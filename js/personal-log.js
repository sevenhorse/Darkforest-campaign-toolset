/* ==========================================================================
   js/personal-log.js - Personal Log (Dossier tab, switch 'personal_log')
   ==========================================================================
   Player request (2026-10-11). DM decisions: private to the owner and the
   DM; opt-in per player; simple counters; a fifth Dossier tab.

   Data: table character_personal_log (one row per profile, RLS = owner or
   DM via df_is_dm, so other players can't read it even from the API).
   partners = [{ id, name, species, notable, count }]; offspring (int),
   offspring_notes (text); enabled = the player's opt-in.

   Each partner row carries its species, so nothing is entered twice:
     combined total = sum of counts
     per species    = counts grouped by species
     unique species = species with at least one encounter
   Anonymous / one-off encounters go in rows like "Various · Human".

   The opt-in tick box sits on the Dossier's PROFILE tab; the PERSONAL LOG
   tab only appears once it's ticked (crew-v2.js asks
   personalLogTabVisible). Turning it off hides the tab and keeps the data.
   The DM gets a read-only summary on the Crew Roster detail for any
   player who opted in. Saves are debounced upserts.
   ========================================================================== */
(function () {
const byId = (id) => document.getElementById(id);
const esc = (s) => (typeof window.escapeHtml === 'function' ? window.escapeHtml(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
const PL = window.__pl = window.__pl || { row: null, forUser: null, all: {}, saveTimer: 0 };
window.personalLogOn = function () { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('personal_log'); };
const crewOn = () => typeof window.crewRestyleOn === 'function' && window.crewRestyleOn();
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
const myId = () => (typeof currentUserId !== 'undefined' ? currentUserId : null);
window.personalLogTabVisible = function () { return window.personalLogOn() && crewOn() && !!(PL.row && PL.row.enabled); };

const blank = (pid) => ({ profile_id: pid, enabled: false, partners: [], offspring: 0, offspring_notes: '' });
const clean = (r, pid) => {
    const x = Object.assign(blank(pid), r || {});
    x.partners = Array.isArray(x.partners) ? x.partners.map(p => ({ id: p.id || newId(), name: String(p.name || ''), species: String(p.species || ''), notable: !!p.notable, count: Math.max(0, parseInt(p.count, 10) || 0) })) : [];
    x.offspring = Math.max(0, parseInt(x.offspring, 10) || 0);
    x.offspring_notes = String(x.offspring_notes || '');
    return x;
};
function newId() { return 'p' + Math.random().toString(36).slice(2, 10); }

// Totals (exported for tests and the DM summary).
function stats(row) {
    const parts = (row && row.partners) || [];
    const total = parts.reduce((n, p) => n + (p.count || 0), 0);
    const bySpecies = {};
    parts.forEach(p => { const k = (p.species || '').trim() || 'Unspecified'; bySpecies[k] = (bySpecies[k] || 0) + (p.count || 0); });
    const species = Object.keys(bySpecies).map(k => ({ name: k, count: bySpecies[k] })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { total, species, unique: species.filter(s => s.count > 0 && s.name !== 'Unspecified').length,
        notable: parts.filter(p => p.notable).length, offspring: (row && row.offspring) || 0 };
}
window.personalLogStats = stats;

async function load(force) {
    const uid = myId();
    if (!uid || typeof db === 'undefined') return;
    if (!force && PL.forUser === uid && PL.row) return;
    try {
        const { data } = await db.from('character_personal_log').select('*').eq('profile_id', uid);
        const rows = Array.isArray(data) ? data : (data ? [data] : []);
        PL.row = clean(rows[rows.length - 1], uid);
    } catch (e) { PL.row = clean(null, uid); }
    PL.forUser = uid;
}
async function loadAllForDm() {
    if (!isDm() || typeof db === 'undefined') return;
    try {
        const { data } = await db.from('character_personal_log').select('*');
        PL.all = {};
        (data || []).forEach(r => { PL.all[r.profile_id] = clean(r, r.profile_id); });
    } catch (e) {}
}
async function saveNow() {
    clearTimeout(PL.saveTimer);
    if (!PL.row || typeof db === 'undefined') return;
    const r = PL.row;
    const payload = { profile_id: r.profile_id, enabled: r.enabled, partners: r.partners, offspring: r.offspring, offspring_notes: r.offspring_notes, updated_at: new Date().toISOString() };
    try { await db.from('character_personal_log').upsert(payload, { onConflict: 'profile_id' }); } catch (e) {}
    if (isDm()) PL.all[r.profile_id] = clean(payload, r.profile_id);
}
function saveSoon() { clearTimeout(PL.saveTimer); PL.saveTimer = setTimeout(saveNow, 600); }
window.personalLogSaveNow = saveNow;

// ---- PROFILE tab: the opt-in tick box ----
function renderOptIn() {
    const pane = byId('cv-pane-profile');
    if (!pane) return;
    let box = byId('pl-optin');
    if (!window.personalLogOn() || !crewOn() || !PL.row) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.id = 'pl-optin'; box.className = 'pl-optin'; pane.appendChild(box); }
    box.innerHTML = `<label><input type="checkbox" id="pl-enabled"${PL.row.enabled ? ' checked' : ''}> Show the PERSONAL LOG tab</label>
        <span>🔒 Private — only you and the Overseer can see it. Turning it off hides the tab and keeps what you've logged.</span>`;
}

// ---- PERSONAL LOG tab ----
function speciesOptions() {
    const seen = new Set();
    (PL.row.partners || []).forEach(p => { const s = (p.species || '').trim(); if (s) seen.add(s); });
    return Array.from(seen).sort().map(s => `<option value="${esc(s)}"></option>`).join('');
}
function summaryHtml() {
    const st = stats(PL.row);
    return `<div class="dz-fact"><span>COMBINED TOTAL</span><b>${st.total}</b></div>
        <div class="dz-fact"><span>NOTABLE PARTNERS</span><b>${st.notable}</b></div>
        <div class="dz-fact"><span>UNIQUE SPECIES</span><b>${st.unique}</b></div>
        <div class="dz-fact pl-off"><span>OFFSPRING</span><span class="pl-step"><button type="button" class="dz-btn dim" data-plact="off-" aria-label="One fewer offspring">−</button><b id="pl-off-n">${st.offspring}</b><button type="button" class="dz-btn" data-plact="off+" aria-label="One more offspring">+</button></span></div>`;
}
function speciesHtml() {
    const st = stats(PL.row);
    return st.species.length ? st.species.map(s => `<div class="pl-sp"><span>${esc(s.name)}</span><b>${s.count}</b></div>`).join('') : '<div class="dz-empty">Species totals appear here as you add partners.</div>';
}
function partnerRowHtml(p) {
    return `<div class="pl-row" data-plid="${esc(p.id)}">
        <button type="button" class="pl-star${p.notable ? ' on' : ''}" data-plact="notable" aria-pressed="${p.notable}" title="Notable partner (named / recurring NPC)" aria-label="Mark notable">★</button>
        <input type="text" data-plf="name" value="${esc(p.name)}" placeholder="Partner name" aria-label="Partner name">
        <input type="text" data-plf="species" value="${esc(p.species)}" placeholder="Species" list="pl-species-list" aria-label="Species">
        <span class="pl-step"><button type="button" class="dz-btn dim" data-plact="minus" aria-label="One fewer">−</button><input type="number" min="0" data-plf="count" value="${p.count}" aria-label="Count"><button type="button" class="dz-btn" data-plact="plus" aria-label="One more">+</button></span>
        <button type="button" class="dz-btn red pl-del" data-plact="remove" aria-label="Remove partner">✕</button>
    </div>`;
}
function renderPane() {
    const pane = byId('cv-pane-personal');
    if (!pane) return;
    if (!window.personalLogTabVisible()) { pane.innerHTML = ''; return; }
    const r = PL.row;
    pane.innerHTML = `<div class="pl-wrap">
        <div class="dz-facts pl-sum" id="pl-sum">${summaryHtml()}</div>
        <div class="pl-cols">
            <div class="sheet-section pl-partners"><h4>PARTNERS</h4>
                <div class="pl-head"><span></span><span>NAME</span><span>SPECIES</span><span>ENCOUNTERS</span><span></span></div>
                <div id="pl-rows">${r.partners.map(partnerRowHtml).join('') || ''}</div>
                ${r.partners.length ? '' : '<div class="dz-empty" id="pl-none">No partners logged yet. Use + ADD PARTNER; one-off encounters can share a row like "Various · Human".</div>'}
                <div class="pl-add"><button type="button" class="dz-btn" data-plact="add">+ ADD PARTNER</button></div>
                <datalist id="pl-species-list">${speciesOptions()}</datalist>
            </div>
            <div class="pl-side">
                <div class="sheet-section"><h4>BY SPECIES</h4><div id="pl-species">${speciesHtml()}</div></div>
                <div class="sheet-section"><h4>OFFSPRING NOTES</h4><textarea id="pl-off-notes" rows="4" placeholder="Names, parents, where they are now…">${esc(r.offspring_notes)}</textarea></div>
            </div>
        </div>
        <p class="pl-private">🔒 Private — only you and the Overseer can see this tab.</p>
    </div>`;
}
function refreshTotals() {
    const sum = byId('pl-sum'); if (sum) sum.innerHTML = summaryHtml();
    const sp = byId('pl-species'); if (sp) sp.innerHTML = speciesHtml();
    const dl = byId('pl-species-list'); if (dl) dl.innerHTML = speciesOptions();
}

async function render(tab) {
    if (!window.personalLogOn() || !crewOn()) { renderOptIn(); renderPane(); return; }
    await load();
    renderOptIn();
    if (tab === undefined) tab = window.__cv && window.__cv.tab;
    if (tab === 'personal') renderPane();
}
window.renderPersonalLog = render;

// ---- events ----
const partnerOf = (el) => { const row = el.closest('.pl-row'); return row && PL.row ? PL.row.partners.find(p => p.id === row.dataset.plid) : null; };
document.addEventListener('change', async (e) => {
    if (e.target && e.target.id === 'pl-enabled' && PL.row) {
        PL.row.enabled = e.target.checked;
        await saveNow();
        if (typeof window.renderCrewDossier === 'function') window.renderCrewDossier();
    }
});
document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.closest || !t.closest('#cv-pane-personal') || !PL.row) return;
    if (t.id === 'pl-off-notes') { PL.row.offspring_notes = t.value; saveSoon(); return; }
    const p = partnerOf(t);
    if (!p || !t.dataset.plf) return;
    if (t.dataset.plf === 'count') p.count = Math.max(0, parseInt(t.value, 10) || 0);
    else p[t.dataset.plf] = t.value;
    refreshTotals();
    saveSoon();
});
document.addEventListener('click', async (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#cv-pane-personal [data-plact]') : null;
    if (!b || !PL.row) return;
    const act = b.dataset.plact, r = PL.row;
    if (act === 'add') {
        r.partners.push({ id: newId(), name: '', species: '', notable: false, count: 1 });
        renderPane(); saveSoon();
        const rows = document.querySelectorAll('#pl-rows .pl-row input[data-plf="name"]'); if (rows.length) rows[rows.length - 1].focus();
        return;
    }
    if (act === 'off+' || act === 'off-') { r.offspring = Math.max(0, r.offspring + (act === 'off+' ? 1 : -1)); refreshTotals(); saveSoon(); return; }
    const p = partnerOf(b);
    if (!p) return;
    if (act === 'plus' || act === 'minus') {
        p.count = Math.max(0, p.count + (act === 'plus' ? 1 : -1));
        const inp = b.parentNode.querySelector('input[data-plf="count"]'); if (inp) inp.value = p.count;
    } else if (act === 'notable') {
        p.notable = !p.notable; b.classList.toggle('on', p.notable); b.setAttribute('aria-pressed', String(p.notable));
    } else if (act === 'remove') {
        const ok = typeof window.showConfirmModal === 'function' ? await window.showConfirmModal(`Remove ${p.name || 'this partner'} from your log?`) : true;
        if (!ok) return;
        r.partners = r.partners.filter(x => x.id !== p.id);
        renderPane(); saveSoon(); return;
    }
    refreshTotals(); saveSoon();
});

// ---- DM: read-only summary on the Crew Roster detail ----
function renderDmSummary() {
    const detail = byId('rz-detail');
    let box = byId('pl-dm');
    const sel = window.__rz && window.__rz.sel;
    const row = sel ? PL.all[sel] : null;
    if (!detail || !isDm() || !window.personalLogOn() || !row || !row.enabled) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.id = 'pl-dm'; box.className = 'sheet-section pl-dm'; detail.appendChild(box); }
    const st = stats(row);
    const top = row.partners.filter(p => p.count > 0).sort((a, b) => (b.notable - a.notable) || (b.count - a.count)).slice(0, 12);
    box.innerHTML = `<h4>PERSONAL LOG <i>PRIVATE · OWNER + OVERSEER</i></h4>
        <div class="dz-facts">${[['COMBINED TOTAL', st.total], ['NOTABLE PARTNERS', st.notable], ['UNIQUE SPECIES', st.unique], ['OFFSPRING', st.offspring]].map(([k, v]) => `<div class="dz-fact"><span>${k}</span><b>${v}</b></div>`).join('')}</div>
        ${top.length ? `<div class="pl-dmlist">${top.map(p => `<div class="pl-sp"><span>${p.notable ? '★ ' : ''}${esc(p.name || '—')} <em>${esc(p.species || '')}</em></span><b>${p.count}</b></div>`).join('')}</div>` : ''}
        ${row.offspring_notes ? `<p class="pl-dmnotes">${esc(row.offspring_notes)}</p>` : ''}`;
}
async function refreshDm() { if (isDm() && window.personalLogOn()) { await loadAllForDm(); renderDmSummary(); } else renderDmSummary(); }

window.onHook('dossier-view-rendered', 'personal-log', (tab) => { render(tab); });
window.onHook('roster-rendered', 'personal-log', () => { setTimeout(refreshDm, 0); });
// The roster redraws its list on the same click, so the clicked row is already
// detached here: match the row marker itself, not its place in #rz-root.
document.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('[data-rzsel]')) setTimeout(renderDmSummary, 0); });
document.addEventListener('darkforest:features-changed', () => { PL.forUser = null; if (typeof window.renderCrewDossier === 'function') window.renderCrewDossier(); refreshDm(); });
})();
