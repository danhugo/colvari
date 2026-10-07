// Wake sweep micro-profile (t_fefa8614): what does one sweepWakes() tick cost on a grown
// board? The sweep runs at 1 Hz on the main process event loop (WAKE.SWEEP_MS) and its cost
// lands in the same event loop the renderer IPC serves, so SLOW_SWEEP_MS (25 ms) is the jank
// line. Plain node — no Electron, no orchestrator, no child processes: sweepWakes only needs
// a store with a team + messages file and the orch seams it reads through (agents/procs/
// wakeTimers/wakeUnread/changed/log). Runs against a throwaway temp dir.
//
//   node test/perf/wake-sweep-profile.js [outDir]
//
// Scenarios per (nodes × messages) matrix: warm sweeps (unread memo hits, steady state —
// the 1 Hz cost), memo-bust sweeps (messages file touched out-of-band → full unreadMap
// rebuild: re-parse + O(messages) pass), and one run with an agent running (procs entry —
// the skip path). All timings are Date.now() deltas around the synchronous sweep body.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../../src/store');
const WS = require('../../src/wake-sweep');

const NODES = [6, 24];
const MESSAGES = [1000, 5000, 20000];
const WARM_SWEEPS = 200;
const BUST_SWEEPS = 10;

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

function seed(dir, nNodes, nMsgs) {
  const store = new Store(dir);
  const nodes = [];
  for (let i = 0; i < nNodes; i++) nodes.push({ id: 'n_probe' + i, name: 'P' + i, role: i === 0 ? 'lead' : 'dev', status: 'idle', x: 80 + (i % 8) * 220, y: 80 + Math.floor(i / 8) * 140 });
  store.write('team', { nodes, edges: [] });
  // Realistic mix: ~15% unread eligible (human + teammate senders), ~55% read, rest from
  // unknown/system senders the unread filter drops (system without the wake flag).
  const msgs = [];
  for (let i = 0; i < nMsgs; i++) {
    const bucket = i % 20;
    const to = nodes[i % nNodes].id;
    let m = { id: 'm' + i, to, text: 'filler line ' + i + ' — padding to a realistic per-message size, a few dozen words of task chatter and status notes.', at: new Date().toISOString(), read: true };
    if (bucket < 3) { m.from = bucket === 0 ? 'human' : nodes[(i + 1) % nNodes].id; m.read = false; } // eligible unread
    else if (bucket < 14) m.from = nodes[(i + 1) % nNodes].id; // read teammate chatter
    else { m.from = 'system'; } // dropped: system without wake
    msgs.push(m);
  }
  fs.writeFileSync(store.file('messages'), JSON.stringify({ messages: msgs }));
  return { store, nodes };
}

function fakeOrch(store) {
  return {
    store,
    agents: {},
    agent(id) { return (this.agents[id] ||= { status: 'idle', wakePending: null }); },
    procs: new Map(),
    wakeTimers: new Map(),
    userStopped: false,
    dispatchPaused: false,
    changed() {},
    log() {},
    wakeUnread(nodeId, team, key) { return WS.wakeUnread(this, nodeId, team, key); },
    dispatchWake() { return Promise.resolve(); },
  };
}

function run(store, orch, nodes) {
  const times = [];
  for (let i = 0; i < WARM_SWEEPS; i++) {
    const t = Date.now();
    WS.sweepWakes(orch);
    times.push(Date.now() - t);
  }
  const busts = [];
  for (let i = 0; i < BUST_SWEEPS; i++) {
    const f = store.file('messages');
    const st = fs.statSync(f);
    fs.utimesSync(f, new Date(), new Date(st.mtimeMs + 1 + i)); // out-of-band edit → sig bust
    const t = Date.now();
    WS.sweepWakes(orch);
    busts.push(Date.now() - t);
  }
  // One agent running: the procs skip path (half the roster unscannable).
  orch.procs.set(nodes[0].id, {});
  const t = Date.now();
  WS.sweepWakes(orch);
  const busyMs = Date.now() - t;
  orch.procs.delete(nodes[0].id);
  return { warm: times, busts, busyMs };
}

function main() {
  const outDir = process.argv[2] || path.join(__dirname, 'results', 'real-agents', 't_fefa8614');
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  const detail = {};
  for (const nNodes of NODES) {
    for (const nMsgs of MESSAGES) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-probe-'));
      const { store, nodes } = seed(dir, nNodes, nMsgs);
      const orch = fakeOrch(store);
      const r = run(store, orch, nodes);
      const warmP50 = pct(r.warm, 50), warmP95 = pct(r.warm, 95), warmMax = r.warm[r.warm.length - 1];
      rows.push({ nodes: nNodes, msgs: nMsgs, warmP50, warmP95, warmMax, bustP50: pct(r.busts, 50), bustMax: r.busts[r.busts.length - 1], busySweepMs: r.busyMs });
      detail[`${nNodes}n-${nMsgs}m`] = r;
      console.log(`nodes=${nNodes} msgs=${nMsgs}: warm p50=${warmP50}ms p95=${warmP95}ms max=${warmMax}ms | bust p50=${pct(r.busts, 50)}ms max=${r.busts[r.busts.length - 1]}ms | 1-running-agent sweep=${r.busyMs}ms`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(outDir, 'wake-sweep.json'), JSON.stringify({ at: new Date().toISOString(), rows, detail }, null, 2));
  console.log('raw: ' + path.join(outDir, 'wake-sweep.json'));
}

main();
