/* ==========================================================================
   js/galaxy-chrome.js - Galaxy map chrome restyle (UI restyle R5, switch
   'galaxy_chrome')
   ==========================================================================
   R5a top bar. DM decisions (2026-10-10, from the R5 mockup): grouped bar
   (brand · search · map tools · universe time · terminal · audio ·
   account menu); TUTORIAL, the role badge, link status and DISCONNECT fold
   into the account menu so the bar stops running off the right edge
   (it already did at 1500 px).

   Re-arranges, doesn't rewrite: the real buttons (with their ids and
   onclick handlers) move into the new groups and go back when the switch
   is off. On phones the whole #top-bar already moves into the ☰ drawer
   (ui.js setupMobileNavLayout); there the account menu shows open, inline.
   Tool on/off: map.js sets inline colours; this view reads the same state
   flags and marks the button '.on' (refreshed on 'tool-buttons-updated'
   and after any top-bar click). COMMS shows how many channels have unread
   messages (window.commsUnread), refreshed on 'comms-tabs-rendered'.
   ========================================================================== */
(function () {
const byId = (id) => document.getElementById(id);
const moved = []; // { node, parent, next }
window.galaxyChromeOn = function () { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('galaxy_chrome'); };

function borrow(node, slot) {
    if (!node || !slot || node.parentNode === slot) return;
    if (!moved.some(m => m.node === node)) moved.push({ node, parent: node.parentNode, next: node.nextSibling });
    slot.appendChild(node);
}
function giveBackAll() {
    // Back in reverse order so each "next sibling" is in place again first.
    for (let i = moved.length - 1; i >= 0; i--) {
        const m = moved[i];
        m.parent.insertBefore(m.node, m.next && m.next.parentNode === m.parent ? m.next : null);
    }
    moved.length = 0;
}
const btnByClick = (fn) => document.querySelector(`#top-bar button[onclick^="window.${fn}("], #gc-bar button[onclick^="window.${fn}("], #gc-acct-menu button[onclick^="window.${fn}("]`);

function ensureBar() {
    const top = byId('top-bar');
    if (!top) return null;
    let bar = byId('gc-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'gc-bar';
        bar.innerHTML = `<span class="gc-slot" id="gc-brand"></span><span class="gc-slot gc-search" id="gc-search"></span>
            <div class="gc-grp" id="gc-tools" role="group" aria-label="Map tools"></div>
            <span class="gc-grow"></span>
            <span class="gc-slot" id="gc-clock"></span>
            <div class="gc-grp" id="gc-term" role="group" aria-label="Terminal"></div>
            <span class="gc-slot" id="gc-audio"></span>
            <span class="gc-acct">
                <button type="button" id="gc-acct-btn" aria-haspopup="true" aria-expanded="false"><i class="gc-dot" aria-hidden="true"></i><span id="gc-acct-name">COMMANDER</span> ▾</button>
                <div id="gc-acct-menu" role="menu" aria-label="Account"></div>
            </span>`;
        top.appendChild(bar);
    }
    return bar;
}

function handle() {
    const me = (typeof allProfiles !== 'undefined' && typeof currentUserId !== 'undefined') ? allProfiles.find(p => p.id === currentUserId) : null;
    return String((me && me.username) || 'COMMANDER').toUpperCase();
}

function refreshTools() {
    if (!document.body.classList.contains('gc-on')) return;
    const flags = { 'measuring-tape-toggle-btn': window.measuringTapeActive, 'ping-tool-toggle-btn': window.pingModeActive, 'territory-tool-toggle-btn': window.territoryDrawActive,
        'hyperlane-toggle-btn': window.hyperlanesVisible, 'radar-sweep-toggle-btn': window.radarSweepActive };
    Object.keys(flags).forEach(id => { const b = byId(id); if (b) b.classList.toggle('gc-tool-on', !!flags[id]); });
    const n = byId('gc-acct-name'); if (n) n.textContent = handle();
    const sync = document.querySelector('#gc-acct-menu .sync-indicator');
    const dot = document.querySelector('#gc-acct-btn .gc-dot');
    if (dot) dot.classList.toggle('off', !!sync && !/LINKED|SYNC/i.test(sync.textContent || ''));
}
window.refreshGalaxyChrome = refreshTools;

// Unread channels (window.commsUnread, set by ui.js) as a count on COMMS.
function refreshComms() {
    const btn = btnByClick('toggleCommsArray');
    if (!btn) return;
    let b = btn.querySelector('.gc-count');
    const n = Object.keys(window.commsUnread || {}).filter(k => window.commsUnread[k]).length;
    if (!document.body.classList.contains('gc-on') || !n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('b'); b.className = 'gc-count'; btn.appendChild(b); }
    b.textContent = ' ' + n;
}

function apply() {
    const on = window.galaxyChromeOn();
    const top = byId('top-bar');
    if (!top) return;
    document.body.classList.toggle('gc-on', on);
    closeMenu();
    if (!on) { giveBackAll(); refreshComms(); return; }
    ensureBar();
    const h3 = top.querySelector('h3') || document.querySelector('#gc-brand h3');
    borrow(h3, byId('gc-brand'));
    const search = byId('global-terminal-search');
    borrow(search && search.parentNode && search.parentNode.id !== 'gc-search' ? search.parentNode : null, byId('gc-search'));
    ['measuring-tape-toggle-btn', 'ping-tool-toggle-btn', 'hyperlane-toggle-btn', 'territory-tool-toggle-btn', 'radar-sweep-toggle-btn'].forEach(id => borrow(byId(id), byId('gc-tools')));
    borrow(byId('universe-clock-display'), byId('gc-clock'));
    ['openFullDossierTerminal', 'openFullCargoTerminal', 'toggleCommsArray'].forEach(fn => borrow(btnByClick(fn), byId('gc-term')));
    borrow(byId('dm-scratchpad-toggle-btn'), byId('gc-term'));
    const audio = byId('audio-controls-toggle-btn');
    borrow(audio ? audio.parentNode : null, byId('gc-audio'));
    const menu = byId('gc-acct-menu');
    borrow(byId('user-role'), menu);
    borrow(document.querySelector('#top-bar .sync-indicator'), menu);
    borrow(byId('tutorial-btn'), menu);
    borrow(btnByClick('handleLogout'), menu);
    refreshTools();
    refreshComms();
}
window.applyGalaxyChrome = apply;

function closeMenu() {
    const m = byId('gc-acct-menu'), b = byId('gc-acct-btn');
    if (m) m.classList.remove('open');
    if (b) b.setAttribute('aria-expanded', 'false');
}
function toggleMenu() {
    const m = byId('gc-acct-menu'), b = byId('gc-acct-btn');
    if (!m || !b) return;
    const opening = !m.classList.contains('open');
    if (opening) {
        // #top-bar clips overflow, so the menu is position:fixed (same trick as the audio dropdown).
        const r = b.getBoundingClientRect();
        m.style.top = (r.bottom + 4) + 'px';
        m.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
        refreshTools();
    }
    m.classList.toggle('open', opening);
    b.setAttribute('aria-expanded', String(opening));
}
// The tutorial's "? TUTORIAL" step points at the account button while the
// button itself sits inside the closed menu.
window.galaxyChromeTarget = function (sel) {
    if (!document.body.classList.contains('gc-on')) return null;
    if (sel === '#tutorial-btn' && !document.querySelector('#mobile-nav-drawer-body #top-bar')) return byId('gc-acct-btn');
    return null;
};

document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#gc-acct-btn')) { toggleMenu(); return; }
    if (t && t.closest && t.closest('#gc-acct-menu button')) closeMenu();
    else if (!(t && t.closest && t.closest('#gc-acct-menu'))) closeMenu();
    if (t && t.closest && t.closest('#top-bar')) setTimeout(refreshTools, 0);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); setTimeout(refreshTools, 0); } });
window.addEventListener('resize', closeMenu);
window.onHook('tool-buttons-updated', 'galaxy-chrome', refreshTools);
window.onHook('comms-tabs-rendered', 'galaxy-chrome', refreshComms);
document.addEventListener('darkforest:features-changed', apply);
// The role badge is filled in after sign-in; keep the handle in step.
const role = byId('user-role');
if (role && typeof MutationObserver === 'function') new MutationObserver(refreshTools).observe(role, { childList: true, characterData: true, subtree: true });
apply();
})();
