/* ==========================================================================
   js/battle-mobile.js - Battle Map on phones
   ==========================================================================
   Keeps the page scrollable during a battle on a phone (the maps otherwise
   swallow every swipe). Four parts, all DM-chosen:
   1. Compact header: the command-bar buttons become ONE swipeable row; the
      rarely used ones (LOG, MAPS, terrain chip + gear, DECK PLANS, END
      BATTLE) fold behind a "⋯" button. The map also moves above the
      DEPLOY / COMMS panels.
   2. Scroll strip: a narrow strip down the right edge of the map where a
      swipe always scrolls the page.
   3. Map lock (🔒 button on the map, starts LOCKED on phones, remembered
      per device): while locked, one-finger swipes on the map scroll the page;
      taps still select / target ships and two fingers still zoom the 3D map.
      Unlocked = normal map behaviour (drag ships, orbit, pan). MEASURE and
      SELECT need drags, so the lock is ignored while one of them is on.
   4. Fit to screen: the map's height is the screen height minus the ship
      card at the bottom, instead of a fixed 600 px / 50vh.
   Phones = viewport ≤ 768 px wide (the app's existing breakpoint). Nothing
   changes on desktop. Hooks: js/battle-3d.js onDown/onMove,
   js/battle-movement.js token touchstart, js/grid-tools.js group drag all ask
   window.battleMapTouchLocked(). */
(function () {
const LOCK_KEY = 'darkforest_battle_lock';
const PHONE_MQ = '(max-width: 768px)';
let moreOpen = false;

window.battleIsPhone = function () {
    try { return !!(window.matchMedia && window.matchMedia(PHONE_MQ).matches); } catch (e) { return false; }
};
function lockPref() {
    try { const v = localStorage.getItem(LOCK_KEY); return v === null ? true : v === '1'; } catch (e) { return true; }
}
let locked = lockPref();
function gridToolOn() {
    const gt = window.__gridTools;
    return !!(gt && (gt.tool === 'measure' || gt.tool === 'select'));
}
// True when a touch on the map should scroll the page instead of moving it.
window.battleMapTouchLocked = function () {
    return locked && window.battleIsPhone() && !gridToolOn();
};
window.setBattleMapLock = function (on) {
    locked = !!on;
    try { localStorage.setItem(LOCK_KEY, locked ? '1' : '0'); } catch (e) {}
    sync();
};
window.toggleBattleMapLock = function () { window.setBattleMapLock(!locked); };
window.toggleBattleHeaderMore = function () { moreOpen = !moreOpen; sync(); };

function ensureControls() {
    const stage = document.getElementById('battle-map-stage');
    if (stage && !document.getElementById('bmm-lock')) {
        const lock = document.createElement('button');
        lock.type = 'button';
        lock.id = 'bmm-lock';
        lock.className = 'bmm-lock';
        lock.onclick = (e) => { e.stopPropagation(); window.toggleBattleMapLock(); };
        stage.appendChild(lock);
        const strip = document.createElement('div');
        strip.id = 'bmm-strip';
        strip.className = 'bmm-strip';
        strip.setAttribute('aria-hidden', 'true');
        strip.title = 'Swipe here to scroll the page';
        stage.appendChild(strip);
    }
    const slot = document.getElementById('bmx-btn-slot');
    if (slot && !document.getElementById('bmm-more')) {
        const more = document.createElement('button');
        more.type = 'button';
        more.id = 'bmm-more';
        more.className = 'bmm-more';
        more.title = 'More battle buttons';
        more.textContent = '⋯';
        more.onclick = () => window.toggleBattleHeaderMore();
        slot.parentNode.insertBefore(more, slot.nextSibling);
    }
}
function fitHeight() {
    const hud = document.getElementById('tv2-hud');
    // The ship card is a fixed sheet over the bottom of the screen (offsetParent
    // is null for fixed elements, so measure it directly). Capped at 30% of
    // the screen so opening the card doesn't shrink the map to nothing.
    const hudH = hud && getComputedStyle(hud).position === 'fixed' && getComputedStyle(hud).display !== 'none' ? hud.getBoundingClientRect().height : 0;
    const vh = window.innerHeight || 700;
    return Math.max(260, Math.round(vh - Math.min(hudH, vh * 0.3) - 12));
}
function sync() {
    const panel = document.getElementById('battle-map-panel');
    if (!panel) return;
    const phone = window.battleIsPhone();
    panel.classList.toggle('bmm', phone);
    if (!phone) { panel.classList.remove('bmm-locked', 'bmm-more-open'); panel.style.removeProperty('--bmm-map-h'); return; }
    ensureControls();
    const lockOn = window.battleMapTouchLocked();
    panel.classList.toggle('bmm-locked', lockOn);
    panel.classList.toggle('bmm-more-open', moreOpen);
    panel.style.setProperty('--bmm-map-h', fitHeight() + 'px');
    const lock = document.getElementById('bmm-lock');
    if (lock) {
        lock.textContent = locked ? (gridToolOn() ? '🔓 TOOL' : '🔒 MAP LOCKED') : '🔓 MAP FREE';
        lock.title = locked ? 'Swipes scroll the page (taps still pick ships). Tap to unlock and drag on the map.' : 'Swipes move the map and ships. Tap to lock so swipes scroll the page.';
        lock.setAttribute('aria-pressed', locked ? 'true' : 'false');
    }
    const more = document.getElementById('bmm-more');
    if (more) more.setAttribute('aria-expanded', moreOpen ? 'true' : 'false');
}
window.battleMobileSync = sync;

// Run after every Battle Map render (battle-chrome may rebuild the bar).
window.onBattleMapRender('battle-mobile', sync, 90);
window.onHook('grid-tools-changed', 'battle-mobile', sync); // MEASURE / SELECT lift the lock
window.addEventListener('resize', () => { try { sync(); } catch (e) {} });
document.addEventListener('darkforest:features-changed', () => { try { sync(); } catch (e) {} });
})();
