'use strict';
// Machine-wide heavy-work slot (t_h0a1c2fe). The user's live app lagged because merge-gate suites,
// perf harnesses and agents' own `npm test` runs all ran at once (load 14-35 on 8 cores). The root
// of every `npm test` run: (1) drops itself to low priority (children inherit it), (2) waits for the
// single machine-wide slot (a mkdir lock holding the owner's pid; dead owners are reaped), and
// (3) waits while the 1-min load is far above the core count. Children inherit
// AGENTS_SQUAD_HEAVY_SLOT and skip all of this. Set AGENTS_SQUAD_HEAVY_SLOT=off to bypass.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK = path.join(process.env.AGENTS_SQUAD_HEAVY_LOCK_DIR || os.tmpdir(), 'agents-squad-heavy.lock');
const MAX_WAIT_MS = Number(process.env.AGENTS_SQUAD_HEAVY_MAX_WAIT_MS || 20 * 60 * 1000);
const LOAD_LIMIT = os.cpus().length * 1.5;

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function owner() { try { return Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8')) || 0; } catch { return 0; } }

function tryTake() {
  try { fs.mkdirSync(LOCK); } catch (e) {
    if (e.code !== 'EEXIST') return true; // can't lock (odd fs): don't block tests
    const pid = owner();
    if (pid && alive(pid)) return false;
    // Owner died (or is mid-write: give it a moment before reaping).
    try { if (!pid && Date.now() - fs.statSync(LOCK).mtimeMs < 5000) return false; } catch { return false; }
    fs.rmSync(LOCK, { recursive: true, force: true });
    return false;
  }
  fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
  return true;
}

function install() {
  if (process.env.AGENTS_SQUAD_HEAVY_SLOT) return;
  process.env.AGENTS_SQUAD_HEAVY_SLOT = String(process.pid);
  try { os.setPriority(0, Math.max(os.getPriority(0), 10)); } catch {}
  const t0 = Date.now();
  let said = false;
  const note = (why) => { if (!said) { said = true; process.stderr.write(`[heavy-slot] waiting: ${why}\n`); } };
  while (Date.now() - t0 < MAX_WAIT_MS) {
    if (!tryTake()) { note(`another heavy suite holds ${LOCK} (pid ${owner()})`); sleep(2000); continue; }
    const load = os.loadavg()[0];
    if (load <= LOAD_LIMIT) break;
    note(`load ${load.toFixed(1)} > ${LOAD_LIMIT} on ${os.cpus().length} cores`);
    fs.rmSync(LOCK, { recursive: true, force: true }); // don't hog the slot while we wait on load
    sleep(5000);
  }
  if (owner() !== process.pid && !tryTake()) process.stderr.write('[heavy-slot] max wait reached; running anyway\n');
  process.on('exit', () => { if (owner() === process.pid) fs.rmSync(LOCK, { recursive: true, force: true }); });
}

module.exports = { install, LOCK };
