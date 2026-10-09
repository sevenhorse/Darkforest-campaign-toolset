/* ==========================================================================
   js/squadrons.js - Strike Craft Catalog & Squadron Logic
   ========================================================================== */

/* Holds the STRIKE_CRAFT_DB catalog, squadron commission/launch/recall/fire
   logic, and the two Battle Map token helpers for squadrons.
   Squadron point-defense intercept logic (squadronWeaponCooldown,
   findEligibleSquadronIntercept, fireEligibleSquadronIntercept) is NOT here:
   it stays nested in window.processBattleRoundAutomations (js/battle-map.js)
   because it shares closure state with the ship PD logic there.

   Load order: nothing here is needed at another script's parse time (all
   references are call-time lookups). Placed right after combat.js in
   index.html to keep squadron-related scripts grouped. */

// Weapon fields:
// - role ('anti_fighter' | 'anti_capital' | 'point_defense' | 'general'):
//   used by AI stances to pick a weapon. Tags are judgment calls from weapon
//   names, not DM rules. Untagged = 'general', used only as a last-resort
//   fallback when no weapon matches the stance's role.
// - range: grid px, same unit as ship_weapons' range. Placeholder values,
//   DM-tunable.
// - cooldown_period: rounds before the weapon is ready again after firing,
//   tracked per squadron in sq.weapon_cooldowns[wpnIdx]. Placeholder, set
//   only on the ordnance missiles; absent or 0 means no cooldown.
const STRIKE_CRAFT_DB = {
    raven: {
        label: "Raven Gen 2 MkIV", base_hp: 200,
        weapons: [
            { name: "Dual .50 Cal Rotary", dice: "2d6", dmgType: "Impact", role: "anti_fighter", range: 90 },
            { name: "Quad Gamma Pulse", dice: "4d6", dmgType: "Heat", role: "general", range: 90 },
            { name: "Hunter Seeker Rockets", dice: "4d10", dmgType: "Piercing", role: "anti_capital", range: 90 },
            { name: "Ship Killer Missiles", dice: "2d12", dmgType: "Impact/Heat", weapon_class: "ordnance", role: "anti_capital", range: 200, cooldown_period: 4 }
        ]
    },
    hawk: {
        label: "Hawk Medium Bomber", base_hp: 350,
        weapons: [
            { name: "Dual 120mm Autocannons", dice: "2d10", dmgType: "Impact", role: "general", range: 90 },
            { name: "Micro Railgun", dice: "1d12", dmgType: "Piercing", role: "anti_capital", range: 90 },
            { name: "Capitol Killer Missiles", dice: "1d20", dmgType: "Piercing", weapon_class: "ordnance", role: "anti_capital", range: 200, cooldown_period: 4 }
        ]
    },
    messenger: {
        label: "Messenger Shuttle", base_hp: 100,
        weapons: [
            { name: "Dual Link .50 Cal", dice: "2d6", dmgType: "Impact", role: "anti_fighter", range: 90 },
            { name: "Hunter Seeker Rockets", dice: "4d10", dmgType: "Piercing", role: "anti_capital", range: 90 },
            { name: "Point Defense System", dice: "1d4", dmgType: "Impact", role: "point_defense", range: 90 }
        ]
    }
};

// Movement per round (grid px) for newly spawned squadron tokens.
// Placeholder, DM-tunable; scaled to the battle grid size. Changing it does
// not update tokens that already exist. There is no editor for a deployed
// token's tactical_speed.
const SQUADRON_TACTICAL_SPEED = 320;

// Safe STRIKE_CRAFT_DB lookup. An unknown chassis (deleted DM design, or
// before loadStrikeCraftTemplates finishes at login) returns a placeholder
// with no weapons instead of crashing the screens that list it. Never
// mutates the catalog.
window.getStrikeCraftStats = function(type) {
    const stats = (typeof STRIKE_CRAFT_DB !== 'undefined') ? STRIKE_CRAFT_DB[type] : null;
    if (stats) return stats;
    return { label: `${type || 'Unknown'} (chassis not in catalog)`, base_hp: 0, weapons: [], _missing: true };
};

// --- Squadron commission / launch / recall / deploy ---

/* The carrier's ship_hangar / ship_deployed JSONB is the single source of
   truth for squadron HP and fuel. A deployed squadron also gets a companion
   ship_markers token and a combat_tracker row, linked by squadron_id, so it
   shows on the map and in Initiative. If a battle is active, the token is
   also placed on the Battle Map grid (window.addSquadronToBattleMap). With no
   active battle there is no grid token; recall + relaunch adds one. */
async function spawnSquadronToken(vessel, sq, hideFromOverworld) {
    const { data: tokenRow, error: tokenError } = await db.from('ship_markers').insert({
        owner_ids: window.vesselOwnerIds(vessel), name: sq.name,
        x: vessel.x + (Math.random() * 80 - 40), y: vessel.y + (Math.random() * 80 - 40),
        drive_type: 'sublight', color: '#ffaa00', tactical_speed: SQUADRON_TACTICAL_SPEED,
        cargo_inventory: window.sanitizeCargo({}),
        integrity_hull: sq.hp, max_hull: sq.max_hp,
        integrity_shields: 0, max_shields: 0, integrity_reactive: 0, max_reactive: 0,
        integrity_ablative: 0, max_ablative: 0, integrity_hardened: 0, max_hardened: 0,
        parent_id: vessel.id, is_strike_craft: true, squadron_id: sq.id,
        // IFF and hidden state inherit from the carrier, so a friendly
        // carrier's fighters are visible to players and a hidden carrier's
        // launch doesn't give it away. Each token reveals on its own first
        // shot (window.revealVesselIfHidden).
        iff: vessel.iff || null, is_hidden: !!vessel.is_hidden,
        // True only when launched from the Battle Map's compact hangar
        // control: keeps the token off the galaxy map (js/map.js). Unrelated
        // to is_hidden. DM rule: stays set until recalled and relaunched from
        // the Vessel Deck; does not clear when the battle ends.
        hide_from_galaxy_map: !!hideFromOverworld
    }).select().single();
    if (tokenError) { console.error('Failed to spawn squadron token:', tokenError.message); }

    // is_npc: true even when player-owned: a squadron is not a character, so
    // Ground Combat To-Hit uses the manual-die NPC defense roll, not a
    // core-stat die.
    const { error: trackerError } = await db.from('combat_tracker').insert({
        name: sq.name, initiative: 14, hp: `${sq.hp}/${sq.max_hp}`,
        // combat_tracker.owner_id is single-value: use the carrier's primary owner.
        owner_id: window.vesselOwnerIds(vessel)[0] || null, parent_id: vessel.id, squadron_id: sq.id, is_strike_craft: true, is_npc: true
    });
    if (trackerError) { console.error('Failed to inject squadron into initiative tracker:', trackerError.message); }

    if (!tokenError && tokenRow && typeof window.addSquadronToBattleMap === 'function') {
        await window.addSquadronToBattleMap(vessel, sq, tokenRow.id, SQUADRON_TACTICAL_SPEED);
    }

    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
    if (typeof loadCombatTracker === 'function') loadCombatTracker();
}

async function despawnSquadronToken(squadronId) {
    // Look up the marker id before deleting. The cache still holds the row
    // here; only loadGalaxyData() at the end refreshes it.
    const markerRow = globalShipMarkersCache.find(m => m.squadron_id === squadronId && m.is_strike_craft);

    await db.from('ship_markers').delete().eq('squadron_id', squadronId);
    await db.from('combat_tracker').delete().eq('squadron_id', squadronId);

    if (markerRow && typeof window.removeBattleTokenByMarkerId === 'function') {
        await window.removeBattleTokenByMarkerId(markerRow.id);
    }

    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
    if (typeof loadCombatTracker === 'function') loadCombatTracker();
}

/* Craft losses (DM rule): a squadron has `count` craft sharing one HP pool
   (max_hp = per-craft HP x count). A craft is lost once its full share is
   gone: craft left = ceil(hp / per-craft HP). Losses are PERMANENT: count and
   max_hp shrink, so repairs and healing only restore the survivors.
   count_max remembers the commissioned size (set on the first loss) for the
   "3/4" label and the 30% break-off check. Dice scale with the current count. */
window.squadronPerCraftHp = function(sq) {
    if (sq && sq.count > 0 && sq.max_hp > 0) return sq.max_hp / sq.count;
    const chassis = sq && typeof STRIKE_CRAFT_DB !== 'undefined' ? STRIKE_CRAFT_DB[sq.type] : null;
    return chassis ? (chassis.base_hp || 0) : 0;
};
window.applySquadronLosses = function(sq) {
    if (!sq || !(sq.count > 0)) return 0;
    const per = window.squadronPerCraftHp(sq);
    if (!(per > 0)) return 0;
    const hp = Math.max(0, sq.hp || 0);
    const alive = hp <= 0 ? 0 : Math.ceil(hp / per - 1e-9);
    if (alive >= sq.count) return 0;
    const lost = sq.count - alive;
    if (!sq.count_max) sq.count_max = sq.count;
    sq.count = alive;
    sq.max_hp = Math.round(per * alive);
    sq.hp = Math.min(hp, sq.max_hp);
    return lost;
};
// Remaining strength vs the commissioned size (for the 30% break-off).
window.squadronStrengthPct = function(sq) {
    const full = window.squadronPerCraftHp(sq) * ((sq && (sq.count_max || sq.count)) || 0);
    return full > 0 ? (sq.hp || 0) / full : 1;
};
window.squadronCountLabel = function(sq) {
    if (!sq) return '0';
    return sq.count_max && sq.count_max > sq.count ? `${sq.count}/${sq.count_max}` : `${sq.count}`;
};

// A strike craft token's integrity_hull is only a spawn-time snapshot; the
// real squadron HP lives in the carrier's ship_deployed[].hp. Call this after
// damaging any target so hits on a squadron token reach the squadron record.
// No-op for non-strike-craft targets.
async function syncSquadronHpToParent(targetShip) {
    if (!targetShip.is_strike_craft || !targetShip.parent_id || !targetShip.squadron_id) return;
    const parent = globalShipMarkersCache.find(m => m.id === targetShip.parent_id);
    if (!parent) return;
    const deployed = parent.ship_deployed || [];
    const sq = deployed.find(s => s.id === targetShip.squadron_id);
    if (!sq) return;
    sq.hp = Math.max(0, Math.min(sq.max_hp, targetShip.integrity_hull));
    const lost = window.applySquadronLosses(sq);
    await db.from('ship_markers').update({ ship_deployed: deployed }).eq('id', parent.id);
    parent.ship_deployed = deployed;
    if (lost > 0) {
        // The token's max hull shrinks with the squadron, so healing only
        // repairs the survivors.
        targetShip.max_hull = sq.max_hp;
        targetShip.integrity_hull = Math.min(targetShip.integrity_hull || 0, sq.max_hp);
        await db.from('ship_markers').update({ max_hull: targetShip.max_hull, integrity_hull: targetShip.integrity_hull }).eq('id', targetShip.id);
        await db.from('chat_logs').insert({ sender_id: null, content: `💀 [SQUADRON] ${sq.name} loses ${lost} craft — ${window.squadronCountLabel(sq)} left.`, message_type: 'system' });
    }
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
    if (!dbStats) { alert("Pick a valid chassis type first."); return; }
    
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

window.launchSquadron = async function(vesselId, idx, hideFromOverworld) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let hangar = vessel.ship_hangar || [];
    let deployed = vessel.ship_deployed || [];

    let sq = hangar.splice(idx, 1)[0];
    if (sq) {
        sq.loiter = 4;
        // DM rule: every chassis launches on 'auto' (AI re-picks its stance
        // each round, see pickSquadronAutoStance in js/battle-map.js). A
        // stance already set before recall (including 'manual') is kept.
        if (!sq.ai_stance) sq.ai_stance = 'auto';
        delete sq.ai_auto_pick; // re-evaluated fresh on the first round
        deployed.push(sq);
        await db.from('ship_markers').update({ ship_hangar: hangar, ship_deployed: deployed }).eq('id', vessel.id);
        vessel.ship_hangar = hangar;
        vessel.ship_deployed = deployed;
        window.renderVesselDeck();

        if (window.AudioEngine) window.AudioEngine.playWarp();
        await spawnSquadronToken(vessel, sq, hideFromOverworld);

        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🛫 [FLIGHT OPS] ${sq.name} launched from ${vessel.name}. Cleared hot for 4 turns.`,
            message_type: 'text'
        });

        // Also called from the Battle Map's compact hangar control, so refresh
        // that panel locally. Other clients update via the ship_markers
        // realtime channel.
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
        // Refresh the Battle Map panel too (see launchSquadron).
        if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();

        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🛬 [FLIGHT OPS] ${sq.name} recovered to ${vessel.name} hangar bay.`,
            message_type: 'text'
        });
    }
};

/* Compact LAUNCH/RECALL section for a Battle Map ship-status card, using the
   same launchSquadron/recallSquadron as the Vessel Deck. Stance, weapon and
   loiter controls stay on the Vessel Deck only. Returns '' for a vessel with
   no squadrons. idx is the raw index into ship_hangar / ship_deployed.
   Launches from here pass hideFromOverworld = true. */
window.renderCompactHangarHtml = function(vessel) {
    const hangar = vessel.ship_hangar || [];
    const deployed = vessel.ship_deployed || [];
    if (hangar.length === 0 && deployed.length === 0) return '';

    let html = '<div style="margin-top:8px; padding-top:8px; border-top:1px dashed #3c4e36;">';
    html += '<div style="font-size:9px; color:#6b826a; margin-bottom:4px;">HANGAR BAY</div>';
    hangar.forEach((sq, idx) => {
        const dbStats = STRIKE_CRAFT_DB[sq.type];
        html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 0; font-size:9px; color:#d4c5a9;">
            <span>${sq.name} <span style="color:#6b826a;">${dbStats ? dbStats.label : sq.type} x${window.squadronCountLabel(sq)}</span></span>
            <button class="layer-edit" onclick="window.launchSquadron('${vessel.id}', ${idx}, true)" style="padding:2px 8px; font-size:8px; border-color:#00e1ff; color:#00e1ff;">🚀 LAUNCH</button>
        </div>`;
    });
    deployed.forEach((sq, idx) => {
        const dbStats = STRIKE_CRAFT_DB[sq.type];
        html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 0; font-size:9px; color:#ffaa00;">
            <span>🛫 ${sq.name} <span style="color:#6b826a;">${dbStats ? dbStats.label : sq.type} x${window.squadronCountLabel(sq)} · HP ${sq.hp}/${sq.max_hp}</span></span>
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

// --- Squadron target-scoping, AI stance, weapon fire & ordnance ---

/* Weapon-select onchange for the manual FIRE row: rebuilds the target list
   for the newly selected weapon's range, measured from the squadron's own
   battle token (not the carrier's), same as renderVesselDeck (js/combat.js).
   Fails open to every other visible ship if there's no scoping function or
   no token. Also toggles FIRE vs LAUNCH and the cooldown badge. */
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
    const scoped = (sqShipSelf && typeof window.getBattleScopedTargets === 'function') ? window.getBattleScopedTargets(sqShipSelf.id, wpn ? wpn.range : 0, { firerVessel: sqShipSelf, wpn: wpn }) : null;
    // Fallback list still hides ships this viewer can't see (Fog of War).
    const candidates = scoped || globalShipMarkersCache.filter(m => m.id !== vesselId && (typeof window.isVesselVisibleToMe !== 'function' || window.isVesselVisibleToMe(m)));

    const prevValue = targetSelect.value;
    let targetOptions = '<option value="">-- Target --</option>';
    candidates.forEach(m => { targetOptions += `<option value="${m.id}">${m.is_strike_craft ? '🛩️ ' : ''}${m.name}</option>`; });
    targetSelect.innerHTML = targetOptions;
    if (prevValue && candidates.some(m => m.id === prevValue)) targetSelect.value = prevValue;

    // Ordnance weapons show LAUNCH instead of FIRE.
    const fireBtn = document.getElementById(`sq-fire-btn-${vesselId}-${sqIdx}`);
    const launchBtn = document.getElementById(`sq-launch-btn-${vesselId}-${sqIdx}`);
    if (fireBtn && launchBtn) {
        const isOrdnance = !!(wpn && wpn.weapon_class === 'ordnance');
        fireBtn.style.display = isOrdnance ? 'none' : '';
        launchBtn.style.display = isOrdnance ? '' : 'none';
    }

    // Cooldown badge for the selected weapon.
    const cdBadge = document.getElementById(`sq-cooldown-badge-${vesselId}-${sqIdx}`);
    if (cdBadge) {
        const cdNow = (sq.weapon_cooldowns && sq.weapon_cooldowns[wpnSelect.value]) || 0;
        cdBadge.textContent = `CD:${cdNow}`;
        cdBadge.style.display = cdNow > 0 ? '' : 'none';
    }
};

// Sets a deployed squadron's AI stance ('' = manual). Non-manual stances
// are resolved each Advance Round in window.processBattleRoundAutomations
// (js/battle-map.js).
window.setSquadronAIStance = async function(vesselId, sqIdx, stance) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let sq = (vessel.ship_deployed || [])[sqIdx];
    if (!sq) return;
    sq.ai_stance = stance || '';
    await db.from('ship_markers').update({ ship_deployed: vessel.ship_deployed }).eq('id', vessel.id);
    window.renderVesselDeck();
};

/* DOM-independent squadron shot: dice, damage, persistence and broadcast.
   Used by both the manual FIRE button (window.rollSquadronWeapon) and AI
   stance fire in processBattleRoundAutomations, so there is one damage path.
   opts.auto: skip silently instead of alerting/confirming, skip the AP
   spend, and tag the chat broadcast as [AI STANCE]. Dice scale with sq.count. */
window.resolveSquadronWeaponFire = async function(vesselId, sqIdx, wpnIdx, targetId, opts) {
    opts = opts || {};
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let sq = (vessel.ship_deployed || [])[sqIdx];
    if (!sq) return;

    let dbStats = window.getStrikeCraftStats(sq.type);
    let wpn = dbStats.weapons[wpnIdx];
    if (!wpn) return;

    // Cooldown: AI fire skips; manual fire warns and allows an override.
    // Cooldowns live on the squadron (sq.weapon_cooldowns), not the shared
    // catalog entry.
    const wpnCooldownNow = (sq.weapon_cooldowns && sq.weapon_cooldowns[wpnIdx]) || 0;
    if (wpnCooldownNow > 0) {
        if (opts.auto) return;
        if (!(await window.showConfirmModal(`[WARNING] ${wpn.name} is on cooldown (${wpnCooldownNow} more turn(s))! Firing will OVERRIDE. Proceed?`))) return;
    }

    // Squadrons fire from their own battle token, not the carrier's.
    // May be undefined; the gates below fail open without it.
    const sqShipSelf = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);

    // Weapons-disabled (EMP) gate, checked on the squadron's own token.
    if (sqShipSelf && sqShipSelf.disabled_weapons_until > 0) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[WEAPONS DISABLED] ${sq.name}'s weapons are offline for ${sqShipSelf.disabled_weapons_until} more round(s).`);
        return;
    }

    // Range re-check against current token positions (either side may have
    // moved since the dropdown was built). The AI path already range-gates
    // before calling, so for it this is a silent safety net. Fails open if
    // either position is unknown.
    if (targetId) {
        const selfPos = sqShipSelf ? window.getBattleTokenPosition(sqShipSelf.id) : null;
        const targetPosForRange = window.getBattleTokenPosition(targetId);
        const targetShipForAlert = globalShipMarkersCache.find(m => m.id === targetId);
        // getEffectiveWeaponRange (js/battle-map.js) applies the
        // strike-craft-vs-capital short-range cap and the Messenger uplink
        // exception; same rule as the AI path.
        const effRange = (typeof window.getEffectiveWeaponRange === 'function') ? window.getEffectiveWeaponRange(wpn, sqShipSelf, targetShipForAlert) : wpn.range;
        if (effRange && selfPos && targetPosForRange && Math.hypot(targetPosForRange.x - selfPos.x, targetPosForRange.y - selfPos.y) > effRange) {
            if (opts.auto) return;
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`[OUT OF RANGE] ${targetShipForAlert ? targetShipForAlert.name : 'Target'} is beyond ${wpn.name}'s range (${effRange}).`);
            return;
        }
        // Terrain rules: planet/station in the way, nebula shroud.
        const sqTerrain = (sqShipSelf && typeof window.terrainFireCheck === 'function') ? window.terrainFireCheck(sqShipSelf.id, targetId) : '';
        if (sqTerrain) {
            if (opts.auto) return;
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`[NO SHOT] ${targetShipForAlert ? targetShipForAlert.name : 'Target'}: ${sqTerrain}.`);
            return;
        }
    }

    // Manual shots cost 1 AP from the squadron's own initiative slot. Spent
    // only after every refusal gate has passed. No token = no AP gate.
    if (!opts.auto && sqShipSelf && typeof window.spendTokenAp === 'function' && !window.spendTokenAp(sqShipSelf.id, 1)) return;

    let volleys = sq.count;
    if (volleys <= 0) return;

    // Shot committed: start the cooldown (replaces, doesn't stack).
    if (wpn.cooldown_period > 0) {
        sq.weapon_cooldowns = sq.weapon_cooldowns || {};
        sq.weapon_cooldowns[wpnIdx] = wpn.cooldown_period;
    }

    // Firing reveals a hidden squadron token. Best-effort; never blocks the shot.
    try { if (typeof window.revealVesselIfHidden === 'function' && sqShipSelf) await window.revealVesselIfHidden(sqShipSelf); } catch (err) { console.error('resolveSquadronWeaponFire: reveal-on-fire failed', err); }

    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = (wpn.dice || '').trim().match(diceRegex);
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
    // Hidden calibration bonus (see js/combat.js).
    if (dmgType !== 'Healing' && typeof window.hiddenDamageBonus === 'function') total += window.hiddenDamageBonus(numDice, diceFaces);

    if (targetId) {
        targetShip = globalShipMarkersCache.find(m => m.id === targetId);
        if (targetShip) {
            const tSt = window.applyStanceToDamage(total, targetShip.ship_stance || 'Balanced', dmgType, 'target');
            total = tSt.total; combatLog += tSt.tag;
            const sqCover = (dmgType !== 'Healing' && typeof window.terrainCover === 'function') ? window.terrainCover(targetId) : null; // asteroid cover
            if (sqCover) { total = Math.floor(total * sqCover.mult); combatLog += sqCover.label; }

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

            // Directional armor: hits the side facing the squadron's own token.
            const result = window.resolveShipDamage(targetShip, dmgType, total, (typeof window.damageSideOpts === 'function' && sqShipSelf) ? window.damageSideOpts(targetShip, { vesselId: sqShipSelf.id }) : undefined);
            combatLog += result.log;
            const sideFields = typeof window.armorSideResultFields === 'function' ? window.armorSideResultFields(result) : {};

            await db.from('ship_markers').update({
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened, ...sideFields
            }).eq('id', targetShip.id);
            Object.assign(targetShip, {
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened, ...sideFields
            });
            await syncSquadronHpToParent(targetShip);

            // At 0 hull in an active battle, withdraw the target's grid token
            // (the ship_markers row is untouched). No-op outside a battle.
            if (typeof window.checkBattleTokenDestroyed === 'function') await window.checkBattleTokenDestroyed(targetShip);

            // Beam flash from the squadron's token to the target. Local-only:
            // other clients don't see it.
            if (typeof window.playWeaponFireEffect === 'function') {
                if (sqShipSelf) {
                    const beamColor = (window.DAMAGE_TYPES[dmgType] && window.DAMAGE_TYPES[dmgType].color) || '#ffaa00';
                    window.playWeaponFireEffect(sqShipSelf.id, targetShip.id, beamColor, dmgType);
                }
            }

            // "Last engaged" record; nothing currently reads it.
            sq.target_id = targetShip.id;
        }
    }

    // Persist ship_deployed if a cooldown started (even with no target) or
    // target_id changed.
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

// Manual FIRE button: reads the row's weapon/target selects and calls
// window.resolveSquadronWeaponFire.
window.rollSquadronWeapon = async function(vesselId, sqIdx) {
    let wpnIdx = document.getElementById(`sq-wpn-select-${vesselId}-${sqIdx}`).value;
    let targetId = document.getElementById(`sq-target-${vesselId}-${sqIdx}`).value;
    await window.resolveSquadronWeaponFire(vesselId, sqIdx, wpnIdx, targetId);
};

/* Squadron version of window.launchOrdnance (js/battle-map.js) for
   weapon_class:'ordnance' weapons: queues an in-flight salvo instead of
   resolving instantly. Used by the manual LAUNCH button and the AI stance
   loop (opts.auto). Falls back to resolveSquadronWeaponFire if the squadron
   has no grid token.

   DM decision: dice scale with sq.count (unlike ship ordnance). This stacks
   with the in-flight split into 6 payloads that each carry the full dice,
   so a 3-unit squadron's 2d12 becomes 6d12 before the split. */
window.launchSquadronOrdnance = async function(vesselId, sqIdx, wpnIdx, targetId, opts) {
    opts = opts || {};
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let sq = (vessel.ship_deployed || [])[sqIdx];
    if (!sq) return;

    let dbStats = window.getStrikeCraftStats(sq.type);
    let wpn = dbStats.weapons[wpnIdx];
    if (!wpn) return;

    const sqShipSelf = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);

    const selfPos = sqShipSelf ? window.getBattleTokenPosition(sqShipSelf.id) : null;
    if (!selfPos) {
        // No grid token (no active battle): resolve instantly instead.
        // resolveSquadronWeaponFire does its own gates and AP spend.
        return window.resolveSquadronWeaponFire(vesselId, sqIdx, wpnIdx, targetId, opts);
    }

    // Weapons-disabled (EMP) gate on the squadron's own token.
    if (sqShipSelf.disabled_weapons_until > 0) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[WEAPONS DISABLED] ${sq.name}'s weapons are offline for ${sqShipSelf.disabled_weapons_until} more round(s).`);
        return;
    }

    // Cooldown: AI fire skips; manual launch warns and allows an override.
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

    // Range re-check against current positions (AI path already range-gates).
    const launchEffRange = (typeof window.getEffectiveWeaponRange === 'function') ? window.getEffectiveWeaponRange(wpn, sqShipSelf, targetVessel) : wpn.range;
    if (launchEffRange && Math.hypot(targetPos.x - selfPos.x, targetPos.y - selfPos.y) > launchEffRange) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[OUT OF RANGE] ${targetVessel.name} is beyond ${wpn.name}'s range (${launchEffRange}).`);
        return;
    }
    const sqLaunchTerrain = (sqShipSelf && typeof window.terrainFireCheck === 'function') ? window.terrainFireCheck(sqShipSelf.id, targetId) : ''; // terrain line-of-fire
    if (sqLaunchTerrain) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[NO LOCK] ${targetVessel.name}: ${sqLaunchTerrain}.`);
        return;
    }

    // Manual launch costs 1 AP, spent only after all refusal gates pass.
    if (!opts.auto && typeof window.spendTokenAp === 'function' && !window.spendTokenAp(sqShipSelf.id, 1)) return;

    let volleys = sq.count;
    if (volleys <= 0) return;

    // Launch committed: start the cooldown.
    if (wpn.cooldown_period > 0) {
        sq.weapon_cooldowns = sq.weapon_cooldowns || {};
        sq.weapon_cooldowns[wpnIdx] = wpn.cooldown_period;
    }

    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = (wpn.dice || '').trim().match(diceRegex);
    if (!match) { console.error('launchSquadronOrdnance: malformed weapon dice, aborting', wpn); return; }
    let baseNumDice = parseInt(match[1]) || 1;
    let diceFaces = parseInt(match[2]);
    // ordnance_pattern 'single' multiplies dice by SINGLE_WARHEAD_DICE_MULT,
    // same as ship ordnance, on top of the unit-count scaling.
    // (Squadron ammo tiers are not supported.)
    const isSinglePattern = wpn.ordnance_pattern === 'single';
    const singleMult = isSinglePattern ? (window.SINGLE_WARHEAD_DICE_MULT || 3) : 1;
    let numDice = baseNumDice * volleys * singleMult;
    const scaledDice = `${numDice}d${diceFaces}`;

    // Firing reveals a hidden squadron token. Best-effort; never blocks the launch.
    try { if (typeof window.revealVesselIfHidden === 'function') await window.revealVesselIfHidden(sqShipSelf); } catch (err) { console.error('launchSquadronOrdnance: reveal-on-fire failed', err); }

    const ordnance = (window.globalBattleEncounterCache.in_flight_ordnance || []).slice();
    ordnance.push({
        salvo_id: (typeof genBattleTokenId === 'function') ? genBattleTokenId() : `${Date.now()}-${Math.random()}`,
        source_vessel_id: sqShipSelf.id, source_vessel_name: sq.name,
        // Launch point, so impact hits the armor side facing it.
        ...(function () { const p = typeof window.ordnanceLaunchPoint === 'function' ? window.ordnanceLaunchPoint(sqShipSelf.id) : null; return { launch_x: p ? p.x : null, launch_y: p ? p.y : null }; })(),
        source_weapon_name: wpn.name, dice: scaledDice, modifier: 0, explodes: !!wpn.explodes,
        damage_type: wpn.dmgType || 'Impact',
        target_vessel_id: targetId, target_vessel_name: targetVessel.name,
        turns_remaining: 3, split: false, ordnance_pattern: isSinglePattern ? 'single' : 'multi'
    });
    window.globalBattleEncounterCache.in_flight_ordnance = ordnance;
    await db.from('battle_encounters').update({ in_flight_ordnance: ordnance }).eq('id', window.globalBattleEncounterCache.id);

    // "Last engaged" record, informational only.
    sq.target_id = targetId;
    await db.from('ship_markers').update({ ship_deployed: vessel.ship_deployed }).eq('id', vessel.id);

    if (window.AudioEngine) window.AudioEngine.playShoot();
    const autoTag = opts.auto ? '🤖 [AI STANCE] ' : '';
    const patternTag = isSinglePattern ? ' [SINGLE WARHEAD]' : '';
    await db.from('chat_logs').insert({ sender_id: null, content: `${autoTag}☠️ [ORDNANCE]${patternTag} ${sq.name} launches ${wpn.name} (x${volleys} units) at ${targetVessel.name} — impact in 3 rounds.`, message_type: 'system' });
    window.renderVesselDeck();
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};

// Manual LAUNCH button: reads the row's selects and calls
// window.launchSquadronOrdnance.
window.launchSquadronOrdnanceFromUI = async function(vesselId, sqIdx) {
    let wpnIdx = document.getElementById(`sq-wpn-select-${vesselId}-${sqIdx}`).value;
    let targetId = document.getElementById(`sq-target-${vesselId}-${sqIdx}`).value;
    await window.launchSquadronOrdnance(vesselId, sqIdx, wpnIdx, targetId);
};

// --- Squadron Battle Map token add/remove ---

/* Called by spawnSquadronToken after the ship_markers row is inserted:
   places the squadron on the active Battle Map grid. No-op with no active
   battle; the squadron gets no grid token until recalled and relaunched
   during a battle. */
window.addSquadronToBattleMap = async function(carrierVessel, sq, markerId, tacticalSpeed) {
    if (!window.globalBattleEncounterCache) return;
    const tokens = (window.globalBattleEncounterCache.tokens || []).slice();

    // Place near the carrier's token if it's on the grid, else use the
    // standard staggered placement for new tokens.
    const carrierPos = window.getBattleTokenPosition ? window.getBattleTokenPosition(carrierVessel.id) : null;
    const pos = carrierPos
        ? clampToGrid(carrierPos.x + (Math.random() * 60 - 30), carrierPos.y + (Math.random() * 60 - 30))
        : staggeredTokenPos(tokens.length);

    tokens.push({ token_id: genBattleTokenId(), ship_marker_id: markerId, x: pos.x, y: pos.y, move_remaining: tacticalSpeed ?? 160 });
    await saveBattleTokens(tokens);
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};

/* Called by despawnSquadronToken (recall or destroyed) to remove the grid
   token. No confirm dialog; the triggering action was already confirmed.
   No-op with no active battle or no matching token. */
window.removeBattleTokenByMarkerId = async function(markerId) {
    if (!window.globalBattleEncounterCache) return;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const tok = tokens.find(t => t.ship_marker_id === markerId);
    if (!tok) return;
    await saveBattleTokens(tokens.filter(t => t.token_id !== tok.token_id));
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};
