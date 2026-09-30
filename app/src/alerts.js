// Alerts collector (t_6674705d): the ONE source that turns live team state into alert rows for the
// top-bar bell. Pure: no DOM, no IPC — the renderer passes a state snapshot and dispatches the
// returned action ops to the handlers that already exist. Kinds (Critic on t_7239c941): master red,
// restart pending, stopped with work left, agent failed/stuck, limits HIT, runtime down.
// Preflight-failed rows are emitted here so the state has a single source, but the bell filters
// kind 'preflight' out — the #pf-summary pill stays the only inline signal (Critic item 5).
// Shape: { id, kind, severity: 'error'|'warn', text, agentId?, taskId?, at, dismissable, fingerprint,
//          action: {label, op, arg?} | null }. Dismissal = id + fingerprint, in memory only.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Alerts = factory(); })(this, function () {
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const shortTaskId = (id) => /^t_/.test(id || '') ? id.slice(0, 6) : (id || '');
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  // Master-red snapshot (contract with Devon, t_897cca56): { red, since, failingTests: [name|{name}],
  // testOutput, fixTaskId, lastMergedTaskId, gateBlocks }. Moved here from the old #redbar renderer so
  // the collector owns the only parse of the payload.
  function normRedMaster(d) {
    if (!d || !d.red) return null;
    const names = (v) => (Array.isArray(v) ? v : []).map((t) => (typeof t === 'string' ? t : (t || {}).name || '')).filter(Boolean);
    return {
      since: +d.since || 0,
      tests: names(d.failingTests),
      output: String(d.testOutput || d.output || ''),
      fixTaskId: d.fixTaskId || null,
      lastMergedTaskId: d.lastMergedTaskId || null,
      blocks: (Array.isArray(d.gateBlocks) ? d.gateBlocks : []).map((b) => ({ taskId: b.taskId, tests: names(b.tests), at: +b.at || 0 })).filter((b) => b.taskId),
    };
  }

  // Provider/window pairs at or over the limit. Near-limit (w.warn) is deliberately NOT an alert in
  // v1 (Critic: normal states must not keep the bell amber). Handles the 0-1 and 0-100 pct scales
  // like the meter's normProviderWindow. One entry per provider: its worst hit window.
  function limitHits(st) {
    if (!st || typeof st !== 'object') return [];
    const pctOf = (w) => { let p = w.pct != null ? Number(w.pct) : (Number(w.limit) > 0 && w.used != null ? Number(w.used) / Number(w.limit) : null); if (p != null && (!Number.isFinite(p) || p < 0)) p = null; else if (p > 1) p /= 100; return p; };
    const isHit = (w) => w && (w.pause === true || (pctOf(w) != null && pctOf(w) >= 1));
    const raw = st.providers ? (Array.isArray(st.providers) ? st.providers : Object.entries(st.providers).map(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? { provider: k, ...v } : { provider: k }))) : [];
    const hits = [];
    for (const e of raw) {
      const provider = String((e && (e.provider != null ? e.provider : e.id)) || '').trim();
      if (!provider || provider.toLowerCase() === 'unknown') continue;
      for (const w of (Array.isArray(e.windows) ? e.windows : []).filter(isHit)) {
        const p = pctOf(w);
        hits.push({ provider: provider.toLowerCase(), name: cap(provider), win: String(w.label || '?'), pct: p != null ? Math.min(100, Math.round(p * 100)) : 100 });
      }
    }
    if (!raw.length) for (const [win, u] of [['5h', st.fiveHour], ['weekly', st.weekly]]) {
      if (!u || !u.limit) continue;
      const p = pctOf(u);
      if (u.pause === true || (p != null && p >= 1)) hits.push({ provider: win, name: win, win, pct: p != null ? Math.min(100, Math.round(p * 100)) : 100 });
    }
    const worst = new Map();
    for (const h of hits) { const prev = worst.get(h.provider); if (!prev || h.pct > prev.pct) worst.set(h.provider, h); }
    return [...worst.values()].sort((a, b) => b.pct - a.pct);
  }

  function collect(state) {
    const s = state || {};
    const out = [];
    const now = s.now || 0;
    const nameOf = (id) => (s.nodeNames || {})[id] || id;

    // 1. Master red — error, NOT dismissable: it blocks every merge and clears only with the state.
    const rm = normRedMaster(s.redMaster);
    if (rm) out.push({
      id: 'master-red', kind: 'master-red', severity: 'error', at: rm.since || now, dismissable: false,
      text: `Master is red — ${rm.tests.length} failing test${rm.tests.length === 1 ? '' : 's'}${rm.tests[0] ? `: ${clip(rm.tests[0], 44)}` : ''}, merges blocked${rm.fixTaskId ? '' : ' · no fix task yet'}`,
      agentId: null, taskId: rm.fixTaskId || null,
      fingerprint: `${rm.since}|${rm.tests.join(',')}`,
      action: rm.fixTaskId ? { label: 'Fix', op: 'open-task', arg: rm.fixTaskId } : null,
    });

    // 2. Restart pending (core restart gate). While stubbed, nothing is really known — stay quiet.
    // Dev-only machinery (t_7fbee55f): packaged builds can never restart themselves, so a stale
    // stored pending state must not surface here; devMode === false hides the row defensively.
    const rst = s.rst || {};
    if (s.devMode !== false && !rst.stub && (rst.pendingCount > 0 || rst.scheduledAfter || rst.scheduledNow)) {
      const bits = [];
      if (rst.pendingCount) bits.push(rst.targetSha ? `${rst.pendingCount} commit${rst.pendingCount === 1 ? '' : 's'} behind` : `${rst.pendingCount} change${rst.pendingCount === 1 ? '' : 's'}`);
      if (rst.scheduledAfter) bits.push(`after ${shortTaskId(rst.scheduledAfter)}`);
      else if (rst.scheduledNow) bits.push('once agents drain');
      out.push({
        id: 'restart-pending', kind: 'restart-pending', severity: 'warn', at: rst.since || now, dismissable: true,
        text: `Restart pending${bits.length ? ' — ' + bits.join(' · ') : ''}`, agentId: null, taskId: null,
        fingerprint: `${rst.pendingCount}|${rst.scheduledAfter || ''}|${rst.scheduledNow ? 1 : 0}`,
        action: { label: 'Restart now', op: 'restart-core' },
      });
    }

    // 3. Stopped with work left: in_progress with an assignee whose agent process is gone.
    const running = new Set(s.running || []);
    for (const t of s.tasks || []) {
      if (!t || t.status !== 'in_progress' || !t.assignee || running.has(t.assignee)) continue;
      out.push({
        id: `stuck-task:${t.id}`, kind: 'stuck-task', severity: 'warn', at: Date.parse(t.updatedAt) || now, dismissable: true,
        text: `${clip(t.title, 60)} — in progress, no live worker`, agentId: t.assignee, taskId: t.id,
        fingerprint: String(t.updatedAt || ''),
        action: { label: 'Open task', op: 'open-task', arg: t.id },
      });
    }

    // 4a. Agent stuck: working but silent for stuckMinutes (Overview.stuckAgents, precomputed).
    for (const id of s.stuck || []) {
      const a = (s.agents || {})[id] || {};
      out.push({
        id: `stuck-agent:${id}`, kind: 'stuck-agent', severity: 'warn', at: now, dismissable: true,
        text: `${nameOf(id)} stuck — no output for ${s.stuckMinutes || 5} min`, agentId: id, taskId: a.taskId || null,
        fingerprint: String(a.taskId || ''),
        action: a.taskId ? { label: 'Open task', op: 'open-task', arg: a.taskId } : { label: 'Open overview', op: 'open-overview' },
      });
    }
    // 4b. Agent failed: the supervisor exhausted its recoveries (stall.state 'recovery_failed').
    for (const x of s.stalls || []) {
      out.push({
        id: `agent-recovery:${x.id}`, kind: 'agent-recovery', severity: 'error', at: now, dismissable: true,
        text: `${nameOf(x.id)} — recovery failed (attempt ${x.st.attempt}/${x.st.max})`, agentId: x.id, taskId: x.st.taskId || null,
        fingerprint: `${x.st.attempt}|${x.st.taskId || ''}`,
        action: x.st.taskId ? { label: 'Open task', op: 'open-task', arg: x.st.taskId } : { label: 'Open overview', op: 'open-overview' },
      });
    }

    // 5. Limits HIT — one aggregate row for every provider paused or at 100%.
    const hits = limitHits(s.limits);
    if (hits.length) out.push({
      id: 'limits-hit', kind: 'limits-hit', severity: 'error', at: now, dismissable: true,
      text: hits.length === 1 ? `Limits hit — ${hits[0].name} ${hits[0].win} ${hits[0].pct}%` : `Limits hit — ${hits.length} providers (${hits.map((h) => h.name).join(', ')})`,
      agentId: null, taskId: null,
      fingerprint: hits.map((h) => `${h.provider}:${h.pct}`).join(','),
      action: { label: 'Open usage', op: 'open-usage' },
    });

    // 6. Runtime down (Critic on t_6674705d): severity error and NOT dismissable while it is down —
    // the old #rtbar never dismissed either, and the Resume path must stay reachable.
    const rtu = s.rtu;
    if (rtu && rtu.runtime) out.push({
      id: `runtime-down:${rtu.runtime}`, kind: 'runtime-down', severity: 'error', at: rtu.at || now, dismissable: false,
      text: `${rtu.label || cap(rtu.runtime)} unavailable — ${rtu.paused || 0} agent${rtu.paused === 1 ? '' : 's'} paused, new work waits`, agentId: null, taskId: null,
      fingerprint: `${rtu.runtime}|${rtu.at || ''}`,
      action: { label: 'Resume', op: 'resume-runtime', arg: rtu.runtime },
    });

    // 7. Preflight failed — emitted for the single-source contract; the bell filters kind 'preflight'.
    for (const n of s.teamNodes || []) {
      if (!n || (n.preflightStatus || 'untested') !== 'fail') continue;
      out.push({
        id: `preflight:${n.id}`, kind: 'preflight', severity: 'error', at: now, dismissable: true,
        text: `Preflight failed — ${n.name || n.id}`, agentId: n.id, taskId: null,
        fingerprint: String((n.preflight && n.preflight.at) || ''),
        action: { label: 'Retest', op: 'retest', arg: n.id },
      });
    }

    // Panel order (Brand spec §5): error first, then warn, newest first.
    return sortAlerts(out);
  }

  // Shared by the collector and the renderer (which appends its dev/test fakes before re-sorting).
  function sortAlerts(list) {
    const rank = { error: 0, warn: 1, info: 2 };
    return list.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || (b.at || 0) - (a.at || 0));
  }

  return { collect, normRedMaster, limitHits, sortAlerts };
});
