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
const enabled = new Set(enabledTools(store.getTeam().nodes.find((n) => n.id === arg('--node'))));
const server = new McpServer({ name: 'board', version: '0.1.0' });
const STATUS = z.enum(['todo', 'in_progress', 'review', 'done']);

const reg = (name, description, shape) => enabled.has(name) && server.tool(name, description, shape, async (args) => {
  try { return { content: [{ type: 'text', text: JSON.stringify(tools[name](args || {}), null, 2) }] }; }
  catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] }; }
});

reg('list_team', 'Show yourself and the teammates you can assign tasks to / receive tasks from.', {});
reg('list_tasks', 'List board tasks visible to you.', { status: STATUS.optional(), mine: z.boolean().optional() });
reg('create_task', 'Create a task assigned to yourself or a teammate you have an outgoing edge to (id or name). Use blockedBy to make it wait for other tasks.', { title: z.string(), description: z.string().optional(), assignee: z.string().optional(), parentId: z.string().optional(), blockedBy: z.array(z.string()).optional().describe('ids of tasks that must be done before this one starts') });
reg('update_task_status', 'Change a task status (todo, in_progress, review, done). Reviewers may move tasks of agents they review to review/done.', { taskId: z.string(), status: STATUS });
reg('comment_task', 'Add a comment to a task.', { taskId: z.string(), text: z.string() });
reg('send_message', 'Send a direct message to a teammate you have a message or assign edge to (id or name).', { to: z.string(), text: z.string(), taskId: z.string().optional() });
reg('read_messages', 'Read your inbox (messages from teammates with an edge to you, and from the human). Marks them read.', { unreadOnly: z.boolean().optional(), from: z.string().optional() });
reg('read_wiki', 'Read a wiki page by title, or list page titles when title is omitted.', { title: z.string().optional() });
reg('write_wiki', 'Create or overwrite a markdown wiki page.', { title: z.string(), content: z.string() });

server.connect(new StdioServerTransport());
