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

  // --- Discovery: initial probe vs. two refresh probes, all merging the same real init event (no fixtures) ---
  const initial = CAP.discoverCapabilities(rt, {}, { cwd, initEvent });
  const refresh1 = CAP.discoverCapabilities(rt, {}, { cwd, initEvent });
  const refresh2 = CAP.discoverCapabilities(rt, {}, { cwd, initEvent });
  console.log('initial:', JSON.stringify({ ok: initial.ok, skills: initial.skills.length, commands: initial.commands.length, slashCommands: initial.slashCommands.length, counts: countBy(initial.categorized) }, null, 2));
  console.log('refresh1:', JSON.stringify({ ok: refresh1.ok, skills: refresh1.skills.length, commands: refresh1.commands.length, slashCommands: refresh1.slashCommands.length, counts: countBy(refresh1.categorized) }, null, 2));
  console.log('refresh2:', JSON.stringify({ ok: refresh2.ok, skills: refresh2.skills.length, commands: refresh2.commands.length, slashCommands: refresh2.slashCommands.length, counts: countBy(refresh2.categorized) }, null, 2));

  expect('discovery ok on the real machine', initial.ok === true, { error: initial.error });
  const ic = countBy(initial.categorized), rc1 = countBy(refresh1.categorized), rc2 = countBy(refresh2.categorized);
  expect('initial == refresh1 == refresh2 counts per category', JSON.stringify(ic) === JSON.stringify(rc1) && JSON.stringify(rc1) === JSON.stringify(rc2), { initial: ic, refresh1: rc1, refresh2: rc2 });
  const totalCommands = (ic.command || 0);
  const totalSkills = initial.skills.length;
  expect('Skills > 0', totalSkills > 0, totalSkills);
  // Approximate: this machine's real plugin/skill/command registry shifts over time (skills, plugins,
  // slash commands get added/removed), so pin to a loose band around the counts seen when this smoke was
  // written (commands≈123, skills≈58) rather than an exact match.
  expect('Commands ≈ 123 (same order of magnitude)', totalCommands >= 50 && totalCommands <= 250, totalCommands);
  expect('Skills ≈ 58 (same order of magnitude)', totalSkills >= 20 && totalSkills <= 150, totalSkills);
  expect('Modes > 0', (ic.mode || 0) > 0, ic.mode || 0);
  const modeNames = initial.categorized.filter((c) => c.category === 'mode').map((c) => c.name);
  console.log('mode names:', JSON.stringify(modeNames));
  expect('Modes include goal and loop', modeNames.includes('goal') && modeNames.includes('loop'), modeNames);

  // --- Limits: production usage.js parser against the real rate_limit_event (no fixture) ---
  const rateLimits = U.parseRateLimits(rateLimitEvent || {});
  console.log('parseRateLimits(rateLimitEvent):', JSON.stringify(rateLimits));
  expect('limits non-null (real rate_limit_event parsed by usage.js)', rateLimits != null, rateLimits);
  expect('5h pct is numeric', rateLimits && typeof rateLimits.fiveHour?.pct === 'number' && Number.isFinite(rateLimits.fiveHour.pct), rateLimits && rateLimits.fiveHour);
  expect('weekly pct is numeric', rateLimits && typeof rateLimits.weekly?.pct === 'number' && Number.isFinite(rateLimits.weekly.pct), rateLimits && rateLimits.weekly);

  if (fails.length) { console.error('SMOKE FAILED:', fails); process.exit(1); }
  console.log('SMOKE OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
