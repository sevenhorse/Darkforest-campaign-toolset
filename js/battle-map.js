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

const BATTLE_GRID_W = 460;
const BATTLE_GRID_H = 380;
const BATTLE_TOKEN_SIZE = 34;

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
    tokens.push({ token_id: genBattleTokenId(), ship_marker_id: window.battleMapArmedToken.ship_marker_id, x: pos.x, y: pos.y, move_remaining: placedVessel?.tactical_speed ?? 80 });
    window.battleMapArmedToken = null;
    saveBattleTokens(tokens).then(() => window.renderBattleMapPanel());
};

window.removeBattleToken = async function(tokenId) {
    if (!window.globalBattleEncounterCache) return;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const tok = tokens.find(t => t.token_id === tokenId);
    if (!tok) return;
    const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
    const isOwner = vessel && vessel.owner_id === currentUserId;
    if (currentUserRole !== 'dm' && !isOwner) return;
    if (!(await window.showConfirmModal('Withdraw this vessel from the battle grid? The vessel itself is untouched.'))) return;
    saveBattleTokens(tokens.filter(t => t.token_id !== tokenId)).then(() => window.renderBattleMapPanel());
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
        const ownerProf = (typeof allProfiles !== 'undefined' ? allProfiles : []).find(p => p.id === m.owner_id);
        return ownerProf && ownerProf.role !== 'dm';
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
   in the pool afterward is offered to deployed strike craft via their
   persisted target_id "engaged target" proxy (squadrons have no grid
   position of their own — see rollSquadronWeapon in combat.js). Any nonzero
   PD hit destroys the payload/counts as a hit on the squadron outright —
   no separate payload-toughness stat exists, per the confirmed design. */
window.processBattleRoundAutomations = async function() {
    if (!window.globalBattleEncounterCache) return;
    const battle = window.globalBattleEncounterCache;
    const tokens = battle.tokens || [];
    const chatLines = [];
    const touchedVessels = new Map(); // id -> vessel object (already mutated in globalShipMarkersCache)

    const markTouched = (v) => { if (v) touchedVessels.set(v.id, v); };

    // Shared per-round pool of available PD weapons: { vesselId, weaponIdx, position, ownerId }
    let pdPool = [];
    tokens.forEach(tok => {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!v) return;
        (v.ship_weapons || []).forEach((w, wIdx) => {
            if (!w.is_point_defense) return;
            if ((w.cooldown || 0) > 0) return; // hard skip — no one to confirm a cooldown override on an automated tick
            if (w.ammo === 0) return;
            pdPool.push({ vesselId: v.id, weaponIdx: wIdx, position: { x: tok.x, y: tok.y }, ownerId: v.owner_id });
        });
    });

    // ownerId is the vessel being protected's owner — escort screening only
    // applies within the same ownership (same "side"), same PC-vs-NPC
    // heuristic (owner_id match) this app already uses everywhere else for
    // friend/foe detection. Without this check an ENEMY's point defense
    // could "intercept" a payload aimed at someone else's ship, which isn't
    // what "allied escort" means.
    function findEligiblePD(targetPos, ownerId) {
        for (let i = 0; i < pdPool.length; i++) {
            const entry = pdPool[i];
            if (entry.ownerId !== ownerId) continue;
            const v = globalShipMarkersCache.find(m => m.id === entry.vesselId);
            const w = v && v.ship_weapons[entry.weaponIdx];
            if (!w) continue;
            const dist = Math.hypot(entry.position.x - targetPos.x, entry.position.y - targetPos.y);
            if (!w.range || dist <= w.range) return i;
        }
        return -1;
    }

    function fireEligiblePD(targetPos, ownerId) {
        const idx = findEligiblePD(targetPos, ownerId);
        if (idx < 0) return null;
        const entry = pdPool.splice(idx, 1)[0];
        const pdVessel = globalShipMarkersCache.find(m => m.id === entry.vesselId);
        const pdWpn = pdVessel.ship_weapons[entry.weaponIdx];
        const roll = rollDamageDice(pdWpn.dice, pdWpn.modifier, pdWpn.explodes);
        if (pdWpn.ammo > 0) pdWpn.ammo -= 1;
        markTouched(pdVessel);
        return { pdVessel, pdWpn, roll };
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

        const engagement = fireEligiblePD(targetPos, targetVessel.owner_id);
        if (engagement && engagement.roll.total > 0) {
            chatLines.push(`🛡️ [POINT DEFENSE] ${engagement.pdVessel.name}'s ${engagement.pdWpn.name} intercepts a payload inbound on ${targetVessel.name} from ${salvo.source_vessel_name} (${engagement.roll.total} dmg) — destroyed!`);
            continue; // payload destroyed, dropped from survivingOrdnance
        }
        if (engagement) {
            chatLines.push(`🛡️ [POINT DEFENSE] ${engagement.pdVessel.name}'s ${engagement.pdWpn.name} fires at an inbound payload — misses.`);
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
            Object.assign(targetVessel, {
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened
            });
            markTouched(targetVessel);
            chatLines.push(`💥 [ORDNANCE IMPACT] ${salvo.source_weapon_name} (from ${salvo.source_vessel_name}) strikes ${targetVessel.name} for ${total} ${dmgType} dmg. ${impactLog}`);
            if (typeof window.checkBattleTokenDestroyed === 'function') await window.checkBattleTokenDestroyed(targetVessel);
            // Bug fix (pre-deploy review): a vessel destroyed mid-pass kept
            // any of its still-unfired PD weapons sitting in the shared pool,
            // available to "intercept" a LATER salvo or engage a strike
            // craft later in this same automation call — a dead ship
            // shooting after its own death. Prune it the moment it's
            // confirmed destroyed rather than leaving stale entries.
            pdPool = pdPool.filter(entry => entry.vesselId !== targetVessel.id);
            continue; // consumed on impact, dropped from survivingOrdnance
        }

        // Survives to next round.
        const updated = { ...salvo, turns_remaining: turnsLeft };
        if (!salvo.split && turnsLeft === 2) {
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

    // --- PD vs deployed strike craft (target-lock proxy — see file header) ---
    const touchedCarrierIds = new Set();
    globalShipMarkersCache.forEach(v => {
        (v.ship_deployed || []).forEach(sq => {
          try {
            if (!sq.target_id || (sq.count || 0) <= 0) return;
            const targetPos = window.getBattleTokenPosition(sq.target_id);
            if (!targetPos) return; // squadron's locked target isn't a current battle token
            const sqShip = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
            if (!sqShip) return;
            const engagement = fireEligiblePD(targetPos, sqShip.owner_id);
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
          } catch (err) {
            console.error('processBattleRoundAutomations: strike-craft PD engagement failed, skipping this squadron this round', sq, err);
          }
        });
    });

    // --- Persist everything touched ---
    for (const v of touchedVessels.values()) {
      try {
        await db.from('ship_markers').update({
            ship_weapons: v.ship_weapons,
            integrity_shields: v.integrity_shields, integrity_hull: v.integrity_hull,
            integrity_reactive: v.integrity_reactive, integrity_ablative: v.integrity_ablative,
            integrity_hardened: v.integrity_hardened
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

        let cargo = (typeof window.sanitizeCargo === 'function') ? window.sanitizeCargo(ship.cargo_inventory || {}) : (ship.cargo_inventory || {});
        let existing = cargo.misc.find(i => i.name.toLowerCase() === rec.resource_name.toLowerCase());
        if (existing) existing.qty += rec.qty;
        else cargo.misc.push({ name: rec.resource_name, qty: rec.qty, unit: rec.unit || 'Tons' });

        await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', ship.id);
        ship.cargo_inventory = cargo;
        await db.from('battlefield_salvage').delete().eq('id', rec.id);
        await db.from('chat_logs').insert({ sender_id: null, content: `📦 [SALVAGE] ${ship.name} recovered ${rec.qty}x ${rec.resource_name}.`, message_type: 'system' });
        any = true;
    }
    if (any) {
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
    if (currentUserRole !== 'dm' && vessel.owner_id !== currentUserId) return;
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
window.getBattleScopedTargets = function(vesselId, range) {
    if (!window.globalBattleEncounterCache) return null;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const selfToken = tokens.find(t => t.ship_marker_id === vesselId);
    if (!selfToken) return null;
    return tokens.filter(t => t.ship_marker_id !== vesselId).filter(t => {
        if (!range) return true;
        return Math.hypot(t.x - selfToken.x, t.y - selfToken.y) <= range;
    }).map(t => {
        const m = globalShipMarkersCache.find(sm => sm.id === t.ship_marker_id);
        return m ? { id: m.id, name: m.name, is_strike_craft: m.is_strike_craft } : null;
    }).filter(Boolean);
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
window.launchOrdnance = async function(vesselId, idx, idPrefix) {
    idPrefix = idPrefix || '';
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let wpn = (vessel.ship_weapons || [])[idx];
    if (!wpn) return;

    const selfPos = window.getBattleTokenPosition(vesselId);
    if (!selfPos) {
        // Not a battle-map token right now — no grid to track a flight
        // against, so ordnance just resolves the old instant way.
        return window.rollShipWeapon(vesselId, idx, idPrefix);
    }

    let targetSelect = document.getElementById(`${idPrefix}wpn-target-${vesselId}-${idx}`);
    let targetId = targetSelect ? targetSelect.value : null;
    if (!targetId) { alert('Select a target first.'); return; }
    let targetVessel = globalShipMarkersCache.find(m => m.id === targetId);
    if (!targetVessel) return;
    const targetPos = window.getBattleTokenPosition(targetId);
    if (!targetPos) { alert('Target is not on the battle grid.'); return; }

    if (wpn.range && Math.hypot(targetPos.x - selfPos.x, targetPos.y - selfPos.y) > wpn.range) {
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[OUT OF RANGE] ${targetVessel.name} is beyond ${wpn.name}'s range (${wpn.range}).`);
        return;
    }

    if (wpn.cooldown > 0) {
        if (!(await window.showConfirmModal(`[WARNING] ${wpn.name} is on cooldown! Launching will OVERRIDE and generate OVERHEAT. Proceed?`))) return;
        wpn.overheat = Math.min(10, (wpn.overheat || 0) + 1);
    }
    if (wpn.ammo === 0) {
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[EMPTY] ${wpn.name} is out of ammunition!`);
        return;
    }
    if (wpn.ammo > 0) wpn.ammo -= 1;

    const ordnance = (window.globalBattleEncounterCache.in_flight_ordnance || []).slice();
    ordnance.push({
        salvo_id: genBattleTokenId(),
        source_vessel_id: vesselId, source_vessel_name: vessel.name,
        source_weapon_name: wpn.name, dice: wpn.dice, modifier: wpn.modifier, explodes: !!wpn.explodes,
        damage_type: wpn.damage_type || 'Impact',
        target_vessel_id: targetId, target_vessel_name: targetVessel.name,
        turns_remaining: 3, split: false
    });
    window.globalBattleEncounterCache.in_flight_ordnance = ordnance;
    await db.from('battle_encounters').update({ in_flight_ordnance: ordnance }).eq('id', window.globalBattleEncounterCache.id);

    await db.from('ship_markers').update({ ship_weapons: vessel.ship_weapons }).eq('id', vesselId);

    if (window.AudioEngine) window.AudioEngine.playShoot();
    await db.from('chat_logs').insert({ sender_id: null, content: `☠️ [ORDNANCE] ${vessel.name} launches ${wpn.name} at ${targetVessel.name} — impact in 3 rounds.`, message_type: 'system' });
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
    tokens.push({ token_id: genBattleTokenId(), ship_marker_id: newId, x: pos.x, y: pos.y, move_remaining: newVessel?.tactical_speed ?? 80 });
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
// each deploy creates a brand-new ship_markers row. No confirmation prompt
// here, matching deployTemplateToBattle's own lack of one — consistent with
// the existing single-deploy action rather than introducing a new pattern.
window.deployFleetToBattle = async function() {
    if (currentUserRole !== 'dm' || !window.globalBattleEncounterCache) return;
    const select = document.getElementById('battle-map-fleet-select');
    if (!select || !select.value) { alert('Select a saved fleet first.'); return; }
    const fleet = (window.globalSavedFleetsCache || []).find(f => f.id === select.value);
    if (!fleet) return;
    const members = fleet.members || [];
    if (members.length === 0) { alert(`"${fleet.name}" has no vessels in it yet — add some from the Secret Repository first.`); return; }

    let tokens = (window.globalBattleEncounterCache.tokens || []).slice();
    let placedCount = 0;
    for (const member of members) {
        for (let i = 0; i < (member.quantity || 1); i++) {
            const newId = await window.deployShipTemplate(member.template_id);
            if (!newId) continue; // deployShipTemplate already alerted on failure — skip this unit, keep going with the rest of the fleet
            if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
            const pos = staggeredTokenPos(tokens.length);
            const newVessel = globalShipMarkersCache.find(m => m.id === newId);
            tokens.push({ token_id: genBattleTokenId(), ship_marker_id: newId, x: pos.x, y: pos.y, move_remaining: newVessel?.tactical_speed ?? 80 });
            placedCount++;
        }
    }
    await saveBattleTokens(tokens);
    await db.from('chat_logs').insert({ sender_id: null, content: `⚔️ [TACTICAL BATTLE MAP] ${fleet.name} deployed — ${placedCount} vessel${placedCount === 1 ? '' : 's'} placed.`, message_type: 'system' });
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
function wireTokenDrag(tokenEl, token) {
    let isDragging = false, moved = false, startX, startY, initialLeft, initialTop;
    tokenEl.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        isDragging = true; moved = false;
        startX = e.clientX; startY = e.clientY;
        initialLeft = token.x; initialTop = token.y;
        // moveEvt.clientX/Y deltas are raw screen pixels; the token div lives
        // inside #battle-map-grid's CSS transform:scale(), so a screen-pixel
        // delta corresponds to BATTLE_GRID_SCALE fewer logical grid units --
        // divide before adding to the token's logical (unscaled) position.
        const onMove = (moveEvt) => {
            if (!isDragging) return;
            const dx = (moveEvt.clientX - startX) / BATTLE_GRID_SCALE, dy = (moveEvt.clientY - startY) / BATTLE_GRID_SCALE;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
            const pos = clampToGrid(initialLeft + dx, initialTop + dy);
            tokenEl.style.left = pos.x + 'px'; tokenEl.style.top = pos.y + 'px';
        };
        const onUp = (upEvt) => {
            isDragging = false;
            window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
            if (moved) {
                const dx = (upEvt.clientX - startX) / BATTLE_GRID_SCALE, dy = (upEvt.clientY - startY) / BATTLE_GRID_SCALE;
                const pos = clampToGrid(initialLeft + dx, initialTop + dy);
                const distMoved = Math.hypot(pos.x - initialLeft, pos.y - initialTop);
                const tokens = (window.globalBattleEncounterCache.tokens || []).map(t => {
                    if (t.token_id !== token.token_id) return t;
                    const prevRemaining = t.move_remaining !== undefined ? t.move_remaining : 80;
                    return { ...t, x: pos.x, y: pos.y, move_remaining: Math.round((prevRemaining - distMoved) * 10) / 10 };
                });
                saveBattleTokens(tokens).then(() => window.renderBattleMapPanel());
            } else {
                if (typeof window.openFullVesselTerminal === 'function') window.openFullVesselTerminal(token.ship_marker_id);
            }
        };
        window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
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
        return { ...t, move_remaining: (vessel?.tactical_speed ?? 80) };
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
    const myShips = globalShipMarkersCache.filter(m => !m.is_strike_craft && m.owner_id === currentUserId);
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
    // ADVANCE ROUND was already functionally DM-only (advanceCombatRound
    // itself returns immediately for a non-DM caller) but the button had no
    // visibility check of its own, so a player saw a clickable button that
    // silently did nothing -- tester feedback asked for it hidden outright.
    // Same toggle pattern as endBtn above.
    const advanceBtn = document.getElementById('battle-map-advance-btn');
    if (advanceBtn) advanceBtn.style.display = isDm ? 'inline-block' : 'none';
    const dmDeploy = document.getElementById('battle-map-dm-deploy');
    if (dmDeploy) dmDeploy.style.display = isDm ? 'block' : 'none';

    const tokens = encounter.tokens || [];

    // --- Grid / placed tokens ---
    const grid = document.getElementById('battle-map-grid');
    if (grid) {
        grid.innerHTML = '';
        grid.onclick = window.handleBattleGridClick;
        tokens.forEach(tok => {
            const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
            const moveRemaining = tok.move_remaining !== undefined ? tok.move_remaining : ((vessel?.tactical_speed ?? 80));
            const tokenEl = document.createElement('div');
            tokenEl.title = `${vessel ? vessel.name : '(vessel not found)'} — Move: ${moveRemaining}${vessel ? '/' + (vessel.tactical_speed ?? 80) : ''} px remaining this round`;
            tokenEl.style.cssText = `position:absolute; left:${tok.x}px; top:${tok.y}px; width:${BATTLE_TOKEN_SIZE}px; height:${BATTLE_TOKEN_SIZE}px; border-radius:50%; background:#0a1410; border:2px solid ${battleTokenHpColor(vessel)}; display:flex; align-items:center; justify-content:center; font-size:8px; color:${vessel ? (vessel.color || '#00e5a3') : '#ff3333'}; cursor:grab; user-select:none; box-shadow:0 0 6px rgba(0,0,0,0.6); text-align:center; overflow:hidden; padding:1px;`;
            tokenEl.innerText = vessel ? vessel.name.slice(0, 6) : '???';
            if (moveRemaining < 0) {
                const moveBadge = document.createElement('div');
                moveBadge.style.cssText = 'position:absolute; top:-8px; right:-4px; background:#ff3333; color:#030403; font-size:7px; font-weight:bold; border-radius:6px; padding:0 3px; pointer-events:none;';
                moveBadge.innerText = '!';
                tokenEl.appendChild(moveBadge);
            }
            wireTokenDrag(tokenEl, tok);
            grid.appendChild(tokenEl);
        });
    }

    // --- Palette (undeployed candidates) ---
    const placedIds = new Set(tokens.map(t => t.ship_marker_id));
    const palette = document.getElementById('battle-map-palette');
    if (palette) {
        // Same rule for both roles: your own vessels not yet placed. For a
        // DM this naturally surfaces "NPC" markers, since every NPC ship in
        // this app is owned by the DM's own account (same convention the
        // Ground Combat To-Hit build already established for combat_tracker
        // PC-vs-NPC detection) — no separate NPC query needed.
        const candidates = globalShipMarkersCache.filter(m => !m.is_strike_craft && m.owner_id === currentUserId && !placedIds.has(m.id));
        if (candidates.length === 0) {
            palette.innerHTML = '<span style="font-size:9px; color:#6b826a;">No available vessels to place.</span>';
        } else {
            palette.innerHTML = candidates.map(m => {
                const armed = window.battleMapArmedToken && window.battleMapArmedToken.ship_marker_id === m.id;
                return `<div style="display:flex; justify-content:space-between; align-items:center; padding:4px 6px; background:#030403; border:1px solid ${armed ? '#00e5a3' : '#3c4e36'}; border-radius:2px;">
                    <span style="font-size:9px; color:#d4c5a9;">${m.name}</span>
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

window.renderBattleShipCards = function(tokens) {
    const container = document.getElementById('battle-map-ship-cards');
    if (!container) return;
    const isDm = currentUserRole === 'dm';
    const profiles = (typeof allProfiles !== 'undefined' ? allProfiles : []);

    if (!tokens || tokens.length === 0) {
        container.innerHTML = '<span style="font-size:10px; color:#6b826a;">No vessels placed on the grid yet.</span>';
        return;
    }

    container.innerHTML = tokens.map(tok => {
        const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!vessel) {
            return `<div class="battle-ship-card" style="border-color:#ff3333;"><span style="font-size:10px; color:#ff3333;">(vessel record missing — token may need to be withdrawn)</span></div>`;
        }

        const ownerProf = profiles.find(p => p.id === vessel.owner_id);
        const ownedByPlayer = !!(ownerProf && ownerProf.role !== 'dm');
        const fullDetail = isDm || ownedByPlayer;
        const canWithdraw = isDm || vessel.owner_id === currentUserId;
        const moveRemaining = tok.move_remaining !== undefined ? tok.move_remaining : (vessel.tactical_speed ?? 80);
        const moveColor = moveRemaining < 0 ? '#ff3333' : '#6b826a';
        const accentColor = fullDetail ? '#00e5a3' : '#ff3333';
        const ownerTag = ownerProf ? (ownerProf.username || 'Commander') : (isDm ? 'Unowned' : 'Unknown');
        const expanded = battleMapExpandedCards.has(tok.token_id);

        const header = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid #3c4e36;">
                <div style="display:flex; align-items:center; gap:6px; cursor:pointer;" onclick="window.toggleBattleShipCardExpanded('${tok.token_id}')" title="${expanded ? 'Click to collapse' : 'Click to expand full detail'}">
                    <span style="font-size:9px; color:#6b826a;">${expanded ? '▾' : '▸'}</span>
                    <strong style="color:${accentColor}; font-size:13px;">${vessel.name}</strong>
                    <span style="font-size:9px; color:#6b826a;">${ownerTag}${vessel.is_strike_craft ? ' · 🛩️' : ''}</span>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:9px; color:${moveColor};" title="Movement remaining this round (informational — not enforced)">Move ${moveRemaining}/${vessel.tactical_speed ?? 80}</span>
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
        </div>`;
    }).join('');
};
