/* ==========================================================================
   js/battle-fx.js - Battle Map visual effects: ordnance flight overlay, weapon fire / impact / destruction effects, range ring, target highlight, click-enemy-to-target-all.
   Classic script sharing the global scope: loads right after battle-map.js
   (see index.html for the order).
   ========================================================================== */
/* --- ORDNANCE FLIGHT VISUALIZATION ---
   Driven by the battle_encounters realtime sync: every client re-renders when
   in_flight_ordnance changes, so all viewers see the same synced state.
   One marker per payload entry (salvo_id): 1 before a split, 6 after.
   turns_remaining (3 -> 2 -> 1 -> resolved) sets a per-round progress
   fraction along the source->target line; nothing animates between rounds.
   A salvo_id that disappears has impacted, been shot down by Point Defense,
   or fizzled. The data doesn't say which, so every disappearance gets the
   same impact flash. */
function renderOrdnanceOverlay(grid, tokens, inFlight) {
    const currentIds = new Set();
    inFlight.forEach(entry => {
        const salvoId = entry.salvo_id;
        currentIds.add(salvoId);
        const sourceTok = tokens.find(t => t.ship_marker_id === entry.source_vessel_id);
        const targetTok = tokens.find(t => t.ship_marker_id === entry.target_vessel_id);
        // Source or target isn't a token on this grid: leave any existing
        // marker where it was; the removal pass cleans it up once the entry
        // resolves.
        if (!sourceTok || !targetTok) return;

        const progress = Math.max(0, Math.min(1, (3 - (entry.turns_remaining !== undefined ? entry.turns_remaining : 3)) / 3));
        const half = BATTLE_TOKEN_SIZE / 2;
        const sx = sourceTok.x + half, sy = sourceTok.y + half;
        const tx = targetTok.x + half, ty = targetTok.y + half;
        let px = sx + (tx - sx) * progress;
        let py = sy + (ty - sy) * progress;

        // Split payloads (shared parent_salvo_id) fan out perpendicular to
        // the flight line so they don't stack on top of each other.
        if (entry.split) {
            const groupKey = entry.parent_salvo_id || entry.salvo_id;
            const siblings = inFlight.filter(e => (e.parent_salvo_id || e.salvo_id) === groupKey);
            const idxInGroup = siblings.findIndex(e => e.salvo_id === salvoId);
            const spread = (idxInGroup - (siblings.length - 1) / 2) * 6;
            const dx = tx - sx, dy = ty - sy;
            const len = Math.hypot(dx, dy) || 1;
            px += (-dy / len) * spread;
            py += (dx / len) * spread;
        }

        let el = battleMapOrdnanceEls[salvoId];
        if (!el) {
            el = document.createElement('div');
            el.className = 'battle-ordnance-marker';
            // Colored by the salvo's damage type, computed once at creation.
            // Stashed on the element so the impact flash can match it.
            const dmgType = (typeof window.normalizeDamageType === 'function') ? window.normalizeDamageType(entry.damage_type || 'Impact') : 'Impact';
            const dmgColor = (window.DAMAGE_TYPES && window.DAMAGE_TYPES[dmgType] && window.DAMAGE_TYPES[dmgType].color) || '#c778dd';
            el.style.background = dmgColor;
            el.style.boxShadow = `0 0 6px ${dmgColor}`;
            el.dataset.dmgColor = dmgColor;
            grid.appendChild(el);
            battleMapOrdnanceEls[salvoId] = el;
        }
        el.title = `${entry.source_weapon_name || 'Ordnance'} — ${entry.source_vessel_name} → ${entry.target_vessel_name} (impact in ${entry.turns_remaining} round${entry.turns_remaining === 1 ? '' : 's'})`;
        el.style.left = (px - 4) + 'px';
        el.style.top = (py - 4) + 'px';
    });

    battleMapPrevOrdnanceIds.forEach(id => {
        if (!currentIds.has(id) && battleMapOrdnanceEls[id]) {
            const el = battleMapOrdnanceEls[id];
            spawnImpactFlash(grid, (parseFloat(el.style.left) || 0) + 4, (parseFloat(el.style.top) || 0) + 4, el.dataset.dmgColor);
            el.remove();
            delete battleMapOrdnanceEls[id];
        }
    });
    battleMapPrevOrdnanceIds = currentIds;
}

// Converts a 6-digit hex color plus a 0-1 alpha into #RRGGBBAA, for building
// radial-gradient flashes. Falls back to white for non-hex input.
function hexWithAlpha(hex, alpha) {
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
    return (hex && hex[0] === '#' ? hex : '#ffffff') + a;
}

// colorHex is optional; without it the .battle-impact-flash CSS default
// (orange/red) is used.
function spawnImpactFlash(grid, x, y, colorHex) {
    const flash = document.createElement('div');
    flash.className = 'battle-impact-flash';
    flash.style.left = x + 'px';
    flash.style.top = y + 'px';
    if (colorHex) {
        flash.style.background = `radial-gradient(circle, ${hexWithAlpha(colorHex, 0.9)}, ${hexWithAlpha(colorHex, 0)} 70%)`;
    }
    grid.appendChild(flash);
    setTimeout(() => flash.remove(), 650);
}

/* --- DIRECT-FIRE WEAPON SHOT VISUAL ---
   Called from js/combat.js (rollShipWeapon / rollSquadronWeapon) after a hit
   resolves. The shot's damage type maps to an effect family via
   window.DAMAGE_TYPE_FAMILY: beam, tracer, burst or pulse (healing); the
   renderer's fireEffect picks the spawn*Effect function below.
   Also sent over the battle broadcast channel so other open Battle Maps play
   it; fromRemote marks a received effect, which is never re-sent.
   Silently no-ops if there's no active battle, either vessel isn't a token,
   or the grid isn't open, so it is safe to call after every shot. */
window.playWeaponFireEffect = function(sourceVesselId, targetVesselId, colorHex, dmgType, fromRemote) {
    if (!window.globalBattleEncounterCache) return;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const sourceTok = tokens.find(t => t.ship_marker_id === sourceVesselId);
    const targetTok = tokens.find(t => t.ship_marker_id === targetVesselId);
    if (!sourceTok || !targetTok) return;
    // Broadcast even if this client's map isn't open (e.g. firing from the
    // Vessel Deck).
    if (!fromRemote && typeof window.sendBattleBroadcast === 'function') {
        window.sendBattleBroadcast('fx', { k: 'fire', src: sourceVesselId, dst: targetVesselId, col: colorHex || null, dmg: dmgType || null });
    }
    const grid = document.getElementById('battle-map-grid');
    if (!grid) return;

    const half = BATTLE_TOKEN_SIZE / 2;
    const sx = sourceTok.x + half, sy = sourceTok.y + half;
    const tx = targetTok.x + half, ty = targetTok.y + half;
    const color = colorHex || '#ff3333';

    // Unknown or missing dmgType falls back to the beam family.
    const family = (dmgType && window.DAMAGE_TYPE_FAMILY && window.DAMAGE_TYPE_FAMILY[dmgType]) || 'beam';
    window.battleRenderer.fireEffect(sx, sy, tx, ty, color, family);
    if (family !== 'pulse') playBattleImpactSound(targetVesselId);
};

/* Impact sound shortly after a shot lands: shield shimmer if the target still
   has shields up, otherwise a hull thud. Runs after damage is applied, so the
   shield read is current. Throttled (150 ms) so a large volley doesn't stack
   into noise. */
let lastBattleImpactSoundAt = 0;
function playBattleImpactSound(targetVesselId) {
    const ae = window.AudioEngine;
    if (!ae || !ae.playShieldHit) return;
    const now = Date.now();
    if (now - lastBattleImpactSoundAt < 150) return;
    lastBattleImpactSoundAt = now;
    const target = globalShipMarkersCache.find(m => m.id === targetVesselId);
    const shieldsUp = !!(target && (target.integrity_shields || 0) > 0);
    setTimeout(() => { try { shieldsUp ? ae.playShieldHit() : ae.playHullHit(); } catch (e) {} }, 180);
}

// Beam family (Energy, Ion, Exotic, Antimatter, Heat; see
// window.DAMAGE_TYPE_FAMILY) and the default: a steady glowing line from
// firer to target that fades out.
function spawnBeamEffect(grid, sx, sy, tx, ty, colorHex) {
    const dx = tx - sx, dy = ty - sy;
    const length = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    const beam = document.createElement('div');
    beam.className = 'battle-fire-beam';
    beam.style.left = sx + 'px';
    beam.style.top = sy + 'px';
    beam.style.width = length + 'px';
    beam.style.background = colorHex;
    beam.style.boxShadow = `0 0 6px ${colorHex}`;
    beam.style.transform = `rotate(${angle}deg)`;
    grid.appendChild(beam);
    setTimeout(() => beam.remove(), 400);
}

// Tracer family (Impact, Piercing, Cold): a glowing dot that travels from
// source to target via the CSS left/top transition on .battle-fire-tracer,
// then leaves a color-matched impact flash.
// `void tracer.offsetWidth` forces a layout flush between the two position
// writes; without it the browser may coalesce them and skip the travel.
function spawnTracerEffect(grid, sx, sy, tx, ty, colorHex) {
    const tracer = document.createElement('div');
    tracer.className = 'battle-fire-tracer';
    tracer.style.left = sx + 'px';
    tracer.style.top = sy + 'px';
    tracer.style.background = colorHex;
    tracer.style.boxShadow = `0 0 8px 2px ${colorHex}`;
    grid.appendChild(tracer);
    void tracer.offsetWidth;
    tracer.style.left = tx + 'px';
    tracer.style.top = ty + 'px';
    setTimeout(() => {
        tracer.remove();
        spawnImpactFlash(grid, tx, ty, colorHex);
    }, 300);
}

// Burst family (Explosive, Flak, Corrosive): an area detonation at the target
// only, with no line from the source. A colored flash plus shrapnel shards
// at evenly spaced, slightly jittered angles (--shard-angle, consumed by the
// battleBurstShard keyframe in style.css).
function spawnBurstEffect(grid, x, y, colorHex) {
    const flash = document.createElement('div');
    flash.className = 'battle-fire-burst-flash';
    flash.style.left = x + 'px';
    flash.style.top = y + 'px';
    flash.style.background = `radial-gradient(circle, ${hexWithAlpha(colorHex, 0.95)}, ${hexWithAlpha(colorHex, 0)} 70%)`;
    grid.appendChild(flash);
    setTimeout(() => flash.remove(), 450);

    const shardCount = 6;
    for (let i = 0; i < shardCount; i++) {
        const shard = document.createElement('div');
        shard.className = 'battle-fire-burst-shard';
        shard.style.left = x + 'px';
        shard.style.top = y + 'px';
        shard.style.background = colorHex;
        shard.style.setProperty('--shard-angle', `${(360 / shardCount) * i + (Math.random() * 20 - 10)}deg`);
        grid.appendChild(shard);
        setTimeout(() => shard.remove(), 400);
    }
}

// Restorative pulse (Healing only): healing isn't an attack, so no
// beam/tracer/burst; just a soft glow and ring centered on the target.
function spawnHealPulseEffect(grid, x, y, colorHex) {
    const glow = document.createElement('div');
    glow.className = 'battle-heal-glow';
    glow.style.left = x + 'px';
    glow.style.top = y + 'px';
    glow.style.background = `radial-gradient(circle, ${hexWithAlpha(colorHex, 0.85)}, ${hexWithAlpha(colorHex, 0)} 70%)`;
    grid.appendChild(glow);
    setTimeout(() => glow.remove(), 700);

    const ring = document.createElement('div');
    ring.className = 'battle-heal-pulse';
    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
    ring.style.borderColor = colorHex;
    grid.appendChild(ring);
    setTimeout(() => ring.remove(), 800);
}

/* --- DESTRUCTION EFFECT ---
   A hot flash plus an expanding shockwave ring, larger than spawnImpactFlash.
   Called only from the render loop's removal pass, for a
   battleMapPendingExplosions entry staged by window.checkBattleTokenDestroyed.
   A manual withdraw/recall never triggers it (see that function). */
function spawnDestructionEffect(grid, x, y) {
    const cx = x + BATTLE_TOKEN_SIZE / 2, cy = y + BATTLE_TOKEN_SIZE / 2;

    const flash = document.createElement('div');
    flash.className = 'battle-destruction-flash';
    flash.style.left = cx + 'px';
    flash.style.top = cy + 'px';
    grid.appendChild(flash);
    setTimeout(() => flash.remove(), 700);

    const ring = document.createElement('div');
    ring.className = 'battle-destruction-ring';
    ring.style.left = cx + 'px';
    ring.style.top = cy + 'px';
    grid.appendChild(ring);
    setTimeout(() => ring.remove(), 900);
}

/* --- WEAPON RANGE RING ---
   Shown while a weapon's target <select> has focus/hover (wired in
   js/combat.js renderShipWeaponsHtml, shared by Vessel Deck and Battle Map
   cards). One reusable element: only one ring is relevant at a time. It is
   wiped on a hard grid reset and lazily recreated.
   No-op if the vessel isn't a token, range is 0 ("unlimited"), or the grid
   isn't in the DOM. */
window.showWeaponRangeRing = function(vesselId, range) {
    if (!range || !window.globalBattleEncounterCache) return;
    const grid = document.getElementById('battle-map-grid');
    if (!grid) return;
    const pos = window.getBattleTokenPosition ? window.getBattleTokenPosition(vesselId) : null;
    if (!pos) return;

    let ring = document.getElementById('battle-map-range-ring');
    if (!ring) {
        ring = document.createElement('div');
        ring.id = 'battle-map-range-ring';
        ring.className = 'battle-range-ring';
        grid.appendChild(ring);
    }
    const cx = pos.x + BATTLE_TOKEN_SIZE / 2, cy = pos.y + BATTLE_TOKEN_SIZE / 2;
    ring.style.left = (cx - range) + 'px';
    ring.style.top = (cy - range) + 'px';
    ring.style.width = (range * 2) + 'px';
    ring.style.height = (range * 2) + 'px';
    ring.style.display = 'block';
};
window.hideWeaponRangeRing = function() {
    const ring = document.getElementById('battle-map-range-ring');
    if (ring) ring.style.display = 'none';
};

/* --- CLICK-ENEMY-TO-TARGET-ALL ---
   Clicking a hostile token (vessel.iff === 'hostile') the user doesn't own
   calls this (see wireTokenDrag); other token clicks open the vessel terminal.
   Points every weapon on the user's own vessels placed on this grid (Battle
   Map cards only, id prefix 'bm-') at the target, skipping weapons whose
   dropdown doesn't offer it as an enabled option (out of range, not visible,
   or out of arc). Does not open the vessel terminal. Flashes the target
   highlight if anything was applied. */
window.autoTargetAllMyWeapons = function(targetVesselId) {
    if (!window.globalBattleEncounterCache) return;
    const myTokens = (window.globalBattleEncounterCache.tokens || []).filter(t => {
        const v = globalShipMarkersCache.find(m => m.id === t.ship_marker_id);
        return v && v.id !== targetVesselId && window.vesselHasOwner(v, currentUserId);
    });
    let appliedAny = false;
    myTokens.forEach(t => {
        const vessel = globalShipMarkersCache.find(m => m.id === t.ship_marker_id);
        const weapons = (vessel && vessel.ship_weapons) || [];
        weapons.forEach((w, idx) => {
            const sel = document.getElementById(`bm-wpn-target-${vessel.id}-${idx}`);
            if (!sel) return;
            const hasOption = Array.from(sel.options).some(o => o.value === targetVesselId && !o.disabled); // disabled = out of arc
            if (!hasOption) return;
            sel.value = targetVesselId;
            appliedAny = true;
        });
    });
    if (appliedAny && typeof window.flashBattleTargetHighlight === 'function') window.flashBattleTargetHighlight(targetVesselId);
};

/* --- TARGET-SELECT HIGHLIGHT ---
   Brief pulse on the chosen target token, wired to each weapon target
   <select>'s onchange (js/combat.js renderShipWeaponsHtml). One reusable
   element; auto-hides after ~1.6 s, and a new pick restarts the timer.
   No-op if the target isn't a token in the active battle (covers
   "-- No Target --") or the grid isn't in the DOM. */
let battleMapTargetHighlightTimeout = null;
window.flashBattleTargetHighlight = function(vesselId) {
    if (!vesselId || !window.globalBattleEncounterCache) return;
    if (window.AudioEngine && window.AudioEngine.playTargetLock) window.AudioEngine.playTargetLock(); // target-lock beep
    const grid = document.getElementById('battle-map-grid');
    if (!grid) return;
    const pos = window.getBattleTokenPosition ? window.getBattleTokenPosition(vesselId) : null;
    if (!pos) return;

    let hl = document.getElementById('battle-map-target-highlight');
    if (!hl) {
        hl = document.createElement('div');
        hl.id = 'battle-map-target-highlight';
        hl.className = 'battle-target-highlight';
        grid.appendChild(hl);
    }
    hl.style.left = pos.x + 'px';
    hl.style.top = pos.y + 'px';
    hl.style.width = BATTLE_TOKEN_SIZE + 'px';
    hl.style.height = BATTLE_TOKEN_SIZE + 'px';
    hl.style.display = 'block';
    // Remove class, force reflow, re-add: replays the CSS pulse even when
    // the same target is picked twice.
    hl.classList.remove('battle-target-highlight-fade');
    void hl.offsetWidth;
    hl.classList.add('battle-target-highlight-fade');

    if (battleMapTargetHighlightTimeout) clearTimeout(battleMapTargetHighlightTimeout);
    battleMapTargetHighlightTimeout = setTimeout(() => { hl.style.display = 'none'; }, 1600);
};
