// Sidecar byte-offset index for logs.jsonl (t_2068c084, wiki paperclip-vs-us-perf change 3).
// getSessionLog used to full-parse the log for every page. Reads now go through <log>.idx:
// one 24-byte record per log line {f64 offset, f64 at, u32 length, u32 nodeKey} after a 32-byte
// header, so a page is located in memory (one pass over the records, no log parsing) and only
// the page's own bytes are read from disk — all async fs. The index is appended by the same
// flush that appends the lines (store._flushLogs hands over per-line meta captured at appendLog
// time, so the hot path never re-parses), and it is only ever an accelerator:
//   - Loads verify the header and walk the offset chain, tolerating a break by using the valid
//     PREFIX. A stat->append interleave between processes, a rebuild racing appends, or a torn
//     write then just shrinks the indexed region; bytes past it are a raw gap scanned with a
//     substring pre-filter, so other processes' lines are never invisible.
//   - The last record is probed against the data file (the bytes at its offset must parse to the
//     record's own at/nodeKey), catching rotation/truncation under the cache and shifted
//     interleaves the chain alone would miss.
//   - A missing/unusable index degrades that read to a whole-file scan and repairs itself in the
//     background (rebuild: chunked async scan -> tmp -> rename). The scanned gap is backfilled
//     into a healthy index when it continues the chain exactly; a large unindexed tail (a rebuild
//     that raced appends) re-triggers the rebuild instead of growing the per-read gap forever.
// Every line returned from a page is re-checked against the exact session predicate, so a stale
// or hash-collided (32-bit key, ~1e-8 at this team's size) index can skew `total` at worst —
// never the returned lines.
const fsp = require('fs').promises;

const MAGIC = 'ASQLGIDX';
const VERSION = 1;
const HEADER = 32; // 8B magic + u32 version + 20B reserved
const REC = 24; // f64 offset (exact to 2^53 — no log gets near), f64 at, u32 length, u32 nodeKey
const SCAN_CHUNK = 1 << 20; // gap-scan/rebuild read size
const YIELD_EVERY = 8 * SCAN_CHUNK; // yield to the event loop after this many scanned bytes
const REBUILD_GAP = 8 << 20; // unindexed tail past which a read re-triggers a full rebuild

// FNV-1a 32-bit of the nodeId string; 0 = null/absent (logLine serializes `l.nodeId || null`).
function nodeKeyOf(nodeId) {
  if (!nodeId) return 0;
  const s = String(nodeId);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const idxPath = (logFile) => logFile + '.idx';

const CACHE = new Map(); // logFile -> { idxSize, idxMtime, n, dv, coveredEnd }
const REBUILDING = new Map(); // logFile -> in-flight rebuild promise
function dropIndex(logFile) { CACHE.delete(logFile); }
const yieldToLoop = () => new Promise((r) => setImmediate(r));

// Load + verify the index (valid prefix only), or null when absent/unusable. Cached per file
// until (idxSize, idxMtime) change, so repeated page opens skip the multi-MB read + chain walk.
async function loadIndex(logFile) {
  const file = idxPath(logFile);
  let ist;
  try { ist = await fsp.stat(file); } catch { return null; }
  const hit = CACHE.get(logFile);
  if (hit && hit.idxSize === ist.size && hit.idxMtime === ist.mtimeMs) return hit;
  if (ist.size < HEADER || (ist.size - HEADER) % REC !== 0) return null;
  let buf;
  try { buf = await fsp.readFile(file); } catch { return null; }
  if (buf.length < HEADER || buf.toString('latin1', 0, 8) !== MAGIC || buf.readUInt32LE(8) !== VERSION) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = Math.min((ist.size - HEADER) / REC, (buf.length - HEADER) / REC);
  let end = 0, rows = 0;
  for (; rows < n; rows++) {
    const o = HEADER + rows * REC;
    const len = dv.getUint32(o + 16, true);
    if (len === 0 || dv.getFloat64(o, true) !== end) break; // chain break: keep the valid prefix
    end = dv.getFloat64(o, true) + len;
  }
  const rec = { idxSize: ist.size, idxMtime: ist.mtimeMs, n: rows, dv, coveredEnd: end };
  CACHE.set(logFile, rec);
  return rec;
}

// Matching rows of a loaded index as a flat [offset, length, ...] list, in file order.
function matchRows(rec, key, startMs, endMs) {
  const pairs = [];
  for (let i = 0; i < rec.n; i++) {
    const o = HEADER + i * REC;
    if (rec.dv.getUint32(o + 20, true) !== key) continue;
    const at = rec.dv.getFloat64(o + 8, true);
    if (at >= startMs && at <= endMs) pairs.push(rec.dv.getFloat64(o, true), rec.dv.getUint32(o + 16, true));
  }
  return pairs;
}

// One pread at the tail: the last record's bytes must still be in the file and parse to the
// record's own at/nodeKey.
async function tailProbeOk(logFile, rec) {
  if (!rec.n) return true;
  const o = HEADER + (rec.n - 1) * REC;
  const off = rec.dv.getFloat64(o, true);
  const len = rec.dv.getUint32(o + 16, true);
  if (len < 2 || len > (1 << 20)) return false;
  let fh;
  try { fh = await fsp.open(logFile, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, off);
    if (bytesRead < len) return false;
    let line;
    try { line = JSON.parse(buf.toString('utf8', 0, len).replace(/\n$/, '')); } catch { return false; }
    return (line.at || 0) === rec.dv.getFloat64(o + 8, true) && nodeKeyOf(line.nodeId) === rec.dv.getUint32(o + 20, true);
  } finally { try { await fh.close(); } catch {} }
}

// controls.logLine writes {"at":<ms>,"nodeId":"<id>"|null,... in fixed order, so the two filter
// fields are extracted from the prefix; anything unexpected (foreign line, an escaped id) falls
// back to JSON.parse, and an unparseable line keeps its bytes in the chain with at=0/key=0 so
// filters just skip it (the old full parse skipped it too).
function rowMeta(line) {
  if (line.startsWith('{"at":')) {
    const comma = line.indexOf(',', 6);
    if (comma > 0) {
      const at = Number(line.slice(6, comma));
      if (Number.isFinite(at) && at > 0) {
        if (line.startsWith('"nodeId":"', comma + 1)) {
          const q = line.indexOf('"', comma + 11);
          if (q > 0 && !line.slice(comma + 11, q).includes('\\')) return { at, key: nodeKeyOf(line.slice(comma + 11, q)) };
        } else if (line.startsWith('"nodeId":null', comma + 1)) return { at, key: 0 };
      }
    }
  }
  try { const v = JSON.parse(line); return { at: v.at || 0, key: nodeKeyOf(v.nodeId) }; } catch { return { at: 0, key: 0 }; }
}

function encodeRows(flat) {
  const out = Buffer.alloc((flat.length / 4) * REC);
  for (let i = 0; i < flat.length / 4; i++) {
    const o = i * REC;
    out.writeDoubleLE(flat[i * 4], o);
    out.writeDoubleLE(flat[i * 4 + 1], o + 8);
    out.writeUInt32LE(flat[i * 4 + 2], o + 16);
    out.writeUInt32LE(flat[i * 4 + 3], o + 20);
  }
  return out;
}

// Append records (flat [offset, at, length, key, ...]) to the index — used by the flush path
// and by the read-path gap backfill. Never throws: an index failure must not lose log lines,
// so errors drop the file (reads fall back to the gap scan and rebuild).
async function appendRows(logFile, flat) {
  if (!flat.length) return;
  try {
    await fsp.appendFile(idxPath(logFile), encodeRows(flat));
  } catch {
    try { await fsp.unlink(idxPath(logFile)); } catch {}
  }
  dropIndex(logFile);
}

function packHeader() {
  const h = Buffer.alloc(HEADER);
  h.write(MAGIC, 0, 'latin1');
  h.writeUInt32LE(VERSION, 8);
  return h;
}

// Full scan -> tmp -> rename. Covers exactly the complete lines that existed at the baseline
// stat (a trailing line without '\n' stays a gap: it is incomplete); batches appended while the
// rebuild runs are picked up by the flush's own records or the read-path backfill.
async function rebuildIndex(logFile) {
  const inflight = REBUILDING.get(logFile);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const size = await fsp.stat(logFile).then((s) => s.size, () => 0);
      if (!size) { try { await fsp.unlink(idxPath(logFile)); } catch {} dropIndex(logFile); return; }
      const rows = [];
      const fh = await fsp.open(logFile, 'r');
      try {
        let pos = 0, base = 0, carry = null, since = 0;
        while (pos < size) {
          const want = Math.min(SCAN_CHUNK, size - pos);
          const buf = Buffer.alloc(want);
          const { bytesRead } = await fh.read(buf, 0, want, pos);
          if (!bytesRead) break;
          const view = carry && carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
          if (!carry || !carry.length) base = pos; // view starts at this chunk
          const lastNl = view.lastIndexOf(10);
          if (lastNl < 0) { carry = view; pos += bytesRead; continue; }
          let from = 0;
          for (let nl = view.indexOf(10); nl >= 0 && nl <= lastNl; nl = view.indexOf(10, from)) {
            const meta = rowMeta(view.toString('utf8', from, nl));
            rows.push(base + from, meta.at, nl - from + 1, meta.key);
            from = nl + 1;
          }
          carry = view.subarray(from);
          base += from;
          pos += bytesRead;
          if ((since += bytesRead) >= YIELD_EVERY) { await yieldToLoop(); since = 0; }
        }
      } finally { try { await fh.close(); } catch {} }
      const out = [packHeader()];
      for (let i = 0; i < rows.length; i += 4 * 8192) out.push(encodeRows(rows.slice(i, i + 4 * 8192)));
      const tmp = `${idxPath(logFile)}.${process.pid}.tmp`;
      try { await fsp.writeFile(tmp, Buffer.concat(out)); await fsp.rename(tmp, idxPath(logFile)); } catch { try { await fsp.unlink(tmp); } catch {} }
      dropIndex(logFile);
    } catch { /* keep any old index; reads fall back to the gap scan */ } finally { REBUILDING.delete(logFile); }
  })();
  REBUILDING.set(logFile, p);
  return p;
}

// Raw scan of bytes [from, to): substring pre-filter on the nodeId field, JSON.parse only the
// candidates, exact at-window check. Returns the matching parsed objects + their raw strings
// (the store's buffer-merge dedup compares them), and every complete line's row so a healthy
// index can backfill the scanned gap. An incomplete trailing line is parsed (the old full parse
// parsed it too) but never indexed.
async function scanRange(logFile, from, to, nodeId, key, startMs, endMs) {
  const objs = [], strings = [], rows = [];
  if (to <= from) return { objs, strings, rows };
  let fh;
  try { fh = await fsp.open(logFile, 'r'); } catch { return { objs, strings, rows }; }
  try {
    let pos = from, base = from, carry = null, since = 0;
    const handleLine = (line, abs, complete) => {
      if (complete) {
        const meta = rowMeta(line);
        rows.push(abs, meta.at, Buffer.byteLength(line) + 1, meta.key);
      }
      if (nodeId && !line.includes(String(nodeId))) return;
      let v;
      try { v = JSON.parse(line); } catch { return; }
      if (nodeKeyOf(v.nodeId) === key && v.at >= startMs && v.at <= endMs) { objs.push(v); strings.push(line); }
    };
    while (pos < to) {
      const want = Math.min(SCAN_CHUNK, to - pos);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (!bytesRead) break;
      const view = carry && carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      if (!carry || !carry.length) base = pos;
      const lastNl = view.lastIndexOf(10);
      if (lastNl < 0) { carry = view; pos += bytesRead; continue; }
      let from0 = 0;
      for (let nl = view.indexOf(10); nl >= 0 && nl <= lastNl; nl = view.indexOf(10, from0)) {
        const line = view.toString('utf8', from0, nl);
        handleLine(line, base + from0);
        from0 = nl + 1;
      }
      carry = view.subarray(from0);
      base += from0;
      pos += bytesRead;
      if ((since += bytesRead) >= YIELD_EVERY) { await yieldToLoop(); since = 0; }
    }
    if (carry && carry.length) handleLine(carry.toString('utf8'), base, false);
    return { objs, strings, rows };
  } finally { try { await fh.close(); } catch {} }
}

// Top read API for one log file: matching index rows (flat pairs), plus a raw scan of anything
// the index does not cover. Triggers a background rebuild when the index is missing/unusable.
async function matchLogRecords(logFile, nodeId, startMs, endMs) {
  const size = await fsp.stat(logFile).then((s) => s.size, () => 0);
  if (!size) return { pairs: [], gapObjs: [], gapStrings: [] };
  const key = nodeKeyOf(nodeId);
  let rec = await loadIndex(logFile);
  if (rec && rec.coveredEnd > size) rec = null; // index describes newer bytes: rotated/truncated
  if (rec && !rec.n && rec.idxSize > HEADER) rec = null; // chain already broken at row 0: garbage
  if (rec && !(await tailProbeOk(logFile, rec))) { dropIndex(logFile); rec = null; }
  if (!rec) { dropIndex(logFile); rebuildIndex(logFile); }
  const pairs = rec ? matchRows(rec, key, startMs, endMs) : [];
  const coveredEnd = rec ? rec.coveredEnd : 0;
  if (coveredEnd >= size) return { pairs, gapObjs: [], gapStrings: [] };
  const gap = await scanRange(logFile, coveredEnd, size, nodeId, key, startMs, endMs);
  if (rec) {
    if (gap.rows.length && gap.rows[0] === coveredEnd) await appendRows(logFile, gap.rows);
    else if (size - coveredEnd >= REBUILD_GAP) rebuildIndex(logFile);
  }
  return { pairs, gapObjs: gap.objs, gapStrings: gap.strings };
}

// Parse the page's rows [iFrom, iTo) out of `pairs` (flat match rows): one pread of the byte
// span, one JSON.parse per row, every row re-checked against the exact predicate (hash-collision
// guard). Returns objects in row order; unreadable rows are skipped.
async function readPageRows(logFile, pairs, iFrom, iTo, key, startMs, endMs) {
  const out = [];
  if (iTo <= iFrom) return out;
  const spanOff = pairs[2 * iFrom];
  const lastO = 2 * (iTo - 1);
  const spanEnd = pairs[lastO] + pairs[lastO + 1];
  const span = spanEnd - spanOff;
  if (spanOff < 0 || span > (1 << 26)) return out; // absurd span: corrupt beyond the chain check
  let fh;
  try { fh = await fsp.open(logFile, 'r'); } catch { return out; }
  try {
    const buf = Buffer.alloc(span);
    const { bytesRead } = await fh.read(buf, 0, span, spanOff);
    if (bytesRead < span) return out;
    for (let i = iFrom; i < iTo; i++) {
      const s = pairs[2 * i] - spanOff, len = pairs[2 * i + 1];
      let v;
      try { v = JSON.parse(buf.toString('utf8', s, s + len).replace(/\n$/, '')); } catch { continue; }
      if (nodeKeyOf(v.nodeId) === key && v.at >= startMs && v.at <= endMs) out.push(v);
    }
    return out;
  } finally { try { await fh.close(); } catch {} }
}

module.exports = { REC, HEADER, idxPath, nodeKeyOf, matchLogRecords, readPageRows, appendRows, rebuildIndex, dropIndex };
