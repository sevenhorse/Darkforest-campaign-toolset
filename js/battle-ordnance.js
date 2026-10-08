/* ==========================================================================
   js/battle-ordnance.js - Ordnance: single-warhead dice scaling and launching missiles/torpedoes (resolveOrdnanceLaunch).
   Classic script sharing the global scope: loads right after battle-map.js
   (see index.html for the order).
   ========================================================================== */
/* Single-warhead ordnance (DM design): wpn.ordnance_pattern = 'single' skips
   the turn-1 split into 6 payloads (default 'multi' splits; see
   window.processBattleRoundAutomations). To compensate, its dice COUNT (not
   die size) is multiplied once at launch and snapshotted on the salvo.
   The multiplier is a first-pass placeholder the DM may tune.
   Used by launchOrdnance here and launchSquadronOrdnance (js/squadrons.js);
   on window because squadrons.js reads it at call time and may load first. */
window.SINGLE_WARHEAD_DICE_MULT = 3;
function scaleOrdnanceDice(diceStr, mult) {
    const m = (diceStr || '').trim().match(/^(\d*)d(\d+)$/i);
    if (!m) return diceStr; // malformed: fail open, leave unscaled
    const baseNumDice = parseInt(m[1]) || 1;
    const diceFaces = parseInt(m[2]);
    return `${baseNumDice * mult}d${diceFaces}`;
}
window.scaleOrdnanceDice = scaleOrdnanceDice;

// Manual LAUNCH button: reads the target from the DOM and delegates to
// window.resolveOrdnanceLaunch (same wrapper/core split as
// rollShipWeapon/resolveShipWeaponFire in js/combat.js).
window.launchOrdnance = async function(vesselId, idx, idPrefix) {
    idPrefix = idPrefix || '';
    const selfPos = window.getBattleTokenPosition(vesselId);
    if (!selfPos) {
        // Not a battle-map token: no flight to track, so resolve instantly
        // as a normal weapon roll.
        return window.rollShipWeapon(vesselId, idx, idPrefix);
    }
    let targetSelect = document.getElementById(`${idPrefix}wpn-target-${vesselId}-${idx}`);
    let targetId = targetSelect ? targetSelect.value : null;
    if (!targetId) { alert('Select a target first.'); return; }
    return window.resolveOrdnanceLaunch(vesselId, idx, targetId, {});
};

/* DOM-independent launch core, used by the manual wrapper above and by the
   AI auto-fire loop (window.processBattleRoundAutomations) with an explicit
   targetId. opts.auto: every refusal returns silently (no alert/confirm),
   a cooldown is never overridden, and no AP is spent. */
window.resolveOrdnanceLaunch = async function(vesselId, idx, targetId, opts) {
    opts = opts || {};
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let wpn = (vessel.ship_weapons || [])[idx];
    if (!wpn) return;

    // A manual launch costs 1 AP, spent only after every refusal gate and the
    // cooldown confirm below, so a refused launch costs nothing.

    // Weapons-disabled gate (System Lockdown; see applySystemLockdown in
    // js/combat.js).
    if (vessel.disabled_weapons_until > 0) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[WEAPONS DISABLED] ${vessel.name}'s weapons are offline for ${vessel.disabled_weapons_until} more round(s).`);
        return;
    }

    // Deck gate, same as rollShipWeapon (js/combat.js): a weapon on a
    // destroyed deck can't launch. Fails open if the deck no longer exists.
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
    if (!selfPos) return; // callers here are grid tokens; the manual wrapper handles the no-token case

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
    // Firing arc is checked at launch only; after that the salvo homes.
    if (typeof window.isTargetInArc === 'function' && !window.isTargetInArc(vesselId, targetId, wpn)) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[OUT OF ARC] ${targetVessel.name} is outside ${wpn.name}'s firing arc — turn the ship first.`);
        return;
    }
    // Terrain: planet/station in the way, or target hidden in a nebula.
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
        if (opts.auto) return; // no one to confirm an override mid-tick
        if (!(await window.showConfirmModal(`[WARNING] ${wpn.name} is on cooldown! Launching will OVERRIDE and generate OVERHEAT. Proceed?`))) return;
        overridingCooldown = true;
    }
    if (!opts.auto && typeof window.spendTokenAp === 'function' && !window.spendTokenAp(vesselId, 1)) return;
    if (overridingCooldown) wpn.overheat = Math.min(10, (wpn.overheat || 0) + 1);
    if (wpn.ammo > 0) wpn.ammo -= 1;

    // Launch committed: start the reload clock if the weapon has a
    // cooldown_period (same as rollShipWeapon in js/combat.js).
    if (wpn.cooldown_period > 0) wpn.cooldown = wpn.cooldown_period;

    // Fog of War: launching reveals a hidden vessel, like any weapon fire.
    // Best-effort; never blocks the launch.
    try { if (typeof window.revealVesselIfHidden === 'function') await window.revealVesselIfHidden(vessel); } catch (err) { console.error('launchOrdnance: reveal-on-fire failed', err); }

    const isSinglePattern = wpn.ordnance_pattern === 'single';
    const salvoDice = isSinglePattern ? scaleOrdnanceDice(wpn.dice, window.SINGLE_WARHEAD_DICE_MULT) : wpn.dice;

    const ordnance = (window.globalBattleEncounterCache.in_flight_ordnance || []).slice();
    // Directional armor (DM rule): impact hits the side facing the launch
    // point, so snapshot it now.
    const launchPt = typeof window.ordnanceLaunchPoint === 'function' ? window.ordnanceLaunchPoint(vesselId) : null;
    ordnance.push({
        salvo_id: genBattleTokenId(),
        source_vessel_id: vesselId, source_vessel_name: vessel.name,
        launch_x: launchPt ? launchPt.x : null, launch_y: launchPt ? launchPt.y : null,
        source_weapon_name: wpn.name, dice: salvoDice, modifier: wpn.modifier, explodes: !!wpn.explodes,
        damage_type: wpn.damage_type || 'Impact',
        target_vessel_id: targetId, target_vessel_name: targetVessel.name,
        turns_remaining: 3, split: false, ordnance_pattern: isSinglePattern ? 'single' : 'multi',
        // Opt-in splash radius (0 = none), snapshotted like the other stats
        // so editing the launcher can't change a salvo already in flight.
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
