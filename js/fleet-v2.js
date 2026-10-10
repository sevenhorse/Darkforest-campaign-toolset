/* ==========================================================================
   js/fleet-v2.js - Fleet pages restyle: Vessel Deck, Colonies & Fleets, Manufacturing
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

/* ---------- R3b: Colonies & Fleets ----------
   A list on the left (built here from coloniesList / fleetGroupsList, in the
   same saved order), and on the right the page's OWN card for the picked
   colony / task group, untouched (storage pick-up, builds, edit, delete,
   reorder all still run colonies.js). The old card container moves into the
   right pane and every card but the picked one is hidden. "+ FOUND COLONY" /
   "+ COMMISSION TASK GROUP" show the existing forms in that pane. */
const CZ = window.__cz = window.__cz || { tab: 'colonies', sel: {}, mode: 'view', view: 'list', known: null };
const CZ_KINDS = {
    colonies: { label: 'COLONIES', tone: 'amber', container: 'colonies-list-container', form: 'new-colony-name', newLabel: '+ FOUND COLONY', orderKey: 'colonies',
        list: () => (typeof coloniesList !== 'undefined' ? coloniesList : []),
        meta: (c) => `POP ${fmtPop(c.population)} · INFRASTRUCTURE ${c.infrastructure_level || 1}${c.has_manufacturing_facility ? ' · FACILITY' : ''}`,
        chip: (c) => [String(c.morale || 'Stable').toUpperCase(), c.morale === 'Thriving' ? 'ok' : c.morale === 'Unrest' ? 'amber' : c.morale === 'Crisis' ? 'red' : 'gold'] },
    fleets: { label: 'TASK GROUPS', tone: '', container: 'fleets-list-container', form: 'new-fleet-name', newLabel: '+ COMMISSION TASK GROUP', orderKey: 'fleet_groups',
        list: () => (typeof fleetGroupsList !== 'undefined' ? fleetGroupsList : []),
        meta: (f) => { const ship = (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).find(m => m.id === f.linked_ship_id); return ship ? `LINKED: ${String(ship.name).toUpperCase()}` : 'NO LINKED SHIP'; },
        chip: (f) => [String(f.status || 'Standby').toUpperCase(), f.status === 'RTB' ? 'red' : f.status === 'Patrolling' ? 'ok' : f.status === 'Mining Operations' ? 'amber' : ''] }
};
function fmtPop(n) { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }
const czOrdered = (k) => (typeof window.applySavedOrder === 'function' ? window.applySavedOrder(CZ_KINDS[k].orderKey, CZ_KINDS[k].list()) : CZ_KINDS[k].list());
const czForm = (k) => { const el = byId(CZ_KINDS[k].form); return el ? el.closest('.sheet-section') : null; };

function czEnsureRoot() {
    const panel = byId('term-panel-colonies');
    if (!panel) return null;
    let root = byId('cz-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'cz-root';
        root.className = 'vz-root cz-root';
        root.innerHTML = `<div class="dz-top"><h2 class="dz-h1">COLONIES &amp; FLEETS</h2><span class="dz-grow"></span>
                <button type="button" class="dz-btn amber-btn" data-cznew="colonies">+ FOUND COLONY</button>
                <button type="button" class="dz-btn" data-cznew="fleets">+ COMMISSION TASK GROUP</button></div>
            <div class="dz-filters" id="cz-tabs" role="tablist" aria-label="Colonies or task groups"></div>
            <div class="dz-body" id="cz-body">
                <div class="dz-panel dz-list" id="cz-list"></div>
                <div class="dz-panel dz-detail" id="cz-detail">
                    <button type="button" class="dz-back" data-czact="back">← BACK TO LIST</button>
                    <span class="dz-kicker" id="cz-kicker"></span>
                    <div class="cz-slot" id="cz-slot-colonies"></div><div class="cz-slot" id="cz-slot-fleets"></div>
                    <div class="cz-formslot" id="cz-formslot"></div>
                    <div class="dz-actions" id="cz-formactions"><span class="dz-grow"></span><button type="button" class="dz-btn dim" data-czact="cancel">CANCEL</button></div>
                </div>
            </div>`;
        panel.appendChild(root);
    }
    return root;
}

function renderColonies() {
    const panel = byId('term-panel-colonies');
    if (!panel) return;
    const on = window.fleetRestyleOn();
    panel.classList.toggle('vz-on', on);
    if (!on) {
        ['colonies', 'fleets'].forEach(k => { const c = byId(CZ_KINDS[k].container); if (c && c.closest('#cz-root')) czGiveBack(c); const f = czForm(k); if (f && f.closest('#cz-root')) czGiveBack(f); });
        CZ.mode = 'view';
        return;
    }
    const root = czEnsureRoot();
    if (!root) return;
    const k = CZ.tab, K = CZ_KINDS[k];
    const items = czOrdered(k);
    if (CZ.mode === 'new' && CZ.known && CZ.known.k === k) {
        const fresh = items.find(x => !CZ.known.ids.has(x.id));
        if (fresh) { CZ.sel[k] = fresh.id; CZ.mode = 'view'; CZ.view = 'detail'; }
    }
    if (!items.some(x => x.id === CZ.sel[k])) CZ.sel[k] = items.length ? items[0].id : null;
    const sel = CZ.sel[k];

    byId('cz-tabs').innerHTML = Object.keys(CZ_KINDS).map(key => `<button type="button" role="tab" class="dz-ftab${key === k ? ' on' : ''}" data-cztab="${key}" aria-selected="${key === k}">${CZ_KINDS[key].label} <b class="${CZ_KINDS[key].tone}">${CZ_KINDS[key].list().length}</b></button>`).join('');
    const initials = (n) => { const w = String(n || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(' ').filter(Boolean); return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '').slice(1, 2))).toUpperCase(); };
    byId('cz-list').innerHTML = `<div class="dz-ttl"><span>${k === 'colonies' ? 'COLONIAL HOLDINGS' : 'TASK GROUPS'}</span><span class="dz-dim">${items.length}</span></div>` + (items.length ? items.map(x => {
        const c = K.chip(x);
        return `<button type="button" class="dz-row${x.id === sel && CZ.mode !== 'new' ? ' sel' : ''}" data-czsel="${esc(x.id)}"><span class="dz-thumb">${esc(initials(x.name))}</span>
            <span class="dz-rowtext"><span class="dz-name">${esc(x.name)}</span><span class="dz-meta">${esc(K.meta(x))}</span></span><span class="dz-chip ${c[1]}">${esc(c[0])}</span></button>`;
    }).join('') : `<div class="dz-empty">None yet. Use ${K.newLabel}.</div>`);

    // Right pane: the old card container (only the picked card shows) or the creation form.
    ['colonies', 'fleets'].forEach(key => czBorrow(byId(CZ_KINDS[key].container), byId('cz-slot-' + key)));
    ['colonies', 'fleets'].forEach(key => { byId('cz-slot-' + key).style.display = (key === k && CZ.mode !== 'new') ? '' : 'none'; });
    const container = byId(K.container);
    if (container) {
        const cards = Array.from(container.children).filter(n => n.classList && n.classList.contains('note-card'));
        cards.forEach((card, i) => { const it = items[i]; if (it) card.dataset.czid = it.id; card.classList.toggle('cz-sel', !!it && it.id === sel); });
    }
    const form = czForm(k);
    ['colonies', 'fleets'].forEach(key => { const f = czForm(key); if (f && key !== k && f.closest('#cz-root')) czGiveBack(f); });
    if (CZ.mode === 'new' && form) czBorrow(form, byId('cz-formslot'));
    else if (form && form.closest('#cz-root')) czGiveBack(form);
    byId('cz-formactions').style.display = CZ.mode === 'new' ? '' : 'none';
    byId('cz-kicker').textContent = CZ.mode === 'new' ? (k === 'colonies' ? 'NEW COLONY' : 'NEW TASK GROUP') : (k === 'colonies' ? 'COLONY' : 'TASK GROUP');
    byId('cz-body').classList.toggle('dz-show-detail', CZ.view === 'detail');
}
window.renderFleetColonies = renderColonies;
const czMoved = [];
function czBorrow(node, slot) {
    if (!node || !slot || node.parentNode === slot) return;
    if (!czMoved.some(m => m.node === node)) czMoved.push({ node, parent: node.parentNode, next: node.nextSibling });
    slot.appendChild(node);
}
function czGiveBack(node) {
    const i = czMoved.findIndex(m => m.node === node);
    if (i < 0) return;
    const m = czMoved[i];
    m.parent.insertBefore(node, m.next && m.next.parentNode === m.parent ? m.next : null);
    czMoved.splice(i, 1);
}
document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#cz-root button') : null;
    if (!b || b.closest('#cz-formslot') || b.closest('.cz-slot')) return;
    if (b.dataset.cztab) {
        CZ.tab = b.dataset.cztab; CZ.mode = 'view';
        if (typeof window.switchColoniesSubtab === 'function') window.switchColoniesSubtab(CZ.tab);
    } else if (b.dataset.czsel) { CZ.sel[CZ.tab] = b.dataset.czsel; CZ.mode = 'view'; CZ.view = 'detail'; }
    else if (b.dataset.cznew) {
        CZ.tab = b.dataset.cznew; CZ.mode = 'new'; CZ.view = 'detail';
        CZ.known = { k: CZ.tab, ids: new Set(CZ_KINDS[CZ.tab].list().map(x => x.id)) };
        if (typeof window.switchColoniesSubtab === 'function') window.switchColoniesSubtab(CZ.tab);
    } else if (b.dataset.czact === 'back') { CZ.view = 'list'; if (CZ.mode === 'new') CZ.mode = 'view'; }
    else if (b.dataset.czact === 'cancel') { CZ.mode = 'view'; }
    else return;
    renderColonies();
});
window.onHook('colonies-rendered', 'fleet-v2', renderColonies);
window.onHook('fleet-groups-rendered', 'fleet-v2', renderColonies);
window.onHook('term-tab-switched', 'fleet-v2-colonies', (tab) => { if (tab === 'colonies') renderColonies(); });
document.addEventListener('darkforest:features-changed', renderColonies);
/* ---------- R3c: Manufacturing ----------
   DM decisions (2026-10-10, R3 mockup): gold accents kept; catalogue tabs
   ALL / CARGO ITEMS / ARSENAL WEAPONS / INFRASTRUCTURE / PENDING; list +
   detail with build time and ingredients; BUILD AT picker + START BUILD;
   in-progress builds with CANCEL underneath.
   Unlike the other fleet pages this one is drawn from the data (the old page
   is a read-only catalogue, nothing live to move). Every action calls the
   existing manufacturing.js function: approveBlueprint, openEditBlueprintModal,
   deleteManufacturingBlueprint, openNewBlueprintModal, cancelManufacturingOrder,
   and START BUILD calls startVesselManufacturingOrder /
   startColonyManufacturingOrder after the same computeManufacturingPreview
   check the build popups use. A colony build's delivery vessel is read by
   startColonyManufacturingOrder from the colony card's own select, so DELIVER
   TO sets that select first. Redraws on 'manufacturing-rendered'. */
const MZ = window.__mz = window.__mz || { tab: 'all', q: '', sel: null, view: 'list', at: '', to: '' };
const MZ_TABS = [['all', 'ALL'], ['cargo_item', 'CARGO ITEMS'], ['arsenal_weapon', 'ARSENAL WEAPONS'], ['colony_infrastructure', 'INFRASTRUCTURE'], ['pending', 'PENDING']];
const MZ_TYPE = { cargo_item: 'CARGO ITEM', arsenal_weapon: 'ARSENAL WEAPON', colony_infrastructure: 'INFRASTRUCTURE' };
const mzBlueprints = () => (typeof manufacturingBlueprintsList !== 'undefined' ? manufacturingBlueprintsList : []);
const mzCall = (name, ...a) => (typeof window[name] === 'function' ? window[name](...a) : undefined);
const mzBare = (fn, ...a) => { try { return fn(...a); } catch (e) { return null; } };
const mzHours = (h) => { h = Number(h) || 0; return (Math.round(h * 10) / 10) + (h === 1 ? ' HOUR' : ' HOURS'); };

function mzEnsureRoot() {
    const panel = byId('term-panel-manufacturing');
    if (!panel) return null;
    let root = byId('mz-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'mz-root';
        root.className = 'vz-root mz-root';
        root.innerHTML = `<div class="dz-top"><h2 class="dz-h1">MANUFACTURING</h2><span class="dz-h1sub mz-goldtxt">// BLUEPRINT CATALOG</span><span class="dz-grow"></span>
                <label class="dz-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg>
                    <span class="dz-sr">Search blueprints</span><input type="text" id="mz-search" placeholder="Search blueprints"></label>
                <button type="button" class="dz-btn" data-mzact="propose">+ PROPOSE BLUEPRINT</button></div>
            <div class="dz-filters" id="mz-tabs" role="tablist" aria-label="Blueprint type"></div>
            <div class="mz-body" id="mz-body">
                <div class="dz-panel dz-list mz-list" id="mz-list"></div>
                <div class="dz-panel dz-detail mz-detail" id="mz-detail"></div>
                <div class="mz-builds" id="mz-builds"></div>
            </div>`;
        panel.appendChild(root);
        byId('mz-search').addEventListener('input', (e) => { MZ.q = e.target.value.trim().toLowerCase(); renderMfg(); });
        root.addEventListener('change', (e) => {
            if (e.target.id === 'mz-at') { MZ.at = e.target.value; renderMfg(); }
            else if (e.target.id === 'mz-to') { MZ.to = e.target.value; renderMfg(); }
        });
    }
    return root;
}

// Places this user can build: vessels with a Manufacturing deck they own
// (DM: all), and their colonies (DM: all). Infrastructure is colony-only.
function mzPlaces(bp) {
    const dm = typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
    const me = typeof currentUserId !== 'undefined' ? currentUserId : null;
    const out = [];
    if (bp.output_type !== 'colony_infrastructure') {
        (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).forEach(v => {
            const deck = (v.ship_decks || []).find(d => d.type === 'manufacturing');
            if (!deck || !(dm || (typeof window.vesselHasOwner === 'function' && window.vesselHasOwner(v, me)))) return;
            out.push({ key: 'v:' + v.id, label: `${v.name} · Manufacturing ${deck.hp}/${deck.max_hp}`, vessel: v });
        });
    }
    (typeof coloniesList !== 'undefined' ? coloniesList : []).forEach(c => {
        if (dm || c.owner_id === me) out.push({ key: 'c:' + c.id, label: `${c.name} (colony)`, colony: c });
    });
    return out;
}
function mzDeliveryVessels() {
    return (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).filter(m => typeof window.canAccessVesselDeck !== 'function' || window.canAccessVesselDeck(m));
}

function mzVisible() {
    const q = MZ.q;
    return mzBlueprints().filter(bp => {
        if (MZ.tab === 'pending' ? bp.status !== 'draft' : (MZ.tab !== 'all' && bp.output_type !== MZ.tab)) return false;
        return !q || (bp.name || '').toLowerCase().includes(q) || (bp.description || '').toLowerCase().includes(q);
    }).sort((a, b) => (a.status === 'draft') - (b.status === 'draft') || String(a.name || '').localeCompare(String(b.name || '')));
}

function mzDetailHtml(bp) {
    if (!bp) return `<div class="dz-empty">${mzBlueprints().length ? 'Pick a blueprint from the list.' : 'No blueprints exist yet. Use + PROPOSE BLUEPRINT.'}</div>`;
    const draft = bp.status === 'draft';
    const tier = typeof computeBlueprintTier === 'function' ? mzBare(computeBlueprintTier, bp) : null;
    const tierTxt = tier == null ? '' : (typeof formatBlueprintTier === 'function' ? mzBare(formatBlueprintTier, tier) : 'Tier ' + tier);
    const editable = typeof canManageBlueprint === 'function' ? !!mzBare(canManageBlueprint, bp) : false;
    const dm = typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
    const proposer = (draft && typeof allProfiles !== 'undefined') ? allProfiles.find(a => a.id === bp.created_by) : null;

    // Build target + live preview (approved blueprints only).
    let preview = null, places = [], place = null, buildHtml = '';
    if (!draft) {
        places = mzPlaces(bp);
        place = places.find(p => p.key === MZ.at) || places[0] || null;
        if (place && typeof window.computeManufacturingPreview === 'function') preview = window.computeManufacturingPreview(bp, place.vessel ? { vessel: place.vessel } : { colony: place.colony });
    }
    const rows = preview ? preview.costRows : (bp.resource_cost || []).map(c => ({ name: c.name, unit: c.unit || 'Units', qty: c.qty, have: null, sufficient: null }));
    const time = preview && preview.timeHours != null ? preview.timeHours : bp.time_cost_hours;
    const facts = `<div class="dz-facts"><div class="dz-fact"><span>BUILD TIME</span><b>${esc(mzHours(time))}</b></div>` + rows.map(r =>
        `<div class="dz-fact"><span>${esc(String(r.name).toUpperCase())}</span><b class="${r.sufficient === false ? 'mz-short' : 'mz-goldtxt'}">${esc(r.qty)} ${esc(r.unit)}</b>${r.have != null ? `<span class="${r.sufficient ? 'mz-ok' : 'mz-short'}">HAVE ${esc(r.have)}</span>` : ''}</div>`).join('') +
        (rows.length ? '' : `<div class="dz-fact"><span>MATERIALS</span><b class="mz-goldtxt">NONE (TIME ONLY)</b></div>`) + `</div>`;
    const output = typeof describeBlueprintOutput === 'function' ? mzBare(describeBlueprintOutput, bp) : '';
    const infraNote = (bp.output_type !== 'colony_infrastructure' && tier != null && tier !== Infinity && tier > 1) ? `Needs Colony Infrastructure Level ${tier} to build at a colony.` : '';

    if (!draft) {
        const needsTo = !!(place && place.colony && bp.output_type !== 'colony_infrastructure');
        let toHtml = '', missingTo = false;
        if (needsTo) {
            const vs = mzDeliveryVessels();
            const cardSel = byId('colony-deliver-vessel-' + place.colony.id);
            if (!vs.some(v => v.id === MZ.to)) MZ.to = (cardSel && vs.some(v => v.id === cardSel.value)) ? cardSel.value : (vs[0] ? vs[0].id : '');
            missingTo = !MZ.to;
            toHtml = `<label class="mz-pick">DELIVER TO <select id="mz-to" aria-label="Deliver to">${vs.length ? vs.map(v => `<option value="${esc(v.id)}"${v.id === MZ.to ? ' selected' : ''}>${esc(v.name)}</option>`).join('') : '<option value="">No accessible vessels</option>'}</select></label>`;
        }
        const blocking = preview ? preview.blocking.slice() : [];
        if (missingTo) blocking.push('No delivery vessel you can access.');
        const can = !!place && !!preview && blocking.length === 0;
        const status = !place ? `<span class="mz-short">Nowhere to build this: needs ${bp.output_type === 'colony_infrastructure' ? 'one of your colonies' : 'a vessel of yours with a Manufacturing deck, or one of your colonies'}.</span>`
            : blocking.length ? `<span class="mz-short">✕ ${esc(blocking.join(' · '))}</span>`
            : `<span class="mz-ok">✓ READY TO BUILD</span>`;
        const notes = preview && preview.notes.length ? `<p class="mz-note">${esc(preview.notes.join(' · '))}${preview.discountPct ? ` · ${esc(preview.discountPct)}% perk discount applied` : ''}</p>` : (preview && preview.discountPct ? `<p class="mz-note">${esc(preview.discountPct)}% perk discount applied</p>` : '');
        buildHtml = `<div class="mz-build">
            <label class="mz-pick">BUILD AT <select id="mz-at" aria-label="Build at"${places.length ? '' : ' disabled'}>${places.length ? places.map(p => `<option value="${esc(p.key)}"${place && p.key === place.key ? ' selected' : ''}>${esc(p.label)}</option>`).join('') : '<option value="">Nowhere available</option>'}</select></label>
            ${toHtml}<span class="mz-status">${status}</span><span class="dz-grow"></span>
            <button type="button" class="dz-btn ok" data-mzact="build"${can ? '' : ' disabled'}>START BUILD</button></div>${notes}`;
        if (place) MZ.at = place.key;
    }

    const actions = [];
    if (dm && draft) actions.push(`<button type="button" class="dz-btn ok" data-mzact="approve">✓ APPROVE</button>`);
    if (editable) actions.push(`<button type="button" class="dz-btn dim" data-mzact="edit">✎ EDIT</button>`, `<button type="button" class="dz-btn red" data-mzact="delete">✕ DELETE</button>`);
    return `<button type="button" class="dz-back" data-mzact="back">← BACK TO LIST</button>
        <span class="dz-kicker mz-goldtxt">BLUEPRINT · ${esc(MZ_TYPE[bp.output_type] || 'ITEM')}</span>
        <div class="dz-titlerow"><h3 class="dz-title">${esc(bp.name)}</h3>${draft ? '<span class="dz-chip amber">PENDING REVIEW</span>' : ''}${tierTxt ? `<span class="dz-chip ${tier === Infinity ? 'red' : 'gold'}">${esc(String(tierTxt).toUpperCase())}</span>` : ''}</div>
        ${bp.description ? `<p class="dz-desc">${esc(bp.description)}</p>` : ''}
        ${facts}
        ${output ? `<p class="mz-note">${esc(output)}</p>` : ''}${infraNote ? `<p class="mz-note">${esc(infraNote)}</p>` : ''}
        ${proposer ? `<span class="dz-by">PROPOSED BY ${esc(String(proposer.username || 'Commander').toUpperCase())}</span>` : ''}
        ${buildHtml}
        ${actions.length ? `<div class="dz-actions"><span class="dz-grow"></span>${actions.join('')}</div>` : ''}`;
}

function mzBuildsHtml() {
    const orders = window.globalManufacturingOrdersCache || [];
    const now = window.universeTimeHours || 0;
    return `<div class="dz-ttl"><span>IN-PROGRESS BUILDS · ALL VESSELS &amp; COLONIES</span><span class="dz-dim">${orders.length}</span></div>` + (orders.length ? orders.map(o => {
        const src = typeof window.manufacturingOrderSource === 'function' ? window.manufacturingOrderSource(o) : { label: '', canCancel: false };
        const queued = o.status === 'queued';
        const dur = Number(o.duration_hours) || 0;
        const pct = queued || !dur ? 0 : Math.max(0, Math.min(100, ((now - (o.started_at_hours || 0)) / dur) * 100));
        const status = String(typeof window.manufacturingOrderStatus === 'function' ? window.manufacturingOrderStatus(o) : '').replace(/^\S+\s/, '');
        return `<div class="mz-order"><span class="mz-otext"><span class="mz-oname">${esc(o.blueprint_name || 'Unknown Blueprint')} · ${esc(src.label)}${o.discount_pct ? ` · ${esc(o.discount_pct)}% discount` : ''}</span>
            <span class="mz-bar${queued ? ' queued' : ''}"><span style="width:${pct.toFixed(1)}%"></span></span></span>
            <span class="mz-otime">${esc(status.toUpperCase())}</span>
            ${src.canCancel ? `<button type="button" class="dz-btn red" data-mzcancel="${esc(o.id)}" title="Cancel this build and refund any deducted resources">CANCEL</button>` : ''}</div>`;
    }).join('') : '<div class="dz-empty">No builds in progress.</div>');
}

function renderMfg() {
    const panel = byId('term-panel-manufacturing');
    if (!panel) return;
    const on = window.fleetRestyleOn();
    panel.classList.toggle('vz-on', on);
    if (!on) return;
    const root = mzEnsureRoot();
    if (!root) return;
    const all = mzBlueprints();
    const pending = all.filter(bp => bp.status === 'draft').length;
    byId('mz-tabs').innerHTML = MZ_TABS.map(([k, label]) => {
        const n = k === 'all' ? all.length : k === 'pending' ? pending : all.filter(bp => bp.output_type === k).length;
        return `<button type="button" role="tab" class="dz-ftab${MZ.tab === k ? ' on' : ''}" data-mztab="${k}" aria-selected="${MZ.tab === k}">${label} <b class="${k === 'pending' ? 'amber' : ''}">${n}</b></button>`;
    }).join('');
    const search = byId('mz-search');
    if (search && document.activeElement !== search && search.value.trim().toLowerCase() !== MZ.q) search.value = MZ.q;
    const items = mzVisible();
    if (!items.some(bp => bp.id === MZ.sel)) MZ.sel = items.length ? items[0].id : null;
    byId('mz-list').innerHTML = `<div class="dz-ttl"><span>BLUEPRINTS</span><span class="dz-dim">${items.length} SHOWN</span></div>` + (items.length ? items.map(bp =>
        `<button type="button" class="dz-row${bp.id === MZ.sel ? ' sel' : ''}" data-mzsel="${esc(bp.id)}"><span class="dz-rowtext"><span class="dz-name">${esc(bp.name)}</span><span class="dz-meta">${esc(MZ_TYPE[bp.output_type] || 'ITEM')}</span></span>${bp.status === 'draft' ? '<span class="dz-chip amber">PENDING</span>' : ''}<span class="mz-time">${esc(Math.round((Number(bp.time_cost_hours) || 0) * 10) / 10)} H</span></button>`).join('')
        : `<div class="dz-empty">${all.length ? 'No blueprints match.' : 'No blueprints exist yet.'}</div>`);
    byId('mz-detail').innerHTML = mzDetailHtml(all.find(bp => bp.id === MZ.sel) || null);
    byId('mz-builds').innerHTML = mzBuildsHtml();
    byId('mz-body').classList.toggle('dz-show-detail', MZ.view === 'detail');
}
window.renderFleetManufacturing = renderMfg;

async function mzStartBuild() {
    const bp = mzBlueprints().find(b => b.id === MZ.sel);
    if (!bp || !MZ.at) return;
    const [kind, id] = [MZ.at.slice(0, 1), MZ.at.slice(2)];
    if (kind === 'v') await mzCall('startVesselManufacturingOrder', id, bp.id);
    else {
        const sel = byId('colony-deliver-vessel-' + id);
        if (sel && MZ.to && bp.output_type !== 'colony_infrastructure') {
            if (!Array.from(sel.options).some(o => o.value === MZ.to)) { const o = document.createElement('option'); o.value = MZ.to; o.textContent = MZ.to; sel.appendChild(o); }
            sel.value = MZ.to;
        }
        await mzCall('startColonyManufacturingOrder', id, bp.id);
    }
    renderMfg();
}

document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#mz-root button') : null;
    if (!b) return;
    const bp = mzBlueprints().find(x => x.id === MZ.sel);
    if (b.dataset.mztab) { MZ.tab = b.dataset.mztab; MZ.view = 'list'; }
    else if (b.dataset.mzsel) { MZ.sel = b.dataset.mzsel; MZ.view = 'detail'; }
    else if (b.dataset.mzcancel) { mzCall('cancelManufacturingOrder', b.dataset.mzcancel); return; }
    else if (b.dataset.mzact === 'back') MZ.view = 'list';
    else if (b.dataset.mzact === 'propose') { mzCall('openNewBlueprintModal'); return; }
    else if (b.dataset.mzact === 'build') { mzStartBuild(); return; }
    else if (bp && b.dataset.mzact === 'approve') { mzCall('approveBlueprint', bp.id); return; }
    else if (bp && b.dataset.mzact === 'edit') { mzCall('openEditBlueprintModal', bp.id); return; }
    else if (bp && b.dataset.mzact === 'delete') { mzCall('deleteManufacturingBlueprint', bp.id); return; }
    else return;
    renderMfg();
});
window.onHook('manufacturing-rendered', 'fleet-v2', renderMfg);
window.onHook('term-tab-switched', 'fleet-v2-manufacturing', (tab) => { if (tab === 'manufacturing') renderMfg(); });
document.addEventListener('darkforest:features-changed', renderMfg);
})();
