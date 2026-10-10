/* ==========================================================================
   js/designers-v2.js - Designers restyle, part 1: Perks / Augments / Gear
   (UI restyle R2, switch 'designers_restyle')
   ==========================================================================
   DM decisions (2026-10-09, from the R2 mockup): the Codex list + detail
   layout; ALL / PENDING / APPROVED filter tabs with counts; the selected
   entry on the right with its effects in a fact grid, who proposed it, and
   the APPROVE (DM, pending only) / EDIT / ▲▼ / DELETE buttons. Phones: the
   list, then the entry full-screen with a back button.

   Looks only. The catalogues, permissions and every action stay in
   perk-designer.js / augment-designer.js / gear-designer.js: this file reads
   their lists and calls their functions (approve, delete, reorder, the
   existing propose / edit popups). The old list keeps rendering, hidden,
   so the terminal badges stay right; each old render announces
   '<kind>-designer-rendered' and this view redraws on it.
   ========================================================================== */
(function () {
const KINDS = {
    perk: {
        panel: 'term-panel-perkdesigner', title: 'PERKS', sub: 'SPECIALIST ROSTER', noun: 'PERK', plural: 'perks',
        list: () => (typeof perkDefinitionsList !== 'undefined' ? perkDefinitionsList : []),
        can: (x) => typeof canManagePerk === 'function' && canManagePerk(x),
        orderKey: 'perks', propose: 'openNewPerkModal', edit: 'openEditPerkModal', approve: 'approvePerk', del: 'deletePerkDefinition', move: 'movePerkDefinitionOrder',
        meta: (x) => `SECTION ${x.section != null ? x.section : '?'}`
    },
    augment: {
        panel: 'term-panel-augmentdesigner', title: 'AUGMENTS', sub: 'BODY AUGMENTATION CATALOG', noun: 'AUGMENT', plural: 'augments',
        list: () => (typeof augmentDefinitionsList !== 'undefined' ? augmentDefinitionsList : []),
        can: (x) => typeof canManageAugment === 'function' && canManageAugment(x),
        orderKey: 'augments', propose: 'openNewAugmentModal', edit: 'openEditAugmentModal', approve: 'approveAugment', del: 'deleteAugmentDefinition', move: 'moveAugmentDefinitionOrder',
        meta: (x) => ((x.slots || []).map(s => (window.AUGMENT_SLOT_LABELS || {})[s] || s).join(', ') || 'NO SLOTS TAGGED').toUpperCase()
    },
    gear: {
        panel: 'term-panel-geardesigner', title: 'GEAR', sub: 'PERSONAL GEAR CATALOG', noun: 'GEAR', plural: 'gear',
        list: () => (typeof gearDefinitionsList !== 'undefined' ? gearDefinitionsList : []),
        can: (x) => typeof canManageGear === 'function' && canManageGear(x),
        orderKey: 'gear', propose: 'openNewGearModal', edit: 'openEditGearModal', approve: 'approveGear', del: 'deleteGearDefinition', move: 'moveGearDefinitionOrder',
        meta: () => 'GEAR'
    }
};
// Per-kind view state; survives redraws (window.__dz for tests).
const S = window.__dz = window.__dz || {};
Object.keys(KINDS).forEach(k => { S[k] = S[k] || { filter: 'all', sel: null, q: '', view: 'list' }; });

window.designersRestyleOn = function () { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('designers_restyle'); };
const esc = (s) => (typeof window.escapeHtml === 'function' ? window.escapeHtml(s) : String(s == null ? '' : s));
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
const signed = (n) => (n >= 0 ? '+' : '') + n;
const ordered = (key, arr) => (typeof window.applySavedOrder === 'function' ? window.applySavedOrder(key, arr) : arr);

// Pending first, then approved, each in the DM's saved order (same keys as the old list).
function entries(kind) {
    const K = KINDS[kind], all = K.list();
    const pending = ordered(K.orderKey + '_pending', all.filter(x => x.status === 'draft'));
    const approved = ordered(K.orderKey + '_approved', all.filter(x => x.status === 'approved'));
    return { pending, approved, all: pending.concat(approved) };
}
// The effect cells shown in the detail fact grid (and summarised in the list).
function facts(x) {
    if (x.flavor_only) return [{ k: 'TYPE', v: 'FLAVOR ONLY', c: '#c778dd' }];
    const out = [];
    if (x.points_grant > 0) out.push({ k: 'FREE SKILL POINTS', v: '+' + x.points_grant, c: '#00e5a3' });
    if (x.shield_max_bonus) out.push({ k: 'SHIELD MAX', v: signed(x.shield_max_bonus), c: '#00e1ff' });
    if (x.dr_bonus) out.push({ k: 'DR', v: signed(x.dr_bonus), c: '#c9962f' });
    if (x.injury_max_bonus) out.push({ k: 'INJURY MAX', v: signed(x.injury_max_bonus), c: '#ff6b6b' });
    (x.effects || []).forEach(e => { if (e && e.name) out.push({ k: String(e.name).toUpperCase(), v: typeof e.bonus === 'number' ? signed(e.bonus) : '—', c: e.bonus < 0 ? '#ff6b6b' : '#00e5a3' }); });
    return out;
}
function summary(x) {
    const f = facts(x);
    if (!f.length) return 'NO EFFECTS';
    if (x.flavor_only) return 'FLAVOR';
    return f.slice(0, 2).map(c => `${c.k.split(' ')[0]} ${c.v}`).join(' · ') + (f.length > 2 ? ' …' : '');
}
function initials(name) {
    const w = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(' ').filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '').slice(1, 2))).toUpperCase();
}
const chip = (x) => x.status === 'draft' ? ['PENDING', 'amber'] : ['APPROVED', 'ok'];

function ensureRoot(kind) {
    const panel = document.getElementById(KINDS[kind].panel);
    if (!panel) return null;
    let root = document.getElementById('dz-root-' + kind);
    if (!root) {
        root = document.createElement('div');
        root.id = 'dz-root-' + kind;
        root.className = 'dz-root';
        root.dataset.kind = kind;
        panel.appendChild(root);
    }
    if (!root.dataset.built) {
        const K = KINDS[kind];
        root.innerHTML = `<div class="dz-top">
                <h2 class="dz-h1">${K.title}</h2><span class="dz-h1sub">// ${K.sub}</span><span class="dz-grow"></span>
                <label class="dz-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg>
                <span class="dz-sr">Search ${K.plural}</span><input type="text" class="dz-q" placeholder="Search ${K.plural} by name or description"></label>
                <button type="button" class="dz-btn" data-act="propose">+ PROPOSE ${K.noun}</button>
            </div>
            <div class="dz-filters" role="tablist" aria-label="Filter ${K.plural}"></div>
            <div class="dz-body"></div>`;
        root.dataset.built = '1';
    }
    return root;
}

function render(kind) {
    const K = KINDS[kind];
    const panel = document.getElementById(K.panel);
    if (!panel) return;
    const on = window.designersRestyleOn();
    panel.classList.toggle('dz-on', on);
    if (!on) return;
    const root = ensureRoot(kind);
    if (!root) return;
    const st = S[kind];
    const q = (st.q || '').trim().toLowerCase();
    const E = entries(kind);
    const match = (x) => !q || (x.name || '').toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q);
    const pool = { all: E.all, pending: E.pending, approved: E.approved };
    const shown = (pool[st.filter] || E.all).filter(match);
    if (!shown.some(x => x.id === st.sel)) st.sel = shown.length ? shown[0].id : null;
    const cur = E.all.find(x => x.id === st.sel) || null;

    root.querySelector('.dz-filters').innerHTML = [['all', 'ALL', ''], ['pending', 'PENDING', 'amber'], ['approved', 'APPROVED', 'ok']].map(([key, label, tone]) =>
        `<button type="button" role="tab" class="dz-ftab${st.filter === key ? ' on' : ''}" data-filter="${key}" aria-selected="${st.filter === key}">${label} <b class="${tone}">${pool[key].filter(match).length}</b></button>`).join('');

    const listHtml = shown.length ? shown.map(x => {
        const [cl, tone] = chip(x);
        return `<button type="button" class="dz-row${x.id === st.sel ? ' sel' : ''}" data-sel="${esc(x.id)}">
            <span class="dz-thumb">${esc(initials(x.name))}</span>
            <span class="dz-rowtext"><span class="dz-name">${esc(x.name)}</span><span class="dz-meta">${esc(K.meta(x))} · ${esc(summary(x))}</span></span>
            <span class="dz-chip ${tone}">${cl}</span></button>`;
    }).join('') : `<div class="dz-empty">${E.all.length ? `No ${K.plural} match.` : `No ${K.plural} yet. Use + PROPOSE ${K.noun} to add one.`}</div>`;

    let detail = `<div class="dz-empty">Pick an entry on the left.</div>`;
    if (cur) {
        const [cl, tone] = chip(cur);
        const proposer = (typeof allProfiles !== 'undefined' ? allProfiles : []).find(p => p.id === cur.created_by);
        const editable = K.can(cur);
        const sibs = cur.status === 'draft' ? E.pending : E.approved;
        const i = sibs.findIndex(x => x.id === cur.id);
        const f = facts(cur);
        detail = `<button type="button" class="dz-back" data-act="back">← BACK TO LIST</button>
            <span class="dz-kicker">${K.noun} · ${esc(K.meta(cur))}</span>
            <div class="dz-titlerow"><h3 class="dz-title">${esc(cur.name)}</h3><span class="dz-chip ${tone}">${cl}</span></div>
            ${cur.description ? `<p class="dz-desc">${esc(cur.description)}</p>` : ''}
            ${f.length ? `<div class="dz-facts">${f.map(c => `<div class="dz-fact"><span>${esc(c.k)}</span><b style="color:${c.c}">${esc(c.v)}</b></div>`).join('')}</div>` : '<div class="dz-empty">No effects configured.</div>'}
            ${proposer ? `<span class="dz-by">PROPOSED BY ${esc(proposer.username || 'Commander')}</span>` : ''}
            <span class="dz-grow"></span>
            <div class="dz-actions">
                ${isDm() && cur.status === 'draft' ? `<button type="button" class="dz-btn ok" data-act="approve">✓ APPROVE</button>` : ''}
                ${editable ? `<button type="button" class="dz-btn" data-act="edit">EDIT</button>` : ''}
                <button type="button" class="dz-btn dim" data-act="up" aria-label="Move up" ${i <= 0 ? 'disabled' : ''}>▲</button>
                <button type="button" class="dz-btn dim" data-act="down" aria-label="Move down" ${i < 0 || i >= sibs.length - 1 ? 'disabled' : ''}>▼</button>
                <span class="dz-grow"></span>
                ${editable ? `<button type="button" class="dz-btn red" data-act="delete">DELETE</button>` : ''}
            </div>`;
    }
    const body = root.querySelector('.dz-body');
    body.classList.toggle('dz-show-detail', st.view === 'detail' && !!cur);
    body.innerHTML = `<div class="dz-panel dz-list"><div class="dz-ttl"><span>ENTRIES</span><span class="dz-dim">${shown.length}</span></div>${listHtml}</div>
        <div class="dz-panel dz-detail">${detail}</div>`;
}
window.renderDesignerV2 = render;

// One delegated listener for all three pages.
document.addEventListener('click', (e) => {
    const root = e.target && e.target.closest ? e.target.closest('.dz-root') : null;
    if (!root) return;
    const kind = root.dataset.kind, K = KINDS[kind], st = S[kind];
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    const call = (name, ...a) => { if (typeof window[name] === 'function') return window[name](...a); };
    if (btn.dataset.filter) { st.filter = btn.dataset.filter; render(kind); return; }
    if (btn.dataset.sel) { st.sel = btn.dataset.sel; st.view = 'detail'; render(kind); return; }
    switch (btn.dataset.act) {
        case 'propose': call(K.propose); break;
        case 'back': st.view = 'list'; render(kind); break;
        case 'approve': call(K.approve, st.sel); break;
        case 'edit': call(K.edit, st.sel); break;
        case 'up': call(K.move, st.sel, 'up'); break;
        case 'down': call(K.move, st.sel, 'down'); break;
        case 'delete': call(K.del, st.sel); break;
    }
});
document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains('dz-q')) return;
    const kind = t.closest('.dz-root').dataset.kind;
    S[kind].q = t.value;
    render(kind);
});

// Redraw whenever the old list redraws (load, realtime, save, approve, reorder).
Object.keys(KINDS).forEach(kind => window.onHook(kind + '-designer-rendered', 'designers-v2', () => render(kind)));
document.addEventListener('darkforest:features-changed', () => Object.keys(KINDS).forEach(render));
})();
