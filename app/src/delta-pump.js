// IPC deltas (t_39bf39ac, perf track 2): push {type,id,patch} changes instead of the renderer
// re-pulling whole sections on every state event. One pump per project, fed by four read-only
// sources:
//  - the board cache's 'change' events (t_479e7290) for task/wiki puts and deletes — this covers
//    in-process writes AND out-of-band writes from agents' MCP processes (the cache's watcher and
//    reconcile adopt those and emit the same events);
//  - the orchestrator's 'state' events (the slim run/agent snapshot) — collapsed to the last one
//    per batch, since each fully replaces the renderer's orch section;
//  - the orchestrator's 'log' events (t_d22a6cf2) — buffered per line and flushed as ONE {type:'logs',
//    set:[...]} append-only delta per batch, instead of one IPC message per log line;
//  - a signature check per flush for the sections that live outside the cache (messages, inbox,
//    runs.json — plain files other processes rewrite, so no emitter exists): when only the sig
//    moved, the section rides along exactly as getAll would have returned it.
// Everything landing within one tick leaves in ONE 'delta' send on the wire, carrying a monotonic
// seq + prev so the renderer can detect a missed batch (gap => full resync, wiki rule 5). While
// nothing is buffered the pump only polls its cold sigs on the idle interval, so an idle app pays
// a few stats per second and no sends at all.
class DeltaPump {
  constructor({ projectId, store, cache, orch, send, tickMs = 16, idleMs = 250 } = {}) {
    this.projectId = projectId; this.store = store; this.cache = cache; this.orch = orch; this.send = send;
    this.tickMs = tickMs; this.idleMs = idleMs;
    this.seq = 0; this.closed = false;
    this.buf = new Map(); // 'section:id' -> delta, later events for the same key replace earlier ones
    this.logBuf = [];     // log lines: append-only, never coalesced — order within a batch matters
    this.lastOrch = null; this.orchDirty = false;
    this.o = null;
    this.cold = { messages: null, inbox: null, runs: null }; // section -> sig at last flush
    this.timer = null;
    this._onChange = (e) => {
      if (this.closed || !e) return;
      this.buf.set(e.section + ':' + e.id, e.type === 'delete' ? { type: e.section, id: e.id, del: 1 } : { type: e.section, id: e.id, set: e.data });
      this.arm();
    };
    this._onResync = () => { if (this.closed) return; this.buf.set('resync:resync', { type: 'resync' }); this.arm(); };
    if (cache) { cache.on('change', this._onChange); cache.on('resync', this._onResync); }
    for (const k of Object.keys(this.cold)) this.cold[k] = this.sig(k);
    this.arm();
  }
  // The orchestrator is created lazily by main.js; subscribe whenever it shows up (before it can
  // emit: main attaches right after construction, events only flow from start()/tick()).
  attachOrch(o) { if (this.o || this.closed) return; this.o = o; o.on('state', (s) => { if (this.closed) return; this.lastOrch = s; this.orchDirty = true; this.arm(); }); }
  // Hot path (one call per log line): buffer + arm, no I/O.
  pushLog(l) { if (this.closed) return; this.logBuf.push(l); this.arm(); }
  sig(k) { try { return this.store.sigFile(k); } catch { return ''; } }
  arm() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, (this.buf.size || this.orchDirty || this.logBuf.length) ? this.tickMs : this.idleMs);
    if (this.timer.unref) this.timer.unref();
  }
  flush() {
    if (this.closed) return;
    const deltas = [...this.buf.values()]; this.buf.clear();
    if (this.orchDirty) { this.orchDirty = false; const s = this.lastOrch; this.lastOrch = null; if (s) deltas.push({ type: 'orch', set: s }); }
    if (this.logBuf.length) { deltas.push({ type: 'logs', set: this.logBuf }); this.logBuf = []; }
    for (const k of Object.keys(this.cold)) {
      const s = this.sig(k);
      if (s === this.cold[k]) continue;
      this.cold[k] = s;
      try {
        deltas.push(k === 'messages' ? { type: 'messages', set: this.store.listMessages().slice(-200) }
          : k === 'inbox' ? { type: 'inbox', set: this.store.listInbox({ status: 'open' }) }
          : { type: 'runs', set: this.store.listRuns() });
        // the ledger lives in the orch snapshot: v.orch below covers runs, so a runs change must carry a fresh orch too
        if (k === 'runs' && !deltas.some((d) => d.type === 'orch')) { const o = this.orch && this.orch(); if (o && o.snapshotSlim) deltas.push({ type: 'orch', set: o.snapshotSlim() }); }
      } catch { this.cold[k] = null; } // torn read: keep the sig open so the next flush retries
    }
    if (deltas.length) {
      const v = {};
      try { v.board = this.cache.sectionSig('board'); v.wiki = this.cache.sectionSig('wiki'); } catch {}
      try { const o = this.orch && this.orch(); if (o) v.orch = o.versionSig(); } catch {}
      for (const k of Object.keys(this.cold)) v[k] = this.cold[k];
      this.send({ projectId: this.projectId, seq: ++this.seq, prev: this.seq - 1, v, deltas });
    }
    this.arm();
  }
  close() {
    if (this.closed) return; this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.logBuf = [];
    if (this.cache) { this.cache.removeListener('change', this._onChange); this.cache.removeListener('resync', this._onResync); }
  }
}

module.exports = { DeltaPump };
