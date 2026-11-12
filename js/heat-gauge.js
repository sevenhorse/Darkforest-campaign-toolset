/* ==========================================================================
   js/heat-gauge.js - Heat gauge (roadmap item 4, switch 'heat_gauge', 2026-11-12)
   ==========================================================================
   Tracks how noticeable the colonies' building is, 0-10 (the DM's "heat"
   rule). DM decisions 2026-11-12:
     - A HEAT chip in the top bar; a click opens a panel with the bar, the
       3/5/7/9 marks and the log.
     - Players see the number, the quarter and the log, except entries marked
       hidden (Dark Forest Discipline). Only the DM adds, sets or removes.
     - The quarter follows the campaign clock (360-day year, so a quarter is
       2,160 hours) and is shown as the clock year: "YR 2888 Q4".
     - Every FINISHED quarter with no visible raise takes 1 off by itself.
       A hidden project adds nothing and the quarter still counts as quiet.
       After a long time skip the DM can log a project into an earlier
       quarter, and that quarter's -1 goes away.

   The number is never stored. It is worked out, the same way in every
   browser, from the rows of heat_log plus the clock (window.heatCompute):
   walk the quarters from the first entry to now, apply each entry in order
   ('set' states the number, 'change' adds its delta), then at the end of a
   finished quarter take 1 off unless it had a raise or a 'set' (a quarter
   where the DM stated the number by hand is left alone).
   Hidden rows are DM only in the database (RLS) and never touch the number,
   so players and the DM always get the same figure.

   What each threshold means is deliberately NOT in this file: the site's
   code is public and those are the DM's notes. */
(function () {
'use strict';
const HOURS_PER_QUARTER = 24 * 30 * 3;
const MARKS = [3, 5, 7, 9];
const H = window.__heat = window.__heat || { rows: null, loading: null, channel: null };
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
const on = () => typeof window.isFeatureOn === 'function' && window.isFeatureOn('heat_gauge');
const esc = (v) => window.escapeHtml(v == null ? '' : String(v));
const clamp = (n) => Math.max(0, Math.min(10, Math.round(Number(n) || 0)));
const nowHours = () => Math.round(Number(window.universeTimeHours) || 0);

window.heatQuarterOf = (hours) => Math.floor((Number(hours) || 0) / HOURS_PER_QUARTER);
window.heatQuarterLabel = (q) => `YR ${Math.floor(q / 4)} Q${((q % 4) + 4) % 4 + 1}`;

/* entries: heat_log rows (any order). Returns
   { heat, quarter, label, lines } where lines (oldest first) are
   { type: 'entry' | 'hidden' | 'quiet', q, heatAfter, e? }. */
window.heatCompute = function (entries, hours) {
    const qNow = window.heatQuarterOf(hours);
    const rows = (entries || []).filter(e => e && window.heatQuarterOf(e.clock_hours) <= qNow)
        .sort((a, b) => (Number(a.clock_hours) - Number(b.clock_hours)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const counted = rows.filter(e => !e.hidden);
    const out = { heat: 0, quarter: qNow, label: window.heatQuarterLabel(qNow), lines: [] };
    if (!rows.length) return out;
    const byQ = new Map();
    rows.forEach(e => { const q = window.heatQuarterOf(e.clock_hours); if (!byQ.has(q)) byQ.set(q, []); byQ.get(q).push(e); });
    let heat = 0;
    const qFirst = counted.length ? window.heatQuarterOf(counted[0].clock_hours) : null;
    for (let q = window.heatQuarterOf(rows[0].clock_hours); q <= qNow; q++) {
        let raised = false, stated = false;
        (byQ.get(q) || []).forEach(e => {
            if (e.hidden) { out.lines.push({ type: 'hidden', q, heatAfter: heat, e }); return; }
            if (e.kind === 'set') { heat = clamp(e.value); stated = true; }
            else { heat = clamp(heat + (Number(e.delta) || 0)); if (Number(e.delta) > 0) raised = true; }
            out.lines.push({ type: 'entry', q, heatAfter: heat, e });
        });
        // Nothing to cool before tracking starts, and nothing to show while heat sits at 0.
        if (q < qNow && qFirst !== null && q >= qFirst && !raised && !stated && heat > 0) {
            heat -= 1;
            out.lines.push({ type: 'quiet', q, heatAfter: heat });
        }
    }
    out.heat = heat;
    return out;
};
window.heatNow = () => window.heatCompute(H.rows || [], nowHours());

async function load() {
    if (H.loading) return H.loading;
    H.loading = (async () => {
        const { data, error } = await db.from('heat_log').select('*').order('clock_hours', { ascending: true });
        if (error) { console.warn('Heat gauge: could not load the log', error); return; }
        H.rows = data || [];
    })();
    try { await H.loading; } finally { H.loading = null; }
    render();
}
window.loadHeatLog = load;
function subscribe() {
    if (H.channel || !db.channel) return;
    try {
        H.channel = db.channel('heat_log_stream').on('postgres_changes', { event: '*', schema: 'public', table: 'heat_log' }, () => { load(); }).subscribe();
    } catch (e) { console.warn('Heat gauge: live updates unavailable', e); }
}

const levelColor = (h) => (h >= 7 ? '#ff3333' : h >= 5 ? '#ff8a3d' : h >= 3 ? '#ffaa00' : '#00e5a3');

function renderChip() {
    const chip = document.getElementById('heat-chip');
    if (!chip) return;
    const show = on() && typeof currentUserId !== 'undefined' && !!currentUserId;
    chip.style.display = show ? 'inline-block' : 'none';
    if (!show) { window.closeHeatBox(); return; }
    const s = window.heatNow();
    const text = `HEAT ${s.heat} · Q${((s.quarter % 4) + 4) % 4 + 1}`;
    if (chip.textContent !== text) chip.textContent = text;
    chip.title = `Heat ${s.heat} of 10 · ${s.label}. Click for the log.`;
    chip.style.color = levelColor(s.heat); chip.style.borderColor = levelColor(s.heat);
}

function lineHtml(l) {
    const q = window.heatQuarterLabel(l.q);
    if (l.type === 'quiet') return `<div class="tl-row"><span class="tl-time">${esc(q)}</span><span style="color:#6b826a; min-width:0; overflow-wrap:anywhere;">Quiet quarter <strong>−1</strong> → ${l.heatAfter}</span></div>`;
    const e = l.e;
    const del = isDm() && e.id ? `<button type="button" class="dt-x" title="Remove this entry" aria-label="Remove this entry" onclick="window.removeHeatEntry('${esc(e.id)}')">✕</button>` : '';
    if (l.type === 'hidden') return `<div class="tl-row"><span class="tl-time">${esc(q)}</span><span style="color:#c778dd; flex:1; min-width:0; overflow-wrap:anywhere;">🫥 Hidden (no heat): ${esc(e.reason || 'project')}</span>${del}</div>`;
    const what = e.kind === 'set' ? `Set to <strong>${clamp(e.value)}</strong>` : `<strong>${Number(e.delta) > 0 ? '+' : (Number(e.delta) < 0 ? '−' : '±')}${Math.abs(Number(e.delta) || 0)}</strong> → ${l.heatAfter}`;
    return `<div class="tl-row"><span class="tl-time">${esc(q)}</span><span style="color:#d4c5a9; flex:1; min-width:0; overflow-wrap:anywhere;">${what}${e.reason ? ` · ${esc(e.reason)}` : ''}</span>${del}</div>`;
}

function renderBox() {
    const box = document.getElementById('heat-box');
    if (!box || box.style.display !== 'block') return;
    const keep = {}; ['heat-reason', 'heat-set-value'].forEach(id => { const el = document.getElementById(id); if (el) keep[id] = el.value; });
    const keepQ = (document.getElementById('heat-quarter') || {}).value, keepHidden = (document.getElementById('heat-hidden') || {}).checked;
    const s = window.heatNow(), color = levelColor(s.heat);
    const cells = Array.from({ length: 10 }, (_, i) => `<span style="flex:1; height:10px; background:${i < s.heat ? color : '#0a1410'}; border:1px solid ${MARKS.includes(i + 1) ? '#d4c5a9' : '#3c4e36'};" title="${i + 1}${MARKS.includes(i + 1) ? ' (threshold)' : ''}"></span>`).join('');
    const quarters = Array.from({ length: 9 }, (_, i) => s.quarter - i).map((q, i) => `<option value="${q}">${i === 0 ? 'This quarter' : esc(window.heatQuarterLabel(q))}</option>`).join('');
    const lines = s.lines.slice().reverse().slice(0, 40);
    box.innerHTML = `
        <div class="dt-head"><span>HEAT · ${esc(s.label)}</span><button type="button" class="dt-x" aria-label="Close" onclick="window.closeHeatBox()">✕</button></div>
        <div style="display:flex; align-items:baseline; gap:8px; margin-bottom:6px;"><strong id="heat-number" style="font-size:22px; color:${color};">${s.heat}</strong><span style="font-size:10px; color:#6b826a;">of 10 · marks at ${MARKS.join(', ')}</span></div>
        <div role="img" aria-label="Heat ${s.heat} of 10" style="display:flex; gap:2px; margin-bottom:8px;">${cells}</div>
        ${isDm() ? `
        <label for="heat-reason" class="tl-hint">What happened? (the reason players will read)</label>
        <input type="text" id="heat-reason" maxlength="200" placeholder="e.g. Piraeus Shipyard comes online">
        <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px; flex-wrap:wrap;">
            <select id="heat-quarter" aria-label="Which quarter" style="width:auto; flex:1; min-width:110px; margin:0; font-size:10px;">${quarters}</select>
            <label style="display:inline-flex; gap:4px; align-items:center; font-size:10px; color:#c778dd; cursor:pointer;"><input type="checkbox" id="heat-hidden" style="width:auto; margin:0;"> hidden (DFD)</label>
        </div>
        <div style="display:flex; gap:6px; margin-bottom:8px;">
            <button type="button" class="btn-reveal" style="flex:1; margin:0;" onclick="window.addHeatChange(1)">+1 HEAT</button>
            <button type="button" class="layer-edit" style="flex:1; margin:0;" onclick="window.addHeatChange(-1)">−1</button>
        </div>
        <div style="display:flex; gap:6px; align-items:center; margin-bottom:8px;">
            <label for="heat-set-value" style="font-size:10px; color:#6b826a;">Set to</label>
            <input type="number" id="heat-set-value" min="0" max="10" step="1" value="${s.heat}" style="width:56px; margin:0;">
            <button type="button" class="layer-edit" style="flex:1; margin:0;" onclick="window.setHeatValue()">SET (now)</button>
        </div>` : ''}
        <div class="tl-list" style="max-height:220px; overflow-y:auto;">${lines.length ? lines.map(lineHtml).join('') : '<div class="tl-row" style="color:#6b826a;">Nothing logged yet.</div>'}</div>`;
    Object.keys(keep).forEach(id => { const el = document.getElementById(id); if (el && keep[id] !== undefined && id !== 'heat-set-value') el.value = keep[id]; });
    const qSel = document.getElementById('heat-quarter'); if (qSel && keepQ !== undefined && Array.from(qSel.options).some(o => o.value === keepQ)) qSel.value = keepQ;
    const hid = document.getElementById('heat-hidden'); if (hid && keepHidden) hid.checked = true;
}
function render() { try { renderChip(); renderBox(); } catch (e) { console.warn('Heat gauge render failed', e); } }
window.renderHeatGauge = render;

window.openHeatBox = async function (btn) {
    if (!on()) return;
    let box = document.getElementById('heat-box');
    if (!box) { box = document.createElement('div'); box.id = 'heat-box'; box.className = 'dt-pop tl-pop'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Heat'); document.body.appendChild(box); }
    if (box.style.display === 'block') { window.closeHeatBox(); return; }
    if (!H.rows) await load();
    box.style.display = 'block';
    renderBox();
    const r = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : { left: 20, bottom: 40, right: 320 };
    box.style.top = Math.max(8, Math.min(window.innerHeight - box.offsetHeight - 8, r.bottom + 6)) + 'px';
    box.style.left = Math.max(8, Math.min(window.innerWidth - box.offsetWidth - 8, r.right - box.offsetWidth)) + 'px';
};
window.closeHeatBox = function () { const box = document.getElementById('heat-box'); if (box) box.style.display = 'none'; };

async function insertEntry(row) {
    if (!isDm()) return false;
    const { data, error } = await db.from('heat_log').insert(row).select();
    if (error) { console.error('Heat gauge: could not save', error); if (window.showToast) window.showToast('Could not save the heat entry.', 'error'); return false; }
    H.rows = (H.rows || []).concat(data && data[0] ? [data[0]] : [Object.assign({ created_at: new Date().toISOString() }, row)]);
    render();
    return true;
}
window.addHeatChange = async function (delta) {
    if (!isDm()) return;
    const reason = ((document.getElementById('heat-reason') || {}).value || '').trim().slice(0, 200);
    const hidden = !!(document.getElementById('heat-hidden') || {}).checked;
    const s = window.heatNow();
    const q = Number((document.getElementById('heat-quarter') || {}).value);
    const backDated = Number.isFinite(q) && q < s.quarter;
    // An earlier quarter: stamped at that quarter's last hour, so it sorts after what is already there.
    const hours = backDated ? (q + 1) * HOURS_PER_QUARTER - 1 : nowHours();
    const targetQ = backDated ? q : s.quarter;
    if (hidden && (H.rows || []).some(e => e.hidden && window.heatQuarterOf(e.clock_hours) === targetQ) && window.showToast) window.showToast(`${window.heatQuarterLabel(targetQ)} already has a hidden project.`, 'error');
    const ok = await insertEntry({ kind: 'change', delta: delta > 0 ? 1 : -1, value: null, reason, hidden, clock_hours: hours });
    if (ok) { const r = document.getElementById('heat-reason'); if (r) r.value = ''; const h = document.getElementById('heat-hidden'); if (h) h.checked = false; }
};
window.setHeatValue = async function () {
    if (!isDm()) return;
    const v = clamp((document.getElementById('heat-set-value') || {}).value);
    const reason = ((document.getElementById('heat-reason') || {}).value || '').trim().slice(0, 200);
    const ok = await insertEntry({ kind: 'set', delta: 0, value: v, reason, hidden: false, clock_hours: nowHours() });
    if (ok) { const r = document.getElementById('heat-reason'); if (r) r.value = ''; }
};
window.removeHeatEntry = async function (id) {
    if (!isDm() || !id) return;
    if (!confirm('Remove this heat entry? The number is worked out again without it.')) return;
    const { error } = await db.from('heat_log').delete().eq('id', id);
    if (error) { console.error('Heat gauge: could not remove', error); if (window.showToast) window.showToast('Could not remove the entry.', 'error'); return; }
    H.rows = (H.rows || []).filter(e => e.id !== id);
    render();
};

function sync() {
    if (!on() || typeof currentUserId === 'undefined' || !currentUserId) { render(); return; }
    subscribe();
    if (!H.rows) load(); else render();
}
document.addEventListener('darkforest:features-changed', sync);
// The quarter rolls over with the clock: redraw whenever the clock display is updated.
if (typeof window.onHook === 'function') window.onHook('clock-display', 'heat-gauge', render);
})();
