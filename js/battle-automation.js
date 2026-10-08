/* ==========================================================================
   js/battle-automation.js - Per-round battle automation: the damage dice
   helper, AI stance pickers for ships and squadrons, and
   processBattleRoundAutomations (ordnance aging, point defense, squadron
   and AI-ship actions).
   Classic script sharing the global scope: loads right after battle-map.js
   (see index.html for the order) and uses its helpers (moveTokenToward,
   getEffectiveWeaponRange, saveBattleTokens, ...).
   ========================================================================== */
// Shared dice roller (NdX, optional exploding dice, flat modifier).
// Adds the hidden calibration bonus (window.hiddenDamageBonus, js/combat.js)
// unless noBonus is set; the bonus is not shown in breakdownText.
// Returns { total, breakdownText }.
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

/* processBattleRoundAutomations runs on each Advance Round (called from
   js/combat.js advanceCombatRound). No-op outside an active battle.

   Ordnance: a salvo launches with turns_remaining=3. Each tick it gets one
   PD interception attempt; if it survives, turns_remaining drops by 1. On
   the 3 -> 2 tick a multi-pattern salvo splits into 6 independent payloads.
   At 0 it impacts via resolveShipDamage.

   PD: every off-cooldown, ammo-holding is_point_defense weapon on the grid
   joins one shared per-round pool. Ordnance is resolved first (the target's
   own or an allied escort's PD, by live distance to the target); what is
   left fires at enemy strike craft, using each squadron's own grid token
   position. Any nonzero PD hit destroys a payload outright (no payload
   toughness stat). Squadrons without a grid token are skipped (fails open).
*/
/* AI ships pick their own stance each round (DM rule): hull under 25% ->
   Evasive (also moves away from its target), under 50% -> Defensive, else
   Aggressive if in better shape (hull %) than its target, else Balanced.
   A stance set by hand on an AI ship is overridden next round; take the
   ship off AI to hold a stance. Thresholds are first-pass numbers. */
window.AI_SHIP_STANCE_THRESHOLDS = { EVASIVE: 0.25, DEFENSIVE: 0.50 };
window.pickAiShipStance = function(v, target) {
    const pct = (m) => (m && m.max_hull > 0) ? (m.integrity_hull || 0) / m.max_hull : 1;
    const own = pct(v), th = window.AI_SHIP_STANCE_THRESHOLDS;
    if (own < th.EVASIVE) return 'Evasive';
    if (own < th.DEFENSIVE) return 'Defensive';
    if (target && own > pct(target)) return 'Aggressive';
    return 'Balanced';
};

/* Squadron "Auto" stance. Launched squadrons default to ai_stance 'auto';
   each round this picks a concrete stance (stored as sq.ai_auto_pick) that
   the normal stance rules then run with. Role-weighted (DM decision):
     - PD chassis (Messenger): enemy ordnance inbound on a friendly ->
       intercept munitions; enemy fighters within reach -> attack strike
       craft; enemy ship within MEDIUM -> attack it; else hold as an
       interceptor screen.
     - Anti-fighter chassis (Raven): fighters within reach -> attack strike
       craft; otherwise the nearest enemy ship's class.
     - Everything else: capitals, then escorts, then strike craft.
   "Within reach" = SQUADRON_AUTO_REACH px. In Auto, Attack Capital Ships
   also takes untagged non-strike-craft ships so fighters don't idle. */
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

    // Carriers whose ship_deployed changed (cooldowns, squadron HP); saved at the end.
    const touchedCarrierIds = new Set();

    // Squadron weapon cooldowns live on the deployed squadron
    // (sq.weapon_cooldowns[wpnIdx]), since STRIKE_CRAFT_DB is a shared catalog.
    function squadronWeaponCooldown(sq, wpnIdx) {
        return (sq.weapon_cooldowns && sq.weapon_cooldowns[wpnIdx]) || 0;
    }

    // Resolve every Auto squadron's stance before the intercept pool and
    // offensive passes below read it.
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
            // An interceptor screen moves to cover the nearest friendly ship
            // with enemy ordnance inbound, else its own carrier, staying
            // within 75% of strike-craft gun reach.
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

    // Shared per-round pool of available PD weapons: { vesselId, weaponIdx, position, ownerIds }
    let pdPool = [];
    tokens.forEach(tok => {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!v) return;
        // A Sensors-disabled vessel drops out of the PD pool for the round.
        if ((v.disabled_sensors_until || 0) > 0) return;
        (v.ship_weapons || []).forEach((w, wIdx) => {
            if (!w.is_point_defense) return;
            if ((w.cooldown || 0) > 0) return; // hard skip: no one to confirm a cooldown override on an automated tick
            if (w.ammo === 0) return;
            pdPool.push({ vesselId: v.id, weaponIdx: wIdx, position: { x: tok.x, y: tok.y }, ownerIds: window.vesselOwnerIds(v) });
        });
    });

    // Pool search. Default: PD of the SAME side as ownerIds (escort screening
    // for a threatened ship). opts.enemyOnly: PD of the OPPOSING side
    // (anti-fighter fire), so a ship never shoots down its own squadrons.
    // A weapon with no range has unlimited reach. Returns pool index or -1.
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
        // A nonzero cooldown_period (opt-in) keeps the weapon out of the pool
        // for that many extra rounds; without one it fires once per round.
        if (pdWpn.cooldown_period > 0) pdWpn.cooldown = pdWpn.cooldown_period;
        markTouched(pdVessel);
        // Firing reveals the PD ship (Fog of War). Fire-and-forget: this
        // helper is called from forEach callbacks, so it can't await.
        if (typeof window.revealVesselIfHidden === 'function') window.revealVesselIfHidden(pdVessel).catch(err => console.error('fireEligiblePD: reveal-on-fire failed', err));
        return { pdVessel, pdWpn, roll };
    }

    /* --- Intercept Munitions squadrons ---
       A separate pool from ship PD (squadron weapons live in STRIKE_CRAFT_DB,
       not ship_weapons). Each squadron with this stance offers ONE intercept
       per round, using its point_defense weapon if off cooldown, else any
       off-cooldown weapon. Tried after ship PD misses a payload. Range is
       measured from the squadron to the defended target, capped by
       strikeCraftRangeCap. Squadrons with no grid token are skipped. */
    let squadronInterceptPool = [];
    globalShipMarkersCache.forEach(v => {
        (v.ship_deployed || []).forEach((sq, sqIdx) => {
            if (window.squadronEffectiveStance(sq) !== 'intercept_munitions' || (sq.count || 0) <= 0) return;
            const sqShip = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
            if (!sqShip) return;
            // A Sensors-disabled squadron drops out of the intercept pool.
            if ((sqShip.disabled_sensors_until || 0) > 0) return;
            const pos = window.getBattleTokenPosition(sqShip.id);
            if (!pos) return; // no grid token this round: can't range-check, skip (fails open)
            const dbStats = STRIKE_CRAFT_DB[sq.type];
            if (!dbStats) return;
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
        // Cooldown is stored on the live deployed squadron, looked up by
        // carrierId/sqIdx (entry.wpn is a shared catalog object).
        if (entry.wpn.cooldown_period > 0) {
            const carrier = globalShipMarkersCache.find(m => m.id === entry.carrierId);
            const liveSq = carrier && (carrier.ship_deployed || [])[entry.sqIdx];
            if (liveSq) {
                liveSq.weapon_cooldowns = liveSq.weapon_cooldowns || {};
                liveSq.weapon_cooldowns[entry.wpnIdx] = entry.wpn.cooldown_period;
                touchedCarrierIds.add(entry.carrierId);
            }
        }
        // Firing reveals the squadron (Fog of War); fire-and-forget.
        if (typeof window.revealVesselIfHidden === 'function') {
            const sqShip = globalShipMarkersCache.find(m => m.id === entry.sqShipId);
            if (sqShip) window.revealVesselIfHidden(sqShip).catch(err => console.error('fireEligibleSquadronIntercept: reveal-on-fire failed', err));
        }
        return { entry, roll };
    }

    // --- Age & resolve in-flight ordnance ---
    // Each salvo/squadron/ship below is wrapped in its own try/catch so one
    // failure (e.g. a transient DB error) doesn't discard every other
    // result or skip the chat log and UI refresh in advanceCombatRound.
    const survivingOrdnance = [];
    // How each payload that left the list ended (hit / intercept / fizzle),
    // saved with the battle row so every client's 3D view plays the right effect.
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

        // An Intercept Munitions squadron gets a shot if ship PD didn't kill it.
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
            // Impact. Only the target's current stance modifies damage; the
            // launcher's stance is not applied to ordnance.
            let dmgType = window.normalizeDamageType ? window.normalizeDamageType(salvo.damage_type || 'Impact') : (salvo.damage_type || 'Impact');
            const roll = rollDamageDice(salvo.dice, salvo.modifier, salvo.explodes);
            let total = roll.total;
            let impactLog = '';
            let tStance = targetVessel.ship_stance || 'Balanced';
            if (tStance === 'Defensive') { total = Math.floor(total * 0.75); impactLog += `[Target Defensive: -25% Dmg] `; }
            else if (tStance === 'Evasive') { total = Math.floor(total * 0.50); impactLog += `[Target Evasive: -50% Dmg] `; }
            else if (tStance === 'Aggressive') { total = Math.floor(total * 1.25); impactLog += `[Target Aggressive: +25% Dmg] `; }
            // total is not clamped to 0, matching rollShipWeapon (js/combat.js).
            // Directional armor: side facing the launch point (fallback: the launcher's current spot, else front).
            const impactSource = (salvo.launch_x !== null && salvo.launch_x !== undefined) ? { point: { x: salvo.launch_x, y: salvo.launch_y } } : { vesselId: salvo.source_vessel_id };
            const result = window.resolveShipDamage(targetVessel, dmgType, total, typeof window.damageSideOpts === 'function' ? window.damageSideOpts(targetVessel, impactSource) : undefined);
            impactLog += result.log;
            // Track the biggest single hit this round for AI ship threat
            // reprioritization (see resolveShipWeaponFire, js/combat.js).
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

            // AOE splash: opt-in per-weapon aoe_radius, snapshotted on the
            // salvo at launch. Every other token within radius of the primary
            // target takes the same rolled total (no PD roll for splash),
            // with each victim's own stance modifier. Applies per payload.
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
                        // Directional armor: side facing the blast centre (the primary target).
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

            // Drop a destroyed target from both pools so it can't fire again
            // later in this pass.
            pdPool = pdPool.filter(entry => entry.vesselId !== targetVessel.id);
            squadronInterceptPool = squadronInterceptPool.filter(entry => entry.sqShipId !== targetVessel.id);
            markOutcome(salvo, 'hit');
            continue; // consumed on impact, dropped from survivingOrdnance
        }

        // Survives to next round.
        const updated = { ...salvo, turns_remaining: turnsLeft };
        // A 'single'-pattern salvo never splits. Older salvos have no
        // ordnance_pattern, hence `!== 'single'` rather than `=== 'multi'`.
        if (!salvo.split && salvo.ordnance_pattern !== 'single' && turnsLeft === 2) {
            // Split into 6 independent payloads.
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

    // --- PD vs deployed strike craft (by the squadron's own grid position) ---
    globalShipMarkersCache.forEach(v => {
        (v.ship_deployed || []).forEach(sq => {
          try {
            if ((sq.count || 0) <= 0) return;
            const sqShip = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
            if (!sqShip) return;
            const targetPos = window.getBattleTokenPosition(sqShip.id);
            if (!targetPos) return; // no grid token this round: can't range-check, skip
            // enemyOnly: the opposing side's PD fires at this strike craft.
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
            // Remove the token if this killed the squadron. Unawaited (inside
            // forEach); saveBattleTokens updates the token cache synchronously
            // before its first await, so later passes already see the removal.
            if (typeof window.checkBattleTokenDestroyed === 'function') checkBattleTokenDestroyed(sqShip);
          } catch (err) {
            console.error('processBattleRoundAutomations: strike-craft PD engagement failed, skipping this squadron this round', sq, err);
          }
        });
    });

    /* --- Squadron offensive stances (attack_strike_craft / attack_capitals /
       attack_escorts) ---
       Runs after both PD passes, so a squadron only acts if it survived
       this round's defensive fire. Once per round, each such squadron:
         0. Below 30% HP breaks off: moves toward its carrier and does not
            fire. 30% is a placeholder threshold. Intercept Munitions
            squadrons never retreat.
         1. Picks eligible enemy tokens (other side by owner) filtered by
            stance: is_strike_craft, or vessel_class 'Capital' / 'Escort'.
            Ships with no vessel_class are ignored (except Auto, see
            pickSquadronAutoStance).
         2. Targets the nearest by live grid distance.
         3. Moves up to tactical_speed px toward it (moveTokenToward).
         4. Picks a weapon: for anti-capital stances an ordnance weapon of
            that role first, then any weapon of the stance's role
            (anti_fighter / anti_capital), then any weapon; all must be off
            cooldown.
         5. Fires only if the post-move distance is within effective range;
            otherwise holds fire and keeps closing next round.
       Fire goes through window.resolveSquadronWeaponFire (same path as the
       manual FIRE button) or launchSquadronOrdnance for ordnance. */
    for (const v of globalShipMarkersCache.slice()) {
        for (let sqIdx = 0; sqIdx < (v.ship_deployed || []).length; sqIdx++) {
          try {
            const sq = v.ship_deployed[sqIdx];
            if (!sq || (sq.count || 0) <= 0) continue;
            const stance = window.squadronEffectiveStance(sq); // 'auto' resolves to its pick
            if (stance !== 'attack_strike_craft' && stance !== 'attack_capitals' && stance !== 'attack_escorts') continue;
            const sqShip = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
            // Log why a stance-set squadron does nothing: never launched (no
            // strike-craft token), or no token on this battle's grid.
            if (!sqShip) {
                chatLines.push(`🤖 [AI STANCE] ${sq.name} has an AI stance set but was never launched onto a battle map (no strike-craft token exists) -- holds position.`);
                continue;
            }
            const selfPos = window.getBattleTokenPosition(sqShip.id);
            if (!selfPos) {
                chatLines.push(`🤖 [AI STANCE] ${sq.name} has an AI stance set but has no token on THIS battle's grid this round -- holds position.`);
                continue; // can't range/nearest-check without a grid token (fails open)
            }

            const moveDist = sqShip.tactical_speed || SQUADRON_TACTICAL_SPEED;

            // --- Low-HP break-off ---
            const hpPct = sq.max_hp > 0 ? (sq.hp / sq.max_hp) : 1;
            if (hpPct < 0.30) {
                const carrierPos = window.getBattleTokenPosition(v.id);
                if (carrierPos) {
                    const movedTokens = moveTokenToward(sqShip.id, carrierPos, moveDist);
                    if (movedTokens) { await saveBattleTokens(movedTokens); if (typeof window.terrainFlushDebris === 'function') await window.terrainFlushDebris(); }
                    chatLines.push(`🤖 [AI STANCE] ${sq.name} drops below 30% strength and breaks off, retreating toward ${v.name}.`);
                } // carrier not on the grid: holds position silently
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
            // Most common cause: no ship with a DIFFERENT owner matches the
            // stance filter (e.g. two NPC ships with no owner_id count as one side).
            if (candidates.length === 0) {
                chatLines.push(`🤖 [AI STANCE] ${sq.name} (${stance.replace(/_/g, ' ')}) has no eligible enemy target on the grid this round -- holds position.`);
                continue;
            }

            let bestTarget = null, bestDist = Infinity, bestTargetPos = null;
            candidates.forEach(m => {
                const pos = window.getBattleTokenPosition(m.id);
                if (!pos) return;
                const d = Math.hypot(pos.x - selfPos.x, pos.y - selfPos.y);
                if (d < bestDist) { bestDist = d; bestTarget = m; bestTargetPos = pos; }
            });
            if (!bestTarget) continue;

            // --- Advance on target ---
            const movedTokens = moveTokenToward(sqShip.id, bestTargetPos, moveDist);
            if (movedTokens) { await saveBattleTokens(movedTokens); if (typeof window.terrainFlushDebris === 'function') await window.terrainFlushDebris(); }
            const movedSelfTok = movedTokens ? movedTokens.find(t => t.ship_marker_id === sqShip.id) : null;
            const newSelfPos = movedSelfTok ? { x: movedSelfTok.x, y: movedSelfTok.y } : selfPos;

            const dbStats = STRIKE_CRAFT_DB[sq.type];
            if (!dbStats) continue;
            const desiredRole = stance === 'attack_strike_craft' ? 'anti_fighter' : 'anti_capital';
            // Weapon choice (all off cooldown for this squadron): anti-capital
            // stances prefer an ordnance weapon of that role, because catalog
            // entries list the direct-fire anti_capital weapon first; then any
            // weapon of the desired role; then any weapon. All on cooldown ->
            // hold fire.
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

            // Hold fire if still out of effective range after moving.
            // getEffectiveWeaponRange applies the strike-craft-vs-capital
            // short-range cap and the Messenger uplink exception (same rule as
            // manual FIRE); a falsy range means unlimited.
            const postMoveDist = Math.hypot(bestTargetPos.x - newSelfPos.x, bestTargetPos.y - newSelfPos.y);
            const effRangeForFire = getEffectiveWeaponRange(wpn, sqShip, bestTarget);
            if (wpn && effRangeForFire && postMoveDist > effRangeForFire) {
                chatLines.push(`🤖 [AI STANCE] ${sq.name} (${stance.replace(/_/g, ' ')}) closes on ${bestTarget.name} but is still out of ${wpn.name}'s range (${effRangeForFire}) -- holds fire.`);
                continue;
            }

            // An effective range of 0 on a ranged weapon means the target is
            // uplinked; noted in the chat log so it doesn't look like a rule break.
            const sqTerrain = typeof window.terrainFireCheck === 'function' ? window.terrainFireCheck(sqShip.id, bestTarget.id) : '';
            if (sqTerrain) { chatLines.push(`🤖 [AI STANCE] ${sq.name} can't engage ${bestTarget.name}: ${sqTerrain} -- holds fire.`); continue; }
            const uplinkNote = (wpn.range > 0 && effRangeForFire === 0) ? ' (target uplinked!)' : '';
            chatLines.push(`🤖 [AI STANCE] ${sq.name} (${stance.replace(/_/g, ' ')}) engages ${bestTarget.name}${uplinkNote}.`);
            // Ordnance weapons launch tracked multi-turn ordnance (same routing as
            // the manual FIRE/LAUNCH buttons); launchSquadronOrdnance falls back
            // to resolveSquadronWeaponFire if the squadron has no battle token.
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

    /* --- AI-controlled ships (ai_controlled) ---
       DM rule: attack the closest enemy in range, moving closer if needed;
       if this ship took a bigger single hit this round from someone else,
       retarget onto that attacker instead. Runs after the squadron passes,
       so a ship only acts if it survived this round's defensive fire.
         - Target scope (DM decision): any enemy vessel, strike craft included.
           No Fog of War (is_hidden) exclusion.
         - Target is recomputed every round; ai_current_target_id is written
           as an informational breadcrumb only.
         - PD weapons are excluded (they belong to the defensive PD pool).
         - Fires EVERY eligible non-PD weapon (in range, in arc, off
           cooldown, has ammo, not blocked by terrain).
       Fire goes through window.resolveShipWeaponFire (js/combat.js) and
       window.resolveOrdnanceLaunch. */
    for (const tok of tokens.slice()) {
      try {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!v || !v.ai_controlled) continue;
        if ((v.integrity_hull || 0) <= 0) continue; // destroyed earlier this pass

        const selfPos = { x: tok.x, y: tok.y };
        // Stations and speed-0 hulls hold position (0 must not fall back to 160).
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
        if (!nearest) continue; // no candidate has a grid position this round

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
            } // attacker gone or no longer an enemy: fall back to nearest silently
        }

        // --- Automatic stance ---
        const newStance = window.pickAiShipStance(v, target);
        if (newStance !== (v.ship_stance || 'Balanced')) {
            chatLines.push(`🤖 [AI CONTROLLED] ${v.name} shifts to ${newStance} stance.`);
            v.ship_stance = newStance;
        }

        // --- Move up to tactical_speed px toward the target
        // (Evasive: away from it instead, still firing whatever reaches) ---
        let moveGoal = targetPos;
        if (v.ship_stance === 'Evasive') {
            const dx = selfPos.x - targetPos.x, dy = selfPos.y - targetPos.y, len = Math.hypot(dx, dy) || 1;
            moveGoal = clampToGrid(selfPos.x + dx / len * moveDist, selfPos.y + dy / len * moveDist);
        }
        const movedTokens = moveDist > 0 ? moveTokenToward(v.id, moveGoal, moveDist) : null;
        if (movedTokens) { await saveBattleTokens(movedTokens); if (typeof window.terrainFlushDebris === 'function') await window.terrainFlushDebris(); }
        const movedSelfTok = movedTokens ? movedTokens.find(t => t.ship_marker_id === v.id) : null;
        const newSelfPos = movedSelfTok ? { x: movedSelfTok.x, y: movedSelfTok.y } : selfPos;
        // Firing arcs: turn to bring the biggest arc-limited gun to bear
        // before firing. No-op while arcs are off.
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
            if (effRange && postMoveDist > effRange) continue; // this weapon holds fire; others still checked
            if (typeof window.isTargetInArc === 'function' && !window.isTargetInArc(v.id, target.id, wpn)) continue; // out of arc even after turning
            if (typeof window.terrainFireCheck === 'function' && window.terrainFireCheck(v.id, target.id)) continue; // blocked by terrain

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
            ...(v.armor_sides ? { armor_sides: v.armor_sides } : {}), // directional armor
            // Hit tracking from ordnance impacts, which mutate the cache here
            // instead of self-persisting like resolveShipWeaponFire.
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
