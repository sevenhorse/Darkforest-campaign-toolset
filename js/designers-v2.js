/* ==========================================================================
   js/designers-v2.js - Designers restyle (UI restyle R2, switch 'designers_restyle')
   ==========================================================================
   DM decisions (2026-10-09, from the R2 mockup): the Codex list + detail
   layout for every designer page. Catalogues (Perks / Augments / Gear) get
   ALL / PENDING / APPROVED filter tabs with counts; templates (Ship Designer,
   Secret Repository, Strike Craft) show the selected design big on the right:
   picture, stat grid, loadout, and the existing buttons. Phones: the list,
   then the entry full-screen with a back button.

   Looks only. Every list, permission and action stays in its own file
   (perk/augment/gear/ship/strike-craft designers): this file reads their
   lists and calls their functions. "+ NEW" on the template pages moves the
   page's existing creation form into the right-hand pane (the Codex trick)
   and puts it back afterwards, so saving still runs the old code. The old
   lists keep rendering, hidden (terminal badges stay right); each old render
   announces a '<kind>-…-rendered' hook and this view redraws on it.
   The Secret Repository's full NPC editor and the Strike Craft editor are
   unchanged and open over this view as before.
   ========================================================================== */
(function () {
const esc = (s) => (typeof window.escapeHtml === 'function' ? window.escapeHtml(s) : String(s == null ? '' : s));
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
const signed = (n) => (n >= 0 ? '+' : '') + n;
const ordered = (key, arr) => (typeof window.applySavedOrder === 'function' ? window.applySavedOrder(key, arr) : arr);
const call = (name, ...a) => { if (typeof window[name] === 'function') return window[name](...a); };
const profiles = () => (typeof allProfiles !== 'undefined' ? allProfiles : []);
const byId = (id) => document.getElementById(id);
// A page's creation form, found by its own name field (it may be borrowed into the pane).
const formOf = (inputId) => { const el = byId(inputId); return el ? el.closest('.sheet-section') : null; };

/* ---------- Catalogue kinds (Perks / Augments / Gear) ---------- */
function catalogFacts(x) {
    if (x.flavor_only) return [{ k: 'TYPE', v: 'FLAVOR ONLY', c: '#c778dd' }];
    const out = [];
    if (x.points_grant > 0) out.push({ k: 'FREE SKILL POINTS', v: '+' + x.points_grant, c: '#00e5a3' });
    if (x.shield_max_bonus) out.push({ k: 'SHIELD MAX', v: signed(x.shield_max_bonus), c: '#00e1ff' });
    if (x.dr_bonus) out.push({ k: 'DR', v: signed(x.dr_bonus), c: '#c9962f' });
    if (x.injury_max_bonus) out.push({ k: 'INJURY MAX', v: signed(x.injury_max_bonus), c: '#ff6b6b' });
    (x.effects || []).forEach(e => { if (e && e.name) out.push({ k: String(e.name).toUpperCase(), v: typeof e.bonus === 'number' ? signed(e.bonus) : '—', c: e.bonus < 0 ? '#ff6b6b' : '#00e5a3' }); });
    return out;
}
function catalogSummary(x) {
    const f = catalogFacts(x);
    if (!f.length) return 'NO EFFECTS';
    if (x.flavor_only) return 'FLAVOR';
    return f.slice(0, 2).map(c => `${c.k.split(' ')[0]} ${c.v}`).join(' · ') + (f.length > 2 ? ' …' : '');
}
const factGrid = (f) => f.length
    ? `<div class="dz-facts">${f.map(c => `<div class="dz-fact"><span>${esc(c.k)}</span><b style="color:${c.c}">${esc(c.v)}</b></div>`).join('')}</div>`
    : '<div class="dz-empty">No effects configured.</div>';
function catalogKind(o) {
    return Object.assign({
        filters: true, search: (x) => `${x.name || ''} ${x.description || ''}`,
        items() {
            const all = o.list();
            return ordered(o.orderKey + '_pending', all.filter(x => x.status === 'draft')).concat(ordered(o.orderKey + '_approved', all.filter(x => x.status === 'approved')));
        },
        group: (x) => x.status === 'draft' ? 'pending' : 'approved',
        chips: (x) => [x.status === 'draft' ? ['PENDING', 'amber'] : ['APPROVED', 'ok']],
        rowMeta: (x) => `${o.meta(x)} · ${catalogSummary(x)}`,
        kicker: (x) => `${o.noun} · ${o.meta(x)}`,
        body(x) {
            const proposer = profiles().find(p => p.id === x.created_by);
            return `${x.description ? `<p class="dz-desc">${esc(x.description)}</p>` : ''}${factGrid(catalogFacts(x))}
                ${proposer ? `<span class="dz-by">PROPOSED BY ${esc(proposer.username || 'Commander')}</span>` : ''}`;
        },
        actions(x, ctx) {
            const editable = o.can(x);
            const sibs = ctx.items.filter(y => y.status === x.status), i = sibs.findIndex(y => y.id === x.id);
            return {
                left: [isDm() && x.status === 'draft' && { act: 'approve', label: '✓ APPROVE', tone: 'ok' },
                       editable && { act: 'edit', label: 'EDIT' },
                       { act: 'up', label: '▲', tone: 'dim', aria: 'Move up', disabled: i <= 0 },
                       { act: 'down', label: '▼', tone: 'dim', aria: 'Move down', disabled: i < 0 || i >= sibs.length - 1 }],
                right: [editable && { act: 'delete', label: 'DELETE', tone: 'red' }]
            };
        },
        onAct(act, x) {
            const map = { approve: o.approve, edit: o.edit, delete: o.del };
            if (map[act]) call(map[act], x.id);
            else if (act === 'up' || act === 'down') call(o.move, x.id, act);
        },
        newButton: { label: `+ PROPOSE ${o.noun}`, run: () => call(o.propose) }
    }, o);
}

/* ---------- Template kinds (Ship Designer / Secret Repository / Strike Craft) ---------- */
const DRIVE = { ftl_class1: 'Class 1 Warp Drive', ftl_class2: 'Class 2 Hyperdrive', ftl_fold: 'Experimental Fold Drive', sublight: 'Sublight Thrusters' };
function shipChips(t, secret) {
    const c = [];
    if (t.vessel_class) c.push([t.vessel_class === 'Capital' ? '⬢ CAPITAL' : '◆ ESCORT', 'gold']);
    else if (isDm() && (t.ship_weapons || []).length) c.push(['⚠ UNCLASSIFIED', 'amber']);
    if (t.is_station) c.push(['🛰 STATION', 'gold']);
    if (t.iff) c.push([String(t.iff).toUpperCase(), t.iff === 'hostile' ? 'red' : (t.iff === 'friendly' ? 'ok' : '')]);
    if (secret && t.ai_controlled) c.push(['🤖 AI', 'red']);
    return c;
}
function shipBody(t, secret) {
    const weapons = t.ship_weapons || [];
    const slots = t.is_station ? `${weapons.length}` : `${weapons.length} / ${t.hardpoint_slots || 4}`;
    const line = t.is_station ? `${t.class || 'Station'} · Stationary platform` : `${t.class || 'Frigate'} · ${DRIVE[t.drive_type] || DRIVE.ftl_class1}`;
    const stat = (k, v, col) => `<div class="dz-fact"><span>${k}</span><b style="color:${col || '#e8f6fa'}">${esc(v)}</b></div>`;
    const pic = typeof window.mediaThumbHtml === 'function' ? window.mediaThumbHtml(t.image_url, { size: 180, width: 260, caption: t.name }) : '';
    const owner = !secret ? profiles().find(p => p.id === t.owner_id) : null;
    const wpnRows = weapons.length ? weapons.map(w => {
        const mod = w.modifier && String(w.modifier) !== '+0' && String(w.modifier) !== '0' ? ` ${w.modifier}` : '';
        const bits = [w.dice ? `${w.dice}${mod}` : '', w.damage_type || '', w.range ? `range ${w.range}` : 'range ∞', w.arc ? String(w.arc).replace(/_/g, ' ') : '', w.is_point_defense ? 'PD' : '', w.weapon_class === 'ordnance' ? 'ordnance' : '', (w.ammo >= 0 && w.max_ammo != null) ? `ammo ${w.max_ammo}` : ''].filter(Boolean);
        return `<div class="dz-lrow"><span class="dz-lname">${esc(w.name || 'Weapon')}</span><span class="dz-lmeta">${esc(bits.join(' · '))}</span></div>`;
    }).join('') : '<div class="dz-empty">No weapons installed.</div>';
    return `<span class="dz-line">${esc(line)}</span>
        <div class="dz-shiptop">${pic ? `<div class="dz-pic">${pic}</div>` : `<div class="dz-pic dz-nopic">NO PICTURE</div>`}
            <div class="dz-facts dz-stats">${stat('HULL', t.max_hull || 0)}${stat('SHIELDS', t.max_shields || 0, '#00e1ff')}${stat('HARDENED', t.max_hardened || 0, '#c9962f')}
            ${stat('REACTIVE', t.max_reactive || 0)}${stat('ABLATIVE', t.max_ablative || 0)}${stat('SPEED', t.is_station ? 0 : (t.tactical_speed != null ? t.tactical_speed : 160))}
            ${stat('HARDPOINTS', slots)}${stat('DECKS', (t.ship_decks || []).length)}${stat('SQUADRONS', (t.ship_hangar || []).length)}</div></div>
        <div class="dz-sub"><div class="dz-subttl">LOADOUT</div>${wpnRows}</div>
        ${owner ? `<span class="dz-by">DESIGNER ${esc(owner.username || 'Commander')}</span>` : ''}`;
}
const KINDS = {
    perk: catalogKind({
        host: () => byId('term-panel-perkdesigner'), title: 'PERKS', sub: 'SPECIALIST ROSTER', noun: 'PERK', plural: 'perks', hook: 'perk-designer-rendered',
        list: () => (typeof perkDefinitionsList !== 'undefined' ? perkDefinitionsList : []),
        can: (x) => typeof canManagePerk === 'function' && canManagePerk(x),
        orderKey: 'perks', propose: 'openNewPerkModal', edit: 'openEditPerkModal', approve: 'approvePerk', del: 'deletePerkDefinition', move: 'movePerkDefinitionOrder',
        meta: (x) => `SECTION ${x.section != null ? x.section : '?'}`
    }),
    augment: catalogKind({
        host: () => byId('term-panel-augmentdesigner'), title: 'AUGMENTS', sub: 'BODY AUGMENTATION CATALOG', noun: 'AUGMENT', plural: 'augments', hook: 'augment-designer-rendered',
        list: () => (typeof augmentDefinitionsList !== 'undefined' ? augmentDefinitionsList : []),
        can: (x) => typeof canManageAugment === 'function' && canManageAugment(x),
        orderKey: 'augments', propose: 'openNewAugmentModal', edit: 'openEditAugmentModal', approve: 'approveAugment', del: 'deleteAugmentDefinition', move: 'moveAugmentDefinitionOrder',
        meta: (x) => ((x.slots || []).map(s => (window.AUGMENT_SLOT_LABELS || {})[s] || s).join(', ') || 'NO SLOTS TAGGED').toUpperCase()
    }),
    gear: catalogKind({
        host: () => byId('term-panel-geardesigner'), title: 'GEAR', sub: 'PERSONAL GEAR CATALOG', noun: 'GEAR', plural: 'gear', hook: 'gear-designer-rendered',
        list: () => (typeof gearDefinitionsList !== 'undefined' ? gearDefinitionsList : []),
        can: (x) => typeof canManageGear === 'function' && canManageGear(x),
        orderKey: 'gear', propose: 'openNewGearModal', edit: 'openEditGearModal', approve: 'approveGear', del: 'deleteGearDefinition', move: 'moveGearDefinitionOrder',
        meta: () => 'GEAR'
    }),
    ship: {
        host: () => byId('term-panel-shipdesigner'), title: 'SHIP DESIGNER', sub: 'PUBLIC TEMPLATES', noun: 'TEMPLATE', plural: 'templates', hook: 'ship-designer-rendered',
        filters: false, search: (t) => `${t.name || ''} ${t.class || ''}`,
        items: () => ordered('ship_templates', typeof shipTemplatesList !== 'undefined' ? shipTemplatesList : []),
        chips: (t) => shipChips(t, false),
        rowMeta: (t) => `HULL ${t.max_hull || 0} · ${(t.ship_weapons || []).length} WEAPONS · ${(t.ship_decks || []).length} DECKS`,
        thumb: (t) => t.image_url,
        kicker: () => 'SHIP TEMPLATE · PUBLIC',
        body: (t) => shipBody(t, false),
        actions(t, ctx) {
            const editable = typeof canManageTemplate === 'function' && canManageTemplate(t);
            const i = ctx.items.findIndex(y => y.id === t.id);
            return {
                left: [{ act: 'deploy', label: '🚀 DEPLOY', tone: 'ok' }, editable && { act: 'stats', label: 'EDIT BASE STATS' }, editable && { act: 'loadout', label: 'LOADOUT' },
                       { act: 'up', label: '▲', tone: 'dim', aria: 'Move up', disabled: i <= 0 }, { act: 'down', label: '▼', tone: 'dim', aria: 'Move down', disabled: i < 0 || i >= ctx.items.length - 1 }],
                right: [editable && { act: 'delete', label: 'DELETE', tone: 'red' }]
            };
        },
        onAct(act, t) {
            const map = { deploy: 'deployShipTemplate', stats: 'openEditTemplateModal', loadout: 'openTemplateLoadoutModal', delete: 'deleteShipTemplate' };
            if (map[act]) call(map[act], t.id);
            else if (act === 'up' || act === 'down') call('moveShipTemplateOrder', t.id, act);
        },
        newButton: { label: '+ NEW TEMPLATE', form: () => formOf('new-template-name') }
    },
    secret: {
        host: () => byId('secretrepo-list-view'), panel: () => byId('term-panel-secretrepo'), title: 'SECRET REPOSITORY', sub: 'HIDDEN NPC TEMPLATES — DM ONLY', noun: 'NPC TEMPLATE', plural: 'NPC templates', hook: 'secretrepo-rendered',
        filters: false, search: (t) => `${t.name || ''} ${t.class || ''}`,
        items: () => (window.secretShipTemplatesList || []),
        chips: (t) => shipChips(t, true),
        rowMeta: (t) => `${(t.class || 'FRIGATE').toUpperCase()} · HULL ${t.max_hull || 0} · ${(t.ship_weapons || []).length} WEAPONS`,
        thumb: (t) => t.image_url,
        kicker: () => 'NPC TEMPLATE · HIDDEN FROM PLAYERS',
        body: (t) => shipBody(t, true) + `<label class="dz-init">Initiative for TO TRACKER <input type="number" class="dz-init-in" value="10"></label>`,
        actions: () => ({
            left: [{ act: 'deploy', label: '🚀 DEPLOY TO MAP', tone: 'ok' }, { act: 'tracker', label: '⚔ TO TRACKER' }, { act: 'open', label: 'OPEN FULL EDITOR ▸' }],
            right: [{ act: 'delete', label: 'DELETE', tone: 'red' }]
        }),
        onAct(act, t, root) {
            if (act === 'deploy') call('deployShipTemplate', t.id);
            else if (act === 'open') call('openSecretRepoEditor', t.id);
            else if (act === 'delete') call('deleteShipTemplate', t.id);
            else if (act === 'tracker') {
                // deployTemplateToInitiative reads the old list's #repo-init-<id> box.
                const mine = root.querySelector('.dz-init-in'), theirs = byId('repo-init-' + t.id);
                if (mine && theirs) theirs.value = mine.value;
                call('deployTemplateToInitiative', t.id);
            }
        },
        newButton: { label: '+ NEW NPC TEMPLATE', form: () => formOf('new-secret-template-name') },
        extra: () => { const c = byId('saved-fleets-list-container'); return c ? c.closest('.sheet-section') : null; }
    },
    strike: {
        host: () => byId('strikecraft-list-view'), panel: () => byId('term-panel-strikecraft'), title: 'STRIKE CRAFT', sub: 'CHASSIS DESIGNER', noun: 'CHASSIS', plural: 'chassis', hook: 'strikecraft-designer-rendered',
        filters: false, search: (t) => `${t.label || ''} ${t.key || ''}`,
        name: (t) => t.label,
        items: () => (window.globalStrikeCraftTemplatesList || []),
        chips: (t) => [[`${t.base_hp || 0} HP`, '']],
        rowMeta: (t) => `KEY ${String(t.key || '').toUpperCase()} · ${(t.weapons || []).length} WEAPONS`,
        kicker: (t) => `STRIKE CRAFT CHASSIS · KEY ${String(t.key || '')}`,
        body(t) {
            const w = t.weapons || [];
            const rows = w.length ? w.map(x => `<div class="dz-lrow"><span class="dz-lname">${esc(x.name || 'Weapon')}</span><span class="dz-lmeta">${esc([x.dice, x.dmgType || x.damage_type, x.role ? String(x.role).replace(/_/g, ' ') : '', x.range ? `range ${x.range}` : '', x.weapon_class === 'ordnance' ? 'ordnance' : '', x.cooldown_period ? `cd ${x.cooldown_period}` : ''].filter(Boolean).join(' · '))}</span></div>`).join('') : '<div class="dz-empty">No weapons yet.</div>';
            return `<div class="dz-facts"><div class="dz-fact"><span>HP PER CRAFT</span><b>${esc(t.base_hp || 0)}</b></div><div class="dz-fact"><span>WEAPONS</span><b>${w.length}</b></div></div>
                <div class="dz-sub"><div class="dz-subttl">WEAPONS (DICE ARE PER CRAFT)</div>${rows}</div>`;
        },
        actions: () => ({ left: [{ act: 'open', label: 'OPEN EDITOR ▸' }], right: [] }),
        onAct(act, t) { if (act === 'open') call('openStrikeCraftEditor', t.id); },
        newButton: { label: '+ NEW CHASSIS', form: () => formOf('new-strikecraft-name') }
    }
};

// Per-kind view state; survives redraws (window.__dz for tests).
const S = window.__dz = window.__dz || {};
Object.keys(KINDS).forEach(k => { S[k] = Object.assign({ filter: 'all', sel: null, q: '', view: 'list', mode: 'view', known: null }, S[k] || {}); });
const moved = {}; // form / extra nodes moved into the view: node -> { parent, next }

window.designersRestyleOn = function () { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('designers_restyle'); };
const nameOf = (K, x) => (K.name ? K.name(x) : x.name) || '';
function initials(name) {
    const w = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(' ').filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '').slice(1, 2))).toUpperCase();
}
function borrow(node, slot) {
    if (!node || !slot || node.parentNode === slot) return;
    if (!moved[node.id || (node.id = 'dz-moved-' + Math.random().toString(36).slice(2, 8))]) moved[node.id] = { parent: node.parentNode, next: node.nextSibling };
    slot.appendChild(node);
}
function giveBack(node) {
    if (!node || !moved[node.id]) return;
    const m = moved[node.id];
    if (m.parent) m.parent.insertBefore(node, m.next && m.next.parentNode === m.parent ? m.next : null);
    delete moved[node.id];
}

function ensureRoot(kind) {
    const K = KINDS[kind], host = K.host();
    if (!host) return null;
    let root = byId('dz-root-' + kind);
    if (!root) {
        root = document.createElement('div');
        root.id = 'dz-root-' + kind;
        root.className = 'dz-root';
        root.dataset.kind = kind;
        host.appendChild(root);
    }
    if (!root.dataset.built) {
        root.innerHTML = `<div class="dz-top">
                <h2 class="dz-h1">${K.title}</h2><span class="dz-h1sub">// ${K.sub}</span><span class="dz-grow"></span>
                <label class="dz-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg>
                <span class="dz-sr">Search ${K.plural}</span><input type="text" class="dz-q" placeholder="Search ${K.plural}"></label>
                <button type="button" class="dz-btn" data-act="new">${K.newButton.label}</button>
            </div>
            ${K.filters ? `<div class="dz-filters" role="tablist" aria-label="Filter ${K.plural}"></div>` : ''}
            <div class="dz-body"></div><div class="dz-extra"></div>`;
        root.dataset.built = '1';
    }
    return root;
}

function render(kind) {
    const K = KINDS[kind], host = K.host();
    if (!host) return;
    const on = window.designersRestyleOn() && (kind !== 'secret' && kind !== 'strike' || isDm());
    host.classList.toggle('dz-on', on);
    const st = S[kind];
    const formNode = K.newButton.form ? K.newButton.form() : null;
    if (!on) {
        // Put borrowed nodes back so the old page is whole again.
        Object.keys(moved).forEach(id => { const n = byId(id); if (n && n.closest && n.closest('#dz-root-' + kind)) giveBack(n); });
        st.mode = 'view';
        return;
    }
    const root = ensureRoot(kind);
    if (!root) return;
    const items = K.items();
    // A new design just saved: select it and hand the form back.
    if (st.mode === 'new' && st.known) {
        const fresh = items.find(x => !st.known.has(x.id));
        if (fresh) { st.sel = fresh.id; st.mode = 'view'; st.view = 'detail'; }
    }
    const q = (st.q || '').trim().toLowerCase();
    const match = (x) => !q || K.search(x).toLowerCase().includes(q);
    const groups = K.filters ? { all: items, pending: items.filter(x => K.group(x) === 'pending'), approved: items.filter(x => K.group(x) === 'approved') } : { all: items };
    const shown = (groups[st.filter] || items).filter(match);
    if (!shown.some(x => x.id === st.sel)) st.sel = shown.length ? shown[0].id : null;
    const cur = st.mode === 'new' ? null : (items.find(x => x.id === st.sel) || null);

    if (K.filters) {
        root.querySelector('.dz-filters').innerHTML = [['all', 'ALL', ''], ['pending', 'PENDING', 'amber'], ['approved', 'APPROVED', 'ok']].map(([key, label, tone]) =>
            `<button type="button" role="tab" class="dz-ftab${st.filter === key ? ' on' : ''}" data-filter="${key}" aria-selected="${st.filter === key}">${label} <b class="${tone}">${groups[key].filter(match).length}</b></button>`).join('');
    }
    const thumb = (x) => {
        const ref = K.thumb ? K.thumb(x) : null;
        const img = ref && typeof window.mediaThumbHtml === 'function' ? window.mediaThumbHtml(ref, { size: 40, caption: nameOf(K, x) }) : '';
        return img ? `<span class="dz-thumb dz-thumbimg">${img}</span>` : `<span class="dz-thumb">${esc(initials(nameOf(K, x)))}</span>`;
    };
    const chipHtml = (c) => `<span class="dz-chip ${c[1] || ''}">${esc(c[0])}</span>`;
    const listHtml = shown.length ? shown.map(x => `<button type="button" class="dz-row${cur && x.id === cur.id ? ' sel' : ''}" data-sel="${esc(x.id)}">
            ${thumb(x)}<span class="dz-rowtext"><span class="dz-name">${esc(nameOf(K, x))}</span><span class="dz-meta">${esc(K.rowMeta(x))}</span></span>
            ${(K.chips(x)[0] ? chipHtml(K.chips(x)[0]) : '')}</button>`).join('')
        : `<div class="dz-empty">${items.length ? `No ${K.plural} match.` : `No ${K.plural} yet. Use ${K.newButton.label} to add one.`}</div>`;

    let detail;
    if (st.mode === 'new') {
        detail = `<button type="button" class="dz-back" data-act="back">← BACK TO LIST</button>
            <span class="dz-kicker">NEW ${K.noun}</span><div class="dz-formslot"></div>
            <div class="dz-actions"><span class="dz-grow"></span><button type="button" class="dz-btn dim" data-act="cancelnew">CANCEL</button></div>`;
    } else if (cur) {
        const a = K.actions(cur, { items });
        const btn = (b) => b ? `<button type="button" class="dz-btn ${b.tone || ''}" data-act="${b.act}"${b.aria ? ` aria-label="${b.aria}"` : ''}${b.disabled ? ' disabled' : ''}>${b.label}</button>` : '';
        detail = `<button type="button" class="dz-back" data-act="back">← BACK TO LIST</button>
            <span class="dz-kicker">${esc(K.kicker(cur))}</span>
            <div class="dz-titlerow"><h3 class="dz-title">${esc(nameOf(K, cur))}</h3>${K.chips(cur).map(chipHtml).join('')}</div>
            ${K.body(cur)}
            <span class="dz-grow"></span>
            <div class="dz-actions">${a.left.map(btn).join('')}<span class="dz-grow"></span>${a.right.map(btn).join('')}</div>`;
    } else {
        detail = `<div class="dz-empty">${items.length ? 'Pick an entry on the left.' : `Nothing here yet. Use ${K.newButton.label} to add one.`}</div>`;
    }
    // Keep a borrowed form alive across the redraw.
    if (formNode && formNode.closest && formNode.closest('#dz-root-' + kind)) giveBack(formNode);
    const body = root.querySelector('.dz-body');
    body.classList.toggle('dz-show-detail', st.view === 'detail' && (!!cur || st.mode === 'new'));
    body.innerHTML = `<div class="dz-panel dz-list"><div class="dz-ttl"><span>${kind === 'perk' || kind === 'augment' || kind === 'gear' ? 'ENTRIES' : K.plural.toUpperCase()}</span><span class="dz-dim">${shown.length}</span></div>${listHtml}</div>
        <div class="dz-panel dz-detail">${detail}</div>`;
    if (st.mode === 'new' && formNode) borrow(formNode, body.querySelector('.dz-formslot'));
    if (K.extra) borrow(K.extra(), root.querySelector('.dz-extra'));
}
window.renderDesignerV2 = render;

// One delegated listener for every designer page.
document.addEventListener('click', (e) => {
    const root = e.target && e.target.closest ? e.target.closest('.dz-root') : null;
    if (!root) return;
    const btn = e.target.closest('button');
    if (!btn || btn.disabled || btn.closest('.dz-formslot') || btn.closest('.dz-extra')) return;
    const kind = root.dataset.kind, K = KINDS[kind], st = S[kind];
    if (btn.dataset.filter) { st.filter = btn.dataset.filter; render(kind); return; }
    if (btn.dataset.sel) { st.sel = btn.dataset.sel; st.mode = 'view'; st.view = 'detail'; render(kind); return; }
    const act = btn.dataset.act;
    if (!act) return;
    if (act === 'new') {
        if (K.newButton.run) { K.newButton.run(); return; }
        st.mode = 'new'; st.view = 'detail'; st.known = new Set(K.items().map(x => x.id)); render(kind); return;
    }
    if (act === 'back') { st.view = 'list'; if (st.mode === 'new') st.mode = 'view'; render(kind); return; }
    if (act === 'cancelnew') { st.mode = 'view'; render(kind); return; }
    const cur = K.items().find(x => x.id === st.sel);
    if (cur) K.onAct(act, cur, root);
});
document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains('dz-q')) return;
    const kind = t.closest('.dz-root').dataset.kind;
    S[kind].q = t.value;
    render(kind);
});

// Redraw whenever the old page redraws (load, realtime, save, approve, reorder).
Object.keys(KINDS).forEach(kind => window.onHook(KINDS[kind].hook, 'designers-v2', () => render(kind)));
document.addEventListener('darkforest:features-changed', () => Object.keys(KINDS).forEach(render));
})();
