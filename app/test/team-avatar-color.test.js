// Team colour regression (t_b590b876): every agent surface must wear its TEAM's colour —
// exactly the team hue token, same for all members, different across teams (wiki UI Design
// Direction — Graph Editor: "Avatar circle (initials, team colour)"). The role-tinted roleBg()
// (924f2dc, DiceBear round) and the per-member mix steps (t_300e8fd2) both broke that: agents
// inside one team showed different colours. Renderer-level per the obs-highlight/inbox-badge
// pattern: extract the real colour block and who() from renderer/app.js and run them against
// stubs, plus source assertions pinning the call sites to the team-tied helper.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

// The colour block: _teamHue/teamHue/nodeById/agentColor/agentVar (+ neighbours, all self-contained).
const cStart = src.indexOf('const _teamHue = new Map()');
const cEnd = src.indexOf('const agentVar');
assert.ok(cStart > 0 && cEnd > cStart, 'colour block found in renderer/app.js');
const cEndLine = src.indexOf('\n', cEnd);
const colourBlock = src.slice(cStart, cEndLine);
const loadColour = (S) => {
  const fn = new Function('S', 'esc', colourBlock + '\nreturn { teamHue, agentColor, agentVar };');
  return fn(S, (s) => String(s));
};

const esc = (s) => String(s);
const TEAMS = [{ id: 't_core', name: 'Core' }, { id: 't_lab', name: 'Lab' }];
const mkAgent = (id, teamId, role, extra) => ({ id, teamId, name: id.replace('n_', ''), role, ...extra });
const agents = [
  mkAgent('n_c1', 't_core', 'PM'), mkAgent('n_c2', 't_core', 'Dev Lead'), mkAgent('n_c3', 't_core', 'Critic'),
  mkAgent('n_l1', 't_lab', 'PM'), mkAgent('n_l2', 't_lab', 'Dev'), mkAgent('n_l3', 't_lab', 'Reviewer'),
];
const S = { project: { teams: TEAMS }, allNodes: agents };

test('2 teams x 3 agents: every member gets EXACTLY its team colour, and teams differ', () => {
  const { teamHue, agentColor, agentVar } = loadColour(S);
  for (const team of TEAMS) {
    const members = agents.filter((a) => a.teamId === team.id);
    const hue = teamHue(team.id);
    const colour = `var(--agent-${hue})`;
    for (const m of members) {
      assert.equal(agentColor(m.id), hue, `${m.id} hue == its team's hue`);
      assert.equal(agentVar(m.id), colour, `${m.id} colour string is exactly the team token`);
    }
    // "exactly": all members share one identical string (no per-member mix steps)
    assert.equal(new Set(members.map((m) => agentVar(m.id))).size, 1, `${team.name}: one colour for all members`);
  }
  assert.notEqual(teamHue('t_core'), teamHue('t_lab'), 'the two teams differ');
});

test('avatarSeed override changes only the face, never the colour', () => {
  const { agentColor, agentVar } = loadColour({ project: { teams: TEAMS }, allNodes: [mkAgent('n_c1', 't_core', 'PM'), { ...mkAgent('n_c2', 't_core', 'Dev'), avatarSeed: 'face9' }] });
  assert.equal(agentColor('n_c1'), agentColor('n_c2'));
  assert.equal(agentVar('n_c1'), agentVar('n_c2'));
});

test('who() hands chat/board/logs the team colour (bg and color agree)', () => {
  const whoLine = src.match(/const who = \(id\) =>[^\n]+/);
  assert.ok(whoLine, 'who() found in renderer/app.js');
  assert.match(whoLine[0], /bg: agentVar\(n\.id\)/, 'who().bg must be the team-tied agentVar, not roleBg');
  const { agentVar } = loadColour(S);
  const fn = new Function('nodeById', 'Chat', 'isLeadRole', 'agentVar', whoLine[0] + '\nreturn who;');
  const who = fn((id) => S.allNodes.find((x) => x.id === id) || null, { initials: (n) => n.slice(0, 2).toUpperCase() }, () => false, agentVar);
  for (const m of agents) {
    assert.equal(who(m.id).bg, agentVar(m.id), `${m.id} avatar bg is the team colour`);
    assert.equal(who(m.id).color, who(m.id).bg, 'color and bg agree for agents');
  }
});

test('source: agent-colouring call sites use the team helper; roleBg and mix steps are gone', () => {
  assert.ok(!src.includes('const roleBg'), 'roleBg() must be deleted');
  assert.ok(!src.includes('roleBg(n.role)'), 'no roleBg call site may remain');
  assert.ok(!src.includes('agentStep'), 'per-member mix steps must be gone');
  // graph node avatar disc (the surface from the human report)
  assert.match(src, /class: 'avatar', cx: 30, cy: 26, r: 14, style: `fill:\$\{agentVar\(n\.id\)\};--av:\$\{agentVar\(n\.id\)\}`/);
  // live card face backdrop, editor face backdrop, chat mentions
  assert.match(src, /class="lc-face" src="\$\{faceUri\(n\.id\)\}" alt="" style="background:\$\{agentVar\(n\.id\)\}"/);
  assert.match(src, /id="nf-face"[^>]+style="background:\$\{agentVar\(n\.id\)\}/);
  assert.match(src, /is-lead' : ''}" style="background:\$\{agentVar\(n\.id\)\}"/);
  // stripe + minimap keep the team token too
  assert.match(src, /class: 'stripe'[^;]+fill:\$\{agentVar\(n\.id\)\}`/);
  assert.match(src, /class: n\.ghost \? 'mghost' : 'mnode', style: n\.ghost \? '' : `fill:\$\{agentVar\(n\.id\)\}`/);
});
