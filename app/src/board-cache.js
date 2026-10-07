// In-memory task/wiki cache for the MAIN process (t_479e7290, perf track 3).
// INVARIANT (Cato, t_adeefa43): this cache is a main-process READ accelerator only — the files on
// disk stay the source of truth. The board MCP server runs in other processes and keeps reading
// the files directly; it must never see or depend on this module. An agent's board write lands on
// disk and reaches this cache only through fs.watch (hint) and the periodic reconcile (truth).
//
// fs.watch is a HINT only (Pia/Perry/Argo review of t_adeefa43): on macOS FSEvents batches, drops
// and doubles events, and reports atomic rename-writes as 'rename'. Every event just queues the
// named file (or the whole section, when the filename is null) for revalidation, and revalidation
// compares what is on disk (stat + sha256) against the cached entry before adopting anything.
// Events caused by our own writes are ignored for free: the write-through already put the same
// bytes in the cache, so the echoed hash equals the cached hash and nothing is emitted — no
// time-window suppression that could swallow an agent's write landing inside the window.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// One cache per project dir, shared by every Store of that dir in this process (main.js builds a
// throwaway Store per IPC call; the watchers must not multiply with them).
const registry = new Map();

class BoardCache extends EventEmitter {
  constructor(store, opts = {}) {
    super();
    this.store = store;
    this.dir = store.dir;
    this.debounceMs = opts.debounceMs ?? 40;   // macOS coalescing window for watch hints
    this.reconcileMs = opts.reconcileMs ?? 5000; // dropped-event backstop: full dir diff
    // Rolling full re-read (t_42816253): stat-skip misses a same-size edit inside the mtime
    // granularity when its watch hint was dropped, so each round also re-reads 1/fullEvery of the
    // files regardless of stat — every file is content-checked once per fullEvery rounds (~60s).
    this.fullEvery = Math.max(1, opts.fullEvery ?? 12);
    this._round = 0;
    this.maxBodyBytes = opts.maxBodyBytes ?? 512 * 1024; // wiki pages above: metadata only, body lazy
    this.seq = 0;
    this.closed = false;
    this.tasks = new Map(); // id -> { data, file, mtimeMs, size, hash, version }
    this.wiki = new Map();  // title -> { title, slug, content, bodyCached, author, updatedAt, file, mtimeMs, size, hash, version }
    this._sortedTasks = null; // invalidated on every task put/delete
    this._pending = new Map(); // 'board'|'wiki' -> Set of basenames ('' = rescan whole section)
    this._debounce = null;
    this._watchers = [];
    this._timer = null;
    this._loaded = false;
  }

  // ---- lifecycle ----
  static forStore(store, opts) {
    let c = registry.get(store.dir);
    if (!c || c.closed) { c = new BoardCache(store, opts); registry.set(store.dir, c); }
    return c;
  }
  static closeDir(dir) { const c = registry.get(dir); if (c) c.close(); }
  static closeAll() { for (const c of [...registry.values()]) c.close(); }
  close() {
    if (this.closed) return;
    this.closed = true;
    registry.delete(this.dir);
    for (const w of this._watchers) { try { w.close(); } catch {} }
    this._watchers = [];
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._debounce) { clearTimeout(this._debounce); this._debounce = null; }
    this.tasks.clear(); this.wiki.clear(); this._pending.clear();
  }
  _ensureLoaded() {
    if (this._loaded || this.closed) return;
    // Set BEFORE the work: write-through hooks fire inside the store's write lock, so a nested
    // _ensureLoaded during this load must be a no-op (withLock is not re-entrant).
    this._loaded = true;
    // Inside the store's write lock the migration baselines are GUARANTEED done (every writer runs
    // _ensureBoard/_ensureWiki before taking the lock; _lockDepth proves who we are). Outside a
    // lock (read paths, reconcile timer) run them here — once per project dir per process.
    if (!this.store._lockDepth) { this.store._ensureBoard(); this.store._ensureWiki(); }
    this.loadAll();
    this._watch();
    this._timer = setInterval(() => { try { this.reconcile(); } catch {} }, this.reconcileMs);
    if (this._timer.unref) this._timer.unref();
  }

  // ---- loading / reconciliation (the source-of-truth side) ----
  // Lock-free by design: loadAll also runs from write-through hooks that already hold the store
  // lock, and a torn read here (a file half-swapped by another process) is handled by the parse
  // guards below plus the next hint/reconcile pass — never by blocking writers.
  loadAll() {
    const t0 = Date.now();
    this._adoptOutOfBandWiki();
    this.tasks.clear(); this._sortedTasks = null;
    for (const f of this.store._taskFiles()) this._revalidateTask(f, { quiet: true });
    this.wiki.clear();
    this._reloadWikiIndex();
    for (const [title, e] of Object.entries(this._wikiIndex())) this._revalidateWikiPage(title, e, { quiet: true });
    const s = this.stats();
    this.store._logStore(`board cache loaded: ${s.tasks} tasks (${kb(s.taskBytes)}), ${s.wikiPages} wiki pages (${kb(s.wikiBytes)}) in ${Date.now() - t0}ms`);
  }
  // Full dir diff vs the cache: the dropped-event backstop. Cheap (readdir + stat per file);
  // file CONTENT is re-read only when stat says something moved.
  reconcile() {
    if (this.closed) return;
    this._ensureLoaded();
    const known = new Set(this.tasks.keys());
    const round = ++this._round;
    this.store._taskFiles().forEach((f, i) => {
      known.delete(f.replace(/\.json$/, ''));
      this._revalidateTask(f, { statSkip: (i + round) % this.fullEvery !== 0 });
    });
    for (const id of known) this._dropTask(id, { verify: true });
    this._reloadWikiIndex();
    // Try-lock: a busy lock (an agent's MCP process mid-write-burst) must not spin-block the main
    // thread here — getAll queued behind the sleepSync spin and measured as a multi-second stall
    // (Quinn t_f4f6d15e). Skipping is safe: watch hints still deliver changes and the next
    // reconcile round retries the adoption.
    this.store.withLockTry(() => this._adoptOutOfBandWiki());
    for (const [title, e] of Object.entries(this._wikiIndex())) this._revalidateWikiPage(title, e);
    const indexed = new Set(Object.values(this._wikiIndex()).map((e) => e.slug));
    for (const [title, e] of [...this.wiki]) if (!indexed.has(e.slug)) this._dropWikiPage(title, e.slug, { verify: true });
  }

  // ---- fs.watch (the hint side) ----
  _watch() {
    for (const section of ['board', 'wiki']) {
      const dir = section === 'board' ? this.store.tasksDir() : this.store.wikiDir();
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      let w;
      try { w = fs.watch(dir, (event, filename) => this._onWatch(section, filename)); } catch { continue; }
      if (w.unref) w.unref();
      w.on('error', () => { try { w.close(); } catch {} }); // dir removed on project close: nothing to invalidate
      this._watchers.push(w);
    }
  }
  _onWatch(section, filename) {
    if (this.closed || !this._loaded) return;
    let base = filename == null ? '' : String(Buffer.isBuffer(filename) ? filename.toString('utf8') : filename);
    if (base.startsWith('.')) {
      if (!(section === 'wiki' && base === '.pages.json')) return; // tmp files / .hashes.json: never interesting
    } else if (section === 'board' && !base.endsWith('.json')) return;
    else if (section === 'wiki' && !(base.endsWith('.md') || base === '.pages.json')) return;
    let set = this._pending.get(section);
    if (!set) this._pending.set(section, (set = new Set()));
    set.add(base);
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => { this._debounce = null; this._drainPending(); }, this.debounceMs);
    if (this._debounce.unref) this._debounce.unref();
  }
  _drainPending() {
    for (const [section, set] of this._pending) {
      this._pending.delete(section);
      if (set.has('')) { // null filename or index change: rescan the section
        if (section === 'wiki') this._reloadWikiIndex();
        const files = section === 'board' ? this.store._taskFiles() : Object.values(this._wikiIndex()).map((e) => e.slug + '.md');
        for (const f of files) section === 'board' ? this._revalidateTask(f) : this._revalidateWikiFile(f);
        if (section === 'wiki') for (const [title, e] of Object.entries(this._wikiIndex())) this._revalidateWikiPage(title, e);
        continue;
      }
      for (const base of set) {
        if (section === 'board') this._revalidateTask(base);
        else if (base === '.pages.json') { this._reloadWikiIndex(); for (const [t, e] of Object.entries(this._wikiIndex())) this._revalidateWikiPage(t, e); }
        else this._revalidateWikiFile(base);
      }
    }
  }

  // ---- revalidation: disk vs cache, per file ----
  // statSkip (reconcile only): same mtime+size as cached => skip the read. Watch hints always
  // re-read, since a fast rewrite can keep both.
  _revalidateTask(file, { quiet = false, statSkip = false } = {}) {
    const p = this.store.taskFile(file.replace(/\.json$/, ''));
    let st; try { st = fs.statSync(p); } catch {
      const id = path.basename(file).replace(/\.json$/, '');
      if (this.tasks.has(id)) this._dropTask(id); // really gone (ENOENT): evict + delete event
      return;
    }
    const id = path.basename(file).replace(/\.json$/, '');
    const cur = this.tasks.get(id);
    if (statSkip && cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size) return;
    let buf; try { buf = fs.readFileSync(p); } catch { return; }
    const hash = sha256(buf);
    if (cur && cur.hash === hash) { Object.assign(cur, { mtimeMs: st.mtimeMs, size: st.size }); return; } // own-write echo or no-op event
    let data = null; try { data = JSON.parse(buf.toString('utf8')); } catch { data = null; }
    if (!data || data.id !== id) {
      // mid-write or junk from another process: keep the last good entry, retry on the next hint
      if (!quiet) this.store._logStore(`board cache: unreadable task file .squad/board/tasks/${path.basename(file)} — keeping the cached copy`);
      return;
    }
    this._putTask(data, { mtimeMs: st.mtimeMs, size: st.size, hash, quiet });
  }
  _revalidateWikiFile(base) {
    const slug = base.replace(/\.md$/, '');
    const title = this._titleBySlug().get(slug);
    if (!title) { this._onWatch('wiki', '.pages.json'); return; } // not indexed (yet): the index pass adopts it
    this._revalidateWikiPage(title, this._wikiIndex()[title]);
  }
  _revalidateWikiPage(title, entry, { quiet = false } = {}) {
    if (!entry) return;
    const p = path.join(this.store.wikiDir(), entry.slug + '.md');
    let st; try { st = fs.statSync(p); } catch { if (this.wiki.has(title)) this._dropWikiPage(title, entry.slug); return; }
    let buf; try { buf = fs.readFileSync(p); } catch { return; }
    const hash = sha256(buf);
    const cur = this.wiki.get(title);
    const metaChanged = !!cur && (cur.author !== (entry.author || '') || cur.updatedAt !== (entry.updatedAt || null));
    if (cur && cur.hash === hash && !metaChanged) { Object.assign(cur, { mtimeMs: st.mtimeMs, size: st.size }); return; }
    this._putWikiPage(title, entry, buf, { mtimeMs: st.mtimeMs, size: st.size, hash, quiet });
  }
  // Out-of-band .md files with no index entry: adopt (never silently drop) — mirrors what the
  // uncached listWiki has always done, but only during load/reconcile, never inside a read.
  _adoptOutOfBandWiki() {
    const idx = this._wikiIndex();
    const known = new Set(Object.values(idx).map((e) => e.slug + '.md'));
    let changed = false;
    for (const f of this.store._wikiFiles()) {
      if (known.has(f)) continue;
      let content = ''; try { content = fs.readFileSync(path.join(this.store.wikiDir(), f), 'utf8'); } catch { continue; }
      const title = f.replace(/\.md$/, '');
      idx[title] = { slug: title, author: 'unknown', updatedAt: new Date().toISOString(), hash: sha256(Buffer.from(content)) };
      this.store._logStore(`out-of-band file: .squad/wiki/${f} appeared outside the board tools; adopting it as wiki page "${title}"`);
      changed = true;
    }
    if (changed) this.store._saveWikiIndex(idx);
  }

  // ---- write-through (called by Store inside its write lock) ----
  // Prewarm at the top of Store write paths (BEFORE the lock): a first-ever write must delta
  // against the loaded state, not be silently swallowed by the initial quiet load.
  prewarm() { this._ensureLoaded(); }
  noteTaskPut(t, dataStr) {
    this._ensureLoaded();
    if (this.closed) return;
    const p = this.store.taskFile(t.id);
    let st = null; try { st = fs.statSync(p); } catch {}
    this._putTask(t, { mtimeMs: st ? st.mtimeMs : 0, size: st ? st.size : Buffer.byteLength(dataStr || ''), hash: sha256(Buffer.from(dataStr || '')) });
  }
  noteTaskDelete(tid) {
    this._ensureLoaded();
    if (this.closed) return;
    this._dropTask(tid);
  }
  // Full wiki section sync after our own wiki write/delete: re-read the index and the one page we
  // know changed (cheap), emit exactly one delta per changed page.
  noteWikiSync(changedSlug = null) {
    this._ensureLoaded();
    if (this.closed) return;
    this._reloadWikiIndex();
    const idx = this._wikiIndex();
    if (changedSlug) {
      const title = this._titleBySlug().get(changedSlug);
      if (title) this._revalidateWikiPage(title, idx[title]);
      else for (const [t, e] of [...this.wiki]) if (e.slug === changedSlug) this._dropWikiPage(t, changedSlug);
    }
    // index-only metadata changes (author/updatedAt of OTHER pages) are rare; catch them cheaply
    for (const [title, e] of Object.entries(idx)) { const cur = this.wiki.get(title); if (cur && (cur.author !== (e.author || '') || cur.updatedAt !== (e.updatedAt || null))) this._revalidateWikiPage(title, e); }
  }

  // ---- cache mutations + deltas ----
  _putTask(data, { mtimeMs, size, hash, quiet = false }) {
    const cur = this.tasks.get(data.id);
    const entry = { data, file: data.id + '.json', mtimeMs, size, hash, version: (cur ? cur.version : 0) + 1 };
    this.tasks.set(data.id, entry);
    this._sortedTasks = null;
    if (!quiet) this.emit('change', { section: 'task', id: data.id, type: 'put', seq: ++this.seq, version: entry.version, data });
  }
  _dropTask(id, { verify = false } = {}) {
    const cur = this.tasks.get(id);
    if (!cur) return;
    if (verify) { try { fs.statSync(this.store.taskFile(id)); return; } catch {} } // only on real ENOENT
    this.tasks.delete(id);
    this._sortedTasks = null;
    this.emit('change', { section: 'task', id, type: 'delete', seq: ++this.seq, version: cur.version });
  }
  _putWikiPage(title, entry, buf, { mtimeMs, size, hash, quiet = false }) {
    const cur = this.wiki.get(title);
    const bodyCached = buf.length <= this.maxBodyBytes;
    const e = { title, slug: entry.slug, content: bodyCached ? buf.toString('utf8') : undefined, bodyCached,
      author: entry.author || '', updatedAt: entry.updatedAt || null, file: entry.slug + '.md', mtimeMs, size, hash, version: (cur ? cur.version : 0) + 1 };
    this.wiki.set(title, e);
    if (!quiet) this.emit('change', { section: 'wiki', id: title, type: 'put', seq: ++this.seq, version: e.version, data: { title, content: e.content, author: e.author, updatedAt: e.updatedAt } });
  }
  _dropWikiPage(title, slug, { verify = false } = {}) {
    const cur = this.wiki.get(title);
    if (!cur) return;
    if (verify) { try { fs.statSync(path.join(this.store.wikiDir(), slug + '.md')); return; } catch {} }
    this.wiki.delete(title);
    this.emit('change', { section: 'wiki', id: title, type: 'delete', seq: ++this.seq, version: cur.version });
  }

  // ---- reads (warm: no syscalls) ----
  listTasks(filter = {}) {
    this._ensureLoaded();
    if (!this._sortedTasks) this._sortedTasks = [...this.tasks.values()].sort((a, b) => String(a.data.createdAt).localeCompare(String(b.data.createdAt)) || String(a.data.id).localeCompare(String(b.data.id)));
    let ts = this._sortedTasks.map((e) => e.data);
    if (filter.status) ts = ts.filter((t) => t.status === filter.status);
    if (filter.assignee) ts = ts.filter((t) => t.assignee === filter.assignee);
    return ts;
  }
  getTask(tid) {
    this._ensureLoaded();
    const hit = this.tasks.get(tid);
    if (hit) return hit.data;
    // Targeted miss (a task another process wrote a moment ago): one disk read + adopt, so a
    // get-after-MCP-write never waits for the watcher. Listing stays pure-cache. The hash covers
    // the RAW bytes so the following watcher echo compares equal and stays silent.
    let buf; try { buf = fs.readFileSync(this.store.taskFile(tid)); } catch { return undefined; }
    let data; try { data = JSON.parse(buf.toString('utf8')); } catch { return undefined; }
    if (!data || data.id !== tid) return undefined;
    let st = null; try { st = fs.statSync(this.store.taskFile(tid)); } catch {}
    this._putTask(data, { mtimeMs: st ? st.mtimeMs : 0, size: st ? st.size : 0, hash: sha256(buf) });
    return data;
  }
  listWiki() {
    this._ensureLoaded();
    const pages = {};
    for (const [title, e] of this.wiki) {
      let content = e.content;
      if (!e.bodyCached) { try { content = fs.readFileSync(path.join(this.store.wikiDir(), e.file), 'utf8'); } catch { continue; } }
      if (content == null) continue;
      pages[title] = { title, content, author: e.author, updatedAt: e.updatedAt };
    }
    return pages;
  }
  // The renderer's poll fingerprint, served from cache metadata: zero syscalls when warm.
  sectionSig(section) {
    this._ensureLoaded();
    let sig = '';
    const src = section === 'board' ? this.tasks : this.wiki;
    for (const key of [...src.keys()].sort()) { const e = src.get(key); sig += '|' + e.file + ':' + e.size + ':' + e.mtimeMs; }
    return sig;
  }
  stats() {
    let taskBytes = 0; for (const e of this.tasks.values()) taskBytes += e.size || 0;
    let wikiBytes = 0; for (const e of this.wiki.values()) wikiBytes += e.size || 0;
    return { tasks: this.tasks.size, taskBytes, wikiPages: this.wiki.size, wikiBytes };
  }

  // ---- wiki index helpers ----
  _wikiIndex() { if (!this._idx) this._reloadWikiIndex(); return this._idx; }
  _reloadWikiIndex() { this._idx = this.store._readWikiIndex(); this._bySlug = null; }
  _titleBySlug() {
    if (!this._bySlug) { this._bySlug = new Map(); for (const [title, e] of Object.entries(this._wikiIndex())) this._bySlug.set(e.slug, title); }
    return this._bySlug;
  }
}

const kb = (n) => Math.round((n || 0) / 1024) + 'kB';

module.exports = { BoardCache };
