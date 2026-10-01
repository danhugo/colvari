// Default agent name: a word from a fixed list, seeded by agent id (same seed idea as the DiceBear face).
// Taken words (first part of an existing name) are skipped, so names never repeat inside a team.
const WORDS = ['Otter', 'Fox', 'Heron', 'Lynx', 'Panda', 'Gecko', 'Raven', 'Koala', 'Bison', 'Finch', 'Mole', 'Newt', 'Tapir', 'Wren', 'Yak', 'Zebu', 'Ibis', 'Lemur', 'Moth', 'Okapi', 'Quail', 'Robin', 'Stoat', 'Vole'];
const seedOf = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
function defaultName(id, role, nodes) {
  const taken = new Set(nodes.map((n) => String(n.name).split(' · ')[0]));
  const start = seedOf(id);
  for (let k = 0; k < WORDS.length; k++) { const w = WORDS[(start + k) % WORDS.length]; if (!taken.has(w)) return `${w} · ${role}`; }
  return `${WORDS[start % WORDS.length]} ${nodes.length + 1} · ${role}`; // list exhausted: number keeps it unique
}
module.exports = { defaultName, WORDS };
