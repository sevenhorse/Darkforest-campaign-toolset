/* ==========================================================================
   js/crew-v2.js - Character sheet restyle (UI restyle R4, switch
   'crew_restyle')
   ==========================================================================
   Parts: R4a Dossier & Stats, R4b Arsenal, R4c Manifest (further down).
   R4a Dossier & Stats. DM decisions (2026-10-10, from the R4 mockup): a
   character header (portrait, handle, name, specialties, live chips for
   Injuries / Stress / Adversity / Shield / DR) over four tabs: PROFILE,
   ATTRIBUTES & SKILLS, PERKS & AUGMENTS, GEAR & ASSETS. SAVE DOSSIER and
   RECHARGE SHIELD always visible in the tab bar.

   Re-arranges, doesn't rewrite. saveTerminalProfile reads every field by
   id, so the page's own sections (with every input, perk / augment / gear
   control and the portrait drop zone) move as-is into the tab panes, and
   the real SAVE and RECHARGE buttons move into the tab bar. Only the
   header, the tab bar and the skill bars are new. Switch off = everything
   goes back where it was. Refreshes on 'dossier-rendered' (ui.js) and on
   any edit inside the page.
   ========================================================================== */
(function () {
const byId = (id) => document.getElementById(id);
const esc = (s) => (typeof window.escapeHtml === 'function' ? window.escapeHtml(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
const TABS = [['profile', 'PROFILE'], ['attributes', 'ATTRIBUTES & SKILLS'], ['perks', 'PERKS & AUGMENTS'], ['gear', 'GEAR & ASSETS']];
const S = window.__cv = window.__cv || { tab: 'attributes' };
const moved = []; // { node, parent, next }
window.crewRestyleOn = function () { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('crew_restyle'); };

const section = (id) => { const el = byId(id); return el ? el.closest('.sheet-section') : null; };
// What goes where; each section is found by an id inside it, so a section
// that has already moved is still found.
const PLACES = {
    profile: ['term-username', 'term-personal-history'],
    attributes: ['term-sheet-name', 'skills-input-container'],
    perks: ['term-specialties', 'augment-slots-container'],
    gear: ['gear-loadout-container']
};
const statsBtn = (fn) => document.querySelector(`#term-panel-stats button[onclick^="window.${fn}("]`);

function borrow(node, slot) {
    if (!node || !slot || node.parentNode === slot) return;
    if (!moved.some(m => m.node === node)) moved.push({ node, parent: node.parentNode, next: node.nextSibling });
    slot.appendChild(node);
}
function giveBackAll() {
    for (let i = moved.length - 1; i >= 0; i--) {
        const m = moved[i];
        m.parent.insertBefore(m.node, m.next && m.next.parentNode === m.parent ? m.next : null);
    }
    moved.length = 0;
}

function ensureRoot() {
    const panel = byId('term-panel-stats');
    if (!panel) return null;
    let root = byId('cv-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'cv-root';
        root.className = 'vz-root cv-root';
        root.innerHTML = `<div class="cv-head">
                <span class="cv-avatar" id="cv-avatar"></span>
                <span class="cv-id"><span class="vz-kicker" id="cv-kicker"></span><h2 class="vz-name" id="cv-name"></h2><span class="cv-spec" id="cv-spec"></span></span>
                <span class="dz-grow"></span>
                <span class="cv-chips" id="cv-chips"></span>
            </div>
            <div class="cv-tabbar"><div class="df-subtabs vz-tabs" id="cv-tabs" role="tablist" aria-label="Dossier sections"></div><span class="dz-grow"></span><span class="cv-actions" id="cv-actions"></span></div>
            ${TABS.map(([k]) => `<div class="vz-pane cv-pane" id="cv-pane-${k}" data-cvpane="${k}"></div>`).join('')}`;
        panel.appendChild(root);
    }
    return root;
}

function num(id) { const el = byId(id); const n = el ? parseInt(el.value, 10) : NaN; return isNaN(n) ? 0 : n; }
function me() { return (typeof allProfiles !== 'undefined' && typeof currentUserId !== 'undefined') ? allProfiles.find(p => p.id === currentUserId) : null; }

function renderHeader() {
    const p = me() || {};
    const c = p.character || {};
    const val = (id) => { const el = byId(id); return el ? String(el.value || '').trim() : ''; };
    const name = val('term-sheet-name') || 'UNNAMED OPERATIVE';
    const av = byId('my-terminal-avatar-preview');
    const avatar = byId('cv-avatar');
    const src = av && av.getAttribute('src');
    if (src && !/^data:image\/svg/.test(src)) avatar.innerHTML = `<img src="${esc(src)}" alt="">`;
    else avatar.textContent = (name.replace(/[^A-Za-z0-9 ]/g, ' ').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
    avatar.classList.toggle('cv-hasimg', !!(src && !/^data:image\/svg/.test(src)));
    byId('cv-kicker').textContent = 'OPERATIVE // HANDLE: ' + (val('term-username') || p.username || '—').toUpperCase();
    byId('cv-name').textContent = name.toUpperCase();
    byId('cv-spec').textContent = (val('term-specialties').split(/\n/)[0] || '').slice(0, 90).toUpperCase();
    // Effective values = what's typed + the perk/augment/gear bonus the sheet already shows.
    const bonus = (fn, base) => (typeof window[fn] === 'function' ? window[fn](c, p.perks, p.augments, p.gear) - (base || 0) : 0);
    const injMax = parseInt((byId('term-vitality') || {}).max, 10);
    const shMax = num('term-shield-max') + bonus('getEffectiveShieldMax', c.shield_max);
    const dr = num('term-dr') + bonus('getEffectiveDR', c.dr);
    const inj = num('term-vitality'), stress = num('term-stress'), adv = num('term-adversity'), sh = num('term-shield-current');
    const chip = (k, v, cls) => `<span class="cv-chip"><span>${k}</span><b class="${cls || ''}">${esc(v)}</b></span>`;
    byId('cv-chips').innerHTML = chip('INJURIES', isNaN(injMax) ? String(inj) : `${inj} / ${injMax}`, inj > 0 ? 'cv-red' : '') +
        chip('STRESS', `${stress} / 20`, stress >= 15 ? 'cv-red' : stress > 0 ? 'cv-amber' : '') +
        chip('ADVERSITY', (adv > 0 ? '+' : '') + adv) +
        chip('SHIELD', `${sh} / ${shMax}`, 'cv-cyan') + chip('DR', String(dr));
    const nPerks = (p.perks || []).length + (p.augments || []).length, nGear = (p.gear || []).length;
    const count = { perks: nPerks, gear: nGear };
    byId('cv-tabs').innerHTML = TABS.map(([k, label]) => `<button type="button" role="tab" class="df-subtab${S.tab === k ? ' on' : ''}" data-cvtab="${k}" aria-selected="${S.tab === k}">${label}${count[k] ? ` <b>${count[k]}</b>` : ''}</button>`).join('');
}

// Skill rows get a -100…+100 bar (new; the number input is the same one).
function renderSkillBars() {
    const box = byId('skills-input-container');
    if (!box) return;
    Array.from(box.querySelectorAll('input[id^="skill-"]')).forEach(inp => {
        const row = inp.parentNode;
        let bar = row.querySelector('.cv-bar');
        if (!bar) { bar = document.createElement('span'); bar.className = 'cv-bar'; bar.setAttribute('aria-hidden', 'true'); bar.innerHTML = '<em></em><i></i>'; row.insertBefore(bar, inp); }
        const v = Math.max(-100, Math.min(100, parseInt(inp.value, 10) || 0));
        const i = bar.querySelector('i');
        i.style.left = (v >= 0 ? 50 : 50 + v / 2) + '%';
        i.style.width = Math.abs(v) / 2 + '%';
        i.classList.toggle('neg', v < 0);
    });
}
function removeSkillBars() { document.querySelectorAll('#skills-input-container .cv-bar').forEach(b => b.remove()); }

function render() {
    const panel = byId('term-panel-stats');
    if (!panel) return;
    const on = window.crewRestyleOn();
    panel.classList.toggle('vz-on', on);
    if (!on) { giveBackAll(); removeSkillBars(); return; }
    const root = ensureRoot();
    if (!root) return;
    Object.keys(PLACES).forEach(k => PLACES[k].forEach(id => borrow(section(id), byId('cv-pane-' + k))));
    borrow(statsBtn('rechargeShield'), byId('cv-actions'));
    borrow(statsBtn('saveTerminalProfile'), byId('cv-actions'));
    if (!PLACES[S.tab]) S.tab = 'attributes';
    root.querySelectorAll('.cv-pane').forEach(p => { p.style.display = p.dataset.cvpane === S.tab ? '' : 'none'; });
    renderHeader();
    renderSkillBars();
}
window.renderCrewDossier = render;

document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#cv-tabs [data-cvtab]') : null;
    if (b) { S.tab = b.dataset.cvtab; render(); return; }
    // Perk / augment / gear buttons redraw their own lists; catch the counts up.
    if (e.target && e.target.closest && e.target.closest('#cv-root') && window.crewRestyleOn()) setTimeout(() => { if (byId('cv-chips')) renderHeader(); }, 0);
});
let pending = 0;
const live = (e) => {
    if (!e.target || !e.target.closest || !e.target.closest('#cv-root') || !window.crewRestyleOn()) return;
    clearTimeout(pending);
    pending = setTimeout(() => { renderHeader(); renderSkillBars(); }, 16);
};
document.addEventListener('input', live);
document.addEventListener('change', live);
window.onHook('dossier-rendered', 'crew-v2', render);
window.onHook('term-tab-switched', 'crew-v2', (tab) => { if (tab === 'stats') render(); });
document.addEventListener('darkforest:features-changed', render);
/* ---------- R4b: Arsenal ----------
   DM decision (2026-10-10, R4 mockup): loadout beside a dice console. Left:
   the page's own Active Arsenal section (weapon rows unchanged: ROLL /
   attack / edit / delete / reorder) with its add form behind + ADD WEAPON,
   then the initiative tracker. Right: the pool roller (attribute and skill
   tick boxes shown as chips, same inputs) and the live dice feed. The real
   SAVE COMBAT DATA button moves into the header. Moves, never rewrites. */
const AV = window.__av = window.__av || { form: false };
const avMoved = [];
function avBorrow(node, slot) {
    if (!node || !slot || node.parentNode === slot) return;
    if (!avMoved.some(m => m.node === node)) avMoved.push({ node, parent: node.parentNode, next: node.nextSibling });
    slot.appendChild(node);
}
function avGiveBack() {
    for (let i = avMoved.length - 1; i >= 0; i--) {
        const m = avMoved[i];
        m.parent.insertBefore(m.node, m.next && m.next.parentNode === m.parent ? m.next : null);
    }
    avMoved.length = 0;
}
const avForm = () => { const el = byId('new-wpn-name'); return el && el.parentNode ? el.parentNode.parentNode : null; };
function avEnsureRoot() {
    const panel = byId('term-panel-combat');
    if (!panel) return null;
    let root = byId('av-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'av-root';
        root.className = 'vz-root av-root';
        root.innerHTML = `<div class="dz-top"><h2 class="dz-h1">ARSENAL</h2><span class="dz-h1sub">// WEAPONS &amp; POWERS</span><span class="dz-grow"></span>
                <button type="button" class="dz-btn" id="av-add" data-avact="add">+ ADD WEAPON</button><span class="cv-actions" id="av-actions"></span></div>
            <div class="av-body"><div class="av-col" id="av-left"></div><div class="av-col av-right" id="av-right"></div></div>`;
        panel.appendChild(root);
    }
    return root;
}
function renderArsenalView() {
    const panel = byId('term-panel-combat');
    if (!panel) return;
    const on = window.crewRestyleOn();
    panel.classList.toggle('vz-on', on);
    if (!on) { const f = avForm(); if (f) f.classList.remove('vz-hidden-form'); avGiveBack(); return; }
    if (!avEnsureRoot()) return;
    avBorrow(section('arsenal-list-container'), byId('av-left'));
    avBorrow(section('terminal-combat-body'), byId('av-left'));
    avBorrow(section('dice-roller-stats'), byId('av-right'));
    avBorrow(section('arsenal-dice-feed'), byId('av-right'));
    avBorrow(document.querySelector('#term-panel-combat button[onclick^="window.saveTerminalProfile("]'), byId('av-actions'));
    const f = avForm();
    if (f) f.classList.toggle('vz-hidden-form', !AV.form);
    const add = byId('av-add');
    if (add) { add.textContent = AV.form ? '× CLOSE FORM' : '+ ADD WEAPON'; add.setAttribute('aria-expanded', String(!!AV.form)); }
}
window.renderCrewArsenal = renderArsenalView;
document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#av-root [data-avact="add"]') : null;
    if (!b) return;
    AV.form = !AV.form;
    renderArsenalView();
    if (AV.form) { const n = byId('new-wpn-name'); if (n) n.focus(); }
});
window.onHook('term-tab-switched', 'crew-v2-arsenal', (tab) => { if (tab === 'combat') renderArsenalView(); });
document.addEventListener('darkforest:features-changed', renderArsenalView);
/* ---------- R4c: Manifest ----------
   Roadmap R4c: vessel picker header + PERISHABLES / EXPENDABLES / MISC tabs
   with counts; cargo rows as they are (synthesizer, food days, +/- qty,
   reorder, delete all unchanged); the add form behind + STORE CARGO; the DM
   catalogue editor behind a DM-only CATALOG tab. Tabs call the existing
   switchCargoSubtab. Moves the real picker, BROADCAST button and sections. */
const MF = window.__mf = window.__mf || { form: false, catalog: false };
const mfMoved = [];
function mfBorrow(node, slot) {
    if (!node || !slot || node.parentNode === slot) return;
    if (!mfMoved.some(m => m.node === node)) mfMoved.push({ node, parent: node.parentNode, next: node.nextSibling });
    slot.appendChild(node);
}
function mfGiveBack() {
    for (let i = mfMoved.length - 1; i >= 0; i--) {
        const m = mfMoved[i];
        m.parent.insertBefore(m.node, m.next && m.next.parentNode === m.parent ? m.next : null);
    }
    mfMoved.length = 0;
}
const MF_CATS = [['perishables', 'PERISHABLES'], ['expendables', 'EXPENDABLES'], ['misc', 'MISC']];
function mfEnsureRoot() {
    const panel = byId('term-panel-cargo');
    if (!panel) return null;
    let root = byId('mf-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'mf-root';
        root.className = 'vz-root mf-root';
        root.innerHTML = `<div class="dz-top"><h2 class="dz-h1">MANIFEST</h2><span class="dz-h1sub">// CARGO HOLD</span>
                <span class="mf-vessel vz-pick" id="mf-vessel"></span><span class="dz-grow"></span>
                <button type="button" class="dz-btn" id="mf-add" data-mfact="add">+ STORE CARGO</button><span class="mf-broadcast" id="mf-broadcast"></span></div>
            <div class="df-subtabs vz-tabs" id="mf-tabs" role="tablist" aria-label="Cargo categories"></div>
            <div class="mf-body"><div class="mf-slot" id="mf-form"></div><div class="mf-slot" id="mf-list"></div><div class="mf-slot" id="mf-catalog"></div></div>`;
        panel.appendChild(root);
    }
    return root;
}
function mfCounts() {
    const sel = byId('cargo-vessel-select');
    const v = sel && typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache.find(m => m.id === sel.value) : null;
    if (!v || (typeof window.canAccessVesselDeck === 'function' && !window.canAccessVesselDeck(v)) || typeof window.sanitizeCargo !== 'function') return {};
    const c = window.sanitizeCargo(v.cargo_inventory);
    return { perishables: (c.perishables || []).length, expendables: (c.expendables || []).length, misc: (c.misc || []).length };
}
function renderManifestView() {
    const panel = byId('term-panel-cargo');
    if (!panel) return;
    const on = window.crewRestyleOn();
    panel.classList.toggle('vz-on', on);
    if (!on) { mfGiveBack(); return; }
    if (!mfEnsureRoot()) return;
    const sel = byId('cargo-vessel-select');
    mfBorrow(sel ? sel.parentNode : null, byId('mf-vessel'));
    mfBorrow(document.querySelector('#term-panel-cargo button[onclick^="window.broadcastTerminalCargoManifest("]'), byId('mf-broadcast'));
    mfBorrow(section('new-cargo-name'), byId('mf-form'));
    mfBorrow(section('terminal-cargo-items-container'), byId('mf-list'));
    mfBorrow(byId('cargo-catalog-dm-editor'), byId('mf-catalog'));
    const dm = typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
    if (!dm) MF.catalog = false;
    const cur = typeof activeCargoSubtab !== 'undefined' ? activeCargoSubtab : 'perishables';
    const n = mfCounts();
    byId('mf-tabs').innerHTML = MF_CATS.map(([k, label]) => `<button type="button" role="tab" class="df-subtab${!MF.catalog && cur === k ? ' on' : ''}" data-mfcat="${k}" aria-selected="${!MF.catalog && cur === k}">${label}${n[k] ? ` <b>${n[k]}</b>` : ''}</button>`).join('') +
        (dm ? `<button type="button" role="tab" class="df-subtab mf-dmtab${MF.catalog ? ' on' : ''}" data-mfcat="catalog" aria-selected="${!!MF.catalog}">CATALOG <i>DM</i></button>` : '');
    byId('mf-form').style.display = MF.form && !MF.catalog ? '' : 'none';
    byId('mf-list').style.display = MF.catalog ? 'none' : '';
    byId('mf-catalog').style.display = MF.catalog ? '' : 'none';
    const add = byId('mf-add');
    if (add) { add.textContent = MF.form ? '× CLOSE FORM' : '+ STORE CARGO'; add.setAttribute('aria-expanded', String(!!MF.form)); add.style.display = MF.catalog ? 'none' : ''; }
}
window.renderCrewManifest = renderManifestView;
document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#mf-root [data-mfcat], #mf-root [data-mfact]') : null;
    if (!b) return;
    if (b.dataset.mfact === 'add') {
        MF.form = !MF.form;
        if (MF.form) { const c = byId('new-cargo-category'); if (c && typeof activeCargoSubtab !== 'undefined') c.value = activeCargoSubtab; }
        renderManifestView();
        if (MF.form) { const n = byId('new-cargo-name'); if (n) n.focus(); }
        return;
    }
    if (b.dataset.mfcat === 'catalog') { MF.catalog = true; renderManifestView(); return; }
    MF.catalog = false;
    if (typeof window.switchCargoSubtab === 'function') window.switchCargoSubtab(b.dataset.mfcat); // redraws the list; 'cargo-deck-rendered' redraws the tabs
    else renderManifestView();
});
window.onHook('cargo-deck-rendered', 'crew-v2', renderManifestView);
window.onHook('term-tab-switched', 'crew-v2-manifest', (tab) => { if (tab === 'cargo') renderManifestView(); });
document.addEventListener('darkforest:features-changed', renderManifestView);
})();
