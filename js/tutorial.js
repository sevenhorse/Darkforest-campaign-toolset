/* ==========================================================================
   PLAYER TUTORIAL — guided spotlight tour (2026-09-24)

   DM-confirmed design:
   - Style: a spotlight tour. The screen dims, the real button/panel being
     explained is outlined, and a small card explains it (Back / Next / Skip).
   - Trigger: runs automatically ONCE per device (browser/phone) the first
     time a non-DM player logs in, and anytime from the "? TUTORIAL" button
     in the top bar (inside the ☰ menu on phones).
   - Audience: players only (no DM tools). The DM can still run it to preview.
   - Text: drafted by Claude from how the code actually works, for the DM to
     review and correct -- all wording lives in TUTORIAL_STEPS below, so
     editing a step never requires touching the tour machinery.

   Read-only by design: the tour only opens/closes panels and tabs so it can
   point at them. It never clicks buttons, saves anything, or touches the
   database. Whatever the tour opened is closed again when it ends, and
   panels the player already had open are left open.

   "Seen" flag: localStorage key TUTORIAL_SEEN_KEY. Deliberately NOT
   prefixed "odyssey_" -- RESET UI wipes odyssey_* keys, and resetting panel
   positions shouldn't replay the whole tour.
   ========================================================================== */

const TUTORIAL_SEEN_KEY = 'darkforest_tutorial_seen_v1';

// Each step: { title, body, mobileBody?, target?, before? }
//   target  -- CSS selector (or function returning an element) to spotlight.
//              Missing/hidden target => the card shows centered, no spotlight.
//   before  -- optional function run before the step is shown (open a tab,
//              panel, etc.). Must be UI-only -- never save or send anything.
//   mobileBody -- replaces body on phone-width screens (touch wording).
const TUTORIAL_STEPS = [
    {
        title: 'Welcome aboard, Commander',
        body: 'This quick tour shows you the main controls of the Intrepid Horizon mainframe. It takes about two minutes. Use NEXT and BACK to move through it, or SKIP to close it. You can replay it anytime with the <b>? TUTORIAL</b> button in the top bar.',
        mobileBody: 'This quick tour shows you the main controls of the Intrepid Horizon mainframe. It takes about two minutes. Use NEXT and BACK to move through it, or SKIP to close it. You can replay it anytime from the <b>? TUTORIAL</b> button in the ☰ menu (top right).'
    },
    {
        title: 'The galaxy map (DRADIS)',
        target: '#canvas-container',
        body: '<b>Drag</b> to pan and use the <b>scroll wheel</b> to zoom. <b>Click</b> a star, planet or ship to select it. You can drag your own ship to reposition it. Zoom in close on a scanned system to see its planets orbiting.',
        mobileBody: '<b>Drag one finger</b> to pan and <b>pinch</b> to zoom. <b>Tap</b> a star, planet or ship to select it. To move your own ship, <b>press and hold</b> on it for half a second, then drag. Zoom in close on a scanned system to see its planets orbiting.'
    },
    {
        title: 'Telemetry panel',
        target: '#hud-overlay',
        body: 'Whatever you select shows up here: class, ownership, hazards and actions. <b>Bookmarks</b> saves places you care about and <b>Recents</b> lists what you looked at last. The <b>🚀 JUMP</b> button snaps the camera to your own vessel.',
        mobileBody: 'Whatever you select shows up here, inside the ☰ menu. A small red dot on the ☰ button means you selected something new. <b>Bookmarks</b> saves places you care about and <b>Recents</b> lists what you looked at last. The <b>🚀 JUMP</b> button snaps the camera to your own vessel.'
    },
    {
        title: 'Sensor range and DRADIS scans',
        target: '#hud-overlay',
        body: 'Space you can\'t see is dark. Faint dots are <b>unknown contacts</b> outside sensor range, which reaches 300 units around your ships and friendly ships. A system in range shows its name and an <b>EXECUTE DRADIS SCAN</b> button. A scan costs time on the shared clock (2 hours plus 1 per orbital body) and reveals the planets, their resources and who controls the system. Scan results are announced on comms.'
    },
    {
        title: 'Plotting a jump',
        target: '#hud-overlay',
        body: 'Select your ship and press <b>🌌 PLOT JUMP VECTOR</b>, then click a star or any point in space. The plotter shows the distance, the fuel cost (1 <b>Energy Core</b> per 100 units; sublight is free) and the <b>chronometer drift</b>. FTL jumps move the shared clock <i>backward</i>, so you arrive before you left. Press <b>🚀 EXECUTE JUMP</b> to go.',
        mobileBody: 'Select your ship and press <b>🌌 PLOT JUMP VECTOR</b>, then tap a star or any point in space. The plotter shows the distance, the fuel cost (1 <b>Energy Core</b> per 100 units; sublight is free) and the <b>chronometer drift</b>. FTL jumps move the shared clock <i>backward</i>, so you arrive before you left. Press <b>🚀 EXECUTE JUMP</b> to go.'
    },
    {
        title: 'Search',
        target: '#global-terminal-search',
        body: 'Type part of a system or ship name to find it fast. Picking a result selects it and moves the camera there.'
    },
    {
        title: 'Map tools',
        target: '#ping-tool-toggle-btn',
        body: '<b>MEASURE</b>: click two points to see the distance. <b>PING</b>: click the map to drop a marker every crew member sees (you can also <b>Shift+click</b>). <b>ROUTES</b>: shows or hides the trade routes you\'ve discovered. <b>RADAR</b>: toggles the sweep effect.',
        mobileBody: '<b>MEASURE</b>: tap two points to see the distance. <b>PING</b>: tap the map to drop a marker every crew member sees. <b>ROUTES</b>: shows or hides the trade routes you\'ve discovered. <b>RADAR</b>: toggles the sweep effect.'
    },
    {
        title: 'The campaign clock',
        target: '#universe-clock-display',
        body: 'One clock is shared by the whole crew and run by the Overseer (DM). Scans, jumps and builds all move it. Each new day your ships eat rations from cargo, and each ship\'s Elder E-M Synthesizer recharges.'
    },
    {
        title: 'Your Dossier',
        target: '#term-tab-btn-stats',
        before: () => tutorialOpenTerminalTab('stats'),
        body: 'The <b>DOSSIER</b> button opens your character terminal. Fill in your character sheet here: stats, skills, injuries, stress and shield. Save it once before you add perks, augments, gear or weapons, because those attach to your saved character.'
    },
    {
        title: 'Arsenal and dice',
        target: '#term-tab-btn-combat',
        before: () => tutorialOpenTerminalTab('combat'),
        body: 'Add your personal weapons and powers here. <b>ROLL</b> rolls damage, and <b>⚔</b> resolves a full attack against someone in the initiative tracker. The <b>dice roller</b> lets you tick stats and skills (plus Advantage) and roll them together. Your perks, augments and gear are added automatically, and every roll is posted to the <b>Dice Streamer</b> for the whole crew.'
    },
    {
        title: 'Cargo',
        target: '#term-tab-btn-cargo',
        before: () => tutorialOpenTerminalTab('cargo'),
        body: 'Pick one of your ships to see its hold: Perishables, Expendables and Misc. Rations are eaten daily, <b>Energy Cores</b> are jump fuel and <b>Hull Plates</b> repair hull damage. The <b>Synthesizer</b> converts up to 10 tons a day into whatever you name.'
    },
    {
        title: 'Vessel Deck',
        target: '#term-tab-btn-vessel',
        before: () => tutorialOpenTerminalTab('vessel'),
        body: 'Your ship\'s full status. <b>Shields, armor and hull</b> are shown in the order they take damage. <b>Tactical stance</b> trades damage for defense. Weapons have a <b>FIRE</b> button with a target and volley size. Decks can be damaged and knock out their weapons. The <b>Hangar Bay</b> tab launches and recalls strike-craft squadrons.'
    },
    {
        title: 'Colonies and Manufacturing',
        target: '#term-tab-btn-colonies',
        before: () => tutorialOpenTerminalTab('colonies'),
        body: 'Colonies produce resources every day into their own storage. Use <b>PICK UP</b> to load them onto one of your ships. The <b>Manufacturing</b> tab builds items from blueprints. Builds take time on the campaign clock and the result is delivered to the ship you chose.'
    },
    {
        title: 'Codex and Intel',
        target: '#term-tab-btn-codex',
        before: () => tutorialOpenTerminalTab('codex'),
        body: 'The <b>Cloud Codex</b> holds lore on factions, places and history. Some entries unlock only after you scan the right system. <b>Intel & Ops</b> is your notebook, and each note can be private or shared with the crew. <b>RETURN TO MAP</b> closes this terminal.'
    },
    {
        title: 'Comms',
        // Spotlight the tab row (not the whole panel) so on phones -- where
        // the Comms panel fills the screen -- the card docks below the tabs
        // instead of covering them.
        target: () => { const bar = document.getElementById('comms-tabs-bar'); return bar ? bar.parentElement : null; },
        before: () => { tutorialCloseTerminal(); tutorialShowPanel('comms-array-panel'); },
        body: '<b>General</b> is crew-wide chat and the <b>🎲 Dice Streamer</b> is every roll. Use <b>+ New DM…</b> to start a private conversation. A tab lights up when something new arrives there.'
    },
    {
        title: 'Combat and the Battle Map',
        target: () => tutorialFindButton('#bottom-toggle-bar', 'BATTLE MAP'),
        before: () => tutorialHidePanel('comms-array-panel'),
        body: 'When the Overseer starts an engagement, open <b>BATTLE MAP</b>. Use <b>+ PLACE</b> on your ship, then click the grid to put it there. <b>Drag</b> your token to move it; each ship has a movement allowance per round. Fire from your ship\'s card. If initiative has been rolled, you act on <b>your turn</b>: each action costs 1 <b>AP</b> (Action Point), and <b>END TURN</b> passes to the next unit. <b>COMBAT</b> opens the initiative tracker for personal fights.',
        mobileBody: 'When the Overseer starts an engagement, open <b>BATTLE MAP</b>. Use <b>+ PLACE</b> on your ship, then tap the grid to put it there. <b>Drag</b> your token with a finger to move it; each ship has a movement allowance per round. Fire from your ship\'s card. If initiative has been rolled, you act on <b>your turn</b>: each action costs 1 <b>AP</b> (Action Point), and <b>END TURN</b> passes to the next unit. <b>COMBAT</b> opens the initiative tracker for personal fights.'
    },
    {
        title: 'Salvage',
        target: () => tutorialFindButton('#bottom-toggle-bar', 'SALVAGE'),
        body: 'Destroyed ships can leave wreckage behind. Open <b>SALVAGE</b>, choose one of your ships within 300 units of it, and press <b>GATHER</b>. The salvage lands in that ship\'s cargo when the time is up.'
    },
    {
        title: 'You\'re cleared for launch',
        target: '#tutorial-btn',
        body: 'That\'s the tour. Press <b>? TUTORIAL</b> anytime to see it again. If a panel ever gets lost off-screen, <b>RESET UI</b> in the bottom bar puts everything back. Good hunting, Commander.',
        mobileBody: 'That\'s the tour. <b>? TUTORIAL</b> in the ☰ menu replays it anytime. If a panel ever gets stuck, <b>RESET UI</b> in the menu puts everything back. Good hunting, Commander.'
    }
];

// ---- small UI helpers used by steps (UI-only, never save anything) ----
function tutorialIsMobile() { return window.matchMedia && window.matchMedia('(max-width: 768px)').matches; }
function tutorialFindButton(containerSel, label) {
    const c = document.querySelector(containerSel);
    if (!c) return null;
    return Array.from(c.querySelectorAll('button')).find(b => (b.textContent || '').trim().toUpperCase() === label) || null;
}
function tutorialOpenTerminalTab(tab) {
    const term = document.getElementById('character-terminal');
    if (term && term.style.display !== 'block') { tutorialState.opened.add('terminal'); term.style.display = 'block'; }
    if (typeof window.switchTermTab === 'function') window.switchTermTab(tab);
}
function tutorialCloseTerminal() {
    const term = document.getElementById('character-terminal');
    if (term && tutorialState.opened.has('terminal')) { term.style.display = 'none'; tutorialState.opened.delete('terminal'); }
}
function tutorialShowPanel(id) {
    const p = document.getElementById(id);
    if (p && p.style.display !== 'block') { tutorialState.opened.add(id); p.style.display = 'block'; }
    if (id === 'comms-array-panel' && typeof window.populateCommsRecipients === 'function') window.populateCommsRecipients();
}
function tutorialHidePanel(id) {
    const p = document.getElementById(id);
    if (p && tutorialState.opened.has(id)) { p.style.display = 'none'; tutorialState.opened.delete(id); }
}

// ---- tour machinery ----
const tutorialState = { active: false, index: 0, opened: new Set(), els: null, prevTermTab: null };

function tutorialEnsureEls() {
    if (tutorialState.els) return tutorialState.els;
    const blocker = document.createElement('div');
    blocker.id = 'tutorial-blocker';
    const spot = document.createElement('div');
    spot.id = 'tutorial-spotlight';
    const card = document.createElement('div');
    card.id = 'tutorial-card';
    card.className = 'panel';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-live', 'polite');
    card.innerHTML = `
        <div id="tutorial-card-count"></div>
        <h4 id="tutorial-card-title"></h4>
        <div id="tutorial-card-body"></div>
        <div id="tutorial-card-actions">
            <button id="tutorial-skip-btn" type="button">SKIP</button>
            <button id="tutorial-back-btn" type="button">◀ BACK</button>
            <button id="tutorial-next-btn" type="button" class="btn-deploy">NEXT ▶</button>
        </div>`;
    document.body.appendChild(blocker);
    document.body.appendChild(spot);
    document.body.appendChild(card);
    card.querySelector('#tutorial-skip-btn').addEventListener('click', () => window.endTutorial());
    card.querySelector('#tutorial-back-btn').addEventListener('click', () => tutorialGo(tutorialState.index - 1));
    card.querySelector('#tutorial-next-btn').addEventListener('click', () => {
        if (tutorialState.index >= TUTORIAL_STEPS.length - 1) window.endTutorial();
        else tutorialGo(tutorialState.index + 1);
    });
    // The blocker swallows clicks so nothing underneath fires mid-tour.
    blocker.addEventListener('click', (e) => e.stopPropagation());
    tutorialState.els = { blocker, spot, card };
    return tutorialState.els;
}

function tutorialResolveTarget(step) {
    if (!step.target) return null;
    let el = null;
    try { el = typeof step.target === 'function' ? step.target() : document.querySelector(step.target); } catch (e) { el = null; }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null; // hidden (display:none etc.)
    return el;
}

function tutorialPlace() {
    if (!tutorialState.active) return;
    const { spot, card } = tutorialEnsureEls();
    const step = TUTORIAL_STEPS[tutorialState.index];
    const el = tutorialResolveTarget(step);
    const vw = window.innerWidth, vh = window.innerHeight;
    const mobile = tutorialIsMobile();

    card.style.left = card.style.top = card.style.bottom = card.style.right = '';
    if (!el) {
        spot.style.display = 'none';
        tutorialState.els.blocker.classList.add('tutorial-dim');
        card.classList.add('tutorial-card-center');
        return;
    }
    tutorialState.els.blocker.classList.remove('tutorial-dim');
    card.classList.remove('tutorial-card-center');
    const r = el.getBoundingClientRect();
    const pad = 6;
    // Clamp the spotlight to the viewport (the galaxy canvas is full-screen).
    const left = Math.max(4, r.left - pad), top = Math.max(4, r.top - pad);
    const right = Math.min(vw - 4, r.right + pad), bottom = Math.min(vh - 4, r.bottom + pad);
    Object.assign(spot.style, { display: 'block', left: left + 'px', top: top + 'px', width: Math.max(0, right - left) + 'px', height: Math.max(0, bottom - top) + 'px' });

    if (mobile) {
        // Phones: dock the card to whichever screen half the target isn't in.
        const targetMid = (top + bottom) / 2;
        if (targetMid > vh / 2) { card.style.top = '10px'; } else { card.style.bottom = '10px'; }
        card.style.left = '10px'; card.style.right = '10px';
        return;
    }
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 12;
    let cx = Math.min(Math.max(10, left), vw - cw - 10);
    let cy;
    if (bottom + gap + ch <= vh - 10) cy = bottom + gap;                 // below
    else if (top - gap - ch >= 10) cy = top - gap - ch;                   // above
    else if (right + gap + cw <= vw - 10) { cx = right + gap; cy = Math.min(Math.max(10, top), vh - ch - 10); }  // right
    else if (left - gap - cw >= 10) { cx = left - gap - cw; cy = Math.min(Math.max(10, top), vh - ch - 10); }    // left
    else { cy = vh - ch - 10; }                                           // big target: pin to bottom
    card.style.left = cx + 'px'; card.style.top = cy + 'px';
}

function tutorialGo(i) {
    if (i < 0 || i >= TUTORIAL_STEPS.length) return;
    tutorialState.index = i;
    const step = TUTORIAL_STEPS[i];
    try { if (step.before) step.before(); } catch (e) { console.error('Tutorial step setup failed (continuing):', e); }

    // Phones: things in the top/bottom bars and the telemetry panel live in
    // the ☰ drawer -- open it when the target is inside, close it otherwise.
    const drawer = document.getElementById('mobile-nav-drawer');
    if (tutorialIsMobile() && drawer && typeof window.toggleMobileNav === 'function') {
        let el = null;
        try { el = typeof step.target === 'function' ? step.target() : (step.target ? document.querySelector(step.target) : null); } catch (e) {}
        const inDrawer = !!(el && drawer.contains(el));
        window.toggleMobileNav(inDrawer);
        if (inDrawer) { tutorialState.opened.add('drawer'); try { el.scrollIntoView({ block: 'center' }); } catch (e) {} }
    }

    const { card } = tutorialEnsureEls();
    card.querySelector('#tutorial-card-count').textContent = `STEP ${i + 1} / ${TUTORIAL_STEPS.length}`;
    card.querySelector('#tutorial-card-title').textContent = step.title;
    card.querySelector('#tutorial-card-body').innerHTML = (tutorialIsMobile() && step.mobileBody) ? step.mobileBody : step.body;
    card.querySelector('#tutorial-back-btn').disabled = i === 0;
    card.querySelector('#tutorial-next-btn').textContent = i === TUTORIAL_STEPS.length - 1 ? 'FINISH ✓' : 'NEXT ▶';
    // Let any panel/tab the step just opened lay out (and the drawer slide in) before measuring.
    tutorialPlace();
    setTimeout(tutorialPlace, 60);
    setTimeout(tutorialPlace, 260);
}

function tutorialOnKey(e) {
    if (!tutorialState.active) return;
    if (e.key === 'Escape') { e.preventDefault(); window.endTutorial(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (tutorialState.index < TUTORIAL_STEPS.length - 1) tutorialGo(tutorialState.index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); tutorialGo(tutorialState.index - 1); }
}
function tutorialOnResize() { if (tutorialState.active) tutorialPlace(); }

window.startTutorial = function() {
    if (tutorialState.active) return;
    const els = tutorialEnsureEls();
    const activeTab = document.querySelector('.term-tab-btn-vert.active');
    tutorialState.prevTermTab = activeTab ? activeTab.id.replace('term-tab-btn-', '') : null;
    tutorialState.opened = new Set();
    tutorialState.active = true;
    els.blocker.style.display = 'block';
    els.card.style.display = 'block';
    document.addEventListener('keydown', tutorialOnKey);
    window.addEventListener('resize', tutorialOnResize);
    tutorialGo(0);
};

window.endTutorial = function() {
    if (!tutorialState.active) return;
    tutorialState.active = false;
    try { localStorage.setItem(TUTORIAL_SEEN_KEY, 'true'); } catch (e) {}
    const { blocker, spot, card } = tutorialEnsureEls();
    blocker.style.display = 'none'; spot.style.display = 'none'; card.style.display = 'none';
    document.removeEventListener('keydown', tutorialOnKey);
    window.removeEventListener('resize', tutorialOnResize);
    // Put the screen back the way the player had it.
    if (tutorialState.opened.has('terminal')) {
        const term = document.getElementById('character-terminal'); if (term) term.style.display = 'none';
    } else if (tutorialState.prevTermTab && typeof window.switchTermTab === 'function') {
        window.switchTermTab(tutorialState.prevTermTab);
    }
    tutorialState.opened.forEach(id => { if (id !== 'terminal' && id !== 'drawer') { const p = document.getElementById(id); if (p) p.style.display = 'none'; } });
    if (tutorialState.opened.has('drawer') && typeof window.toggleMobileNav === 'function') window.toggleMobileNav(false);
    tutorialState.opened = new Set();
};

// Called from js/db.js once login finishes. Players only, once per device.
window.maybeAutoStartTutorial = function() {
    if (typeof currentUserRole !== 'undefined' && currentUserRole === 'dm') return;
    let seen = false;
    try { seen = localStorage.getItem(TUTORIAL_SEEN_KEY) === 'true'; } catch (e) { seen = true; } // storage blocked: don't nag every load
    if (seen) return;
    setTimeout(() => { if (!tutorialState.active) window.startTutorial(); }, 1500);
};
