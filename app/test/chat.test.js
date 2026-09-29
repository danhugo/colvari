const test = require('node:test'); const assert = require('node:assert');
const C = require('../src/chat.js');
const nodes = [{ id: 'n1', name: 'Pia' }, { id: 'n2', name: 'Devon' }];

test('avatar colour is stable per id and independent of name', () => {
  assert.strictEqual(C.avatarColor('n1'), C.avatarColor('n1')); assert.notStrictEqual(C.avatarColor('n1'), C.avatarColor('n2'));
  assert.strictEqual(C.initials('Devon'), 'D'); assert.strictEqual(C.initials('Rhea Reviewer'), 'RR');
});

test('composer: @Name = task, @Name? = message, plain = goal, unknown = error', () => {
  assert.deepStrictEqual(C.parseComposer('@devon build it', nodes), { kind: 'task', nodeId: 'n2', name: 'Devon', text: 'build it' });
  assert.strictEqual(C.parseComposer('@Devon? how is it going', nodes).kind, 'message');
  assert.strictEqual(C.parseComposer('hi team', nodes).kind, 'goal');
  assert.strictEqual(C.parseComposer('@Zed do x', nodes).kind, 'error');
  assert.strictEqual(C.parseComposer('@Devon', nodes).kind, 'error');
  assert.strictEqual(C.parseComposer('  ', nodes), null);
  assert.deepStrictEqual(C.mentionMatches('hey @De', nodes).map((n) => n.id), ['n2']); assert.strictEqual(C.mentionMatches('no mention', nodes), null);
});

test('room events: thoughts, tool chips with results, handoffs, questions; linked to tasks; grouped', () => {
  const tasks = [{ id: 't1', title: 'Build', createdBy: 'n1', assignee: 'n2', createdAt: 1, comments: [{ author: 'n2', text: 'done', at: 90 }] }];
  const logs = [{ nodeId: 'n2', kind: 'system', text: '▶ Devon starts "Build" in /x', at: 10 }, { nodeId: 'n2', kind: 'text', text: 'thinking', at: 20 },
    { nodeId: 'n2', kind: 'tool', text: 'Bash {"command":"npm test"}', at: 30 }, { nodeId: 'n2', kind: 'tool_result', text: 'ok', at: 31 }];
  const ev = C.roomEvents(logs, tasks, [{ from: 'n1', to: 'n2', text: 'ping', at: 50 }], [{ id: 'i1', kind: 'question', nodeId: 'n2', question: 'Which?', choices: ['a'], at: 60 }]);
  assert.deepStrictEqual(ev.map((e) => e.type), ['handoff', 'action', 'thought', 'tool', 'message', 'question', 'comment']);
  const tool = ev.find((e) => e.type === 'tool'); assert.strictEqual(tool.label, 'Bash · npm test'); assert.strictEqual(tool.result, 'ok'); assert.strictEqual(tool.taskId, 't1');
  const g = C.group(ev); assert.deepStrictEqual(g.map((x) => [x.who, x.items.length]), [['n1', 1], ['n2', 3], ['n1', 1], ['n2', 1], ['n2', 1]]);
  assert.strictEqual(C.roomEvents(Array.from({ length: 700 }, (_, i) => ({ nodeId: 'n1', kind: 'text', text: 'x', at: i })), [], [], []).length, C.MAX);
});

test('attachments: fmtSize, fileUrl encoding, messages carry atts into room events', () => {
  assert.strictEqual(C.fmtSize(0), '0 B'); assert.strictEqual(C.fmtSize(999), '999 B');
  assert.strictEqual(C.fmtSize(2048), '2.0 KB'); assert.strictEqual(C.fmtSize(5 * 1048576), '5.0 MB'); assert.strictEqual(C.fmtSize(undefined), '');
  assert.strictEqual(C.fileUrl('/tmp/a b/c.png'), 'file:///tmp/a%20b/c.png');
  const att = { path: '/store/attachments/1-2-shot.png', name: 'shot.png', mime: 'image/png', size: 12345 };
  const ev = C.roomEvents([], [], [{ from: 'human', to: 'n1', text: 'see shot', at: 5, attachments: [att] }], []);
  assert.deepStrictEqual(ev[0].atts, [att]);
  assert.strictEqual(C.roomEvents([], [], [{ from: 'human', text: 'no atts', at: 5 }], [])[0].atts, null);
});

test('attachments: attThumbs HTML — lazy file:// img for images, name chip otherwise, escaped; none → empty', () => {
  const img = { path: '/store/a b/shot.png', name: 'shot.png', mime: 'image/png', size: 2048 };
  const h = C.attThumbs([img]);
  assert.match(h, /<img class="att-thumb" src="file:\/\/\/store\/a%20b\/shot\.png" loading="lazy"/);
  assert.match(h, /title="shot\.png · 2\.0 KB"/);
  const doc = { path: '/store/x.md', name: '<b>&x</b>.md', mime: 'text/markdown', size: 9 };
  const hd = C.attThumbs([doc]);
  assert.match(hd, /📄 &lt;b&gt;&amp;x&lt;\/b&gt;\.md/); assert.doesNotMatch(hd, /<b>/);
  assert.match(hd, /title="&lt;b&gt;&amp;x&lt;\/b&gt;\.md · 9 B"/);
  assert.strictEqual(C.attThumbs([]), ''); assert.strictEqual(C.attThumbs(null), '');
  assert.doesNotMatch(C.attThumbs([{ path: '/p/x.png', name: 'x.png', mime: '', size: 1 }]), /<img/); // empty mime → file chip, not img
});

test('attachments: identical consecutive messages collapse, but only when neither carries attachments', () => {
  const a = { path: '/p/1.png', name: '1.png', mime: 'image/png', size: 1 };
  const plain = [{ from: 'human', to: 'n1', text: 'ping', at: 1 }, { from: 'human', to: 'n1', text: 'ping', at: 2 }];
  const c1 = C.collapseRepeats(C.roomEvents([], [], plain, []));
  assert.strictEqual(c1.length, 1); assert.strictEqual(c1[0].count, 2); // collapses
  const withAtt = [{ from: 'human', to: 'n1', text: 'ping', at: 1, attachments: [a] }, { from: 'human', to: 'n1', text: 'ping', at: 2 }];
  const c2 = C.collapseRepeats(C.roomEvents([], [], withAtt, []));
  assert.strictEqual(c2.length, 2); assert.strictEqual(c2[0].count, undefined); // atts keep bubbles apart
});
