/* ==========================================================================
   js/crew-v2.js - Character sheet restyle (UI restyle R4, switch
   'crew_restyle')
   ==========================================================================
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
})();
