/* ==========================================================================
   js/battle-tutorial.js - Battle Map tour for players (2026-10-08)
   ==========================================================================
   DM decisions: same spotlight tour as the main tutorial (js/tutorial.js
   machinery: startTutorial({ steps, seenKey, onEnd })); runs by itself ONCE
   per device the first time a player opens the Battle Map while a battle is
   running, and anytime from the "? TUTORIAL" button in the Battle Map header
   (behind ⋯ on phones); full tour; only available while a battle is running.

   Read-only like the main tour: it only selects the player's own ship on the
   ship card and opens/closes the card's weapons sheet so it can point at
   things. It never moves, fires or saves anything. Wording is drafted from
   how the code works for the DM to review -- edit BATTLE_TUTORIAL_STEPS only.
   ========================================================================== */
(function () {
const SEEN_KEY = 'darkforest_battle_tutorial_seen_v1';
const PHONE = () => typeof window.battleIsPhone === 'function' ? window.battleIsPhone() : (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
const state = { openedSheet: false, openedMore: false, autoTried: false };

function battleActive() {
    const enc = window.globalBattleEncounterCache;
    const panel = document.getElementById('battle-map-panel');
    return !!(enc && enc.is_active !== false && panel && panel.style.display === 'block');
}
function mapEl() {
    const v3 = document.getElementById('battle-3d-view');
    if (v3 && typeof window.battle3dActive === 'function' && window.battle3dActive()) return v3;
    return document.getElementById('battle-map-grid-wrap');
}
// Show the player's own ship on the ship card (UI only).
function selectMyShip() {
    if (typeof window.tv2Select !== 'function' || typeof globalShipMarkersCache === 'undefined') return;
    const enc = window.globalBattleEncounterCache;
    const toks = (enc && enc.tokens) || [];
    const mine = toks.map(t => globalShipMarkersCache.find(m => m.id === t.ship_marker_id))
        .find(v => v && !v.is_strike_craft && window.vesselHasOwner(v, currentUserId));
    if (mine) window.tv2Select(mine.id);
}
function setSheet(open) {
    const TV = window.__tv2;
    if (!TV || typeof window.tv2Render !== 'function') return;
    if (open && !TV.sheetOpen) { TV.sheetOpen = true; state.openedSheet = true; window.tv2Render(); }
    if (!open && state.openedSheet) { TV.sheetOpen = false; state.openedSheet = false; window.tv2Render(); }
}
function setMore(open) {
    const panel = document.getElementById('battle-map-panel');
    if (!panel || !PHONE() || typeof window.toggleBattleHeaderMore !== 'function') return;
    const isOpen = panel.classList.contains('bmm-more-open');
    if (open && !isOpen) { window.toggleBattleHeaderMore(); state.openedMore = true; }
    if (!open && isOpen && state.openedMore) { window.toggleBattleHeaderMore(); state.openedMore = false; }
}
function hudSection(label) {
    const hud = document.getElementById('tv2-hud');
    if (!hud) return null;
    return Array.from(hud.querySelectorAll('.tv2-sec')).find(s => (s.textContent || '').toUpperCase().includes(label)) || null;
}

const BATTLE_TUTORIAL_STEPS = [
    {
        title: 'Battle stations',
        body: 'This tour walks you through the Battle Map. It takes about three minutes. Use NEXT and BACK, or SKIP to close it. You can run it again anytime with <b>? TUTORIAL</b> in the Battle Map header while a battle is running.',
        mobileBody: 'This tour walks you through the Battle Map. It takes about three minutes. Use NEXT and BACK, or SKIP to close it. You can run it again anytime: tap <b>⋯</b> in the Battle Map header, then <b>? TUTORIAL</b>.'
    },
    {
        title: 'The command bar',
        target: '#bmx-bar',
        before: () => { setMore(false); setSheet(false); },
        body: 'The battle\'s name and round are at the top, with the buttons for this battle beside them. <b>CLOSE</b> takes you back to the galaxy map; the battle keeps running.',
        mobileBody: 'The battle\'s name and round are at the top. Swipe the row of buttons sideways to see them all; <b>⋯</b> shows the rest. <b>✕</b> takes you back to the galaxy map; the battle keeps running.'
    },
    {
        title: 'Turns and Action Points',
        target: '#battle-map-turn-bar',
        body: 'Once the Overseer rolls initiative, this bar shows whose turn it is. On your turn your ship gets <b>AP</b> (Action Points): every shot costs 1 AP. Moving doesn\'t cost AP. Press <b>END TURN</b> to pass to the next unit. Ships marked <b>AI</b> and squadrons on an AI stance act on their own at the end of each round. Before initiative is rolled, you can act freely.'
    },
    {
        title: 'Placing your ship',
        target: () => document.getElementById('bmx-deploy') || document.getElementById('battle-map-palette'),
        body: 'Ships that aren\'t on the grid yet are listed under <b>VESSELS</b>. Press <b>+ PLACE</b> on yours, then click the grid where you want it.',
        mobileBody: 'Ships that aren\'t on the grid yet are listed under <b>VESSELS</b>. Tap <b>+ PLACE</b> on yours, then tap the grid where you want it.'
    },
    {
        title: 'Fleet roster',
        target: '#tv2-roster',
        body: 'Every ship you can see on the grid, with its hull bar and, during a turn, its AP. Click a row to show that ship on the card. Hidden enemy ships don\'t appear until they reveal themselves, for example by firing.',
        mobileBody: 'Every ship you can see on the grid. Tap a chip to show that ship on the card. Hidden enemy ships don\'t appear until they reveal themselves, for example by firing.'
    },
    {
        title: 'Objective',
        target: '#tv2-objective',
        body: 'What the Overseer wants you to achieve in this battle.'
    },
    {
        title: 'Moving',
        target: mapEl,
        before: () => selectMyShip(),
        body: '<b>Drag</b> your ship to move it. Each round it can move as far as its allowance (<b>MOVE</b> on the ship card) and the allowance refills next round. If initiative is rolled, you can only move on your turn. With <b>terrain rules</b> on, asteroid fields cost double movement and give cover, planets and stations block movement and shots, debris damages ships that cross it, and nebulae hide ships from more than 100 away.',
        mobileBody: 'While the map shows <b>🔒 MAP LOCKED</b>, swiping scrolls the page. Tap it for <b>🔓 MAP FREE</b>, then <b>drag</b> your ship to move it. Each round it can move as far as its allowance (<b>MOVE</b> on the ship card), refilled next round. If initiative is rolled, you can only move on your turn. With <b>terrain rules</b> on, asteroids cost double movement and give cover, planets and stations block movement and shots, and debris damages ships that cross it.'
    },
    {
        title: 'Your ship card',
        target: '#tv2-hud',
        before: () => { selectMyShip(); setSheet(false); },
        body: 'The selected ship\'s status. Damage hits <b>shields</b> first, then <b>armor</b>, then <b>hull</b>. Armor is split into four sides: a shot hits the side facing the attacker, so turn your strongest side toward the enemy. <b>FULL SHEET</b> opens the ship\'s whole Vessel Deck and <b>WITHDRAW</b> takes the ship off the grid.'
    },
    {
        title: 'Turning and firing arcs',
        target: '#tv2-hud',
        body: 'The <b>🧭</b> number is your heading. <b>⟲ ⟳</b> on the card turn the ship 15° at a time (on your turn, once initiative is rolled). Many weapons only fire within their arc. Hover over or focus a weapon to see its range ring and arc on the map.',
        mobileBody: 'The <b>🧭</b> number is your heading. <b>⟲ ⟳</b> on the card turn the ship 15° at a time (on your turn, once initiative is rolled). Many weapons only fire within their arc, so turn to bring your guns to bear.'
    },
    {
        title: 'Weapons and firing',
        target: () => document.querySelector('#tv2-hud .tv2-weapons') || document.getElementById('tv2-hud'),
        before: () => { selectMyShip(); if (PHONE()) setSheet(true); },
        body: 'Pick a target for a weapon, set how many volleys, and press <b>FIRE</b>. Clicking a hostile ship on the map targets it with all your weapons at once. Targets that are out of range, blocked by a planet or hidden in a nebula are greyed out. Missiles and torpedoes use <b>LAUNCH</b> and arrive 3 rounds later. Watch each weapon\'s ammo and cooldown.',
        mobileBody: '<b>WEAPONS ▸</b> on the card opens this list. Pick a target, set the volleys and tap <b>FIRE</b>. Tapping a hostile ship on the map targets it with all your weapons at once. Out-of-range or blocked targets are greyed out. Missiles and torpedoes use <b>LAUNCH</b> and arrive 3 rounds later.'
    },
    {
        title: 'Ranges and MEASURE',
        target: '#battle-tools-bar',
        before: () => setSheet(false),
        body: 'Weapon ranges come in three bands: <b>SHORT 100</b>, <b>MEDIUM 200</b> and <b>LONG 400</b>. With <b>MEASURE</b> on, drag on the map to measure a distance, or click a ship to show its range rings. Press MEASURE again to turn it off.',
        mobileBody: 'Weapon ranges come in three bands: <b>SHORT 100</b>, <b>MEDIUM 200</b> and <b>LONG 400</b>. With <b>MEASURE</b> on, drag on the map to measure, or tap a ship to show its range rings. MEASURE works even while the map is locked.'
    },
    {
        title: 'SELECT and group moves',
        target: '#battle-tools-bar',
        body: 'With <b>SELECT</b> on, click your ships (or drag a box around them) to pick several. Then drag any one of them to move the whole group in formation. The group stops when the ship with the least movement left runs out.',
        mobileBody: 'With <b>SELECT</b> on, tap your ships (or drag a box) to pick several. Then drag any one of them to move the whole group in formation. The group stops when the ship with the least movement left runs out.'
    },
    {
        title: 'Incoming ordnance',
        target: '#battle-map-ordnance-list',
        body: 'Missiles and torpedoes in flight, with how many rounds until impact. <b>Point defense</b> fires on its own at anything aimed at your side, and squadrons set to <b>Intercept Munitions</b> help shoot them down.'
    },
    {
        title: 'Strike craft',
        target: () => hudSection('HANGAR') || document.getElementById('tv2-hud'),
        before: () => { selectMyShip(); if (PHONE()) setSheet(true); }, // phones: the hangar is inside the opened card
        body: 'A carrier\'s squadrons are listed on its card: <b>🚀 LAUNCH</b> puts one on the grid and <b>RECALL</b> brings it home. Squadrons launch on <b>🤖 Auto</b>: they choose for themselves whether to dogfight, attack ships or intercept missiles, and fight at the end of each round. You can set a fixed stance, or Manual to fly them yourself, in <b>FULL SHEET</b>. Their guns only reach 90, so they have to close in; their missiles reach 200.'
    },
    {
        title: 'Tactical stance',
        target: '#tv2-hud',
        before: () => setSheet(false),
        body: 'Each ship has a stance, set in <b>FULL SHEET</b>. <b>Aggressive</b>: deals 25% more damage but takes 25% more. <b>Defensive</b>: deals and takes 25% less. <b>Evasive</b>: takes half damage. <b>Balanced</b> is the default.'
    },
    {
        title: '2D and 3D views',
        target: '#battle-map-view-btn',
        body: 'This switches between the flat 2D grid and the 3D view. Both show the same battle. In 3D: drag empty space to orbit the camera, right-drag or Shift-drag to pan, and use the scroll wheel to zoom. The buttons along the bottom of the 3D view reset the camera, look straight down, change graphics quality and change your ship\'s altitude.',
        mobileBody: 'This switches between the flat 2D grid and the 3D view. Both show the same battle. In 3D (map unlocked): drag to orbit and pinch to zoom; two fingers also zoom while the map is locked. The buttons along the bottom of the 3D view reset the camera, look straight down and change graphics quality.'
    },
    {
        title: 'Swiping on a phone',
        only: 'mobile',
        target: '#bmm-strip',
        body: 'The dashed strip with <b>⇕</b> down the right edge of the map always scrolls the page, even when the map is unlocked. Your 🔒 / 🔓 choice is remembered on this phone.'
    },
    {
        title: 'Comms during battle',
        target: () => document.querySelector('#battle-map-panel .bmx-comms') || document.getElementById('bm-comms-dock-body'),
        body: 'Chat with the crew and see every dice roll without leaving the Battle Map.'
    },
    {
        title: 'You\'re cleared to engage',
        target: '#btut-btn',
        before: () => { setSheet(false); setMore(true); },
        body: 'That\'s the Battle Map. Press <b>? TUTORIAL</b> here anytime during a battle to see this again. Good hunting, Commander.',
        mobileBody: 'That\'s the Battle Map. Tap <b>⋯</b> then <b>? TUTORIAL</b> anytime during a battle to see this again. Good hunting, Commander.'
    }
];
window.BATTLE_TUTORIAL_STEPS = BATTLE_TUTORIAL_STEPS; // tests / DM wording review

window.startBattleTutorial = function () {
    if (!battleActive() || typeof window.startTutorial !== 'function') return false;
    if (typeof window.tutorialActive === 'function' && window.tutorialActive()) return false;
    state.openedSheet = false; state.openedMore = false;
    window.startTutorial({
        steps: BATTLE_TUTORIAL_STEPS, seenKey: SEEN_KEY,
        onEnd: () => { setSheet(false); setMore(false); }
    });
    return true;
};

// The "? TUTORIAL" button in the Battle Map header (shown only while a battle runs).
function ensureButton() {
    let btn = document.getElementById('btut-btn');
    if (!btn) {
        const anchor = document.getElementById('battle-map-end-btn');
        if (!anchor || !anchor.parentNode) return null;
        btn = document.createElement('button');
        btn.id = 'btut-btn';
        btn.type = 'button';
        btn.className = 'layer-edit';
        btn.title = 'Show the Battle Map tutorial';
        btn.style.cssText = 'font-size:9px; padding:3px 8px;';
        btn.textContent = '? TUTORIAL';
        btn.onclick = () => window.startBattleTutorial();
        anchor.parentNode.insertBefore(btn, anchor);
    }
    return btn;
}
function sync() {
    const btn = ensureButton();
    const active = battleActive();
    if (btn) btn.style.display = active ? 'inline-block' : 'none';
    // Players: run once per device the first time they open a running battle.
    if (!active || state.autoTried || (typeof currentUserRole !== 'undefined' && currentUserRole === 'dm')) return;
    let seen = false;
    try { seen = localStorage.getItem(SEEN_KEY) === 'true'; } catch (e) { seen = true; }
    if (seen) { state.autoTried = true; return; }
    state.autoTried = true;
    setTimeout(() => { if (battleActive()) window.startBattleTutorial(); }, 900);
}
window.battleTutorialSync = sync;
window.__battleTutorialState = state; // tests

const orig = window.renderBattleMapPanel;
if (typeof orig === 'function') {
    window.renderBattleMapPanel = function () {
        const r = orig.apply(this, arguments);
        try { sync(); } catch (e) { console.error('battle tutorial:', e); }
        return r;
    };
}
})();
