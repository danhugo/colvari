const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const U = require('../src/usage');

// Invariants for the Usage tab (t_e181e30a, parent t_4e6295b9): whatever the data layers produce,
// (1) there is never a duplicate row for the same usage key/account, (2) the header total equals
// the sum of the rows, summed RAW and rounded once, (3) a key with no usable cost renders "—",
// never a guessed $0, and stays out of the sum (flagged partial), (4) a legacy runtime-less
// non-claude run is never silently folded into the claude account.
//
// The fixture reproduces the live bug trio: ONE Claude subscription seen as three rows
// ("Claude · firstParty", "Claude · subscription", "unknown · firstParty · claude-opus-5-5").
// Renderer-level per the update-veil-freeze pattern: extract the real renderer/app.js
// implementations (ledgerFromRuns, runLedger, accountOf, usageHero, accountTable, modelTableBlock) and
// exercise them in node — no Electron, no gui-e2e.
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const lines = src.split('\n');
const grabLine = (what, re) => { const l = lines.find((x) => re.test(x)); assert.ok(l, `${what} line found in renderer/app.js`); return l; };
const chunks = src.split(/\nfunction /).slice(1);
const grabFn = (what) => { const c = chunks.find((x) => x.startsWith(what + '(')); assert.ok(c, `${what} function found in renderer/app.js`); return 'function ' + c; };

function buildRenderer() {
  const parts = [
    "'use strict';",
    grabLine('esc', /^const esc = /),
    grabLine('estTag', /^const estTag = /),
    grabLine('VENDOR', /^const VENDOR = /),
    'const findCustomRuntime = () => null;',
    grabLine('runtimeLabel', /^const runtimeLabel = /),
    // S.config is unset in this harness: canCost -> true, matching the app default for claude/unknown.
    'const canCost = () => true;',
    grabLine('billTag', /^const billTag = /),
    grabFn('runLedger'),
    grabFn('accountOf'),
    grabFn('ledgerFromRuns'),
    grabLine('rowTokTotal', /^const rowTokTotal = /),
    grabFn('ledgerCostCell'),
    grabFn('accountTable'),
    grabFn('modelTableBlock'),
    grabFn('usageHero'),
    'return { runLedger, ledgerFromRuns, rowTokTotal, ledgerCostCell, accountTable, modelTableBlock, usageHero };',
  ];
  // A grabbed function chunk runs to the next `function` keyword, so top-level consts between two
  // grabbed functions appear twice; drop re-declarations (col-0 const/function lines only).
  const seen = new Set();
  const body = [];
  for (const part of parts) for (const l of part.split('\n')) {
    const m = l.match(/^(?:const ([A-Za-z_$][\w$]*)|function ([A-Za-z_$][\w$]*))/);
    if (m) { const k = m[1] ? 'c:' + m[1] : 'f:' + m[2]; if (seen.has(k)) continue; seen.add(k); }
    body.push(l);
  }
  return new Function(body.join('\n'))();
}
const R = buildRenderer();

// --- the fixture: one Claude account, four run shapes (5 runs, 4 ledger keys) ---
const today = new Date().toISOString();
const ledger = (runtime, provider, model, inputTokens, outputTokens, costUsd) => (
  { runtime, provider, model, inputTokens, outputTokens, cacheReadTokens: null, cacheCreationTokens: null, costUsd, costSource: costUsd != null ? 'reported' : 'unknown' });
// legacy runtime-less run (pre-runtime persisted data, ledger re-synthesized with runtime 'unknown')
const legacyOpus = () => ({ id: 'r_legacy', kind: 'agent', startedAt: today, agent: 'Ada', nodeId: 'n_ada', runtime: undefined, model: 'claude-opus-5-5', billingSource: 'unknown', inputTokens: 1000, outputTokens: 200, cacheReadTokens: null, cacheCreationTokens: null, reportedCostUsd: 0.014, ledger: [ledger('unknown', 'firstParty', 'claude-opus-5-5', 1000, 200, 0.014)] });
// firstParty = the claude CLI's own label for Anthropic-direct usage (an API-key run here)
const firstPartySonnet = () => ({ id: 'r_api', kind: 'agent', startedAt: today, agent: 'Bo', nodeId: 'n_bo', runtime: 'claude', model: 'claude-sonnet-4-5', billingSource: 'api', inputTokens: 400, outputTokens: 100, cacheReadTokens: null, cacheCreationTokens: null, reportedCostUsd: 0.013, ledger: [ledger('claude', 'firstParty', 'claude-sonnet-4-5', 400, 100, 0.013)] });
// the same subscription, two runs on two agents — must land in ONE row
const subHaiku = (i, agent, node, inTok, outTok, cost) => ({ id: 'r_sub' + i, kind: 'agent', startedAt: today, agent, nodeId: node, runtime: 'claude', model: 'claude-haiku-4-5', billingSource: 'subscription', inputTokens: inTok, outputTokens: outTok, cacheReadTokens: null, cacheCreationTokens: null, reportedCostUsd: cost, ledger: [ledger('claude', 'subscription', 'claude-haiku-4-5', inTok, outTok, cost)] });
// legacy runtime-less NON-claude run: flat record, no persisted ledger (synthesis path), model has
// no price-table entry and reports no cost — the "model without a price" case.
const legacyMistral = () => ({ id: 'r_legacy2', kind: 'agent', startedAt: today, agent: 'Cy', nodeId: 'n_cy', runtime: undefined, model: 'mistral-large', billingSource: 'unknown', inputTokens: 300, outputTokens: 100, reportedCostUsd: 0 });
const claudeRuns = () => [legacyOpus(), firstPartySonnet(), subHaiku(1, 'Pia', 'n_pia', 250, 50, 0.015), subHaiku(2, 'Rhea', 'n_rhea', 220, 40, 0.014)];
const allRuns = () => [...claudeRuns(), legacyMistral()];
const GRAND = 0.056; // 0.014 + 0.013 + 0.015 + 0.014, raw

test('renderer ledger: no duplicate rows — the 5-run fixture collapses to exactly one row per key', () => {
  const led = R.ledgerFromRuns(allRuns());
  const keys = led.rows.map((r) => `${r.runtime}¦${r.provider}¦${r.model}`);
  assert.equal(led.rows.length, 4, 'one row per distinct key, never one per run');
  assert.equal(new Set(keys).size, 4, 'keys are unique');
  const haiku = led.rows.find((r) => r.model === 'claude-haiku-4-5');
  assert.equal(haiku.runs, 2, 'the two subscription runs share one row across agents');
  assert.ok(Math.abs(haiku.costUsd - 0.029) < 1e-9, 'their costs merge into that one row');
  assert.equal(haiku.inputTokens, 470); assert.equal(haiku.outputTokens, 90);
  assert.equal(haiku.cacheReadTokens, null, 'cache stays unknown (null), never a fabricated 0');
});

test('renderer account table: every account renders exactly one <tr>, every model key exactly once', () => {
  const led = R.ledgerFromRuns(allRuns());
  assert.equal(new Set(led.accounts.map((a) => a.key)).size, led.accounts.length, 'account keys are unique');
  const html = R.accountTable(led.accounts);
  assert.equal((html.match(/<tr class="us-acct">/g) || []).length, led.accounts.length, 'one row per account, never one per run');
  for (const model of ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-5-5', 'mistral-large']) {
    assert.equal((html.match(new RegExp(`>${model}<`, 'g')) || []).length, 1, `${model} renders once`);
  }
  assert.ok(html.includes('$0.0290'), 'merged subscription key shows the summed $ (0.015 + 0.014)');
  assert.ok(html.includes('$0.0140') && html.includes('$0.0130'));
  assert.ok(html.includes('—'), 'the unpriced mistral key renders an explicit em-dash, never a guessed $0');
});

test('header grand total == Σ row costs, summed raw and rounded ONCE (never per row)', () => {
  const led = R.ledgerFromRuns(allRuns());
  assert.ok(Math.abs(led.costUsd - GRAND) < 1e-9, 'ledger total is the raw sum');
  const hero = R.usageHero(allRuns(), led);
  const m = hero.match(/API-eq, grand total<\/small><b[^>]*>\$([\d.]+)</);
  assert.ok(m, 'hero carries the grand-total KPI');
  assert.equal(m[1], GRAND.toFixed(2), 'header shows the raw sum rounded once');
  const perRow = led.rows.reduce((a, r) => a + +(r.costUsd != null ? r.costUsd.toFixed(2) : 0), 0);
  assert.notEqual(perRow.toFixed(2), GRAND.toFixed(2), 'rounding per row first would drift — the header must not');
  const perAccount = led.accounts.reduce((a, r) => a + (r.costUsd || 0), 0);
  assert.ok(Math.abs(perAccount - GRAND) < 1e-9, 'Σ account rows (raw, unknown-cost ones excluded) == grand total');
  assert.ok(hero.includes('partial — some keys report no cost'), 'unknown-cost key flags the total as partial');
  assert.ok(hero.match(/<b>4<\/b>/), 'model-key count is 4, not 5 (runs, not rows)');
});

test('model sub-rows sum to the same header total (by-model table)', () => {
  const led = R.ledgerFromRuns(allRuns());
  const html = R.modelTableBlock(led.rows);
  const sum = html.split('</tr>').filter((row) => /\$[\d.]+/.test(row))
    .reduce((a, row) => a + +((row.match(/\$([\d.]+)/) || [])[1] || 0), 0);
  assert.ok(Math.abs(sum - GRAND) < 1e-9, `Σ per-model costs (${sum}) == grand total`);
  const haiku = html.split('</tr>').find((row) => row.includes('claude-haiku-4-5'));
  assert.ok(haiku.includes('>560<'), 'by-model tokens merge across the row\'s runs (470 in + 90 out)');
  assert.ok(haiku.includes('$0.0290'), 'by-model cost merges across providers of the same model');
});

test('a model without a price reports "—", stays out of the total, flags partial — never a $0', () => {
  const led = R.ledgerFromRuns(allRuns());
  const mistral = led.rows.find((r) => r.model === 'mistral-large');
  assert.equal(mistral.costUsd, null);
  assert.equal(mistral.costSource, 'unknown');
  assert.equal(led.costPartial, true);
  const cell = R.ledgerCostCell(mistral);
  assert.ok(cell.includes('—'), 'renders an explicit em-dash');
  assert.match(cell, /no cost reported or estimable/);
  const without = R.ledgerFromRuns(claudeRuns());
  assert.ok(Math.abs(without.costUsd - GRAND) < 1e-9, 'removing the unknown-cost run changes nothing in the $ total');
  assert.equal(without.costPartial, false);
});

test('legacy runtime-less non-claude run keeps its own row — never folded into claude rows', () => {
  const led = R.ledgerFromRuns(allRuns());
  const mistral = led.rows.find((r) => r.model === 'mistral-large');
  assert.ok(mistral, 'the legacy mistral run is tracked, not dropped');
  assert.equal(mistral.runtime, 'unknown');
  for (const r of led.rows.filter((x) => x.runtime === 'claude')) {
    assert.match(r.model, /^claude/, 'claude-labelled rows carry only claude models');
  }
  assert.equal(led.rows.length, 4, 'it is its own row, not a fifth claude variant');
});

test('backend ledger (S.orch.ledger, the unfiltered view) upholds the same invariants', () => {
  const led = U.usageLedger(allRuns());
  assert.equal(led.rows.length, 4);
  assert.equal(new Set(led.rows.map((r) => r.model)).size, 4, 'no duplicate rows from the backend producer either');
  assert.ok(Math.abs(led.costUsd - GRAND) < 1e-9);
  assert.equal(led.costPartial, true);
  for (const r of led.rows.filter((x) => x.runtime === 'claude')) assert.match(r.model, /^claude/);
});

// --- account-layer contract (Devon, t_f514cc2e) --------------------------------------------
// Agreed shape: usage rows grouped by ACCOUNT (provider + billing; firstParty == subscription for
// claude; runtime-less legacy claude-* runs fold into the claude account), each row exposing
// apiEq (raw API-equivalent $) and billed, header apiEq == Σ row.apiEq. Lands either as
// U.accountLedger(runs) or as an `account` field on usageLedger rows — both arm these tests.
const accountView = (runs) => {
  if (typeof U.accountLedger === 'function') return U.accountLedger(runs);
  const led = U.usageLedger(runs);
  return led.rows.length && led.rows.every((r) => 'account' in r) ? led : null;
};
const needsAccountLayer = 'arms when t_f514cc2e lands (account grouping + apiEq/billed on usage rows)';
const skipAccount = () => { try { return accountView(allRuns()) ? false : needsAccountLayer; } catch { return needsAccountLayer; } };
const modelMention = (r) => JSON.stringify(r.models || [r.model]);

test('account: legacy runtime-less + firstParty + subscription claude runs are ONE account row', { skip: skipAccount() }, () => {
  const v = accountView(allRuns());
  const claudeRows = v.rows.filter((r) => modelMention(r).includes('claude'));
  assert.ok(claudeRows.length, 'claude usage is present');
  assert.equal(new Set(claudeRows.map((r) => r.account)).size, 1, 'the three label variants share one account');
  if (v.rows.some((r) => Array.isArray(r.models))) {
    assert.equal(claudeRows.length, 1, 'nested shape: exactly one claude account row carrying the model breakdown');
  }
  const mistralRows = v.rows.filter((r) => modelMention(r).includes('mistral'));
  assert.ok(mistralRows.length, 'the unpriced legacy non-claude run is still tracked');
  const claudeAccounts = [...new Set(claudeRows.map((r) => r.account))];
  assert.ok(mistralRows.every((r) => !claudeAccounts.includes(r.account)), 'it is never folded into the claude account');
});

test('account: header API-eq == Σ per-row API-eq, raw sum rounded once at the header', { skip: skipAccount() }, () => {
  const v = accountView(allRuns());
  const sum = v.rows.reduce((a, r) => a + (r.apiEq || 0), 0);
  assert.ok(Math.abs(v.apiEq - sum) < 1e-9, `header apiEq (${v.apiEq}) must equal Σ rows (${sum})`);
  assert.ok(Math.abs(v.apiEq - GRAND) < 1e-9, 'fixture total is the raw 0.056, not the 0.05 per-row-rounded drift');
  assert.equal(v.apiEq.toFixed(2), '0.06');
  if ('billed' in v) assert.ok(Math.abs(v.billed - v.rows.reduce((a, r) => a + (r.billed || 0), 0)) < 1e-9);
});
