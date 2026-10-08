/* ==========================================================================
   js/battle-movement.js - Ship token movement: overlap separation, AI move-toward, the 2D token drag and the shared move rules (battle_tokens moves).
   Split out of js/battle-map.js (consolidation pass 2, 2026-10-08), code
   unchanged. Classic script sharing the global scope: loads right after
   battle-map.js (see index.html for the order).
   ========================================================================== */
/* Playtest rebalance (2026-10-03, DM): ships and strike craft stacked on
   top of / inside each other (AI moves ended exactly on their target's
   position; launches scattered randomly round the carrier). Every token
   that is new or moved in a save is now nudged to the nearest free spot:
   footprints are circles sized from the 3D hull lengths (craft 12, escort
   23, capital 31, station 22, x model_scale). A moved token first backs off
   along its own path; a new one spirals outward. Hidden (fog) ships aren't
   obstacles for players, so a nudge never gives one away. */
const TOKEN_FOOTPRINT = { craft: 12, escort: 23, capital: 31, station: 22 };
window.tokenFootprintRadius = function(v) {
    let r = !v ? 17 : v.is_strike_craft ? TOKEN_FOOTPRINT.craft : v.is_station ? TOKEN_FOOTPRINT.station : v.vessel_class === 'Escort' ? TOKEN_FOOTPRINT.escort : TOKEN_FOOTPRINT.capital;
    const sc = v && Number(v.model_scale) > 0 ? Math.max(0.5, Math.min(2, Number(v.model_scale))) : 1;
    return r * sc;
};
function sepTokenCenter(t, v) {
    const size = (v && v.is_strike_craft) ? BATTLE_STRIKE_CRAFT_TOKEN_SIZE : BATTLE_TOKEN_SIZE;
    return { x: (t.x || 0) + size / 2, y: (t.y || 0) + size / 2, z: t.z || 0 };
}
window.findFreeTokenSpot = function(tok, pos, tokens, fromPos) {
    const byId = (id) => globalShipMarkersCache.find(m => m.id === id);
    const me = byId(tok.ship_marker_id), rMe = window.tokenFootprintRadius(me);
    if (!me || window.BATTLE_TOKEN_SEPARATION === false) return pos; // stale token with no ship / separation switched off (test harness)
    const others = (tokens || []).filter(o => o && o.token_id !== tok.token_id && o.ship_marker_id !== tok.ship_marker_id).map(o => {
        const v = byId(o.ship_marker_id);
        if (!v || (v.is_hidden && currentUserRole !== 'dm')) return null;
        return { c: sepTokenCenter(o, v), r: window.tokenFootprintRadius(v) };
    }).filter(Boolean);
    const free = (p) => {
        const c = sepTokenCenter({ x: p.x, y: p.y, z: tok.z }, me);
        return others.every(o => Math.hypot(o.c.x - c.x, o.c.y - c.y, o.c.z - c.z) >= o.r + rMe - 0.5);
    };
    if (free(pos)) return pos;
    if (fromPos) {
        const dx = fromPos.x - pos.x, dy = fromPos.y - pos.y, len = Math.hypot(dx, dy);
        for (let d = 4; d < len; d += 4) {
            const p = { x: pos.x + dx * d / len, y: pos.y + dy * d / len };
            if (free(p)) return p;
        }
    }
    for (let ring = 6; ring <= 360; ring += 6) {
        const steps = Math.max(8, Math.round(ring / 4));
        for (let i = 0; i < steps; i++) {
            const a = (i / steps) * Math.PI * 2;
            const p = clampToGrid(pos.x + Math.cos(a) * ring, pos.y + Math.sin(a) * ring);
            if (free(p)) return p;
        }
    }
    return fromPos && free(fromPos) ? fromPos : pos; // nowhere free -- leave it
};
function separateBattleTokens(tokens) {
    const out = (tokens || []).slice();
    for (let i = 0; i < out.length; i++) {
        const t = out[i];
        if (!t || !t.token_id) continue;
        const prev = battleTokenSnapshot[t.token_id];
        const moved = !prev || prev.x !== (t.x || 0) || prev.y !== (t.y || 0) || (prev.z || 0) !== (t.z || 0);
        if (!moved) continue;
        const p = window.findFreeTokenSpot(t, { x: t.x || 0, y: t.y || 0 }, out, prev ? { x: prev.x, y: prev.y } : null);
        if (p.x !== t.x || p.y !== t.y) out[i] = { ...t, x: p.x, y: p.y };
    }
    return out;
}
window.separateBattleTokens = separateBattleTokens;

/* Squadron Movement + Retreat build (this session): moves ONE token
   (identified by its ship_marker_id) up to maxDist px straight toward
   targetPos, clamped to the grid -- used by the AI Stances' offensive
   advance-on-target and low-HP retreat-toward-carrier behavior in
   processBattleRoundAutomations below. Reads/writes through
   window.globalBattleEncounterCache.tokens directly (via a fresh slice,
   same "never mutate the live array in place" convention every other
   token-position writer in this file already follows) so a caller can
   await saveBattleTokens() on the result and have window.
   getBattleTokenPosition immediately reflect the new position for
   whatever it does next (e.g. firing from the arrived-at position).
   Returns null (no-op) if the token isn't found -- fails open, same
   as every other "squadron has no grid token" check in this file. */
function moveTokenToward(shipMarkerId, targetPos, maxDist) {
    if (!window.globalBattleEncounterCache) return null;
    const currentTokens = (window.globalBattleEncounterCache.tokens || []).slice();
    const idx = currentTokens.findIndex(t => t.ship_marker_id === shipMarkerId);
    if (idx < 0) return null;
    const cur = currentTokens[idx];
    const dx = targetPos.x - cur.x, dy = targetPos.y - cur.y;
    const dist = Math.hypot(dx, dy);
    let newPos = (dist <= maxDist || dist === 0)
        ? { x: targetPos.x, y: targetPos.y }
        : clampToGrid(cur.x + dx * (maxDist / dist), cur.y + dy * (maxDist / dist));
    // Phase 10: terrain rules (asteroids cost more, planets/stations stop
    // the move, debris crossed is queued for damage -- flushed by the caller
    // after it saves the move, via window.terrainFlushDebris).
    if (typeof window.terrainRulesActive === 'function' && window.terrainRulesActive()) {
        const v = globalShipMarkersCache.find(m => m.id === shipMarkerId);
        const walk = window.terrainWalk(v, { x: cur.x, y: cur.y }, clampToGrid(targetPos.x, targetPos.y), maxDist);
        newPos = walk.pos;
        window.terrainQueueDebris(shipMarkerId, walk.debrisLen);
    }
    // Playtest rebalance: never end a move inside another ship (see separateBattleTokens).
    if (typeof window.findFreeTokenSpot === 'function') newPos = window.findFreeTokenSpot(cur, newPos, currentTokens, { x: cur.x, y: cur.y });
    currentTokens[idx] = { ...cur, x: newPos.x, y: newPos.y };
    return currentTokens;
}



/* Native drag (mousedown/mousemove/mouseup), constrained to the grid bounds,
   same pattern as makePanelDraggable (js/ui.js) but scoped to a token div
   inside the arena rather than a whole floating panel. A short-drag (< 5px)
   is treated as a click (opens the vessel terminal) rather than a move.

   ** SUPERSEDED 2026-09-26: movement is now enforced for players (owner-
   only, own-turn-only once initiative is rolled, hard-capped at
   move_remaining; DM exempt) -- see the comment inside wireTokenDrag. The
   original design note below is kept for history. **
   Movement (added this session, confirmed design): DM-trusted, not
   code-enforced — the drag itself is never blocked or snapped back. On
   drop, the straight-line distance moved is subtracted from the token's
   move_remaining (grid px) as an informational readout only; it's allowed
   to go negative (rendered in red — "overdrawn") so the DM sees at a glance
   that a token moved further than its Tactical Speed for the round, same
   as this app trusts the DM's eye everywhere else (combat rolls, hazards).
   move_remaining resets to the vessel's tactical_speed whenever the DM
   clicks ADVANCE ROUND — see resetBattleMapMovement below. */
// Animation Engine build (this session): parameterized by the STABLE
// tokenId/shipMarkerId now, not a captured token object -- the grid render
// now diffs and REUSES token DOM elements across renders (see the maps
// above) instead of tearing down and rebuilding everything every time, so
// this function's closure can no longer trust a token object captured once
// at element-creation time; a remote move synced in through realtime (or
// any other render) would leave it stale. Both ids are immutable for a
// token's lifetime, so they're safe to close over; x/y are looked up fresh
// from window.globalBattleEncounterCache at the moment a drag actually
// starts instead.
function wireTokenDrag(tokenEl, tokenId, shipMarkerId) {
    // Station Designer build: a station is fully immobile on the Battle Map
    // (confirmed design — no move-remaining tracking, can't be repositioned
    // by drag) rather than just defaulting to 0 speed like any other ship
    // could. A plain click still opens the vessel terminal, same as a
    // short/non-drag click on a normal token.
    const stationVessel = globalShipMarkersCache.find(m => m.id === shipMarkerId);
    if (stationVessel && stationVessel.is_station) {
        tokenEl.addEventListener('mousedown', (e) => { e.stopPropagation(); });
        tokenEl.addEventListener('click', () => {
            // Phase 4c: with the tactical HUD on, a tap selects the ship in the HUD first.
            if (typeof window.tv2HandleTokenTap === 'function' && window.tv2HandleTokenTap(shipMarkerId)) return;
            if (stationVessel.iff === 'hostile' && !window.vesselHasOwner(stationVessel, currentUserId)) {
                window.autoTargetAllMyWeapons(shipMarkerId);
                return;
            }
            if (typeof window.openFullVesselTerminal === 'function') window.openFullVesselTerminal(shipMarkerId);
        });
        return;
    }
    // Mobile pass (2026-09-24): token dragging was mouse-only, so on a phone
    // you could tap a token (the browser fakes a click) but never MOVE your
    // ship on the Battle Map. The drag logic is now three plain functions
    // (begin/move/end, taking screen coordinates) driven by BOTH mouse and
    // touch listeners -- same math, same save, same tap-vs-drag rule (more
    // than 5 grid units = a drag, otherwise it's a tap that opens the vessel
    // or auto-targets a hostile). Desktop mouse behavior is unchanged.
    // Movement enforcement (DM decision 2026-09-26 -- replaces the old
    // honor-system "overdrawn in red" behavior for players):
    //   - DM is exempt: can drag any token any distance at any time, and a
    //     DM drag does NOT spend move_remaining (pure repositioning).
    //   - A player can only drag a token they own (vesselHasOwner); on
    //     anyone else's token a press is always treated as a tap.
    //   - Once initiative is rolled, a player's token that HAS a turn slot
    //     can only move during its own turn (tokens with no slot --
    //     AI-stance / ai_controlled -- are unrestricted, same rule as
    //     spendTokenAp). Movement still does not cost AP.
    //   - Distance is hard-capped at move_remaining: the token stops at
    //     max reach along the drag direction instead of overspending.
    // dragMode is decided at press time: 'free' (DM), 'capped' (player,
    // allowed), or 'tap' (not allowed to move -- press only opens/targets).
    let isDragging = false, moved = false, startX, startY, initialLeft, initialTop;
    let dragMode = 'tap', blockReason = '', moveRule = null;
    let lastTouchX = 0, lastTouchY = 0, lastTouchEndAt = 0;
    let pressIsTouch = false; // phones: a touch press on a LOCKED map is tap-only (js/battle-mobile.js)
    // Phase 6a: the move rules now live in shared functions (battleMoveRule /
    // battleConstrainMove / battleCommitMove / battleTokenTapped, just below
    // this function) so the 3D Command view applies exactly the same rules.
    function constrainPos(x, y) { return window.battleConstrainMove(moveRule, x, y); }
    function beginDrag(clientX, clientY) {
        isDragging = true; moved = false;
        startX = clientX; startY = clientY;
        moveRule = window.battleMoveRule(tokenId, shipMarkerId);
        initialLeft = moveRule.x0 !== null ? moveRule.x0 : (parseFloat(tokenEl.style.left) || 0);
        initialTop = moveRule.y0 !== null ? moveRule.y0 : (parseFloat(tokenEl.style.top) || 0);
        moveRule.x0 = initialLeft; moveRule.y0 = initialTop;
        dragMode = moveRule.mode; blockReason = moveRule.blockReason;
        if (pressIsTouch && typeof window.battleMapTouchLocked === 'function' && window.battleMapTouchLocked()) { dragMode = 'tap'; blockReason = ''; }
        // Suspend the CSS position transition (see .battle-token-el in
        // style.css) for the duration of this drag -- otherwise every move
        // write would animate TOWARD the new value instead of tracking the
        // pointer directly. Restored on drop.
        tokenEl.style.transition = 'none';
    }
    // Screen-pixel deltas are converted by the renderer (screenDeltaToWorld --
    // today a divide by BATTLE_GRID_SCALE) because the token
    // lives inside #battle-map-grid's CSS transform:scale().
    function moveDrag(clientX, clientY) {
        if (!isDragging) return;
        const { x: dx, y: dy } = window.battleRenderer.screenDeltaToWorld(clientX - startX, clientY - startY);
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
        if (dragMode === 'tap') return; // not allowed to move this token -- leave it where it is
        const pos = constrainPos(initialLeft + dx, initialTop + dy);
        tokenEl.style.left = pos.x + 'px'; tokenEl.style.top = pos.y + 'px';
    }
    function endDrag(clientX, clientY) {
        if (!isDragging) return;
        isDragging = false;
        tokenEl.style.transition = '';
        if (moved && dragMode === 'tap' && blockReason) {
            // A real drag attempt on the player's OWN token that isn't allowed
            // right now -- say why instead of silently opening the terminal.
            alert(blockReason);
            return;
        }
        if (moved && dragMode === 'tap') return; // a drag/swipe on a token you can't move -- neither move it nor treat it as a tap
        if (moved) {
            const { x: dx, y: dy } = window.battleRenderer.screenDeltaToWorld(clientX - startX, clientY - startY);
            const pos = constrainPos(initialLeft + dx, initialTop + dy);
            window.battleCommitMove(moveRule, pos);
        } else {
            window.battleTokenTapped(shipMarkerId);
        }
    }
    tokenEl.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (Date.now() - lastTouchEndAt < 800) return; // browser's synthetic mouse event after a touch -- already handled
        pressIsTouch = false;
        beginDrag(e.clientX, e.clientY);
        const onMove = (moveEvt) => moveDrag(moveEvt.clientX, moveEvt.clientY);
        const onUp = (upEvt) => {
            window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
            endDrag(upEvt.clientX, upEvt.clientY);
        };
        window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    });
    tokenEl.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        e.stopPropagation();
        const t = e.touches[0];
        lastTouchX = t.clientX; lastTouchY = t.clientY;
        pressIsTouch = true;
        beginDrag(t.clientX, t.clientY);
    }, { passive: true });
    tokenEl.addEventListener('touchmove', (e) => {
        if (!isDragging || e.touches.length !== 1) return;
        if (dragMode === 'tap') { const t0 = e.touches[0]; lastTouchX = t0.clientX; lastTouchY = t0.clientY; if (Math.abs(t0.clientX - startX) > 5 || Math.abs(t0.clientY - startY) > 5) moved = true; return; } // let the page scroll/pan normally
        e.preventDefault(); // keep the page from scrolling while a token is being dragged
        const t = e.touches[0];
        lastTouchX = t.clientX; lastTouchY = t.clientY;
        moveDrag(t.clientX, t.clientY);
    }, { passive: false });
    tokenEl.addEventListener('touchend', (e) => {
        if (!isDragging) return;
        lastTouchEndAt = Date.now();
        e.preventDefault(); // suppress the browser's follow-up synthetic mouse/click events
        endDrag(lastTouchX, lastTouchY);
    }, { passive: false });
    tokenEl.addEventListener('touchcancel', () => {
        if (!isDragging) return;
        isDragging = false; moved = false;
        tokenEl.style.transition = '';
        tokenEl.style.left = initialLeft + 'px'; tokenEl.style.top = initialTop + 'px'; // snap back, nothing saved
    });
}

/* Phase 6a (2026-10-03): the token move rules, shared by the 2D grid's drag
   (wireTokenDrag above) and the 3D Command view (js/battle-3d.js). Same
   rules as before, unchanged:
     - DM: 'free' -- any token, any distance, no move spent.
     - Player: only their own token; once initiative is rolled, only on its
       own turn (tokens with no turn slot are unrestricted); not while the
       round waits for the DM; capped at move_remaining ('capped').
     - Otherwise 'tap' (a press only selects / opens / targets).
     - Stations never move. */
window.battleMoveRule = function(tokenId, shipMarkerId) {
    const enc = window.globalBattleEncounterCache;
    const liveToken = ((enc && enc.tokens) || []).find(t => t.token_id === tokenId);
    const rule = { tokenId, shipMarkerId, mode: 'tap', maxReach: 0, blockReason: '', x0: liveToken ? liveToken.x : null, y0: liveToken ? liveToken.y : null };
    const v = globalShipMarkersCache.find(m => m.id === shipMarkerId);
    if (v && v.is_station) return rule;
    if (currentUserRole === 'dm') { rule.mode = 'free'; return rule; }
    if (!v || !window.vesselHasOwner(v, currentUserId)) return rule;
    if (enc && enc.initiative_rolled && enc.pending_round_tick) { rule.blockReason = 'This round is waiting for the DM to resolve it.'; return rule; }
    if (enc && enc.initiative_rolled && liveToken) {
        const order = enc.turn_order || [];
        if (order.includes(liveToken.token_id) && order[enc.current_turn_index] !== liveToken.token_id) {
            rule.blockReason = "It's not this unit's turn yet — it can only move on its own turn.";
            return rule;
        }
    }
    const rem = liveToken && liveToken.move_remaining !== undefined ? liveToken.move_remaining : (v.tactical_speed ?? 160);
    rule.maxReach = Math.max(0, rem);
    if (rule.maxReach <= 0) { rule.blockReason = 'No movement remaining this round.'; return rule; }
    rule.mode = 'capped';
    return rule;
};
// Clamp a proposed top-left position to the grid AND (capped moves) to
// maxReach from the start point along the same direction.
window.battleConstrainMove = function(rule, x, y) {
    let pos = clampToGrid(x, y);
    // Phase 10: with terrain rules on, a capped move walks the straight line
    // and stops where the budget runs out (asteroids cost more) or where it
    // would enter a planet / station (js/terrain-rules.js).
    if (rule && rule.mode === 'capped' && typeof window.terrainRulesActive === 'function' && window.terrainRulesActive()) {
        const v = globalShipMarkersCache.find(m => m.id === rule.shipMarkerId);
        return window.terrainWalk(v, { x: rule.x0, y: rule.y0 }, pos, rule.maxReach).pos;
    }
    if (rule && rule.mode === 'capped') {
        const ddx = pos.x - rule.x0, ddy = pos.y - rule.y0;
        const d = Math.hypot(ddx, ddy);
        if (d > rule.maxReach && d > 0) {
            const k = rule.maxReach / d;
            pos = clampToGrid(rule.x0 + ddx * k, rule.y0 + ddy * k);
        }
    }
    return pos;
};
// What a capped move to `pos` would cost (terrain-aware); used by the drag previews.
window.battleMoveCost = function(rule, pos) {
    if (!rule || !pos) return 0;
    if (rule.mode === 'capped' && typeof window.terrainRulesActive === 'function' && window.terrainRulesActive()) {
        return window.terrainWalk(globalShipMarkersCache.find(m => m.id === rule.shipMarkerId), { x: rule.x0, y: rule.y0 }, pos, null).cost;
    }
    return Math.hypot(pos.x - rule.x0, pos.y - rule.y0);
};
// Save a finished move (one undo step). pos must already be constrained.
window.battleCommitMove = function(rule, pos) {
    if (!rule || rule.mode === 'tap' || !window.globalBattleEncounterCache) return Promise.resolve();
    let distMoved = Math.hypot(pos.x - rule.x0, pos.y - rule.y0);
    const dragVessel = globalShipMarkersCache.find(m => m.id === rule.shipMarkerId);
    // Phase 10: terrain cost + debris crossed (not for DM 'free' repositioning).
    let terrainWalkResult = null;
    if (rule.mode === 'capped' && typeof window.terrainRulesActive === 'function' && window.terrainRulesActive()) {
        terrainWalkResult = window.terrainWalk(dragVessel, { x: rule.x0, y: rule.y0 }, pos, null);
        distMoved = terrainWalkResult.cost;
    }
    const tokens = (window.globalBattleEncounterCache.tokens || []).map(t => {
        if (t.token_id !== rule.tokenId) return t;
        if (rule.mode === 'free') return { ...t, x: pos.x, y: pos.y }; // DM reposition: no move spent
        const prevRemaining = t.move_remaining !== undefined ? t.move_remaining : (dragVessel?.tactical_speed ?? 160);
        return { ...t, x: pos.x, y: pos.y, move_remaining: Math.max(0, Math.round((prevRemaining - distMoved) * 10) / 10) };
    });
    // Undo log (2026-10-01): every token move is recorded.
    return window.recordBattleAction('Move', async () => {
        await saveBattleTokens(tokens);
        if (terrainWalkResult && terrainWalkResult.debrisLen >= 5 && dragVessel) await window.terrainApplyDebris(dragVessel, terrainWalkResult.debrisLen);
    }).then(() => window.renderBattleMapPanel());
};
// A tap (press without a drag) on a token.
window.battleTokenTapped = function(shipMarkerId) {
    // Phase 4c: with the tactical HUD on, a tap selects the ship in the HUD first
    // (own ships stop here; FULL SHEET opens the terminal; hostiles still auto-target).
    if (typeof window.tv2HandleTokenTap === 'function' && window.tv2HandleTokenTap(shipMarkerId)) return;
    const clickedVessel = globalShipMarkersCache.find(m => m.id === shipMarkerId);
    if (clickedVessel && clickedVessel.iff === 'hostile' && !window.vesselHasOwner(clickedVessel, currentUserId)) {
        window.autoTargetAllMyWeapons(shipMarkerId);
        return;
    }
    if (typeof window.openFullVesselTerminal === 'function') window.openFullVesselTerminal(shipMarkerId);
};

/* Called from js/combat.js's advanceCombatRound (the same global tick every
   other per-round mechanic in this app already reuses — confirmed design,
   see file header). Refreshes every token's move_remaining back to its
   vessel's tactical_speed. No-op if there's no active battle. */
window.resetBattleMapMovement = async function() {
    if (!window.globalBattleEncounterCache) return;
    const tokens = (window.globalBattleEncounterCache.tokens || []).map(t => {
        const vessel = globalShipMarkersCache.find(m => m.id === t.ship_marker_id);
        // System Lockdown build (this session): an Engines-disabled vessel
        // gets its move allowance forced to 0 for the round instead of the
        // normal tactical_speed refill.
        const enginesDown = vessel && (vessel.disabled_engines_until || 0) > 0;
        return { ...t, move_remaining: enginesDown ? 0 : (vessel?.tactical_speed ?? 160) };
    });
    await saveBattleTokens(tokens);
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};
