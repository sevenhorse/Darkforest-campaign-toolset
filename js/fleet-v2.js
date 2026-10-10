/* ==========================================================================
   js/fleet-v2.js - Fleet pages restyle, part 1: Vessel Deck
   (UI restyle R3, switch 'fleet_restyle')
   ==========================================================================
   DM decisions (2026-10-10, from the R3 mockup): four tabs (STATUS /
   WEAPONS / DECKS / HANGAR) under a vessel header; the weapon cards stay as
   they are (shared with the Battle Map); the add forms sit behind buttons.

   Re-arranges, doesn't rewrite. The Vessel Deck's own sections (health +
   stance, decks with their repair / type / boarding / deck-plan controls,
   weapon cards, ownership, salvage, on-board builds, hangar) are moved as-is
   into the tab panes, so every control still runs the same code in
   combat.js / squadrons.js. Only the header, the tab bar and the "at a
   glance" box are new. renderVesselDeck announces 'vessel-deck-rendered'
   and this view refreshes its header on it. Switch off = every section is
   put back where it was.
   ========================================================================== */
(function () {
const byId = (id) => document.getElementById(id);
const esc = (s) => (typeof window.escapeHtml === 'function' ? window.escapeHtml(s) : String(s == null ? '' : s));
const TABS = [['status', 'STATUS'], ['weapons', 'WEAPONS'], ['decks', 'DECKS'], ['hangar', 'HANGAR']];
const S = window.__vz = window.__vz || { tab: 'status', open: {} };
const moved = []; // { node, parent, next }

window.fleetRestyleOn = function () { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('fleet_restyle'); };
const section = (id) => { const el = byId(id); return el ? el.closest('.sheet-section') : null; };
const formBox = (inputId) => { const el = byId(inputId); return el ? el.closest('div[style*="background:#030403"]') : null; };
// What goes where. Each entry is looked up fresh (by an id inside it) so a
// node that has already moved is still found.
const PLACES = {
    status: () => [section('vessel-health-container'), byId('vessel-ownership-container'), byId('vessel-salvage-container'), byId('vessel-manufacturing-container')],
    weapons: () => [section('vessel-weapons-container')],
    decks: () => [section('vessel-decks-container')],
    hangar: () => [section('vessel-embarked-container'), section('vessel-deployed-container'), section('new-squadron-name')]
};
// Add forms that sit behind a "+" button: [tab, node finder, button label].
const FORMS = [
    ['weapons', () => formBox('new-ship-wpn-name'), '+ MOUNT WEAPON'],
    ['decks', () => formBox('new-deck-name'), '+ ADD DECK'],
    ['hangar', () => section('new-squadron-name'), '+ COMMISSION SQUADRON']
];

function borrow(node, slot) {
    if (!node || !slot || node.parentNode === slot) return;
    if (!moved.some(m => m.node === node)) moved.push({ node, parent: node.parentNode, next: node.nextSibling });
    slot.appendChild(node);
}
function giveBackAll() {
    for (let i = moved.length - 1; i >= 0; i--) {
        const m = moved[i];
        if (m.parent) m.parent.insertBefore(m.node, m.next && m.next.parentNode === m.parent ? m.next : null);
        m.node.classList && m.node.classList.remove('vz-hidden-form');
    }
    moved.length = 0;
}

function ensureRoot() {
    const panel = byId('term-panel-vessel');
    if (!panel) return null;
    let root = byId('vz-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'vz-root';
        root.className = 'vz-root';
        root.innerHTML = `<div class="vz-head">
                <span class="vz-avatar" id="vz-avatar"></span>
                <div class="vz-id"><span class="vz-kicker" id="vz-kicker">VESSEL</span>
                    <div class="vz-namerow"><h2 class="vz-name" id="vz-name">—</h2><span id="vz-chips"></span></div></div>
                <span class="dz-grow"></span>
                <label class="vz-pick">SWITCH VESSEL <span id="vz-select-slot"></span></label>
                <span id="vz-broadcast-slot"></span>
            </div>
            <nav class="df-subtabs vz-tabs" id="vz-tabs" aria-label="Vessel sections"></nav>
            ${TABS.map(([k]) => `<div class="vz-pane" id="vz-pane-${k}" data-tab="${k}">
                ${k === 'status' ? '<div class="vz-glance" id="vz-glance"></div>' : ''}
                <div class="vz-formbar" id="vz-formbar-${k}"></div><div class="vz-slot" id="vz-slot-${k}"></div></div>`).join('')}`;
        panel.appendChild(root);
    }
    return root;
}

function currentVessel() {
    const sel = byId('vessel-deck-select');
    const id = sel && sel.value;
    return id && typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache.find(m => m.id === id) : null;
}
function initials(name) {
    const w = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(' ').filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '').slice(1, 2))).toUpperCase();
}

function render() {
    const panel = byId('term-panel-vessel');
    if (!panel) return;
    const on = window.fleetRestyleOn();
    panel.classList.toggle('vz-on', on);
    if (!on) {
        if (moved.length) giveBackAll();
        FORMS.forEach(([, find]) => { const n = find(); if (n) n.classList.remove('vz-hidden-form'); });
        return;
    }
    const root = ensureRoot();
    if (!root) return;

    // Header: the old vessel picker + broadcast button move in, as they are.
    borrow(byId('vessel-deck-select'), byId('vz-select-slot'));
    const bc = panel.querySelector('button[onclick*="broadcastVesselStatus"]');
    borrow(bc, byId('vz-broadcast-slot'));
    Object.keys(PLACES).forEach(tab => PLACES[tab]().forEach(n => borrow(n, byId('vz-slot-' + tab))));

    const v = currentVessel();
    const weapons = v ? (v.ship_weapons || []) : [], decks = v ? (v.ship_decks || []) : [];
    const hangar = v ? (v.ship_hangar || []) : [], deployed = v ? (v.ship_deployed || []) : [];
    const counts = { status: '', weapons: weapons.length, decks: decks.length, hangar: hangar.length + deployed.length };
    byId('vz-tabs').innerHTML = TABS.map(([k, label]) => `<button type="button" class="df-subtab${S.tab === k ? ' on' : ''}" data-vztab="${k}" aria-pressed="${S.tab === k}"><span>${label}</span>${counts[k] ? `<b>${counts[k]}</b>` : ''}</button>`).join('');
    TABS.forEach(([k]) => { byId('vz-pane-' + k).style.display = S.tab === k ? '' : 'none'; });

    FORMS.forEach(([tab, find, label]) => {
        const node = find(), bar = byId('vz-formbar-' + tab);
        if (!node || !bar) return;
        const open = !!S.open[tab];
        node.classList.toggle('vz-hidden-form', !open);
        bar.innerHTML = `<button type="button" class="dz-btn${open ? ' dim' : ''}" data-vzform="${tab}">${open ? 'CLOSE' : label}</button>`;
    });

    if (!v) {
        byId('vz-name').textContent = '—'; byId('vz-chips').innerHTML = ''; byId('vz-avatar').textContent = '?';
        byId('vz-glance').innerHTML = '<div class="dz-empty">Pick a vessel.</div>';
        return;
    }
    const hullPct = v.max_hull > 0 ? (v.integrity_hull || 0) / v.max_hull : 1;
    const decksOk = decks.filter(d => (d.hp || 0) > 0).length;
    const cond = hullPct <= 0 ? ['DESTROYED', 'red'] : hullPct < 0.25 ? ['CRITICAL', 'red'] : hullPct < 0.75 || decksOk < decks.length ? ['DAMAGED', 'amber'] : ['ALL SYSTEMS NOMINAL', 'ok'];
    const img = v.image_url && typeof window.mediaThumbHtml === 'function' ? window.mediaThumbHtml(v.image_url, { size: 52, caption: v.name }) : '';
    byId('vz-avatar').innerHTML = img || esc(initials(v.name));
    byId('vz-avatar').classList.toggle('vz-hasimg', !!img);
    byId('vz-name').textContent = v.name || '—';
    byId('vz-kicker').textContent = v.is_station ? 'STATION' : 'VESSEL';
    byId('vz-chips').innerHTML = [v.vessel_class ? [v.vessel_class === 'Capital' ? '⬢ CAPITAL' : '◆ ESCORT', 'gold'] : null, v.is_station ? ['🛰 STATION', 'gold'] : null, cond]
        .filter(Boolean).map(c => `<span class="dz-chip ${c[1]}">${esc(c[0])}</span>`).join('');
    const mfg = decks.find(d => d.type === 'manufacturing');
    const cell = (k, val, col) => `<div class="dz-fact"><span>${k}</span><b style="color:${col || '#e8f6fa'}">${esc(val)}</b></div>`;
    byId('vz-glance').innerHTML = `<div class="dz-facts">${cell('WEAPONS', weapons.length)}${cell('DECKS', decks.length ? `${decksOk} / ${decks.length} OK` : 'NONE', decksOk < decks.length ? '#ffaa00' : '')}
        ${cell('SQUADRONS', `${hangar.length} IN HANGAR${deployed.length ? ` · ${deployed.length} OUT` : ''}`)}${mfg ? cell('MANUFACTURING DECK', `${mfg.hp} / ${mfg.max_hp}`, '#c9962f') : ''}</div>`;
}
window.renderFleetVessel = render;

document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#vz-root button') : null;
    if (!b) return;
    if (b.dataset.vztab) { S.tab = b.dataset.vztab; render(); }
    else if (b.dataset.vzform) { S.open[b.dataset.vzform] = !S.open[b.dataset.vzform]; render(); }
});
window.onHook('vessel-deck-rendered', 'fleet-v2', render);
window.onHook('term-tab-switched', 'fleet-v2', (tab) => { if (tab === 'vessel') render(); });
document.addEventListener('darkforest:features-changed', render);
})();
