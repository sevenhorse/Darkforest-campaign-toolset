/* ==========================================================================
   js/battle-map.js - Tactical Battle Map (Phase 1)
   ==========================================================================
   New this session. Confirmed design (see darkforest-architecture-reference.md
   checkpoints): a simple fixed-size arena, no pan/zoom/starfield — click to
   place, click to target. Full mutual visibility once in a battle (no FOW).
   Dragging a Secret Repository template onto the map creates a REAL
   ship_markers row via the existing window.deployShipTemplate flow — a
   battle token is a placement record pointing at a real vessel, never a
   parallel lightweight entity. Free drag-to-reposition (no movement rules/
   stats — that's an explicitly separate, not-yet-designed thread).

   Data shape: battle_encounters row = { id, name, is_active, created_by,
   created_at, tokens: [{ token_id, ship_marker_id, x, y }] }. Only one
   active battle at a time (Phase 1 scope) — starting a new one deactivates
   any currently-active row rather than deleting it (keeps history).

   Deliberately NOT in Phase 1 (see architecture doc): range rules, draw-tool
   AOE targeting, hex/grid overlay, multiple simultaneous battles, and the
   MLRS multi-turn ordnance/counter-fire engine itself (weapon classification
   groundwork for that exists in combat.js, but the actual resolution loop is
   a later build).

   --- MOVEMENT (built same session as a follow-up to Phase 1, confirmed
   design) --- No dedicated turn/initiative tracker: move_remaining refreshes
   on the SAME global tick every other per-round mechanic in this app already
   uses (js/combat.js's advanceCombatRound, via window.resetBattleMapMovement
   below) rather than inventing a separate turn concept. Allowance comes from
   a new ship_templates/ship_markers.tactical_speed stat (grid px/round,
   default 80), copied onto ship_markers at deploy time exactly like
   integrity_hull/max_hull already are — deliberately NOT derived from
   drive_type/speed, which is the galaxy-scale FTL travel stat and the wrong
   scale for this 460x380 grid. Enforcement is DM-trusted, not code-blocked:
   dragging a token past its move_remaining is never prevented, it just goes
   negative and renders red (roster line + a small "!" badge on the token)
   so the DM can see at a glance who overspent. move_remaining lives on the
   battle_encounters.tokens record itself (per-battle, per-round state —
   not on ship_markers, which persists across battles).

   --- BATTLEFIELD SALVAGE (built same session, layered on the destroyed-
   token hook below) --- Confirmed design: destroying a token spawns a
   battlefield_salvage row at a player-owned vessel's position (any player
   ship still in the battle, not necessarily the killing blow — no player
   ship present means no salvage). A manual "Gather" action (ship must be
   within SALVAGE_GATHER_RANGE) starts a DM/player-set duration timer
   against the existing universeTimeHours clock; completion is automatic
   once that clock passes the deadline (checked every time advancement, not
   just daily ticks, since a duration can be sub-day) and delivers the raw
   resource into the gathering vessel's cargo misc array. Separately, any
   vessel with BOTH the raw resource in cargo AND a configured
   salvage_processing_output/rate (new ship_markers columns, same
   nullable/zero-means-off convention as fleet_groups' production fields)
   converts some per day, scaled by its Manufacturing deck's HP% exactly
   like fleet-group production already does — see
   window.processSalvageConversion. Deliberately NOT built: any UI rendering
   of salvage markers on the galaxy canvas itself (map.js's render loop
   wasn't touched) — salvage is presented as a DOM list panel only, same
   pattern as Territory Control, not a clickable map token. */

window.globalBattleEncounterCache = null;
window.battleMapArmedToken = null; // { ship_marker_id } while a palette entry is armed for click-to-place, else null

function genBattleTokenId() { return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ('tok-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)); }

// Battle Map Grid Expansion build (this session): doubled from 460x380 to
// 920x760 (DM's confirmed choice, among 3 options presented) -- growing the
// actual LOGICAL battlespace, not just the visual zoom (see
// BATTLE_GRID_SCALE's own comment below for that distinction; this is the
// "actually growing the battlespace" lever it warns changing SCALE alone
// doesn't do). Raised at the DM's own request after Squadron AI Stances
// shipped: the grid hadn't grown since the very first Battle Map build,
// while token count and simultaneous visual effects had grown a lot since.
// Existing weapon `range` values are mostly 0/unset (this app's "unlimited"
// convention) so this is lower-risk than resizing usually would be -- see
// the Grid Expansion checkpoint notes for what WAS touched to keep relative
// mobility consistent (SQUADRON_TACTICAL_SPEED and the tactical_speed
// defaults for NEW ships, both doubled) and what deliberately WASN'T
// (existing ships' already-stored tactical_speed values -- not bulk-
// migrated; flagged, not silently left inconsistent). The index.html
// #battle-map-grid element's inline width/height must match these two
// constants exactly (same requirement as before this build -- see that
// element's own comment), and #battle-map-grid-wrap switched from a fixed
// clipped viewport to a scrollable one since the fully-scaled grid
// (920*1.5 x 760*1.5 = 1380x1140 CSS px) no longer fits most screens at
// once -- see that element's comment for the reasoning.
const BATTLE_GRID_W = 920;
const BATTLE_GRID_H = 760;
const BATTLE_TOKEN_SIZE = 34;
// Polish pass (this session, DM-reported): strike craft tokens were
// rendering at the exact same size as capital ships/stations (both used
// BATTLE_TOKEN_SIZE) -- the DM's "emblem needs to be much smaller" note.
// FLAGGED FIRST-PASS SIZE, DM-tunable, same as every other placeholder
// constant in this app.
const BATTLE_STRIKE_CRAFT_TOKEN_SIZE = 20;

// Visual-only zoom (tester feedback: "make the map bigger" -- see
// darkforest-architecture-reference.md's Battle Map layout addendum). The
// grid's LOGICAL coordinate space (BATTLE_GRID_W/H above, every stored
// token x/y, every weapon range and tactical_speed check via Math.hypot)
// is completely unchanged by this -- those are all still defined in the
// same 460x380 units they always were. Only the on-screen rendering is
// scaled up via CSS transform (index.html's #battle-map-grid), so a click
// or drag's raw mouse-pixel delta has to be divided by this factor before
// it means anything in logical grid units. Change this one constant (and
// the matching transform:scale()/wrapper size in index.html) to retune
// the visual size -- it deliberately does NOT touch tactical_speed or any
// weapon's range value, unlike actually growing the battlespace would.
const BATTLE_GRID_SCALE = 1.5;

/* Weapon Range Tiers build (this session, DM-confirmed design): four range
   bands, replacing the old ad hoc per-weapon placeholder numbers (300/450/
   650/700) with values derived from the grid's own size. LONG/MEDIUM/SHORT
   are 33% / 16.5% / 8.25% of the battle grid's DIAGONAL (sqrt(920^2+760^2)
   ~= 1193px), rounded to clean numbers -- the DM's own explicit pick of
   "diagonal" as what counts as the map's overall size, out of diagonal/
   width/average offered. The 4th tier (missiles/torpedoes, and a strike
   craft's own effective reach) isn't a number here at all: ship-mounted
   ordnance tubes get range 0 (unlimited launch distance, DM-confirmed)
   since they already travel over multiple turns via the existing
   ordnance-aging mechanic rather than hitting instantly, and a strike
   craft closes distance every round via moveTokenToward instead of
   needing a long weapon range to begin with. See getEffectiveWeaponRange
   and getUplinkedEnemyIds below for the two new rules built on top of
   these tiers (strike-craft-vs-capital short-range requirement, and the
   Messenger squadron's target-uplink exception to it). */
window.BATTLE_RANGE_TIERS = { LONG: 400, MEDIUM: 200, SHORT: 100 };

/* Squadron Target Uplink build (this session, DM-described mechanic, exact
   trigger/scope/duration NOT explicitly spec'd beyond "gets close enough" --
   my own concrete reading, flagged plainly per standing instruction 5:
   a Messenger-type squadron (STRIKE_CRAFT_DB's `messenger` entry) within
   SHORT range of an enemy ship "uplinks" that ship for its OWN side (same
   owner_id as the Messenger) for the rest of THIS round only -- recomputed
   fresh every time this is called, nothing persists across rounds. Returns
   a Set of ship_marker ids (enemy ships currently uplinked for forOwnerId).
   Deliberately does not care about the Messenger's own ai_stance -- this is
   read as a passive sensor/spotter effect of just being close, not an
   attack action, so a Manual-stance Messenger still projects it. */
function getUplinkedEnemyIds(forOwnerIds) {
    if (!window.globalBattleEncounterCache) return new Set();
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const messengerPositions = [];
    tokens.forEach(t => {
        const marker = globalShipMarkersCache.find(m => m.id === t.ship_marker_id);
        if (!marker || !marker.is_strike_craft || !window.ownerIdsShareOwner(window.vesselOwnerIds(marker), forOwnerIds)) return;
        const carrier = globalShipMarkersCache.find(c => c.id === marker.parent_id);
        const sq = carrier && (carrier.ship_deployed || []).find(s => s.id === marker.squadron_id);
        if (sq && sq.type === 'messenger') messengerPositions.push({ x: t.x, y: t.y });
    });
    const uplinked = new Set();
    if (messengerPositions.length === 0) return uplinked;
    tokens.forEach(t => {
        const target = globalShipMarkersCache.find(m => m.id === t.ship_marker_id);
        if (!target || window.ownerIdsShareOwner(window.vesselOwnerIds(target), forOwnerIds)) return; // only enemy ships get uplinked
        const isClose = messengerPositions.some(mp => Math.hypot(mp.x - t.x, mp.y - t.y) <= window.BATTLE_RANGE_TIERS.SHORT);
        if (isClose) uplinked.add(target.id);
    });
    return uplinked;
}
window.getUplinkedEnemyIds = getUplinkedEnemyIds;

/* Weapon Range Tiers + Squadron Target Uplink builds (this session):
   computes the ACTUAL max range (px) for `wpn` fired by `firerVessel` at
   `targetVessel` this round, folding in both new rules on top of whatever
   `wpn.range` already says (0 = unlimited, existing convention unchanged):
     1. (DM-confirmed, applies to BOTH manual fire and AI-stance auto-fire)
        A strike craft (`firerVessel.is_strike_craft`) attacking anything
        that ISN'T itself a strike craft is hard-capped at SHORT range,
        regardless of its own weapon's listed range and regardless of the
        squadron's own type/size -- "must close to within short range to
        hit," full stop, unless rule 2 below already granted an exception.
        Deliberately keyed on `!targetVessel.is_strike_craft` rather than
        `vessel_class === 'Capital'/'Escort'` -- most live ships don't have
        `vessel_class` set yet (see Pending list), and gating on it here
        would let an untagged capital ship get sniped at full weapon range
        by accident, which reads as a worse bug than being slightly broader
        than "escort/capital" than asked.
     2. (My own reading of "the messenger... allows medium and long range
        weapons to hit regardless of distance" -- not explicitly scoped to
        ship guns vs. squadron weapons in what was described, so applied to
        both here; flagging this as a judgment call, not a confirmed spec)
        If `targetVessel` is currently uplinked for `firerVessel`'s side
        (see getUplinkedEnemyIds above) AND `wpn`'s own range already
        qualifies as medium-or-long tier (>= MEDIUM), that weapon ignores
        range entirely against this target this round -- checked BEFORE
        rule 1, so it also lets a strike craft's medium/long weapon skip
        the short-range-vs-capital requirement once uplinked. A weapon
        that's short-tier or already unlimited gets no benefit from an
        uplink -- there's nothing for it to extend. */
function getEffectiveWeaponRange(wpn, firerVessel, targetVessel) {
    const tiers = window.BATTLE_RANGE_TIERS || { LONG: 400, MEDIUM: 200, SHORT: 100 };
    const baseRange = (wpn && wpn.range) || 0; // 0 = unlimited, existing convention

    if (firerVessel && targetVessel && baseRange >= tiers.MEDIUM) {
        const uplinked = getUplinkedEnemyIds(window.vesselOwnerIds(firerVessel));
        if (uplinked.has(targetVessel.id)) return 0; // unlimited this round
    }

    if (firerVessel && firerVessel.is_strike_craft && targetVessel && !targetVessel.is_strike_craft) {
        return baseRange > 0 ? Math.min(baseRange, tiers.SHORT) : tiers.SHORT;
    }

    return baseRange;
}
window.getEffectiveWeaponRange = getEffectiveWeaponRange;

/* --- ANIMATION ENGINE (built a prior session, confirmed scope: in-flight
   ordnance visualization, smooth token movement, direct-fire shot flashes, a
   decorative starfield backdrop — CSS/SVG-transform-driven per the DM's own
   choice, NOT a canvas/sprite pipeline, staying consistent with the rest of
   this file's plain-DOM approach. Strike-craft animation was explicitly out
   of scope at the time — squadrons had no real grid position (the
   "target-lock proxy" thread) and animating movement needs a real position
   to animate between. RESOLVED this session (see the Strike Craft Grid
   Position checkpoint below and window.addSquadronToBattleMap) — a
   squadron's token is a normal entry in battle_encounters.tokens now, so it
   flows through the exact same diff/reuse render loop and gets smooth
   movement + fire-beam flashes automatically, no separate animation path
   needed.

   Smooth token movement required a real architecture change: the grid used
   to be torn down (innerHTML = '') and rebuilt from scratch on every single
   render, which meant a token's DOM element never survived between renders
   — nothing for a CSS transition to animate FROM. The three maps below let
   the grid render function diff against what's already on screen and reuse
   existing elements (so style.left/top changes actually transition) instead
   of destroying and recreating everything every time. */
let battleMapTokenEls = {};        // token_id -> token DOM element (reused across renders)
let battleMapTokenMarkerIds = {};  // token_id -> ship_marker_id, kept even after a token is removed from `tokens` (see the destruction-effect pass below)
let battleMapPendingExplosions = []; // [{token_id, x, y}] staged by checkBattleTokenDestroyed just before a destroyed token is removed — see Visual Polish checkpoint
let battleMapOrdnanceEls = {};     // salvo_id -> ordnance marker DOM element
let battleMapPrevOrdnanceIds = new Set(); // salvo_ids seen on the previous render, to detect resolved/removed payloads
let battleMapLastEncounterId = null; // hard-resets the three maps above when the active battle itself changes

async function loadBattleEncounters() {
    // Battle music hook (2026-08 audio polish): this function already runs
    // on EVERY connected client via battle_encounters_stream below, whoever
    // started/ended the fight -- so comparing the active-state edge here
    // fires the music bed for the whole table, not just the DM's browser.
    const wasActive = !!window.globalBattleEncounterCache;
    const { data, error } = await db.from('battle_encounters').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(1);
    if (error) { console.error('loadBattleEncounters failed', error); return; }
    window.globalBattleEncounterCache = (data && data.length > 0) ? data[0] : null;
    const isActive = !!window.globalBattleEncounterCache;
    if (window.AudioEngine) {
        if (isActive && !wasActive) window.AudioEngine.startBattleMusic();
        else if (!isActive && wasActive) window.AudioEngine.stopBattleMusic();
    }
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
}

let battleEncountersRealtimeChannel = null;
function initBattleEncountersRealtimeChannel() {
    battleEncountersRealtimeChannel = db.channel('battle_encounters_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'battle_encounters' }, () => {
            loadBattleEncounters();
        })
        .subscribe();
}
window.initBattleEncountersRealtimeChannel = initBattleEncountersRealtimeChannel;
window.loadBattleEncounters = loadBattleEncounters;

window.toggleBattleMap = function() {
    const panel = document.getElementById('battle-map-panel');
    if (!panel) return;
    const opening = panel.style.display !== 'block';
    panel.style.display = opening ? 'block' : 'none';
    if (opening) { loadBattleEncounters(); }
};

window.startBattleEncounter = async function() {
    if (currentUserRole !== 'dm') return;
    const nameInput = document.getElementById('battle-map-name-input');
    const name = (nameInput && nameInput.value.trim()) || 'Untitled Engagement';

    if (window.globalBattleEncounterCache) {
        if (!(await window.showConfirmModal(`An engagement ("${window.globalBattleEncounterCache.name}") is already active. Starting a new one will end it (its record is kept, just marked inactive). Proceed?`))) return;
        await db.from('battle_encounters').update({ is_active: false }).eq('id', window.globalBattleEncounterCache.id);
    }

    const { error } = await db.from('battle_encounters').insert({ name, is_active: true, created_by: currentUserId, tokens: [] });
    if (error) { alert('Failed to start battle: ' + error.message); return; }
    if (nameInput) nameInput.value = '';
    await db.from('chat_logs').insert({ sender_id: null, content: `⚔️ [TACTICAL BATTLE MAP] Engagement started: "${name}".`, message_type: 'system' });
    if (window.AudioEngine) window.AudioEngine.playKlaxon();
    loadBattleEncounters();
};

window.endBattleEncounter = async function() {
    if (currentUserRole !== 'dm' || !window.globalBattleEncounterCache) return;
    if (!(await window.showConfirmModal(`End engagement "${window.globalBattleEncounterCache.name}"? The record is kept (marked inactive), tokens' underlying vessels are untouched.`))) return;
    await db.from('battle_encounters').update({ is_active: false }).eq('id', window.globalBattleEncounterCache.id);
    await db.from('chat_logs').insert({ sender_id: null, content: `⚔️ [TACTICAL BATTLE MAP] Engagement ended: "${window.globalBattleEncounterCache.name}".`, message_type: 'system' });
    loadBattleEncounters();
};

async function saveBattleTokens(tokens) {
    if (!window.globalBattleEncounterCache) return;
    window.globalBattleEncounterCache.tokens = tokens;
    await db.from('battle_encounters').update({ tokens }).eq('id', window.globalBattleEncounterCache.id);
}

function clampToGrid(x, y) {
    return {
        x: Math.max(0, Math.min(BATTLE_GRID_W - BATTLE_TOKEN_SIZE, x)),
        y: Math.max(0, Math.min(BATTLE_GRID_H - BATTLE_TOKEN_SIZE, y))
    };
}

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
    const newPos = (dist <= maxDist || dist === 0)
        ? { x: targetPos.x, y: targetPos.y }
        : clampToGrid(cur.x + dx * (maxDist / dist), cur.y + dy * (maxDist / dist));
    currentTokens[idx] = { ...cur, x: newPos.x, y: newPos.y };
    return currentTokens;
}


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

    const updatePayload = { tokens: newTokens, turn_order: turnOrder, current_turn_index: 0, round_number: 1, initiative_rolled: true };
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
        await db.from('battle_encounters').update({ tokens: newTokens, turn_order: newOrder, current_turn_index: newCurrentIndex < 0 ? encounter.current_turn_index : newCurrentIndex }).eq('id', encounter.id);
        Object.assign(encounter, { tokens: newTokens, turn_order: newOrder, current_turn_index: newCurrentIndex < 0 ? encounter.current_turn_index : newCurrentIndex });
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
    encounter.tokens = newTokens;
    // Bug-hunt pass (2026-09-24): this used to end in `.catch(...)` -- but a
    // Supabase query builder has no .catch() (only .then), so it threw a
    // TypeError right here: the AP spend was never saved and every manual
    // shot/launch/withdraw aborted the moment initiative had been rolled.
    // `.then(({ error }) => ...)` is the correct fire-and-forget form.
    db.from('battle_encounters').update({ tokens: newTokens }).eq('id', encounter.id)
        .then(({ error }) => { if (error) console.error('spendTokenAp: failed to persist AP spend', error); });
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
window.endCurrentTurn = async function() {
    const encounter = window.globalBattleEncounterCache;
    if (!encounter || !encounter.initiative_rolled) return;
    const turnOrder = encounter.turn_order || [];
    if (turnOrder.length === 0) return;

    const isDm = currentUserRole === 'dm';
    const curTok = (encounter.tokens || []).find(t => t.token_id === turnOrder[encounter.current_turn_index]);
    const curVessel = curTok ? globalShipMarkersCache.find(m => m.id === curTok.ship_marker_id) : null;
    if (!isDm && !(curVessel && window.vesselHasOwner(curVessel, currentUserId))) return;

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
    const newTokens = (freshEncounter.tokens || []).map(t => t.token_id === nextTok.token_id ? { ...t, ap_current: apMax } : t);

    const updatePayload = { tokens: newTokens, current_turn_index: idx };
    if (wrapped) updatePayload.round_number = (freshEncounter.round_number || 1) + 1;

    await db.from('battle_encounters').update(updatePayload).eq('id', freshEncounter.id);
    Object.assign(freshEncounter, updatePayload);

    await db.from('chat_logs').insert({ sender_id: null, content: `⏭️ [INITIATIVE] ${nextVessel.name}'s turn (${apMax} AP)${wrapped ? `, round ${updatePayload.round_number}` : ''}.`, message_type: 'system' });

    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
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
    const rect = grid.getBoundingClientRect();
    // rect is the POST-transform (visually scaled) box; divide by
    // BATTLE_GRID_SCALE to convert the click's raw screen-pixel offset back
    // into the logical 460x380 grid units clampToGrid/BATTLE_GRID_W expect.
    const raw = { x: (evt.clientX - rect.left) / BATTLE_GRID_SCALE - (BATTLE_TOKEN_SIZE / 2), y: (evt.clientY - rect.top) / BATTLE_GRID_SCALE - (BATTLE_TOKEN_SIZE / 2) };
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

// Shared dice-roll helper for the Range/Ordnance build — same regex/exploding
// logic already duplicated between rollShipWeapon and rollSquadronWeapon in
// js/combat.js, factored out here rather than duplicated a third time since
// both PD counter-fire and ordnance impact need it.
function rollDamageDice(diceStr, modifierStr, explodes) {
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
            if (sq.ai_stance !== 'intercept_munitions' || (sq.count || 0) <= 0) return;
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
            if (!entry.wpn.range || dist <= entry.wpn.range) return i;
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
    for (const salvo of (battle.in_flight_ordnance || [])) {
      try {
        const targetVessel = globalShipMarkersCache.find(m => m.id === salvo.target_vessel_id);
        const targetPos = targetVessel ? window.getBattleTokenPosition(targetVessel.id) : null;
        if (!targetVessel || !targetPos) {
            chatLines.push(`💨 [ORDNANCE] ${salvo.source_weapon_name} from ${salvo.source_vessel_name} loses its lock (${salvo.target_vessel_name} is no longer on the grid) and fizzles.`);
            continue;
        }

        const engagement = fireEligiblePD(targetPos, window.vesselOwnerIds(targetVessel));
        if (engagement && engagement.roll.total > 0) {
            chatLines.push(`🛡️ [POINT DEFENSE] ${engagement.pdVessel.name}'s ${engagement.pdWpn.name} intercepts a payload inbound on ${targetVessel.name} from ${salvo.source_vessel_name} (${engagement.roll.total} dmg) — destroyed!`);
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
            const result = window.resolveShipDamage(targetVessel, dmgType, total);
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
                integrity_hardened: result.integrity_hardened
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
                        const splashResult = window.resolveShipDamage(splashVessel, dmgType, splashTotal);
                        splashLog += splashResult.log;
                        Object.assign(splashVessel, {
                            integrity_shields: splashResult.integrity_shields, integrity_hull: splashResult.integrity_hull,
                            integrity_reactive: splashResult.integrity_reactive, integrity_ablative: splashResult.integrity_ablative,
                            integrity_hardened: splashResult.integrity_hardened
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
            if (sq.ai_stance !== 'attack_strike_craft' && sq.ai_stance !== 'attack_capitals' && sq.ai_stance !== 'attack_escorts') continue;
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
                    if (movedTokens) await saveBattleTokens(movedTokens);
                    chatLines.push(`🤖 [AI STANCE] ${sq.name} drops below 30% strength and breaks off, retreating toward ${v.name}.`);
                } // carrier not on the grid -- nothing to retreat toward, holds position silently
                continue; // no fire while retreating
            }

            let candidates = tokens
                .map(tok => globalShipMarkersCache.find(m => m.id === tok.ship_marker_id))
                .filter(Boolean)
                .filter(m => m.id !== sqShip.id && !window.ownerIdsShareOwner(window.vesselOwnerIds(m), window.vesselOwnerIds(sqShip)));

            if (sq.ai_stance === 'attack_strike_craft') {
                candidates = candidates.filter(m => m.is_strike_craft);
            } else if (sq.ai_stance === 'attack_capitals') {
                candidates = candidates.filter(m => !m.is_strike_craft && m.vessel_class === 'Capital');
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
                chatLines.push(`🤖 [AI STANCE] ${sq.name} (${sq.ai_stance.replace(/_/g, ' ')}) has no eligible enemy target on the grid this round -- holds position.`);
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
            if (movedTokens) await saveBattleTokens(movedTokens);
            const movedSelfTok = movedTokens ? movedTokens.find(t => t.ship_marker_id === sqShip.id) : null;
            const newSelfPos = movedSelfTok ? { x: movedSelfTok.x, y: movedSelfTok.y } : selfPos;

            const dbStats = STRIKE_CRAFT_DB[sq.type];
            if (!dbStats) continue;
            const desiredRole = sq.ai_stance === 'attack_strike_craft' ? 'anti_fighter' : 'anti_capital';
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
                chatLines.push(`🤖 [AI STANCE] ${sq.name} (${sq.ai_stance.replace(/_/g, ' ')}) has every weapon on cooldown -- holds fire.`);
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
                chatLines.push(`🤖 [AI STANCE] ${sq.name} (${sq.ai_stance.replace(/_/g, ' ')}) closes on ${bestTarget.name} but is still out of ${wpn.name}'s range (${wpn.range}) -- holds fire.`);
                continue;
            }

            // Squadron Target Uplink build (this session): cheap chat-log
            // tell so an uplinked shot doesn't look like a silent range-rule
            // violation to whoever's watching the log -- no other visual
            // indicator exists yet for which enemy ships are uplinked this
            // round (flagged, not built -- see Pending list).
            const uplinkNote = (wpn.range > 0 && effRangeForFire === 0) ? ' (target uplinked!)' : '';
            chatLines.push(`🤖 [AI STANCE] ${sq.name} (${sq.ai_stance.replace(/_/g, ' ')}) engages ${bestTarget.name}${uplinkNote}.`);
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
        const moveDist = v.tactical_speed || 160;

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

        // --- Move up to tactical_speed px toward the target's current position ---
        const movedTokens = moveTokenToward(v.id, targetPos, moveDist);
        if (movedTokens) await saveBattleTokens(movedTokens);
        const movedSelfTok = movedTokens ? movedTokens.find(t => t.ship_marker_id === v.id) : null;
        const newSelfPos = movedSelfTok ? { x: movedSelfTok.x, y: movedSelfTok.y } : selfPos;

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

            if (wpn.weapon_class === 'ordnance' && typeof window.resolveOrdnanceLaunch === 'function') {
                await window.resolveOrdnanceLaunch(v.id, wIdx, target.id, { auto: true });
            } else if (typeof window.resolveShipWeaponFire === 'function') {
                await window.resolveShipWeaponFire(v.id, wIdx, target.id, 1, { auto: true });
            }
            firedAny = true;
        }
        chatLines.push(firedAny
            ? `🤖 [AI CONTROLLED] ${v.name} engages ${target.name}.`
            : `🤖 [AI CONTROLLED] ${v.name} closes on ${target.name} but has no weapon in range -- holds fire.`);

        // --- Persist target lock (informational) + reset this round's hit tracking ---
        await db.from('ship_markers').update({ ai_current_target_id: target.id, round_biggest_hit_amount: 0, round_biggest_hit_by: null }).eq('id', v.id);
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
    try {
        await db.from('battle_encounters').update({ in_flight_ordnance: survivingOrdnance }).eq('id', battle.id);
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

/* --- BATTLEFIELD SALVAGE: data + panel --- */
window.globalBattlefieldSalvageCache = [];
const SALVAGE_GATHER_RANGE = 300; // matches the hazard-zone default radius already used elsewhere as this app's "nearby" scale

async function loadBattlefieldSalvage() {
    const { data, error } = await db.from('battlefield_salvage').select('*').order('created_at', { ascending: true });
    if (error) { console.error('loadBattlefieldSalvage failed', error); return; }
    window.globalBattlefieldSalvageCache = data || [];
    if (typeof window.renderSalvagePanel === 'function') window.renderSalvagePanel();
}
window.loadBattlefieldSalvage = loadBattlefieldSalvage;

let battlefieldSalvageRealtimeChannel = null;
function initBattlefieldSalvageRealtimeChannel() {
    battlefieldSalvageRealtimeChannel = db.channel('battlefield_salvage_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'battlefield_salvage' }, () => {
            loadBattlefieldSalvage();
        })
        .subscribe();
}
window.initBattlefieldSalvageRealtimeChannel = initBattlefieldSalvageRealtimeChannel;

window.toggleSalvagePanel = function() {
    const panel = document.getElementById('salvage-panel');
    if (!panel) return;
    const opening = panel.style.display !== 'block';
    panel.style.display = opening ? 'block' : 'none';
    if (opening) loadBattlefieldSalvage();
};

window.startSalvageGather = async function(salvageId) {
    const rec = window.globalBattlefieldSalvageCache.find(r => r.id === salvageId);
    if (!rec || rec.status !== 'available') return;
    const shipSelect = document.getElementById(`salvage-ship-${salvageId}`);
    const durationInput = document.getElementById(`salvage-duration-${salvageId}`);
    if (!shipSelect || !shipSelect.value) { alert('Select a vessel to gather with first.'); return; }
    const ship = globalShipMarkersCache.find(m => m.id === shipSelect.value);
    if (!ship) return;
    const dist = Math.hypot(ship.x - rec.x, ship.y - rec.y);
    if (dist > SALVAGE_GATHER_RANGE) { alert(`${ship.name} is too far from the wreckage to begin gathering (must be within ${SALVAGE_GATHER_RANGE} units).`); return; }
    const duration = Math.max(1, parseFloat(durationInput && durationInput.value) || 24);

    const { error } = await db.from('battlefield_salvage').update({
        status: 'gathering', gathering_ship_id: ship.id,
        gather_started_at_hours: window.universeTimeHours, gather_duration_hours: duration
    }).eq('id', salvageId);
    if (error) { alert('Failed to start gathering: ' + error.message); return; }
    await db.from('chat_logs').insert({ sender_id: null, content: `⏳ [SALVAGE] ${ship.name} began recovering wreckage — ready in ${duration}h.`, message_type: 'system' });
    loadBattlefieldSalvage();
};

window.updateSalvageQty = async function(salvageId) {
    if (currentUserRole !== 'dm') return;
    const input = document.getElementById(`salvage-qty-${salvageId}`);
    if (!input) return;
    const qty = Math.max(0, parseInt(input.value) || 0);
    await db.from('battlefield_salvage').update({ qty }).eq('id', salvageId);
    loadBattlefieldSalvage();
};

/* Runs on EVERY time advancement (js/ui.js processTimeAdvancement), not just
   daily ticks — a gather duration can be sub-day. Queries the DB directly
   rather than the local cache, since whichever client advances time should
   resolve every completed gather regardless of that client's own cache
   freshness. */
window.processSalvageGatherCompletion = async function(newHours) {
    const { data, error } = await db.from('battlefield_salvage').select('*').eq('status', 'gathering');
    if (error || !data || data.length === 0) return;
    let any = false;
    for (const rec of data) {
        if (rec.gather_started_at_hours === null || rec.gather_duration_hours === null) continue;
        if (newHours < rec.gather_started_at_hours + rec.gather_duration_hours) continue;
        const ship = globalShipMarkersCache.find(m => m.id === rec.gathering_ship_id);
        if (!ship) continue; // gathering vessel no longer exists — leave the record rather than silently discarding it

        // Bug-hunt pass (2026-09-24): claim the record FIRST by deleting it
        // and checking we were the one who deleted it. Two clients (or two
        // overlapping time ticks) processing the same completed gather used
        // to BOTH deliver the salvage before either deleted the record --
        // double cargo. Now only the client whose delete actually removed
        // the row delivers; if delivery then fails, the record is put back
        // so the next tick retries it instead of the salvage vanishing.
        const { data: claimed, error: claimErr } = await db.from('battlefield_salvage').delete().eq('id', rec.id).select();
        if (claimErr || !claimed || claimed.length === 0) continue; // already claimed/delivered elsewhere

        let cargo = (typeof window.sanitizeCargo === 'function') ? window.sanitizeCargo(ship.cargo_inventory || {}) : (ship.cargo_inventory || {});
        let existing = cargo.misc.find(i => (i.name || '').toLowerCase() === (rec.resource_name || '').toLowerCase());
        if (existing) existing.qty += rec.qty;
        else cargo.misc.push({ name: rec.resource_name, qty: rec.qty, unit: rec.unit || 'Tons' });

        const { error: deliverErr } = await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', ship.id);
        if (deliverErr) {
            console.error('processSalvageGatherCompletion: delivery failed, restoring salvage record for retry', deliverErr);
            await db.from('battlefield_salvage').insert(rec);
            if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData(); // resync the cargo cache we just touched
            continue;
        }
        ship.cargo_inventory = cargo;
        await db.from('chat_logs').insert({ sender_id: null, content: `📦 [SALVAGE] ${ship.name} recovered ${rec.qty}x ${rec.resource_name}.`, message_type: 'system' });
        any = true;
    }
    if (any) {
        // Pending-list follow-up (this session): "gather/salvage complete
        // has no chime hookup" — reusing playChime, the same SFX the Daily
        // Logistics 24-hour-cycle completion already uses for "something
        // finished" (js/ui.js), rather than inventing a new sound for this.
        if (window.AudioEngine) window.AudioEngine.playChime();
        loadBattlefieldSalvage();
        if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
    }
};

/* Manufacturing-deck post-processing — same once-daily cadence and linear
   HP-scaling pattern as window.processFleetGroupProduction (js/colonies.js),
   just sourced from per-ship salvage_processing_output/rate fields instead
   of a fleet_groups row, and consuming a cargo item instead of producing
   from nothing. Per-vessel try/catch isolation matches that function's own
   defense-in-depth convention (one bad vessel shouldn't block the rest). */
window.processSalvageConversion = async function(daysPassed) {
    if (typeof globalShipMarkersCache === 'undefined') return;
    for (const vessel of globalShipMarkersCache) {
        try {
            if (!vessel.salvage_processing_output || !(vessel.salvage_processing_rate > 0)) continue;
            let cargo = (typeof window.sanitizeCargo === 'function') ? window.sanitizeCargo(vessel.cargo_inventory || {}) : (vessel.cargo_inventory || {});
            let rawIdx = cargo.misc.findIndex(i => i.name.toLowerCase() === 'unprocessed wreckage salvage');
            if (rawIdx < 0 || !(cargo.misc[rawIdx].qty > 0)) continue;

            const mfgDeck = (vessel.ship_decks || []).find(d => d.type === 'manufacturing');
            const scale = mfgDeck ? Math.max(0, (mfgDeck.hp || 0) / (mfgDeck.max_hp || 1)) : 1;
            const maxConvertible = Math.max(0, Math.round(vessel.salvage_processing_rate * scale) * daysPassed);
            if (maxConvertible <= 0) continue;
            const consumed = Math.min(maxConvertible, cargo.misc[rawIdx].qty);
            if (consumed <= 0) continue;

            cargo.misc[rawIdx].qty -= consumed;
            if (cargo.misc[rawIdx].qty <= 0) cargo.misc.splice(rawIdx, 1);
            let outIdx = cargo.expendables.findIndex(i => i.name.toLowerCase() === vessel.salvage_processing_output.toLowerCase());
            if (outIdx >= 0) cargo.expendables[outIdx].qty += consumed;
            else cargo.expendables.push({ name: vessel.salvage_processing_output, qty: consumed, unit: 'Units' });

            await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vessel.id);
            vessel.cargo_inventory = cargo;
            await db.from('chat_logs').insert({
                sender_id: null,
                content: `⚙ [SALVAGE PROCESSING] ${vessel.name} refined ${consumed}x Unprocessed Wreckage Salvage into ${consumed}x ${vessel.salvage_processing_output}${mfgDeck ? ` (Manufacturing deck at ${Math.round(scale * 100)}%)` : ''}.`,
                message_type: 'system'
            });
        } catch (err) {
            console.error(`processSalvageConversion: failed for vessel "${vessel.name}" (${vessel.id})`, err);
        }
    }
};

window.saveSalvageProcessingConfig = async function(vesselId) {
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    if (currentUserRole !== 'dm' && !window.vesselHasOwner(vessel, currentUserId)) return;
    const outputInput = document.getElementById(`salvage-proc-output-${vesselId}`);
    const rateInput = document.getElementById(`salvage-proc-rate-${vesselId}`);
    const output = outputInput ? outputInput.value.trim() : '';
    const rate = Math.max(0, parseInt(rateInput && rateInput.value) || 0);
    const { error } = await db.from('ship_markers').update({ salvage_processing_output: output || null, salvage_processing_rate: rate }).eq('id', vesselId);
    if (error) { alert('Failed to save processing config: ' + error.message); return; }
    vessel.salvage_processing_output = output || null;
    vessel.salvage_processing_rate = rate;
    if (typeof window.showToast === 'function') window.showToast('Salvage processing configuration saved.');
};

/* Called from js/combat.js's renderVesselDeck weapon-target dropdown. Returns
   null when there's no restriction to apply (no active battle, or this
   vessel isn't currently a token in it) so the caller falls back to its
   existing full-galaxy target list unchanged. Returns an array of
   {id, name} (battle tokens other than the vessel itself) otherwise. */
// Small shared lookup used across Movement, Range, and the ordnance/PD
// automation below — returns the {x,y} of a ship_marker's current token in
// the active battle, or null if there's no active battle or it isn't in it.
window.getBattleTokenPosition = function(vesselId) {
    if (!window.globalBattleEncounterCache) return null;
    const tok = (window.globalBattleEncounterCache.tokens || []).find(t => t.ship_marker_id === vesselId);
    return tok ? { x: tok.x, y: tok.y } : null;
};

// `range` (optional, grid px) added this session for the Range/Ordnance
// build: when provided and > 0, candidates further than `range` from the
// firing vessel's own token are filtered out. 0/undefined preserves the
// original "no restriction" behavior — legacy callers that don't pass a
// range are completely unaffected.
// Fog of War build (this session): a hidden vessel is also excluded here --
// this is the single choke point behind BOTH ship_weapons' and squadron
// weapons' target dropdowns (js/combat.js), so filtering here covers both
// surfaces at once instead of duplicating the check at each call site. Uses
// window.isVesselVisibleToMe so the vessel's own player-owner (if any) still
// sees it in their own dropdown even while it's hidden from everyone else.
// Weapon Range Tiers build (this session): now takes an optional `opts`
// ({ firerVessel, wpn }) so the per-CANDIDATE effective range (short-range-
// vs-capital cap, target-uplink exception -- see getEffectiveWeaponRange
// above) can be applied instead of one flat `range` for every candidate.
// Every existing caller was updated to pass it; `range` alone still works
// as a plain flat-distance filter for any caller that doesn't (none left,
// kept for safety/back-compat rather than assuming every call site here
// and in every other file got updated).
window.getBattleScopedTargets = function(vesselId, range, opts) {
    if (!window.globalBattleEncounterCache) return null;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const selfToken = tokens.find(t => t.ship_marker_id === vesselId);
    if (!selfToken) return null;
    const firerVessel = (opts && opts.firerVessel) || globalShipMarkersCache.find(m => m.id === vesselId);
    const wpn = opts && opts.wpn;
    return tokens.filter(t => t.ship_marker_id !== vesselId).filter(t => {
        const targetVessel = globalShipMarkersCache.find(sm => sm.id === t.ship_marker_id);
        const effRange = (wpn && typeof getEffectiveWeaponRange === 'function')
            ? getEffectiveWeaponRange(wpn, firerVessel, targetVessel)
            : range;
        if (!effRange) return true;
        return Math.hypot(t.x - selfToken.x, t.y - selfToken.y) <= effRange;
    }).map(t => globalShipMarkersCache.find(sm => sm.id === t.ship_marker_id))
      .filter(Boolean)
      .filter(m => (typeof window.isVesselVisibleToMe === 'function') ? window.isVesselVisibleToMe(m) : true)
      .map(m => ({ id: m.id, name: m.name, is_strike_craft: m.is_strike_craft }));
};

/* Ordnance LAUNCH (Range/Ordnance build, this session). An ordnance-classified
   weapon's button calls this instead of window.rollShipWeapon. If the firer
   isn't currently a token in an active battle, there's no grid to track a
   multi-turn flight against, so this just delegates straight to the old
   instant-resolve behavior — same fallback pattern as every other
   battle-scoped feature in this file. Inside an active battle, this
   validates + consumes ammo/cooldown exactly like a normal shot (mirroring
   rollShipWeapon's own checks, since this replaces that call for ordnance
   weapons specifically) but does NOT roll damage — it snapshots the
   weapon's profile into a new battle_encounters.in_flight_ordnance entry
   instead. Aging, the turn-1 split into 6, PD auto-fire, and impact
   resolution all happen in window.processBattleRoundAutomations, called
   from combat.js's advanceCombatRound. */
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
    ordnance.push({
        salvo_id: genBattleTokenId(),
        source_vessel_id: vesselId, source_vessel_name: vessel.name,
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

// Shared by deployTemplateToBattle and deployFleetToBattle (Saved Fleets
// follow-on, this session) — same stagger formula both used to duplicate.
// tokenCount is however many tokens are already placed (plus however many
// this same batch-deploy has already placed before this call).
function staggeredTokenPos(tokenCount) {
    const stagger = tokenCount * 24;
    return clampToGrid(20 + (stagger % (BATTLE_GRID_W - 60)), 20 + Math.floor(stagger / (BATTLE_GRID_W - 60)) * 40);
}

window.deployTemplateToBattle = async function() {
    if (currentUserRole !== 'dm' || !window.globalBattleEncounterCache) return;
    const select = document.getElementById('battle-map-template-select');
    if (!select || !select.value) { alert('Select a template first.'); return; }
    const newId = await window.deployShipTemplate(select.value);
    if (!newId) return; // deployShipTemplate already alerted on failure
    // deployShipTemplate fires its own loadGalaxyData() without awaiting it,
    // so globalShipMarkersCache may not have the new marker yet — await our
    // own call here so the token we're about to place doesn't briefly render
    // as "(vessel not found)" on the DM's own client.
    if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
    const tokens = (window.globalBattleEncounterCache.tokens || []).slice();
    const pos = staggeredTokenPos(tokens.length);
    const newVessel = globalShipMarkersCache.find(m => m.id === newId);
    tokens.push({ token_id: genBattleTokenId(), ship_marker_id: newId, x: pos.x, y: pos.y, move_remaining: newVessel?.tactical_speed ?? 160 });
    await saveBattleTokens(tokens);
    window.renderBattleMapPanel();
};

// Saved Fleets follow-on (this session) — deploys every member of a saved
// fleet composition in one click instead of one deployTemplateToBattle
// click per vessel. Loops window.deployShipTemplate once per unit (quantity
// times per member) — each call is the SAME real deploy path a single
// template deploy already uses, so a fleet vessel is exactly as fresh/
// fully-stocked as if placed individually; there's no separate "fleet
// vessel" data model and nothing carries over from a prior battle, since
// each deploy creates a brand-new ship_markers row.
//
// Pending-list follow-up (this session): originally had no confirmation
// prompt at all (an asymmetry with every other DM action in this panel,
// flagged in the checkpoint notes) and silently skipped any member whose
// saved template_id no longer resolved to a real template — deployShipTemplate
// only alerts on a genuine DB insert error, not on "template not found", so
// a deleted-template member used to just vanish from the placed count with
// nothing surfaced anywhere. Both closed out: missing-template members are
// now detected up front and named in the confirm prompt (and in the
// resulting chat log line) instead of silently disappearing mid-loop.
window.deployFleetToBattle = async function() {
    if (currentUserRole !== 'dm' || !window.globalBattleEncounterCache) return;
    const select = document.getElementById('battle-map-fleet-select');
    if (!select || !select.value) { alert('Select a saved fleet first.'); return; }
    const fleet = (window.globalSavedFleetsCache || []).find(f => f.id === select.value);
    if (!fleet) return;
    const members = fleet.members || [];
    if (members.length === 0) { alert(`"${fleet.name}" has no vessels in it yet — add some from the Secret Repository first.`); return; }

    const missingMembers = members.filter(m => !findAnyTemplateById(m.template_id));
    const deployableUnitCount = members.reduce((sum, m) => sum + (findAnyTemplateById(m.template_id) ? (m.quantity || 1) : 0), 0);

    let confirmMsg = `Deploy "${fleet.name}" (${deployableUnitCount} vessel${deployableUnitCount === 1 ? '' : 's'}) to the battle grid?`;
    if (missingMembers.length > 0) {
        confirmMsg += `\n\n[WARNING] ${missingMembers.length} member${missingMembers.length === 1 ? '' : 's'} of this fleet reference${missingMembers.length === 1 ? 's' : ''} a template that no longer exists in the repository and will be SKIPPED.`;
    }
    if (!(await window.showConfirmModal(confirmMsg))) return;

    let tokens = (window.globalBattleEncounterCache.tokens || []).slice();
    let placedCount = 0;
    for (const member of members) {
        if (!findAnyTemplateById(member.template_id)) continue; // already warned above — skip entirely, don't attempt
        for (let i = 0; i < (member.quantity || 1); i++) {
            const newId = await window.deployShipTemplate(member.template_id);
            if (!newId) continue; // deployShipTemplate already alerted on a real DB error — skip this unit, keep going with the rest of the fleet
            if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
            const pos = staggeredTokenPos(tokens.length);
            const newVessel = globalShipMarkersCache.find(m => m.id === newId);
            tokens.push({ token_id: genBattleTokenId(), ship_marker_id: newId, x: pos.x, y: pos.y, move_remaining: newVessel?.tactical_speed ?? 160 });
            placedCount++;
        }
    }
    await saveBattleTokens(tokens);
    let logMsg = `⚔️ [TACTICAL BATTLE MAP] ${fleet.name} deployed — ${placedCount} vessel${placedCount === 1 ? '' : 's'} placed.`;
    if (missingMembers.length > 0) logMsg += ` (${missingMembers.length} member${missingMembers.length === 1 ? '' : 's'} skipped — deleted template.)`;
    await db.from('chat_logs').insert({ sender_id: null, content: logMsg, message_type: 'system' });
    window.renderBattleMapPanel();
};

function battleTokenHpColor(vessel) {
    if (!vessel) return '#6b826a';
    const max = vessel.max_hull || 100;
    const cur = vessel.integrity_hull !== undefined ? vessel.integrity_hull : max;
    const pct = max > 0 ? cur / max : 1;
    if (pct > 0.66) return '#00e5a3';
    if (pct > 0.33) return '#ffaa00';
    return '#ff3333';
}

/* Visual Polish build (this session, confirmed design): "player-owned" (an
   owner profile with role !== 'dm') is the same heuristic already used
   throughout this app (renderBattleShipCards' fullDetail check, Battlefield
   Salvage's spawn condition, Ground Combat's PC-vs-NPC filter) rather than a
   new one invented for this. For the DM's own view this naturally collapses
   to a clean 2-tier result (every player ship reads as "ally" green, every
   DM/NPC ship reads red) since no player id ever equals the DM's own
   currentUserId. For a player's view it's a real 3-tier read: their own
   ship (cyan), another player's (green), DM/NPC (red). */
function battleTokenFactionColor(vessel) {
    if (!vessel) return '#6b826a';
    const ownerProfs = window.vesselOwnerIds(vessel).map(id => (typeof allProfiles !== 'undefined' ? allProfiles : []).find(p => p.id === id)).filter(Boolean);
    const isPlayerOwned = ownerProfs.some(p => p.role !== 'dm');
    if (!isPlayerOwned) return '#ff3333';           // DM/NPC-owned (or unowned) — hostile/neutral
    if (window.vesselHasOwner(vessel, currentUserId)) return '#00e1ff'; // I'm one of its owners
    return '#00e5a3';                                // another player's vessel (I'm not a co-owner) — ally
}

/* Native drag (mousedown/mousemove/mouseup), constrained to the grid bounds,
   same pattern as makePanelDraggable (js/ui.js) but scoped to a token div
   inside the arena rather than a whole floating panel. A short-drag (< 5px)
   is treated as a click (opens the vessel terminal) rather than a move.

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
    let isDragging = false, moved = false, startX, startY, initialLeft, initialTop;
    let lastTouchX = 0, lastTouchY = 0, lastTouchEndAt = 0;
    function beginDrag(clientX, clientY) {
        isDragging = true; moved = false;
        startX = clientX; startY = clientY;
        const liveToken = ((window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || []).find(t => t.token_id === tokenId);
        initialLeft = liveToken ? liveToken.x : (parseFloat(tokenEl.style.left) || 0);
        initialTop = liveToken ? liveToken.y : (parseFloat(tokenEl.style.top) || 0);
        // Suspend the CSS position transition (see .battle-token-el in
        // style.css) for the duration of this drag -- otherwise every move
        // write would animate TOWARD the new value instead of tracking the
        // pointer directly. Restored on drop.
        tokenEl.style.transition = 'none';
    }
    // Screen-pixel deltas are divided by BATTLE_GRID_SCALE because the token
    // lives inside #battle-map-grid's CSS transform:scale().
    function moveDrag(clientX, clientY) {
        if (!isDragging) return;
        const dx = (clientX - startX) / BATTLE_GRID_SCALE, dy = (clientY - startY) / BATTLE_GRID_SCALE;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
        const pos = clampToGrid(initialLeft + dx, initialTop + dy);
        tokenEl.style.left = pos.x + 'px'; tokenEl.style.top = pos.y + 'px';
    }
    function endDrag(clientX, clientY) {
        if (!isDragging) return;
        isDragging = false;
        tokenEl.style.transition = '';
        if (moved) {
            const dx = (clientX - startX) / BATTLE_GRID_SCALE, dy = (clientY - startY) / BATTLE_GRID_SCALE;
            const pos = clampToGrid(initialLeft + dx, initialTop + dy);
            const distMoved = Math.hypot(pos.x - initialLeft, pos.y - initialTop);
            const dragVessel = globalShipMarkersCache.find(m => m.id === shipMarkerId);
            const tokens = (window.globalBattleEncounterCache.tokens || []).map(t => {
                if (t.token_id !== tokenId) return t;
                const prevRemaining = t.move_remaining !== undefined ? t.move_remaining : (dragVessel?.tactical_speed ?? 160);
                return { ...t, x: pos.x, y: pos.y, move_remaining: Math.round((prevRemaining - distMoved) * 10) / 10 };
            });
            saveBattleTokens(tokens).then(() => window.renderBattleMapPanel());
        } else {
            const clickedVessel = globalShipMarkersCache.find(m => m.id === shipMarkerId);
            if (clickedVessel && clickedVessel.iff === 'hostile' && !window.vesselHasOwner(clickedVessel, currentUserId)) {
                window.autoTargetAllMyWeapons(shipMarkerId);
                return;
            }
            if (typeof window.openFullVesselTerminal === 'function') window.openFullVesselTerminal(shipMarkerId);
        }
    }
    tokenEl.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (Date.now() - lastTouchEndAt < 800) return; // browser's synthetic mouse event after a touch -- already handled
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
        beginDrag(t.clientX, t.clientY);
    }, { passive: true });
    tokenEl.addEventListener('touchmove', (e) => {
        if (!isDragging || e.touches.length !== 1) return;
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

// Salvage stays a normal draggable floating panel. Battle Map itself is NO
// LONGER draggable as of this session's full-screen build — it's now a
// fixed full-viewport overlay (same convention as #character-terminal),
// so a drag call on it would be meaningless/broken.
if (typeof makePanelDraggable === 'function') makePanelDraggable('salvage-panel', 'salvage-header', 'odyssey_salvage_pos');

window.renderSalvagePanel = function() {
    const container = document.getElementById('salvage-list-container');
    if (!container) return; // panel not in DOM yet
    const records = window.globalBattlefieldSalvageCache || [];
    if (records.length === 0) {
        container.innerHTML = '<span style="font-size:10px; color:#6b826a;">No recoverable wreckage detected.</span>';
        return;
    }
    const myShips = globalShipMarkersCache.filter(m => !m.is_strike_craft && window.vesselHasOwner(m, currentUserId));
    const shipOptionsHtml = myShips.map(m => `<option value="${m.id}">${m.name}</option>`).join('') || '<option value="">-- No vessels --</option>';

    container.innerHTML = records.map(rec => {
        const posLabel = `(${Math.round(rec.x)}, ${Math.round(rec.y)})`;
        if (rec.status === 'gathering') {
            const readyAt = (rec.gather_started_at_hours || 0) + (rec.gather_duration_hours || 0);
            const remainingH = Math.max(0, Math.round((readyAt - (window.universeTimeHours || 0)) * 10) / 10);
            const gatheringShip = globalShipMarkersCache.find(m => m.id === rec.gathering_ship_id);
            return `<div class="note-card" style="padding:6px; background:#030403; border-color:#ffaa00;">
                <div style="font-size:10px; color:#ffaa00;">⏳ Gathering at ${posLabel}</div>
                <div style="font-size:9px; color:#d4c5a9;">${gatheringShip ? gatheringShip.name : '(vessel missing)'} recovering ${rec.qty}x ${rec.resource_name} — ready in ~${remainingH}h.</div>
            </div>`;
        }
        // status === 'available'
        const dmQtyControl = currentUserRole === 'dm' ? `
            <div style="display:flex; gap:4px; align-items:center; margin-top:4px;">
                <label for="salvage-qty-${rec.id}" style="font-size:8px; color:#6b826a;">Qty:</label>
                <input type="number" id="salvage-qty-${rec.id}" value="${rec.qty}" min="0" style="width:50px; margin:0; font-size:9px; padding:2px; text-align:center;">
                <button class="layer-edit" onclick="window.updateSalvageQty('${rec.id}')" style="font-size:8px; padding:2px 6px;">SAVE</button>
            </div>` : '';
        return `<div class="note-card" style="padding:6px; background:#030403; border-color:#c9962f;">
            <div style="font-size:10px; color:#c9962f;">🛰️ Wreckage at ${posLabel}${rec.source_vessel_name ? ` — from ${rec.source_vessel_name}` : ''}</div>
            <div style="font-size:9px; color:#d4c5a9;">${rec.qty}x ${rec.resource_name}</div>
            <div style="display:flex; gap:4px; margin-top:4px; align-items:center;">
                <label for="salvage-ship-${rec.id}" style="display:none;">Gathering vessel</label>
                <select id="salvage-ship-${rec.id}" style="flex:1.5; margin:0; font-size:9px; padding:3px;">${shipOptionsHtml}</select>
                <label for="salvage-duration-${rec.id}" style="display:none;">Duration (hours)</label>
                <input type="number" id="salvage-duration-${rec.id}" value="24" min="1" title="Gather duration, hours" style="width:45px; margin:0; font-size:9px; padding:3px; text-align:center;">
                <button class="btn-deploy" onclick="window.startSalvageGather('${rec.id}')" style="font-size:9px; padding:3px 8px;">GATHER</button>
            </div>
            ${dmQtyControl}
        </div>`;
    }).join('');
};

window.renderBattleMapPanel = function() {
    const dmControls = document.getElementById('battle-map-dm-controls');
    const inactiveMsg = document.getElementById('battle-map-inactive-msg');
    const activeContainer = document.getElementById('battle-map-active-container');
    if (!dmControls || !inactiveMsg || !activeContainer) return; // panel not in DOM yet

    const encounter = window.globalBattleEncounterCache;
    const isDm = currentUserRole === 'dm';

    dmControls.style.display = (isDm && !encounter) ? 'block' : 'none';
    inactiveMsg.style.display = encounter ? 'none' : 'block';
    // activeContainer is now the two-column .battle-map-layout flex box
    // (full-screen build, this session) — 'flex', not 'block', or the grid
    // + ship-cards columns collapse back to a single stacked column.
    activeContainer.style.display = encounter ? 'flex' : 'none';
    if (!encounter) return;

    document.getElementById('battle-map-encounter-name').innerText = encounter.name;
    const endBtn = document.getElementById('battle-map-end-btn');
    if (endBtn) endBtn.style.display = isDm ? 'inline-block' : 'none';
    // Initiative + Action Economy build (this session): ADVANCE ROUND is now
    // only the pre-initiative free-for-all's round tick -- once a battle has
    // real initiative rolled, ending the last turn in the order fires the
    // exact same tick automatically (window.endCurrentTurn), so a DM
    // manually clicking ADVANCE ROUND mid-turn-order would desync the two.
    // ROLL INITIATIVE is the mirror image: only useful before that's
    // happened for this battle.
    const advanceBtn = document.getElementById('battle-map-advance-btn');
    // ADVANCE ROUND was already functionally DM-only (advanceCombatRound
    // itself returns immediately for a non-DM caller) but the button had no
    // visibility check of its own, so a player saw a clickable button that
    // silently did nothing -- tester feedback asked for it hidden outright.
    // Same toggle pattern as endBtn above.
    if (advanceBtn) advanceBtn.style.display = (isDm && !encounter.initiative_rolled) ? 'inline-block' : 'none';
    const rollInitBtn = document.getElementById('battle-map-roll-initiative-btn');
    if (rollInitBtn) rollInitBtn.style.display = (isDm && !encounter.initiative_rolled) ? 'inline-block' : 'none';
    const dmDeploy = document.getElementById('battle-map-dm-deploy');
    if (dmDeploy) dmDeploy.style.display = isDm ? 'block' : 'none';

    const tokens = encounter.tokens || [];

    // --- Turn bar (Initiative + Action Economy build, this session) ---
    const turnBar = document.getElementById('battle-map-turn-bar');
    if (turnBar) {
        if (encounter.initiative_rolled && (encounter.turn_order || []).length > 0) {
            turnBar.style.display = 'flex';
            const turnOrder = encounter.turn_order || [];
            const curTokId = turnOrder[encounter.current_turn_index];
            const curTok = tokens.find(t => t.token_id === curTokId);
            const curVessel = curTok ? globalShipMarkersCache.find(m => m.id === curTok.ship_marker_id) : null;
            const turnInfo = document.getElementById('battle-map-turn-info');
            if (turnInfo) {
                turnInfo.innerText = curVessel
                    ? `Round ${encounter.round_number || 1} — ${curVessel.name}'s turn (AP ${curTok.ap_current || 0}/${window.getTokenApMax(curVessel)})`
                    : `Round ${encounter.round_number || 1} — (current unit not found)`;
            }
            const endTurnBtn = document.getElementById('battle-map-endturn-btn');
            if (endTurnBtn) {
                const canEndTurn = isDm || (curVessel && window.vesselHasOwner(curVessel, currentUserId));
                endTurnBtn.style.display = canEndTurn ? 'inline-block' : 'none';
            }
            // Cheap, idempotent tail check (own in-flight guard) -- picks up
            // any token placed/launched onto the grid after initiative was
            // first rolled for this battle.
            if (typeof window.ensureNewTokensInTurnOrder === 'function') window.ensureNewTokensInTurnOrder();
        } else {
            turnBar.style.display = 'none';
        }
    }

    // --- Grid / placed tokens ---
    // Animation Engine build (this session): diff against existing DOM
    // elements instead of the old innerHTML='' + full rebuild every render.
    // A token's element now persists across renders, which is what lets the
    // .battle-token-el CSS transition (style.css) actually animate a
    // position change instead of teleporting -- e.g. another player's drag
    // syncing in through realtime, a fresh deploy landing via
    // staggeredTokenPos, or resetBattleMapMovement's round tick.
    const grid = document.getElementById('battle-map-grid');
    if (grid) {
        grid.onclick = window.handleBattleGridClick;

        // Switching to a different active battle (or to none) invalidates
        // every cached element outright -- stale token/ordnance divs from a
        // PRIOR encounter must never leak into this one.
        if (encounter.id !== battleMapLastEncounterId) {
            grid.innerHTML = '';
            battleMapTokenEls = {};
            battleMapTokenMarkerIds = {};
            battleMapPendingExplosions = [];
            battleMapOrdnanceEls = {};
            battleMapPrevOrdnanceIds = new Set();
            battleMapLastEncounterId = encounter.id;
        }

        const seenTokenIds = new Set();
        // Initiative + Action Economy build (this session): whose turn it is,
        // for the glow highlight below -- undefined/harmless when initiative
        // hasn't been rolled for this battle.
        const currentTurnTokenId = (encounter.initiative_rolled && (encounter.turn_order || []).length > 0)
            ? encounter.turn_order[encounter.current_turn_index]
            : null;
        tokens.forEach(tok => {
            const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
            // Fog of War build (this session): a hidden token is simply
            // never added to seenTokenIds -- the cleanup pass below (which
            // removes any tokenEl NOT in that set) then deletes its DOM
            // element on this render if it had one, or the token just never
            // gets created in the first place. The DM and the vessel's own
            // player-owner still see it normally.
            if (vessel && typeof window.isVesselVisibleToMe === 'function' && !window.isVesselVisibleToMe(vessel)) return;
            seenTokenIds.add(tok.token_id);
            const isStationTok = !!(vessel && vessel.is_station);
            const isStrikeCraftTok = !!(vessel && vessel.is_strike_craft);
            const moveRemaining = tok.move_remaining !== undefined ? tok.move_remaining : ((vessel?.tactical_speed ?? 160));

            let tokenEl = battleMapTokenEls[tok.token_id];
            if (!tokenEl) {
                tokenEl = document.createElement('div');
                tokenEl.className = 'battle-token-el';
                tokenEl.style.position = 'absolute';
                tokenEl.style.left = tok.x + 'px';
                tokenEl.style.top = tok.y + 'px';
                grid.appendChild(tokenEl);
                battleMapTokenEls[tok.token_id] = tokenEl;
                wireTokenDrag(tokenEl, tok.token_id, tok.ship_marker_id);
            }
            // Visual Polish build: kept even after the token leaves `tokens`
            // (updated every render while the token is present) so the
            // removal pass below can still look up which vessel a just-
            // vanished token belonged to, for the destruction-effect check.
            battleMapTokenMarkerIds[tok.token_id] = tok.ship_marker_id;

            tokenEl.title = isStationTok
                ? `${vessel.name} — stationary platform, immobile`
                : isStrikeCraftTok
                ? `${vessel.name} — strike craft, Move: ${moveRemaining}/${vessel.tactical_speed ?? 160} px remaining. Fire from the Hangar Bay panel, not this token.`
                : `${vessel ? vessel.name : '(vessel not found)'} — Move: ${moveRemaining}${vessel ? '/' + (vessel.tactical_speed ?? 160) : ''} px remaining this round`;
            // left/top set separately from the rest so re-applying the same
            // value every render (nothing moved) never re-triggers the CSS
            // transition -- only an ACTUAL change animates.
            tokenEl.style.left = tok.x + 'px';
            tokenEl.style.top = tok.y + 'px';
            const tokenSize = isStrikeCraftTok ? BATTLE_STRIKE_CRAFT_TOKEN_SIZE : BATTLE_TOKEN_SIZE;
            tokenEl.style.width = tokenSize + 'px';
            tokenEl.style.height = tokenSize + 'px';
            tokenEl.style.borderRadius = isStationTok ? '4px' : '50%';
            tokenEl.style.background = '#0a1410';
            // Strike Craft Grid Position build: a dashed border is the only
            // visual differentiator (kept intentionally light — squadrons
            // don't get their own ship-status card, see the checkpoint notes
            // for why the data model doesn't fit renderBattleShipCards).
            tokenEl.style.border = `2px ${isStrikeCraftTok ? 'dashed' : 'solid'} ${battleTokenHpColor(vessel)}`;
            // Initiative + Action Economy build (this session): a bright
            // glow on whichever token currently has the turn -- purely
            // additive to the existing HP-color border above, cleared for
            // every other token by re-setting boxShadow unconditionally
            // every render (same "re-apply every render" pattern the rest
            // of this loop already uses).
            tokenEl.style.boxShadow = (currentTurnTokenId && tok.token_id === currentTurnTokenId) ? '0 0 8px 3px #ffd700' : 'none';
            tokenEl.style.display = 'flex';
            tokenEl.style.alignItems = 'center';
            tokenEl.style.justifyContent = 'center';
            // Polish pass (this session): strike craft tokens are now much
            // smaller (BATTLE_STRIKE_CRAFT_TOKEN_SIZE above) -- a bit bigger
            // relative font so the single emoji glyph doesn't look lost, and
            // the name text drops entirely below (an emblem, not a label;
            // the full name still shows in the hover title set above).
            tokenEl.style.fontSize = isStrikeCraftTok ? '11px' : '8px';
            tokenEl.style.color = vessel ? (vessel.color || '#00e5a3') : '#ff3333';
            tokenEl.style.cursor = isStationTok ? 'pointer' : 'grab';
            tokenEl.style.userSelect = 'none';
            // Fog of War build (this session): the token is only ever built
            // for a viewer who's allowed to see it at all (see the
            // isVesselVisibleToMe skip above) -- for the DM specifically,
            // dim it slightly so a hidden-from-players token is still
            // visually distinguishable on their own grid, without changing
            // anything a player (who never gets this token built) would see.
            tokenEl.style.opacity = (vessel && vessel.is_hidden && currentUserRole === 'dm') ? '0.55' : '1';
            // Visual Polish build (this session): an outer ring in the
            // viewer's own faction color (mine/ally/DM-NPC), layered outside
            // the existing HP-color border via a second box-shadow ring
            // rather than replacing that border -- HP state stays visible,
            // ownership becomes ALSO visible at a glance without a click
            // into the side card.
            tokenEl.style.boxShadow = `0 0 0 2px ${battleTokenFactionColor(vessel)}, 0 0 6px rgba(0,0,0,0.6)`;
            tokenEl.style.textAlign = 'center';
            tokenEl.style.overflow = 'hidden';
            tokenEl.style.padding = '1px';
            tokenEl.style.zIndex = '2';

            tokenEl.innerHTML = '';
            tokenEl.appendChild(document.createTextNode(
                !vessel ? '???' : isStrikeCraftTok ? '🛩️' : vessel.name.slice(0, 6)
            ));
            if (!isStationTok && moveRemaining < 0) {
                const moveBadge = document.createElement('div');
                moveBadge.style.cssText = 'position:absolute; top:-8px; right:-4px; background:#ff3333; color:#030403; font-size:7px; font-weight:bold; border-radius:6px; padding:0 3px; pointer-events:none;';
                moveBadge.innerText = '!';
                tokenEl.appendChild(moveBadge);
            }
        });

        // Remove elements for tokens no longer present (withdrawn/destroyed).
        // Visual Polish build: if the removed token has a matching entry in
        // battleMapPendingExplosions (staged by checkBattleTokenDestroyed
        // just before this render ran), play a destruction effect at its
        // last known position first. A plain withdraw/recall never stages
        // an entry, so those vanish silently exactly as before.
        Object.keys(battleMapTokenEls).forEach(id => {
            if (!seenTokenIds.has(id)) {
                const pendingIdx = battleMapPendingExplosions.findIndex(p => p.token_id === id);
                if (pendingIdx >= 0) {
                    const exp = battleMapPendingExplosions.splice(pendingIdx, 1)[0];
                    spawnDestructionEffect(grid, exp.x, exp.y);
                }
                battleMapTokenEls[id].remove();
                delete battleMapTokenEls[id];
                delete battleMapTokenMarkerIds[id];
            }
        });

        renderOrdnanceOverlay(grid, tokens, encounter.in_flight_ordnance || []);
    }

    // --- Palette (undeployed candidates) ---
    const placedIds = new Set(tokens.map(t => t.ship_marker_id));
    const palette = document.getElementById('battle-map-palette');
    if (palette) {
        // Bug fix (2026-08-29, DM report): a DM prepping an encounter needs
        // to place a PLAYER's vessel (e.g. their primary combat ship), not
        // just their own NPC markers -- but every NPC in this app is ALSO
        // owned by the DM's own account, so the old "your own vessels only"
        // rule (still correct for a player's own self-service placement)
        // silently hid every PC ship from the DM's palette with no error,
        // just an empty/wrong-looking list. globalShipMarkersCache already
        // holds every vessel regardless of owner (js/map.js's
        // loadGalaxyData does an unfiltered `.select('*')`), so this is a
        // pure display-filter fix, no new query needed. A non-DM player
        // keeps the old own-vessels-only behavior unchanged.
        const candidates = globalShipMarkersCache.filter(m => !m.is_strike_craft && !placedIds.has(m.id) && (isDm || window.vesselHasOwner(m, currentUserId)));
        if (candidates.length === 0) {
            palette.innerHTML = '<span style="font-size:9px; color:#6b826a;">No available vessels to place.</span>';
        } else {
            palette.innerHTML = candidates.map(m => {
                const armed = window.battleMapArmedToken && window.battleMapArmedToken.ship_marker_id === m.id;
                // DM view only: label another player's vessel with their
                // username (from live presence, the only owner->name lookup
                // already loaded in this app -- offline owners just show no
                // suffix rather than a stale/guessed name) so a DM looking
                // at a mixed NPC+PC list can tell them apart at a glance.
                const otherOwnerIds = (isDm && !window.vesselHasOwner(m, currentUserId)) ? window.vesselOwnerIds(m) : [];
                const otherOwnerNames = otherOwnerIds.map(id => (onlineUsersMap[id] || [])[0]).filter(Boolean).map(p => p.username);
                const ownerSuffix = otherOwnerNames.length ? ` <span style="color:#6b826a;">— ${otherOwnerNames.join('/')}</span>` : '';
                return `<div style="display:flex; justify-content:space-between; align-items:center; padding:4px 6px; background:#030403; border:1px solid ${armed ? '#00e5a3' : '#3c4e36'}; border-radius:2px;">
                    <span style="font-size:9px; color:#d4c5a9;">${m.name}${ownerSuffix}</span>
                    ${armed
                        ? `<button class="layer-edit" onclick="window.cancelTokenPlacement()" style="font-size:8px; padding:2px 6px;">CANCEL</button>`
                        : `<button class="btn-deploy" onclick="window.armTokenForPlacement('${m.id}')" style="font-size:8px; padding:2px 6px;">+ PLACE</button>`}
                </div>`;
            }).join('');
        }
        if (window.battleMapArmedToken) {
            palette.innerHTML = `<div style="font-size:9px; color:#00e5a3; margin-bottom:4px;">ARMED — click the grid to place, or Cancel above.</div>` + palette.innerHTML;
        }
    }

    // --- DM template deploy select ---
    const tmplSelect = document.getElementById('battle-map-template-select');
    if (tmplSelect && isDm) {
        const allTemplates = (typeof shipTemplatesList !== 'undefined' ? shipTemplatesList : []).concat(window.secretShipTemplatesList || []);
        tmplSelect.innerHTML = allTemplates.length === 0
            ? '<option value="">-- No templates designed --</option>'
            : allTemplates.map(t => `<option value="${t.id}">${t.name}${t.is_secret ? ' 🔒' : ''}</option>`).join('');
    }

    // --- DM saved-fleet deploy select (Saved Fleets follow-on, this session) ---
    const fleetSelect = document.getElementById('battle-map-fleet-select');
    if (fleetSelect && isDm) {
        const fleets = window.globalSavedFleetsCache || [];
        fleetSelect.innerHTML = fleets.length === 0
            ? '<option value="">-- No saved fleets --</option>'
            : fleets.map(f => `<option value="${f.id}">${f.name} (${(f.members || []).reduce((n, m) => n + (m.quantity || 1), 0)} vessels)</option>`).join('');
    }

    // --- Ship-status cards (weapons + health) — replaces the old plain
    // "Engaged Roster" list this session; see window.renderBattleShipCards
    // below for the permission rule (own/allied vs. DM/NPC vessels).
    window.renderBattleShipCards(tokens);

    // --- Incoming Ordnance (informational — PD is fully automatic, see
    // window.processBattleRoundAutomations; nothing here is clickable) ---
    const ordnanceContainer = document.getElementById('battle-map-ordnance-list');
    if (ordnanceContainer) {
        const inFlight = encounter.in_flight_ordnance || [];
        if (inFlight.length === 0) {
            ordnanceContainer.innerHTML = 'No ordnance currently in flight.';
        } else {
            // Group split payloads (shared parent_salvo_id) into one line so
            // 6 individual entries don't clutter the panel.
            const groups = {};
            inFlight.forEach(salvo => {
                const key = salvo.parent_salvo_id || salvo.salvo_id;
                if (!groups[key]) groups[key] = { ...salvo, count: 0 };
                groups[key].count += 1;
            });
            ordnanceContainer.innerHTML = Object.values(groups).map(g => {
                const countLabel = g.split ? ` (${g.count}/6 payloads)` : '';
                return `<div style="padding:2px 0;">${g.source_weapon_name} from ${g.source_vessel_name} → ${g.target_vessel_name}${countLabel} — impact in ${g.turns_remaining} round${g.turns_remaining === 1 ? '' : 's'}</div>`;
            }).join('');
        }
    }

    // Manual Damage Application build (this session): keep the DM Tools
    // "MANUAL DMG" subtab's Firer/Target dropdowns in sync with whatever's
    // actually deployed right now -- cheap, idempotent, called unconditionally
    // same as every other tail-of-render refresh in this codebase (e.g. the
    // Custom Star Tracker refresh in window.loadGalaxyData).
    if (typeof window.renderManualDamagePanel === 'function') window.renderManualDamagePanel();
};

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
   family-specific rendering. LOCAL to this client only -- unlike
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
window.playWeaponFireEffect = function(sourceVesselId, targetVesselId, colorHex, dmgType) {
    const grid = document.getElementById('battle-map-grid');
    if (!grid || !window.globalBattleEncounterCache) return;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const sourceTok = tokens.find(t => t.ship_marker_id === sourceVesselId);
    const targetTok = tokens.find(t => t.ship_marker_id === targetVesselId);
    if (!sourceTok || !targetTok) return;

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
    if (family === 'pulse') {
        spawnHealPulseEffect(grid, tx, ty, color);
    } else if (family === 'burst') {
        spawnBurstEffect(grid, tx, ty, color);
    } else if (family === 'tracer') {
        spawnTracerEffect(grid, sx, sy, tx, ty, color);
    } else {
        spawnBeamEffect(grid, sx, sy, tx, ty, color);
    }
};

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
            const hasOption = Array.from(sel.options).some(o => o.value === targetVesselId);
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

/* --- SHIP-STATUS CARDS (full-screen build; collapse/expand added later
   this session per tester feedback) ---
   Confirmed permission rule: the DM sees full weapon+health detail on every
   token, no exceptions. A player sees full detail (stance, interactive
   weapons, editable health bars) on any PLAYER-owned vessel — their own
   AND allies' (every NPC in this app is owned by the DM's account, so
   "player-owned" == "owner's profile role !== 'dm'" cleanly separates the
   two, same heuristic this project already uses for combat_tracker
   PC-vs-NPC detection). A DM/NPC-owned vessel viewed by a player shows
   health only — all 5 defensive bars, read-only, no stance selector, no
   weapons at all. This is a DISPLAY-level rule only, same honor-system
   trust model as the rest of this app — nothing here changes RLS or adds
   real access control, it just controls what gets rendered into the DOM.

   Every card now starts COLLAPSED (name + HULL/SHIELDS % only) regardless
   of the permission tier above, and expands to that same tier's full detail
   on click — a display-density toggle layered on top of the existing
   permission split, not a replacement for it. See renderCompactHealthLine /
   battleMapExpandedCards / window.toggleBattleShipCardExpanded below. */
// Per-vessel card expand/collapse state, keyed by token_id. Pure
// client-side UI convenience -- not persisted, not synced between players,
// resets on page reload -- same "each browser keeps its own not-quite-
// permanent UI state" spirit as other collapsible bits of this app.
// Collapsed by default per tester feedback: showing full stance + all 5
// health bars + the complete weapons list for EVERY engaged vessel at once
// was "overwhelming" -- see darkforest-architecture-reference.md's Battle
// Map layout addendum for the full reasoning.
let battleMapExpandedCards = new Set();

/* Comms & Dice dock (live-session feature request, 2026-09-13: "dice roller
   chat integrated into the battle map"). Collapsed by default -- same
   "don't eat vertical space nobody asked to see yet" reasoning as the ship
   cards' own collapse-by-default above -- and, once opened, forces a fresh
   renderChatFeed() so the feed's scrollTop-pin recalculates against the
   dock's REAL now-visible height (its innerHTML was already kept in sync
   the whole time via renderChatFeed/renderCommsTabBar's mirrored-render
   approach in js/ui.js even while display:none, but scrollTop math against
   a hidden 0-height element wouldn't have pinned it to the bottom). See
   index.html for the dock markup and js/ui.js for the shared
   render/send functions this reuses (unmodified in spirit, just now
   rendering into two targets instead of one). */
window.toggleBattleMapCommsDock = function() {
    const body = document.getElementById('bm-comms-dock-body');
    const caret = document.getElementById('bm-comms-dock-caret');
    if (!body) return;
    const opening = body.style.display !== 'block';
    body.style.display = opening ? 'block' : 'none';
    if (caret) caret.textContent = opening ? '▾' : '▸';
    if (opening && typeof window.renderChatFeed === 'function') window.renderChatFeed();
};

window.toggleBattleShipCardExpanded = function(tokenId) {
    if (battleMapExpandedCards.has(tokenId)) battleMapExpandedCards.delete(tokenId);
    else battleMapExpandedCards.add(tokenId);
    window.renderBattleShipCards((window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || []);
};

// One-line HULL/SHIELDS % summary for a collapsed card -- deliberately just
// these two (not all 5 defensive layers renderShipHealthBarsHtml shows) as
// the "glance" version; the full breakdown is one click away via expand.
function renderCompactHealthLine(vessel) {
    const h_max = vessel.max_hull || 300;
    const h_int = vessel.integrity_hull !== undefined ? vessel.integrity_hull : h_max;
    const s_max = vessel.max_shields || 400;
    const s_int = vessel.integrity_shields !== undefined ? vessel.integrity_shields : s_max;
    const hullPct = h_max > 0 ? Math.max(0, Math.min(100, Math.round((h_int / h_max) * 100))) : 100;
    const shieldPct = s_max > 0 ? Math.max(0, Math.min(100, Math.round((s_int / s_max) * 100))) : 100;
    const colorFor = (pct) => pct > 66 ? '#00e5a3' : (pct > 33 ? '#ffaa00' : '#ff3333');
    return `<div style="display:flex; gap:14px; font-size:9px; margin-top:2px;">
        <span style="color:${colorFor(hullPct)};">HULL ${hullPct}%</span>
        <span style="color:${colorFor(shieldPct)};">SHIELDS ${shieldPct}%</span>
    </div>`;
}

// Vessel roster tabs build (live-session feature request, 2026-09-13): see
// the HTML comment above #battle-map-vessel-tabs in index.html for why this
// exists and why strike craft need a separate, simpler card type. Tracks
// which of the 5 tabs is currently showing; persists only for the session
// (not saved anywhere), same lifetime as battleMapExpandedCards below.
window.battleMapVesselTab = window.battleMapVesselTab || 'friendly';

// Buckets a CAPITAL ship into Friendly/Neutral/Hostile. The DM's explicit
// iff tag (the dropdown built into this card's header, further down) always
// wins when set -- that control exists specifically so a boarded/captured/
// revealed vessel can be reclassified mid-fight, and this tab would silently
// fight that if it used its own separate rule. When iff is unset (the
// common case -- a player's own ship never needed one before this build),
// falls back to ownership: player-owned defaults to Friendly, anything else
// (DM/NPC, still unset) defaults to Neutral rather than assuming Hostile
// with no DM confirmation. Strike craft use a simpler ownership-only rule
// (see the sc_friendly/sc_hostile bucketing below) since squadron tokens
// don't carry an iff value at all.
window.getVesselTabBucket = function(vessel, ownedByPlayer) {
    if (vessel.iff === 'friendly' || vessel.iff === 'neutral' || vessel.iff === 'hostile') return vessel.iff;
    return ownedByPlayer ? 'friendly' : 'neutral';
};

window.switchBattleMapVesselTab = function(tab) {
    window.battleMapVesselTab = tab;
    ['friendly', 'neutral', 'hostile', 'sc_friendly', 'sc_hostile'].forEach(t => {
        const btn = document.getElementById('bm-vessel-tab-btn-' + t);
        if (btn) btn.classList.toggle('active', t === tab);
    });
    window.renderBattleShipCards((window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || []);
};

// New lightweight card for the sc_friendly/sc_hostile tabs (live-session
// feature request, 2026-09-13). Strike craft were deliberately excluded
// from the capital-ship card below (see that function's own header comment)
// because their weapons/stats live entirely in the Hangar Bay panel on
// their carrier's card, not on a ship_weapons row -- this card is read-only
// status (name/owner/HP/move/withdraw) for exactly that reason, it doesn't
// try to grow a weapons section to match.
function renderStrikeCraftCard(tok, isDm, profiles) {
    const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
    if (!vessel) {
        return `<div class="battle-ship-card" style="border-color:#ff3333;"><span style="font-size:10px; color:#ff3333;">(vessel record missing — token may need to be withdrawn)</span></div>`;
    }
    const ownerProfs = window.vesselOwnerIds(vessel).map(id => profiles.find(p => p.id === id)).filter(Boolean);
    const ownedByPlayer = ownerProfs.some(p => p.role !== 'dm');
    const accentColor = ownedByPlayer ? '#00e5a3' : '#ff3333';
    const canWithdraw = isDm || window.vesselHasOwner(vessel, currentUserId);
    const moveRemaining = tok.move_remaining !== undefined ? tok.move_remaining : (vessel.tactical_speed ?? 160);
    const moveColor = moveRemaining < 0 ? '#ff3333' : '#6b826a';
    const ownerTag = ownerProfs.length ? ownerProfs.map(p => p.username || 'Commander').join('/') : (isDm ? 'Unowned' : 'Unknown');
    return `<div class="battle-ship-card" style="border-color:${accentColor};">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid #3c4e36;">
            <div style="display:flex; align-items:center; gap:6px;">
                <strong style="color:${accentColor}; font-size:13px;">🛩️ ${vessel.name}</strong>
                <span style="font-size:9px; color:#6b826a;">${ownerTag}</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                ${vessel.is_hidden ? `<span style="font-size:9px; color:#c778dd;" title="Hidden from every non-DM viewer except this vessel's own player-owner">🫥 HIDDEN</span>` : ''}
                <span style="font-size:9px; color:${moveColor};" title="Movement remaining this round (informational — not enforced)">Move ${moveRemaining}/${vessel.tactical_speed ?? 160}</span>
                ${canWithdraw ? `<button class="layer-del" onclick="window.removeBattleToken('${tok.token_id}')" style="font-size:8px; padding:2px 6px;">WITHDRAW</button>` : ''}
            </div>
        </div>
        ${renderCompactHealthLine(vessel)}
        <div style="font-size:8px; color:#6b826a; margin-top:4px;">Fire from the Hangar Bay panel on the carrier's card, not from here.</div>
    </div>`;
}

window.renderBattleShipCards = function(tokens) {
    const container = document.getElementById('battle-map-ship-cards');
    if (!container) return;
    const isDm = currentUserRole === 'dm';
    const profiles = (typeof allProfiles !== 'undefined' ? allProfiles : []);
    const activeTab = window.battleMapVesselTab || 'friendly';
    const isScTab = activeTab === 'sc_friendly' || activeTab === 'sc_hostile';

    tokens = (tokens || []).filter(tok => {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        // Fog of War build (this session): same visibility rule as the grid
        // token rendering above -- a hidden vessel gets no status card
        // either, except for the DM and its own player-owner.
        if (v && typeof window.isVesselVisibleToMe === 'function' && !window.isVesselVisibleToMe(v)) return false;
        return true;
    });

    // Vessel roster tabs build: bucket every visible token into all 5 tabs
    // up front (not just the active one) so the tab button counts are
    // always right, then only render the active bucket's cards below.
    const buckets = { friendly: [], neutral: [], hostile: [], sc_friendly: [], sc_hostile: [] };
    tokens.forEach(tok => {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!v) { buckets.neutral.push(tok); return; } // missing record -- surfaced under Neutral rather than silently dropped, see the "(vessel record missing...)" card below
        if (v.is_strike_craft) {
            const ownedByPlayer = window.vesselOwnerIds(v).map(id => profiles.find(p => p.id === id)).filter(Boolean).some(p => p.role !== 'dm');
            buckets[ownedByPlayer ? 'sc_friendly' : 'sc_hostile'].push(tok);
        } else {
            const ownerProfs = window.vesselOwnerIds(v).map(id => profiles.find(p => p.id === id)).filter(Boolean);
            buckets[window.getVesselTabBucket(v, ownerProfs.some(p => p.role !== 'dm'))].push(tok);
        }
    });

    const tabLabels = { friendly: 'Friendly', neutral: 'Neutral', hostile: 'Hostile', sc_friendly: '🛩️ Friendly', sc_hostile: '🛩️ Hostile' };
    Object.keys(tabLabels).forEach(t => {
        const btn = document.getElementById('bm-vessel-tab-btn-' + t);
        if (btn) btn.textContent = `${tabLabels[t]} (${buckets[t].length})`;
    });

    const activeTokens = buckets[activeTab] || [];

    if (activeTokens.length === 0) {
        container.innerHTML = '<span style="font-size:10px; color:#6b826a;">No vessels here.</span>';
        return;
    }

    if (isScTab) {
        container.innerHTML = activeTokens.map(tok => renderStrikeCraftCard(tok, isDm, profiles)).join('');
        return;
    }

    // Bug-hunt pass (2026-09-24): wrapped in preserveFormState (js/db.js) --
    // this re-renders on every realtime ship/battle update during combat,
    // which used to reset the weapon target dropdowns and volley counts a
    // player was in the middle of setting.
    window.preserveFormState(container, () => { container.innerHTML = activeTokens.map(tok => {
        const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!vessel) {
            return `<div class="battle-ship-card" style="border-color:#ff3333;"><span style="font-size:10px; color:#ff3333;">(vessel record missing — token may need to be withdrawn)</span></div>`;
        }

        const ownerProfs = window.vesselOwnerIds(vessel).map(id => profiles.find(p => p.id === id)).filter(Boolean);
        const ownedByPlayer = ownerProfs.some(p => p.role !== 'dm');
        const fullDetail = isDm || ownedByPlayer;
        const canWithdraw = isDm || window.vesselHasOwner(vessel, currentUserId);
        const moveRemaining = tok.move_remaining !== undefined ? tok.move_remaining : (vessel.tactical_speed ?? 160);
        const moveColor = moveRemaining < 0 ? '#ff3333' : '#6b826a';
        const accentColor = fullDetail ? '#00e5a3' : '#ff3333';
        const ownerTag = ownerProfs.length ? ownerProfs.map(p => p.username || 'Commander').join('/') : (isDm ? 'Unowned' : 'Unknown');
        const expanded = battleMapExpandedCards.has(tok.token_id);
        // Station Designer build: stations are immobile, so the move-
        // remaining readout is dropped entirely rather than showing a
        // meaningless "Move 0/0" — matches the Battle Map grid's own
        // stationary-platform tooltip.
        const moveLine = vessel.is_station
            ? `<span style="font-size:9px; color:#6b826a;" title="Stationary platform — no Battle Map movement">🛰 STATIONARY</span>`
            : `<span style="font-size:9px; color:${moveColor};" title="Movement remaining this round (informational — not enforced)">Move ${moveRemaining}/${vessel.tactical_speed ?? 160}</span>`;

        // Mid-battle IFF change (live-session feature request, 2026-09-13): DM
        // asked to be able to flip a ship's Friendly/Hostile/Neutral tag mid-
        // fight (e.g. a boarded/captured vessel, a reveal). Reuses the exact
        // same dropdown markup/behavior as the Galaxy Map HUD's own DM-only
        // IFF box (js/map.js, selected-target 'ship' panel) for consistency —
        // same window.IFF_COLORS palette, same "-- Unset --" option, same
        // window.updateShipIff(shipId, newIff) call — just laid out compactly
        // for this card's header instead of the HUD's full-width panel.
        const iffVal = vessel.iff || null;
        const iffColor = iffVal ? ((window.IFF_COLORS && window.IFF_COLORS[iffVal]) || '#00e1ff') : '#6b826a';
        const dmIffBox = isDm ? `<select onchange="window.updateShipIff('${vessel.id}', this.value)" onclick="event.stopPropagation();" style="font-size:8px; padding:2px; background:#0a1410; color:${iffColor}; border:1px solid ${iffColor};" title="DM: change this vessel's IFF tag mid-battle"><option value="" ${!iffVal ? 'selected' : ''} style="color:#6b826a;">-- Unset --</option><option value="friendly" ${iffVal === 'friendly' ? 'selected' : ''} style="color:#00e5a3;">✓ Friendly</option><option value="neutral" ${iffVal === 'neutral' ? 'selected' : ''} style="color:#c9962f;">◌ Neutral</option><option value="hostile" ${iffVal === 'hostile' ? 'selected' : ''} style="color:#ff3333;">⚠ Hostile</option></select>` : '';

        const header = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid #3c4e36;">
                <div style="display:flex; align-items:center; gap:6px; cursor:pointer;" onclick="window.toggleBattleShipCardExpanded('${tok.token_id}')" title="${expanded ? 'Click to collapse' : 'Click to expand full detail'}">
                    <span style="font-size:9px; color:#6b826a;">${expanded ? '▾' : '▸'}</span>
                    <strong style="color:${accentColor}; font-size:13px;">${vessel.name}</strong>
                    <span style="font-size:9px; color:#6b826a;">${ownerTag}${vessel.is_strike_craft ? ' · 🛩️' : ''}</span>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${vessel.is_hidden ? `<span style="font-size:9px; color:#c778dd;" title="Hidden from every non-DM viewer except this vessel's own player-owner">🫥 HIDDEN</span>` : ''}
                    ${moveLine}
                    ${dmIffBox}
                    ${isDm ? `<button class="layer-edit" onclick="window.toggleVesselHidden('${vessel.id}')" style="font-size:8px; padding:2px 6px; border-color:#c778dd; color:#c778dd;" title="Fog of War: toggle whether this vessel is hidden from every non-DM viewer except its own player-owner">${vessel.is_hidden ? '👁 UNHIDE' : '🫥 HIDE'}</button>` : ''}
                    ${canWithdraw ? `<button class="layer-del" onclick="window.removeBattleToken('${tok.token_id}')" style="font-size:8px; padding:2px 6px;">WITHDRAW</button>` : ''}
                </div>
            </div>`;

        if (!expanded) {
            return `<div class="battle-ship-card" style="border-color:${accentColor};">${header}${renderCompactHealthLine(vessel)}</div>`;
        }

        if (!fullDetail) {
            return `<div class="battle-ship-card" style="border-color:${accentColor};">${header}${window.renderShipHealthBarsHtml(vessel, false)}</div>`;
        }

        return `<div class="battle-ship-card" style="border-color:${accentColor};">
            ${header}
            ${window.renderShipStanceHtml(vessel)}
            ${window.renderShipHealthBarsHtml(vessel, true)}
            <div style="margin-top:8px; padding-top:8px; border-top:1px dashed #3c4e36;">
                ${window.renderShipWeaponsHtml(vessel, { idPrefix: 'bm-', showManageButtons: false })}
            </div>
            ${typeof window.renderCompactHangarHtml === 'function' ? window.renderCompactHangarHtml(vessel) : ''}
        </div>`;
    }).join(''); }, 'select[id^="bm-wpn-target-"], input[id^="bm-wpn-volley-"]');
};
