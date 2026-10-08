/* ==========================================================================
   js/battle-fx.js - Battle Map visual effects: ordnance flight overlay, weapon fire / impact / destruction effects, range ring, target highlight, click-enemy-to-target-all.
   Split out of js/battle-map.js (consolidation pass 2, 2026-10-08), code
   unchanged. Classic script sharing the global scope: loads right after
   battle-map.js (see index.html for the order).
   ========================================================================== */
/* --- ORDNANCE FLIGHT VISUALIZATION (Animation Engine build, this session) ---
   Rides the EXISTING battle_encounters realtime sync for free -- every
   connected client already re-fetches the row and calls
   window.renderBattleMapPanel whenever in_flight_ordnance changes (launch,
   round-advance resolution, impact), so this animates real synced state for
   everyone watching, not just the client that caused the change. One marker
   div per individual payload entry (salvo_id) -- pre-split that's 1 marker,
   post-split it's 6. turns_remaining (3 -> 2 -> 1 -> resolved/removed at 0)
   drives a coarse per-ROUND progress fraction along the source->target line;
   this is NOT a real-time countdown between rounds, consistent with this
   app's turn-based, DM-driven pacing (nothing here ticks on its own). A
   salvo_id present last render but missing now has resolved one way or
   another -- impacted, was shot down by Point Defense, or fizzled (target
   destroyed/withdrawn mid-flight, see processBattleRoundAutomations). That
   distinction isn't exposed through this data diff, so every disappearance
   gets the same generic impact-flash treatment -- a deliberate
   simplification flagged in the checkpoint notes, not a missed case: a real
   hit-vs-intercept distinction would need processBattleRoundAutomations to
   pass along an explicit outcome per resolved payload, which it doesn't
   today. */
function renderOrdnanceOverlay(grid, tokens, inFlight) {
    const currentIds = new Set();
    inFlight.forEach(entry => {
        const salvoId = entry.salvo_id;
        currentIds.add(salvoId);
        const sourceTok = tokens.find(t => t.ship_marker_id === entry.source_vessel_id);
        const targetTok = tokens.find(t => t.ship_marker_id === entry.target_vessel_id);
        // Source or target is no longer a token on THIS grid (withdrawn,
        // destroyed, or this client just doesn't have one placed) -- nothing
        // sane to draw a line between. The marker (if one already exists
        // from an earlier render) is simply left where it last was; it gets
        // cleaned up by the removal pass below once the entry itself
        // resolves out of in_flight_ordnance.
        if (!sourceTok || !targetTok) return;

        const progress = Math.max(0, Math.min(1, (3 - (entry.turns_remaining !== undefined ? entry.turns_remaining : 3)) / 3));
        const half = BATTLE_TOKEN_SIZE / 2;
        const sx = sourceTok.x + half, sy = sourceTok.y + half;
        const tx = targetTok.x + half, ty = targetTok.y + half;
        let px = sx + (tx - sx) * progress;
        let py = sy + (ty - sy) * progress;

        // Split payloads (shared parent_salvo_id) fan out around the flight
        // line instead of stacking exactly on top of each other -- a small
        // deterministic perpendicular offset keyed off each payload's
        // position within its own group.
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
            // Animation Suite build (this session): color the marker by the
            // salvo's actual damage_type instead of the previous hardcoded
            // purple. normalizeDamageType covers legacy/blank values the
            // same way every other damage-type read in this codebase does.
            // Computed once at marker creation (a salvo's damage type never
            // changes mid-flight) and stashed on the element so the removal
            // pass below can color-match the impact flash to it too.
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

// Converts a 6-digit hex color plus a 0-1 alpha into an 8-digit #RRGGBBAA
// string, used throughout the Animation Suite effects below to build
// colored radial-gradient flashes from a single damage-type hex color
// instead of hand-writing an rgba() per effect. Falls back to white if
// handed something that isn't a hex string.
function hexWithAlpha(hex, alpha) {
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
    return (hex && hex[0] === '#' ? hex : '#ffffff') + a;
}

// colorHex is optional -- callers that don't have a damage-type color handy
// (e.g. legacy call sites) get the original hardcoded orange/red via the
// existing .battle-impact-flash CSS default background.
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

/* --- DIRECT-FIRE WEAPON SHOT VISUAL (Animation Engine build; effect
   families added in the Animation Suite build, this session) ---
   Called from js/combat.js's rollShipWeapon/rollSquadronWeapon right after
   a hit resolves. Originally a single beam style for every weapon; now
   dispatches by the shot's damage type (via window.DAMAGE_TYPE_FAMILY,
   js/combat.js) into one of 4 effect families -- Beam (steady line, the
   original look), Tracer (a traveling streak), Burst (a shell-burst at the
   target, no line from source), or a Restorative pulse for Healing (also
   target-only, no attack-style effect). See spawnBeamEffect/
   spawnTracerEffect/spawnBurstEffect/spawnHealPulseEffect below for the
   family-specific rendering. [UPDATE 2026-09-30: no longer local-only --
   every call is now also sent over the battle broadcast channel, see
   BATTLE BROADCAST CHANNEL near the top of this file. The note below is
   the original rationale, kept for history.] LOCAL to this client only -- unlike
   the ordnance visualization above, a direct-fire shot has no persisted
   in-flight row to piggyback sync off of, and this app has no ephemeral
   broadcast channel (every existing realtime channel here is a real DB
   table's postgres_changes stream). Building one just for this felt like
   real new plumbing for a cosmetic effect, not something to add silently —
   flagged as a known limitation in the checkpoint notes, not a bug: another
   player watching the same battle on their own screen will see the
   resulting health-bar change (real live sync now, via js/db.js's
   ship_markers_stream channel — see the Battle Map Health Sync checkpoint)
   but not the beam itself, and not the destruction/explosion effect either
   (same local-only limitation, see spawnDestructionEffect above).
   Silently no-ops if the Battle Map isn't open, there's no active battle,
   or either vessel isn't currently a token in it — safe to call
   unconditionally after every resolved shot regardless of context. */
window.playWeaponFireEffect = function(sourceVesselId, targetVesselId, colorHex, dmgType, fromRemote) {
    if (!window.globalBattleEncounterCache) return;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const sourceTok = tokens.find(t => t.ship_marker_id === sourceVesselId);
    const targetTok = tokens.find(t => t.ship_marker_id === targetVesselId);
    if (!sourceTok || !targetTok) return;
    // Battle broadcast (Phase 0, 2026-09-30): tell every other open Battle
    // Map to play the same effect -- sent even if THIS client's map isn't
    // open (e.g. firing from the Vessel Deck). Never re-sent by a receiver.
    if (!fromRemote && typeof window.sendBattleBroadcast === 'function') {
        window.sendBattleBroadcast('fx', { k: 'fire', src: sourceVesselId, dst: targetVesselId, col: colorHex || null, dmg: dmgType || null });
    }
    const grid = document.getElementById('battle-map-grid');
    if (!grid) return;

    const half = BATTLE_TOKEN_SIZE / 2;
    const sx = sourceTok.x + half, sy = sourceTok.y + half;
    const tx = targetTok.x + half, ty = targetTok.y + half;
    const color = colorHex || '#ff3333';

    // Animation Suite build (this session): dispatch to one of 4 visual
    // "effect families" instead of every weapon playing the same beam, per
    // window.DAMAGE_TYPE_FAMILY (js/combat.js). dmgType is optional and new
    // as of this build -- any caller that doesn't pass one (there
    // shouldn't be any left in this codebase, but this keeps old/unknown
    // call sites from breaking) falls back to the original beam look.
    const family = (dmgType && window.DAMAGE_TYPE_FAMILY && window.DAMAGE_TYPE_FAMILY[dmgType]) || 'beam';
    window.battleRenderer.fireEffect(sx, sy, tx, ty, color, family);
    if (family !== 'pulse') playBattleImpactSound(targetVesselId);
};

/* Impact sound (Phase 1, 2026-10-01): a moment after a shot lands, a shield
   shimmer if the target still has shields up, otherwise a hull thud. This
   runs after the damage was applied, so "shields still up" is the right
   read. Throttled so an AI volley of many guns doesn't stack into noise. */
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

// Beam family (Energy, Ion, Exotic, Antimatter, Heat -- see
// window.DAMAGE_TYPE_FAMILY) -- the original/default fire effect from the
// Animation Engine build: a steady glowing line snapped instantly between
// firer and target, fading out. Unchanged behavior, just factored out of
// window.playWeaponFireEffect so it's one of 4 dispatch targets instead of
// the only effect.
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

// Tracer family (Impact, Piercing, Cold) -- Animation Suite build. Unlike
// Beam, this actually travels: a small glowing dot spawned at the source
// token, then immediately re-positioned to the target token so the
// existing `transition: left/top` on .battle-fire-tracer animates the
// move (same lerp-via-CSS-transition trick already used for
// .battle-token-el and .battle-ordnance-marker elsewhere in this file).
// `void tracer.offsetWidth` forces a layout flush between the two position
// writes -- without it the browser can coalesce them and the dot just pops
// straight to the target with no visible travel. Leaves an impact flash
// (color-matched) at the target on arrival, same as ordnance impacts.
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

// Burst family (Explosive, Flak, Corrosive) -- Animation Suite build. Per
// the confirmed design this is deliberately NOT a line from source to
// target at all -- a shell-burst/spread effect that appears only at the
// target, representing an area-detonation weapon rather than a directed
// shot. A colored flash plus a small ring of shrapnel "shards" flying
// outward at evenly-spaced angles (with a little per-shard jitter so it
// doesn't look too mechanically uniform), each an independently animated
// element using a --shard-angle CSS custom property consumed by the
// battleBurstShard keyframe in style.css.
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

// Restorative pulse (Healing only) -- Animation Suite build. Per the
// confirmed design, healing deliberately gets no attack-style beam/tracer/
// burst at all (it isn't an attack) -- just a soft outward glow-and-ring
// wave centered on the target, slower and gentler than the Burst family's
// sharp shrapnel-flash treatment.
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

/* --- DESTRUCTION EFFECT (Visual Polish build, this session) ---
   A token vanishing from the grid with zero visual event was the most
   jarring remaining gap now that movement, ordnance flight, impacts, and
   weapon fire all animate. Bigger/more dramatic than spawnImpactFlash
   (ordnance non-impact removal still uses that smaller flash) — a hot
   flash plus an expanding shockwave ring. Called only from the render
   loop's removal pass, consuming a battleMapPendingExplosions entry staged
   by window.checkBattleTokenDestroyed — see that function and the removal
   pass for why a manual withdraw/recall never triggers this. */
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

/* --- WEAPON RANGE RING (Visual Polish build, this session) ---
   Range has been a real targeting restriction since the Range/Ordnance
   build (out-of-range candidates are already filtered from the target
   dropdown), but nothing showed it visually. Wired to a weapon's target
   <select> in js/combat.js's renderShipWeaponsHtml (both the Vessel Deck
   and Battle Map cards share that one function) via onfocus/onmouseenter
   and onblur/onmouseleave. A single reusable element rather than one per
   weapon row -- only one ring is ever relevant at a time (whichever weapon
   row the player's mouse/focus is currently on), and living outside the
   per-token diff loop means it needs no cleanup bookkeeping there; it just
   gets wiped along with everything else on a hard grid reset and lazily
   recreated the next time it's shown. No-op (silently) if the firing
   vessel isn't currently a token, the weapon's range is 0 (this app's
   "unlimited" convention), or the Battle Map grid isn't in the DOM. */
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

/* --- TARGET-SELECT HIGHLIGHT (live-session feature request, 2026-09-13:
   "when selecting a target highlight the actual token") --- Wired to the
   onchange of each weapon's target <select> in js/combat.js's
   renderShipWeaponsHtml (the one function both the Vessel Deck and Battle
   Map cards share). Same single-reusable-element-over-the-grid pattern as
   the range ring just above, but this is a brief pulse rather than a
   persistent overlay -- it's feedback for "you just picked this," not an
   ongoing selection indicator (nothing here tracks per-weapon-row target
   state), so it auto-hides itself after ~1.6s. Re-selecting (same or a
   different target, from the same or a different weapon row) restarts the
   timer rather than stacking one, so only the most recent pick is ever
   showing. No-op (silently) if the target isn't currently a token in the
   active battle -- covers the "-- No Target --" option and any stale
   selection -- or the grid isn't in the DOM. */
/* --- CLICK-ENEMY-TO-TARGET-ALL (live-session feature request, 2026-09-13):
   "clicking an enemy ship auto applies targeting information for all owned
   ship weapons." Judgment call, not re-confirmed with the DM at the
   mechanics level (flagged in the architecture doc, easy to revisit):
   - Only fires for a HOSTILE-tagged token (vessel.iff === 'hostile') that
     the clicking user doesn't own -- a friendly/neutral/untagged token
     click keeps the pre-existing "open vessel terminal" behavior unchanged
     (see the branch in wireTokenDrag below).
   - Sets every weapon-target <select> on the CLICKING user's own vessels
     that are currently placed on THIS battle grid (Battle Map ship cards
     only -- id prefix 'bm-', not the Vessel Deck's separate copies of the
     same weapon rows) to this target, skipping any weapon whose dropdown
     doesn't actually list the target as an option (out of range / not
     visible -- see getBattleScopedTargets) rather than forcing an invalid
     value in.
   - Deliberately does NOT also open the vessel terminal for this click --
     the point is one click to get every gun pointed at the target, and a
     modal popping up over the same cards the FIRE buttons live on would
     fight that. Flashes the existing target highlight ring afterward so
     the lock-on is visually obvious. */
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
            const hasOption = Array.from(sel.options).some(o => o.value === targetVesselId && !o.disabled); // disabled = out of arc (Phase 3)
            if (!hasOption) return;
            sel.value = targetVesselId;
            appliedAny = true;
        });
    });
    if (appliedAny && typeof window.flashBattleTargetHighlight === 'function') window.flashBattleTargetHighlight(targetVesselId);
};

let battleMapTargetHighlightTimeout = null;
window.flashBattleTargetHighlight = function(vesselId) {
    if (!vesselId || !window.globalBattleEncounterCache) return;
    if (window.AudioEngine && window.AudioEngine.playTargetLock) window.AudioEngine.playTargetLock(); // target-lock beep (2026-10-01)
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
    // Restart the CSS pulse animation on every call, including re-picking
    // the same target twice in a row -- removing the class, forcing a
    // reflow, then re-adding it is the standard trick to make a browser
    // replay an animation it thinks hasn't changed.
    hl.classList.remove('battle-target-highlight-fade');
    void hl.offsetWidth;
    hl.classList.add('battle-target-highlight-fade');

    if (battleMapTargetHighlightTimeout) clearTimeout(battleMapTargetHighlightTimeout);
    battleMapTargetHighlightTimeout = setTimeout(() => { hl.style.display = 'none'; }, 1600);
};
