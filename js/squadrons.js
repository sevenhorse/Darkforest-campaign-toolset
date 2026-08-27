/* ==========================================================================
   js/squadrons.js - Strike Craft Catalog & Squadron Logic
   ========================================================================== */

/* Split out of js/combat.js and js/battle-map.js on 2026-08-27 (Priority 2,
   confirmed this session): every other major system in this app already had
   a dedicated file (ship-designer.js, perk-designer.js, augment-designer.js,
   gear-designer.js, dm-sheet-editor.js, manufacturing.js, colonies.js,
   map.js) but squadron/strike-craft logic had no home of its own, split
   across combat.js and battle-map.js.

   SCOPE (confirmed this session, "combat.js block only"): this file holds
   the STRIKE_CRAFT_DB catalog, the squadron CRUD/action functions that lived
   in combat.js, and the two battle-map.js token helpers
   (addSquadronToBattleMap/removeBattleTokenByMarkerId) that were clean
   top-level functions with no closure coupling. It deliberately does NOT
   include squadronWeaponCooldown/findEligibleSquadronIntercept/
   fireEligibleSquadronIntercept, which remain nested inside
   window.processBattleRoundAutomations in js/battle-map.js -- those three
   share closure state (touchedCarrierIds, squadronInterceptPool, markTouched)
   with the parallel non-squadron PD logic they're interleaved with, and
   extracting them would mean restructuring processBattleRoundAutomations
   itself. That was explicitly deferred as a larger, separate risk (the
   round-automation function is the app's most complex and least
   playtested) -- not an oversight. See darkforest-architecture-reference.md
   for the full scoping discussion.

   Load order: must load after js/combat.js is no longer required for
   STRIKE_CRAFT_DB specifically (all real references to it and to this file's
   functions are call-time lookups inside function bodies, never something
   another script needs at ITS OWN parse time) -- but this file is placed
   directly after combat.js in index.html to keep the squadron-adjacent
   scripts grouped together, matching this app's existing load-order
   convention. */

// Squadron AI Stances build (this session): each weapon got an optional
// `role` tag ('anti_fighter' | 'anti_capital' | 'point_defense' | 'general')
// consumed by an AI-controlled squadron (window.setSquadronAIStance) to pick
// which of its weapons fits the stance it's been given — e.g. the
// Messenger's "Point Defense System" for Intercept Munitions, or the Raven's
// "Ship Killer Missiles" for Attack Capital Ships/Escorts. FLAGGED JUDGMENT
// CALL, not DM-confirmed per weapon: these are flavor-text reads of each
// weapon's name/dice (a name like "Point Defense System" or "Ship Killer
// Missiles" is fairly unambiguous, but e.g. "Micro Railgun" -> anti_capital
// is a judgment call, not a stated rule). Untagged weapons default to
// 'general' and are only used as a last-resort fallback (see
// processBattleRoundAutomations' weapon-selection comment) when no weapon
// on that squadron type matches the stance's desired role at all.
// Strike-Craft Weapon Range build (this session): every squadron weapon gets
// a `range` field (grid px, same unit/meaning as ship_weapons' `range` --
// see getBattleScopedTargets/launchOrdnance in js/battle-map.js), which was
// ZERO/absent before this build (a repeatedly-flagged open gap -- see the
// Strike Craft Grid Position, Squadron AI Stances, and Weapon Range Ring
// checkpoints below). FLAGGED FIRST-PASS PLACEHOLDER NUMBERS, DM-tunable,
// same convention as SQUADRON_TACTICAL_SPEED below and every other
// first-pass balance number in this app -- NOT a rules citation. Scaled
// against the battle grid (BATTLE_GRID_W/H = 920x760, js/battle-map.js) and
// SQUADRON_TACTICAL_SPEED = 320/round, and differentiated by each weapon's
// existing `role` tag per the confirmed design (short for point-defense/
// anti-fighter dogfighting weapons, medium for general-purpose, long for
// anti-capital ordnance/rockets that are meant to be launched from standoff
// range): point_defense ~180, anti_fighter ~280, general ~420, anti_capital
// ~600, and weapon_class:"ordnance" anti-capital munitions a bit further
// still (~700) since they're explicitly standoff missiles/rockets by name.
// Weapon Cooldowns build (this session): `cooldown_period` on a weapon
// entry is new -- how many rounds it needs after firing before it's ready
// again (auto-applied to the squadron's own per-instance
// `sq.weapon_cooldowns[wpnIdx]` counter on fire, decremented on Advance
// Round, same soft-override-on-fire convention ship_weapons' cooldown
// already used). FLAGGED FIRST-PASS PLACEHOLDER, DM-tunable, and
// DELIBERATELY ONLY SET ON THE TWO ORDNANCE WEAPONS (missiles) -- the DM's
// own framing was "missiles and torpedoes as well as SOME guns," but which
// specific guns wasn't specified, and defaulting a cooldown onto an
// existing, already-balanced direct-fire weapon would be a real balance
// change nobody asked for yet. Every weapon without a `cooldown_period` (or
// with it at 0) behaves exactly as before -- opt-in per weapon, not a
// blanket new restriction. Tell me which specific guns should get one and
// I'll set real values.
const STRIKE_CRAFT_DB = {
    raven: {
        label: "Raven Gen 2 MkIV", base_hp: 200,
        weapons: [
            { name: "Dual .50 Cal Rotary", dice: "2d6", dmgType: "Impact", role: "anti_fighter", range: 280 },
            { name: "Quad Gamma Pulse", dice: "4d6", dmgType: "Heat", role: "general", range: 420 },
            { name: "Hunter Seeker Rockets", dice: "4d10", dmgType: "Piercing", role: "anti_capital", range: 600 },
            { name: "Ship Killer Missiles", dice: "2d12", dmgType: "Impact/Heat", weapon_class: "ordnance", role: "anti_capital", range: 700, cooldown_period: 4 }
        ]
    },
    hawk: {
        label: "Hawk Medium Bomber", base_hp: 350,
        weapons: [
            { name: "Dual 120mm Autocannons", dice: "2d10", dmgType: "Impact", role: "general", range: 420 },
            { name: "Micro Railgun", dice: "1d12", dmgType: "Piercing", role: "anti_capital", range: 600 },
            { name: "Capitol Killer Missiles", dice: "1d20", dmgType: "Piercing", weapon_class: "ordnance", role: "anti_capital", range: 700, cooldown_period: 4 }
        ]
    },
    messenger: {
        label: "Messenger Shuttle", base_hp: 100,
        weapons: [
            { name: "Dual Link .50 Cal", dice: "2d6", dmgType: "Impact", role: "anti_fighter", range: 280 },
            { name: "Hunter Seeker Rockets", dice: "4d10", dmgType: "Piercing", role: "anti_capital", range: 600 },
            { name: "Point Defense System", dice: "1d4", dmgType: "Impact", role: "point_defense", range: 180 }
        ]
    }
};

// Strike Craft Grid Position build: squadron tokens now get a real
// tactical_speed like any other ship_markers row, since they're placed as
// real Battle Map tokens (see spawnSquadronToken below) instead of only
// existing as an Initiative Tracker entry + Hangar Bay panel row. No real
// balance number exists for fighter speed yet -- this is a flagged
// placeholder (2x the capital-ship default), same "flat default the DM
// tunes later" convention as every other first-pass number in this app
// (Battlefield Salvage's 5-ton default, the 24h gather duration, etc.).
// There's currently no live editor for an already-deployed vessel's
// tactical_speed (only set at ship-template deploy time) -- same gap
// applies here, not a new one introduced by that build.
//
// Battle Map Grid Expansion build (this session): doubled 160 -> 320,
// matching the grid's own doubling (BATTLE_GRID_W/H, js/battle-map.js) so
// squadrons keep covering the SAME proportional share of the map per round
// as before, rather than suddenly taking twice as long to cross it. Only
// affects NEWLY spawned squadron tokens from this point forward --
// see the Grid Expansion checkpoint notes for why existing ships'
// stored tactical_speed values were deliberately NOT bulk-updated.
const SQUADRON_TACTICAL_SPEED = 320;

// --- Squadron commission / launch / recall / deploy (moved from js/combat.js) ---

/* --- STRIKE CRAFT MAP/INITIATIVE PRESENCE ---
   The hangar/deployed system above (ship_hangar / ship_deployed JSONB on the
   carrier) is the single source of truth for squadron HP and fuel — it
   already existed and already works. This layer just gives a DEPLOYED
   squadron a companion ship_markers token (visible/selectable on the map)
   and a companion combat_tracker row (visible in Initiative), linked back
   via squadron_id, WITHOUT duplicating fuel/HP into a second place that
   could drift out of sync with the real data on the carrier.

   Strike Craft Grid Position build (this session, confirmed design): a
   squadron's ship_markers token is now ALSO placed onto the active Battle
   Map grid automatically on launch, if a battle is currently active — no
   separate manual placement step, matching the precedent this token/tracker
   spawn already set. Staggered near the carrier's own token if the carrier
   is itself currently placed (window.addSquadronToBattleMap, battle-map.js
   — that file owns all battle_encounters reads/writes, so this delegates
   rather than reaching into that table directly, same cross-file convention
   as window.checkBattleTokenDestroyed/playWeaponFireEffect/launchOrdnance).
   No-op if no battle is active, or if a squadron was already deployed
   before this build shipped — those don't retroactively get a token; recall
   + relaunch picks one up. Flagged, not silently glossed over. */
async function spawnSquadronToken(vessel, sq) {
    const { data: tokenRow, error: tokenError } = await db.from('ship_markers').insert({
        owner_id: vessel.owner_id, name: sq.name,
        x: vessel.x + (Math.random() * 80 - 40), y: vessel.y + (Math.random() * 80 - 40),
        drive_type: 'sublight', color: '#ffaa00', tactical_speed: SQUADRON_TACTICAL_SPEED,
        cargo_inventory: window.sanitizeCargo({}),
        integrity_hull: sq.hp, max_hull: sq.max_hp,
        integrity_shields: 0, max_shields: 0, integrity_reactive: 0, max_reactive: 0,
        integrity_ablative: 0, max_ablative: 0, integrity_hardened: 0, max_hardened: 0,
        parent_id: vessel.id, is_strike_craft: true, squadron_id: sq.id,
        // IFF / Fog of War build (this session): inherited from the carrier
        // at launch, not left unset -- otherwise a Friendly-tagged DM-owned
        // carrier's own fighters would default to DM-only invisible in
        // players' Vessel Deck despite the carrier itself being visible, and
        // a Hidden carrier's freshly-launched squadron would immediately be
        // visible on the grid and give the ambush away. Each squadron token
        // still reveals independently on its own first shot (see
        // window.revealVesselIfHidden), same as the carrier does on its own.
        iff: vessel.iff || null, is_hidden: !!vessel.is_hidden
    }).select().single();
    if (tokenError) { console.error('Failed to spawn squadron token:', tokenError.message); }

    // Pending-list follow-up (this session): is_npc: true set explicitly —
    // a strike craft squadron isn't anyone's "character" for Ground Combat
    // To-Hit's defense-roll purposes even when player-owned, so it always
    // gets the manual-die NPC branch rather than a core-stat die. Previously
    // the owner-role heuristic didn't check entity type at all, meaning a
    // player-owned squadron entry could have incorrectly rolled a PC-style
    // defense die -- a real (if narrow) behavior fix, not just a refactor.
    const { error: trackerError } = await db.from('combat_tracker').insert({
        name: sq.name, initiative: 14, hp: `${sq.hp}/${sq.max_hp}`,
        owner_id: vessel.owner_id, parent_id: vessel.id, squadron_id: sq.id, is_strike_craft: true, is_npc: true
    });
    if (trackerError) { console.error('Failed to inject squadron into initiative tracker:', trackerError.message); }

    if (!tokenError && tokenRow && typeof window.addSquadronToBattleMap === 'function') {
        await window.addSquadronToBattleMap(vessel, sq, tokenRow.id, SQUADRON_TACTICAL_SPEED);
    }

    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
    if (typeof loadCombatTracker === 'function') loadCombatTracker();
}

async function despawnSquadronToken(squadronId) {
    // Capture the marker's id BEFORE deleting it -- globalShipMarkersCache
    // still holds the pre-delete row at this point (only loadGalaxyData(),
    // called at the end of this function without awaiting, refreshes it),
    // so this is a safe synchronous lookup, not a race.
    const markerRow = globalShipMarkersCache.find(m => m.squadron_id === squadronId && m.is_strike_craft);

    await db.from('ship_markers').delete().eq('squadron_id', squadronId);
    await db.from('combat_tracker').delete().eq('squadron_id', squadronId);

    if (markerRow && typeof window.removeBattleTokenByMarkerId === 'function') {
        await window.removeBattleTokenByMarkerId(markerRow.id);
    }

    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
    if (typeof loadCombatTracker === 'function') loadCombatTracker();
}

// Strike craft tokens got their own integrity_hull as a one-time snapshot at
// spawn time so they could render/take damage like any other ship_markers
// row — but the REAL squadron HP (shown in the carrier's Hangar Bay panel,
// and what bingo-fuel recall/casualty logic reads) lives in the parent's
// ship_deployed[].hp. Without this, damage taken via ship-to-ship weapon
// fire against a strike craft token would silently never reach the actual
// squadron record — exactly the kind of dual-source drift this whole
// system was designed to avoid. Called after any damage resolution against
// a target that turns out to be a strike craft.
async function syncSquadronHpToParent(targetShip) {
    if (!targetShip.is_strike_craft || !targetShip.parent_id || !targetShip.squadron_id) return;
    const parent = globalShipMarkersCache.find(m => m.id === targetShip.parent_id);
    if (!parent) return;
    const deployed = parent.ship_deployed || [];
    const sq = deployed.find(s => s.id === targetShip.squadron_id);
    if (!sq) return;
    sq.hp = Math.max(0, Math.min(sq.max_hp, targetShip.integrity_hull));
    await db.from('ship_markers').update({ ship_deployed: deployed }).eq('id', parent.id);
    parent.ship_deployed = deployed;
    if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
}

window.commissionSquadron = async function() {
    const select = document.getElementById('vessel-deck-select');
    if (!select || !select.value) { alert("Select a vessel to commission to."); return; }
    
    const vesselId = select.value;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    const name = document.getElementById('new-squadron-name').value.trim();
    const type = document.getElementById('new-squadron-type').value;
    const count = parseInt(document.getElementById('new-squadron-size').value) || 4;

    if (!name) { alert("Enter a callsign for this squadron."); return; }

    let hangar = vessel.ship_hangar || [];
    let dbStats = STRIKE_CRAFT_DB[type];
    
    let sqId = 'sq_' + Math.random().toString(36).substr(2, 9);
    hangar.push({
        id: sqId, name: name, type: type, count: count,
        hp: dbStats.base_hp * count, max_hp: dbStats.base_hp * count, loiter: 4
    });

    await db.from('ship_markers').update({ ship_hangar: hangar }).eq('id', vessel.id);
    vessel.ship_hangar = hangar;

    document.getElementById('new-squadron-name').value = '';
    window.renderVesselDeck();
    
    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `🔧 [HANGAR OPS] ${name} (${count}x ${dbStats.label}) commissioned aboard ${vessel.name}.`,
        message_type: 'text'
    });
};

window.launchSquadron = async function(vesselId, idx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let hangar = vessel.ship_hangar || [];
    let deployed = vessel.ship_deployed || [];

    let sq = hangar.splice(idx, 1)[0];
    if (sq) {
        sq.loiter = 4;
        deployed.push(sq);
        await db.from('ship_markers').update({ ship_hangar: hangar, ship_deployed: deployed }).eq('id', vessel.id);
        vessel.ship_hangar = hangar;
        vessel.ship_deployed = deployed;
        window.renderVesselDeck();

        if (window.AudioEngine) window.AudioEngine.playWarp();
        await spawnSquadronToken(vessel, sq);

        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🛫 [FLIGHT OPS] ${sq.name} launched from ${vessel.name}. Cleared hot for 4 turns.`,
            message_type: 'text'
        });

        // Battle Map Hangar Control build (this session, DM note #1): this
        // function is now also called from the compact hangar section on a
        // ship-status card (window.renderCompactHangarHtml below), not just
        // the Vessel Deck -- refresh that view too for immediate feedback on
        // the initiating client, same as window.renderVesselDeck above.
        // Other clients pick this up via the ship_markers realtime channel
        // like any other change to this table.
        if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    }
};

window.recallSquadron = async function(vesselId, idx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let hangar = vessel.ship_hangar || [];
    let deployed = vessel.ship_deployed || [];

    let sq = deployed.splice(idx, 1)[0];
    if (sq) {
        hangar.push(sq);
        await db.from('ship_markers').update({ ship_hangar: hangar, ship_deployed: deployed }).eq('id', vessel.id);
        vessel.ship_hangar = hangar;
        vessel.ship_deployed = deployed;
        window.renderVesselDeck();
        await despawnSquadronToken(sq.id);
        // Battle Map Hangar Control build (this session): see the matching
        // comment in window.launchSquadron above.
        if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();

        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🛬 [FLIGHT OPS] ${sq.name} recovered to ${vessel.name} hangar bay.`,
            message_type: 'text'
        });
    }
};

/* Battle Map Hangar Control build (this session, DM note #1): "a hangar
   control needs to be added to the battle map per ship" -- a compact
   LAUNCH/RECALL section for a ship-status card, wired to the SAME
   window.launchSquadron/window.recallSquadron functions the Vessel Deck
   already calls (not a parallel implementation, per the DM's own read of
   this request). Deliberately much lighter than the Vessel Deck's own
   hangar/deployed sections (js/combat.js renderVesselDeck) -- no AI stance
   picker, no manual weapon/target row, no loiter +/- -- since a ship-status
   card is already dense; those controls stay on the Vessel Deck. Returns ''
   (renders nothing) for a vessel with no hangar/deployed squadrons at all,
   so a non-carrier's card is unaffected. idx passed to launch/recall is the
   raw index into vessel.ship_hangar/ship_deployed, matching how
   renderVesselDeck's own embedded version already does it. */
window.renderCompactHangarHtml = function(vessel) {
    const hangar = vessel.ship_hangar || [];
    const deployed = vessel.ship_deployed || [];
    if (hangar.length === 0 && deployed.length === 0) return '';

    let html = '<div style="margin-top:8px; padding-top:8px; border-top:1px dashed #3c4e36;">';
    html += '<div style="font-size:9px; color:#6b826a; margin-bottom:4px;">HANGAR BAY</div>';
    hangar.forEach((sq, idx) => {
        const dbStats = STRIKE_CRAFT_DB[sq.type];
        html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 0; font-size:9px; color:#d4c5a9;">
            <span>${sq.name} <span style="color:#6b826a;">${dbStats ? dbStats.label : sq.type} x${sq.count}</span></span>
            <button class="layer-edit" onclick="window.launchSquadron('${vessel.id}', ${idx})" style="padding:2px 8px; font-size:8px; border-color:#00e1ff; color:#00e1ff;">🚀 LAUNCH</button>
        </div>`;
    });
    deployed.forEach((sq, idx) => {
        const dbStats = STRIKE_CRAFT_DB[sq.type];
        html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 0; font-size:9px; color:#ffaa00;">
            <span>🛫 ${sq.name} <span style="color:#6b826a;">${dbStats ? dbStats.label : sq.type} · HP ${sq.hp}/${sq.max_hp}</span></span>
            <button class="layer-edit" onclick="window.recallSquadron('${vessel.id}', ${idx})" style="padding:2px 8px; font-size:8px; border-color:#00e5a3; color:#00e5a3;">RECALL</button>
        </div>`;
    });
    html += '</div>';
    return html;
};

window.deleteSquadron = async function(vesselId, idx, isDeployed) {
    if (!(await window.showConfirmModal(isDeployed ? "Record this squadron as destroyed in combat?" : "Decommission this squadron from the hangar?"))) return;
    
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let targetArray = isDeployed ? (vessel.ship_deployed || []) : (vessel.ship_hangar || []);
    let sq = targetArray.splice(idx, 1)[0];

    let updatePayload = isDeployed ? { ship_deployed: targetArray } : { ship_hangar: targetArray };
    await db.from('ship_markers').update(updatePayload).eq('id', vesselId);
    
    if (isDeployed) vessel.ship_deployed = targetArray;
    else vessel.ship_hangar = targetArray;

    if (isDeployed && sq) await despawnSquadronToken(sq.id);

    window.renderVesselDeck();

    if (isDeployed && sq) {
        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `💥 [KIA REPORT] ${sq.name} destroyed in combat.`,
            message_type: 'text'
        });
    }
};

window.modifySquadronLoiter = async function(vesselId, idx, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let deployed = vessel.ship_deployed || [];
    if (deployed[idx]) {
        deployed[idx].loiter = Math.max(0, Math.min(10, deployed[idx].loiter + delta));
        await db.from('ship_markers').update({ ship_deployed: deployed }).eq('id', vesselId);
        vessel.ship_deployed = deployed;
        window.renderVesselDeck();
    }
};

// --- Squadron target-scoping, AI stance, weapon fire & ordnance (moved from js/combat.js) ---

/* Squadron AI Stances build (this session): sets/clears which stance (if
   any) a deployed squadron uses. '' (Manual) is the default for every
   existing and newly-launched squadron -- nothing about this build changes
   behavior for a squadron nobody has explicitly set a stance on. See
   window.processBattleRoundAutomations (js/battle-map.js) for where a
   non-manual stance actually gets resolved each Advance Round. */
/* Strike-Craft Weapon Range build (this session): the manual FIRE row's
   weapon and target selects are sibling elements, not one dropdown per
   weapon row like renderShipWeaponsHtml -- so when the player changes which
   weapon they're about to fire, the target list has to be rebuilt live to
   reflect THAT weapon's own range. Mirrors the scoping logic used at initial
   render (see renderVesselDeck's deployedContainer block above): distance
   from the squadron's own battle-map token (sqShipSelf), not the carrier's.
   Fails open (falls back to every other ship) if there's no battle-scoping
   function or no token for this squadron this round -- same "don't block
   fire over a missing token" convention as everywhere else in this build. */
window.updateSquadronTargetOptions = function(vesselId, sqIdx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let sq = (vessel.ship_deployed || [])[sqIdx];
    if (!sq) return;
    let dbStats = STRIKE_CRAFT_DB[sq.type];
    const wpnSelect = document.getElementById(`sq-wpn-select-${vesselId}-${sqIdx}`);
    const targetSelect = document.getElementById(`sq-target-${vesselId}-${sqIdx}`);
    if (!wpnSelect || !targetSelect || !dbStats) return;

    const wpn = dbStats.weapons[parseInt(wpnSelect.value, 10)];
    const sqShipSelf = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
    const scoped = (sqShipSelf && typeof window.getBattleScopedTargets === 'function') ? window.getBattleScopedTargets(sqShipSelf.id, wpn ? wpn.range : 0) : null;
    // Fog of War build (this session): same fallback-path filter as the two
    // sibling target-list builders above.
    const candidates = scoped || globalShipMarkersCache.filter(m => m.id !== vesselId && (typeof window.isVesselVisibleToMe !== 'function' || window.isVesselVisibleToMe(m)));

    const prevValue = targetSelect.value;
    let targetOptions = '<option value="">-- Target --</option>';
    candidates.forEach(m => { targetOptions += `<option value="${m.id}">${m.is_strike_craft ? '🛩️ ' : ''}${m.name}</option>`; });
    targetSelect.innerHTML = targetOptions;
    if (prevValue && candidates.some(m => m.id === prevValue)) targetSelect.value = prevValue;

    // Squadron Ordnance build (this session): the shared FIRE/LAUNCH button
    // pair toggles here too, same weapon-select onchange hook -- switching to
    // an ordnance-classified weapon (Ship Killer / Capitol Killer Missiles)
    // swaps which button is visible, mirroring renderShipWeaponsHtml's
    // static per-row FIRE-vs-LAUNCH choice but done live since this row has
    // one shared button pair for whichever weapon is currently selected.
    const fireBtn = document.getElementById(`sq-fire-btn-${vesselId}-${sqIdx}`);
    const launchBtn = document.getElementById(`sq-launch-btn-${vesselId}-${sqIdx}`);
    if (fireBtn && launchBtn) {
        const isOrdnance = !!(wpn && wpn.weapon_class === 'ordnance');
        fireBtn.style.display = isOrdnance ? 'none' : '';
        launchBtn.style.display = isOrdnance ? '' : 'none';
    }

    // Weapon Cooldowns build (this session): keep the cooldown badge in
    // sync with whichever weapon is now selected -- same live-toggle hook
    // as the FIRE/LAUNCH swap just above.
    const cdBadge = document.getElementById(`sq-cooldown-badge-${vesselId}-${sqIdx}`);
    if (cdBadge) {
        const cdNow = (sq.weapon_cooldowns && sq.weapon_cooldowns[wpnSelect.value]) || 0;
        cdBadge.textContent = `CD:${cdNow}`;
        cdBadge.style.display = cdNow > 0 ? '' : 'none';
    }
};

window.setSquadronAIStance = async function(vesselId, sqIdx, stance) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let sq = (vessel.ship_deployed || [])[sqIdx];
    if (!sq) return;
    sq.ai_stance = stance || '';
    await db.from('ship_markers').update({ ship_deployed: vessel.ship_deployed }).eq('id', vessel.id);
    window.renderVesselDeck();
};

/* Squadron AI Stances build (this session): the actual dice/damage/persist/
   broadcast logic previously lived directly inside window.rollSquadronWeapon
   and read its weapon+target selections straight from the manual FIRE row's
   DOM elements — which meant nothing else in the codebase could resolve a
   squadron shot without a rendered UI to read from. Extracted here as a
   DOM-independent core (explicit wpnIdx/targetId params instead of
   document.getElementById reads) so BOTH the manual FIRE button (still
   window.rollSquadronWeapon, now a thin DOM-reading wrapper below) and the
   new automated AI Stance resolution in js/battle-map.js's
   processBattleRoundAutomations call the exact same implementation — one
   damage-resolution path, not two that could quietly drift apart. Logic
   itself is UNCHANGED from before this refactor. opts.auto (used by the AI
   path) just swaps the chat broadcast's label prefix so an automated shot
   reads distinctly from a player's own manual click in the log. */
window.resolveSquadronWeaponFire = async function(vesselId, sqIdx, wpnIdx, targetId, opts) {
    opts = opts || {};
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let sq = (vessel.ship_deployed || [])[sqIdx];
    if (!sq) return;

    let dbStats = STRIKE_CRAFT_DB[sq.type];
    let wpn = dbStats.weapons[wpnIdx];
    if (!wpn) return;

    // Weapon Cooldowns build (this session): same soft-override convention
    // ship_weapons' own cooldown check already uses (rollShipWeapon above) --
    // automated AI-stance fire hard-skips (no one to confirm an override
    // mid-tick, same rule ship PD's automated pool already follows), manual
    // FIRE warns and allows an override. State lives on the squadron
    // instance itself (sq.weapon_cooldowns), not on `wpn` -- STRIKE_CRAFT_DB
    // is a shared catalog, not per-instance data, so every squadron of the
    // same type tracks its own cooldowns independently.
    const wpnCooldownNow = (sq.weapon_cooldowns && sq.weapon_cooldowns[wpnIdx]) || 0;
    if (wpnCooldownNow > 0) {
        if (opts.auto) return;
        if (!(await window.showConfirmModal(`[WARNING] ${wpn.name} is on cooldown (${wpnCooldownNow} more turn(s))! Firing will OVERRIDE. Proceed?`))) return;
    }

    // Squadrons fire from their OWN battle-map token, not the carrier's --
    // same lookup the range check and the beam-effect code below both need,
    // computed once here and reused (was previously duplicated inline).
    const sqShipSelf = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);

    // System Lockdown build (this session): Weapons-disabled gate, checked
    // on the squadron's own companion token (that's what would have been
    // targeted and hit by an EMP shot, not the carrier). Fails open if the
    // squadron has no token at all -- same "can't check what doesn't exist"
    // convention as everything else here.
    if (sqShipSelf && sqShipSelf.disabled_weapons_until > 0) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[WEAPONS DISABLED] ${sq.name}'s weapons are offline for ${sqShipSelf.disabled_weapons_until} more round(s).`);
        return;
    }

    // Strike-Craft Weapon Range build (this session): explicit
    // defense-in-depth re-check at fire time, mirroring window.launchOrdnance
    // (js/battle-map.js)'s pattern for ship_weapons ordnance -- the manual
    // target dropdown is already range-scoped (window.updateSquadronTargetOptions
    // above), but this re-validates against CURRENT token positions in case
    // either side moved between the dropdown populating and the FIRE click.
    // opts.auto (the AI-stance path in processBattleRoundAutomations)
    // already range-gates BEFORE ever calling this, per the confirmed "AI
    // holds fire until in range" design -- so this should only trip there as
    // a redundant safety net, and does so silently (no blocking alert()
    // during automated round resolution) rather than the manual path's
    // alert+refuse UX. Fails open (fires anyway) if either token's grid
    // position can't be found -- same "don't block on a missing token"
    // convention as every other range/position check in this build.
    if (targetId && wpn.range) {
        const selfPos = sqShipSelf ? window.getBattleTokenPosition(sqShipSelf.id) : null;
        const targetPosForRange = window.getBattleTokenPosition(targetId);
        if (selfPos && targetPosForRange && Math.hypot(targetPosForRange.x - selfPos.x, targetPosForRange.y - selfPos.y) > wpn.range) {
            if (opts.auto) return;
            if (window.AudioEngine) window.AudioEngine.playError();
            const targetShipForAlert = globalShipMarkersCache.find(m => m.id === targetId);
            alert(`[OUT OF RANGE] ${targetShipForAlert ? targetShipForAlert.name : 'Target'} is beyond ${wpn.name}'s range (${wpn.range}).`);
            return;
        }
    }

    let volleys = sq.count;
    if (volleys <= 0) return;

    // Weapon Cooldowns build (this session): the shot is now committed --
    // start this weapon's reload clock on the SQUADRON instance (not the
    // shared catalog entry). Replaces rather than stacks, same rule
    // rollShipWeapon's own auto-set uses.
    if (wpn.cooldown_period > 0) {
        sq.weapon_cooldowns = sq.weapon_cooldowns || {};
        sq.weapon_cooldowns[wpnIdx] = wpn.cooldown_period;
    }

    // Fog of War build (this session, confirmed design): reveal the
    // squadron's own token the moment its shot is committed (every gate
    // above this point could still have refused to fire). Best-effort --
    // never blocks the shot itself if this fails.
    try { if (typeof window.revealVesselIfHidden === 'function' && sqShipSelf) await window.revealVesselIfHidden(sqShipSelf); } catch (err) { console.error('resolveSquadronWeaponFire: reveal-on-fire failed', err); }

    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = wpn.dice.trim().match(diceRegex);
    if (!match) return;

    let baseNumDice = parseInt(match[1]) || 1;
    let numDice = baseNumDice * volleys;
    let diceFaces = parseInt(match[2]);

    let canExplode = wpn.explodes && diceFaces >= 2;

    let total = 0;
    let breakdown = [];

    for (let i = 0; i < numDice; i++) {
        let rollTotal = 0;
        let subRolls = [];
        let currentRoll;
        do {
            currentRoll = Math.floor(Math.random() * diceFaces) + 1;
            rollTotal += currentRoll;
            subRolls.push(currentRoll);
        } while (currentRoll === diceFaces && canExplode);
        total += rollTotal;
        breakdown.push(`(d${diceFaces}: ${subRolls.join('💥')})`);
    }

    const breakdownText = breakdown.join(' + ');

    let targetShip = null;
    let combatLog = ``;
    let dmgType = window.normalizeDamageType(wpn.dmgType || 'Impact');

    if (targetId) {
        targetShip = globalShipMarkersCache.find(m => m.id === targetId);
        if (targetShip) {
            let tStance = targetShip.ship_stance || 'Balanced';
            if (tStance === 'Defensive') { total = Math.floor(total * 0.75); combatLog += `[Target Defensive: -25% Dmg] `; }
            if (tStance === 'Evasive') { total = Math.floor(total * 0.50); combatLog += `[Target Evasive: -50% Dmg] `; }
            if (tStance === 'Aggressive') { total = Math.floor(total * 1.25); combatLog += `[Target Aggressive: +25% Dmg] `; }

            let categoryMult = 1;
            if (dmgType !== 'Healing') {
                if (targetShip.is_strike_craft) {
                    categoryMult = (dmgType === 'Flak') ? 2 : 0.5;
                    combatLog += `[TARGET: STRIKE CRAFT] ${dmgType} effectiveness x${categoryMult}. `;
                } else if (dmgType === 'Flak') {
                    categoryMult = 0.4;
                    combatLog += `[TARGET: SHIP] Flak is a poor fit for capital-scale armor (x${categoryMult}). `;
                }
            }
            total = Math.ceil(total * categoryMult);

            const result = window.resolveShipDamage(targetShip, dmgType, total);
            combatLog += result.log;

            await db.from('ship_markers').update({
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened
            }).eq('id', targetShip.id);
            Object.assign(targetShip, {
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened
            });
            await syncSquadronHpToParent(targetShip);

            // Tactical Battle Map: if this target is a token in the active
            // battle and just hit 0 hull, auto-withdraw its token (does not
            // touch this ship_markers row itself). No-op outside a battle.
            if (typeof window.checkBattleTokenDestroyed === 'function') await window.checkBattleTokenDestroyed(targetShip);

            // Strike Craft Grid Position build (this session): a beam flash
            // between the squadron's own token and its target, same
            // playWeaponFireEffect used by rollShipWeapon — no longer
            // deliberately skipped now that squadrons have a real token to
            // draw the beam from. Local-only, same flagged limitation as
            // ship-weapon fire (no broadcast channel exists in this
            // codebase — see the Animation Engine checkpoint).
            if (typeof window.playWeaponFireEffect === 'function') {
                if (sqShipSelf) {
                    const beamColor = (window.DAMAGE_TYPES[dmgType] && window.DAMAGE_TYPES[dmgType].color) || '#ffaa00';
                    window.playWeaponFireEffect(sqShipSelf.id, targetShip.id, beamColor, dmgType);
                }
            }

            // Range/Ordnance build (prior session): persist which target this
            // squadron last fired at. Strike Craft Grid Position build (this
            // session): Point Defense no longer reads this as a position
            // stand-in — squadrons now have a real Battle Map token, so PD
            // checks that directly (see window.processBattleRoundAutomations,
            // js/battle-map.js). Kept as a harmless "last engaged" record,
            // not currently read by anything else.
            sq.target_id = targetShip.id;
        }
    }

    // Weapon Cooldowns build (this session): persisting ship_deployed is now
    // unconditional -- a "fire into the void" shot (no target) still needs
    // to start its weapon_cooldowns clock, which the old target-only persist
    // here would have silently dropped. sq.target_id's own persistence rides
    // along in the same write, unchanged.
    if (wpn.cooldown_period > 0 || targetShip) {
        await db.from('ship_markers').update({ ship_deployed: vessel.ship_deployed }).eq('id', vessel.id);
    }

    let targetString = targetShip ? ` at ${targetShip.name}` : ``;
    let breakdownString = `
        <div style="margin-top:4px; padding:4px; border-left:2px solid #ffaa00; background:rgba(255,170,0,0.1);">
            <strong>Damage Type:</strong> ${dmgType}<br>
            <strong>Base Output:</strong> ${breakdownText} = <strong style="color:#ff3333;">${total} Dmg</strong><br>
            ${targetShip ? `<strong>Target Report:</strong> ${combatLog}` : ''}
        </div>
    `;

    if (window.AudioEngine) window.AudioEngine.playShoot();

    if(typeof window.broadcastRoll === 'function') {
        const autoTag = opts.auto ? '🤖 [AI STANCE] ' : '';
        await window.broadcastRoll(`${autoTag}[${sq.name}] FIRES ${wpn.name} (x${volleys})${targetString}`, breakdownString, total);
    }
};

// Thin DOM-reading wrapper — unchanged call signature/behavior for the
// manual FIRE button (window.rollSquadronWeapon('vesselId', sqIdx) via
// onclick), delegating to window.resolveSquadronWeaponFire above.
window.rollSquadronWeapon = async function(vesselId, sqIdx) {
    let wpnIdx = document.getElementById(`sq-wpn-select-${vesselId}-${sqIdx}`).value;
    let targetId = document.getElementById(`sq-target-${vesselId}-${sqIdx}`).value;
    await window.resolveSquadronWeaponFire(vesselId, sqIdx, wpnIdx, targetId);
};

/* Squadron Ordnance build (this session): mirrors window.launchOrdnance
   (js/battle-map.js, ship_weapons' own ordnance path) for a squadron's
   weapon_class:'ordnance' entries (Ship Killer / Capitol Killer Missiles)
   instead of resolveSquadronWeaponFire's instant-resolve. Called from BOTH
   the manual LAUNCH button (window.launchSquadronOrdnanceFromUI below) and
   the AI-stance offensive loop in processBattleRoundAutomations (opts.auto)
   -- one implementation, not two, same convention resolveSquadronWeaponFire
   itself already established.

   Confirmed design (this session): the payload's dice DO scale with the
   squadron's own unit count (sq.count), same multiplier a normal squadron
   FIRE already applies -- NOT left flat like ship_weapons' own ordnance,
   which ignores gun-count/volley entirely. Flagging plainly: this stacks
   with the pre-existing "splits into 6 independent payloads, each carrying
   the FULL dice profile" mechanic (processBattleRoundAutomations,
   js/battle-map.js) -- a 3-unit squadron's "2d12" becomes "6d12" BEFORE the
   split, so up to 6x that already-tripled damage can land if every payload
   survives interception. This was the explicitly-flagged tradeoff of the
   confirmed option (over the ship-ordnance-style "ignore unit count"
   alternative), not an oversight — no rebalancing was requested or
   attempted here. */
window.launchSquadronOrdnance = async function(vesselId, sqIdx, wpnIdx, targetId, opts) {
    opts = opts || {};
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let sq = (vessel.ship_deployed || [])[sqIdx];
    if (!sq) return;

    let dbStats = STRIKE_CRAFT_DB[sq.type];
    let wpn = dbStats && dbStats.weapons[wpnIdx];
    if (!wpn) return;

    const sqShipSelf = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
    const selfPos = sqShipSelf ? window.getBattleTokenPosition(sqShipSelf.id) : null;
    if (!selfPos) {
        // Not a battle-map token right now (pre-build legacy launch, or
        // launched outside an active battle) -- no grid to track a flight
        // against, so this falls back to the old instant-resolve behavior,
        // same pattern window.launchOrdnance uses for ship weapons.
        return window.resolveSquadronWeaponFire(vesselId, sqIdx, wpnIdx, targetId, opts);
    }

    // System Lockdown build (this session): same Weapons-disabled gate as
    // resolveSquadronWeaponFire's own check above, checked on the squadron's
    // own companion token.
    if (sqShipSelf.disabled_weapons_until > 0) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[WEAPONS DISABLED] ${sq.name}'s weapons are offline for ${sqShipSelf.disabled_weapons_until} more round(s).`);
        return;
    }

    // Weapon Cooldowns build (this session): same soft-override convention
    // as resolveSquadronWeaponFire's own check above (and every other
    // cooldown check in this app) -- automated AI-stance fire hard-skips,
    // manual LAUNCH warns and allows an override.
    const ordCooldownNow = (sq.weapon_cooldowns && sq.weapon_cooldowns[wpnIdx]) || 0;
    if (ordCooldownNow > 0) {
        if (opts.auto) return;
        if (!(await window.showConfirmModal(`[WARNING] ${wpn.name} is on cooldown (${ordCooldownNow} more turn(s))! Launching will OVERRIDE. Proceed?`))) return;
    }

    if (!targetId) { if (!opts.auto) alert('Select a target first.'); return; }
    let targetVessel = globalShipMarkersCache.find(m => m.id === targetId);
    if (!targetVessel) return;
    const targetPos = window.getBattleTokenPosition(targetId);
    if (!targetPos) { if (!opts.auto) alert('Target is not on the battle grid.'); return; }

    // Defense-in-depth re-check, same reasoning as resolveSquadronWeaponFire's
    // own range re-check above -- the AI-stance path already range-gates
    // BEFORE ever calling this (see processBattleRoundAutomations), so this
    // should only trip here for the manual path, or as a redundant safety
    // net if either token moved between dropdown-populate and click/tick.
    if (wpn.range && Math.hypot(targetPos.x - selfPos.x, targetPos.y - selfPos.y) > wpn.range) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[OUT OF RANGE] ${targetVessel.name} is beyond ${wpn.name}'s range (${wpn.range}).`);
        return;
    }

    let volleys = sq.count;
    if (volleys <= 0) return;

    // Weapon Cooldowns build (this session): the launch is now committed --
    // start this weapon's reload clock on the squadron instance, same rule
    // resolveSquadronWeaponFire's own auto-set uses.
    if (wpn.cooldown_period > 0) {
        sq.weapon_cooldowns = sq.weapon_cooldowns || {};
        sq.weapon_cooldowns[wpnIdx] = wpn.cooldown_period;
    }

    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = (wpn.dice || '').trim().match(diceRegex);
    if (!match) { console.error('launchSquadronOrdnance: malformed weapon dice, aborting', wpn); return; }
    let baseNumDice = parseInt(match[1]) || 1;
    let diceFaces = parseInt(match[2]);
    // Single Warhead Ordnance build (this session, confirmed design): squadron
    // ordnance shares the same ordnance_pattern field/mechanic as ship
    // ordnance (js/battle-map.js's launchOrdnance/window.SINGLE_WARHEAD_DICE_MULT)
    // even though squadron AMMO TIERS themselves were confirmed out of scope
    // for this pass -- this is just the multi/single split, which costs
    // almost nothing extra since launchSquadronOrdnance already reuses the
    // identical in_flight_ordnance/split code path. Stacks with (multiplies
    // on top of) the existing unit-count scaling below, not a replacement
    // for it -- a 'single'-pattern squadron ordnance is still bigger with
    // more units in the squadron, same as 'multi' already was.
    const isSinglePattern = wpn.ordnance_pattern === 'single';
    const singleMult = isSinglePattern ? (window.SINGLE_WARHEAD_DICE_MULT || 3) : 1;
    let numDice = baseNumDice * volleys * singleMult; // confirmed design: scales with unit count
    const scaledDice = `${numDice}d${diceFaces}`;

    // Fog of War build (confirmed design, inherited from every other fire
    // path in this app): reveal the squadron's own token the moment its
    // shot is committed. Best-effort, never blocks the launch.
    try { if (typeof window.revealVesselIfHidden === 'function') await window.revealVesselIfHidden(sqShipSelf); } catch (err) { console.error('launchSquadronOrdnance: reveal-on-fire failed', err); }

    const ordnance = (window.globalBattleEncounterCache.in_flight_ordnance || []).slice();
    ordnance.push({
        salvo_id: (typeof genBattleTokenId === 'function') ? genBattleTokenId() : `${Date.now()}-${Math.random()}`,
        source_vessel_id: sqShipSelf.id, source_vessel_name: sq.name,
        source_weapon_name: wpn.name, dice: scaledDice, modifier: 0, explodes: !!wpn.explodes,
        damage_type: wpn.dmgType || 'Impact',
        target_vessel_id: targetId, target_vessel_name: targetVessel.name,
        turns_remaining: 3, split: false, ordnance_pattern: isSinglePattern ? 'single' : 'multi'
    });
    window.globalBattleEncounterCache.in_flight_ordnance = ordnance;
    await db.from('battle_encounters').update({ in_flight_ordnance: ordnance }).eq('id', window.globalBattleEncounterCache.id);

    // Same "last engaged target" bookkeeping regular squadron fire already
    // records -- informational only, nothing currently reads it back for
    // ordnance specifically.
    sq.target_id = targetId;
    await db.from('ship_markers').update({ ship_deployed: vessel.ship_deployed }).eq('id', vessel.id);

    if (window.AudioEngine) window.AudioEngine.playShoot();
    const autoTag = opts.auto ? '🤖 [AI STANCE] ' : '';
    const patternTag = isSinglePattern ? ' [SINGLE WARHEAD]' : '';
    await db.from('chat_logs').insert({ sender_id: null, content: `${autoTag}☠️ [ORDNANCE]${patternTag} ${sq.name} launches ${wpn.name} (x${volleys} units) at ${targetVessel.name} — impact in 3 rounds.`, message_type: 'system' });
    window.renderVesselDeck();
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};

// Thin DOM-reading wrapper for the manual ☠ LAUNCH button, same relationship
// to window.launchSquadronOrdnance that window.rollSquadronWeapon has to
// window.resolveSquadronWeaponFire above.
window.launchSquadronOrdnanceFromUI = async function(vesselId, sqIdx) {
    let wpnIdx = document.getElementById(`sq-wpn-select-${vesselId}-${sqIdx}`).value;
    let targetId = document.getElementById(`sq-target-${vesselId}-${sqIdx}`).value;
    await window.launchSquadronOrdnance(vesselId, sqIdx, wpnIdx, targetId);
};

// --- Squadron Battle Map token add/remove (moved from js/battle-map.js) ---

/* --- STRIKE CRAFT GRID POSITION (this session, confirmed design) ---
   Called from js/combat.js's spawnSquadronToken right after a launched
   squadron's ship_markers row is inserted. Auto-places a token for it on
   the active Battle Map grid — no separate manual placement step, matching
   the precedent the ship_markers/combat_tracker rows already set. No-op if
   no battle is currently active (a squadron can launch anytime, not just
   during an engagement); that squadron simply won't have a grid presence
   until it's recalled and relaunched during an active battle, or a future
   sync action is built — flagged, not silently patched over here. */
window.addSquadronToBattleMap = async function(carrierVessel, sq, markerId, tacticalSpeed) {
    if (!window.globalBattleEncounterCache) return;
    const tokens = (window.globalBattleEncounterCache.tokens || []).slice();

    // Stagger near the carrier's own token if it's currently placed;
    // otherwise fall back to the same staggered-corner placement used for
    // any other freshly-deployed vessel.
    const carrierPos = window.getBattleTokenPosition ? window.getBattleTokenPosition(carrierVessel.id) : null;
    const pos = carrierPos
        ? clampToGrid(carrierPos.x + (Math.random() * 60 - 30), carrierPos.y + (Math.random() * 60 - 30))
        : staggeredTokenPos(tokens.length);

    tokens.push({ token_id: genBattleTokenId(), ship_marker_id: markerId, x: pos.x, y: pos.y, move_remaining: tacticalSpeed ?? 160 });
    await saveBattleTokens(tokens);
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};

/* Called from js/combat.js's despawnSquadronToken (recall or destroyed-in-
   combat) to clean up the grid token created above. No confirm dialog —
   this is automatic housekeeping tied to an action the player/DM already
   confirmed (recalling or recording a casualty), same "silent auto-removal"
   pattern as window.checkBattleTokenDestroyed. No-op if there's no active
   battle or no matching token (e.g. the squadron launched before this build
   shipped and never got one). */
window.removeBattleTokenByMarkerId = async function(markerId) {
    if (!window.globalBattleEncounterCache) return;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const tok = tokens.find(t => t.ship_marker_id === markerId);
    if (!tok) return;
    await saveBattleTokens(tokens.filter(t => t.token_id !== tok.token_id));
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};
