#!/usr/bin/env node
// Real-machine smoke (no fixtures): discovers capabilities against the real $HOME + this project (real
// `claude --help`, real .claude dirs), asserts initial == refresh counts and that goal/loop/workflow-relevant
// categories are non-empty; then runs one tiny real `claude` turn to capture a real rate_limits init event and
// asserts limits parse to non-null. Prints everything so a human can eyeball the raw counts/values.
const path = require('path');
const { spawn } = require('child_process');
const CAP = require('../src/capabilities');
const RT = require('../src/runtimes');
const U = require('../src/usage');

const cwd = path.join(__dirname, '..'); // this project (has its own .claude/skills, .claude/commands)
const fails = [];
const expect = (label, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, extra !== undefined ? JSON.stringify(extra) : ''); if (!ok) fails.push(label); };

function countBy(categorized) {
  const out = {};
  for (const c of categorized) out[c.category] = (out[c.category] || 0) + 1;
  return out;
}

// One tiny real `claude` turn (no fixture): captures the real system/init event (skills, slash commands — richer
// than --help, since these are the CLI's own live plugin/skill registry) and the real rate_limit_event (the
// CLI's own self-reported 5h/weekly utilization). Real cost: one trivial prompt, --max-turns 1.
function runRealClaudeTurn(rt) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (r) => { if (!resolved) { resolved = true; resolve(r); } };
    const child = spawn(rt.bin({}), ['-p', 'Reply with exactly: ok', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--permission-mode', 'bypassPermissions'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; let initEvent = null; let rateLimitEvent = null;
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'system' && ev.subtype === 'init') initEvent = ev;
          if (ev.type === 'rate_limit_event') rateLimitEvent = ev;
        } catch {}
      }
    });
    child.on('error', () => done({ initEvent, rateLimitEvent }));
    child.on('close', () => done({ initEvent, rateLimitEvent }));
    setTimeout(() => { child.kill(); done({ initEvent, rateLimitEvent }); }, 60000);
  });
}

async function main() {
  const rt = RT.getRuntime('claude');
  const { initEvent, rateLimitEvent } = await runRealClaudeTurn(rt);
  console.log('real init event:', initEvent ? JSON.stringify({ skills: (initEvent.skills || []).length, slash_commands: (initEvent.slash_commands || []).length }) : null);
  console.log('real rate_limit_event:', JSON.stringify(rateLimitEvent));

  // --- Discovery: initial probe vs. refresh probe, both merging the same real init event (no fixtures) ---
  const initial = CAP.discoverCapabilities(rt, {}, { cwd, initEvent });
  const refresh = CAP.discoverCapabilities(rt, {}, { cwd, initEvent });
  console.log('initial:', JSON.stringify({ ok: initial.ok, skills: initial.skills.length, commands: initial.commands.length, slashCommands: initial.slashCommands.length, counts: countBy(initial.categorized) }, null, 2));
  console.log('refresh:', JSON.stringify({ ok: refresh.ok, skills: refresh.skills.length, commands: refresh.commands.length, slashCommands: refresh.slashCommands.length, counts: countBy(refresh.categorized) }, null, 2));

  expect('discovery ok on the real machine', initial.ok === true, { error: initial.error });
  const ic = countBy(initial.categorized), rc = countBy(refresh.categorized);
  expect('initial == refresh counts per category', JSON.stringify(ic) === JSON.stringify(rc), { initial: ic, refresh: rc });
  expect('Skills > 0', initial.skills.length > 0, initial.skills.length);
  expect('Commands > 17', (ic.command || 0) > 17, ic.command || 0);
  expect('Modes >= 1', (ic.mode || 0) >= 1, ic.mode || 0);

  // --- Limits: production usage.js parser against the real rate_limit_event (no fixture) ---
  const rateLimits = U.parseRateLimits(rateLimitEvent || {});
  console.log('parseRateLimits(rateLimitEvent):', JSON.stringify(rateLimits));
  expect('limits non-null (real rate_limit_event parsed by usage.js)', rateLimits != null, rateLimits);

  if (fails.length) { console.error('SMOKE FAILED:', fails); process.exit(1); }
  console.log('SMOKE OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
