/* ==========================================================================
   js/battle-turns.js - Initiative, Action Points, END TURN, token placement / withdrawal / hiding, destruction checks.
   Split out of js/battle-map.js (consolidation pass 2, 2026-10-08), code
   unchanged. Classic script sharing the global scope: loads right after
   battle-map.js (see index.html for the order).
   ========================================================================== */
// addSquadronToBattleMap / removeBattleTokenByMarkerId moved to
// js/squadrons.js on 2026-08-27 (Priority 2 split). NOTE: the three
// squadron-specific helpers still nested inside
// window.processBattleRoundAutomations below (squadronWeaponCooldown,
// findEligibleSquadronIntercept, fireEligibleSquadronIntercept) were
// deliberately NOT moved -- they share closure state with this file's
// non-squadron PD pool logic. See js/squadrons.js's header comment.

/* ==========================================================================
   INITIATIVE + ACTION ECONOMY (new this session)
   ==========================================================================
   Confirmed design (see darkforest-architecture-reference.md): individual
   d20 initiative per token, rolled once when the DM starts it and reused
   for the rest of THIS battle (rerolled only by starting a new battle, not
   every round); a fixed Action Point pool per token, refilled at the start
   of that token's own turn, spent 1-per-action, no carryover once the turn
   ends. Scope, confirmed: Battle Map only (ships/squadrons), not ground
   combat. Movement is deliberately NOT folded into AP -- move_remaining
   keeps working exactly as it already did (soft-enforced px budget,
   refilled once per full ROUND rather than per individual turn, since
   nothing here asked to change that).

   AI-stance squadrons and ai_controlled ships are DELIBERATELY EXCLUDED
   from the initiative order and never get an individual turn slot --
   confirmed design tradeoff (see the AI-turn-risk decision) to avoid
   restructuring window.processBattleRoundAutomations's shared
   persist/chat-flush machinery, or duplicating its fire/move logic, in the
   same pass as building this engine. They keep firing together in one
   batch the instant the turn order wraps back to the top (same trigger as
   today's ADVANCE ROUND) -- a real, deliberate scope limit, not an
   oversight. PD/intercept was never turn-gated to begin with and stays
   fully reactive, untouched by any of this.

   Deliberately NOT AP-gated this pass (flagged, not silently skipped):
   launching/recalling a squadron from the Hangar Bay (doesn't cleanly map
   to "spend AP of token X" -- the squadron doesn't have a grid token yet
   at launch time), and changing a squadron's AI stance (stance-driven
   squadrons don't have a turn slot to spend from in the first place, per
   the exclusion above). Say the word if either should be wired in too. */

/* Resolves the live squadron record (`sq`, the entry on its CARRIER's own
   ship_deployed array) for a strike-craft battle token -- the reverse of
   the far more common sqShip-from-sq lookup used throughout this file.
   Needed here because a strike-craft token's own ship_markers row carries
   no weapon list of its own (STRIKE_CRAFT_DB is the catalog, keyed off
   sq.type, not the token). Returns null if the carrier or the squadron
   record can't be found (e.g. a stale/orphaned token) -- fails open, same
   convention as every other "can't resolve a squadron's own data" case in
   this file. */
function getSquadronRecordForToken(vessel) {
    if (!vessel || !vessel.is_strike_craft || !vessel.parent_id) return null;
    const carrier = globalShipMarkersCache.find(m => m.id === vessel.parent_id);
    if (!carrier) return null;
    const sq = (carrier.ship_deployed || []).find(s => s.id === vessel.squadron_id);
    if (!sq) return null;
    return { sq, carrier };
}

/* Action Point pool for one token's turn: 1 + floor(weaponCount / 2),
   confirmed formula -- a lone 1-2 weapon squadron gets 2 AP, a 12-weapon
   Jupiter-class cruiser gets 7. Floor of 1 even for a 0-weapon token (e.g.
   an unarmed station) so it can always do at least one non-fire action
   (Withdraw, etc.) on its turn. */
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

/* A token gets its own individual initiative slot only if nothing already
   controls it automatically -- confirmed scope (see file-header note
   above). A squadron counts as "manually controlled" whenever its
   ai_stance is unset/blank/'manual'; anything else (attack_strike_craft/
   attack_capitals/attack_escorts/intercept_munitions) excludes it. */
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

/* DM-only: rolls a flat d20 per initiative-eligible token currently on the
   active battle's grid and builds the turn order (descending). Ties are
   resolved by re-rolling just the tied tokens against each other (a few
   passes, capped so a pathological all-ties case can't loop forever --
   falls back to token_id string order if still tied after the cap, which
   never actually triggers with a d20 pool this small in practice). Ineligible
   tokens (AI-stance squadrons, ai_controlled ships) get no initiative value
   at all and never appear in turn_order -- they act at the round boundary
   exactly as they already did before this build. */
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
    // Tokens are per-row now (battle_tokens) -- saved separately from the encounter's own fields.
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

/* Rolls initiative for any token that's been added to the grid AFTER
   window.rollBattleInitiative already ran this battle (a mid-fight deploy,
   a freshly-launched squadron) -- called as a cheap, idempotent tail check
   from window.renderBattleMapPanel, same "safe to call unconditionally
   every render" convention this codebase already uses for other per-render
   refreshes. Inserts each newly-rolled token into turn_order at its sorted
   position; whether it actually gets to act THIS round or has to wait for
   the next one falls out naturally from where that position lands relative
   to current_turn_index. A simple in-flight guard avoids overlapping
   concurrent persists if a render fires again before the previous one's
   write lands. */
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
        // Remember whose turn it currently is BEFORE inserting anything --
        // splicing a newcomer in ahead of current_turn_index would otherwise
        // silently shift which token that numeric index actually points to.
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
        // Re-derive the index from the remembered token id rather than
        // trusting the old numeric index, which the splice(s) above may
        // have invalidated.
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

/* Spends `amount` AP from shipMarkerId's OWN turn slot, IF it's currently
   that token's turn and it has enough left. Fails open (returns true, no
   alert) whenever the turn-order system isn't active at all -- no
   initiative rolled for this battle, or the token isn't on this battle's
   grid -- so every call site stays a harmless no-op until a DM actually
   starts using ROLL INITIATIVE. Persists optimistically (fire-and-forget,
   matching this file's existing convention for a cheap incidental token
   field write) and re-renders so the turn bar's AP readout updates
   immediately. */
window.spendTokenAp = function(shipMarkerId, amount) {
    amount = amount || 1;
    const encounter = window.globalBattleEncounterCache;
    if (!encounter || !encounter.initiative_rolled) return true;
    const tokens = encounter.tokens || [];
    const tok = tokens.find(t => t.ship_marker_id === shipMarkerId);
    if (!tok) return true;
    const turnOrder = encounter.turn_order || [];
    const curTokId = turnOrder[encounter.current_turn_index];
    if (!turnOrder.includes(tok.token_id)) return true; // this token was never given an individual slot (AI-stance/ai_controlled) -- unrestricted, matches its always-acts-at-round-boundary behavior
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
    // Bug-hunt pass (2026-09-24): this used to end in `.catch(...)` -- but a
    // Supabase query builder has no .catch() (only .then), so it threw a
    // TypeError right here: the AP spend was never saved and every manual
    // shot/launch/withdraw aborted the moment initiative had been rolled.
    // `.then(({ error }) => ...)` is the correct fire-and-forget form.
    // Per-row token storage (2026-09-30): saveBattleTokens updates the cache
    // synchronously, then writes just this token's ap_current. Fire-and-forget
    // (this function must stay synchronous for its callers); it logs + resyncs
    // on failure itself.
    saveBattleTokens(newTokens);
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return true;
};

/* Ends the current token's turn and hands it to the next eligible one in
   turn_order, skipping any that have been withdrawn (no longer a token) or
   destroyed (integrity_hull <= 0) since the order was rolled -- up to a
   full lap, so an all-dead/all-gone order doesn't loop forever. Wrapping
   past the end of turn_order is a full round boundary: fires the exact
   same global tick window.advanceCombatRound's manual button does (via
   window.resolveRoundTick, no confirm dialog / no DM-only gate -- see that
   function's own header comment), which is where AI-stance squadrons and
   ai_controlled ships actually get to act, then starts the new round at
   the top of the order. Callable by the DM or by whoever owns the vessel
   whose turn it currently is -- matches how a player already fires their
   own weapons without DM involvement elsewhere in this app. */
/* DM-AUTHORITATIVE ROUND TICK (Command Terminal refactor, Phase 0,
   2026-09-30): a player's END TURN still advances turns on its own, with no
   DM input -- EXCEPT the wrap into a new round. That wrap used to run the
   whole round tick (AI fire, point defense, ordnance, cooldowns, refills)
   inside whichever browser pressed the button, which means results could
   depend on who clicked. Now a player's wrap just sets
   battle_encounters.pending_round_tick = true, and the DM's browser, which
   sees that flag through realtime, runs the tick exactly once
   (window.maybeResolvePendingRoundTick, called after every encounter load).
   Needed for full undo (one place records every automated result) and for
   any future server-side Fog of War (a player's browser won't be able to
   see hidden ships). If the DM's tab isn't open the round waits, with an
   "awaiting DM" line in the turn bar -- the DM can also just press END TURN. */
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
            // resolveRoundTick can destroy/change tokens (PD, AI fire) -- re-read
            // the freshly-picked next token's vessel fresh rather than trust a
            // now-possibly-stale reference. A token destroyed by the round tick
            // right as it becomes its own turn is a known, accepted edge case
            // this pass doesn't fully solve -- the DM/owner just clicks END TURN
            // again to skip it.
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

/* DM browser only: if a player has handed off a round boundary, resolve it.
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
    // Screen -> grid conversion goes through the active renderer (Phase 0
    // renderer split, 2026-10-01) -- the one place that knows how the grid
    // is scaled/projected on screen.
    const world = window.battleRenderer.screenToWorld(evt.clientX, evt.clientY);
    if (!world) return;
    window.placeArmedTokenAt(world);
};
// Phase 6a: shared with the 3D view -- drop the armed palette ship centred on a grid point.
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

    // Initiative + Action Economy build (this session): Withdraw spends 1 AP
    // from this token's own turn slot -- checked AFTER the confirm dialog
    // (not before) so declining the confirm never spends AP that wasn't
    // actually used.
    if (typeof window.spendTokenAp === 'function' && !window.spendTokenAp(tok.ship_marker_id, 1)) return;

    // Pending-list follow-up (this session): a withdrawn carrier's still-
    // deployed squadrons used to be left behind as orphaned tokens with no
    // parent on the grid -- found (not fixed) during the Animation Suite
    // Part 1 verification pass, closed out now. Pull every companion token
    // (is_strike_craft + parent_id pointing at this vessel) along with the
    // carrier's own token. Matches window.checkBattleTokenDestroyed's own
    // "withdrawing isn't dying" convention -- this only removes GRID
    // tokens, never touches ship_deployed itself, so the squadrons are
    // still there (just off the map) if the carrier returns.
    const squadronTokenIds = tokens
        .filter(t => {
            const m = globalShipMarkersCache.find(sm => sm.id === t.ship_marker_id);
            return m && m.is_strike_craft && m.parent_id === tok.ship_marker_id;
        })
        .map(t => t.token_id);

    saveBattleTokens(tokens.filter(t => t.token_id !== tokenId && !squadronTokenIds.includes(t.token_id))).then(() => window.renderBattleMapPanel());
};

/* Fog of War build (this session, confirmed design): DM-only quick toggle on
   the Battle Map ship-status card (see the HIDE/UNHIDE button in
   window.renderBattleShipCards below) -- a faster path than opening EDIT
   BASE STATS (js/combat.js's Vessel Deck modal, which also has the same
   `is_hidden` checkbox for setting it outside an active battle). Persists on
   ship_markers directly, same field either path writes to. */
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

/* Called from js/combat.js's rollShipWeapon right after a damaged vessel's
   new hull value is committed. Auto-removes a destroyed vessel's token from
   the active battle (per confirmed design) without touching the underlying
   ship_markers row — matches the existing convention that vessel destruction
   is DM-narrated/manually handled everywhere else in this app (there was no
   prior auto-delete-on-0-hull behavior anywhere to begin with). Also spawns
   a Battlefield Salvage record, per confirmed design — see file header. */
window.checkBattleTokenDestroyed = async function(vessel) {
    if (!vessel || !window.globalBattleEncounterCache) return;
    if ((vessel.integrity_hull || 0) > 0) return;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const tok = tokens.find(t => t.ship_marker_id === vessel.id);
    if (!tok) return;
    // Visual Polish build (this session): stage a destruction effect at this
    // token's last position, consumed by the render loop's removal pass
    // right before the DOM element actually disappears. Only staged here —
    // NOT in window.removeBattleToken (a manual WITHDRAW) or
    // window.removeBattleTokenByMarkerId (a squadron RECALL) — withdrawing
    // isn't dying. LOCAL-ONLY, same limitation as the direct-fire beam: this
    // only runs on whichever client's action triggered the destruction (the
    // firer, or the DM on an Advance Round ordnance/PD kill) — there's no
    // ship_markers realtime channel in this codebase for other clients to
    // detect "this token just now hit 0 hull" independently.
    battleMapPendingExplosions.push({ token_id: tok.token_id, x: tok.x, y: tok.y });
    // Battle broadcast (2026-09-30): other clients now see the explosion too.
    if (typeof window.sendBattleBroadcast === 'function') window.sendBattleBroadcast('fx', { k: 'boom', marker: vessel.id, x: tok.x, y: tok.y });
    const remaining = tokens.filter(t => t.token_id !== tok.token_id);
    await saveBattleTokens(remaining);
    await db.from('chat_logs').insert({ sender_id: null, content: `💥 [TACTICAL BATTLE MAP] ${vessel.name} destroyed — removed from the engagement.`, message_type: 'system' });

    // Battlefield Salvage: spawn at any player-owned vessel still present in
    // the battle. "Player" = owner's profile role !== 'dm', same heuristic
    // the Ground Combat To-Hit build established for combat_tracker PC-vs-NPC
    // detection. No player ship present (e.g. a pure NPC-vs-NPC fight) means
    // no salvage — nobody around to recover it anyway.
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
