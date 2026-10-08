/* ==========================================================================
   js/battle-turns.js - Initiative, Action Points, END TURN, token placement / withdrawal / hiding, destruction checks.
   Classic script sharing the global scope: loads right after battle-map.js
   (see index.html for the order).
   ========================================================================== */
// addSquadronToBattleMap / removeBattleTokenByMarkerId live in js/squadrons.js.
// The squadron helpers nested inside window.processBattleRoundAutomations
// (js/battle-automation.js) stay there because they share closure state with
// the PD pool logic.

/* ==========================================================================
   INITIATIVE + ACTION ECONOMY
   ==========================================================================
   DM design (see darkforest-architecture-reference.md), Battle Map only:
   - d20 initiative per token, rolled once per battle (not every round).
   - Fixed Action Point pool per token, refilled at the start of its own
     turn, 1 AP per action, no carryover.
   - Movement is not AP: move_remaining is a soft px budget refilled once per
     full round.
   - AI-stance squadrons and ai_controlled ships get no turn slot; they act
     together in window.processBattleRoundAutomations when the order wraps
     to a new round. PD/intercept is fully reactive, never turn-gated.
   - Not AP-gated: launching/recalling squadrons from the Hangar Bay (no grid
     token yet at launch) and changing a squadron's AI stance. */

/* Returns { sq, carrier } for a strike-craft token: the squadron entry on
   its carrier's ship_deployed array. Needed because the token's own
   ship_markers row has no weapon list (STRIKE_CRAFT_DB is keyed by sq.type).
   Returns null if the carrier or squadron can't be found (stale token). */
function getSquadronRecordForToken(vessel) {
    if (!vessel || !vessel.is_strike_craft || !vessel.parent_id) return null;
    const carrier = globalShipMarkersCache.find(m => m.id === vessel.parent_id);
    if (!carrier) return null;
    const sq = (carrier.ship_deployed || []).find(s => s.id === vessel.squadron_id);
    if (!sq) return null;
    return { sq, carrier };
}

/* DM rule: AP per turn = 1 + floor(weaponCount / 2). A 2-weapon squadron
   gets 2 AP, a 12-weapon cruiser gets 7, an unarmed token still gets 1 so it
   can take a non-fire action (Withdraw, etc.). */
window.getTokenApMax = function(vessel) {
    if (!vessel) return 1;
    let weaponCount;
    if (vessel.is_strike_craft) {
        const rec = getSquadronRecordForToken(vessel);
        const dbStats = rec && typeof STRIKE_CRAFT_DB !== 'undefined' ? STRIKE_CRAFT_DB[rec.sq.type] : null;
        weaponCount = dbStats ? (dbStats.weapons || []).length : 1;
    } else {
        weaponCount = (vessel.ship_weapons || []).length;
    }
    return 1 + Math.floor(weaponCount / 2);
};

/* A token gets an initiative slot only if it isn't AI-controlled: ships
   without ai_controlled, and squadrons whose ai_stance is unset or 'manual'. */
function tokenIsInitiativeEligible(vessel) {
    if (!vessel) return false;
    if (vessel.is_strike_craft) {
        const rec = getSquadronRecordForToken(vessel);
        if (!rec) return false;
        const stance = rec.sq.ai_stance;
        return !stance || stance === 'manual';
    }
    return !vessel.ai_controlled;
}

/* DM-only: rolls a d20 per initiative-eligible token on the grid and sorts
   the turn order descending. Tied tokens re-roll (up to 5 passes), then fall
   back to token_id order. Ineligible tokens get initiative null and never
   appear in turn_order. */
window.rollBattleInitiative = async function() {
    if (currentUserRole !== 'dm') return;
    const encounter = window.globalBattleEncounterCache;
    if (!encounter) return;
    const tokens = (encounter.tokens || []).slice();
    if (tokens.length === 0) { alert('No tokens on the grid to roll initiative for.'); return; }

    const eligibleIds = [];
    tokens.forEach(tok => {
        const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (tokenIsInitiativeEligible(vessel)) eligibleIds.push(tok.token_id);
    });
    if (eligibleIds.length === 0) { alert('No manually-controlled tokens on the grid -- nothing to roll initiative for (AI-stance squadrons and AI-controlled ships keep acting at the round boundary, not on an individual turn).'); return; }

    let rolls = {};
    eligibleIds.forEach(id => { rolls[id] = 1 + Math.floor(Math.random() * 20); });
    for (let pass = 0; pass < 5; pass++) {
        const byValue = {};
        Object.keys(rolls).forEach(id => { (byValue[rolls[id]] = byValue[rolls[id]] || []).push(id); });
        const tiedGroups = Object.values(byValue).filter(g => g.length > 1);
        if (tiedGroups.length === 0) break;
        tiedGroups.forEach(group => group.forEach(id => { rolls[id] = 1 + Math.floor(Math.random() * 20); }));
    }

    const turnOrder = eligibleIds.slice().sort((a, b) => (rolls[b] - rolls[a]) || a.localeCompare(b));
    const newTokens = tokens.map(tok => ({ ...tok, initiative: rolls[tok.token_id] !== undefined ? rolls[tok.token_id] : null, ap_current: 0 }));
    const firstTok = newTokens.find(t => t.token_id === turnOrder[0]);
    const firstVessel = firstTok ? globalShipMarkersCache.find(m => m.id === firstTok.ship_marker_id) : null;
    if (firstTok) firstTok.ap_current = window.getTokenApMax(firstVessel);

    const updatePayload = { turn_order: turnOrder, current_turn_index: 0, round_number: 1, initiative_rolled: true, pending_round_tick: false };
    // Tokens are stored per-row (battle_tokens), separately from the encounter row.
    await saveBattleTokens(newTokens);
    await db.from('battle_encounters').update(updatePayload).eq('id', encounter.id);
    Object.assign(encounter, updatePayload);

    const orderSummary = turnOrder.map(id => {
        const tok = newTokens.find(t => t.token_id === id);
        const v = tok ? globalShipMarkersCache.find(m => m.id === tok.ship_marker_id) : null;
        return `${v ? v.name : '(unknown)'} (${rolls[id]})`;
    }).join(' → ');
    await db.from('chat_logs').insert({ sender_id: null, content: `🎲 [INITIATIVE] Order rolled: ${orderSummary}`, message_type: 'system' });

    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};

/* Rolls initiative for tokens added after initiative was rolled (mid-fight
   deploys, launched squadrons) and inserts them into turn_order at their
   sorted position. Whether they act this round depends on where that lands
   relative to current_turn_index. Idempotent; called from every
   window.renderBattleMapPanel. The in-flight guard prevents overlapping
   writes when renders fire quickly. */
let battleMapInitiativeSyncInFlight = false;
window.ensureNewTokensInTurnOrder = async function() {
    const encounter = window.globalBattleEncounterCache;
    if (!encounter || !encounter.initiative_rolled || battleMapInitiativeSyncInFlight) return;
    const tokens = encounter.tokens || [];
    const turnOrder = encounter.turn_order || [];
    const newcomers = tokens.filter(tok => {
        if (turnOrder.includes(tok.token_id)) return false;
        const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        return tokenIsInitiativeEligible(vessel);
    });
    if (newcomers.length === 0) return;

    battleMapInitiativeSyncInFlight = true;
    try {
        // Remember whose turn it is before splicing; inserting ahead of
        // current_turn_index would shift what that index points to.
        const currentTokenId = turnOrder[encounter.current_turn_index];

        let rolls = {};
        newcomers.forEach(tok => { rolls[tok.token_id] = 1 + Math.floor(Math.random() * 20); });
        let newOrder = turnOrder.slice();
        newcomers.forEach(tok => {
            const val = rolls[tok.token_id];
            let insertAt = newOrder.findIndex(id => {
                const otherTok = tokens.find(t => t.token_id === id);
                return otherTok && (otherTok.initiative || 0) < val;
            });
            if (insertAt < 0) insertAt = newOrder.length;
            newOrder.splice(insertAt, 0, tok.token_id);
        });
        const newTokens = tokens.map(tok => rolls[tok.token_id] !== undefined ? { ...tok, initiative: rolls[tok.token_id], ap_current: 0 } : tok);
        const newCurrentIndex = currentTokenId ? newOrder.indexOf(currentTokenId) : encounter.current_turn_index;
        await saveBattleTokens(newTokens);
        await db.from('battle_encounters').update({ turn_order: newOrder, current_turn_index: newCurrentIndex < 0 ? encounter.current_turn_index : newCurrentIndex }).eq('id', encounter.id);
        Object.assign(encounter, { turn_order: newOrder, current_turn_index: newCurrentIndex < 0 ? encounter.current_turn_index : newCurrentIndex });
        if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    } catch (err) {
        console.error('ensureNewTokensInTurnOrder: failed to roll in a newly-added token', err);
    } finally {
        battleMapInitiativeSyncInFlight = false;
    }
};

/* Spends `amount` AP (default 1) if it's this token's turn and it has
   enough. Returns false (with an alert) to block the action, true to allow.
   Fails open (true, no alert) when initiative isn't rolled, the token isn't
   on the grid, or it has no turn slot (AI-controlled). Must stay synchronous
   for its callers: the save is fire-and-forget (saveBattleTokens updates the
   cache immediately and logs/resyncs on failure itself). */
window.spendTokenAp = function(shipMarkerId, amount) {
    amount = amount || 1;
    const encounter = window.globalBattleEncounterCache;
    if (!encounter || !encounter.initiative_rolled) return true;
    const tokens = encounter.tokens || [];
    const tok = tokens.find(t => t.ship_marker_id === shipMarkerId);
    if (!tok) return true;
    const turnOrder = encounter.turn_order || [];
    const curTokId = turnOrder[encounter.current_turn_index];
    if (!turnOrder.includes(tok.token_id)) return true; // no turn slot (AI-controlled): unrestricted
    if (encounter.pending_round_tick) {
        alert('This round is waiting for the DM to resolve it.');
        return false;
    }
    if (tok.token_id !== curTokId) {
        alert("It's not this unit's turn yet.");
        return false;
    }
    const apCur = tok.ap_current || 0;
    if (apCur < amount) {
        alert(`Not enough Action Points (${apCur} left, this costs ${amount}).`);
        return false;
    }
    const newTokens = tokens.map(t => t.token_id === tok.token_id ? { ...t, ap_current: apCur - amount } : t);
    saveBattleTokens(newTokens);
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return true;
};

/* Ends the current turn and hands it to the next token in turn_order,
   skipping withdrawn or destroyed (integrity_hull <= 0) ones, for at most
   one full lap. Callable by the DM or the owner of the current vessel.
   Wrapping past the end is a round boundary: window.resolveRoundTick runs
   the round tick (AI fire, point defense, ordnance, cooldowns, refills),
   then the new round starts at the top.
   The round tick is DM-authoritative: a player's wrap only sets
   battle_encounters.pending_round_tick = true, and the DM's browser runs the
   tick exactly once (window.maybeResolvePendingRoundTick, after every
   encounter load). This keeps undo in one place and keeps hidden-ship data
   off player browsers. If the DM's tab isn't open the round waits ("awaiting
   DM" in the turn bar); the DM can also press END TURN. */
let battleRoundTickInFlight = false;
window.endCurrentTurn = async function(opts) {
    opts = opts || {};
    const encounter = window.globalBattleEncounterCache;
    if (!encounter || !encounter.initiative_rolled) return;
    const turnOrder = encounter.turn_order || [];
    if (turnOrder.length === 0) return;

    const isDm = currentUserRole === 'dm';
    if (encounter.pending_round_tick && !isDm) {
        alert('This round is waiting for the DM to resolve it.');
        return;
    }
    const curTok = (encounter.tokens || []).find(t => t.token_id === turnOrder[encounter.current_turn_index]);
    const curVessel = curTok ? globalShipMarkersCache.find(m => m.id === curTok.ship_marker_id) : null;
    if (!isDm && !(curVessel && window.vesselHasOwner(curVessel, currentUserId))) return;
    if (isDm && battleRoundTickInFlight) return;

    let idx = encounter.current_turn_index;
    let wrapped = false;
    let nextTok = null, nextVessel = null;
    let safety = 0;
    do {
        idx += 1;
        if (idx >= turnOrder.length) { idx = 0; wrapped = true; }
        safety++;
        const tid = turnOrder[idx];
        nextTok = (encounter.tokens || []).find(t => t.token_id === tid);
        nextVessel = nextTok ? globalShipMarkersCache.find(m => m.id === nextTok.ship_marker_id) : null;
    } while ((!nextTok || !nextVessel || (nextVessel.integrity_hull || 0) <= 0) && safety <= turnOrder.length);

    if (safety > turnOrder.length) {
        await db.from('chat_logs').insert({ sender_id: null, content: `⏭️ [INITIATIVE] No units remain in the turn order.`, message_type: 'system' });
        return;
    }

    if (wrapped && !isDm) {
        // Hand the round boundary to the DM's browser.
        const { error } = await db.from('battle_encounters').update({ pending_round_tick: true }).eq('id', encounter.id);
        if (error) { alert('Failed to end the round: ' + error.message); return; }
        encounter.pending_round_tick = true;
        await db.from('chat_logs').insert({ sender_id: null, content: `⏳ [INITIATIVE] Round ${encounter.round_number || 1} complete — awaiting the DM to resolve the round.`, message_type: 'system' });
        if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
        return;
    }

    if (wrapped) battleRoundTickInFlight = true;
    try {
        if (wrapped && encounter.pending_round_tick) {
            // Claim the pending flag first, so a second DM tab (or a manual
            // END TURN racing the automatic pickup) can't resolve it twice.
            const { data: claimed, error: claimErr } = await db.from('battle_encounters')
                .update({ pending_round_tick: false }).eq('id', encounter.id).eq('pending_round_tick', true).select();
            if (claimErr) { console.error('endCurrentTurn: failed to claim pending round', claimErr); return; }
            if (!claimed || claimed.length === 0) return; // someone else already resolved it
            encounter.pending_round_tick = false;
        }
        if (wrapped && typeof window.resolveRoundTick === 'function') {
            await window.resolveRoundTick();
            // The tick can destroy tokens, so re-read the next vessel. Known
            // limitation: if it died in the tick, nothing is advanced here and
            // the DM/owner has to press END TURN again.
            nextVessel = globalShipMarkersCache.find(m => m.id === nextTok.ship_marker_id);
            if (!nextVessel || (nextVessel.integrity_hull || 0) <= 0) {
                if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
                return;
            }
        }

        const apMax = window.getTokenApMax(nextVessel);
        const freshEncounter = window.globalBattleEncounterCache; // resolveRoundTick may have reloaded/updated this
        if (!freshEncounter) return;
        const newTokens = (freshEncounter.tokens || []).map(t => t.token_id === nextTok.token_id ? { ...t, ap_current: apMax } : t);

        const updatePayload = { current_turn_index: idx, pending_round_tick: false };
        if (wrapped) updatePayload.round_number = (freshEncounter.round_number || 1) + 1;

        await saveBattleTokens(newTokens);
        await db.from('battle_encounters').update(updatePayload).eq('id', freshEncounter.id);
        Object.assign(freshEncounter, updatePayload);

        await db.from('chat_logs').insert({ sender_id: null, content: `⏭️ [INITIATIVE] ${nextVessel.name}'s turn (${apMax} AP)${wrapped ? `, round ${updatePayload.round_number}` : ''}.`, message_type: 'system' });

        if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    } finally {
        if (wrapped) battleRoundTickInFlight = false;
    }
};

/* DM browser only: resolves a round boundary handed off by a player.
   Safe to call any number of times (in-flight guard + the claim above). */
window.maybeResolvePendingRoundTick = function() {
    if (currentUserRole !== 'dm') return;
    const enc = window.globalBattleEncounterCache;
    if (!enc || !enc.initiative_rolled || !enc.pending_round_tick || battleRoundTickInFlight) return;
    // Defer a tick so the loader that called us finishes rendering first.
    setTimeout(() => { window.endCurrentTurn({ autoResolve: true }); }, 0);
};


window.armTokenForPlacement = function(shipMarkerId) {
    window.battleMapArmedToken = { ship_marker_id: shipMarkerId };
    window.renderBattleMapPanel();
};
window.cancelTokenPlacement = function() {
    window.battleMapArmedToken = null;
    window.renderBattleMapPanel();
};

window.handleBattleGridClick = function(evt) {
    if (!window.battleMapArmedToken || !window.globalBattleEncounterCache) return;
    const grid = document.getElementById('battle-map-grid');
    if (!grid || evt.target !== grid) return; // ignore clicks that land on a token div (they have their own handler)
    // Screen -> grid conversion goes through the active renderer, which
    // knows how the grid is scaled/projected.
    const world = window.battleRenderer.screenToWorld(evt.clientX, evt.clientY);
    if (!world) return;
    window.placeArmedTokenAt(world);
};
// Shared with the 3D view: drops the armed palette ship centred on a grid point.
window.placeArmedTokenAt = function(world) {
    if (!window.battleMapArmedToken || !window.globalBattleEncounterCache || !world) return;
    const raw = { x: world.x - (BATTLE_TOKEN_SIZE / 2), y: world.y - (BATTLE_TOKEN_SIZE / 2) };
    const pos = clampToGrid(raw.x, raw.y);

    const placedVessel = globalShipMarkersCache.find(m => m.id === window.battleMapArmedToken.ship_marker_id);
    const tokens = (window.globalBattleEncounterCache.tokens || []).slice();
    tokens.push({ token_id: genBattleTokenId(), ship_marker_id: window.battleMapArmedToken.ship_marker_id, x: pos.x, y: pos.y, move_remaining: placedVessel?.tactical_speed ?? 160 });
    window.battleMapArmedToken = null;
    saveBattleTokens(tokens).then(() => window.renderBattleMapPanel());
};

window.removeBattleToken = async function(tokenId) {
    if (!window.globalBattleEncounterCache) return;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const tok = tokens.find(t => t.token_id === tokenId);
    if (!tok) return;
    const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
    const isOwner = vessel && window.vesselHasOwner(vessel, currentUserId);
    if (currentUserRole !== 'dm' && !isOwner) return;
    if (!(await window.showConfirmModal('Withdraw this vessel from the battle grid? The vessel itself is untouched.'))) return;

    // Withdraw costs 1 AP, checked after the confirm so cancelling never
    // spends AP.
    if (typeof window.spendTokenAp === 'function' && !window.spendTokenAp(tok.ship_marker_id, 1)) return;

    // Also remove the carrier's deployed squadron tokens (is_strike_craft
    // with parent_id = this vessel). Grid tokens only: ship_deployed is
    // untouched, so the squadrons are still there if the carrier returns.
    const squadronTokenIds = tokens
        .filter(t => {
            const m = globalShipMarkersCache.find(sm => sm.id === t.ship_marker_id);
            return m && m.is_strike_craft && m.parent_id === tok.ship_marker_id;
        })
        .map(t => t.token_id);

    saveBattleTokens(tokens.filter(t => t.token_id !== tokenId && !squadronTokenIds.includes(t.token_id))).then(() => window.renderBattleMapPanel());
};

/* Fog of War: DM-only HIDE/UNHIDE toggle on the Battle Map ship card
   (window.renderBattleShipCards). Writes ship_markers.is_hidden, the same
   field as the checkbox in EDIT BASE STATS (js/combat.js). */
window.toggleVesselHidden = async function(vesselId) {
    if (currentUserRole !== 'dm') return;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    const newHidden = !vessel.is_hidden;
    const { error } = await db.from('ship_markers').update({ is_hidden: newHidden }).eq('id', vesselId);
    if (error) { alert('Failed to update Hidden status: ' + error.message); return; }
    vessel.is_hidden = newHidden;
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
};

/* Called from js/combat.js rollShipWeapon after a vessel's new hull value is
   saved. At 0 hull, removes its token from the battle (the ship_markers row
   is untouched; destruction is otherwise DM-narrated) and may spawn a
   Battlefield Salvage record. */
window.checkBattleTokenDestroyed = async function(vessel) {
    if (!vessel || !window.globalBattleEncounterCache) return;
    if ((vessel.integrity_hull || 0) > 0) return;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const tok = tokens.find(t => t.ship_marker_id === vessel.id);
    if (!tok) return;
    // Stage the destruction effect for the render loop's removal pass. Only
    // here, not on WITHDRAW or squadron RECALL: withdrawing isn't dying.
    battleMapPendingExplosions.push({ token_id: tok.token_id, x: tok.x, y: tok.y });
    // Broadcast so other clients play the explosion too.
    if (typeof window.sendBattleBroadcast === 'function') window.sendBattleBroadcast('fx', { k: 'boom', marker: vessel.id, x: tok.x, y: tok.y });
    const remaining = tokens.filter(t => t.token_id !== tok.token_id);
    await saveBattleTokens(remaining);
    await db.from('chat_logs').insert({ sender_id: null, content: `💥 [TACTICAL BATTLE MAP] ${vessel.name} destroyed — removed from the engagement.`, message_type: 'system' });

    // Battlefield Salvage spawns at the first remaining player-owned vessel
    // (an owner whose profile role !== 'dm'). No player ship present means
    // no salvage.
    const playerToken = remaining.find(t => {
        const m = globalShipMarkersCache.find(sm => sm.id === t.ship_marker_id);
        if (!m) return false;
        const ownerProfs = window.vesselOwnerIds(m).map(id => (typeof allProfiles !== 'undefined' ? allProfiles : []).find(p => p.id === id)).filter(Boolean);
        return ownerProfs.some(p => p.role !== 'dm');
    });
    if (playerToken) {
        const anchor = globalShipMarkersCache.find(sm => sm.id === playerToken.ship_marker_id);
        if (anchor) {
            await db.from('battlefield_salvage').insert({
                x: anchor.x, y: anchor.y,
                resource_name: 'Unprocessed Wreckage Salvage', qty: 5, unit: 'Tons',
                status: 'available', source_vessel_name: vessel.name, created_by: currentUserId
            });
            await db.from('chat_logs').insert({ sender_id: null, content: `🛰️ [SALVAGE] Wreckage from ${vessel.name} drifts near ${anchor.name} — recoverable.`, message_type: 'system' });
        }
    }

    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    if (typeof loadBattlefieldSalvage === 'function') loadBattlefieldSalvage();
};
