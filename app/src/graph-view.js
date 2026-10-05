// Graph cluster view model (pure, shared by the renderer's Team graph and Overview, and by tests).
// Past CLUSTER_MIN agents, whole per-lead groups collapse into one cluster card each so a 24-agent
// team still fits at ~100% zoom with readable names instead of a 25% zoom-out of overlapping cards
// (t_345af163). A group is a lead's whole assign-subtree (lead included); nodes outside the assign
// tree (reviewers, critics, ...) join the one group they hold edges to, and stay individual when
// their edges fan across several groups (they are the bridges between clusters).
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.GraphView = factory(); })(this, function () {
  const CLUSTER_MIN = 12; // team size above which the cluster view kicks in at all
  const GROUP_MIN = 3; // smallest group worth collapsing into a card

  // id + all assign-descendants, cycle-safe
  function subtree(id, kids, acc = []) { if (acc.includes(id)) return acc; acc.push(id); (kids[id] || []).forEach((k) => subtree(k, kids, acc)); return acc; }

  // nodes: [{id,name,role,x,y,...}], edges: team edges (any type), expanded: Set of head ids the user opened.
  // Returns { nodes, remap, clustered } — nodes is the visible list (members of collapsed groups
  // replaced by one cluster pseudo-node each, positioned at its head), remap maps member id -> cluster id.
  function clusterView(nodes, edges, expanded) {
    const ids = new Set(nodes.map((n) => n.id));
    if (nodes.length <= CLUSTER_MIN) return { nodes, remap: {}, clustered: false };
    const kids = {}, hasParent = new Set();
    for (const e of edges || []) if ((e.type || 'assign') === 'assign' && ids.has(e.from) && ids.has(e.to) && e.from !== e.to && !hasParent.has(e.to)) { (kids[e.from] ||= []).push(e.to); hasParent.add(e.to); }
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const groups = new Map(); // rootId -> member ids (the root's whole assign-subtree, root included)
    for (const r of nodes) if (!hasParent.has(r.id)) groups.set(r.id, subtree(r.id, kids));
    // Absorb assign-tree-free singleton roots by edge affinity: everything they touch lives in
    // exactly one other group. Repeat so chains (c -> b -> group) settle innermost-first.
    let moved = true;
    while (moved) {
      moved = false;
      for (const g of [...groups.keys()]) {
        if (groups.get(g).length !== 1 || (kids[g] || []).length) continue;
        const targets = new Set();
        for (const e of edges || []) {
          const o = e.from === g ? e.to : e.to === g ? e.from : null;
          if (!o || o === g || !ids.has(o)) continue;
          for (const [gid, gm] of groups) if (gid !== g && gm.includes(o)) targets.add(gid);
        }
        if (targets.size === 1) { groups.get([...targets][0]).push(g); groups.delete(g); moved = true; }
      }
    }
    const remap = {}; const cl = [];
    for (const [head, m] of groups) {
      if (m.length < GROUP_MIN || (expanded && expanded.has(head))) continue;
      const h = byId[head];
      cl.push({ id: 'cl:' + head, cluster: true, head, members: m.map((i) => byId[i]), name: (h.name || head) + ' team', role: m.length + ' agents', x: h.x, y: h.y });
      m.forEach((i) => { remap[i] = 'cl:' + head; });
    }
    return { nodes: [...nodes.filter((n) => !remap[n.id]), ...cl], remap, clustered: cl.length > 0 };
  }

  // Rewrite edge endpoints through the remap and drop self-loops/duplicates that collapsing creates.
  function mapEdges(edges, remap) {
    const seen = new Set();
    return (edges || []).map((e) => ({ ...e, from: remap[e.from] || e.from, to: remap[e.to] || e.to }))
      .filter((e) => e.from !== e.to && !seen.has(`${e.from}|${e.to}|${e.type || 'assign'}`) && seen.add(`${e.from}|${e.to}|${e.type || 'assign'}`));
  }

  const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // Automatic layered tree layout (migrated from the renderer so it is shared and testable).
  // The stored x/y stay the user's manual layout; callers only apply the result while auto mode
  // is on. o: { W, H } card size, asp canvas aspect ratio (from #graph, used only to balance the
  // unconnected grid toward landscape). Returns id -> {x,y}.
  function layoutTree(nodes, edges, o) {
    const { W = 184, H = 80, asp = 1.6 } = o || {};
    const ids = new Set(nodes.map((n) => n.id)), kids = {}, hasParent = new Set(); const GX = W + 36, GY = H + 64, pos = {};
    for (const e of edges) if ((e.type || 'assign') === 'assign' && ids.has(e.from) && ids.has(e.to) && e.from !== e.to && !hasParent.has(e.to)) { (kids[e.from] ||= []).push(e.to); hasParent.add(e.to); }
    const seen = new Set();
    const LEAF_COLS = 5; // many leaf reports wrap under their lead into a block this wide
    const placeLeafBlock = (id, ks, x0, y) => {
      ks.forEach((k, i) => { seen.add(k); pos[k] = { x: x0 + (i % LEAF_COLS) * GX, y: y + GY + Math.floor(i / LEAF_COLS) * (H + 26) }; });
      pos[id] = { x: x0 + (Math.min(LEAF_COLS, ks.length) - 1) * GX / 2, y }; return Math.min(LEAF_COLS, ks.length) * GX;
    };
    const place = (id, x0, y) => {
      seen.add(id); const ks = (kids[id] || []).filter((k) => !seen.has(k));
      if (!ks.length) { pos[id] = { x: x0, y }; return GX; }
      if (ks.length > LEAF_COLS && ks.every((k) => !(kids[k] || []).length)) return placeLeafBlock(id, ks, x0, y);
      let x = x0; for (const k of ks) if (!seen.has(k)) x += place(k, x, y + GY);
      const first = pos[ks[0]].x, last = pos[ks[ks.length - 1]].x; pos[id] = { x: (first + last) / 2, y }; return Math.max(GX, x - x0);
    };
    const roots = nodes.filter((n) => !hasParent.has(n.id)).sort((p, q) => (q.core ? 1 : 0) - (p.core ? 1 : 0)); let x = 40;
    // Unconnected agents wrap into a near-landscape grid instead of one long row (a row of 12 fits at 25% zoom).
    const loners = roots.filter((r) => !(kids[r.id] || []).length);
    for (const r of roots) if ((kids[r.id] || []).length) x += place(r.id, x, 40);
    const placed = new Set(Object.keys(pos));
    const rest = loners.concat(nodes.filter((n) => !placed.has(n.id) && !loners.includes(n))).filter((n) => !placed.has(n.id));
    // Balanced rows (12 -> 4x3): pick a column count so the grid fills toward the canvas aspect.
    let cols = rest.length > 4 ? Math.max(3, Math.ceil(Math.sqrt(rest.length * asp * 0.55))) : rest.length;
    if (rest.length > 4) cols = Math.ceil(rest.length / Math.ceil(rest.length / cols));
    rest.forEach((n, i) => { pos[n.id] = { x: x + (i % cols) * GX, y: 40 + Math.floor(i / cols) * (H + 40) }; });
    return pos;
  }

  // Jank instrumentation wrapper: times each layout pass and surfaces {ms, nodes, edges, placed}
  // as a non-enumerable `stats` prop on the returned map (callers still see a plain id -> {x,y}
  // map), plus a 'graph.treeLayout' performance measure for the DevTools timeline when available.
  function treeLayout(nodes, edges, o) {
    const t0 = nowMs();
    const pos = layoutTree(nodes, edges, o);
    const stats = { ms: +(nowMs() - t0).toFixed(3), nodes: nodes.length, edges: (edges || []).length, placed: Object.keys(pos).length };
    Object.defineProperty(pos, 'stats', { value: stats, enumerable: false });
    if (typeof performance !== 'undefined' && performance.measure) { try { performance.measure('graph.treeLayout', { start: t0, duration: stats.ms }); } catch (_) { /* timeline API unavailable */ } }
    return pos;
  }

  return { CLUSTER_MIN, GROUP_MIN, clusterView, mapEdges, treeLayout };
});
