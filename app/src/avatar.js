// avatarUri(agentId, bg) -> data: URI of the agent's bottts-neutral avatar (wiki decision-dicebear-avatars).
// Seed = agentId only, so an agent's face never changes; bg is the role colour (hex, '#' optional).
// SVG data URIs are memoized in a plain Map (avatarUri.cache) — the renderer calls this on every render.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./dicebear')); else root.avatarUri = factory(root.DiceBear); })(this, function (DiceBear) {
  const cache = new Map();
  function avatarUri(agentId, bg) {
    const colour = bg ? String(bg).replace(/^#/, '') : '';
    const key = agentId + '\n' + colour;
    if (cache.has(key)) return cache.get(key);
    const opts = { seed: String(agentId) };
    if (colour) opts.backgroundColor = [colour];
    const uri = DiceBear.createAvatar(DiceBear.botttsNeutral, opts).toDataUri();
    cache.set(key, uri);
    return uri;
  }
  // SVG text without DiceBear's coloured full-canvas background rect (so the role colour shows through).
  // Only the fill-first rect is dropped; the mask's white rect must stay or the masked <g> (eyes, mouth) vanishes.
  avatarUri.faceSvg = (id) => decodeURIComponent(avatarUri(id).replace(/^[^,]*,/, '')).replace(/<rect fill="#[0-9a-f]+" width="120" height="120"[^>]*\/>/gi, '');
  avatarUri.cache = cache;
  return avatarUri;
});
