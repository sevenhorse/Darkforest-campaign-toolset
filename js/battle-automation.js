/* ==========================================================================
   js/battle-automation.js - Round automation: damage dice helper, AI stance pickers and processBattleRoundAutomations (ordnance aging, point defense, squadron + ship AI).
   Split out of js/battle-map.js (consolidation pass 2, 2026-10-08), code
   unchanged. Classic script sharing the global scope: loads right after
   battle-map.js (see index.html for the order).
   ========================================================================== */
// Shared dice-roll helper for the Range/Ordnance build — same regex/exploding
// logic already duplicated between rollShipWeapon and rollSquadronWeapon in
// js/combat.js, factored out here rather than duplicated a third time since
// both PD counter-fire and ordnance impact need it.
// Playtest rebalance (2026-10-03): adds the hidden calibration bonus
// (window.hiddenDamageBonus, js/combat.js) unless noBonus -- it is not shown
// in breakdownText. Every caller here is a ship/strike-craft weapon roll;
// only Spinal EMP self-damage passes noBonus.
function rollDamageDice(diceStr, modifierStr, explodes, noBonus) {
    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = (diceStr || '1d10').trim().match(diceRegex);
    if (!match) return { total: 0, breakdownText: '(invalid dice)' };
    let numDice = parseInt(match[1]) || 1;
    let diceFaces = parseInt(match[2]);
    let modVal = parseInt(modifierStr) || 0;
    let canExplode = explodes && diceFaces >= 2;
    let total = 0;
    let breakdown = [];
    for (let i = 0; i < numDice; i++) {
        let rollTotal = 0, subRolls = [], currentRoll;
        do {
            currentRoll = Math.floor(Math.random() * diceFaces) + 1;
            rollTotal += currentRoll;
            subRolls.push(currentRoll);
        } while (currentRoll === diceFaces && canExplode);
        total += rollTotal;
        breakdown.push(`(d${diceFaces}: ${subRolls.join('💥')})`);
    }
    total += modVal;
    if (!noBonus && typeof window.hiddenDamageBonus === 'function') total += window.hiddenDamageBonus(numDice, diceFaces);
    return { total, breakdownText: breakdown.join(' + ') + (modVal !== 0 ? ` [Mod: ${modVal >= 0 ? '+' : ''}${modVal}]` : '') };
}

/* Range/Ordnance build (this session) — the per-round automation for
   in-flight ordnance and Point Defense, called from js/combat.js's
   advanceCombatRound alongside window.resetBattleMapMovement, on the same
   tick per the confirmed "reuse Advance Round" turn model. No-op outside an
   active battle.

   Turn model (confirmed mechanics: "persists 3 turns, splits into 6 after
   turn 1, each turn in flight subject to counter-fire"): a launched salvo
   starts at turns_remaining=3. Each tick: it gets ONE PD interception
   attempt at its current state (single object on the first tick, one of 6
   independent payloads afterward); if it survives, turns_remaining
   decrements; the tick where it drops from 3 to 2 is also the tick it
   splits into 6 clones (each turns_remaining=2, split=true); when a
   surviving payload's turns_remaining hits 0 it impacts immediately and
   resolves damage via the existing resolveShipDamage path.

   PD engagement (auto, no manual step, per the DM's own call): every
   is_point_defense weapon on any current battle token that isn't on
   cooldown and has ammo forms a single shared per-round pool. Ordnance is
   resolved first (each alive payload gets the first eligible weapon — the
   target's own or an escort's, checked by LIVE distance to the target's
   current position, preserving the escort-screen decision); whatever's left
   in the pool afterward is offered to deployed strike craft. Any nonzero PD
   hit destroys the payload/counts as a hit on the squadron outright — no
   separate payload-toughness stat exists, per the confirmed design.

   Strike Craft Grid Position build (this session, confirmed design): PD vs.
   strike craft now checks the squadron's OWN real Battle Map token position
   (window.getBattleTokenPosition(sqShip.id)) instead of the old "target_id
   engaged target" proxy — squadrons are real grid tokens now (see
   window.addSquadronToBattleMap, called from combat.js's spawnSquadronToken
   on launch), so the proxy is retired. This also closes a real gap the
   proxy had: a squadron that hadn't fired yet this battle (no target_id
   set) previously couldn't be PD-engaged at all; now it can, from the
   moment it's placed. A squadron with no grid token at all (launched before
   this build shipped, or launched while no battle was active) still can't
   be range-checked and is skipped — fails open, doesn't error.

   Squadron AI Stances build (this session): also resolves any deployed
   squadron's non-manual ai_stance exactly once per round -- Intercept
   Munitions (a standalone interceptor pool, tried per-salvo after ship PD),
   and the 3 offensive stances (Attack Strike Craft / Attack Capital Ships /
   Attack Escorts, nearest-target auto-fire). See the dedicated comment
   blocks further down this function for each. */
/* Playtest rebalance (2026-10-03, DM): AI ships pick their own stance each
   round. Hull under 25% -> Evasive (also breaks off: moves away from its
   target), under 50% -> Defensive, otherwise Aggressive when it's in better
   shape than its target (hull %), else Balanced. A stance the DM sets by
   hand on an AI ship is overridden next round -- take the ship off AI to
   hold a stance. Thresholds are first-pass numbers. */
window.AI_SHIP_STANCE_THRESHOLDS = { EVASIVE: 0.25, DEFENSIVE: 0.50 };
window.pickAiShipStance = function(v, target) {
    const pct = (m) => (m && m.max_hull > 0) ? (m.integrity_hull || 0) / m.max_hull : 1;
    const own = pct(v), th = window.AI_SHIP_STANCE_THRESHOLDS;
    if (own < th.EVASIVE) return 'Evasive';
    if (own < th.DEFENSIVE) return 'Defensive';
    if (target && own > pct(target)) return 'Aggressive';
    return 'Balanced';
};

/* Playtest rebalance (2026-10-03, DM): squadron "Auto" stance. Launched
   squadrons default to ai_stance 'auto'; each Advance Round this picks the
   concrete stance (stored as sq.ai_auto_pick, shown in the deck) that every
   existing stance rule then runs with. Role-weighted (DM decision):
     - PD-carrying chassis (Messenger): enemy ordnance inbound on a friendly
       -> intercept munitions; enemy fighters within reach -> attack strike
       craft; an enemy ship within MEDIUM -> attack it (rockets); otherwise
       hold as an interceptor screen. As a screen it moves to cover the
       friendly ship enemy ordnance is inbound on, else its carrier.
     - Anti-fighter chassis (Raven): enemy fighters within reach -> attack
       strike craft; otherwise the nearest enemy ship's class.
     - Everything else (Hawk, bombers): capitals first, then escorts, then
       strike craft.
   "Within reach" = SQUADRON_AUTO_REACH px. The existing below-30%-HP
   break-off still applies to the offensive picks. In Auto, Attack Capital
   Ships also takes untagged (UNCLASSIFIED) non-strike-craft ships -- a
   judgment call so auto fighters don't idle against untagged NPCs. */
window.SQUADRON_AUTO_REACH = 600;
window.squadronEffectiveStance = function(sq) {
    if (!sq) return '';
    return sq.ai_stance === 'auto' ? (sq.ai_auto_pick || 'attack_capitals') : (sq.ai_stance || '');
};
window.pickSquadronAutoStance = function(sq, sqShip, ctx) {
    const db0 = (typeof STRIKE_CRAFT_DB !== 'undefined' && STRIKE_CRAFT_DB[sq.type]) || { weapons: [] };
    const roles = (db0.weapons || []).map(w => w.role);
    const hasPD = roles.includes('point_defense'), hasAF = roles.includes('anti_fighter');
    const tokens = ctx.tokens || [];
    const myIds = window.vesselOwnerIds(sqShip);
    const selfPos = window.getBattleTokenPosition(sqShip.id);
    if (!selfPos) return sq.ai_auto_pick || 'attack_capitals';
    const enemies = [];
    tokens.forEach(t => {
        const m = globalShipMarkersCache.find(x => x.id === t.ship_marker_id);
        if (!m || m.id === sqShip.id || window.ownerIdsShareOwner(window.vesselOwnerIds(m), myIds)) return;
        enemies.push({ m, d: Math.hypot(t.x - selfPos.x, t.y - selfPos.y) });
    });
    const reach = window.SQUADRON_AUTO_REACH;
    const fightersNear = enemies.some(e => e.m.is_strike_craft && e.d <= reach);
    const ships = enemies.filter(e => !e.m.is_strike_craft).sort((a, b) => a.d - b.d);
    const classPick = (e) => (e && e.m.vessel_class === 'Escort') ? 'attack_escorts' : 'attack_capitals';
    if (hasPD) {
        const threat = (ctx.ordnance || []).some(o => {
            const tgt = globalShipMarkersCache.find(x => x.id === o.target_vessel_id);
            const src = globalShipMarkersCache.find(x => x.id === o.source_vessel_id);
            return tgt && window.ownerIdsShareOwner(window.vesselOwnerIds(tgt), myIds) && !(src && window.ownerIdsShareOwner(window.vesselOwnerIds(src), myIds));
        });
        if (threat) return 'intercept_munitions';
        if (fightersNear) return 'attack_strike_craft';
        const tiers = window.BATTLE_RANGE_TIERS || { MEDIUM: 200 };
        if (ships.length && ships[0].d <= tiers.MEDIUM) return classPick(ships[0]);
        return 'intercept_munitions';
    }
    if (hasAF) {
        if (fightersNear) return 'attack_strike_craft';
        if (ships.length) return classPick(ships[0]);
        return enemies.length ? 'attack_strike_craft' : (sq.ai_auto_pick || 'attack_capitals');
    }
    if (ships.some(e => e.m.vessel_class !== 'Escort')) return 'attack_capitals';
    if (ships.length) return 'attack_escorts';
    if (enemies.length) return 'attack_strike_craft';
    return sq.ai_auto_pick || 'attack_capitals';
};

window.processBattleRoundAutomations = async function() {
    if (!window.globalBattleEncounterCache) return;
    const battle = window.globalBattleEncounterCache;
    const tokens = battle.tokens || [];
    const chatLines = [];
    const touchedVessels = new Map(); // id -> vessel object (already mutated in globalShipMarkersCache)

    const markTouched = (v) => { if (v) touchedVessels.set(v.id, v); };

    // Weapon Cooldowns build (this session): hoisted from further down this
    // function (it used to be declared right before the "PD vs deployed
    // strike craft" block) so the squadron-intercept pool below -- which
    // runs BEFORE that block, inside the ordnance-aging loop -- can also mark
    // a carrier touched when an intercepting squadron's weapon cooldown gets
    // set. Same Set, same final persist loop at the end of this function.
    const touchedCarrierIds = new Set();

    // Weapon Cooldowns build (this session): sq.weapon_cooldowns is new,
    // per-deployed-squadron-instance state (STRIKE_CRAFT_DB itself is a
    // shared catalog, not per-instance, so cooldown state can't live on the
    // weapon object the way it does for ship_weapons).
    function squadronWeaponCooldown(sq, wpnIdx) {
        return (sq.weapon_cooldowns && sq.weapon_cooldowns[wpnIdx]) || 0;
    }

    // Playtest rebalance: resolve every Auto squadron's stance for this round
    // BEFORE the intercept pool / offensive passes below read it.
    for (const v of globalShipMarkersCache.slice()) {
        for (const sq of (v.ship_deployed || [])) {
          try {
            if (!sq || sq.ai_stance !== 'auto' || (sq.count || 0) <= 0) continue;
            const sqShip = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
            if (!sqShip || !window.getBattleTokenPosition(sqShip.id)) continue;
            const pick = window.pickSquadronAutoStance(sq, sqShip, { tokens: battle.tokens || [], ordnance: battle.in_flight_ordnance || [] });
            if (pick !== sq.ai_auto_pick) {
                chatLines.push(`🤖 [AI AUTO] ${sq.name} switches to ${pick.replace(/_/g, ' ')}.`);
                sq.ai_auto_pick = pick;
                touchedCarrierIds.add(v.id);
            }
            // An interceptor screen moves to cover: the friendly ship enemy
            // ordnance is inbound on (nearest one), else its own carrier --
            // close enough that its PD (90 px reach) covers it.
            if (pick === 'intercept_munitions') {
                const sPos = window.getBattleTokenPosition(sqShip.id);
                const myIds = window.vesselOwnerIds(sqShip);
                let guard = null, guardD = Infinity;
                (battle.in_flight_ordnance || []).forEach(o => {
                    const tgt = globalShipMarkersCache.find(x => x.id === o.target_vessel_id);
                    const src = globalShipMarkersCache.find(x => x.id === o.source_vessel_id);
                    if (!tgt || !window.ownerIdsShareOwner(window.vesselOwnerIds(tgt), myIds) || (src && window.ownerIdsShareOwner(window.vesselOwnerIds(src), myIds))) return;
                    const p = window.getBattleTokenPosition(tgt.id);
                    if (p && sPos && Math.hypot(p.x - sPos.x, p.y - sPos.y) < guardD) { guardD = Math.hypot(p.x - sPos.x, p.y - sPos.y); guard = p; }
                });
                if (!guard) guard = window.getBattleTokenPosition(v.id);
                const keep = window.STRIKE_CRAFT_RANGES.GUN * 0.75;
                if (guard && sPos && Math.hypot(guard.x - sPos.x, guard.y - sPos.y) > keep) {
                    const moved = moveTokenToward(sqShip.id, guard, sqShip.tactical_speed || SQUADRON_TACTICAL_SPEED);
                    if (moved) await saveBattleTokens(moved);
                }
            }
          } catch (err) { console.error('processBattleRoundAutomations: auto stance pick failed', err); }
        }
    }

    // Shared per-round pool of available PD weapons: { vesselId, weaponIdx, position, ownerId }
    let pdPool = [];
    tokens.forEach(tok => {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!v) return;
        // System Lockdown build (this session): a Sensors-disabled vessel
        // drops out of the automated PD pool entirely for the round -- no
        // detection, no intercepts.
        if ((v.disabled_sensors_until || 0) > 0) return;
        (v.ship_weapons || []).forEach((w, wIdx) => {
            if (!w.is_point_defense) return;
            if ((w.cooldown || 0) > 0) return; // hard skip — no one to confirm a cooldown override on an automated tick
            if (w.ammo === 0) return;
            pdPool.push({ vesselId: v.id, weaponIdx: wIdx, position: { x: tok.x, y: tok.y }, ownerIds: window.vesselOwnerIds(v) });
        });
    });

    // ownerId is the vessel being protected's owner — escort screening only
    // applies within the same ownership (same "side"), same PC-vs-NPC
    // heuristic (owner_id match) this app already uses everywhere else for
    // friend/foe detection. Without this check an ENEMY's point defense
    // could "intercept" a payload aimed at someone else's ship, which isn't
    // what "allied escort" means.
    //
    // Bug fix (2026-08-29, caught live during the DM's own test battle): the
    // "PD vs deployed strike craft" block below this function used to call
    // fireEligiblePD(targetPos, sqShip.owner_id) -- i.e. it asked "find PD
    // belonging to THIS SAME strike craft's own owner", which is backwards
    // for anti-fighter fire and made every ship's point defense shoot down
    // its OWN launched squadrons every round (confirmed live: "Task Force
    // Black's PDC Grid engages Ghost", Ghost being Task Force Black's own
    // Raven). Ordnance interception (the other caller, above) legitimately
    // wants SAME-owner PD protecting a threatened ship, so the shared
    // pool-search couldn't just flip its default -- added an opts.enemyOnly
    // flag instead so each caller states which relationship it actually
    // means, rather than smuggling "enemy of" through a param named for
    // "owner of".
    function findEligiblePD(targetPos, ownerIds, opts) {
        const enemyOnly = !!(opts && opts.enemyOnly);
        for (let i = 0; i < pdPool.length; i++) {
            const entry = pdPool[i];
            const sameOwner = window.ownerIdsShareOwner(entry.ownerIds, ownerIds);
            if (enemyOnly ? sameOwner : !sameOwner) continue;
            const v = globalShipMarkersCache.find(m => m.id === entry.vesselId);
            const w = v && v.ship_weapons[entry.weaponIdx];
            if (!w) continue;
            const dist = Math.hypot(entry.position.x - targetPos.x, entry.position.y - targetPos.y);
            if (!w.range || dist <= w.range) return i;
        }
        return -1;
    }

    function fireEligiblePD(targetPos, ownerIds, opts) {
        const idx = findEligiblePD(targetPos, ownerIds, opts);
        if (idx < 0) return null;
        const entry = pdPool.splice(idx, 1)[0];
        const pdVessel = globalShipMarkersCache.find(m => m.id === entry.vesselId);
        const pdWpn = pdVessel.ship_weapons[entry.weaponIdx];
        const roll = rollDamageDice(pdWpn.dice, pdWpn.modifier, pdWpn.explodes);
        if (pdWpn.ammo > 0) pdWpn.ammo -= 1;
        // Weapon Cooldowns build (this session): applies to automated PD
        // fire too, not just manual/AI-stance shots -- if a PD weapon has a
        // cooldown_period set (opt-in, 0 by default so every PD weapon keeps
        // firing every round it's eligible unless a DM deliberately gives it
        // one), this pool already only lets it fire once per round by
        // construction (spliced out below); a nonzero cooldown_period now
        // also keeps it out of the pool for however many ADDITIONAL rounds
        // it specifies.
        if (pdWpn.cooldown_period > 0) pdWpn.cooldown = pdWpn.cooldown_period;
        markTouched(pdVessel);
        // Fog of War build (this session, confirmed design): PD firing
        // reveals the PD ship too, same as any other weapon discharge. This
        // helper is called from both a for-of loop and a plain .forEach
        // below, so it isn't async itself -- fire-and-forget, same "can't
        // await inside a forEach callback" precedent as
        // checkBattleTokenDestroyed's own unawaited call further down this
        // function.
        if (typeof window.revealVesselIfHidden === 'function') window.revealVesselIfHidden(pdVessel).catch(err => console.error('fireEligiblePD: reveal-on-fire failed', err));
        return { pdVessel, pdWpn, roll };
    }

    /* --- Squadron AI Stances build (this session): Intercept Munitions ---
       Confirmed design: a standalone intercept roll, separate from the
       shared ship-mounted pdPool above (squadron weapons only ever exist in
       the static STRIKE_CRAFT_DB catalog -- they have no ship_weapons row on
       their own companion token at all, so they were never eligible for
       pdPool in the first place and still aren't). Each deployed squadron
       with ai_stance === 'intercept_munitions' contributes ONE intercept
       attempt to this round's pool, using its role:'point_defense' weapon
       if it has one (falling back to its first weapon otherwise -- same
       fallback rule as the offensive stances below). Tried in the ordnance
       loop AFTER the existing ship PD roll, i.e. ship PD gets first crack at
       a payload and a squadron only gets a shot if that payload survives it
       -- an implementation-order call, not something the DM explicitly
       confirmed either way; flagging it rather than letting it pass as
       obviously-the-only-option.

       Strike-Craft Weapon Range build (later session): originally had NO
       range check at all ("STRIKE_CRAFT_DB weapons have no range field",
       true at the time) -- now that every squadron weapon has a real
       `range`, this mirrors findEligiblePD/fireEligiblePD's own pattern
       exactly: the interceptor is only eligible if its own token is within
       its weapon's range of the position being defended (the target vessel
       the payload is inbound on), same "range measured from the defender's
       position, not the attacker's" semantics ship PD already used. */
    let squadronInterceptPool = [];
    globalShipMarkersCache.forEach(v => {
        (v.ship_deployed || []).forEach((sq, sqIdx) => {
            if (window.squadronEffectiveStance(sq) !== 'intercept_munitions' || (sq.count || 0) <= 0) return;
            const sqShip = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
            if (!sqShip) return;
            // System Lockdown build (this session): a Sensors-disabled
            // squadron drops out of the automated intercept pool for the
            // round, same as a Sensors-disabled ship's PD above.
            if ((sqShip.disabled_sensors_until || 0) > 0) return;
            const pos = window.getBattleTokenPosition(sqShip.id);
            if (!pos) return; // no grid token this round -- can't range-check, skip (fails open, same as every other "squadron has no grid token" check in this file)
            const dbStats = STRIKE_CRAFT_DB[sq.type];
            if (!dbStats) return;
            // Weapon Cooldowns build (this session): prefer the point_defense
            // weapon, but only if it isn't on cooldown for THIS squadron
            // instance; fall back to any other weapon that isn't on
            // cooldown; if every weapon is on cooldown, this squadron sits
            // the round out entirely (matches ship PD's own pdPool -- a
            // weapon on cooldown is never added to the pool in the first
            // place, same hard-skip convention, not just a fire-time check).
            let wpnIdx = dbStats.weapons.findIndex((w, i) => w.role === 'point_defense' && squadronWeaponCooldown(sq, i) === 0);
            if (wpnIdx < 0) wpnIdx = dbStats.weapons.findIndex((w, i) => squadronWeaponCooldown(sq, i) === 0);
            if (wpnIdx < 0) return; // every weapon on cooldown -- no interception offered this round
            squadronInterceptPool.push({ carrierId: v.id, sqIdx, sqName: sq.name, wpn: dbStats.weapons[wpnIdx], wpnIdx, ownerIds: window.vesselOwnerIds(sqShip), position: pos, sqShipId: sqShip.id });
        });
    });

    function findEligibleSquadronIntercept(targetPos, ownerIds) {
        for (let i = 0; i < squadronInterceptPool.length; i++) {
            const entry = squadronInterceptPool[i];
            if (!window.ownerIdsShareOwner(entry.ownerIds, ownerIds)) continue;
            const dist = Math.hypot(entry.position.x - targetPos.x, entry.position.y - targetPos.y);
            const cap = window.strikeCraftRangeCap(entry.wpn); // playtest rebalance: SC reach cap
            if (dist <= (entry.wpn.range ? Math.min(entry.wpn.range, cap) : cap)) return i;
        }
        return -1;
    }

    function fireEligibleSquadronIntercept(targetPos, ownerIds) {
        const idx = findEligibleSquadronIntercept(targetPos, ownerIds);
        if (idx < 0) return null;
        const entry = squadronInterceptPool.splice(idx, 1)[0];
        const roll = rollDamageDice(entry.wpn.dice, entry.wpn.modifier, entry.wpn.explodes);
        // Weapon Cooldowns build (this session): entry.wpn is a shared
        // STRIKE_CRAFT_DB catalog object, not per-instance -- cooldown state
        // lives on the deployed squadron itself, looked back up here via the
        // carrierId/sqIdx this pool entry was built with (pool-building
        // above already skipped this entry if it were on cooldown, so this
        // is always a fresh cooldown start, never a redundant re-set).
        if (entry.wpn.cooldown_period > 0) {
            const carrier = globalShipMarkersCache.find(m => m.id === entry.carrierId);
            const liveSq = carrier && (carrier.ship_deployed || [])[entry.sqIdx];
            if (liveSq) {
                liveSq.weapon_cooldowns = liveSq.weapon_cooldowns || {};
                liveSq.weapon_cooldowns[entry.wpnIdx] = entry.wpn.cooldown_period;
                touchedCarrierIds.add(entry.carrierId);
            }
        }
        // Fog of War build (this session, confirmed design): same
        // fire-reveals-you rule as fireEligiblePD above, fire-and-forget for
        // the same reason (called from a for-of loop, not itself async).
        if (typeof window.revealVesselIfHidden === 'function') {
            const sqShip = globalShipMarkersCache.find(m => m.id === entry.sqShipId);
            if (sqShip) window.revealVesselIfHidden(sqShip).catch(err => console.error('fireEligibleSquadronIntercept: reveal-on-fire failed', err));
        }
        return { entry, roll };
    }

    // --- Age & resolve in-flight ordnance ---
    // Bug fix (pre-deploy review): this whole function previously had no
    // exception isolation at all, unlike its sibling processSalvageConversion
    // (js/battle-map.js), which explicitly wraps each item in its own
    // try/catch "as defense-in-depth against any other unexpected failure."
    // Without it, one bad awaited call (e.g. a transient Supabase error on
    // a single salvo's checkBattleTokenDestroyed) would throw out of the
    // whole function, silently discarding every already-computed damage/PD
    // result for every OTHER salvo/squadron processed that round, and
    // skipping the trailing chat log + UI refresh in advanceCombatRound too.
    // Each salvo/squadron is now isolated the same way.
    const survivingOrdnance = [];
    // Phase 11: how each payload that leaves the list ended (hit / shot
    // down / fizzled), saved with the same row update so every client's 3D
    // view can play the right effect when it disappears.
    const ordnanceOutcomes = {};
    const markOutcome = (salvo, o) => { if (salvo && salvo.salvo_id) ordnanceOutcomes[salvo.salvo_id] = { o, r: battle.round_number || null }; };
    for (const salvo of (battle.in_flight_ordnance || [])) {
      try {
        const targetVessel = globalShipMarkersCache.find(m => m.id === salvo.target_vessel_id);
        const targetPos = targetVessel ? window.getBattleTokenPosition(targetVessel.id) : null;
        if (!targetVessel || !targetPos) {
            chatLines.push(`💨 [ORDNANCE] ${salvo.source_weapon_name} from ${salvo.source_vessel_name} loses its lock (${salvo.target_vessel_name} is no longer on the grid) and fizzles.`);
            markOutcome(salvo, 'fizzle');
            continue;
        }

        const engagement = fireEligiblePD(targetPos, window.vesselOwnerIds(targetVessel));
        if (engagement && engagement.roll.total > 0) {
            chatLines.push(`🛡️ [POINT DEFENSE] ${engagement.pdVessel.name}'s ${engagement.pdWpn.name} intercepts a payload inbound on ${targetVessel.name} from ${salvo.source_vessel_name} (${engagement.roll.total} dmg) — destroyed!`);
            markOutcome(salvo, 'intercept');
            continue; // payload destroyed, dropped from survivingOrdnance
        }
        if (engagement) {
            chatLines.push(`🛡️ [POINT DEFENSE] ${engagement.pdVessel.name}'s ${engagement.pdWpn.name} fires at an inbound payload — misses.`);
        }

        // Squadron AI Stances build (this session): an Intercept Munitions
        // squadron gets a shot at the same payload if ship PD didn't
        // already destroy it -- see squadronInterceptPool/
        // fireEligibleSquadronIntercept above.
        const sqEngagement = fireEligibleSquadronIntercept(targetPos, window.vesselOwnerIds(targetVessel));
        if (sqEngagement && sqEngagement.roll.total > 0) {
            chatLines.push(`🛡️ [SQUADRON INTERCEPT] ${sqEngagement.entry.sqName} shoots down a payload inbound on ${targetVessel.name} from ${salvo.source_vessel_name} (${sqEngagement.roll.total} dmg) — destroyed!`);
            markOutcome(salvo, 'intercept');
            continue; // payload destroyed, dropped from survivingOrdnance
        }
        if (sqEngagement) {
            chatLines.push(`🛡️ [SQUADRON INTERCEPT] ${sqEngagement.entry.sqName} fires at an inbound payload — misses.`);
        }

        const turnsLeft = salvo.turns_remaining - 1;
        if (turnsLeft <= 0) {
            // Impact. Only the target's own current stance/category modifiers
            // apply — the launching vessel's stance at LAUNCH time isn't
            // reapplied here (it may have changed in the 3 rounds since, and
            // retroactively changing an already-committed shot's damage off
            // a stance set turns later would be stranger than just not
            // modeling firer stance for ordnance impact at all).
            let dmgType = window.normalizeDamageType ? window.normalizeDamageType(salvo.damage_type || 'Impact') : (salvo.damage_type || 'Impact');
            const roll = rollDamageDice(salvo.dice, salvo.modifier, salvo.explodes);
            let total = roll.total;
            let impactLog = '';
            let tStance = targetVessel.ship_stance || 'Balanced';
            if (tStance === 'Defensive') { total = Math.floor(total * 0.75); impactLog += `[Target Defensive: -25% Dmg] `; }
            else if (tStance === 'Evasive') { total = Math.floor(total * 0.50); impactLog += `[Target Evasive: -50% Dmg] `; }
            else if (tStance === 'Aggressive') { total = Math.floor(total * 1.25); impactLog += `[Target Aggressive: +25% Dmg] `; }
            // Not clamping `total` to 0 here — matches rollShipWeapon's own
            // behavior (js/combat.js), which passes its computed total into
            // resolveShipDamage unclamped too. Keeping ordnance consistent
            // with direct-fire rather than fixing a speculative edge case
            // only on this path.
            // Directional armor (Phase 5): side facing the launch point (fallback: the launcher's current spot, else front).
            const impactSource = (salvo.launch_x !== null && salvo.launch_x !== undefined) ? { point: { x: salvo.launch_x, y: salvo.launch_y } } : { vesselId: salvo.source_vessel_id };
            const result = window.resolveShipDamage(targetVessel, dmgType, total, typeof window.damageSideOpts === 'function' ? window.damageSideOpts(targetVessel, impactSource) : undefined);
            impactLog += result.log;
            // DM-AI-for-NPCs build (this session): same "biggest single hit
            // this round" tracking as every other damage path (see
            // window.resolveShipWeaponFire, js/combat.js, for the full
            // explanation) -- an ordnance impact is a legitimate threat
            // source for the AI ship reprioritization check below, since the
            // DM explicitly asked for ordnance to be in scope for this build.
            if (total > (targetVessel.round_biggest_hit_amount || 0)) {
                targetVessel.round_biggest_hit_amount = total;
                targetVessel.round_biggest_hit_by = salvo.source_vessel_id || null;
            }
            Object.assign(targetVessel, {
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened,
                ...(typeof window.armorSideResultFields === 'function' ? window.armorSideResultFields(result) : {})
            });
            markTouched(targetVessel);
            chatLines.push(`💥 [ORDNANCE IMPACT] ${salvo.source_weapon_name} (from ${salvo.source_vessel_name}) strikes ${targetVessel.name} for ${total} ${dmgType} dmg. ${impactLog}`);
            if (typeof window.checkBattleTokenDestroyed === 'function') await window.checkBattleTokenDestroyed(targetVessel);

            // AOE splash (Jupiter Heavy Cruiser follow-on, System Lockdown/AOE
            // build): opt-in per-weapon `aoe_radius`, snapshotted onto the
            // salvo at launch. Every OTHER token within radius of the primary
            // target's position takes the SAME rolled `total`/`dmgType` --
            // one shared roll, no separate PD roll for splash victims -- with
            // each victim's own current stance modifier applied individually.
            // Confirmed design: per-payload (Capitol Killer Tubes only, up to
            // 6 blasts per original salvo once its ordnance has split).
            if (salvo.aoe_radius > 0) {
                const primaryTok = tokens.find(t => t.ship_marker_id === targetVessel.id);
                if (primaryTok) {
                    for (const tok of tokens) {
                        if (!tok || tok.ship_marker_id === targetVessel.id) continue;
                        const dx = tok.x - primaryTok.x, dy = tok.y - primaryTok.y;
                        if (Math.sqrt(dx * dx + dy * dy) > salvo.aoe_radius) continue;
                        const splashVessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
                        if (!splashVessel) continue;
                        let splashTotal = total;
                        let splashLog = '';
                        const sStance = splashVessel.ship_stance || 'Balanced';
                        if (sStance === 'Defensive') { splashTotal = Math.floor(splashTotal * 0.75); splashLog += `[Target Defensive: -25% Dmg] `; }
                        else if (sStance === 'Evasive') { splashTotal = Math.floor(splashTotal * 0.50); splashLog += `[Target Evasive: -50% Dmg] `; }
                        else if (sStance === 'Aggressive') { splashTotal = Math.floor(splashTotal * 1.25); splashLog += `[Target Aggressive: +25% Dmg] `; }
                        // Directional armor (Phase 5): side facing the blast centre (the primary target).
                        const blastCentre = typeof window.battleTokenCenter === 'function' ? window.battleTokenCenter(primaryTok) : { x: primaryTok.x, y: primaryTok.y };
                        const splashResult = window.resolveShipDamage(splashVessel, dmgType, splashTotal, typeof window.damageSideOpts === 'function' ? window.damageSideOpts(splashVessel, { point: blastCentre }) : undefined);
                        splashLog += splashResult.log;
                        Object.assign(splashVessel, {
                            integrity_shields: splashResult.integrity_shields, integrity_hull: splashResult.integrity_hull,
                            integrity_reactive: splashResult.integrity_reactive, integrity_ablative: splashResult.integrity_ablative,
                            integrity_hardened: splashResult.integrity_hardened,
                            ...(typeof window.armorSideResultFields === 'function' ? window.armorSideResultFields(splashResult) : {})
                        });
                        markTouched(splashVessel);
                        chatLines.push(`💥 [AOE SPLASH] ${salvo.source_weapon_name} (from ${salvo.source_vessel_name}) catches ${splashVessel.name} in the blast for ${splashTotal} ${dmgType} dmg. ${splashLog}`);
                        if (typeof window.checkBattleTokenDestroyed === 'function') await window.checkBattleTokenDestroyed(splashVessel);
                        pdPool = pdPool.filter(entry => entry.vesselId !== splashVessel.id);
                        squadronInterceptPool = squadronInterceptPool.filter(entry => entry.sqShipId !== splashVessel.id);
                    }
                }
            }

            // Bug fix (pre-deploy review): a vessel destroyed mid-pass kept
            // any of its still-unfired PD weapons sitting in the shared pool,
            // available to "intercept" a LATER salvo or engage a strike
            // craft later in this same automation call — a dead ship
            // shooting after its own death. Prune it the moment it's
            // confirmed destroyed rather than leaving stale entries.
            pdPool = pdPool.filter(entry => entry.vesselId !== targetVessel.id);
            // Bug fix (bug hunt, this session): same stale-pool problem
            // applies to squadronInterceptPool -- a squadron destroyed by
            // this impact could otherwise still "intercept" a later salvo
            // this same automation pass, since its pool entry is keyed off
            // sqShipId which stays resolvable in globalShipMarkersCache even
            // after the token is gone. Prune by sqShipId, mirroring pdPool.
            squadronInterceptPool = squadronInterceptPool.filter(entry => entry.sqShipId !== targetVessel.id);
            markOutcome(salvo, 'hit');
            continue; // consumed on impact, dropped from survivingOrdnance
        }

        // Survives to next round.
        const updated = { ...salvo, turns_remaining: turnsLeft };
        // Single Warhead Ordnance build (this session): a 'single'-pattern
        // salvo never splits, regardless of turnsLeft -- it just ages down
        // and resolves as ONE impact roll, same as every salvo behaved
        // before the 6-way split mechanic existed. ordnance_pattern is
        // undefined on any salvo launched before this build shipped, so
        // `!== 'single'` (not `=== 'multi'`) is the correct check -- an old
        // in-flight salvo keeps splitting exactly as it already would have.
        if (!salvo.split && salvo.ordnance_pattern !== 'single' && turnsLeft === 2) {
            // This is the "after turn 1" point — split into 6 independent payloads.
            const parentId = salvo.salvo_id;
            for (let i = 1; i <= 6; i++) {
                survivingOrdnance.push({ ...updated, salvo_id: genBattleTokenId(), parent_salvo_id: parentId, payload_index: i, split: true });
            }
            chatLines.push(`☠️ [ORDNANCE] ${salvo.source_weapon_name} from ${salvo.source_vessel_name} splits into 6 independent payloads, still inbound on ${targetVessel.name}.`);
        } else {
            survivingOrdnance.push(updated);
        }
      } catch (err) {
        // Fail open: keep the salvo exactly as it was rather than silently
        // dropping a payload because of an unrelated error (e.g. a transient
        // DB write failure). It gets another try next round.
        console.error('processBattleRoundAutomations: ordnance salvo failed, carrying it over unchanged', salvo, err);
        survivingOrdnance.push(salvo);
      }
    }

    // --- PD vs deployed strike craft (real grid position — see file header) ---
    // touchedCarrierIds is declared up near markTouched now (Weapon
    // Cooldowns build, this session) -- reused here unchanged.
    globalShipMarkersCache.forEach(v => {
        (v.ship_deployed || []).forEach(sq => {
          try {
            if ((sq.count || 0) <= 0) return;
            const sqShip = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
            if (!sqShip) return;
            const targetPos = window.getBattleTokenPosition(sqShip.id);
            if (!targetPos) return; // squadron has no grid token this round (pre-build legacy launch, or launched outside a battle) — can't be range-checked, skip
            // enemyOnly: true -- this is anti-fighter fire, we want the OPPOSING
            // side's PD shooting at this strike craft, not its own carrier's.
            const engagement = fireEligiblePD(targetPos, window.vesselOwnerIds(sqShip), { enemyOnly: true });
            if (!engagement) return;
            if (engagement.roll.total <= 0) {
                chatLines.push(`🛡️ [POINT DEFENSE] ${engagement.pdVessel.name}'s ${engagement.pdWpn.name} fires at ${sq.name} — misses.`);
                return;
            }
            let dmgType = window.normalizeDamageType ? window.normalizeDamageType(engagement.pdWpn.damage_type || 'Impact') : (engagement.pdWpn.damage_type || 'Impact');
            let categoryMult = (dmgType === 'Flak') ? 2 : 0.5; // strike-craft effectiveness, same rule as manual fire
            let total = Math.ceil(engagement.roll.total * categoryMult);
            const result = window.resolveShipDamage(sqShip, dmgType, total);
            Object.assign(sqShip, {
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened
            });
            markTouched(sqShip);
            if (typeof syncSquadronHpToParent === 'function') syncSquadronHpToParent(sqShip);
            touchedCarrierIds.add(v.id); // this carrier's ship_deployed[].hp was just updated by syncSquadronHpToParent
            chatLines.push(`🛡️ [POINT DEFENSE] ${engagement.pdVessel.name}'s ${engagement.pdWpn.name} engages ${sq.name} for ${total} ${dmgType} dmg. ${result.log}`);
            // Bughunt pass (this session): this block was the one damage path
            // in this function that never called checkBattleTokenDestroyed,
            // unlike the ordnance-impact path above (which does, plus prunes
            // pdPool) and the manual/AI-fire paths in js/combat.js (rollShipWeapon,
            // resolveSquadronWeaponFire). Without it, a squadron killed by
            // automated ship PD during Advance Round kept its grid token
            // indefinitely (sq.hp synced to 0 via syncSquadronHpToParent, but
            // count untouched and the token still present) -- which, combined
            // with this session's new AI-stance retreat logic, meant a dead
            // squadron would show up as "breaking off" forever every round
            // instead of ever leaving the grid. Called unawaited, matching the
            // syncSquadronHpToParent call just above it in this same forEach
            // (forEach can't be awaited); its first await is inside
            // saveBattleTokens, which reassigns window.globalBattleEncounterCache.tokens
            // synchronously before that await, so the removal is already
            // reflected in the cache by the time this forEach returns and the
            // downstream AI-stance loop runs.
            if (typeof window.checkBattleTokenDestroyed === 'function') checkBattleTokenDestroyed(sqShip);
          } catch (err) {
            console.error('processBattleRoundAutomations: strike-craft PD engagement failed, skipping this squadron this round', sq, err);
          }
        });
    });

    /* --- Squadron AI Stances build (offensive stances), extended this
       session with Squadron Movement + Retreat ---
       Runs AFTER both PD passes above, so an AI-controlled squadron never
       fires from a position it didn't survive this round's defensive fire
       to hold. Each deployed squadron with an ai_stance of
       attack_strike_craft/attack_capitals/attack_escorts resolves exactly
       once per Advance Round:
         0. (New this session, confirmed design) Below 30% HP the squadron
            breaks off entirely -- moves toward its own carrier's current
            token position instead of picking a target, and does NOT fire
            this round. 30% is a first-pass placeholder threshold, not a
            DM-tuned number (flagged in the checkpoint notes) -- easy to
            retune to a different fraction later. Intercept Munitions
            squadrons do NOT retreat -- confirmed design keeps them
            stationary regardless of HP (see squadronInterceptPool above),
            reconciling "should AI squadrons retreat" (yes) against
            "should Intercept move" (no, stay in place) by scoping retreat
            to the 3 offensive stances only, which are the only ones that
            actively close distance/engage in the first place.
         1. Otherwise, eligible targets = current battle tokens, excluding
            the squadron's own side (owner_id match, the same friend/foe
            heuristic used everywhere else in this app) and filtered by
            stance -- is_strike_craft for Attack Strike Craft, or
            vessel_class ('Capital'/'Escort', a new ship_markers/
            ship_templates field added in the original Squadron AI Stances
            build) for the other two. A ship with no vessel_class set is
            invisible to BOTH Attack Capital Ships and Attack Escorts -- it
            isn't obviously either one, so it's excluded rather than
            guessed into a side.
         2. Target picked = nearest by live grid distance among eligible
            candidates (confirmed design).
         3. (New this session, confirmed design) The squadron then moves up
            to its own tactical_speed px straight toward that target's
            CURRENT position via moveTokenToward (defined above,
            clampToGrid-bounded) -- move-then-fire is my own ordering call,
            not something separately confirmed; flagged rather than implied
            as the only sensible option. Since squadron weapons have no
            `range` field at all, this doesn't gate whether it CAN fire --
            it's purely so an AI-stance squadron visibly closes on its
            target instead of sniping from a static position it never
            approaches.
         4. Weapon picked = this squadron type's weapon tagged with the
            role that fits the stance (anti_fighter for Attack Strike
            Craft, anti_capital for the other two -- see STRIKE_CRAFT_DB's
            role-tag comment, js/combat.js), falling back to the squadron's
            first listed weapon if none match (confirmed design).
         5. (New this session, Strike-Craft Weapon Range build, confirmed
            design) Now that STRIKE_CRAFT_DB weapons carry a real `range`,
            the squadron only actually fires if its POST-MOVE distance to
            the target is within the picked weapon's range -- otherwise it
            holds fire this round (having still closed distance per step 3)
            and tries again next round as it keeps advancing. This was a
            confirmed either/or design choice against the alternative of
            leaving AI auto-fire completely unranged; picked so the AI
            doesn't feel dumber than a manual player once ranges exist.
       Resolution itself goes through window.resolveSquadronWeaponFire --
       the exact same damage/persist/chat-log/beam-effect path the manual
       FIRE button uses (extracted from window.rollSquadronWeapon in the
       original build specifically so there'd be one implementation, not
       two). */
    for (const v of globalShipMarkersCache.slice()) {
        for (let sqIdx = 0; sqIdx < (v.ship_deployed || []).length; sqIdx++) {
          try {
            const sq = v.ship_deployed[sqIdx];
            if (!sq || (sq.count || 0) <= 0) continue;
            const stance = window.squadronEffectiveStance(sq); // playtest rebalance: 'auto' resolves to its pick
            if (stance !== 'attack_strike_craft' && stance !== 'attack_capitals' && stance !== 'attack_escorts') continue;
            const sqShip = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
            // Squadron Movement Diagnostics build (this session): the two
            // checks below (!sqShip and !selfPos) used to fail completely
            // silently -- a stance-set squadron with neither a strike-craft
            // token at all (never launched onto ANY battle map, just sitting
            // in ship_deployed) nor a token ON THIS battle's grid specifically
            // would just do nothing, every round, with zero feedback anywhere
            // in the chat log. That silence was itself reported as "squadrons
            // don't move" with no way to tell whether that's a real bug or an
            // unlaunched squadron -- these two lines exist purely to make
            // that distinction visible without changing any behavior.
            if (!sqShip) {
                chatLines.push(`🤖 [AI STANCE] ${sq.name} has an AI stance set but was never launched onto a battle map (no strike-craft token exists) -- holds position.`);
                continue;
            }
            const selfPos = window.getBattleTokenPosition(sqShip.id);
            if (!selfPos) {
                chatLines.push(`🤖 [AI STANCE] ${sq.name} has an AI stance set but has no token on THIS battle's grid this round -- holds position.`);
                continue; // no grid token this round -- can't range/nearest-check, skip (fails open, same as every other stance/PD check in this function)
            }

            const moveDist = sqShip.tactical_speed || SQUADRON_TACTICAL_SPEED;

            // --- Squadron Movement + Retreat (this session): low-HP break-off ---
            const hpPct = sq.max_hp > 0 ? (sq.hp / sq.max_hp) : 1;
            if (hpPct < 0.30) {
                const carrierPos = window.getBattleTokenPosition(v.id);
                if (carrierPos) {
                    const movedTokens = moveTokenToward(sqShip.id, carrierPos, moveDist);
                    if (movedTokens) { await saveBattleTokens(movedTokens); if (typeof window.terrainFlushDebris === 'function') await window.terrainFlushDebris(); }
                    chatLines.push(`🤖 [AI STANCE] ${sq.name} drops below 30% strength and breaks off, retreating toward ${v.name}.`);
                } // carrier not on the grid -- nothing to retreat toward, holds position silently
                continue; // no fire while retreating
            }

            let candidates = tokens
                .map(tok => globalShipMarkersCache.find(m => m.id === tok.ship_marker_id))
                .filter(Boolean)
                .filter(m => m.id !== sqShip.id && !window.ownerIdsShareOwner(window.vesselOwnerIds(m), window.vesselOwnerIds(sqShip)));

            if (stance === 'attack_strike_craft') {
                candidates = candidates.filter(m => m.is_strike_craft);
            } else if (stance === 'attack_capitals') {
                // Auto: untagged non-strike-craft ships count as capitals too (see pickSquadronAutoStance).
                candidates = candidates.filter(m => !m.is_strike_craft && (m.vessel_class === 'Capital' || (sq.ai_stance === 'auto' && m.vessel_class !== 'Escort')));
            } else {
                candidates = candidates.filter(m => !m.is_strike_craft && m.vessel_class === 'Escort');
            }
            // Squadron Movement Diagnostics build (this session): was a
            // silent `continue` -- now logs why, same reasoning as the
            // !sqShip/!selfPos checks above. Most likely cause: no ship on
            // the grid has a DIFFERENT owner_id than this squadron (the
            // app's existing friend/foe convention -- see findEligiblePD's
            // comment above) matching this stance's class filter, e.g. two
            // NPC-side ships that both have no owner_id assigned look like
            // the same "side" to this check.
            if (candidates.length === 0) {
                chatLines.push(`🤖 [AI STANCE] ${sq.name} (${stance.replace(/_/g, ' ')}) has no eligible enemy target on the grid this round -- holds position.`);
                continue; // nothing eligible this round -- same as a manual player choosing not to fire
            }

            let bestTarget = null, bestDist = Infinity, bestTargetPos = null;
            candidates.forEach(m => {
                const pos = window.getBattleTokenPosition(m.id);
                if (!pos) return;
                const d = Math.hypot(pos.x - selfPos.x, pos.y - selfPos.y);
                if (d < bestDist) { bestDist = d; bestTarget = m; bestTargetPos = pos; }
            });
            if (!bestTarget) continue;

            // --- Squadron Movement + Retreat (this session): advance on target ---
            const movedTokens = moveTokenToward(sqShip.id, bestTargetPos, moveDist);
            if (movedTokens) { await saveBattleTokens(movedTokens); if (typeof window.terrainFlushDebris === 'function') await window.terrainFlushDebris(); }
            const movedSelfTok = movedTokens ? movedTokens.find(t => t.ship_marker_id === sqShip.id) : null;
            const newSelfPos = movedSelfTok ? { x: movedSelfTok.x, y: movedSelfTok.y } : selfPos;

            const dbStats = STRIKE_CRAFT_DB[sq.type];
            if (!dbStats) continue;
            const desiredRole = stance === 'attack_strike_craft' ? 'anti_fighter' : 'anti_capital';
            // Squadron Ordnance build (this session, confirmed design: "also
            // wire AI stances to auto-launch it"): for the two anti-capital
            // stances, an available ordnance-classified weapon of the
            // desired role is now preferred over a same-role direct-fire one
            // -- without this preference, an AI squadron would never
            // actually pick Ship Killer/Capitol Killer Missiles in practice,
            // since each catalog entry in STRIKE_CRAFT_DB (js/combat.js)
            // happens to list its non-ordnance anti_capital weapon (Hunter
            // Seeker Rockets / Micro Railgun) BEFORE its ordnance one, and a
            // plain findIndex(role-match) would keep silently skipping the
            // newly-functional mechanic this build exists to close. Attack
            // Strike Craft is untouched -- no squadron weapon is both
            // anti_fighter and ordnance-classified today anyway.
            // Weapon Cooldowns build (this session): every candidate index
            // below is now filtered to weapons NOT currently on cooldown for
            // THIS squadron instance (squadronWeaponCooldown, defined near
            // the top of this function) -- same hard-skip-on-cooldown rule
            // automated ship PD/squadron intercept already use, extended to
            // offensive auto-fire. Preference order otherwise unchanged: an
            // available ordnance weapon of the desired role first (anti_capital
            // stances only, see comment above), then any same-role weapon,
            // then any weapon at all (the old unconditional "index 0"
            // fallback, now also cooldown-filtered) -- and if literally every
            // weapon on this squadron is on cooldown, it holds fire this
            // round instead of the old guaranteed-fire fallback.
            let wpnIdx = -1;
            if (desiredRole === 'anti_capital') {
                wpnIdx = dbStats.weapons.findIndex((w, i) => w.role === desiredRole && w.weapon_class === 'ordnance' && squadronWeaponCooldown(sq, i) === 0);
            }
            if (wpnIdx < 0) wpnIdx = dbStats.weapons.findIndex((w, i) => w.role === desiredRole && squadronWeaponCooldown(sq, i) === 0);
            if (wpnIdx < 0) wpnIdx = dbStats.weapons.findIndex((w, i) => squadronWeaponCooldown(sq, i) === 0);
            if (wpnIdx < 0) {
                chatLines.push(`🤖 [AI STANCE] ${sq.name} (${stance.replace(/_/g, ' ')}) has every weapon on cooldown -- holds fire.`);
                continue;
            }
            const wpn = dbStats.weapons[wpnIdx];

            // Strike-Craft Weapon Range build (this session, confirmed
            // design): hold fire this round if still out of range after
            // moving -- the squadron has already closed distance above, it
            // just doesn't get a shot off yet. wpn.range falsy (shouldn't
            // happen now that every STRIKE_CRAFT_DB weapon has one, but
            // fails open consistent with every other range check in this
            // build) means unlimited, same convention as ship_weapons.
            const postMoveDist = Math.hypot(bestTargetPos.x - newSelfPos.x, bestTargetPos.y - newSelfPos.y);
            // Weapon Range Tiers build (this session): was a raw wpn.range
            // check -- now folds in the strike-craft-vs-capital short-range
            // cap and the Messenger uplink exception (getEffectiveWeaponRange
            // above), same rule the manual FIRE path enforces.
            const effRangeForFire = getEffectiveWeaponRange(wpn, sqShip, bestTarget);
            if (wpn && effRangeForFire && postMoveDist > effRangeForFire) {
                chatLines.push(`🤖 [AI STANCE] ${sq.name} (${stance.replace(/_/g, ' ')}) closes on ${bestTarget.name} but is still out of ${wpn.name}'s range (${effRangeForFire}) -- holds fire.`);
                continue;
            }

            // Squadron Target Uplink build (this session): cheap chat-log
            // tell so an uplinked shot doesn't look like a silent range-rule
            // violation to whoever's watching the log -- no other visual
            // indicator exists yet for which enemy ships are uplinked this
            // round (flagged, not built -- see Pending list).
            const sqTerrain = typeof window.terrainFireCheck === 'function' ? window.terrainFireCheck(sqShip.id, bestTarget.id) : '';
            if (sqTerrain) { chatLines.push(`🤖 [AI STANCE] ${sq.name} can't engage ${bestTarget.name}: ${sqTerrain} -- holds fire.`); continue; }
            const uplinkNote = (wpn.range > 0 && effRangeForFire === 0) ? ' (target uplinked!)' : '';
            chatLines.push(`🤖 [AI STANCE] ${sq.name} (${stance.replace(/_/g, ' ')}) engages ${bestTarget.name}${uplinkNote}.`);
            // Squadron Ordnance build (this session): an ordnance-classified
            // pick (see the weapon-selection comment above) routes through
            // the tracked multi-turn launch instead of an instant-resolve
            // shot -- same routing rule the manual FIRE/LAUNCH button pair
            // uses (window.updateSquadronTargetOptions, js/combat.js).
            // launchSquadronOrdnance itself falls back to
            // resolveSquadronWeaponFire if the squadron somehow isn't a
            // battle-map token this round, so this is safe even though the
            // caller above already guarantees selfPos is valid.
            if (wpn && wpn.weapon_class === 'ordnance' && typeof window.launchSquadronOrdnance === 'function') {
                await window.launchSquadronOrdnance(v.id, sqIdx, wpnIdx, bestTarget.id, { auto: true });
            } else if (typeof window.resolveSquadronWeaponFire === 'function') {
                await window.resolveSquadronWeaponFire(v.id, sqIdx, wpnIdx, bestTarget.id, { auto: true });
            }
          } catch (err) {
            console.error('processBattleRoundAutomations: squadron AI stance failed, skipping this squadron this round', err);
          }
        }
    }

    /* --- DM-AI-for-NPCs build (this session) ---
       ai_controlled ship_markers fight on their own during Advance Round:
       "attack closest in range, move closer if necessary" (confirmed
       design), with one override -- if this vessel took a bigger single hit
       THIS round from someone other than whoever it's about to engage, it
       retargets onto that bigger threat instead ("biggest single hit this
       round" model, confirmed with the DM over a running per-attacker
       damage total).

       Runs after the squadron AI-stance block above so an AI ship never
       fires from a position it didn't survive this round's PD/squadron-
       intercept fire to hold -- same ordering rationale as squadron AI
       stances above it.

       Judgment calls made here, NOT separately confirmed with the DM
       (flagging per this project's convention rather than implying full
       completeness):
         - Point-defense-flagged weapons (is_point_defense) are excluded
           from an AI ship's own direct-fire loop -- they're already
           committed to the automated defensive PD pool built at the top of
           this function, and re-firing them here as an offensive weapon
           didn't seem right for what "point defense" is supposed to mean.
         - An AI ship fires EVERY eligible (in-range, off-cooldown, has
           ammo) non-PD weapon at its locked target each round, not just
           one -- unlike a squadron (one weapon platform), a multi-mount
           ship emptying everything it has at its target each round is
           closer to how a human player would actually play the ship.
         - Target selection is recomputed fresh every round (nearest, or
           the round's biggest-hit attacker if that's someone else) rather
           than "sticking" to a previous lock once acquired -- matches the
           DM's literal wording ("attack closest... but if taking heavy
           fire... re-prioritize") more directly than a stickier model
           would. ai_current_target_id is still written every round as an
           informational "who is it engaging right now" breadcrumb (same
           convention as squadrons' sq.target_id) -- it isn't itself
           authoritative for next round's decision.
         - No is_hidden (Fog of War) exclusion on candidate targets --
           mirrors the squadron AI-stance block above, which doesn't check
           it either.
         - Confirmed with the DM via AskUserQuestion: target scope is ANY
           enemy vessel on the grid (strike craft included), not just
           Capital/Escort-class ships -- a literal reading of "attack
           closest in range".
       Resolution goes through window.resolveShipWeaponFire (js/combat.js)
       and window.resolveOrdnanceLaunch (this file) -- the same
       extracted-core pattern this app already uses for squadrons
       (window.resolveSquadronWeaponFire), so there's one implementation of
       "a ship fires its weapon", not two. */
    for (const tok of tokens.slice()) {
      try {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!v || !v.ai_controlled) continue;
        if ((v.integrity_hull || 0) <= 0) continue; // destroyed earlier this same pass -- don't act

        const selfPos = { x: tok.x, y: tok.y };
        // Playtest rebalance: stations / speed-0 hulls hold position (they
        // used to fall back to 160 here because 0 is falsy).
        const moveDist = (v.is_station || v.tactical_speed === 0) ? 0 : (v.tactical_speed || 160);

        const candidates = tokens
            .map(t => globalShipMarkersCache.find(m => m.id === t.ship_marker_id))
            .filter(Boolean)
            .filter(m => m.id !== v.id && !window.ownerIdsShareOwner(window.vesselOwnerIds(m), window.vesselOwnerIds(v)));

        if (candidates.length === 0) {
            chatLines.push(`🤖 [AI CONTROLLED] ${v.name} has no eligible enemy target on the grid this round -- holds position.`);
            if (v.ai_current_target_id || v.round_biggest_hit_amount || v.round_biggest_hit_by) {
                await db.from('ship_markers').update({ ai_current_target_id: null, round_biggest_hit_amount: 0, round_biggest_hit_by: null }).eq('id', v.id);
                Object.assign(v, { ai_current_target_id: null, round_biggest_hit_amount: 0, round_biggest_hit_by: null });
            }
            continue;
        }

        let nearest = null, nearestDist = Infinity, nearestPos = null;
        candidates.forEach(m => {
            const pos = window.getBattleTokenPosition(m.id);
            if (!pos) return;
            const d = Math.hypot(pos.x - selfPos.x, pos.y - selfPos.y);
            if (d < nearestDist) { nearestDist = d; nearest = m; nearestPos = pos; }
        });
        if (!nearest) continue; // none of the candidates have a resolvable grid position this round

        // --- Threat reprioritization override ---
        let target = nearest, targetPos = nearestPos;
        const hitBy = v.round_biggest_hit_by;
        if (hitBy && hitBy !== nearest.id) {
            const attacker = candidates.find(m => m.id === hitBy);
            const attackerPos = attacker ? window.getBattleTokenPosition(attacker.id) : null;
            if (attacker && attackerPos) {
                target = attacker;
                targetPos = attackerPos;
                chatLines.push(`🤖 [AI CONTROLLED] ${v.name} took a heavy hit (${v.round_biggest_hit_amount}) from ${attacker.name} this round and re-prioritizes onto the greater threat.`);
            } // attacker no longer a valid/present candidate (destroyed, withdrawn, or same side now) -- falls back to nearest silently
        }

        // --- Playtest rebalance (2026-10-03, DM): automatic stance ---
        const newStance = window.pickAiShipStance(v, target);
        if (newStance !== (v.ship_stance || 'Balanced')) {
            chatLines.push(`🤖 [AI CONTROLLED] ${v.name} shifts to ${newStance} stance.`);
            v.ship_stance = newStance;
        }

        // --- Move up to tactical_speed px toward the target's current position
        // (Evasive: away from it instead -- breaking off, still firing what reaches) ---
        let moveGoal = targetPos;
        if (v.ship_stance === 'Evasive') {
            const dx = selfPos.x - targetPos.x, dy = selfPos.y - targetPos.y, len = Math.hypot(dx, dy) || 1;
            moveGoal = clampToGrid(selfPos.x + dx / len * moveDist, selfPos.y + dy / len * moveDist);
        }
        const movedTokens = moveDist > 0 ? moveTokenToward(v.id, moveGoal, moveDist) : null;
        if (movedTokens) { await saveBattleTokens(movedTokens); if (typeof window.terrainFlushDebris === 'function') await window.terrainFlushDebris(); }
        const movedSelfTok = movedTokens ? movedTokens.find(t => t.ship_marker_id === v.id) : null;
        const newSelfPos = movedSelfTok ? { x: movedSelfTok.x, y: movedSelfTok.y } : selfPos;
        // Firing arcs (Phase 3, DM-confirmed): turn to bring the biggest
        // arc-limited gun to bear before firing. No-op while arcs are off.
        if (typeof window.aiTurnToward === 'function') {
            const turnedTo = await window.aiTurnToward(v, target);
            if (turnedTo !== null) chatLines.push(`🤖 [AI CONTROLLED] ${v.name} comes about to ${String(turnedTo).padStart(3, '0')}°.`);
        }

        // --- Fire every eligible non-PD weapon (direct-fire AND ordnance) ---
        let firedAny = false;
        for (let wIdx = 0; wIdx < (v.ship_weapons || []).length; wIdx++) {
            const wpn = v.ship_weapons[wIdx];
            if (!wpn || wpn.is_point_defense) continue;
            if ((wpn.cooldown || 0) > 0) continue;
            if (wpn.ammo === 0) continue;
            const postMoveDist = Math.hypot(targetPos.x - newSelfPos.x, targetPos.y - newSelfPos.y);
            const effRange = getEffectiveWeaponRange(wpn, v, target);
            if (effRange && postMoveDist > effRange) continue; // this weapon holds fire this round; other weapons on this same ship are still checked independently
            if (typeof window.isTargetInArc === 'function' && !window.isTargetInArc(v.id, target.id, wpn)) continue; // out of arc even after turning
            if (typeof window.terrainFireCheck === 'function' && window.terrainFireCheck(v.id, target.id)) continue; // Phase 10: blocked by terrain

            if (wpn.weapon_class === 'ordnance' && typeof window.resolveOrdnanceLaunch === 'function') {
                await window.resolveOrdnanceLaunch(v.id, wIdx, target.id, { auto: true });
            } else if (typeof window.resolveShipWeaponFire === 'function') {
                await window.resolveShipWeaponFire(v.id, wIdx, target.id, 1, { auto: true });
            }
            firedAny = true;
        }
        chatLines.push(firedAny
            ? `🤖 [AI CONTROLLED] ${v.name} ${v.ship_stance === 'Evasive' ? 'breaks off, firing on' : 'engages'} ${target.name}.`
            : `🤖 [AI CONTROLLED] ${v.name} ${v.ship_stance === 'Evasive' ? 'breaks off from' : 'closes on'} ${target.name} but has no weapon in range or arc -- holds fire.`);

        // --- Persist target lock (informational) + reset this round's hit tracking ---
        await db.from('ship_markers').update({ ai_current_target_id: target.id, round_biggest_hit_amount: 0, round_biggest_hit_by: null, ship_stance: v.ship_stance || 'Balanced' }).eq('id', v.id);
        Object.assign(v, { ai_current_target_id: target.id, round_biggest_hit_amount: 0, round_biggest_hit_by: null });
      } catch (err) {
        console.error('processBattleRoundAutomations: AI-controlled ship resolution failed, skipping this ship this round', err);
      }
    }

    // --- Persist everything touched ---
    for (const v of touchedVessels.values()) {
      try {
        await db.from('ship_markers').update({
            ship_weapons: v.ship_weapons,
            integrity_shields: v.integrity_shields, integrity_hull: v.integrity_hull,
            integrity_reactive: v.integrity_reactive, integrity_ablative: v.integrity_ablative,
            integrity_hardened: v.integrity_hardened,
            ...(v.armor_sides ? { armor_sides: v.armor_sides } : {}), // Phase 5 directional armor
            // DM-AI-for-NPCs build (this session): rides along with every
            // other mutation this loop already persists for a touched
            // vessel -- covers the ordnance-impact path above, which (unlike
            // resolveShipWeaponFire/resolveSquadronWeaponFire) mutates the
            // cache in-memory here and defers to this shared persist loop
            // rather than self-persisting per-hit.
            round_biggest_hit_amount: v.round_biggest_hit_amount || 0, round_biggest_hit_by: v.round_biggest_hit_by || null
        }).eq('id', v.id);
      } catch (err) {
        console.error('processBattleRoundAutomations: failed to persist vessel', v.id, err);
      }
    }
    // Carriers whose deployed squadrons took PD damage need ship_deployed saved too.
    for (const cid of touchedCarrierIds) {
      try {
        const carrier = globalShipMarkersCache.find(m => m.id === cid);
        if (carrier) await db.from('ship_markers').update({ ship_deployed: carrier.ship_deployed }).eq('id', cid);
      } catch (err) {
        console.error('processBattleRoundAutomations: failed to persist carrier ship_deployed', cid, err);
      }
    }

    battle.in_flight_ordnance = survivingOrdnance;
    battle.ordnance_outcomes = ordnanceOutcomes;
    try {
        await db.from('battle_encounters').update({ in_flight_ordnance: survivingOrdnance, ordnance_outcomes: ordnanceOutcomes }).eq('id', battle.id);
    } catch (err) {
        console.error('processBattleRoundAutomations: failed to persist in_flight_ordnance', err);
    }

    for (const line of chatLines) {
      try {
        await db.from('chat_logs').insert({ sender_id: null, content: line, message_type: 'system' });
      } catch (err) {
        console.error('processBattleRoundAutomations: failed to post chat log line', line, err);
      }
    }

    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
};
