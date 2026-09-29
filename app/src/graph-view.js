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

  return { CLUSTER_MIN, GROUP_MIN, clusterView, mapEdges };
});
