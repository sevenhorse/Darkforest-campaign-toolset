/* ==========================================================================
   js/battle-ordnance.js - Ordnance: single-warhead dice scaling and launching missiles/torpedoes (resolveOrdnanceLaunch).
   Split out of js/battle-map.js (consolidation pass 2, 2026-10-08), code
   unchanged. Classic script sharing the global scope: loads right after
   battle-map.js (see index.html for the order).
   ========================================================================== */
/* Single Warhead Ordnance build (this session, confirmed design): an
   ordnance-classed weapon can opt into wpn.ordnance_pattern = 'single'
   (default/undefined = 'multi', today's existing 6-payload-split behavior,
   unchanged for every pre-existing weapon). A 'single' salvo skips the
   turn-1 split entirely (see the split check in
   window.processBattleRoundAutomations below) -- to compensate for losing
   that redundancy, its dice COUNT (not die size) is scaled up once at
   LAUNCH time and baked into the snapshotted salvo, same "computed once,
   never re-derived later" convention as launchSquadronOrdnance's own
   unit-count scaling. FLAGGED FIRST-PASS PLACEHOLDER MULTIPLIER,
   DM-tunable, same as every other first-pass balance number in this app.
   Shared by both js/battle-map.js's own launchOrdnance and
   js/squadrons.js's launchSquadronOrdnance (confirmed this session) --
   exposed on window since squadrons.js may load before or after this file
   and only ever reads it at call time, not parse time. */
window.SINGLE_WARHEAD_DICE_MULT = 3;
function scaleOrdnanceDice(diceStr, mult) {
    const m = (diceStr || '').trim().match(/^(\d*)d(\d+)$/i);
    if (!m) return diceStr; // malformed -- fail open, leave unscaled rather than throwing
    const baseNumDice = parseInt(m[1]) || 1;
    const diceFaces = parseInt(m[2]);
    return `${baseNumDice * mult}d${diceFaces}`;
}
window.scaleOrdnanceDice = scaleOrdnanceDice;

// Thin DOM-reading wrapper — unchanged call signature/behavior for the
// manual LAUNCH button, delegating to window.resolveOrdnanceLaunch below
// (same core/wrapper split as window.rollShipWeapon/resolveShipWeaponFire,
// js/combat.js, and window.rollSquadronWeapon/resolveSquadronWeaponFire,
// js/squadrons.js).
window.launchOrdnance = async function(vesselId, idx, idPrefix) {
    idPrefix = idPrefix || '';
    const selfPos = window.getBattleTokenPosition(vesselId);
    if (!selfPos) {
        // Not a battle-map token right now — no grid to track a flight
        // against, so ordnance just resolves the old instant way.
        return window.rollShipWeapon(vesselId, idx, idPrefix);
    }
    let targetSelect = document.getElementById(`${idPrefix}wpn-target-${vesselId}-${idx}`);
    let targetId = targetSelect ? targetSelect.value : null;
    if (!targetId) { alert('Select a target first.'); return; }
    return window.resolveOrdnanceLaunch(vesselId, idx, targetId, {});
};

/* DM-AI-for-NPCs build (this session): DOM-independent core extracted from
   window.launchOrdnance so the new AI ship auto-fire loop
   (window.processBattleRoundAutomations below) can launch ordnance directly
   with an explicit targetId instead of reading a hidden DOM select — same
   split as window.resolveShipWeaponFire (js/combat.js). opts.auto hard-skips
   every gate that would otherwise alert()/confirm() a human player, same
   silent-fail convention as everywhere else opts.auto is used in this app. */
window.resolveOrdnanceLaunch = async function(vesselId, idx, targetId, opts) {
    opts = opts || {};
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let wpn = (vessel.ship_weapons || [])[idx];
    if (!wpn) return;

    // Initiative + Action Economy build (this session): same 1-AP spend as
    // window.resolveShipWeaponFire (js/combat.js) -- a manual ordnance
    // launch is still a discrete action from this ship's own turn slot.
    // (Bug-hunt pass 2026-09-24: the 1-AP spend moved below every refusal
    // gate and the cooldown confirm -- a refused launch no longer costs AP.)

    // System Lockdown build (this session): same Weapons-disabled gate as
    // js/combat.js's rollShipWeapon (see applySystemLockdown there for the
    // full mechanic).
    if (vessel.disabled_weapons_until > 0) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[WEAPONS DISABLED] ${vessel.name}'s weapons are offline for ${vessel.disabled_weapons_until} more round(s).`);
        return;
    }

    // Station Designer build (js/combat.js): same deck-gate check as
    // rollShipWeapon, duplicated here since launchOrdnance is a separate
    // fire path for ordnance-classified weapons. Fails open if the deck no
    // longer exists.
    if (wpn.assigned_deck_id) {
        const assignedDeck = (vessel.ship_decks || []).find(d => d.id === wpn.assigned_deck_id);
        if (assignedDeck && assignedDeck.hp <= 0) {
            if (opts.auto) return;
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`[DECK DESTROYED] ${wpn.name} is mounted on the ${assignedDeck.name} deck, which has been destroyed and can no longer launch.`);
            return;
        }
    }

    const selfPos = window.getBattleTokenPosition(vesselId);
    if (!selfPos) return; // AI/core caller is expected to already be a grid token -- manual wrapper above handles the no-token fallback itself

    let targetVessel = globalShipMarkersCache.find(m => m.id === targetId);
    if (!targetVessel) return;
    const targetPos = window.getBattleTokenPosition(targetId);
    if (!targetPos) {
        if (opts.auto) return;
        alert('Target is not on the battle grid.');
        return;
    }

    const launchEffRange = getEffectiveWeaponRange(wpn, vessel, targetVessel);
    if (launchEffRange && Math.hypot(targetPos.x - selfPos.x, targetPos.y - selfPos.y) > launchEffRange) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[OUT OF RANGE] ${targetVessel.name} is beyond ${wpn.name}'s range (${launchEffRange}).`);
        return;
    }
    // Firing arcs (Phase 3): checked at LAUNCH only -- after that the salvo homes.
    if (typeof window.isTargetInArc === 'function' && !window.isTargetInArc(vesselId, targetId, wpn)) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[OUT OF ARC] ${targetVessel.name} is outside ${wpn.name}'s firing arc — turn the ship first.`);
        return;
    }
    // Phase 10: terrain (planet/station in the way, or target hidden in a nebula).
    const launchTerrain = typeof window.terrainFireCheck === 'function' ? window.terrainFireCheck(vesselId, targetId) : '';
    if (launchTerrain) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[NO LOCK] ${targetVessel.name}: ${launchTerrain}.`);
        return;
    }

    if (wpn.ammo === 0) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[EMPTY] ${wpn.name} is out of ammunition!`);
        return;
    }
    let overridingCooldown = false;
    if (wpn.cooldown > 0) {
        if (opts.auto) return; // hard-skip -- no one to confirm an override mid-tick
        if (!(await window.showConfirmModal(`[WARNING] ${wpn.name} is on cooldown! Launching will OVERRIDE and generate OVERHEAT. Proceed?`))) return;
        overridingCooldown = true;
    }
    if (!opts.auto && typeof window.spendTokenAp === 'function' && !window.spendTokenAp(vesselId, 1)) return;
    if (overridingCooldown) wpn.overheat = Math.min(10, (wpn.overheat || 0) + 1);
    if (wpn.ammo > 0) wpn.ammo -= 1;

    // Weapon Cooldowns build (this session): the launch is now committed --
    // start this weapon's reload clock if it has one, same auto-set
    // rollShipWeapon uses (js/combat.js). This is also what closes the
    // long-standing "ordnance's cooldown isn't auto-set to 10 on launch"
    // Pending item -- give an ordnance weapon a real cooldown_period (Add/
    // Edit Weapon form) and this now does it automatically.
    if (wpn.cooldown_period > 0) wpn.cooldown = wpn.cooldown_period;

    // Fog of War build (this session, confirmed design): reveal on launch,
    // same as any other weapon fire. Best-effort, never blocks the launch.
    try { if (typeof window.revealVesselIfHidden === 'function') await window.revealVesselIfHidden(vessel); } catch (err) { console.error('launchOrdnance: reveal-on-fire failed', err); }

    const isSinglePattern = wpn.ordnance_pattern === 'single';
    const salvoDice = isSinglePattern ? scaleOrdnanceDice(wpn.dice, window.SINGLE_WARHEAD_DICE_MULT) : wpn.dice;

    const ordnance = (window.globalBattleEncounterCache.in_flight_ordnance || []).slice();
    // Directional armor (Phase 5, DM-confirmed): impact hits the side facing
    // where the salvo was launched from, so snapshot the launch point now.
    const launchPt = typeof window.ordnanceLaunchPoint === 'function' ? window.ordnanceLaunchPoint(vesselId) : null;
    ordnance.push({
        salvo_id: genBattleTokenId(),
        source_vessel_id: vesselId, source_vessel_name: vessel.name,
        launch_x: launchPt ? launchPt.x : null, launch_y: launchPt ? launchPt.y : null,
        source_weapon_name: wpn.name, dice: salvoDice, modifier: wpn.modifier, explodes: !!wpn.explodes,
        damage_type: wpn.damage_type || 'Impact',
        target_vessel_id: targetId, target_vessel_name: targetVessel.name,
        turns_remaining: 3, split: false, ordnance_pattern: isSinglePattern ? 'single' : 'multi',
        // AOE build (this session): opt-in per-weapon splash radius (only
        // the Jupiter-class Capitol Killer Tubes have wpn.aoe_radius set, in
        // js/map.js), snapshotted onto the salvo same as every other weapon
        // stat here — an edited/destroyed launcher can't retroactively
        // change an already-in-flight payload's AOE. 0/undefined = no
        // splash, same "opt-in" convention as cooldown_period.
        aoe_radius: wpn.aoe_radius || 0
    });
    window.globalBattleEncounterCache.in_flight_ordnance = ordnance;
    await db.from('battle_encounters').update({ in_flight_ordnance: ordnance }).eq('id', window.globalBattleEncounterCache.id);

    await db.from('ship_markers').update({ ship_weapons: vessel.ship_weapons }).eq('id', vesselId);

    if (window.AudioEngine) window.AudioEngine.playShoot();
    const patternTag = isSinglePattern ? ' [SINGLE WARHEAD]' : '';
    const autoTag = opts.auto ? '🤖 [AI CONTROLLED] ' : '';
    await db.from('chat_logs').insert({ sender_id: null, content: `${autoTag}☠️ [ORDNANCE]${patternTag} ${vessel.name} launches ${wpn.name} at ${targetVessel.name} — impact in 3 rounds.`, message_type: 'system' });
    window.renderVesselDeck();
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};
