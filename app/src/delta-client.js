// The 'delta' push-channel contract (t_39bf39ac, perf track 2), shared by the renderer (script
// tag, like the other src/*.js the page loads) and the node tests (require). Kept dependency-free
// and pure so both sides exercise the exact same code. Batch shapes: keyed patches {type:'task'|
// 'wiki'|'orch'|'messages'|'inbox', id?, set|del} that patch() folds into the renderer's store,
// the append-only {type:'logs', set:[line...]} batch (t_d22a6cf2, handled by the caller — log
// lines live outside S) and {type:'runs'}/{type:'resync'} which the caller handles before patch().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DeltaClient = api;
})(typeof self !== 'undefined' ? self : this, () => {
  // Decides what the renderer does with a batch. Any seq gap or replay means a batch was missed:
  // patching on top of stale state would diverge silently, so the caller must pull a full
  // snapshot instead (wiki rule 5). lastSeq === null (first batch ever, or right after a resync)
  // is accepted as-is — the renderer's store is fresh from a full getAll in both cases.
  const plan = (lastSeq, b) => {
    if (!b || !Array.isArray(b.deltas)) return { op: 'ignore' };
    if (lastSeq !== null && b.prev !== lastSeq) return { op: 'resync' };
    return { op: 'apply' };
  };
  // Applies ONE delta to the renderer's S. tasks stays in listTasks order (createdAt, then id) so
  // no view ever sees a differently-ordered board than after a full getAll.
  const patch = (S, d) => {
    if (d.type === 'task') {
      const ts = S.tasks; const i = ts.findIndex((t) => t.id === d.id);
      if (d.del) { if (i >= 0) ts.splice(i, 1); return; }
      if (i >= 0) { ts[i] = d.set; return; }
      const j = ts.findIndex((t) => String(t.createdAt).localeCompare(String(d.set.createdAt)) > 0 || (t.createdAt === d.set.createdAt && String(t.id) > String(d.id)));
      if (j < 0) ts.push(d.set); else ts.splice(j, 0, d.set);
    } else if (d.type === 'wiki') { if (d.del) delete S.wiki[d.id]; else S.wiki[d.id] = d.set; }
    else if (d.type === 'orch') S.orch = d.set;
    else if (d.type === 'messages') S.messages = d.set;
    else if (d.type === 'inbox') S.inbox = d.set;
  };
  return { plan, patch };
});
