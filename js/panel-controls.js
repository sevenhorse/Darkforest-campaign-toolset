/* ==========================================================================
   js/panel-controls.js - Uniform panel controls (QoL, 2026-10-25)
   ==========================================================================
   DM request: the DM Operations panel, the Telemetry panel and the scene box
   (the reopen button that shows while a scene is live) should all be
   movable, collapsible and hideable, the same way.
   DM decisions (2026-10-25): the whole DM Operations panel; hidden panels
   come back from the account menu (top right, PANELS section); hiding the
   scene box only lasts for that scene (a new live scene shows it again).
   Feature switch 'panel_controls'. PC only: on phones these panels live in
   the menu drawer / bottom of the screen and nothing changes there.

   Every panel's header gets — (collapse to the header) and ✕ (hide). Moving
   is the existing header drag (ui.js makePanelDraggable; the scene box got
   one in js/scene-maps.js). State is per browser in localStorage
   (odyssey_pc_<key>), so RESET UI clears it along with panel positions.
   Hiding uses a class (.pc-hidden, display:none !important) rather than
   style.display, so code that shows a panel (e.g. login showing DM tools)
   doesn't fight it. */
(function () {
const $ = (id) => document.getElementById(id);
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
const isPhone = () => (window.innerWidth || 1200) <= 768;
function liveSceneId() { const s = window.__scene; const l = s && Array.isArray(s.list) ? s.list.find(x => x.is_active) : null; return l ? l.id : null; }

const PANELS = {
    telemetry: { id: 'hud-overlay', head: 'hud-overlay-header', label: 'TELEMETRY', who: () => true },
    dmtools: { id: 'dm-tools', head: 'dm-tools-header', label: 'DM TOOLS', who: isDm },
    scenebox: { id: 'scv-box', head: 'scv-box-head', label: 'SCENE BOX', who: () => !!liveSceneId(), perScene: true }
};
const KEYS = Object.keys(PANELS);
window.panelControlsKeys = KEYS;

window.panelControlsOn = function () {
    return typeof window.isFeatureOn === 'function' && window.isFeatureOn('panel_controls') && !isPhone();
};
// Hiding needs a way back, and the way back is the account menu (galaxy_chrome).
const canHide = () => !!$('gc-acct-menu') && document.body.classList.contains('gc-on');

function load(key) {
    try { const v = JSON.parse(window.safeLocalGet('odyssey_pc_' + key, 'null')); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
}
function save(key, st) { window.safeLocalSet('odyssey_pc_' + key, JSON.stringify(st)); }
function isHidden(key, st) {
    if (!st.h) return false;
    if (PANELS[key].perScene) return st.h === liveSceneId();
    return true;
}
window.panelIsHidden = (key) => isHidden(key, load(key));
window.panelIsCollapsed = (key) => !!load(key).c;

function decorate(key) {
    const P = PANELS[key], panel = $(P.id), head = $(P.head);
    if (!panel || !head) return;
    panel.classList.add('pc-panel');
    head.classList.add('pc-head');
    let ctl = head.querySelector('.pc-ctl');
    if (!ctl) {
        ctl = document.createElement('div');
        ctl.className = 'pc-ctl';
        ctl.innerHTML = `<button type="button" class="pc-btn pc-min" aria-label="Collapse ${P.label.toLowerCase()}"></button><button type="button" class="pc-btn pc-x" aria-label="Hide ${P.label.toLowerCase()}" title="Hide (bring it back from the account menu, top right)">✕</button>`;
        ctl.querySelector('.pc-min').onclick = (e) => { e.stopPropagation(); window.panelToggleCollapse(key); };
        ctl.querySelector('.pc-x').onclick = (e) => { e.stopPropagation(); window.panelSetHidden(key, true); };
        head.appendChild(ctl);
        // Picking a tab on a collapsed panel opens it again.
        head.addEventListener('click', (e) => { if (e.target.closest('.hud-tab-btn') && load(key).c) window.panelToggleCollapse(key, false); });
    }
}
function apply(key) {
    const P = PANELS[key], panel = $(P.id);
    if (!panel) return;
    decorate(key);
    const st = load(key), on = window.panelControlsOn();
    panel.classList.toggle('pc-collapsed', on && !!st.c);
    panel.classList.toggle('pc-hidden', on && canHide() && isHidden(key, st));
    const min = panel.querySelector('.pc-min');
    if (min) { min.textContent = st.c ? '+' : '–'; min.title = st.c ? 'Expand' : 'Collapse to the header'; min.setAttribute('aria-expanded', String(!st.c)); }
    const x = panel.querySelector('.pc-x'); if (x) x.style.display = canHide() ? '' : 'none';
}
function applyAll() {
    document.body.classList.toggle('pc-on', window.panelControlsOn());
    KEYS.forEach(apply);
    renderMenu();
}
window.panelControlsApply = applyAll;
window.panelControlsRegister = (key) => { if (PANELS[key]) apply(key); };

window.panelToggleCollapse = function (key, force) {
    const st = load(key);
    st.c = typeof force === 'boolean' ? force : !st.c;
    save(key, st); apply(key);
};
window.panelSetHidden = function (key, hide) {
    const st = load(key);
    st.h = hide ? (PANELS[key].perScene ? liveSceneId() : true) : false;
    save(key, st); apply(key); renderMenu();
    if (hide && typeof window.showToast === 'function') window.showToast(`${PANELS[key].label} hidden. Bring it back from the account menu (top right) → PANELS.`, 'info');
};

/* --- Account menu: PANELS section --- */
function renderMenu() {
    const menu = $('gc-acct-menu');
    let box = $('pc-menu');
    if (!menu || !window.panelControlsOn() || !canHide()) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.id = 'pc-menu'; box.className = 'pc-menu'; menu.insertBefore(box, menu.querySelector('button[onclick^="window.handleLogout"]')); }
    const rows = KEYS.filter(k => PANELS[k].who() && $(PANELS[k].id)).map(k => {
        const hid = isHidden(k, load(k));
        return `<button type="button" class="pc-menu-btn${hid ? '' : ' on'}" data-panel="${k}" onclick="window.panelSetHidden('${k}', ${!hid})"><span>${PANELS[k].label}</span><b>${hid ? 'HIDDEN · SHOW' : 'SHOWN'}</b></button>`;
    }).join('');
    box.innerHTML = rows ? `<div class="pc-menu-ttl">PANELS</div>${rows}` : '';
}
// Refresh the section as the menu opens (galaxy-chrome toggles it on this click).
document.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('#gc-acct-btn')) renderMenu(); }, true);

document.addEventListener('darkforest:features-changed', applyAll);
window.addEventListener('resize', () => { if (document.body.classList.contains('pc-on') !== window.panelControlsOn()) applyAll(); });
// Login (DM tools appear), a new live scene (per-scene hide), galaxy chrome on/off. Cheap.
setInterval(() => {
    const on = window.panelControlsOn();
    if (document.body.classList.contains('pc-on') !== on) { applyAll(); return; }
    if (on) apply('scenebox');
}, 1000);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyAll); else applyAll();
})();
