#!/usr/bin/env node
// stdio MCP server exposing the board/wiki to one agent node.
// Usage: node mcp-server.js --project <dir> --node <nodeId>
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { Store } = require('./store');
const { makeTools, enabledTools } = require('./board-tools');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const store = new Store(arg('--project'));
const tools = makeTools(store, arg('--node'));
// Only register the tools enabled for this agent (checked again on every call).
const callerNode = store.getTeam().nodes.find((n) => n.id === arg('--node'));
const enabled = new Set(enabledTools(callerNode));
// Team management tools are listed only for a node that is core:true at startup; a node the human
// makes core later picks them up on its next run (no hot reload). The tools also re-check the flag
// on every call, so this registration is only the tool listing, not the guard.
const coreNow = !!(callerNode && callerNode.core === true);
const server = new McpServer({ name: 'board', version: '0.1.0' });
const STATUS = z.enum(['todo', 'in_progress', 'review', 'done', 'waiting_for_human']);
const PRIORITY = z.enum(['P0', 'P1', 'P2', 'P3']);

const reg = (name, description, shape) => enabled.has(name) && server.tool(name, description, shape, async (args) => {
  try { return { content: [{ type: 'text', text: JSON.stringify(await tools[name](args || {}), null, 2) }] }; }
  catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] }; }
});

reg('list_team', 'Show yourself and the teammates you can assign tasks to / receive tasks from.', {});
reg('list_tasks', 'List board tasks visible to you. Excludes done tasks and trims description/comments by default (small output); pass includeDone or status:"done" to see done tasks, or taskId to get one task in full (with comments).', { status: STATUS.optional(), mine: z.boolean().optional(), includeDone: z.boolean().optional(), taskId: z.string().optional() });
reg('create_task', 'Create a task assigned to yourself or a teammate you have an outgoing edge to (id or name). Use blockedBy to make it wait for other tasks.', { title: z.string(), description: z.string().optional(), assignee: z.string().optional(), parentId: z.string().optional(), blockedBy: z.array(z.string()).optional().describe('ids of tasks that must be done before this one starts'), priority: PRIORITY.optional().describe('P0 (highest) .. P3 (lowest); default P2') });
reg('update_task_status', 'Change a task status (todo, in_progress, review, done). Reviewers may move tasks of agents they review to review/done.', { taskId: z.string(), status: STATUS, priority: PRIORITY.optional().describe('optionally re-prioritize the task (P0 highest .. P3 lowest)') });
reg('comment_task', 'Add a comment to a task.', { taskId: z.string(), text: z.string() });
reg('send_message', 'Send a direct message to a teammate you have a message or assign edge to (id or name).', { to: z.string(), text: z.string(), taskId: z.string().optional() });
reg('read_messages', 'Read your inbox (messages from teammates with an edge to you, and from the human). Marks them read.', { unreadOnly: z.boolean().optional(), from: z.string().optional() });
reg('ask_human', 'Ask the human a question and WAIT for the answer (blocks until answered in the Inbox). Your task goes to waiting_for_human meanwhile. Returns {answer}.', { question: z.string(), choices: z.array(z.string()).optional().describe('optional answer buttons'), taskId: z.string().optional() });
reg('read_wiki', 'Read a wiki page by title, or list page titles when title is omitted.', { title: z.string().optional() });
reg('write_wiki', 'Create or overwrite a markdown wiki page.', { title: z.string(), content: z.string() });
reg('request_self_update', 'PM only: ask the app to update itself to the newest merged code (safe restart: waits for agents, runs tests, relaunches). Honors the auto-restart setting and restart guards.', { reason: z.string().optional().describe('why the update is being requested') });

if (coreNow) {
  reg('recruit_agent', 'Core agent only: recruit a new agent into your own team. In ask mode the request first goes to the human Inbox and nothing changes; call this tool again once it is approved.', { name: z.string(), role: z.string(), prompt: z.string().optional(), runtime: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), reason: z.string().describe('why the team change is needed') });
  reg('retire_agent', 'Core agent only: retire an agent you recruited (refused while it owns an in_progress task; its todo tasks move back to you).', { nodeId: z.string(), reason: z.string().describe('why the team change is needed') });
  reg('update_agent', 'Core agent only: change role/prompt/runtime/model/effort of an agent you recruited (patch whitelist; any other field is refused).', { nodeId: z.string(), patch: z.record(z.string(), z.unknown()), reason: z.string().describe('why the team change is needed') });
}

server.connect(new StdioServerTransport());
