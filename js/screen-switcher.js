/* ==========================================================================
   js/screen-switcher.js - Screen switcher + Codex quick look (QoL, 2026-10-25)
   ==========================================================================
   DM decisions (2026-10-25):
   - A: a tab strip along the top of the screen on every view
     (MAP / TERMINAL / CODEX / BATTLE / SCENE / BRIDGE). Clicking a tab hides
     the current full-screen view and shows the other one; nothing is closed
     or reloaded. A dot marks a live battle / live scene. The ` key flips
     back to the previous view.
   - B: a Codex quick look: a drawer on the right, over any view, with search,
     categories and the reading pane (~ key or the strip button).
   - Desktop only, for everyone (phones keep their menu). Codex look.
   - Feature switch 'screen_switcher'.

   How it works:
   - The strip takes a 30 px band at the top; body.ss-on moves the app and
     every full-screen view down by --ss-h (style.css), so nothing is covered.
   - Only one full-screen view is shown at a time: when one opens (from the
     strip or from any other button), the others are hidden. Before this the
     Command Terminal and the Battle Map shared z-index 100, so opening the
     Codex during a battle opened it invisibly underneath the Battle Map.
   - Sub-tools that sit on top of a view (Battle Map editor, Encounter
     Stager, Deck Plan editor, Deck View) are parked while you are on another
     view and come back when you return to the view they were opened on.
   - Each view's own close button still closes it (back to the map). */
(function () {
const esc = (v) => window.escapeHtml(v == null ? '' : String(v));
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
const isPhone = () => (window.innerWidth || 1200) <= 768;
const $ = (id) => document.getElementById(id);
const shown = (el) => !!el && el.style.display === 'block';
const svg = (p) => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${p}</svg>`;

const D = window.__cxd = { open: false, cat: 'all', q: '', sel: null, charts: [] }; // B. Codex quick look
const SS = window.__ss = { on: false, cur: 'map', prev: null, snap: null, switching: false, lastTermTab: 'stats', parked: [] };

function appVisible() { const a = $('app-container'); return !!a && a.style.display !== 'none' && a.style.display !== ''; }
window.screenSwitcherOn = function () {
    return typeof window.isFeatureOn === 'function' && window.isFeatureOn('screen_switcher') && !isPhone() && appVisible();
};
// Height of the strip band in px (0 when it is off); for code that sizes from window.innerHeight.
window.ssBandPx = function () { return SS.on ? 30 : 0; };

/* --- Which view is showing --- */
const SCREENS = [
    { key: 'map', label: 'MAP', icon: '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3"></circle><path d="M12 3v3M12 18v3M3 12h3M18 12h3"></path>' },
    { key: 'terminal', label: 'TERMINAL', icon: '<rect x="3" y="4" width="18" height="14"></rect><path d="M7 9l3 2-3 2M12 14h5"></path>' },
    { key: 'codex', label: 'CODEX', icon: '<path d="M5 4h10l4 4v12H5z"></path><path d="M8 11h8M8 15h6"></path>' },
    { key: 'battle', label: 'BATTLE', icon: '<path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"></path>' },
    { key: 'scene', label: 'SCENE', icon: '<rect x="3" y="5" width="18" height="14"></rect><circle cx="9" cy="11" r="2"></circle><circle cx="15" cy="13" r="2"></circle>' },
    { key: 'bridge', label: 'BRIDGE', icon: '<path d="M3 17l3-8h12l3 8z"></path><path d="M8 9V6h8v3"></path>' }
];
function codexTabActive() { const p = $('term-panel-codex'); return !!p && p.classList.contains('active'); }
function visibleNow() {
    return {
        bridge: document.body.classList.contains('bw-open'),
        scene: shown($('scene-view')),
        battle: shown($('battle-map-panel')),
        terminal: shown($('character-terminal'))
    };
}
// Front-most view (same order as their z-index).
function currentOf(v) {
    if (v.bridge) return 'bridge';
    if (v.scene) return 'scene';
    if (v.battle) return 'battle';
    if (v.terminal) return codexTabActive() ? 'codex' : 'terminal';
    return 'map';
}
window.ssCurrentScreen = () => currentOf(visibleNow());
const baseOf = (k) => (k === 'codex' ? 'terminal' : k);
function liveScene() { const s = window.__scene; return s && Array.isArray(s.list) ? s.list.find(x => x.is_active) || null : null; }
function liveBattle() { return typeof window.globalBattleEncounterCache !== 'undefined' && window.globalBattleEncounterCache ? window.globalBattleEncounterCache : null; }
function available(k) {
    if (k === 'scene') return isDm() ? !!(window.sceneMapsAllowed && window.sceneMapsAllowed()) : !!liveScene();
    if (k === 'bridge') return !!(window.bridgeAvailable && window.bridgeAvailable() && window.bridgeUserOn && window.bridgeUserOn());
    return true;
}
window.ssAvailableScreens = () => SCREENS.map(s => s.key).filter(available);

/* --- Hiding / showing --- */
function hideView(k) {
    if (k === 'terminal') { const t = $('character-terminal'); if (shown(t)) t.style.display = 'none'; }
    else if (k === 'battle') { const p = $('battle-map-panel'); if (shown(p)) p.style.display = 'none'; }
    else if (k === 'scene') { if (shown($('scene-view')) && window.closeSceneView) window.closeSceneView(); }
    else if (k === 'bridge') { if (document.body.classList.contains('bw-open') && window.closeBridge) window.closeBridge(); }
}
function closeReader() { if (shown($('codex-fullscreen-reader')) && window.closeCodexFullscreen) window.closeCodexFullscreen(); }

// Sub-tools that sit on top of a view. Parked = hidden while you're elsewhere, back when you return.
const SUBS = ['battle-map-editor', 'encounter-stager', 'deck-plan-editor'];
function parkSubs(from) {
    SUBS.forEach(id => {
        const el = $(id);
        if (el && el.style.display && el.style.display !== 'none') { SS.parked.push({ id, from, display: el.style.display }); el.style.display = 'none'; }
    });
    if (window.closeDeckView && shown($('deck-view'))) { SS.parked.push({ id: 'deck-view', from }); window.closeDeckView(); }
}
function unparkSubs(to) {
    const keep = [];
    SS.parked.forEach(p => {
        if (p.from !== to) { keep.push(p); return; }
        if (p.id === 'deck-view') { if (window.openDeckView) window.openDeckView(); return; }
        const el = $(p.id); if (el) el.style.display = p.display;
    });
    SS.parked = keep;
}

window.ssShow = function (k) {
    if (!available(k)) return;
    const from = window.ssCurrentScreen();
    if (from === k) return;
    SS.switching = true;
    try {
        closeReader();
        if (baseOf(from) !== baseOf(k)) parkSubs(baseOf(from));
        ['bridge', 'scene', 'battle', 'terminal'].forEach(v => { if (v !== baseOf(k)) hideView(v); });
        if (k === 'terminal' || k === 'codex') {
            $('character-terminal').style.display = 'block';
            if (k === 'codex' && !codexTabActive()) window.switchTermTab('codex');
            else if (k === 'terminal' && codexTabActive()) window.switchTermTab(SS.lastTermTab || 'stats');
            else if (k === 'codex') window.switchCodexCategory(window.activeCodexCategory || 'factions');
        } else if (k === 'battle') {
            if (!shown($('battle-map-panel'))) window.toggleBattleMap();
        } else if (k === 'scene') {
            window.openSceneView();
        } else if (k === 'bridge') {
            window.openBridge();
        }
        if (typeof window.broadcastActivity === 'function') {
            const labels = { map: 'Monitoring DRADIS', codex: 'Reading the Codex', battle: 'On the Battle Map', scene: 'In a scene', bridge: 'On the bridge' };
            if (k === 'terminal') { const tab = SS.lastTermTab; window.broadcastActivity((window.TERM_TAB_ACTIVITY_LABELS || {})[tab] || 'Reviewing Command Terminal'); }
            else window.broadcastActivity(labels[k]);
        }
    } finally { SS.switching = false; }
    if (k !== 'map') unparkSubs(baseOf(k));
    observe();
};
window.ssFlipBack = function () {
    if (!SS.on || !SS.prev || SS.prev === SS.cur || !available(SS.prev)) return false;
    window.ssShow(SS.prev);
    return true;
};

/* --- Keep one view at a time, however it was opened --- */
function observe() {
    if (!SS.on) return;
    const v = visibleNow();
    const old = SS.snap || v;
    SS.snap = v;
    const opened = Object.keys(v).filter(k => v[k] && !old[k]);
    if (opened.length && !SS.switching) {
        // The newest view wins; everything that was already up gets hidden.
        const winner = ['bridge', 'scene', 'battle', 'terminal'].find(k => opened.includes(k));
        const others = Object.keys(v).filter(k => k !== winner && v[k]);
        if (others.length) {
            SS.switching = true;
            try {
                closeReader();
                const fromKey = currentOf(old);
                parkSubs(baseOf(fromKey));
                others.forEach(hideView);
            } finally { SS.switching = false; }
            SS.snap = visibleNow();
        }
        unparkSubs(winner);
    }
    const cur = currentOf(SS.snap);
    if (cur !== SS.cur) { SS.prev = SS.cur; SS.cur = cur; }
    renderStrip();
}
let mo = null, watched = null;
// scene-view and bridge-walk are created on first use, so new body children get picked up too.
function attach() {
    ['character-terminal', 'battle-map-panel', 'scene-view'].forEach(id => {
        const el = $(id);
        if (el && !watched.has(el)) { watched.add(el); mo.observe(el, { attributes: true, attributeFilter: ['style', 'class'] }); }
    });
}
function watch() {
    if (mo) return;
    watched = new WeakSet();
    mo = new MutationObserver(() => { attach(); observe(); });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true });
    attach();
}

/* --- The strip --- */
function ensureStrip() {
    let s = $('ss-strip');
    if (s) return s;
    s = document.createElement('div');
    s.id = 'ss-strip';
    s.innerHTML = `<span class="ss-brand">VIEWS</span><div class="ss-tabs" role="tablist" aria-label="Views" id="ss-tabs"></div>
        <div class="ss-right"><button type="button" class="ss-peek" id="ss-peek" title="Codex quick look over this view (~)" onclick="window.toggleCodexDrawer()">${svg('<path d="M5 4h10l4 4v12H5z"></path><path d="M8 11h8M8 15h6"></path>')}<span>QUICK CODEX</span></button>
        <span class="ss-hint" title="Keyboard: \` flips back to the previous view, ~ opens the Codex quick look"><kbd>\`</kbd> LAST VIEW <kbd>~</kbd> QUICK LOOK</span></div>`;
    document.body.appendChild(s);
    return s;
}
function renderStrip() {
    const s = $('ss-strip');
    if (!SS.on) { if (s) s.style.display = 'none'; return; }
    ensureStrip().style.display = '';
    const battle = liveBattle(), scene = liveScene();
    const html = SCREENS.filter(x => available(x.key)).map(x => {
        const on = x.key === SS.cur;
        let dot = '', title = x.label;
        if (x.key === 'battle' && battle) { dot = '<i class="ss-dot ss-dot-red"></i>'; title = `Battle live: ${battle.name || 'engagement'}${battle.round_number ? ' (round ' + battle.round_number + ')' : ''}`; }
        if (x.key === 'scene' && scene) { dot = '<i class="ss-dot"></i>'; title = `Scene live: ${scene.name || ''}`; }
        if (x.key === SS.prev && !on) title += ' (` flips back here)';
        return `<button type="button" role="tab" aria-selected="${on}" class="ss-tab${on ? ' on' : ''}" data-screen="${x.key}" title="${esc(title)}" onclick="window.ssShow('${x.key}')">${svg(x.icon)}<span>${x.label}</span>${dot}</button>`;
    }).join('');
    const tabs = $('ss-tabs');
    if (tabs.__html !== html) { tabs.innerHTML = html; tabs.__html = html; }
    const peek = $('ss-peek'); if (peek) peek.classList.toggle('on', !!D.open);
}

/* --- On / off --- */
function apply() {
    const on = window.screenSwitcherOn();
    if (on !== SS.on) {
        SS.on = on;
        document.body.classList.toggle('ss-on', on);
        if (on) { watch(); SS.snap = null; SS.cur = window.ssCurrentScreen(); SS.prev = null; observe(); }
        else { if (mo) { mo.disconnect(); mo = null; } if (D.open) window.toggleCodexDrawer(false); }
        // Canvases size from their container; tell them the band changed.
        window.dispatchEvent(new Event('resize'));
    }
    renderStrip();
}
window.ssApply = apply;
document.addEventListener('darkforest:features-changed', apply);
window.addEventListener('resize', () => { if (window.screenSwitcherOn() !== SS.on) apply(); });
if (typeof window.onHook === 'function') {
    window.onHook('term-tab-switched', 'screen-switcher', (tab) => { if (tab && tab !== 'codex') SS.lastTermTab = tab; if (SS.on) observe(); });
    if (typeof window.onBattleMapRender === 'function') window.onBattleMapRender('screen-switcher', () => { if (SS.on) renderStrip(); }, 90);
}
// Slow tick: login/logout, live dots. Cheap: a few checks, and the strip only redraws when it changed.
setInterval(() => { apply(); if (SS.on) observe(); }, 1000);

document.addEventListener('keydown', (e) => {
    if (!SS.on || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, tag = (t && t.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (t && t.isContentEditable)) return;
    if (e.key === '`') { if (window.ssFlipBack()) e.preventDefault(); }
    else if (e.key === '~') { e.preventDefault(); window.toggleCodexDrawer(); }
    else if (e.key === 'Escape' && D.open) { e.preventDefault(); e.stopImmediatePropagation(); window.toggleCodexDrawer(false); }
}, true);

/* ==========================================================================
   B. Codex quick look (drawer)
   ========================================================================== */
function api() { return window.codexV2Api || null; }
function ensureDrawer() {
    let d = $('cxd-drawer');
    if (d) return d;
    d = document.createElement('aside');
    d.id = 'cxd-drawer';
    d.setAttribute('aria-label', 'Codex quick look');
    d.innerHTML = `<div class="cxd-head"><div><span class="cxd-kicker">CODEX // QUICK LOOK</span><span class="cxd-sub">reads over any view</span></div>
            <span class="cxd-grow"></span><button type="button" class="cxd-x" aria-label="Close the quick look" onclick="window.toggleCodexDrawer(false)">✕</button></div>
        <label class="cxd-search"><span class="cxd-sr">Search the Codex</span>${svg('<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>')}
            <input type="text" id="cxd-q" placeholder="Search names, tags and text" autocomplete="off"></label>
        <div class="cxd-cats" id="cxd-cats"></div>
        <div class="cxd-body" id="cxd-body"></div>`;
    document.body.appendChild(d);
    const q = d.querySelector('#cxd-q');
    q.addEventListener('input', () => { D.q = q.value.toLowerCase().trim(); D.sel = null; renderDrawer(); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); window.toggleCodexDrawer(false); } });
    return d;
}
function destroyCharts() { (D.charts || []).forEach(c => { try { c.destroy(); } catch (e) {} }); D.charts = []; }
function matches(e) {
    if (!D.q) return true;
    return [e.title, e.subtitle, e.content].some(t => t && String(t).toLowerCase().includes(D.q));
}
function entries() {
    const A = api(); if (!A) return [];
    const cats = A.cats().map(c => c.key);
    return (typeof globalCodexEntriesCache !== 'undefined' ? globalCodexEntriesCache : [])
        .filter(e => cats.includes(e.category) && A.visible(e) && (D.cat === 'all' || e.category === D.cat) && matches(e))
        .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
}
window.cxdEntries = () => entries().map(e => e.id); // tests
function renderDrawer() {
    const d = $('cxd-drawer'); if (!d || !D.open) return;
    const A = api();
    destroyCharts();
    if (!A) { $('cxd-body').innerHTML = '<div class="cxd-empty">The Codex isn\'t loaded yet.</div>'; return; }
    const cats = A.cats();
    if (D.cat !== 'all' && !cats.some(c => c.key === D.cat)) D.cat = 'all';
    $('cxd-cats').innerHTML = [{ key: 'all', tab: 'ALL' }].concat(cats).map(c =>
        `<button type="button" class="cxd-cat${D.cat === c.key ? ' on' : ''}" onclick="window.cxdCat('${c.key}')">${esc(c.tab)}</button>`).join('');
    const list = entries();
    const body = $('cxd-body');
    const e = D.sel ? (typeof globalCodexEntriesCache !== 'undefined' ? globalCodexEntriesCache : []).find(x => x.id === D.sel && A.visible(x)) : null;
    if (!e) {
        D.sel = null;
        const catName = (k) => { const c = cats.find(x => x.key === k); return c ? c.tab : ''; };
        body.innerHTML = list.length ? `<div class="cxd-rows">${list.map(x => {
            const tag = A.cleanTag(x), kind = window.codexTagKind(tag);
            return `<button type="button" class="cxd-row" onclick="window.cxdOpen('${x.id}')">
                <span class="cxd-av">${esc(A.initials(x.title))}</span>
                <span class="cxd-rowtxt"><span class="cxd-rowtitle">${esc(x.title || 'Untitled')}</span>
                <span class="cxd-rowmeta">${tag ? `<span class="cx2-chip cx2-k-${kind}">${esc(tag.toUpperCase())}</span>` : ''}${D.cat === 'all' ? `<span class="cxd-dim">${esc(catName(x.category))}</span>` : ''}${isDm() && x.is_hidden ? '<span class="cx2-chip cx2-k-hostile">HIDDEN</span>' : ''}</span></span>
            </button>`;
        }).join('')}</div>` : `<div class="cxd-empty">${D.q ? 'Nothing matches your search.' : 'No entries here.'}</div>`;
        return;
    }
    const tag = A.cleanTag(e), kind = window.codexTagKind(tag);
    const cat = cats.find(c => c.key === e.category);
    const b = A.body(e.content || 'No narrative content recorded.', 'cxd-chart');
    const img = window.codexDisplayImageRef ? window.codexDisplayImageRef(e) : null;
    body.innerHTML = `<div class="cxd-back-row"><button type="button" class="cxd-back" onclick="window.cxdBack()">‹ BACK TO LIST</button>
            <button type="button" class="cxd-open" onclick="window.cxdOpenInCodex('${e.id}')" title="Open this entry in the Codex tab">OPEN IN CODEX ›</button></div>
        <div class="cxd-read">
            ${img ? `<img class="cxd-img" data-media-ref="${esc(img)}" alt="${esc(e.title || '')}" title="Click to enlarge" onclick="window.openImageLightbox(this.getAttribute('data-media-ref'), this.getAttribute('alt'))">` : ''}
            <div class="cx2-kicker">${esc(b.kicker ? b.kicker.toUpperCase() : (cat ? cat.title : ''))}</div>
            <h2 class="cxd-title">${esc(e.title || 'Untitled')}</h2>
            <div class="cx2-chips">${tag ? `<span class="cx2-chip cx2-k-${kind}">${esc(tag.toUpperCase())}</span>` : ''}${cat ? `<span class="cx2-chip cx2-k-cat">${esc(cat.tab)}</span>` : ''}${isDm() && e.is_hidden ? '<span class="cx2-chip cx2-k-hostile">HIDDEN FROM PLAYERS</span>' : ''}</div>
            <div class="cx2-text cxd-text">${b.html}</div>
        </div>`;
    if (window.drawCodexCharts) window.drawCodexCharts(b.charts, D.charts);
}
window.cxdCat = function (k) { D.cat = k; D.sel = null; renderDrawer(); };
window.cxdOpen = function (id) { D.sel = id; renderDrawer(); const b = $('cxd-body'); if (b) b.scrollTop = 0; };
window.cxdBack = function () { D.sel = null; renderDrawer(); };
window.cxdOpenInCodex = function (id) {
    window.toggleCodexDrawer(false);
    if (SS.on) window.ssShow('codex');
    if (window.codexOpenEntry) window.codexOpenEntry(id);
};
window.toggleCodexDrawer = function (force) {
    const open = typeof force === 'boolean' ? force : !D.open;
    if (open && !SS.on) return;
    D.open = open;
    const d = ensureDrawer();
    d.classList.toggle('open', open);
    document.body.classList.toggle('cxd-open', open);
    if (open) { renderDrawer(); setTimeout(() => { const q = $('cxd-q'); if (q) q.focus(); }, 0); }
    else destroyCharts();
    renderStrip();
};
// The Codex reloads (realtime, saves): refresh the quick look too. Runs before codex-v2 takes over the draw.
if (typeof window.onHook === 'function') window.onHook('codex-render', 'codex-drawer', () => { if (D.open) renderDrawer(); }, 10);

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
})();
