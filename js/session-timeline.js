/* ==========================================================================
   js/session-timeline.js - Session timeline + "mark this moment" (2026-10-29)
   ==========================================================================
   DM decision (2026-10-29): sessions are recorded on Discord (Craig) and
   transcribed afterwards; the DM wants landmarks to line the transcript up
   against, and an automatic write-up after each session reads them.

   - Table session_timeline (DM-only RLS): kind 'mark' (the DM's 📍 MARK
     button, optional note), 'reveal' / 'hide' (a Codex entry shown to or
     hidden from players, logged by js/codex-v2.js). Each row has the real
     time (created_at) and the in-game clock (universe_time_hours).
   - 📍 MARK sits next to SCRATCHPAD (DM only). It opens a small box: type a
     note or leave it blank, Enter saves. The box lists tonight's marks.
   - window.logTimeline(kind, note, entryId) is the one way to add a row;
     it does nothing for players and never blocks the caller.
   No feature switch: DM-only, requested, nothing players see. */
(function () {
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
const esc = (v) => window.escapeHtml(v == null ? '' : String(v));
const S = window.__timeline = window.__timeline || { recent: [] };

window.logTimeline = async function (kind, note, entryId) {
    if (!isDm()) return null;
    const row = { kind, note: String(note || '').slice(0, 2000), entry_id: entryId || null,
        universe_time_hours: typeof window.universeTimeHours === 'number' ? Math.round(window.universeTimeHours) : null };
    const { data, error } = await db.from('session_timeline').insert(row).select();
    if (error) { console.error('logTimeline: insert failed', error); return null; }
    const saved = (data && data[0]) || row;
    S.recent.unshift(saved); S.recent = S.recent.slice(0, 50);
    return saved;
};

// Tonight = the last 12 hours, so a session that runs past midnight stays together.
async function loadRecent() {
    if (!isDm()) return;
    const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const { data, error } = await db.from('session_timeline').select('*').gte('created_at', since).order('created_at', { ascending: false });
    if (!error && data) S.recent = data.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
const clock = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

function renderBox() {
    const box = document.getElementById('timeline-box'); if (!box) return;
    const tonight = (S.recent || []).slice(0, 8);
    box.innerHTML = `
        <div class="dt-head"><span>📍 MARK THIS MOMENT</span><button type="button" class="dt-x" aria-label="Close" onclick="window.closeTimelineBox()">✕</button></div>
        <label for="tl-note" class="tl-hint">What just happened? (optional, Enter saves)</label>
        <input type="text" id="tl-note" maxlength="300" placeholder="e.g. Seraphina's secret comes out" onkeydown="if (event.key === 'Enter') window.saveTimelineMark(); if (event.key === 'Escape') window.closeTimelineBox();">
        <button type="button" class="btn-reveal dt-roll" onclick="window.saveTimelineMark()">📍 MARK NOW</button>
        <div class="tl-list">${tonight.length ? tonight.map(r => `<div class="tl-row"><span class="tl-time">${esc(clock(r.created_at))}</span><span class="tl-kind tl-${esc(r.kind)}">${r.kind === 'mark' ? '📍' : (r.kind === 'reveal' ? '👁 SHOWN' : '🙈 HIDDEN')}</span><span class="tl-note">${esc(r.note || (r.kind === 'mark' ? '(no note)' : ''))}</span></div>`).join('') : '<div class="tl-empty">Nothing marked tonight yet.</div>'}</div>`;
}
window.openTimelineBox = async function (btn) {
    if (!isDm()) return;
    let box = document.getElementById('timeline-box');
    if (!box) { box = document.createElement('div'); box.id = 'timeline-box'; box.className = 'dt-pop tl-pop'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Mark this moment'); document.body.appendChild(box); }
    if (box.style.display === 'block') { window.closeTimelineBox(); return; }
    await loadRecent();
    renderBox();
    box.style.display = 'block';
    const r = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : { left: 20, bottom: 40, right: 320 };
    box.style.top = (r.bottom + 6) + 'px';
    box.style.left = Math.max(8, Math.min(window.innerWidth - box.offsetWidth - 8, r.right - box.offsetWidth)) + 'px';
    const input = document.getElementById('tl-note'); if (input) input.focus();
};
window.closeTimelineBox = function () { const box = document.getElementById('timeline-box'); if (box) box.style.display = 'none'; };
window.saveTimelineMark = async function () {
    const input = document.getElementById('tl-note');
    const saved = await window.logTimeline('mark', input ? input.value.trim() : '');
    if (!saved) { if (window.showToast) window.showToast('Could not save the mark.', 'error'); return; }
    if (window.showToast) window.showToast('📍 Moment marked.');
    renderBox();
    const again = document.getElementById('tl-note'); if (again) { again.value = ''; again.focus(); }
};
})();
