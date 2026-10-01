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
  avatarUri.cache = cache;
  return avatarUri;
});
