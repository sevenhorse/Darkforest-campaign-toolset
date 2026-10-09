/* ==========================================================================
   js/map.js - Cartography, Map Tools, & FOW Engine
   ========================================================================== */

window.camera = { x: 0, y: 0, zoom: 0.2, isDragging: false, startX: 0, startY: 0 };
window.draggedMarker = null; 
window.draggedStar = null;

window.measuringTapeActive = false; window.measureStartPoint = null; window.measureEndPoint = null;
window.pingModeActive = false; window.activePings = [];
window.jumpPlottingActive = false; window.activeJumpShip = null; window.jumpTargetPoint = null; window.selectedDriveSpeed = 250; window.selectedDriveTypeKey = 'ftl_class1';
window.territoryToolActive = false; window.territoryDrawActive = false; window.activeTerritoryVertices = [];
window.hyperlaneDrawActive = false; window.activeHyperlaneNodes = [];
window.hyperlanesVisible = true; // must be initialized, or routes stay invisible until toggled once

function stringToHash(str) { let hash = 0; for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash = hash & hash; } return Math.abs(hash); }
function mulberry32(a) { return function() { var t = a += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 8, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const planetTypes = ['Terrestrial', 'Gas Giant', 'Ice World', 'Barren Rock', 'Volcanic'];
function getPlanetColor(type, prng) {
    if(type === 'Gas Giant') return ['#c4a482', '#e3a859', '#7da2a6'][Math.floor(prng()*3)];
    if(type === 'Ice World') return ['#a4d2ed', '#e6f5ff'][Math.floor(prng()*2)];
    if(type === 'Terrestrial') return ['#4287f5', '#4bb564', '#3b7852'][Math.floor(prng()*3)];
    if(type === 'Barren Rock') return ['#8a8a8a', '#a69b8d'][Math.floor(prng()*2)];
    if(type === 'Volcanic') return ['#d1451f', '#ff5e00'][Math.floor(prng()*2)]; return '#ffffff';
}

function getPlanetResources(type, prng) {
    const rares = ['Uranium', 'Platinum', 'Dark Matter Trace', 'Neodymium', 'Promethium', 'Quantum Silicates'];
    const commons = ['Iron', 'Nickel', 'Cobalt', 'Silicon', 'Ice'];
    if (type === 'Gas Giant') return 'Hydrogen, Helium-3, Exotic Volatiles';
    if (type === 'Ice World') return 'Water Ice, Tritium, Methane';
    if (type === 'Terrestrial') return 'Organics, Carbon, ' + commons[Math.floor(prng()*commons.length)];
    if (type === 'Barren Rock') return commons[Math.floor(prng()*commons.length)] + ', ' + commons[Math.floor(prng()*commons.length)];
    if (type === 'Volcanic') return rares[Math.floor(prng()*rares.length)] + ', Basalt, Sulfur'; return 'Unknown Scans';
}

let generatedSystems = {};
// Merges DM overrides (globalPlanetaryModifiersCache) onto bodies on every
// call, outside the per-system memo, so edits always show the latest DB state.
// Returns new objects; never mutates the cached base array.
function applyPlanetaryOverrides(bodies) {
    const overrides = window.globalPlanetaryModifiersCache || {};
    // Personal labels win over the DM's custom_name, for this viewer only
    // (the cache holds only the current viewer's rows; see loadPersonalLabels in js/db.js).
    const personalLabels = window.globalPersonalLabelsCache || {};
    return bodies.map(b => {
        const o = overrides[b.id];
        const personalName = personalLabels[`body:${b.id}`];
        if (!o && !personalName) return b;
        return { ...b,
            name: personalName ?? (o ? (o.custom_name ?? b.name) : b.name),
            type: o ? (o.custom_type ?? b.type) : b.type,
            gravity: o ? (o.custom_gravity ?? b.gravity) : b.gravity,
            atmosphere: o ? (o.custom_atmosphere ?? b.atmosphere) : b.atmosphere,
            resources: o ? (o.custom_resources ?? b.resources) : b.resources };
    });
}

// System name with the viewer's personal label applied. Used only at a few
// display sites (galaxy map star label, HUD telemetry); other reads of
// `.name` (search results, jump plotter labels, etc.) show the canonical name.
window.getDisplaySystemName = function(system) {
    if (!system) return '';
    const personalLabels = window.globalPersonalLabelsCache || {};
    return personalLabels[`system:${system.id}`] ?? system.name;
};

// Save/clear for both personal-label editors (system + body). Upserts on
// (user_id, target_type, target_id); only ever touches this viewer's own row.
window.savePersonalLabel = async function(targetType, targetId, newName) {
    const trimmed = (newName || '').trim();
    const cacheKey = `${targetType}:${targetId}`;
    if (!trimmed) {
        // Empty input clears the label back to the canonical name.
        await db.from('personal_labels').delete().eq('user_id', currentUserId).eq('target_type', targetType).eq('target_id', targetId);
        delete window.globalPersonalLabelsCache[cacheKey];
    } else {
        const { error } = await db.from('personal_labels')
            .upsert({ user_id: currentUserId, target_type: targetType, target_id: targetId, custom_name: trimmed }, { onConflict: 'user_id,target_type,target_id' });
        if (error) { alert('Failed to save personal label: ' + error.message); return; }
        window.globalPersonalLabelsCache[cacheKey] = trimmed;
    }
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};
// The one place that decides "can this system ever show orbiting bodies".
// Used by the render loop's focus, orbit-draw and click hit-test gates.
// True for every non-Nebula system, and for a Nebula-typed system that has
// custom_bodies (a custom star with the Dense Nebula hazard, not an empty
// procedural gas cloud).
function systemCanHaveBodies(s) {
    if (s.type !== 'Nebula') return true;
    return !!(s.custom_bodies && s.custom_bodies.length > 0);
}
window.getSystemBodies = function(system) { return applyPlanetaryOverrides(getSystemBodiesRaw(system)); };
function getSystemBodiesRaw(system) {
    // custom_bodies must be checked BEFORE the Nebula short-circuit: a custom
    // star with the Dense Nebula hazard also gets type 'Nebula' (derived from
    // hazard in loadGalaxyData). Procedural nebulae never have custom_bodies.
    if (system.custom_bodies && Array.isArray(system.custom_bodies) && system.custom_bodies.length > 0) { return system.custom_bodies.map((b, idx) => ({ ...b, id: b.id || `${system.id}-custom-${idx}`, baseAngle: b.baseAngle || (idx * 1.2), speed: b.speed || (0.0002 / (idx + 1)), parentSystem: system })); }
    if(system.type === 'Nebula') return [];
    if(generatedSystems[system.id]) return generatedSystems[system.id];
    
    let seed = stringToHash(system.id.toString()); let prng = mulberry32(seed); let bodies = []; let r = system.type === 'Black Hole' ? 40 : 15; 
    let multiType = system.multiType || 'Single'; 
    if (multiType === 'Binary' || multiType === 'Trinary') {
        r = 25 + prng() * 15;
        bodies.push({ id: system.id + '-B', name: system.name + ' B', isStar: true, radius: r, size: (system.size || 4) * (prng() * 0.4 + 0.4), type: 'Companion Star', baseAngle: prng() * Math.PI * 2, speed: ((prng() * 0.001) + 0.0005) * (prng() > 0.5 ? 1 : -1), color: prng() > 0.5 ? '#ffb37b' : '#7694ff', gravity: 'Stellar', atmosphere: 'Corona', resources: 'Plasma, Heat', parentSystem: system });
        if (multiType === 'Trinary') {
            r += 30 + prng() * 20;
            bodies.push({ id: system.id + '-C', name: system.name + ' C', isStar: true, radius: r, size: (system.size || 4) * (prng() * 0.3 + 0.3), type: 'Companion Star', baseAngle: prng() * Math.PI * 2, speed: ((prng() * 0.0008) + 0.0003) * (prng() > 0.5 ? 1 : -1), color: prng() > 0.5 ? '#ffe9c4' : '#ff3366', gravity: 'Stellar', atmosphere: 'Corona', resources: 'Plasma, Heat', parentSystem: system });
        }
    }
    let numPlanets = Math.floor(prng() * 5) + (system.type === 'Black Hole' ? 1 : 2); 
    for(let i=0; i<numPlanets; i++) {
        r += 25 + prng() * 30; let pType = planetTypes[Math.floor(prng() * planetTypes.length)];
        bodies.push({ id: system.id + '-p' + i, name: system.name + ' ' + (["","I","II","III","IV","V","VI","VII","VIII"][i+1] || i+1), isStar: false, radius: r, size: prng() * 1.5 + 0.8, type: pType, baseAngle: prng() * Math.PI * 2, speed: ((prng() * 0.0003) + 0.00005) * (prng() > 0.5 ? 1 : -1), color: getPlanetColor(pType, prng), gravity: (prng() * 1.8 + 0.1).toFixed(2) + ' G', atmosphere: pType === 'Barren Rock' ? 'None' : (prng()>0.5 ? 'Toxic' : 'Breathable'), resources: getPlanetResources(pType, prng), parentSystem: system });
    }
    generatedSystems[system.id] = bodies; return bodies;
};

/* Hazards that affect ships (see window.checkShipHazards below):
   explicit DM-placed zones (system_hazards: x/y/radius/intensity) and the
   implicit `hazard` field on star systems (Pulsar, Nebula, Gravity Well),
   which applies within a default radius centered on the star. */
window.HAZARD_IMPLICIT_RADIUS = 350;
// Explicit zone radius is clamped to this, both for the mechanical effect and
// the visual ring in drawHazardZones, so what you see matches what applies.
window.SYSTEM_HAZARD_MAX_RADIUS = window.HAZARD_IMPLICIT_RADIUS;

/* FOW ENGINE
   isPositionSensorVisible: is this point within 300 units of any owned or
   friendly ship? The DM always sees everything. Viewer-relative (evaluated
   against the current client's ships), like every FOW check here. The one
   mechanical caller (gravity-well jump inflation in js/db.js) runs on the
   jumping ship owner's client, so viewer and owner are the same there. */
window.isPositionSensorVisible = function(x, y) {
    if (currentUserRole === 'dm') return true;
    for (let m of globalShipMarkersCache) {
        if (m.docked_to) continue; // docked craft use their master's position, not their own stale coords
        if (m.hide_from_galaxy_map) continue; // Battle-Map-only ships aren't on this map, so they don't give sensor cover here
        if (window.vesselHasOwner(m, currentUserId) || m.iff === 'friendly') {
            if (Math.hypot(m.x - x, m.y - y) <= 300) return true;
        }
    }
    return false;
};
window.getFowTier = function(system) {
    if (window.scannedSystems && window.scannedSystems.includes(system.id)) return 3; // Tier 3
    return window.isPositionSensorVisible(system.x, system.y) ? 2 : 1;
};

/* --- HYPERLANE DISCOVERY (persistent Fog of War for trade routes) ---
   Unlike hazards/tier-2 systems (live sensor range only), route nodes stay
   revealed once discovered, like scanned systems. Discovery is automatic:
   the first render pass where a node is within sensor range marks it.
   Stored per browser in localStorage, not DB-synced. */
window.discoveredHyperlaneNodes = new Set(window.safeJsonParse(window.safeLocalGet('odyssey_discovered_hyperlane_nodes', '[]'), []));
// Nodes normally carry a stable id (genHyperlaneNodeId). Legacy deep-space
// nodes may not; they fall back to a route+index key, which breaks if the
// route is reordered. Re-saving a route via startEditHyperlane assigns real ids.
function hyperlaneNodeKey(route, node, index) { return node.id || (route.id + '-n' + index); }
function updateHyperlaneDiscovery() {
    // Skipped for the DM: isPositionSensorVisible is always true for the DM,
    // so running this would mark every node discovered in this browser's
    // localStorage, leaking to any player later using the same browser.
    // DM omniscience is handled on the read side in render().
    if (currentUserRole === 'dm') return;
    let changed = false;
    globalHyperlanesCache.forEach(route => {
        (route.nodes || []).forEach((node, idx) => {
            const key = hyperlaneNodeKey(route, node, idx);
            if (!window.discoveredHyperlaneNodes.has(key) && window.isPositionSensorVisible(node.x, node.y)) {
                window.discoveredHyperlaneNodes.add(key);
                changed = true;
            }
        });
    });
    if (changed) window.safeLocalSet('odyssey_discovered_hyperlane_nodes', JSON.stringify([...window.discoveredHyperlaneNodes]));
}

/* --- FOW RESET SYNC (DM Maintenance panel) ---
   Scanned systems and discovered hyperlane nodes live only in each
   browser's localStorage, so the DM can't clear them directly.
   fow_reset_state is a singleton row (id=1, realtime, like campaign_clock)
   holding reset_epoch, a counter the DM bumps. Every client compares it to
   its own last-applied epoch (localStorage) at login and via realtime, and
   wipes its local FOW state when it sees a newer one.
   DM decision: one action clears both scans and hyperlanes, for every
   player at once, live for anyone online. No other data is touched. */
window.applyFowResetIfNewer = function(serverEpoch) {
    const localEpoch = parseInt(window.safeLocalGet('odyssey_fow_reset_epoch', null) || '0');
    if (!(serverEpoch > localEpoch)) return;
    window.scannedSystems = [];
    window.discoveredHyperlaneNodes = new Set();
    window.safeLocalSet('odyssey_scanned', '[]');
    window.safeLocalSet('odyssey_discovered_hyperlane_nodes', '[]');
    window.safeLocalSet('odyssey_fow_reset_epoch', String(serverEpoch));
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};

window.initFowResetSync = async function() {
    try {
        const { data } = await db.from('fow_reset_state').select('reset_epoch').eq('id', 1).maybeSingle();
        if (data) window.applyFowResetIfNewer(data.reset_epoch);
    } catch (e) { /* table unreachable this load -- next login/realtime message catches up */ }

    db.channel('fow_reset_state_stream')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'fow_reset_state' }, (payload) => {
            if (!payload.new) return;
            window.applyFowResetIfNewer(payload.new.reset_epoch);
        })
        .subscribe();
};

window.resetFowForAllPlayers = async function() {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Reset Fog of War for ALL players? Every DRADIS-scanned system and every discovered hyperlane route reverts to unexplored, for everyone (your own browser included). No other campaign data is touched -- ships, cargo, systems, etc. are unaffected. This cannot be undone."))) return;

    const { data: current, error: readError } = await db.from('fow_reset_state').select('reset_epoch').eq('id', 1).maybeSingle();
    if (readError) { alert("Failed to reset FOW: " + readError.message); return; }
    const newEpoch = (current ? current.reset_epoch : 0) + 1;

    const { error } = await db.from('fow_reset_state').update({ reset_epoch: newEpoch, updated_at: new Date().toISOString(), updated_by: currentUserId }).eq('id', 1);
    if (error) { alert("Failed to reset FOW: " + error.message); return; }

    // Apply locally now rather than waiting for the realtime round-trip.
    window.applyFowResetIfNewer(newEpoch);

    db.from('chat_logs').insert({ sender_id: currentUserId, content: `🌫️ [FOG OF WAR RESET] Overseer wiped all DRADIS scans and discovered hyperlane routes back to unexplored, for everyone.`, message_type: 'text' });
    alert("Fog of War reset — every connected player's map just went dark, and anyone logging in later starts fresh too.");
};

/* --- SYSTEM HAZARD ENGINE ---
   Hazards respect Fog of War: a zone or a system's implicit hazard only
   affects a ship if the zone/system location is within sensor range
   (isPositionSensorVisible). Returns a list of hit descriptors. */
window.checkShipHazards = function(shipMarker) {
    if (!shipMarker) return [];
    let hits = [];

    // Cheap distance test first; the sensor test loops every ship and this
    // runs per ship per frame.
    (window.globalSystemHazardsCache || []).forEach(hz => {
        const r = Math.min(hz.radius || 300, window.SYSTEM_HAZARD_MAX_RADIUS);
        let dist = Math.hypot(shipMarker.x - hz.x, shipMarker.y - hz.y);
        if (dist > r) return;
        if (!window.isPositionSensorVisible(hz.x, hz.y)) return;
        hits.push({ type: hz.hazard_type, intensity: hz.intensity || 1, radius: r, source: 'zone', distance: dist });
    });

    const allSystems = (globalProceduralSystemsCache || []).concat(globalDbSystemsCache || []);
    allSystems.forEach(s => {
        if (!s.hazard || s.hazard === 'None') return;
        let dist = Math.hypot(shipMarker.x - s.x, shipMarker.y - s.y);
        if (dist > window.HAZARD_IMPLICIT_RADIUS) return;
        if (!window.isPositionSensorVisible(s.x, s.y)) return;
        hits.push({ type: s.hazard.toLowerCase().replace(/\s+/g, '_'), intensity: 1, radius: window.HAZARD_IMPLICIT_RADIUS, source: 'system', systemName: s.name, distance: dist });
    });

    return hits;
};

/* DB SYNC & WIPES */
window.wipeGalaxySlate = async function() {
    if (currentUserRole !== 'dm') return; if (!(await window.showConfirmModal("Wipe all custom stars, ships, and territories?"))) return;
    await db.from('star_systems').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('ship_markers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('territories').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    window.selectedTarget = null; if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

// Called from many places (every ship_markers realtime event, every save).
// Coalesced (window.coalesceAsync, js/db.js) so overlapping runs can't land
// out of order: at most one fetch in flight plus one trailing refresh.
// Callers that `await` it get data at least as fresh as their own change.
window.loadGalaxyData = window.coalesceAsync(async function() {
    const { data: starData } = await db.from('star_systems').select('*');
    if (starData) globalDbSystemsCache = starData.map(s => ({ ...s, isCustom: true, size: s.size || 5.0, type: s.luminosity === 'Black Hole' ? 'Black Hole' : (s.hazard === 'Nebula' ? 'Nebula' : 'Star'), multiType: s.multiType || 'Single', custom_bodies: s.custom_bodies || [] }));
    const { data: markerData } = await db.from('ship_markers').select('*');
    if (markerData) globalShipMarkersCache = markerData.map(m => ({ ...m, cargo_inventory: window.sanitizeCargo ? window.sanitizeCargo(m.cargo_inventory) : (m.cargo_inventory || {}), ship_weapons: m.ship_weapons || [], ship_decks: m.ship_decks || [] }));
    // Every custom star create/edit/delete reloads here, so the tracker
    // re-renders here rather than at each call site.
    if (typeof window.renderDmCustomStarsList === 'function') window.renderDmCustomStarsList();
    // Battle-map fog of war (js/battle-map.js): re-fetch battle tokens if a ship
    // just became visible to this player. First call after login only seeds.
    if (markerData && typeof window.battleFogCheckReveal === 'function') window.battleFogCheckReveal();
    // The caches are rebuilt as new objects; re-point the selected target and
    // active jump ship at the fresh copies so the HUD doesn't go stale.
    const freshOf = (t) => {
        if (!t || !t.data || t.data.id === undefined) return null;
        if (t.type === 'ship') return globalShipMarkersCache.find(m => m.id === t.data.id) || null;
        if (t.type === 'star' && t.data.isCustom) return globalDbSystemsCache.find(x => x.id === t.data.id) || null;
        return null;
    };
    const freshSel = freshOf(window.selectedTarget);
    if (freshSel && !window.draggedMarker && !window.draggedStar) window.selectedTarget = { type: window.selectedTarget.type, data: freshSel };
    if (window.activeJumpShip) {
        const freshJump = globalShipMarkersCache.find(m => m.id === window.activeJumpShip.id);
        if (freshJump) window.activeJumpShip = freshJump;
    }
});

/* --- CUSTOM STAR TRACKER (DM Operations > SPAWN tab) ---
   DM-only searchable list of custom stars (procedural stars excluded).
   LOCATE selects the star the same way a map click does, so the Overseer
   Star Editor appears in Telemetry. This list is a finder, not an editor. */
window.renderDmCustomStarsList = function() {
    const container = document.getElementById('dm-custom-stars-list-container');
    if (!container) return;
    if (currentUserRole !== 'dm') { container.innerHTML = ''; return; }

    const searchEl = document.getElementById('dm-custom-stars-search');
    const term = searchEl ? searchEl.value.trim().toLowerCase() : '';
    const allCustom = (globalDbSystemsCache || []).filter(s => s.isCustom);
    const filtered = (term ? allCustom.filter(s => (s.name || '').toLowerCase().includes(term)) : allCustom)
        .slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (allCustom.length === 0) {
        container.innerHTML = '<span style="font-size:9px; color:#6b826a;">No custom stars placed yet -- use SYSTEM ARCHITECT above to create one.</span>';
        return;
    }
    if (filtered.length === 0) {
        container.innerHTML = `<span style="font-size:9px; color:#6b826a;">No custom stars match "${searchEl.value.trim()}".</span>`;
        return;
    }

    container.innerHTML = filtered.map(s => `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:3px 2px; border-bottom:1px solid #1a2419;">
            <div style="min-width:0;">
                <strong style="color:#00e5a3; font-size:10px;">${s.type === 'Black Hole' ? '🕳️' : '⭐'} ${s.name}</strong>
                <div style="font-size:8px; color:#6b826a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${s.luminosity || 'Standard'} · ${s.ownership || 'Unclaimed'}</div>
            </div>
            <button class="btn-reveal" onclick="window.locateCustomStar('${s.id}')" style="width:auto; margin:0; padding:3px 6px; font-size:8px; flex-shrink:0;">🎯 LOCATE</button>
        </div>`).join('');
};

window.locateCustomStar = function(id) {
    if (currentUserRole !== 'dm') return;
    const s = (globalDbSystemsCache || []).find(x => x.id === id && x.isCustom);
    if (!s) return;
    window.selectedTarget = { type: 'star', data: s };
    if (typeof window.lockCameraOnSelected === 'function') window.lockCameraOnSelected();
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    if (window.AudioEngine) window.AudioEngine.playPing();
};

/* SYSTEM ARCHITECT */
let architectPlanets = [];
// Opens with a fresh system: resets fields and re-renders the planet list.
// The re-render matters: stale rows would keep onchange handlers indexing
// into the now-empty architectPlanets and throw on edit.
window.openSystemArchitect = function() {
    if (currentUserRole !== 'dm') return;
    architectPlanets = [];
    document.getElementById('arch-name').value = 'Tartarus Prime';
    document.getElementById('arch-multi').value = 'Single';
    document.getElementById('arch-lum').value = 'Class G (Yellow)';
    document.getElementById('arch-hazard').value = 'None';
    window.renderArchitectPlanets();
    document.getElementById('system-architect-modal').style.display = 'flex';
};
window.closeSystemArchitect = function() { document.getElementById('system-architect-modal').style.display = 'none'; };
window.architectClassChanged = function(val) { if (val === 'Black Hole') document.getElementById('arch-hazard').value = 'Gravity Well'; };
window.addArchitectPlanetRow = function() { let count = architectPlanets.length + 1; architectPlanets.push({ name: `Planet ${count}`, type: 'Terrestrial', gravity: '1.0 G', atmosphere: 'Breathable', resources: 'Unknown', radius: 20 + count * 25, size: 1.6, color: '#4287f5' }); window.renderArchitectPlanets(); };
window.removeArchitectPlanetRow = function(idx) { architectPlanets.splice(idx, 1); window.renderArchitectPlanets(); };
window.renderArchitectPlanets = function() {
    const cont = document.getElementById('arch-planets-container'); if (!cont) return;
    if (architectPlanets.length === 0) { cont.innerHTML = `<span style="font-size:10px; color:#6b826a;">No custom planets added.</span>`; return; }
    let html = '';
    architectPlanets.forEach((p, idx) => {
        html += `<div style="background:#030403; border:1px solid #3c4e36; padding:6px; border-radius:2px; font-size:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <input type="text" value="${p.name}" onchange="architectPlanets[${idx}].name=this.value" style="font-size:10px; padding:2px; width:140px; margin:0;">
                    <select onchange="architectPlanets[${idx}].type=this.value; architectPlanets[${idx}].color=getPlanetColor(this.value, Math.random); window.renderArchitectPlanets();" style="font-size:10px; margin:0; width:110px;">
                        <option value="Terrestrial" ${p.type==='Terrestrial'?'selected':''}>Terrestrial</option><option value="Gas Giant" ${p.type==='Gas Giant'?'selected':''}>Gas Giant</option>
                        <option value="Ice World" ${p.type==='Ice World'?'selected':''}>Ice World</option><option value="Barren Rock" ${p.type==='Barren Rock'?'selected':''}>Barren Rock</option>
                        <option value="Volcanic" ${p.type==='Volcanic'?'selected':''}>Volcanic</option>
                    </select>
                    <button class="layer-del" onclick="window.removeArchitectPlanetRow(${idx})" style="padding:1px 5px; font-size:9px;">✕</button>
                </div>
                <div style="display:flex; gap:6px;">
                    <input type="text" placeholder="Gravity" value="${p.gravity}" onchange="architectPlanets[${idx}].gravity=this.value" style="font-size:9px; padding:2px; flex:1; margin:0;">
                    <input type="text" placeholder="Atmosphere" value="${p.atmosphere}" onchange="architectPlanets[${idx}].atmosphere=this.value" style="font-size:9px; padding:2px; flex:1; margin:0;">
                    <input type="text" placeholder="Resource Scans" value="${p.resources}" onchange="architectPlanets[${idx}].resources=this.value" style="font-size:9px; padding:2px; flex:2; margin:0;">
                </div></div>`;
    });
    cont.innerHTML = html;
};

/* OVERSEER STAR EDITOR — Planet Manifest (edit an existing custom star).
   Separate state from System Architect's create-only architectPlanets.
   Holds the in-progress edit for the selected custom star and is reset only
   when the selected star's id changes, so typing survives HUD re-renders. */
let editingStarBodyId = null; let editingStarBodies = [];
window.addEditStarPlanetRow = function() { let count = editingStarBodies.length + 1; editingStarBodies.push({ name: `Planet ${count}`, type: 'Terrestrial', gravity: '1.0 G', atmosphere: 'Breathable', resources: 'Unknown', radius: 20 + count * 25, size: 1.6, color: '#4287f5' }); window.renderEditStarPlanets(); };
window.removeEditStarPlanetRow = function(idx) { editingStarBodies.splice(idx, 1); window.renderEditStarPlanets(); };
window.buildEditStarPlanetsHtml = function() {
    if (editingStarBodies.length === 0) { return `<span style="font-size:10px; color:#6b826a;">No custom planets.</span>`; }
    let html = '';
    editingStarBodies.forEach((p, idx) => {
        // DM decision: removing a row and saving discards its scan override
        // (planetary_modifiers, keyed by body_id); editing in place keeps it.
        // This warning is the only signal; there is no confirmation dialog.
        const hasOverride = !!(p.id && window.globalPlanetaryModifiersCache && window.globalPlanetaryModifiersCache[p.id]);
        html += `<div style="background:#030403; border:1px solid #3c4e36; padding:6px; border-radius:2px; font-size:10px; margin-top:4px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <input type="text" value="${p.name}" onchange="editingStarBodies[${idx}].name=this.value" style="font-size:10px; padding:2px; width:140px; margin:0;">
                    <select onchange="editingStarBodies[${idx}].type=this.value; editingStarBodies[${idx}].color=getPlanetColor(this.value, Math.random); window.renderEditStarPlanets();" style="font-size:10px; margin:0; width:110px;">
                        <option value="Terrestrial" ${p.type==='Terrestrial'?'selected':''}>Terrestrial</option><option value="Gas Giant" ${p.type==='Gas Giant'?'selected':''}>Gas Giant</option>
                        <option value="Ice World" ${p.type==='Ice World'?'selected':''}>Ice World</option><option value="Barren Rock" ${p.type==='Barren Rock'?'selected':''}>Barren Rock</option>
                        <option value="Volcanic" ${p.type==='Volcanic'?'selected':''}>Volcanic</option>
                    </select>
                    <button class="layer-del" onclick="window.removeEditStarPlanetRow(${idx})" style="padding:1px 5px; font-size:9px;">✕</button>
                </div>
                <div style="display:flex; gap:6px;">
                    <input type="text" placeholder="Gravity" value="${p.gravity}" onchange="editingStarBodies[${idx}].gravity=this.value" style="font-size:9px; padding:2px; flex:1; margin:0;">
                    <input type="text" placeholder="Atmosphere" value="${p.atmosphere}" onchange="editingStarBodies[${idx}].atmosphere=this.value" style="font-size:9px; padding:2px; flex:1; margin:0;">
                    <input type="text" placeholder="Resource Scans" value="${p.resources}" onchange="editingStarBodies[${idx}].resources=this.value" style="font-size:9px; padding:2px; flex:2; margin:0;">
                </div>${hasOverride ? `<div style="font-size:8px; color:#ffaa00; margin-top:3px;">⚠ has a saved scan override — removing this row and saving will discard it</div>` : ''}</div>`;
    });
    return html;
};
window.renderEditStarPlanets = function() { const cont = document.getElementById('edit-star-planets-container'); if (cont) cont.innerHTML = window.buildEditStarPlanetsHtml(); };

window.commitArchitectSystem = async function() {
    if (currentUserRole !== 'dm') return;
    const name = document.getElementById('arch-name').value || 'Target System'; const luminosity = document.getElementById('arch-lum').value; const multiType = document.getElementById('arch-multi').value; const hazard = document.getElementById('arch-hazard').value;
    let color = '#ffe9c4'; if (luminosity === 'Class M (Red Dwarf)') color = '#ffb37b'; if (luminosity === 'Class O (Blue Giant)') color = '#7694ff'; if (luminosity === 'Black Hole') color = '#000000'; if (luminosity === 'Hidden Anomaly') color = '#ff3333';
    let customBodiesClean = architectPlanets.map((p, idx) => ({ ...p, isStar: false, radius: 25 + (idx + 1) * 30, baseAngle: idx * 1.25, speed: 0.0002 / (idx + 1) }));
    const payload = { name, x: -window.camera.x / window.camera.zoom, y: -window.camera.y / window.camera.zoom, size: luminosity === 'Black Hole' ? 7.0 : 5.0, color, luminosity, multiType, hazard, ownership: 'Unclaimed', control: 'Uncontested', industry_tier: 1, custom_bodies: customBodiesClean };
    // Surface insert errors (e.g. missing columns); otherwise the modal would
    // close as if the star had been created.
    const { error } = await db.from('star_systems').insert(payload);
    if (error) { alert("Failed to create star system: " + error.message); return; }
    window.closeSystemArchitect(); if(typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
};

window.spawnTokenAtCenter = async function() {
    const driveType = document.getElementById('dm-tool-drivetype').value || 'ftl_class1'; 
    const name = document.getElementById('dm-tool-name').value || 'Task Force Black'; 
    const iffStatus = document.getElementById('dm-tool-iff') ? document.getElementById('dm-tool-iff').value : 'friendly';

    let isJupiter = false;
    if (name.toLowerCase().includes("task force black") || name.toLowerCase().includes("horizon")) {
        isJupiter = await window.showConfirmModal(`Deploy '${name}' as a Jupiter-Class Heavy Cruiser? (Auto-fills weapons, health, and decks)`);
    }

    let newCargo = typeof window.sanitizeCargo === 'function' ? window.sanitizeCargo({}) : {};

    // IFF lives in the ship_markers.iff column (canonical), not cargo_inventory.
    let payload = { owner_ids: [currentUserId], name: name, drive_type: driveType, iff: iffStatus, x: -window.camera.x / window.camera.zoom, y: -window.camera.y / window.camera.zoom, color: (typeof window.getIffColor === 'function' ? window.getIffColor(iffStatus) : '#00e1ff'), cargo_inventory: newCargo };

    if (isJupiter) {
        payload.integrity_shields = 400; payload.max_shields = 400;
        payload.integrity_hull = 300; payload.max_hull = 300;
        payload.integrity_reactive = 10; payload.max_reactive = 10;
        payload.integrity_ablative = 10; payload.max_ablative = 10;
        payload.integrity_hardened = 15; payload.max_hardened = 15;
        // Jupiter Heavy Cruiser preset, from the DM's paper stat sheet.
        // - damage_type: one per weapon (the paper lists two; engine supports one).
        // - gun_count matches the paper's mount/tube counts (DM-confirmed).
        // - cooldown_period: "every turn" -> 0, "every other turn" -> 1,
        //   "once every N turns" -> N-1.
        // - range: short=300, medium=450, long=650, ordnance long=700. Dual-band
        //   weapons use the higher band (placeholder, not DM-confirmed per weapon).
        // - EMP Cannon: Ion damage type covers "bypasses armor"; system_lockdown
        //   is d20 vs DC16, fail = one random system disabled 1d4 rounds (strike
        //   craft/Escort: all three systems disabled permanently, no check);
        //   self_damage_on_consecutive_fire = 1d4 Heat if fired two rounds running.
        // - aoe_radius splash (100px) on Capitol Killer Tubes only, not Flak Guns (DM rule).
        // - Not included: the paper's embarked air group (12 Raven, 12 Hawk,
        //   48 Messenger, 48 "Messenger Gunship", the last not a STRIKE_CRAFT_DB type).
        payload.ship_weapons = [
            { loc: "Primary", name: "Gauss Cannons", dice: "1d10", modifier: "+0", explodes: false, ammo: 10, max_ammo: 10, cooldown: 0, overheat: 0, cooldown_period: 0, gun_count: 32, damage_type: "Piercing", range: 450 },
            { loc: "Turrets", name: "Dual Railguns", dice: "1d20", modifier: "+0", explodes: false, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0, cooldown_period: 1, gun_count: 12, damage_type: "Piercing", range: 650 },
            { loc: "Spinal", name: "Gamma Lance", dice: "1d20", modifier: "+0", explodes: true, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0, cooldown_period: 4, gun_count: 2, damage_type: "Energy", range: 650 },
            { loc: "Tubes", name: "Ship Killer Tubes", dice: "1d12", modifier: "+0", explodes: false, ammo: 48, max_ammo: 48, cooldown: 0, overheat: 0, cooldown_period: 3, gun_count: 48, damage_type: "Explosive", weapon_class: "ordnance", range: 700 },
            { loc: "Tubes", name: "Capitol Killer Tubes", dice: "1d20", modifier: "+0", explodes: false, ammo: 24, max_ammo: 24, cooldown: 0, overheat: 0, cooldown_period: 5, gun_count: 24, damage_type: "Antimatter", weapon_class: "ordnance", range: 700, aoe_radius: 100 },
            { loc: "PDC", name: "PDC Grid", dice: "1d4", modifier: "+0", explodes: false, ammo: 12, max_ammo: 12, cooldown: 0, overheat: 0, cooldown_period: 0, gun_count: 36, damage_type: "Flak", is_point_defense: true, range: 300 },
            { loc: "PDL", name: "PDL Grid", dice: "1d4", modifier: "+0", explodes: false, ammo: 12, max_ammo: 12, cooldown: 0, overheat: 0, cooldown_period: 0, gun_count: 36, damage_type: "Flak", is_point_defense: true, range: 450 },
            { loc: "PDG", name: "PDG Grid", dice: "1d4", modifier: "+0", explodes: false, ammo: 10, max_ammo: 10, cooldown: 0, overheat: 0, cooldown_period: 0, gun_count: 36, damage_type: "Flak", is_point_defense: true, range: 650 },
            { loc: "Turrets", name: "Flak Guns", dice: "1d6", modifier: "+0", explodes: false, ammo: 10, max_ammo: 10, cooldown: 0, overheat: 0, cooldown_period: 0, gun_count: 12, damage_type: "Flak", range: 300 },
            { loc: "Turrets", name: "Rapid Plasma Repeaters", dice: "1d12", modifier: "+0", explodes: false, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0, cooldown_period: 0, gun_count: 6, damage_type: "Heat", range: 450 },
            { loc: "Spinal", name: "Thanix Enforcer", dice: "2d20", modifier: "+5", explodes: true, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0, cooldown_period: 4, gun_count: 2, damage_type: "Antimatter", range: 650 },
            { loc: "Spinal", name: "Spinal EMP Cannon", dice: "2d12", modifier: "+0", explodes: false, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0, cooldown_period: 0, gun_count: 1, damage_type: "Ion", range: 650, system_lockdown: { checkDC: 16 }, self_damage_on_consecutive_fire: { dice: '1d4', damage_type: 'Heat' } }
        ];
        payload.ship_decks = [
            { name: "Bridge / CIC", hp: 100, max_hp: 100, type: "bridge", boarding_status: "secure" },
            { name: "Engineering / Core", hp: 150, max_hp: 150, type: "engineering", boarding_status: "secure" },
            { name: "Life Support", hp: 100, max_hp: 100, type: "life_support", boarding_status: "secure" },
            { name: "Flight Deck / Hangars", hp: 120, max_hp: 120, type: "hangar", boarding_status: "secure" },
            { name: "Manufacturing", hp: 100, max_hp: 100, type: "manufacturing", boarding_status: "secure" }
        ];
    }
    payload.ai_controlled = currentUserRole === 'dm' && (payload.ship_weapons || []).length > 0; // playtest rebalance: armed NPC spawns default to AI
    await db.from('ship_markers').insert(payload); if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

/* --- TOOL TOGGLES --- */
window.toggleMeasuringTool = function() {
    window.measuringTapeActive = !window.measuringTapeActive;
    if(!window.measuringTapeActive) { window.measureStartPoint = null; window.measureEndPoint = null; }
    window.pingModeActive = false; window.jumpPlottingActive = false; window.territoryDrawActive = false; window.hyperlaneDrawActive = false;
    window.updateToolButtonStyles();
};

window.togglePingMode = function() {
    window.pingModeActive = !window.pingModeActive;
    window.measuringTapeActive = false; window.jumpPlottingActive = false; window.territoryDrawActive = false; window.hyperlaneDrawActive = false;
    window.updateToolButtonStyles();
};

window.toggleTerritoryTool = function() {
    if (currentUserRole !== 'dm') return; 
    window.territoryToolActive = !window.territoryToolActive;
    const panel = document.getElementById('territory-control-panel'); 
    panel.style.display = window.territoryToolActive ? 'block' : 'none';
    if (window.territoryToolActive) {
        if (typeof window.populateTerritoryFactionSelect === 'function') window.populateTerritoryFactionSelect();
        if (typeof window.renderTerritoryList === 'function') window.renderTerritoryList();
    } else { window.cancelDrawingTerritory(); }
    window.updateToolButtonStyles();
};

// Territory edit-in-place (same pattern as hyperlane editing).
// editingTerritoryId: set by startEditTerritory; null means finishActiveTerritory inserts.
// editingTerritoryWasHidden: "hidden" is a '[HIDDEN] ' prefix on faction_name;
// the form shows the stripped name, so this lets a save re-apply the prefix.
window.editingTerritoryId = null;
window.editingTerritoryWasHidden = false;

/* btn-close-territory-panel is hidden during any draw/edit: it calls
   cancelDrawingTerritory and would silently discard the edit, and it is
   easily confused with "✓ CLOSE & SAVE". The DM must explicitly Cancel or Save. */

function resetTerritoryFormFields() {
    const nameEl = document.getElementById('territory-name-input'); if (nameEl) nameEl.value = '';
    const colorEl = document.getElementById('territory-color-input'); if (colorEl) colorEl.value = '#00e5a3';
    const factionEl = document.getElementById('territory-faction-select'); if (factionEl) factionEl.value = '';
}

// Does NOT reset the form: the DM may fill name/faction/color before
// clicking DRAW POLYGON. Cancel and finish already reset it.
window.startDrawingTerritory = function() { window.editingTerritoryId = null; window.editingTerritoryWasHidden = false; window.territoryDrawActive = true; window.activeTerritoryVertices = []; document.getElementById('btn-start-territory-draw').style.display = 'none'; document.getElementById('btn-finish-territory-draw').style.display = 'block'; document.getElementById('btn-cancel-territory-draw').style.display = 'block'; document.getElementById('btn-undo-territory-vertex').style.display = 'block'; document.getElementById('territory-drawing-status').style.display = 'block'; const closeBtn1 = document.getElementById('btn-close-territory-panel'); if (closeBtn1) closeBtn1.style.display = 'none'; window.updateToolButtonStyles(); };

// Loads an existing territory into the draw state for in-place editing
// (saved as an UPDATE). Does NOT touch owned_system_ids or galaxy ownership:
// Apply stays a separate explicit action, so shape changes have no effect
// on ownership until the DM hits Apply again.
window.startEditTerritory = function(territoryId) {
    if (currentUserRole !== 'dm') return;
    const t = globalTerritoriesCache.find(x => x.id === territoryId);
    if (!t) return;
    window.editingTerritoryId = territoryId;
    window.editingTerritoryWasHidden = !!(t.faction_name && t.faction_name.includes('[HIDDEN]'));
    window.activeTerritoryVertices = (t.vertices || []).map(v => ({ x: v.x, y: v.y }));
    const nameEl = document.getElementById('territory-name-input'); if (nameEl) nameEl.value = t.name || '';
    const colorEl = document.getElementById('territory-color-input'); if (colorEl) colorEl.value = t.color || '#00e5a3';
    const factionEl = document.getElementById('territory-faction-select'); if (factionEl) factionEl.value = (t.faction_name || '').replace('[HIDDEN] ', '').replace('[HIDDEN]', '');
    window.territoryDrawActive = true;
    document.getElementById('btn-start-territory-draw').style.display = 'none';
    document.getElementById('btn-finish-territory-draw').style.display = 'block';
    document.getElementById('btn-cancel-territory-draw').style.display = 'block';
    document.getElementById('btn-undo-territory-vertex').style.display = 'block';
    document.getElementById('territory-drawing-status').style.display = 'block';
    document.getElementById('territory-drawing-status').innerText = `Editing "${t.name || 'New Sector'}" — Nodes: ${window.activeTerritoryVertices.length}`;
    const closeBtn2 = document.getElementById('btn-close-territory-panel'); if (closeBtn2) closeBtn2.style.display = 'none';
    window.updateToolButtonStyles();
};

window.undoLastTerritoryVertex = function() { if (window.activeTerritoryVertices.length > 0) { window.activeTerritoryVertices.pop(); const statusEl = document.getElementById('territory-drawing-status'); if (statusEl) statusEl.innerText = (window.editingTerritoryId ? 'Editing — ' : '') + `Nodes: ${window.activeTerritoryVertices.length}`; } };

window.finishActiveTerritory = async function() {
    if (window.activeTerritoryVertices.length < 3) { alert("Requires at least 3 nodes."); return; }
    const name = document.getElementById('territory-name-input').value || 'New Sector'; const color = document.getElementById('territory-color-input').value || '#00e5a3';
    let faction = document.getElementById('territory-faction-select') ? document.getElementById('territory-faction-select').value : '';
    // Re-apply the hidden prefix even with no faction, matching
    // toggleTerritoryVisibility, so editing never un-hides a territory.
    if (window.editingTerritoryId && window.editingTerritoryWasHidden) faction = '[HIDDEN] ' + faction;
    const payload = { name, color, vertices: window.activeTerritoryVertices, faction_name: faction };
    const { error } = window.editingTerritoryId
        ? await db.from('territories').update(payload).eq('id', window.editingTerritoryId)
        : await db.from('territories').insert(payload);
    if (error) { alert("Failed to save territory: " + error.message); return; }
    window.cancelDrawingTerritory(); if (typeof window.loadTerritories === 'function') window.loadTerritories();
};
window.cancelDrawingTerritory = function() { window.territoryDrawActive = false; window.activeTerritoryVertices = []; window.editingTerritoryId = null; window.editingTerritoryWasHidden = false; resetTerritoryFormFields(); document.getElementById('btn-start-territory-draw').style.display = 'block'; document.getElementById('btn-finish-territory-draw').style.display = 'none'; document.getElementById('btn-cancel-territory-draw').style.display = 'none'; document.getElementById('btn-undo-territory-vertex').style.display = 'none'; document.getElementById('territory-drawing-status').style.display = 'none'; const closeBtn3 = document.getElementById('btn-close-territory-panel'); if (closeBtn3) closeBtn3.style.display = ''; window.updateToolButtonStyles(); };

/* --- TERRITORY FACTION OWNERSHIP FLIP ---
   Flips ownership of the systems inside a territory's border. DM rules:
   - Applying is an explicit DM action, not automatic on save/edit.
   - Overlaps resolve "last applied wins" (Apply shows a count of systems
     taken from another faction, but does not block).
   - Deleting or shrinking a territory un-claims what it no longer covers.
   territories.owned_system_ids records what this territory owns, so a
   release only touches systems still owned by its faction, never undoing a
   more recently applied overlapping territory. */

// Ray-casting point-in-polygon test. `vertices` is [{x,y}, ...] as stored
// in territories.vertices.
window.isPointInPolygon = function(x, y, vertices) {
    if (!vertices || vertices.length < 3) return false;
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const xi = vertices[i].x, yi = vertices[i].y;
        const xj = vertices[j].x, yj = vertices[j].y;
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
};

// Procedural systems have no DB row: copy ownership overrides onto
// globalProceduralSystemsCache in place. Custom systems get ownership from
// star_systems via loadGalaxyData.
window.applySystemOwnershipOverrides = function() {
    const overrides = window.globalSystemOwnershipCache || {};
    (globalProceduralSystemsCache || []).forEach(s => {
        const o = overrides[s.id];
        if (o === undefined) return;
        if (o.ownership !== undefined) s.ownership = o.ownership;
        if (o.control !== undefined && o.control !== null) s.control = o.control;
    });
};

// Used by delete (release all) and apply (release what fell outside the
// shape). Releases a system only if it is still owned by this territory's
// faction. Returns the number released.
window.releaseTerritoryOwnership = async function(t) {
    const faction = (t.faction_name || '').replace('[HIDDEN] ', '').replace('[HIDDEN]', '').trim();
    const ids = t.owned_system_ids || [];
    if (!faction || ids.length === 0) return 0;
    const allSystems = (globalProceduralSystemsCache || []).concat(globalDbSystemsCache || []);
    let released = 0;
    for (const id of ids) {
        const sys = allSystems.find(s => s.id === id);
        if (!sys || sys.ownership !== faction) continue;
        // Control resets along with ownership.
        if (sys.isCustom) {
            await db.from('star_systems').update({ ownership: 'Unclaimed', control: 'None' }).eq('id', id);
        } else {
            await db.from('system_ownership_overrides').delete().eq('system_id', id);
        }
        sys.ownership = 'Unclaimed'; // instant local reflect; a full reload still follows in the caller
        sys.control = 'None';
        released++;
    }
    return released;
};

window.applyTerritoryToGalaxy = async function(territoryId) {
    if (currentUserRole !== 'dm') return;
    const t = globalTerritoriesCache.find(x => x.id === territoryId);
    if (!t) return;
    if (!t.vertices || t.vertices.length < 3) { alert("This territory has no valid drawn shape to apply."); return; }
    const faction = (t.faction_name || '').replace('[HIDDEN] ', '').replace('[HIDDEN]', '').trim();
    if (!faction) { alert("Assign a faction to this territory before applying it — there's no owner to claim systems for otherwise."); return; }

    const allSystems = (globalProceduralSystemsCache || []).concat(globalDbSystemsCache || []);
    const newOwnedIds = allSystems.filter(s => window.isPointInPolygon(s.x, s.y, t.vertices)).map(s => s.id);

    // Informational only: count systems taken from a different faction.
    // Overlap is never blocked ("last applied wins").
    const contestedCount = newOwnedIds.filter(id => {
        const sys = allSystems.find(s => s.id === id);
        return sys && sys.ownership && sys.ownership !== 'Unclaimed' && sys.ownership !== faction;
    }).length;
    let confirmMsg = `Apply "${t.name}" to the galaxy? ${newOwnedIds.length} system(s) inside its border will be claimed for ${faction}; anything this territory previously claimed but no longer covers will be released back to Unclaimed. This changes the shared galaxy for everyone.`;
    if (contestedCount > 0) confirmMsg += ` ⚠ ${contestedCount} of these system(s) are currently claimed by another faction and will be reassigned to ${faction}.`;
    if (!(await window.showConfirmModal(confirmMsg))) return;

    const newSet = new Set(newOwnedIds);
    const toRelease = (t.owned_system_ids || []).filter(id => !newSet.has(id));
    const releasedCount = await window.releaseTerritoryOwnership({ faction_name: faction, owned_system_ids: toRelease });

    let claimedCount = 0;
    for (const id of newOwnedIds) {
        const sys = allSystems.find(s => s.id === id);
        if (!sys) continue;
        // DM decision: every Apply resets Control to the owning faction,
        // overwriting any hand-set "owned by A, controlled by B".
        const controlValue = faction;
        if (sys.isCustom) {
            await db.from('star_systems').update({ ownership: faction, control: controlValue }).eq('id', id);
        } else {
            await db.from('system_ownership_overrides').upsert({ system_id: id, ownership: faction, control: controlValue, updated_at: new Date().toISOString() });
        }
        sys.ownership = faction;
        sys.control = controlValue;
        claimedCount++;
    }

    await db.from('territories').update({ owned_system_ids: newOwnedIds }).eq('id', t.id);

    if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
    if (typeof loadSystemOwnershipOverrides === 'function') await loadSystemOwnershipOverrides();
    if (typeof loadTerritories === 'function') await loadTerritories();
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();

    await db.from('chat_logs').insert({
        sender_id: null,
        content: `🚩 [TERRITORY] "${t.name}" applied — ${claimedCount} system(s) now under ${faction}${releasedCount > 0 ? `, ${releasedCount} released back to Unclaimed` : ''}.`,
        message_type: 'system'
    });
    if (typeof window.showToast === 'function') window.showToast(`Territory applied: ${claimedCount} claimed${releasedCount > 0 ? `, ${releasedCount} released` : ''}.`);
};

window.toggleHyperlanes = function() {
    if (currentUserRole === 'dm') { const hBtn = document.getElementById('btn-start-hyperlane-draw'); if(hBtn && hBtn.style.display !== 'none') { window.hyperlanesVisible = !window.hyperlanesVisible; } } else { window.hyperlanesVisible = !window.hyperlanesVisible; }
    window.updateToolButtonStyles();
};

// Hyperlane node ids: the system's id for a snapped node, a generated one
// for a deep-space node. FOW discovery keys off these, so edits must
// preserve existing ids rather than regenerate them.
function genHyperlaneNodeId() { return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ('node-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)); }

window.editingHyperlaneId = null; // set by startEditHyperlane; null = finishActiveHyperlane inserts a new route instead of updating one

function resetHyperlaneFormFields() {
    const nameEl = document.getElementById('hyperlane-name-input'); if (nameEl) nameEl.value = '';
    const colorEl = document.getElementById('hyperlane-color-input'); if (colorEl) colorEl.value = '#00e1ff';
    const factionEl = document.getElementById('hyperlane-faction-select'); if (factionEl) factionEl.value = '';
}

// Keeps whatever name / colour / faction the DM typed first (finish and
// cancel clear the form, so nothing is left over from an earlier edit).
window.startDrawingHyperlane = function() { window.editingHyperlaneId = null; window.hyperlaneDrawActive = true; window.activeHyperlaneNodes = []; document.getElementById('btn-start-hyperlane-draw').style.display = 'none'; document.getElementById('btn-finish-hyperlane-draw').style.display = 'block'; document.getElementById('btn-cancel-hyperlane-draw').style.display = 'block'; document.getElementById('btn-undo-hyperlane-node').style.display = 'block'; document.getElementById('hyperlane-drawing-status').style.display = 'block'; window.updateToolButtonStyles(); };

// Loads an existing route into the drawing state for in-place editing
// (saved as an UPDATE). Existing node ids are kept; legacy nodes without
// one get the same route+index fallback key used by discovery, which is
// then saved for real.
window.startEditHyperlane = function(routeId) {
    if (currentUserRole !== 'dm') return;
    const route = globalHyperlanesCache.find(h => h.id === routeId);
    if (!route) return;
    window.editingHyperlaneId = routeId;
    window.activeHyperlaneNodes = (route.nodes || []).map((n, idx) => ({ ...n, id: n.id || (routeId + '-n' + idx) }));
    const nameEl = document.getElementById('hyperlane-name-input'); if (nameEl) nameEl.value = route.name || '';
    const colorEl = document.getElementById('hyperlane-color-input'); if (colorEl) colorEl.value = route.color || '#00e1ff';
    const factionEl = document.getElementById('hyperlane-faction-select'); if (factionEl) factionEl.value = route.faction_name || '';
    window.hyperlaneDrawActive = true;
    document.getElementById('btn-start-hyperlane-draw').style.display = 'none'; document.getElementById('btn-finish-hyperlane-draw').style.display = 'block'; document.getElementById('btn-cancel-hyperlane-draw').style.display = 'block'; document.getElementById('btn-undo-hyperlane-node').style.display = 'block'; document.getElementById('hyperlane-drawing-status').style.display = 'block';
    document.getElementById('hyperlane-drawing-status').innerText = `Editing "${route.name || 'Trade Route'}" — Nodes: ${window.activeHyperlaneNodes.length}`;
    window.updateToolButtonStyles();
};

window.undoLastHyperlaneNode = function() { if (window.activeHyperlaneNodes.length > 0) { window.activeHyperlaneNodes.pop(); const statusEl = document.getElementById('hyperlane-drawing-status'); if (statusEl) statusEl.innerText = (window.editingHyperlaneId ? 'Editing — ' : '') + `Nodes: ${window.activeHyperlaneNodes.length}`; } };

window.finishActiveHyperlane = async function() {
    if (window.activeHyperlaneNodes.length < 2) { alert("Requires at least 2 nodes."); return; }
    // Backstop: ensure every node has a stable id before saving.
    const nodes = window.activeHyperlaneNodes.map(n => n.id ? n : { ...n, id: genHyperlaneNodeId() });
    const name = document.getElementById('hyperlane-name-input').value || 'Trade Route';
    const color = document.getElementById('hyperlane-color-input').value || '#00e1ff';
    const factionEl = document.getElementById('hyperlane-faction-select');
    const faction_name = (factionEl && factionEl.value) ? factionEl.value : null;
    const payload = { name, color, nodes, faction_name };
    const { error } = window.editingHyperlaneId
        ? await db.from('hyperlanes').update(payload).eq('id', window.editingHyperlaneId)
        : await db.from('hyperlanes').insert(payload);
    if (error) { alert("Failed to save trade route: " + error.message); return; }
    window.cancelDrawingHyperlane(); if (typeof loadHyperlanes === 'function') loadHyperlanes();
};
window.cancelDrawingHyperlane = function() { window.editingHyperlaneId = null; resetHyperlaneFormFields(); window.hyperlaneDrawActive = false; window.activeHyperlaneNodes = []; document.getElementById('btn-start-hyperlane-draw').style.display = 'block'; document.getElementById('btn-finish-hyperlane-draw').style.display = 'none'; document.getElementById('btn-cancel-hyperlane-draw').style.display = 'none'; document.getElementById('btn-undo-hyperlane-node').style.display = 'none'; document.getElementById('hyperlane-drawing-status').style.display = 'none'; window.updateToolButtonStyles(); };

window.triggerTacticalPing = function(x, y) {
    if (!realtimeChannel) return;
    if (window.AudioEngine) window.AudioEngine.playPing();
    const username = allProfiles.find(p => p.id === currentUserId)?.username || 'Commander';
    const color = currentUserRole === 'dm' ? '#ff6b6b' : '#00e5a3';
    // httpSend() always uses REST: pings are low-volume, and this avoids
    // supabase-js's deprecation warning for send()'s automatic REST fallback.
    realtimeChannel.httpSend('tactical_ping', { x, y, username, color });
    window.activePings.push({ x, y, color, user: username, startTime: Date.now() });
    if(window.pingModeActive) window.togglePingMode();

    // Also post a Comms message with a jump link. Coordinates ride in the
    // existing roll_data jsonb column.
    db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `📍 ${username} dropped a tactical ping.`,
        message_type: 'ping',
        roll_data: { x, y }
    }).then(({ error }) => { if (!error && typeof loadChatLogs === 'function') loadChatLogs(); });
};

window.jumpToPingLocation = function(x, y) {
    window.camera.x = -x * window.camera.zoom;
    window.camera.y = -y * window.camera.zoom;
    if (window.AudioEngine) window.AudioEngine.playPing();
};

window.updateToolButtonStyles = function() {
    const mBtn = document.getElementById('measuring-tape-toggle-btn'); const pBtn = document.getElementById('ping-tool-toggle-btn'); const tBtn = document.getElementById('territory-tool-toggle-btn'); const hBtn = document.getElementById('btn-start-hyperlane-draw'); const rBtn = document.getElementById('hyperlane-toggle-btn');
    if(mBtn) { mBtn.style.borderColor = window.measuringTapeActive ? '#00e5a3' : '#3c4e36'; mBtn.style.color = window.measuringTapeActive ? '#00e5a3' : '#6b826a'; }
    if(pBtn) { pBtn.style.borderColor = window.pingModeActive ? '#00e5a3' : '#3c4e36'; pBtn.style.color = window.pingModeActive ? '#00e5a3' : '#6b826a'; }
    if(tBtn) { tBtn.style.borderColor = window.territoryDrawActive ? '#00e5a3' : '#3c4e36'; tBtn.style.color = window.territoryDrawActive ? '#00e5a3' : '#6b826a'; }
    if(hBtn) { hBtn.style.borderColor = window.hyperlaneDrawActive ? '#00e1ff' : '#4a7ab5'; hBtn.style.color = window.hyperlaneDrawActive ? '#00e1ff' : '#a2c4f5'; }
    if(rBtn) { rBtn.style.borderColor = window.hyperlanesVisible ? '#00e1ff' : '#3c4e36'; rBtn.style.color = window.hyperlanesVisible ? '#00e1ff' : '#6b826a'; }
};

/* --- MAP CENTERING: LOCK ON GALACTIC CORE ---
   Sagittarius Prime (the core black hole) is at world (0,0); camera (0,0)
   centers world (0,0) in the viewport. */
window.recenterOnGalacticCore = function() {
    window.camera.x = 0;
    window.camera.y = 0;
    window.camera.zoom = 1;
};

/* --- CIC TACTICAL TABLE: RADAR SWEEP TOGGLE ---
   Pure CSS animation (.radar-sweep in style.css); only on/off state lives here. */
window.radarSweepActive = window.safeLocalGet('odyssey_radar_sweep', null) === 'true';
function applyRadarSweepState() {
    const overlay = document.getElementById('radar-sweep-overlay');
    if (overlay) overlay.classList.toggle('active', window.radarSweepActive);
    const btn = document.getElementById('radar-sweep-toggle-btn');
    if (btn) { btn.style.borderColor = window.radarSweepActive ? '#00e5a3' : '#3c4e36'; btn.style.color = window.radarSweepActive ? '#00e5a3' : '#6b826a'; }
}
window.toggleRadarSweep = function() {
    window.radarSweepActive = !window.radarSweepActive;
    window.safeLocalSet('odyssey_radar_sweep', window.radarSweepActive ? 'true' : 'false');
    applyRadarSweepState();
    if (window.radarSweepActive) window.recenterOnGalacticCore();
};

/* --- CIC TACTICAL TABLE: DYNAMIC GRID ---
   Drawn in world space. Spacing snaps to a 1-2-5 sequence so cells stay
   readable at any zoom; only the visible viewport (cx/cy/hw/hh) is drawn.
   Returns the spacing used, for the telemetry readout. */
function drawTacticalGrid(ctx, cx, cy, hw, hh, zoom) {
    const targetPx = 90;
    const rawSpacing = targetPx / zoom;
    const pow10 = Math.pow(10, Math.floor(Math.log10(rawSpacing)));
    const norm = rawSpacing / pow10;
    const mult = norm < 2 ? 1 : (norm < 5 ? 2 : 5);
    const spacing = mult * pow10;

    let alpha = Math.min(0.10, Math.max(0.015, zoom * 0.05));

    const startX = Math.floor((cx - hw) / spacing) * spacing;
    const endX = Math.ceil((cx + hw) / spacing) * spacing;
    const startY = Math.floor((cy - hh) / spacing) * spacing;
    const endY = Math.ceil((cy + hh) / spacing) * spacing;

    ctx.save();
    ctx.strokeStyle = `rgba(0, 229, 163, ${alpha})`;
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    for (let x = startX; x <= endX; x += spacing) { ctx.moveTo(x, cy - hh); ctx.lineTo(x, cy + hh); }
    for (let y = startY; y <= endY; y += spacing) { ctx.moveTo(cx - hw, y); ctx.lineTo(cx + hw, y); }
    ctx.stroke();

    // Brighter major lines every 5th cell for a bit of structure.
    const majorSpacing = spacing * 5;
    ctx.strokeStyle = `rgba(0, 229, 163, ${Math.min(0.16, alpha * 1.8)})`;
    ctx.beginPath();
    const startXM = Math.floor((cx - hw) / majorSpacing) * majorSpacing;
    const startYM = Math.floor((cy - hh) / majorSpacing) * majorSpacing;
    for (let x = startXM; x <= endX; x += majorSpacing) { ctx.moveTo(x, cy - hh); ctx.lineTo(x, cy + hh); }
    for (let y = startYM; y <= endY; y += majorSpacing) { ctx.moveTo(cx - hw, y); ctx.lineTo(cx + hw, y); }
    ctx.stroke();
    ctx.restore();

    return spacing;
}

/* --- CIC OVERLAY: SYSTEM HAZARD ZONE VISUALS ---
   Draws explicit zones (system_hazards) and implicit per-star hazards, for
   on-screen hazards only. Each is FOW-gated on its OWN x/y via
   isPositionSensorVisible. A zone's system_id is informational only (zones
   are placed at the camera center, not necessarily near that system).
   Radius is clamped to window.SYSTEM_HAZARD_MAX_RADIUS. */
function drawHazardZones(ctx, cx, cy, hw, hh, zoom, time) {
    (window.globalSystemHazardsCache || []).forEach(hz => {
        const r = Math.min(hz.radius || 300, window.SYSTEM_HAZARD_MAX_RADIUS);
        if (Math.abs(hz.x - cx) > hw + r || Math.abs(hz.y - cy) > hh + r) return; // off-screen cull first (cheap)
        if (!window.isPositionSensorVisible(hz.x, hz.y)) return;
        drawSingleHazard(ctx, hz.x, hz.y, r, hz.hazard_type, zoom, time);
    });

    const allSystems = (globalProceduralSystemsCache || []).concat(globalDbSystemsCache || []);
    const implicitR = window.HAZARD_IMPLICIT_RADIUS;
    allSystems.forEach(s => {
        if (!s.hazard || s.hazard === 'None') return;
        if (Math.abs(s.x - cx) > hw + implicitR || Math.abs(s.y - cy) > hh + implicitR) return; // off-screen cull first (cheap)
        if (!window.isPositionSensorVisible(s.x, s.y)) return;
        drawSingleHazard(ctx, s.x, s.y, implicitR, s.hazard.toLowerCase().replace(/\s+/g, '_'), zoom, time);
    });
}

function drawSingleHazard(ctx, x, y, radius, type, zoom, time) {
    if (!(radius > 0)) return; // guard against zero/negative/NaN radius (bad data or malformed DM input)
    ctx.save();
    if (type === 'pulsar') {
        let pulse = 0.5 + Math.sin(time * 0.006) * 0.3;
        ctx.lineWidth = 2 / zoom;
        ctx.strokeStyle = `rgba(255, 51, 102, ${pulse * 0.6})`;
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = `rgba(255, 51, 102, ${pulse * 0.25})`;
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.01, radius * 0.6), 0, Math.PI * 2); ctx.stroke();
    } else if (type === 'nebula') {
        let grd = ctx.createRadialGradient(x, y, Math.max(0.01, radius * 0.1), x, y, radius);
        grd.addColorStop(0, 'rgba(199, 120, 221, 0.16)');
        grd.addColorStop(0.6, 'rgba(120, 80, 200, 0.09)');
        grd.addColorStop(1, 'rgba(120, 80, 200, 0)');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    } else if (type === 'gravity_well') {
        ctx.strokeStyle = 'rgba(118, 148, 255, 0.3)';
        ctx.lineWidth = 1 / zoom;
        for (let r = radius; r > radius * 0.15; r -= radius / 5) {
            let warp = Math.sin(time * 0.003 + r * 0.02) * (6 / zoom);
            // At extreme zoom-out the warp can exceed a small ring's radius;
            // clamp so arc() never gets a negative radius (it throws).
            let ringR = Math.max(0.01, r + warp);
            ctx.beginPath(); ctx.arc(x, y, ringR, 0, Math.PI * 2); ctx.stroke();
        }
    }
    ctx.restore();
}

/* --- DRADIS RADAR: DYNAMIC ANCHOR TRACKING ---
   Places the dish over a world-space anchor (galactic core, or the focused
   system) using the canvas transform. Runs every frame while active.
   left/top are not CSS-transitioned so tracking stays in sync during
   pan/zoom; only width/height transition (.radar-sweep in style.css). */
const GALAXY_RADIUS_WORLD = 16000; // must match initGalaxyEngine's galaxyRadius
function updateRadarSweepPosition(cssWidth, cssHeight) {
    if (!window.radarSweepActive) return;
    const overlay = document.getElementById('radar-sweep-overlay');
    if (!overlay) return;

    const focused = window._radarFocusedSystem;
    let anchorWorldX = 0, anchorWorldY = 0, radiusPx;
    if (focused) {
        anchorWorldX = focused.x; anchorWorldY = focused.y;
        radiusPx = 260; // fixed dish size at system-scale focus
    } else {
        // No system in focus: anchor on the galactic core, sized to the galaxy.
        radiusPx = Math.max(160, Math.min(520, GALAXY_RADIUS_WORLD * window.camera.zoom));
    }

    const screenX = cssWidth / 2 + window.camera.x + anchorWorldX * window.camera.zoom;
    const screenY = cssHeight / 2 + window.camera.y + anchorWorldY * window.camera.zoom;

    overlay.style.left = `${screenX}px`;
    overlay.style.top = `${screenY}px`;
    overlay.style.width = `${radiusPx * 2}px`;
    overlay.style.height = `${radiusPx * 2}px`;
    overlay.style.transform = 'translate(-50%, -50%)';
}

/* --- CIC TACTICAL TABLE: TELEMETRY READOUT ---
   Updates sector coords, zoom % and grid scale text, throttled to every 150 ms. */
let lastCicTelemetryUpdate = 0;
function updateCicTelemetry(cx, cy, zoom, gridSpacing) {
    const now = Date.now();
    if (now - lastCicTelemetryUpdate < 150) return;
    lastCicTelemetryUpdate = now;
    const coordsEl = document.getElementById('cic-sector-coords');
    const zoomEl = document.getElementById('cic-zoom-pct');
    const gridEl = document.getElementById('cic-grid-scale');
    if (coordsEl) coordsEl.textContent = `${Math.round(cx)} / ${Math.round(cy)}`;
    if (zoomEl) zoomEl.textContent = `${Math.round(zoom * 100)}%`;
    if (gridEl) gridEl.textContent = gridSpacing ? `${gridSpacing}u` : '—';
}

/* --- GLOBAL SYSTEM SEARCH --- */
window._globalSearchResults = [];
let _searchDropdownEscaped = false;
function escapeSearchDropdownClipping() {
    // #top-bar has overflow-y:hidden, which clips the dropdown. Move it to
    // <body> (and use position:fixed) instead of changing that CSS rule.
    if (_searchDropdownEscaped) return;
    const dropdown = document.getElementById('search-results-dropdown');
    if (!dropdown) return;
    document.body.appendChild(dropdown);
    _searchDropdownEscaped = true;
}

window.handleGlobalSearchInput = function(query) {
    escapeSearchDropdownClipping();
    const dropdown = document.getElementById('search-results-dropdown');
    const inputEl = document.getElementById('global-terminal-search');
    if (!dropdown || !inputEl) return;
    query = (query || '').trim().toLowerCase();
    if (!query) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; window._globalSearchResults = []; return; }

    let allSystems = globalProceduralSystemsCache.concat(globalDbSystemsCache);
    let results = [];
    allSystems.forEach(s => { if (s.name && s.name.toLowerCase().includes(query)) results.push({ type: 'star', data: s }); });
    globalShipMarkersCache.forEach(m => { if (!m.hide_from_galaxy_map && m.name && m.name.toLowerCase().includes(query)) results.push({ type: 'ship', data: m }); }); // Battle-Map-only ships aren't on this map
    results = results.slice(0, 8);
    window._globalSearchResults = results;

    const rect = inputEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.width = rect.width + 'px';

    if (results.length === 0) {
        dropdown.innerHTML = '<div class="search-result-item" style="cursor:default; color:#6b826a;">No matches</div>';
    } else {
        dropdown.innerHTML = results.map((r, idx) => `<div class="search-result-item" onclick="window.selectGlobalSearchResult(${idx})">${r.data.name} <span style="color:#6b826a; font-size:9px;">[${r.type.toUpperCase()}]</span></div>`).join('');
    }
    dropdown.style.display = 'block';
};

window.selectGlobalSearchResult = function(idx) {
    const r = window._globalSearchResults[idx];
    if (!r) return;
    window.selectedTarget = { type: r.type, data: r.data };
    window.lockCameraOnSelected();
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    const dropdown = document.getElementById('search-results-dropdown');
    if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
    const input = document.getElementById('global-terminal-search');
    if (input) input.value = '';
};

document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('search-results-dropdown');
    const input = document.getElementById('global-terminal-search');
    if (!dropdown || dropdown.style.display === 'none') return;
    if (e.target === input || dropdown.contains(e.target)) return;
    dropdown.innerHTML = ''; dropdown.style.display = 'none';
});

window.clearSelectedTarget = function() {
    window.selectedTarget = null;
    window._lastMobileNavAutoOpenKey = null; // so re-selecting the same target still auto-opens the mobile nav drawer
    if (window.jumpPlottingActive) window.cancelJumpPlotting();
    if (window.measuringTapeActive) window.toggleMeasuringTool();
    if (window.hyperlaneDrawActive) window.cancelDrawingHyperlane();
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};

window.lockCameraOnSelected = function() {
    if (!window.selectedTarget || !window.selectedTarget.data) return;
    let targetX = window.selectedTarget.data.x; let targetY = window.selectedTarget.data.y;
    if (window.selectedTarget.type === 'body' && window.selectedTarget.data.parentSystem) { targetX = window.selectedTarget.data.parentSystem.x; targetY = window.selectedTarget.data.parentSystem.y; }
    window.camera.x = -targetX * window.camera.zoom; window.camera.y = -targetY * window.camera.zoom;
    window.addRecentTarget(window.selectedTarget);
};

window.addRecentTarget = function(target) {
    if (!target || !target.data || target.data.id === undefined) return;
    recentTargets = recentTargets.filter(r => !(r.data && r.data.id === target.data.id && r.type === target.type));
    recentTargets.unshift({ type: target.type, data: target.data });
    if (recentTargets.length > 10) recentTargets.length = 10;
    window.safeLocalSet('odyssey_recents', JSON.stringify(recentTargets));
    if (window.activeHudTab === 'recents' && typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};

/* --- JUMP PLOTTING, TARGETS, SAVES --- */
window.startJumpPlottingMode = function() {
    if (!window.selectedTarget || window.selectedTarget.type !== 'ship') return;
    window.jumpPlottingActive = true; window.measuringTapeActive = false; window.pingModeActive = false; window.territoryDrawActive = false; window.hyperlaneDrawActive = false;
    window.activeJumpShip = window.selectedTarget.data; window.jumpTargetPoint = null;
    window.selectedDriveTypeKey = driveSpeeds[window.activeJumpShip.drive_type] ? window.activeJumpShip.drive_type : 'ftl_class1'; // unknown drive types fall back to ftl_class1
    window.selectedDriveSpeed = driveSpeeds[window.selectedDriveTypeKey].speed;
    window.updateToolButtonStyles(); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};
window.cancelJumpPlotting = function() { window.jumpPlottingActive = false; window.activeJumpShip = null; window.jumpTargetPoint = null; if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };
window.setDriveSpeedKey = function(key) { if (driveSpeeds[key]) { window.selectedDriveTypeKey = key; window.selectedDriveSpeed = driveSpeeds[key].speed; if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); } };
window.updateShipDriveType = async function(shipId, newDriveType) { await db.from('ship_markers').update({ drive_type: newDriveType }).eq('id', shipId); let ship = globalShipMarkersCache.find(s => s.id === shipId); if (ship) ship.drive_type = newDriveType; if (window.activeJumpShip && window.activeJumpShip.id === shipId && driveSpeeds[newDriveType]) { window.selectedDriveTypeKey = newDriveType; window.selectedDriveSpeed = driveSpeeds[newDriveType].speed; } if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };
window.updateShipIff = async function(shipId, newIff) { let ship = globalShipMarkersCache.find(s => s.id === shipId); if (!ship) return; const iffValue = newIff || null; await db.from('ship_markers').update({ iff: iffValue }).eq('id', shipId); ship.iff = iffValue; if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };

/* --- MASTER-TO-SUB-TOKEN DOCKING ---
   A docked craft is not drawn or selectable on the map (docked_to checks in
   the render loop and click handler); it shows as a "🔗 count" tag on its
   master's label. Only one level of nesting is supported. */
window.dockShipToMaster = async function(subShipId, masterShipId) {
    if (!masterShipId) { alert("Select a master vessel to dock to."); return; }
    if (subShipId === masterShipId) return;
    const sub = globalShipMarkersCache.find(m => m.id === subShipId);
    if (sub && currentUserRole !== 'dm' && !window.vesselHasOwner(sub, currentUserId)) { alert("You can only dock vessels you control."); return; }
    const master = globalShipMarkersCache.find(m => m.id === masterShipId);
    if (master && master.docked_to) { alert("That vessel is itself docked to another master — only one level of docking is supported."); return; }
    const { error } = await db.from('ship_markers').update({ docked_to: masterShipId }).eq('id', subShipId);
    if (error) { alert("Failed to dock: " + error.message); return; }
    if (sub) sub.docked_to = masterShipId;
    if (window.AudioEngine) window.AudioEngine.playDock();
    window.clearSelectedTarget(); // it's no longer an independently selectable token
    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

window.undockShip = async function(shipId) {
    const ship = globalShipMarkersCache.find(m => m.id === shipId);
    if (!ship) return;
    if (currentUserRole !== 'dm' && !window.vesselHasOwner(ship, currentUserId)) { alert("You can only undock vessels you control."); return; }
    // Detach near the master's current position, not the stale pre-dock coords.
    const master = globalShipMarkersCache.find(m => m.id === ship.docked_to);
    let updates = { docked_to: null };
    if (master) { updates.x = master.x + (Math.random() * 60 - 30); updates.y = master.y + (Math.random() * 60 - 30); }
    const { error } = await db.from('ship_markers').update(updates).eq('id', shipId);
    if (error) { alert("Failed to undock: " + error.message); return; }
    Object.assign(ship, updates);
    if (window.AudioEngine) window.AudioEngine.playDock();
    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

window.executePlottedJump = async function() {
    if (!window.activeJumpShip || !window.jumpTargetPoint) return;
    let ship = window.activeJumpShip; let target = window.jumpTargetPoint;
    let dist = Math.hypot(target.x - ship.x, target.y - ship.y);
    let fuelCost = Math.max(1, Math.round(dist / 100)); if (window.selectedDriveSpeed < 50) fuelCost = 0;

    let cargo = ship.cargo_inventory || {}; let expendables = cargo.expendables || [];
    let fuelIdx = expendables.findIndex(i => (i.name || '').toLowerCase().includes('energy core') || (i.name || '').toLowerCase().includes('fuel'));

    if (fuelCost > 0) {
        if (fuelIdx >= 0 && expendables[fuelIdx].qty >= fuelCost) { expendables[fuelIdx].qty -= fuelCost; cargo.expendables = expendables; }
        else { if (window.AudioEngine) window.AudioEngine.playError(); alert(`Insufficient Fuel! Requires ${fuelCost} Energy Cores.`); return; }
    }

    // Relativistic time inversion: a jump rewinds the clock (see
    // window.JUMP_TIME_INVERSION_MAX_HOURS in js/db.js). A gravity well
    // multiplies the effective distance by 1 + 0.5 * intensity.
    let driftDist = dist;
    let gravityWellHit = (typeof window.checkShipHazards === 'function') ? window.checkShipHazards(ship).find(h => h.type === 'gravity_well') : null;
    let gravityWellNote = '';
    if (gravityWellHit) {
        const mult = 1 + (0.5 * (gravityWellHit.intensity || 1));
        driftDist = driftDist * mult;
        gravityWellNote = ` [GRAVITY WELL: jump vector distorted, effective distance x${mult}]`;
    }
    const isFtl = window.selectedDriveTypeKey !== 'sublight';
    let rawDriftHours = 0;
    if (isFtl || !window.jumpInversionFtlOnly) {
        rawDriftHours = driftDist * window.selectedDriveSpeed / window.TEMPORAL_DRIFT_CONSTANT;
    }
    let driftHours = rawDriftHours > 0 ? Math.min(window.JUMP_TIME_INVERSION_MAX_HOURS, Math.max(1, Math.round(rawDriftHours))) : 0;
    const cappedNote = rawDriftHours > window.JUMP_TIME_INVERSION_MAX_HOURS ? ' [CAPPED]' : '';

    if (window.AudioEngine) window.AudioEngine.playWarp();
    // DM rule: the jump rewinds the one shared campaign clock for everyone.
    // Uses the atomic adjust_campaign_clock RPC like every other clock write.
    let oldTime = window.universeTimeHours, newTime = window.universeTimeHours;
    if (driftHours > 0) {
        const { data: clockData, error: clockError } = await db.rpc('adjust_campaign_clock', { delta_hours: -driftHours });
        if (!clockError && clockData && clockData[0]) {
            oldTime = clockData[0].old_hours; newTime = clockData[0].new_hours;
            window.universeTimeHours = newTime;
            window.safeLocalSet('odyssey_universe_time', window.universeTimeHours);
            if (typeof window.updateCalendarDisplay === 'function') window.updateCalendarDisplay();
        }
    }

    ship.x = target.x; ship.y = target.y; ship.cargo_inventory = cargo;
    await db.from('ship_markers').update({ x: target.x, y: target.y, cargo_inventory: cargo }).eq('id', ship.id);
    if(typeof checkAnomalyProximity === 'function') await checkAnomalyProximity(ship);
    if(typeof window.processTimeAdvancement === 'function') await window.processTimeAdvancement(oldTime, newTime);

    const driftNote = driftHours > 0 ? ` Chronometer reads ${driftHours}h prior to departure per relativistic inversion.${cappedNote}${gravityWellNote}` : '';
    await db.from('chat_logs').insert({ sender_id: currentUserId, content: `🚀 [FTL JUMP] Vessel '${ship.name}' completed jump to ${target.name}.${driftNote}`, message_type: 'text' });
    window.cancelJumpPlotting(); if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

window.toggleBookmarkSelected = function() {
    if (!window.selectedTarget || !window.selectedTarget.data) return;
    let existsIndex = bookmarkedTargets.findIndex(b => b.data.id === window.selectedTarget.data.id);
    if (existsIndex >= 0) { bookmarkedTargets.splice(existsIndex, 1); } else { bookmarkedTargets.push({ type: window.selectedTarget.type, data: window.selectedTarget.data }); }
    window.safeLocalSet('odyssey_bookmarks', JSON.stringify(bookmarkedTargets)); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};
window.shareBookmarkToChat = function(name, type) { db.from('chat_logs').insert({ sender_id: currentUserId, content: `Shared Coordinate 📍 [${type.toUpperCase()}]: ${name}`, message_type: 'text' }); alert("Broadcasted to Comms!"); };
window.jumpToBookmark = function(index) { let b = bookmarkedTargets[index]; if (!b) return; window.selectedTarget = b; window.lockCameraOnSelected(); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };
window.deleteBookmark = function(index) { bookmarkedTargets.splice(index, 1); window.safeLocalSet('odyssey_bookmarks', JSON.stringify(bookmarkedTargets)); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };
window.jumpToRecent = function(index) { let r = recentTargets[index]; if (!r) return; window.selectedTarget = r; window.lockCameraOnSelected(); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };

window.saveDMStarProperties = async function(id) {
    if (currentUserRole !== 'dm') return;
    const name = document.getElementById('edit-star-name').value; const ownership = document.getElementById('edit-star-ownership').value; const control = document.getElementById('edit-star-control') ? document.getElementById('edit-star-control').value : undefined; const luminosity = document.getElementById('edit-star-luminosity').value; const tier = parseInt(document.getElementById('edit-star-tier').value) || 0;
    const payload = { name, ownership, luminosity, industry_tier: tier };
    if (control !== undefined) payload.control = control;
    // Hazard, multiplicity and the planet manifest are saved only when
    // edit-star-hazard exists, i.e. in the full custom-system editor box.
    const hazardEl = document.getElementById('edit-star-hazard'); const multiEl = document.getElementById('edit-star-multi');
    let removedOverrideIds = [];
    if (hazardEl) {
        payload.hazard = hazardEl.value;
        payload.multiType = multiEl ? multiEl.value : 'Single';
        // Body ids are stored in custom_bodies, or synthesized from array
        // position as in getSystemBodiesRaw (editingStarBodies uses the same
        // fallback). Ids saved on the star but missing from editingStarBodies
        // were removed, and their scan overrides are deleted below (DM decision).
        const keptIds = new Set(editingStarBodies.map(b => b.id).filter(Boolean));
        const currentStar = (globalDbSystemsCache || []).find(x => x.id === id);
        removedOverrideIds = ((currentStar && currentStar.custom_bodies) || []).map(b => b.id).filter(bid => bid && !keptIds.has(bid));
        payload.custom_bodies = editingStarBodies.map((b, idx) => ({ ...b, isStar: false, radius: b.radius || (25 + (idx + 1) * 30), baseAngle: b.baseAngle != null ? b.baseAngle : idx * 1.25, speed: b.speed || (0.0002 / (idx + 1)) }));
    }
    const { error } = await db.from('star_systems').update(payload).eq('id', id);
    if (error) { alert("Failed to save: " + error.message); return; }
    for (const rid of removedOverrideIds) {
        await db.from('planetary_modifiers').delete().eq('body_id', rid);
        if (window.globalPlanetaryModifiersCache) delete window.globalPlanetaryModifiersCache[rid];
    }
    alert("Parameters updated.");
    if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
    // loadGalaxyData rebuilds the cache with new objects; copy the fresh
    // values onto selectedTarget/hoveredTarget so the editor isn't stale.
    const refreshed = (globalDbSystemsCache || []).find(s => s.id === id);
    if (refreshed) {
        if (window.selectedTarget && window.selectedTarget.data && window.selectedTarget.data.id === id) Object.assign(window.selectedTarget.data, refreshed);
        if (window.hoveredTarget && window.hoveredTarget.data && window.hoveredTarget.data.id === id) Object.assign(window.hoveredTarget.data, refreshed);
    }
    // Re-derive the Planet Manifest editor state from the saved custom_bodies.
    editingStarBodyId = null;
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};

// Ownership/Control editor for a procedural system, which has no
// star_systems row: writes to system_ownership_overrides instead.
window.saveDMSystemOwnershipControl = async function(id) {
    if (currentUserRole !== 'dm') return;
    const ownershipEl = document.getElementById('edit-star-ownership'); const controlEl = document.getElementById('edit-star-control');
    if (!ownershipEl || !controlEl) return;
    const ownership = ownershipEl.value || 'Unclaimed'; const control = controlEl.value || 'None';
    await db.from('system_ownership_overrides').upsert({ system_id: id, ownership, control, updated_at: new Date().toISOString() });
    const sys = (globalProceduralSystemsCache || []).find(s => s.id === id);
    if (sys) { sys.ownership = ownership; sys.control = control; }
    alert("Parameters updated.");
    if (typeof loadSystemOwnershipOverrides === 'function') await loadSystemOwnershipOverrides();
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};
// Saves a body's scan data to planetary_modifiers (most bodies are
// procedural and have no star_systems row). Uses select-then-update/insert
// rather than .upsert() because body_id may not have a unique constraint.
window.saveDMBodyProperties = async function(id) {
    if (currentUserRole !== 'dm' || !window.selectedTarget || window.selectedTarget.type !== 'body') return;
    const payload = {
        custom_name: document.getElementById('edit-body-name').value,
        custom_type: document.getElementById('edit-body-type').value,
        custom_gravity: document.getElementById('edit-body-gravity').value,
        custom_atmosphere: document.getElementById('edit-body-atmosphere').value,
        custom_resources: document.getElementById('edit-body-resources').value
    };
    const { data: existing, error: selectError } = await db.from('planetary_modifiers').select('body_id').eq('body_id', id).maybeSingle();
    if (selectError) { alert("Failed to save scan data: " + selectError.message); return; }
    const { error } = existing
        ? await db.from('planetary_modifiers').update(payload).eq('body_id', id)
        : await db.from('planetary_modifiers').insert({ body_id: id, ...payload });
    if (error) { alert("Failed to save scan data: " + error.message); return; }

    window.globalPlanetaryModifiersCache = window.globalPlanetaryModifiersCache || {};
    window.globalPlanetaryModifiersCache[id] = { ...window.globalPlanetaryModifiersCache[id], body_id: id, ...payload };
    // Reflect saved values onto selectedTarget.data, which the HUD reads.
    Object.assign(window.selectedTarget.data, { name: payload.custom_name, type: payload.custom_type, gravity: payload.custom_gravity, atmosphere: payload.custom_atmosphere, resources: payload.custom_resources });

    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    alert("Scan data saved — synced to all players.");
};
// Removes a planetary_modifiers override; the body reverts to its raw
// generated/custom values (no history is kept). Also useful for cleaning up
// overrides orphaned when procedural star positions change.
window.deletePlanetOverride = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Clear this scan-data override? The body will revert to its default generated/custom values."))) return;
    const { error } = await db.from('planetary_modifiers').delete().eq('body_id', id);
    if (error) { alert("Failed to clear override: " + error.message); return; }

    if (window.globalPlanetaryModifiersCache) delete window.globalPlanetaryModifiersCache[id];
    [window.selectedTarget, window.hoveredTarget].forEach(t => {
        if (t && t.data && t.data.id === id && t.data.parentSystem) {
            const raw = getSystemBodiesRaw(t.data.parentSystem).find(b => b.id === id);
            if (raw) Object.assign(t.data, { name: raw.name, type: raw.type, gravity: raw.gravity, atmosphere: raw.atmosphere, resources: raw.resources });
        }
    });
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    alert("Override cleared — synced to all players.");
};
window.deleteStarSystem = async function(id) { if (currentUserRole !== 'dm') return; if(!(await window.showConfirmModal("Destroy star system?"))) return; await db.from('star_systems').delete().eq('id', id); window.clearSelectedTarget(); if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData(); };
window.deleteShipToken = async function(id) {
    const ship = globalShipMarkersCache.find(m => m.id === id);
    // DM or the ship's owner may decommission.
    if (ship && currentUserRole !== 'dm' && !window.vesselHasOwner(ship, currentUserId)) return;
    if (!(await window.showConfirmModal("Decommission token?"))) return;
    // Strike craft: also remove the squadron from the carrier's ship_deployed
    // list and its combat_tracker row, so nothing is left orphaned.
    if (ship && ship.is_strike_craft && ship.parent_id && ship.squadron_id) {
        const parent = globalShipMarkersCache.find(m => m.id === ship.parent_id);
        if (parent) {
            let deployed = (parent.ship_deployed || []).filter(sq => sq.id !== ship.squadron_id);
            await db.from('ship_markers').update({ ship_deployed: deployed }).eq('id', parent.id);
            parent.ship_deployed = deployed;
            if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
        }
        await db.from('combat_tracker').delete().eq('squadron_id', ship.squadron_id);
        if (typeof loadCombatTracker === 'function') loadCombatTracker();
    }

    await db.from('ship_markers').delete().eq('id', id);
    window.clearSelectedTarget();
    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

/* --- THE CANVAS ENGINE --- */
window.initGalaxyEngine = function() {
    const canvas = document.getElementById('galaxyCanvas'); if (!canvas) return;
    const ctx = canvas.getContext('2d'); const container = document.getElementById('canvas-container');
    const SYSTEM_ZOOM_THRESHOLD = 1.5; const MAP_LIMIT = 18000;

    function resize() { const dpr = window.devicePixelRatio || 1; canvas.width = container.clientWidth * dpr; canvas.height = container.clientHeight * dpr; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr); }
    window.addEventListener('resize', resize); resize();
    applyRadarSweepState();
    window.updateToolButtonStyles();
    
    const proceduralSystems = []; const rng = mulberry32(1048596);
    // galaxyRadius is sized so the 4 LY spacing floor below fits most spiral
    // stars (DM decision). Must match GALAXY_RADIUS_WORLD.
    const coreRadius = 1400; const galaxyRadius = 16000;
    
    proceduralSystems.push({ id: 'proc-core-blackhole', name: 'Sagittarius Prime', x: 0, y: 0, size: 10, color: '#000000', type: 'Black Hole', luminosity: 'Supermassive Singularity', hazard: 'Gravity Well', multiType: 'Single', ownership: 'Uninhabitable Core', isCustom: false });
    for (let i = 0; i < 240; i++) {
        let r = Math.pow(rng(), 0.7) * coreRadius + 120; let theta = rng() * Math.PI * 2; let x = Math.cos(theta) * r; let y = Math.sin(theta) * r; let heat = rng();
        let color = '#7694ff'; let luminosity = 'Class O (Blue Giant)'; let hazard = 'Pulsar';
        if (heat > 0.85) { color = '#000000'; luminosity = 'Singularity'; hazard = 'Gravity Well'; } else if (heat > 0.5) { color = '#ffe9c4'; luminosity = 'Class G (Yellow)'; hazard = 'None'; }
        proceduralSystems.push({ id: `proc-core-${i}`, name: `Core Sector-${2000 + i}`, x, y, size: rng() * 2.5 + 3.5, color, type: luminosity === 'Singularity' ? 'Black Hole' : 'Star', luminosity, hazard, multiType: rng() > 0.7 ? 'Binary' : 'Single', ownership: 'Galactic Core', isCustom: false });
    }
    // Minimum spiral-arm star spacing (100 units = 1 LY). Not applied to the
    // denser galactic core above. A rejected candidate rerolls its position
    // (type/color are rolled only once placed) up to MAX_PLACEMENT_ATTEMPTS
    // times, then is skipped. Deterministic (fixed seed), but every extra
    // draw shifts all later stars in the shared rng() stream, so changing
    // these constants moves stars and can drop proc-spiral-N ids, orphaning
    // territory claims, hazard zones and planet overrides tied to them.
    const MIN_STAR_SPACING = 400; // ~4 LY at 100 units = 1 LY
    const MIN_STAR_SPACING_SQ = MIN_STAR_SPACING * MIN_STAR_SPACING;
    // With this galaxyRadius, 20 attempts places ~97% of the 2,400 spiral stars.
    const MAX_PLACEMENT_ATTEMPTS = 20;
    const MIN_STAR_SPACING_FALLBACK = 'skip'; // drop the star rather than force an overlap
    const spiralPositions = [];

    for (let i = 0; i < 2400; i++) {
        let arm = i % 4;
        let x, y, placed = false;

        for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
            let r = Math.pow(rng(), 0.6) * (galaxyRadius - coreRadius) + coreRadius;

            // 1.6 winding factor lets the arms open up gracefully
            let spiralTheta = (Math.log(r / coreRadius) * 1.6) + ((arm * 2 * Math.PI) / 4);
            // Angle scatter widens the arms
            let finalTheta = spiralTheta + (rng() - 0.5) * (0.8 + (r / galaxyRadius) * 0.8);
            // Radius scatter fills the gaps between arms
            let finalR = r + (rng() - 0.5) * (400 + (r / galaxyRadius) * 800);
            // 18% outliers seed the dark voids with rogue stars
            if (rng() > 0.82) { finalTheta = rng() * Math.PI * 2; finalR = rng() * galaxyRadius; }

            let candX = Math.cos(finalTheta) * finalR; let candY = Math.sin(finalTheta) * finalR;

            let tooClose = false;
            for (let k = 0; k < spiralPositions.length; k++) {
                let dx = spiralPositions[k].x - candX; let dy = spiralPositions[k].y - candY;
                if (dx * dx + dy * dy < MIN_STAR_SPACING_SQ) { tooClose = true; break; }
            }
            if (!tooClose) { x = candX; y = candY; placed = true; break; }
        }

        if (!placed) continue; // MIN_STAR_SPACING_FALLBACK === 'skip'
        spiralPositions.push({ x, y });

        let type = 'Star'; let size = rng() * 2.0 + 3.0; let color = '#ffe9c4'; let luminosity = 'Class G (Yellow)'; let hazard = 'None';

        let starRoll = rng();
        if (starRoll > 0.985) { type = 'Black Hole'; color = '#000000'; size = 6.5; luminosity = 'Singularity'; hazard = 'Gravity Well'; }
        else if (starRoll > 0.94) { type = 'Nebula'; color = ['#ff3366', '#33ccff', '#cc33ff', '#33ff99'][Math.floor(rng() * 4)]; size = 120 + rng() * 120; luminosity = 'Gas Cloud'; hazard = 'Nebula'; }
        else { let heat = rng(); if (heat > 0.75) { color = '#7694ff'; luminosity = 'Class O (Blue Giant)'; if (rng() > 0.6) hazard = 'Pulsar'; } else if (heat > 0.35) { color = '#ffe9c4'; luminosity = 'Class G (Yellow)'; } else { color = '#ffb37b'; luminosity = 'Class M (Red Dwarf)'; size *= 0.8; } }

        proceduralSystems.push({ id: `proc-spiral-${i}`, name: `Arm ${['Alpha','Beta','Gamma','Delta'][arm]}-${1000 + i}`, x, y, size, color, type, luminosity, hazard, multiType: rng() > 0.8 ? 'Binary' : 'Single', ownership: 'Unclaimed', isCustom: false });
    }
    globalProceduralSystemsCache = proceduralSystems;
    // Re-apply in case the ownership override cache (js/db.js) loaded
    // before the procedural galaxy existed.
    if (typeof window.applySystemOwnershipOverrides === 'function') window.applySystemOwnershipOverrides();
    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();

    function screenToWorld(sx, sy) { const rect = canvas.getBoundingClientRect(); return { x: (sx - rect.left - container.clientWidth / 2 - window.camera.x) / window.camera.zoom, y: (sy - rect.top - container.clientHeight / 2 - window.camera.y) / window.camera.zoom }; }

    // Pointer handlers take plain coordinates so mouse and touch share the
    // same logic. Two-finger pinch only zooms/pans; it never drags ships/stars.
    function handlePointerDown(clientX, clientY, targetEl, shiftKey) {
        if (targetEl && targetEl.closest && targetEl.closest('.panel')) return;
        const worldPos = screenToWorld(clientX, clientY);

        if (window.territoryDrawActive) {
            const startNode = window.activeTerritoryVertices[0]; const snapDist = 30 / window.camera.zoom;
            if (startNode && window.activeTerritoryVertices.length >= 3 && Math.hypot(worldPos.x - startNode.x, worldPos.y - startNode.y) < snapDist) { window.finishActiveTerritory(); return; }
            window.activeTerritoryVertices.push({ x: worldPos.x, y: worldPos.y }); document.getElementById('territory-drawing-status').innerText = (window.editingTerritoryId ? 'Editing — ' : '') + `Nodes: ${window.activeTerritoryVertices.length}`; return;
        }

        if (window.hyperlaneDrawActive) {
            // Snapped nodes reuse the system's id; deep-space nodes get a
            // generated one. Either serves as the FOW discovery key.
            let snapNode = { x: worldPos.x, y: worldPos.y, name: "Deep Space Node", id: genHyperlaneNodeId() };
            let allSystems = proceduralSystems.concat(globalDbSystemsCache);
            for (let s of allSystems) { if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < Math.max(15, 25 / window.camera.zoom)) { snapNode = { x: s.x, y: s.y, id: s.id, name: s.name }; break; } }
            window.activeHyperlaneNodes.push(snapNode);
            const statusEl = document.getElementById('hyperlane-drawing-status'); if (statusEl) statusEl.innerText = (window.editingHyperlaneId ? 'Editing — ' : '') + `Nodes: ${window.activeHyperlaneNodes.length}`;
            return;
        }

        if (window.jumpPlottingActive && window.activeJumpShip) {
            let snapTarget = null; let allSystems = proceduralSystems.concat(globalDbSystemsCache);
            // Scaled by zoom like the other hit-tests, so the on-screen snap
            // size stays roughly constant.
            const jumpSnapRadius = Math.max(15, 40 / window.camera.zoom);
            for (let s of allSystems) { if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < jumpSnapRadius) { snapTarget = { x: s.x, y: s.y, name: s.name, hazard: s.hazard }; break; } }
            if (snapTarget) { window.jumpTargetPoint = { x: snapTarget.x, y: snapTarget.y, name: snapTarget.name, hazard: snapTarget.hazard }; }
            else { window.jumpTargetPoint = { x: worldPos.x, y: worldPos.y, name: `Sector (${Math.round(worldPos.x)}, ${Math.round(worldPos.y)})`, hazard: 'None' }; }
            if (window.AudioEngine) window.AudioEngine.playConfirm();
            if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); return;
        }

        if (shiftKey || window.pingModeActive) { if(typeof window.triggerTacticalPing === 'function') window.triggerTacticalPing(worldPos.x, worldPos.y); return; }

        if (window.measuringTapeActive) {
            if (!window.measureStartPoint) { window.measureStartPoint = worldPos; } else if (!window.measureEndPoint) { window.measureEndPoint = worldPos; } else { window.measureStartPoint = worldPos; window.measureEndPoint = null; }
            return;
        }

        const starHitRadius = Math.max(12, 15 / window.camera.zoom); const tokenHitRadius = Math.max(10, 15 / window.camera.zoom); const planetHitRadius = Math.max(6, 12 / window.camera.zoom);
        let time = Date.now(); let allSystems = proceduralSystems.concat(globalDbSystemsCache);

        if (window.camera.zoom > SYSTEM_ZOOM_THRESHOLD) {
            for (let s of allSystems) {
                // Same gate as the render loop: bodies are only clickable at
                // FOW tier 3 and in the focused system, so unscanned body data
                // can't be selected.
                if (window.getFowTier(s) !== 3 || (window._radarFocusedSystem && s.id !== window._radarFocusedSystem.id)) continue;
                if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < 250 && systemCanHaveBodies(s)) {
                    for (let b of window.getSystemBodies(s)) {
                        let angle = b.baseAngle + (time * b.speed); let bx = s.x + Math.cos(angle) * b.radius; let by = s.y + Math.sin(angle) * b.radius;
                        if (Math.hypot(bx - worldPos.x, by - worldPos.y) < (b.isStar ? starHitRadius : planetHitRadius)) { 
                            window.selectedTarget = { type: 'body', data: b }; window.addRecentTarget(window.selectedTarget); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); return; 
                        }
                    }
                }
            }
        }

        for (let m of globalShipMarkersCache) {
            if (m.docked_to) continue; // docked craft aren't independently selectable — they're part of their master
            if (m.hide_from_galaxy_map) continue; // not drawn here, so not clickable/draggable here
            if (Math.hypot(m.x - worldPos.x, m.y - worldPos.y) < tokenHitRadius && (currentUserRole === 'dm' || window.vesselHasOwner(m, currentUserId))) {
                window.draggedMarker = m; window._dragOrigin = { x: m.x, y: m.y }; window.selectedTarget = { type: 'ship', data: m }; window.addRecentTarget(window.selectedTarget);
                if(typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); return;
            }
        }
        for (let s of allSystems) {
            if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < starHitRadius) {
                window.selectedTarget = { type: 'star', data: s }; window.addRecentTarget(window.selectedTarget);
                if(currentUserRole === 'dm' && s.isCustom) { window.draggedStar = s; window._dragOrigin = { x: s.x, y: s.y }; }
                if(typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); return;
            }
        }
        window.camera.isDragging = true; window.camera.startX = clientX; window.camera.startY = clientY;
    }

    function handlePointerMove(clientX, clientY) {
        const worldPos = screenToWorld(clientX, clientY); window._lastMouseWorldX = worldPos.x; window._lastMouseWorldY = worldPos.y;

        if (window.draggedMarker) { window.draggedMarker.x = worldPos.x; window.draggedMarker.y = worldPos.y; return; }
        if (window.draggedStar) { window.draggedStar.x = worldPos.x; window.draggedStar.y = worldPos.y; return; }

        if (window.camera.isDragging) {
            let dx = clientX - window.camera.startX; let dy = clientY - window.camera.startY;
            window.camera.x = Math.max(-MAP_LIMIT * window.camera.zoom, Math.min(MAP_LIMIT * window.camera.zoom, window.camera.x + dx));
            window.camera.y = Math.max(-MAP_LIMIT * window.camera.zoom, Math.min(MAP_LIMIT * window.camera.zoom, window.camera.y + dy));
            window.camera.startX = clientX; window.camera.startY = clientY;
        }
    }

    // Only write a position if it actually changed since pointer-down; a
    // plain click must not write stale cached x/y over another player's move.
    async function handlePointerUp() {
        const origin = window._dragOrigin; window._dragOrigin = null;
        const movedFromOrigin = (obj) => !origin || obj.x !== origin.x || obj.y !== origin.y;
        if (window.draggedMarker) {
            const m = window.draggedMarker; window.draggedMarker = null;
            if (movedFromOrigin(m)) await db.from('ship_markers').update({ x: m.x, y: m.y }).eq('id', m.id);
            if(typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
        }
        if (window.draggedStar) {
            const st = window.draggedStar; window.draggedStar = null;
            if (movedFromOrigin(st)) await db.from('star_systems').update({ x: st.x, y: st.y }).eq('id', st.id);
        }
        window.camera.isDragging = false;
    }

    function applyZoomAtPoint(mouseX, mouseY, zoomFactor) {
        const worldX = (mouseX - window.camera.x) / window.camera.zoom; const worldY = (mouseY - window.camera.y) / window.camera.zoom;
        const newZoom = Math.max(0.02, Math.min(15.0, window.camera.zoom * zoomFactor));
        window.camera.x = Math.max(-MAP_LIMIT * newZoom, Math.min(MAP_LIMIT * newZoom, mouseX - worldX * newZoom));
        window.camera.y = Math.max(-MAP_LIMIT * newZoom, Math.min(MAP_LIMIT * newZoom, mouseY - worldY * newZoom));
        window.camera.zoom = newZoom;
    }

    function applyZoomToTarget(mouseX, mouseY, targetZoom) {
        const worldX = (mouseX - window.camera.x) / window.camera.zoom; const worldY = (mouseY - window.camera.y) / window.camera.zoom;
        window.camera.x = Math.max(-MAP_LIMIT * targetZoom, Math.min(MAP_LIMIT * targetZoom, mouseX - worldX * targetZoom));
        window.camera.y = Math.max(-MAP_LIMIT * targetZoom, Math.min(MAP_LIMIT * targetZoom, mouseY - worldY * targetZoom));
        window.camera.zoom = targetZoom;
    }

    function touchDist(touches) { return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY); }
    function touchMid(touches, rect) {
        return {
            x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left - container.clientWidth / 2,
            y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top - container.clientHeight / 2
        };
    }

    // Browsers fire synthetic mouse events ~300ms after a touch. Touch
    // handlers already run the tap logic, so ignore mousedown shortly after
    // a touch to avoid running it twice.
    window._lastTouchTime = 0;
    container.addEventListener('mousedown', (e) => { if (Date.now() - window._lastTouchTime < 800) return; handlePointerDown(e.clientX, e.clientY, e.target, e.shiftKey); });
    window.addEventListener('mousemove', (e) => { handlePointerMove(e.clientX, e.clientY); });
    window.addEventListener('mouseup', () => { handlePointerUp(); });

    container.addEventListener('wheel', (e) => {
        if (e.target.closest('.panel')) return; e.preventDefault();
        const mouseX = e.clientX - container.getBoundingClientRect().left - container.clientWidth / 2;
        const mouseY = e.clientY - container.getBoundingClientRect().top - container.clientHeight / 2;
        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        applyZoomAtPoint(mouseX, mouseY, zoomFactor);
    }, { passive: false });

    // --- Touch input (mouse is handled separately) ---
    // Calling handlePointerDown on touchstart would select whatever star is
    // under the finger and never pan, so:
    //   * one finger down -> always starts a camera pan
    //   * lifted without moving > TOUCH_TAP_SLOP px -> TAP: runs the same
    //     handlePointerDown select/tool logic as a mouse click
    //   * held still for TOUCH_LONG_PRESS_MS -> LONG PRESS: runs
    //     handlePointerDown, which picks up a draggable token (own ship / DM
    //     custom star); a short vibration confirms where supported
    //   * two fingers -> pinch-zoom, and cancels any tap
    const TOUCH_TAP_SLOP = 10; const TOUCH_LONG_PRESS_MS = 450;
    let touchGesture = null; // { x, y, target, moved, longPressed, timer }
    function clearTouchGesture() { if (touchGesture && touchGesture.timer) clearTimeout(touchGesture.timer); touchGesture = null; }

    container.addEventListener('touchstart', (e) => {
        if (e.target && e.target.closest && e.target.closest('.panel')) return;
        window._lastTouchTime = Date.now();
        if (e.touches.length === 1) {
            const t = e.touches[0];
            clearTouchGesture();
            window.draggedMarker = null; window.draggedStar = null;
            window.camera.isDragging = true; window.camera.startX = t.clientX; window.camera.startY = t.clientY;
            const g = { x: t.clientX, y: t.clientY, target: t.target, moved: false, longPressed: false, timer: null };
            g.timer = setTimeout(() => {
                if (touchGesture !== g || g.moved) return;
                g.longPressed = true;
                window.camera.isDragging = false;
                handlePointerDown(g.x, g.y, g.target, false);
                if ((window.draggedMarker || window.draggedStar) && navigator.vibrate) { try { navigator.vibrate(30); } catch (_) {} }
            }, TOUCH_LONG_PRESS_MS);
            touchGesture = g;
        } else if (e.touches.length >= 2) {
            // A second finger cancels any single-finger pan/tap/drag and
            // starts a pinch, so a ship/star isn't left stuck to the finger.
            if (touchGesture) { touchGesture.moved = true; if (touchGesture.timer) clearTimeout(touchGesture.timer); }
            window.camera.isDragging = false; window.draggedMarker = null; window.draggedStar = null;
            window._pinchStartDist = touchDist(e.touches);
            window._pinchStartZoom = window.camera.zoom;
        }
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1 && window._pinchStartDist) {
            // dropped from two fingers to one -- don't resume a pan using a
            // stale startX/startY from before the pinch.
            window._pinchStartDist = null;
            window.camera.isDragging = true;
            window.camera.startX = e.touches[0].clientX; window.camera.startY = e.touches[0].clientY;
            return;
        }
        if (e.touches.length === 1 && touchGesture && !touchGesture.moved) {
            const t = e.touches[0];
            if (Math.hypot(t.clientX - touchGesture.x, t.clientY - touchGesture.y) > TOUCH_TAP_SLOP) {
                touchGesture.moved = true;
                if (touchGesture.timer) clearTimeout(touchGesture.timer);
            }
        }
        if (e.touches.length === 1 && (window.camera.isDragging || window.draggedMarker || window.draggedStar)) {
            e.preventDefault();
            const t = e.touches[0];
            handlePointerMove(t.clientX, t.clientY);
        } else if (e.touches.length >= 2 && window._pinchStartDist) {
            e.preventDefault();
            const rect = container.getBoundingClientRect();
            const mid = touchMid(e.touches, rect);
            const newDist = touchDist(e.touches);
            const targetZoom = Math.max(0.02, Math.min(15.0, window._pinchStartZoom * (newDist / window._pinchStartDist)));
            applyZoomToTarget(mid.x, mid.y, targetZoom);
        }
    }, { passive: false });

    container.addEventListener('touchend', (e) => {
        window._lastTouchTime = Date.now();
        if (e.touches.length === 0) {
            const g = touchGesture; clearTouchGesture();
            window._pinchStartDist = null;
            if (g && !g.moved && !g.longPressed) {
                // TAP: run the click logic at the original touch point, then
                // disarm any drag/pan it armed (no DB position write).
                window.camera.isDragging = false;
                handlePointerDown(g.x, g.y, g.target, false);
                window.draggedMarker = null; window.draggedStar = null; window.camera.isDragging = false; window._dragOrigin = null;
            } else {
                handlePointerUp();
            }
        } else if (e.touches.length === 1) {
            window._pinchStartDist = null;
            window.camera.isDragging = true;
            window.camera.startX = e.touches[0].clientX; window.camera.startY = e.touches[0].clientY;
        }
    });
    container.addEventListener('touchcancel', () => { clearTouchGesture(); handlePointerUp(); window._pinchStartDist = null; });

    // HUD TELEMETRY RENDERER
    window.renderHUDTelemetry = function() {
        const content = document.getElementById('hud-content'); if (!content) return;

        // Mobile: on a new selection, flag a dot on the nav menu button
        // rather than force-opening the drawer over the map.
        // flagMobileNavUpdate (js/ui.js) is a no-op on desktop. Keyed on a
        // type:id string, since selectedTarget is a fresh object on every
        // click and reference equality would fire on every re-render.
        const _mobileNavSelKey = window.selectedTarget ? `${window.selectedTarget.type}:${(window.selectedTarget.data && (window.selectedTarget.data.id || window.selectedTarget.data.name)) || ''}` : null;
        if (_mobileNavSelKey && _mobileNavSelKey !== window._lastMobileNavAutoOpenKey) {
            window._lastMobileNavAutoOpenKey = _mobileNavSelKey;
            if (typeof window.flagMobileNavUpdate === 'function') window.flagMobileNavUpdate();
        }

        if (window.activeHudTab === 'bookmarks') {
            let html = '<div style="font-size:11px;"><h4 style="margin:0 0 8px 0; color:#00e5a3;">Saved Bookmarks</h4>';
            if (bookmarkedTargets.length === 0) { html += '<span style="color:#6b826a; font-size:10px;">No saved bookmarks. Click bookmark on any target telemetry.</span>'; } 
            else { bookmarkedTargets.forEach((b, idx) => { html += `<div class="note-card" style="display:flex; justify-content:space-between; align-items:center; padding:6px; margin-bottom:4px;"><div><strong style="color:#00e5a3;">${b.data.name}</strong><br><span style="font-size:9px; color:#6b826a;">Type: ${b.type}</span></div><div style="display:flex; gap:4px;"><button class="layer-edit" onclick="window.jumpToBookmark(${idx})" style="font-size:9px; padding:2px 6px;">Jump</button><button class="layer-edit" onclick="window.shareBookmarkToChat('${b.data.name}', '${b.type}')" style="font-size:9px; padding:2px 6px;">Share</button><button class="layer-del" onclick="window.deleteBookmark(${idx})" style="font-size:9px; padding:2px 6px;">✕</button></div></div>`; }); }
            html += '</div>'; content.innerHTML = html; return;
        }

        if (window.activeHudTab === 'recents') {
            let html = '<div style="font-size:11px;"><h4 style="margin:0 0 8px 0; color:#00e5a3;">Recent Navigation Targets</h4>';
            if (recentTargets.length === 0) { html += '<span style="color:#6b826a; font-size:10px;">No recent targets.</span>'; } 
            else { recentTargets.forEach((r, idx) => { html += `<div class="note-card" style="display:flex; justify-content:space-between; align-items:center; padding:6px; margin-bottom:4px;"><div><strong style="color:#00e5a3;">${r.data.name}</strong><br><span style="font-size:9px; color:#6b826a;">Type: ${r.type}</span></div><button class="layer-edit" onclick="window.jumpToRecent(${idx})" style="font-size:9px; padding:2px 6px;">Jump</button></div>`; }); }
            html += '</div>'; content.innerHTML = html; return;
        }

        let dynamicTarget = window.selectedTarget || window.hoveredTarget;
        if (!dynamicTarget) { content.innerHTML = `<p style="margin: 0; font-size: 12px; color: #6b826a;">Hover or click a target...</p>`; return; }
        
        let isLocked = !!window.selectedTarget; let lockStatusHtml = isLocked ? `<span style="color:#00e5a3; font-size:9px;">[TARGET LOCKED]</span>` : `<span style="color:#ffaa00; font-size:9px;">[SENSOR HOVER]</span>`;
        let isBookmarked = bookmarkedTargets.some(b => b.data.id === dynamicTarget.data.id);
        let bookmarkBtn = `<button class="btn-reveal" onclick="window.toggleBookmarkSelected()" style="font-size:9px; padding:4px; margin-top:4px;">${isBookmarked ? '★ BOOKMARKED' : '☆ BOOKMARK'}</button>`;
        let lockBtn = `<button class="btn-reveal" onclick="window.lockCameraOnSelected()" style="font-size:9px; padding:4px; margin-top:4px;">🎯 LOCK VIEW</button>`;

        if (dynamicTarget.type === 'star') {
            const s = dynamicTarget.data; let fowTier = window.getFowTier(s);
            let dmEditorBox = '';
            // Personal label editor: shown to every user (only affects this
            // viewer). Not offered at fowTier 1 (Unknown Contact).
            const myPersonalSystemLabel = (window.globalPersonalLabelsCache || {})[`system:${s.id}`] || '';
            const personalLabelBox = `<div style="background:#040605; border:1px solid #3c4e36; padding:6px; margin-top:8px; border-radius:2px;">
                <span style="font-size:9px; color:#6b826a;">📝 Personal Label (only you see this):</span>
                <div style="display:flex; gap:4px; margin-top:4px;">
                    <input type="text" id="personal-label-system-${s.id}" value="${myPersonalSystemLabel}" placeholder="${s.name}" style="flex:1; font-size:10px; margin:0;">
                    <button class="btn-reveal" onclick="window.savePersonalLabel('system', '${s.id}', document.getElementById('personal-label-system-${s.id}').value)" style="width:auto; padding:4px 8px; font-size:9px; margin:0;" title="Leave blank and click SET to clear your personal label">SET</button>
                </div>
            </div>`;
            // DM sees Ownership/Control on every system. Custom systems get the
            // full OVERSEER STAR EDITOR box; procedural systems get a smaller
            // SYSTEM CONTROL OVERRIDE box (Ownership+Control only, written to
            // system_ownership_overrides). DM rule: Control stays editable
            // after a Territory Apply.
            if (currentUserRole === 'dm') {
                const ownershipControlFields = `
                    <label style="font-size:9px; color:#6b826a; display:block; margin-top:4px;">Ownership:</label><input type="text" id="edit-star-ownership" value="${s.ownership || 'Unclaimed'}" style="font-size:10px; margin:2px 0;">
                    <label style="font-size:9px; color:#6b826a; display:block;">Control:</label><input type="text" id="edit-star-control" value="${s.control || 'None'}" style="font-size:10px; margin:2px 0;">`;
                if (s.isCustom) {
                    // editingStarBodies re-derives from s.custom_bodies only
                    // when the selected star changes, so re-renders keep typing.
                    if (editingStarBodyId !== s.id) {
                        editingStarBodyId = s.id;
                        editingStarBodies = (s.custom_bodies || []).map((b, idx) => ({ ...b, id: b.id || `${s.id}-custom-${idx}` }));
                    }
                    dmEditorBox = `<div style="background:#040605; border:1px solid #ff3366; padding:8px; margin-top:8px; border-radius:2px;">
                        <span style="font-size:9px; color:#ff6b6b; font-weight:bold;">🛠️ OVERSEER STAR EDITOR</span>
                        <label style="font-size:9px; color:#6b826a; display:block; margin-top:4px;">Name:</label><input type="text" id="edit-star-name" value="${s.name}" style="font-size:10px; margin:2px 0;">
                        ${ownershipControlFields}
                        <div style="display:flex; gap:6px;"><div style="flex:1;"><label style="font-size:9px; color:#6b826a;">Class:</label><select id="edit-star-luminosity" style="font-size:9px; margin:2px 0;"><option value="Class G (Yellow)" ${s.luminosity==='Class G (Yellow)'?'selected':''}>Class G</option><option value="Class M (Red Dwarf)" ${s.luminosity==='Class M (Red Dwarf)'?'selected':''}>Class M</option><option value="Class O (Blue Giant)" ${s.luminosity==='Class O (Blue Giant)'?'selected':''}>Class O</option><option value="Black Hole" ${s.luminosity==='Black Hole'?'selected':''}>Black Hole</option><option value="Hidden Anomaly" ${s.luminosity==='Hidden Anomaly'?'selected':''}>Hidden Anomaly</option></select></div><div style="flex:1;"><label style="font-size:9px; color:#6b826a;">Tier:</label><input type="number" id="edit-star-tier" value="${s.industry_tier || 0}" style="font-size:10px; margin:2px 0;"></div></div>
                        <div style="display:flex; gap:6px; margin-top:4px;"><div style="flex:1;"><label style="font-size:9px; color:#6b826a;">Multiplicity:</label><select id="edit-star-multi" style="font-size:9px; margin:2px 0;"><option value="Single" ${(s.multiType||'Single')==='Single'?'selected':''}>Single Star</option><option value="Binary" ${s.multiType==='Binary'?'selected':''}>Binary Stars</option><option value="Trinary" ${s.multiType==='Trinary'?'selected':''}>Trinary Stars</option></select></div><div style="flex:1;"><label style="font-size:9px; color:#6b826a;">Hazard:</label><select id="edit-star-hazard" style="font-size:9px; margin:2px 0; background:#0a1410; color:#ffaa00; border-color:#ffaa00;"><option value="None" ${(s.hazard||'None')==='None'?'selected':''}>Clear Sector (No Hazards)</option><option value="Nebula" ${s.hazard==='Nebula'?'selected':''}>Dense Nebula (Shields Offline / EMCON)</option><option value="Pulsar" ${s.hazard==='Pulsar'?'selected':''}>Pulsar Radiation (Double Weapon Overheat)</option><option value="Gravity Well" ${s.hazard==='Gravity Well'?'selected':''}>High Gravity Accretion (2x FTL Fuel Cost)</option></select></div></div>
                        <div style="margin-top:6px; border-top:1px solid #3c4e36; padding-top:6px;"><div style="display:flex; justify-content:space-between; align-items:center;"><span style="font-size:10px; color:#00e5a3; font-weight:bold;">Planet Manifest</span><button class="btn-reveal" onclick="window.addEditStarPlanetRow()" style="font-size:9px; padding:2px 8px; width:auto; margin:0;">+ ADD PLANET</button></div><div id="edit-star-planets-container">${window.buildEditStarPlanetsHtml()}</div></div>
                        <button class="btn-reveal" onclick="window.saveDMStarProperties('${s.id}')" style="font-size:9px; padding:6px; margin-top:6px; width:100%;">SAVE SYSTEM</button>
                        <button class="btn-remove" onclick="window.deleteStarSystem('${s.id}')" style="font-size:9px; padding:4px; margin-top:4px;">DESTROY</button></div>`;
                } else {
                    dmEditorBox = `<div style="background:#040605; border:1px solid #ff3366; padding:8px; margin-top:8px; border-radius:2px;">
                        <span style="font-size:9px; color:#ff6b6b; font-weight:bold;">🛠️ SYSTEM CONTROL OVERRIDE</span>
                        ${ownershipControlFields}
                        <button class="btn-reveal" onclick="window.saveDMSystemOwnershipControl('${s.id}')" style="font-size:9px; padding:6px; margin-top:6px; width:100%;">SAVE</button></div>`;
                }
            }

            if (fowTier === 1) {
                content.innerHTML = `<div style="font-size: 11px;">${lockStatusHtml}<br><strong style="color: #6b826a; font-size: 13px;">[UNKNOWN CONTACT]</strong><br><span style="color: #6b826a;">Coordinates:</span> X: ${Math.round(s.x)}, Y: ${Math.round(s.y)}<br><span style="color: #ff3333; font-size:9px; margin-top:6px; display:block;">⚠ OUT OF SENSOR RANGE</span><div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''} ${bookmarkBtn}</div>${dmEditorBox}</div>`;
            } else if (fowTier === 2) {
                let bodies = window.getSystemBodies(s).length; let dradisBtn = `<button class="btn-deploy" onclick="window.executeDradisScan('${s.id}')" style="font-size:9px; padding:6px; margin-top:6px; width:100%;">📡 EXECUTE DRADIS SCAN (EST: ${2 + bodies} HRS)</button>`;
                content.innerHTML = `<div style="font-size: 11px;">${lockStatusHtml}<br><strong style="color: #ffaa00; font-size: 13px;">${s.type === 'Black Hole' ? '🕳️' : '⭐'} ${window.getDisplaySystemName(s)}</strong><br><span style="color: #6b826a;">Class:</span> ${s.luminosity || 'Standard'} (${s.multiType || 'Single'})<br><span style="color: #6b826a;">Orbital Bodies Detected:</span> ${bodies}<br><span style="color: #ffaa00; font-size:9px; margin-top:6px; display:block;">⚠ AWAITING DEEP SCAN FOR SURFACE TELEMETRY</span>${dradisBtn}<div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''} ${bookmarkBtn}</div>${dmEditorBox}${personalLabelBox}</div>`;
            } else {
                let hazardBadge = s.hazard && s.hazard !== 'None' ? `<span style="color:#ff3333; font-weight:bold; display:block; margin:2px 0;">⚠️ HAZARD: ${s.hazard.toUpperCase()}</span>` : '';
                content.innerHTML = `<div style="font-size: 11px;">${lockStatusHtml}<br><strong style="color: #00e5a3; font-size: 13px;">${s.type === 'Black Hole' ? '🕳️' : '⭐'} ${window.getDisplaySystemName(s)}</strong><br><span style="color: #6b826a;">Class:</span> ${s.luminosity || 'Standard'} (${s.multiType || 'Single'})<br>${hazardBadge}<span style="color: #6b826a;">Ownership:</span> ${s.ownership || 'Unclaimed'}<br><span style="color: #6b826a;">Control:</span> ${s.control || 'None'}<br><span style="color: #00e5a3; font-size:9px; margin-top:6px; display:block;">✓ DRADIS TELEMETRY COMPLETE</span><div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''} ${bookmarkBtn}</div>${dmEditorBox}${personalLabelBox}</div>`;
            }
        } else if (dynamicTarget.type === 'ship') {
            // IFF comes from ship_markers.iff and may be null (never tagged):
            // null shows no tag (like window.renderIffBadge), and the DM
            // dropdown has an "Unset" option to clear it.
            const m = dynamicTarget.data; let iff = m.iff || null; let iffColor = iff ? ((window.IFF_COLORS && window.IFF_COLORS[iff]) || '#00e1ff') : '#6b826a'; let iffTag = iff ? ` [${iff.toUpperCase()}]` : '';

            let driveOptionsHtml = ''; Object.keys(driveSpeeds).forEach(k => { driveOptionsHtml += `<option value="${k}" ${m.drive_type === k ? 'selected' : ''}>${driveSpeeds[k].label}</option>`; });
            let dmIffBox = currentUserRole === 'dm' ? `<div style="margin:4px 0;"><label style="color: #6b826a; font-size:10px;">IFF Tag:</label><select onchange="window.updateShipIff('${m.id}', this.value)" style="font-size:10px; padding:2px; background:#0a1410; color:${iffColor}; border:1px solid ${iffColor}; margin:2px 0;"><option value="" ${!iff ? 'selected' : ''} style="color:#6b826a;">-- Unset --</option><option value="friendly" ${iff === 'friendly' ? 'selected' : ''} style="color:#00e5a3;">✓ Friendly</option><option value="neutral" ${iff === 'neutral' ? 'selected' : ''} style="color:#c9962f;">◌ Neutral</option><option value="hostile" ${iff === 'hostile' ? 'selected' : ''} style="color:#ff3333;">⚠ Hostile</option></select></div>` : '';

            let jumpPlotterBox = '';
            if (window.jumpPlottingActive && window.activeJumpShip && window.activeJumpShip.id === m.id) {
                let targetInfo = window.jumpTargetPoint ? `Target: <strong>${window.jumpTargetPoint.name || 'Custom Vector'}</strong> (X: ${Math.round(window.jumpTargetPoint.x)}, Y: ${Math.round(window.jumpTargetPoint.y)})` : `<span style="color:#ffaa00;">Click on any star or map sector to lock target coordinates...</span>`;
                let calcTimeStr = '';
                if (window.jumpTargetPoint) {
                    let dist = Math.hypot(window.jumpTargetPoint.x - m.x, window.jumpTargetPoint.y - m.y);
                    let fuelCost = window.selectedDriveSpeed < 50 ? 0 : Math.max(1, Math.round(dist / 100));
                    // Must mirror executePlottedJump's time-inversion math exactly.
                    let driftDist = dist;
                    let gwHit = (typeof window.checkShipHazards === 'function') ? window.checkShipHazards(m).find(h => h.type === 'gravity_well') : null;
                    if (gwHit) driftDist = driftDist * (1 + (0.5 * (gwHit.intensity || 1)));
                    let isFtlPreview = window.selectedDriveTypeKey !== 'sublight';
                    let rawDrift = (isFtlPreview || !window.jumpInversionFtlOnly) ? (driftDist * window.selectedDriveSpeed / window.TEMPORAL_DRIFT_CONSTANT) : 0;
                    let driftPreview = rawDrift > 0 ? Math.min(window.JUMP_TIME_INVERSION_MAX_HOURS, Math.max(1, Math.round(rawDrift))) : 0;
                    let driftLine = driftPreview > 0 ? `Chronometer Drift: <strong style="color:#ff66ff;">-${driftPreview}h${rawDrift > window.JUMP_TIME_INVERSION_MAX_HOURS ? ' [CAPPED]' : ''}</strong> (arrive before departure)` : `Chronometer Drift: <strong>None</strong> (sublight)`;
                    calcTimeStr = `<div style="font-size:10px; color:#00e5a3; margin:4px 0; background:#030403; padding:6px; border:1px solid #3c4e36;">Distance: ${dist.toFixed(1)} u<br>${driftLine}<br><span style="color:#ffaa00;">Fuel Cost: ${fuelCost} Energy Cores</span></div>`;
                }
                jumpPlotterBox = `<div style="background:#040605; border:1px solid #00e1ff; padding:8px; margin-top:8px; border-radius:2px;"><span style="font-size:9px; color:#00e1ff; font-weight:bold;">🌌 JUMP VECTOR PLOTTER</span><div style="font-size:10px; color:#d4c5a9; margin:4px 0;">${targetInfo}</div><label style="font-size:9px; color:#6b826a; display:block; margin-top:4px;">Drive System Override:</label><select onchange="window.setDriveSpeedKey(this.value)" style="font-size:9px; margin:2px 0; background:#0a1410; color:#00e1ff;">${driveOptionsHtml}</select>${calcTimeStr}<div style="display:flex; gap:6px; margin-top:6px;"><button class="btn-reveal" onclick="window.executePlottedJump()" ${!window.jumpTargetPoint ? 'disabled style="opacity:0.5;"' : ''} style="flex:2; font-size:9px; padding:6px;">🚀 EXECUTE JUMP</button><button class="btn-remove" onclick="window.cancelJumpPlotting()" style="flex:1; font-size:9px; padding:6px;">CANCEL</button></div></div>`;
            } else if (isLocked) { jumpPlotterBox = `<button class="btn-deploy" onclick="window.startJumpPlottingMode()" style="font-size:9px; padding:6px; margin-top:6px;">🌌 PLOT JUMP VECTOR</button>`; }

            // DOCKING BAY: an undock button for a docked sub-craft (reachable via
            // search/bookmarks/recents), or for an independent ship, a list of
            // docked craft plus a dock control.
            let dockingBox = '';
            if (m.docked_to) {
                const master = globalShipMarkersCache.find(s => s.id === m.docked_to);
                dockingBox = `<div style="background:#040605; border:1px solid #4a7ab5; padding:8px; margin-top:8px; border-radius:2px;">
                    <span style="font-size:9px; color:#a2c4f5; font-weight:bold;">🔗 DOCKED</span>
                    <div style="font-size:10px; color:#d4c5a9; margin:4px 0;">Attached to <strong>${master ? master.name : 'Unknown'}</strong> — not an independent map token while docked.</div>
                    <button class="btn-remove" onclick="window.undockShip('${m.id}')" style="font-size:9px; padding:4px; width:100%;">DETACH & OPERATE INDEPENDENTLY</button>
                </div>`;
            } else {
                const dockedHere = globalShipMarkersCache.filter(s => s.docked_to === m.id);
                const otherIndependentShips = globalShipMarkersCache.filter(s => s.id !== m.id && !s.docked_to);
                let dockedListHtml = dockedHere.length === 0
                    ? `<span style="font-size:9px; color:#6b826a;">No craft currently docked.</span>`
                    : dockedHere.map(s => `<div style="display:flex; justify-content:space-between; align-items:center; font-size:9px; color:#d4c5a9; margin-bottom:3px;"><span>${s.name}</span><button class="layer-del" onclick="window.undockShip('${s.id}')" style="padding:1px 6px; font-size:8px;">DETACH</button></div>`).join('');
                let dockOptionsHtml = otherIndependentShips.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
                dockingBox = `<div style="background:#040605; border:1px solid #4a7ab5; padding:8px; margin-top:8px; border-radius:2px;">
                    <span style="font-size:9px; color:#a2c4f5; font-weight:bold;">🔗 DOCKING BAY</span>
                    <div style="margin:4px 0;">${dockedListHtml}</div>
                    ${otherIndependentShips.length > 0 ? `<div style="display:flex; gap:4px; margin-top:4px;">
                        <label for="dock-select-${m.id}" style="display:none;">Dock Vessel</label>
                        <select id="dock-select-${m.id}" style="flex:1; margin:0; font-size:9px; padding:3px;">${dockOptionsHtml}</select>
                        <button class="btn-reveal" onclick="window.dockShipToMaster(document.getElementById('dock-select-${m.id}').value, '${m.id}')" style="width:auto; margin:0; padding:4px 8px; font-size:9px;">DOCK</button>
                    </div>` : ''}
                </div>`;
            }

            const hazardHits = window.checkShipHazards(m);
            let hazardBox = '';
            if (hazardHits.length > 0) {
                const hazardLabels = { pulsar: '☢️ PULSAR RADIATION — weapons overheating faster', nebula: '🌫️ DENSE NEBULA — sensor emissions masked', gravity_well: '🌀 GRAVITY WELL — jump time drift stretched' };
                hazardBox = `<div style="background:#1a0808; border:1px solid #ff3333; padding:6px; margin-top:6px; border-radius:2px;">
                    <span style="font-size:9px; color:#ff6b6b; font-weight:bold;">⚠️ ENVIRONMENTAL HAZARD</span>
                    ${hazardHits.map(h => `<div style="font-size:9px; color:#ffaaaa; margin-top:2px;">${hazardLabels[h.type] || h.type.toUpperCase()}</div>`).join('')}
                </div>`;
            }

            content.innerHTML = `<div style="font-size: 11px;">${lockStatusHtml}<br><strong style="color: ${iffColor}; font-size: 13px;">🚀 ${m.name}${iffTag}</strong><br><span style="color: #6b826a;">Position:</span> X: ${Math.round(m.x)}, Y: ${Math.round(m.y)}<br><div style="margin:4px 0;"><label style="color: #6b826a; font-size:10px;">Engine Drive:</label><select onchange="window.updateShipDriveType('${m.id}', this.value)" style="font-size:10px; padding:2px; background:#0a1410; color:#00e1ff; margin:2px 0;">${driveOptionsHtml}</select></div>${dmIffBox}<div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''} ${bookmarkBtn}</div>${jumpPlotterBox}${dockingBox}${hazardBox}<button class="btn-deploy" onclick="window.openFullVesselTerminal('${m.id}')" style="font-size:9px; padding:4px; margin-top:6px;">⚙️ INSPECT VESSEL DECK</button>${(currentUserRole === 'dm' || window.vesselHasOwner(m, currentUserId)) ? `<button class="btn-remove" onclick="window.deleteShipToken('${m.id}')" style="font-size:9px; padding:4px; margin-top:4px;">DECOMMISSION</button>` : ''}</div>`;
        } else if (dynamicTarget.type === 'body') {
            const p = dynamicTarget.data;
            let dmBodyEditorBox = currentUserRole === 'dm' ? `<div style="background:#040605; border:1px solid #ff3366; padding:8px; margin-top:8px; border-radius:2px;"><span style="font-size:9px; color:#ff6b6b; font-weight:bold;">🛠️ OVERSEER PLANET EDITOR</span><label style="font-size:9px; color:#6b826a; display:block; margin-top:4px;">Designation:</label><input type="text" id="edit-body-name" value="${p.name}" style="font-size:10px; margin:2px 0;"><div style="display:flex; gap:6px;"><div style="flex:1;"><label style="font-size:9px; color:#6b826a;">Body Type:</label><select id="edit-body-type" style="font-size:9px; margin:2px 0;"><option value="Terrestrial" ${p.type==='Terrestrial'?'selected':''}>Terrestrial</option><option value="Gas Giant" ${p.type==='Gas Giant'?'selected':''}>Gas Giant</option><option value="Ice World" ${p.type==='Ice World'?'selected':''}>Ice World</option><option value="Barren Rock" ${p.type==='Barren Rock'?'selected':''}>Barren Rock</option><option value="Volcanic" ${p.type==='Volcanic'?'selected':''}>Volcanic</option></select></div><div style="flex:1;"><label style="font-size:9px; color:#6b826a;">Gravity:</label><input type="text" id="edit-body-gravity" value="${p.gravity}" style="font-size:10px; margin:2px 0;"></div></div><label style="font-size:9px; color:#6b826a; display:block;">Atmosphere:</label><input type="text" id="edit-body-atmosphere" value="${p.atmosphere}" style="font-size:10px; margin:2px 0;"><label style="font-size:9px; color:#6b826a; display:block;">Scans:</label><textarea id="edit-body-resources" rows="2" style="font-size:10px; margin:2px 0;">${p.resources}</textarea><button class="btn-reveal" onclick="window.saveDMBodyProperties('${p.id}')" style="font-size:9px; padding:6px; margin-top:6px; width:100%;">APPLY SCANS</button>${(window.globalPlanetaryModifiersCache && window.globalPlanetaryModifiersCache[p.id]) ? `<button class="btn-remove" onclick="window.deletePlanetOverride('${p.id}')" style="font-size:9px; padding:4px; margin-top:4px; width:100%;">🗑️ CLEAR OVERRIDE (revert to default)</button>` : ''}</div>` : '';
            // Personal label editor, shown to every user. p.name may already
            // be the personal label (applyPlanetaryOverrides), so the input
            // reads the raw label from the cache instead.
            const myPersonalBodyLabel = (window.globalPersonalLabelsCache || {})[`body:${p.id}`] || '';
            const canonicalBodyName = (window.globalPlanetaryModifiersCache && window.globalPlanetaryModifiersCache[p.id] && window.globalPlanetaryModifiersCache[p.id].custom_name) || p.name;
            const personalBodyLabelBox = `<div style="background:#040605; border:1px solid #3c4e36; padding:6px; margin-top:8px; border-radius:2px;">
                <span style="font-size:9px; color:#6b826a;">📝 Personal Label (only you see this):</span>
                <div style="display:flex; gap:4px; margin-top:4px;">
                    <input type="text" id="personal-label-body-${p.id}" value="${myPersonalBodyLabel}" placeholder="${canonicalBodyName}" style="flex:1; font-size:10px; margin:0;">
                    <button class="btn-reveal" onclick="window.savePersonalLabel('body', '${p.id}', document.getElementById('personal-label-body-${p.id}').value)" style="width:auto; padding:4px 8px; font-size:9px; margin:0;" title="Leave blank and click SET to clear your personal label">SET</button>
                </div>
            </div>`;
            content.innerHTML = `<div style="font-size: 11px;">${lockStatusHtml}<br><strong style="color: ${p.color}; font-size: 13px;">🪐 ${p.name}</strong><br><span style="color: #6b826a;">System:</span> ${window.getDisplaySystemName(p.parentSystem)}<br><span style="color: #6b826a;">Class:</span> ${p.type} | <span style="color: #6b826a;">Grav:</span> ${p.gravity}<br><span style="color: #00e5a3; font-weight:bold; margin-top:4px; display:block;">Scans:</span> <span style="color: #d4c5a9;">${p.resources}</span><div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''} ${bookmarkBtn}</div>${dmBodyEditorBox}${personalBodyLabelBox}</div>`;
        }
    };

    function render() {
        const cssWidth = container.clientWidth; const cssHeight = container.clientHeight;
        ctx.fillStyle = '#010201'; ctx.fillRect(0, 0, cssWidth, cssHeight);
        ctx.save(); ctx.translate(cssWidth / 2 + window.camera.x, cssHeight / 2 + window.camera.y); ctx.scale(window.camera.zoom, window.camera.zoom);

        const time = Date.now();
        const hw = cssWidth / (2 * window.camera.zoom); const hh = cssHeight / (2 * window.camera.zoom);
        const cx = -window.camera.x / window.camera.zoom; const cy = -window.camera.y / window.camera.zoom;

        let _gridSpacing = null;
        if (window.tacticalGridEnabled !== false) { _gridSpacing = drawTacticalGrid(ctx, cx, cy, hw, hh, window.camera.zoom); }
        drawHazardZones(ctx, cx, cy, hw, hh, window.camera.zoom, time);

        if (window.camera.zoom < 0.8) { let coreGrd = ctx.createRadialGradient(0, 0, 100, 0, 0, 1800); coreGrd.addColorStop(0, 'rgba(118, 148, 255, 0.12)'); coreGrd.addColorStop(0.5, 'rgba(0, 229, 163, 0.04)'); coreGrd.addColorStop(1, 'rgba(0, 0, 0, 0)'); ctx.fillStyle = coreGrd; ctx.beginPath(); ctx.arc(0, 0, 1800, 0, Math.PI * 2); ctx.fill(); }

        let allSystems = proceduralSystems.concat(globalDbSystemsCache);

        if (window.hyperlanesVisible) {
            updateHyperlaneDiscovery();
            globalHyperlanesCache.forEach(route => {
                if (!route.nodes || route.nodes.length < 2) return;
                // A segment draws only once BOTH endpoint nodes are
                // discovered, so a partly explored route draws partly.
                for (let k = 0; k < route.nodes.length - 1; k++) {
                    const a = route.nodes[k], b = route.nodes[k + 1];
                    // The DM sees every segment; the discovered set is for players only.
                    if (currentUserRole !== 'dm' && (!window.discoveredHyperlaneNodes.has(hyperlaneNodeKey(route, a, k)) || !window.discoveredHyperlaneNodes.has(hyperlaneNodeKey(route, b, k + 1)))) continue;
                    ctx.save(); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
                    ctx.strokeStyle = route.color || '#00e1ff'; ctx.lineWidth = 3 / window.camera.zoom; ctx.shadowColor = route.color || '#00e1ff'; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0; ctx.restore();
                }
            });
        }

        if (window.hyperlaneDrawActive && window.activeHyperlaneNodes.length > 0) {
            ctx.save(); ctx.strokeStyle = '#00e1ff'; ctx.lineWidth = 3 / window.camera.zoom; ctx.beginPath(); ctx.moveTo(window.activeHyperlaneNodes[0].x, window.activeHyperlaneNodes[0].y);
            for (let k = 1; k < window.activeHyperlaneNodes.length; k++) { ctx.lineTo(window.activeHyperlaneNodes[k].x, window.activeHyperlaneNodes[k].y); }
            if (window._lastMouseWorldX !== undefined) { ctx.lineTo(window._lastMouseWorldX, window._lastMouseWorldY); }
            ctx.stroke(); window.activeHyperlaneNodes.forEach((v) => { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(v.x, v.y, 4 / window.camera.zoom, 0, Math.PI * 2); ctx.fill(); }); ctx.restore();
        }

        /* TERRITORIES: '[HIDDEN]' territories are drawn only for the DM (dashed, fainter). */
        globalTerritoriesCache.forEach(t => {
            if (!t.vertices || t.vertices.length < 3) return;
            
            let isHidden = t.faction_name && t.faction_name.includes('[HIDDEN]');
            if (isHidden && currentUserRole !== 'dm') return;

            ctx.save(); ctx.beginPath(); ctx.moveTo(t.vertices[0].x, t.vertices[0].y);
            for (let k = 1; k < t.vertices.length; k++) { ctx.lineTo(t.vertices[k].x, t.vertices[k].y); }
            ctx.closePath(); 
            
            ctx.fillStyle = t.color + (isHidden ? '11' : '22'); ctx.fill();
            ctx.strokeStyle = t.color; ctx.lineWidth = 2 / window.camera.zoom; 
            
            if (isHidden) ctx.setLineDash([10 / window.camera.zoom, 10 / window.camera.zoom]);
            
            ctx.shadowColor = t.color; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
            ctx.setLineDash([]); 

            if (window.camera.zoom > 0.04) {
                let avgX = t.vertices.reduce((sum, v) => sum + v.x, 0) / t.vertices.length; let avgY = t.vertices.reduce((sum, v) => sum + v.y, 0) / t.vertices.length;
                let displayFaction = t.faction_name ? t.faction_name.replace('[HIDDEN] ', '').replace('[HIDDEN]', '') : '';
                
                ctx.fillStyle = t.color; ctx.font = `bold ${Math.max(10, 14 / window.camera.zoom)}px Courier New`; ctx.textAlign = 'center'; 
                ctx.fillText(`⬡ ${(t.name || 'Sector').toUpperCase()}${isHidden ? ' (HIDDEN)' : ''}`, avgX, avgY);
                if (displayFaction) { ctx.font = `${Math.max(8, 10 / window.camera.zoom)}px Courier New`; ctx.fillText(`[${displayFaction}]`, avgX, avgY + (14 / window.camera.zoom)); }
                ctx.textAlign = 'left';
            }
            ctx.restore();
        });

        if (window.territoryDrawActive && window.activeTerritoryVertices.length > 0) {
            ctx.save(); const drawColor = document.getElementById('territory-color-input')?.value || '#00e5a3';
            ctx.strokeStyle = drawColor; ctx.lineWidth = 2 / window.camera.zoom; ctx.setLineDash([6, 6]);
            ctx.beginPath(); ctx.moveTo(window.activeTerritoryVertices[0].x, window.activeTerritoryVertices[0].y);
            for (let k = 1; k < window.activeTerritoryVertices.length; k++) { ctx.lineTo(window.activeTerritoryVertices[k].x, window.activeTerritoryVertices[k].y); }
            if (window._lastMouseWorldX !== undefined) { ctx.lineTo(window._lastMouseWorldX, window._lastMouseWorldY); }
            ctx.stroke(); ctx.setLineDash([]);
            window.activeTerritoryVertices.forEach((v, idx) => { ctx.fillStyle = idx === 0 ? '#ffaa00' : '#ffffff'; ctx.beginPath(); ctx.arc(v.x, v.y, (idx === 0 ? 6 : 4) / window.camera.zoom, 0, Math.PI * 2); ctx.fill(); });
            if (window.activeTerritoryVertices.length >= 3 && window._lastMouseWorldX !== undefined && Math.hypot(window._lastMouseWorldX - window.activeTerritoryVertices[0].x, window._lastMouseWorldY - window.activeTerritoryVertices[0].y) < 30 / window.camera.zoom) {
                ctx.strokeStyle = '#ffaa00'; ctx.lineWidth = 2 / window.camera.zoom; ctx.beginPath(); ctx.arc(window.activeTerritoryVertices[0].x, window.activeTerritoryVertices[0].y, (12 + Math.sin(time * 0.012) * 5) / window.camera.zoom, 0, Math.PI * 2); ctx.stroke();
            }
            ctx.restore();
        }

        // RENDER PINGS
        window.activePings = window.activePings.filter(p => time - p.startTime < 3000);
        window.activePings.forEach(p => {
            let life = (time - p.startTime) / 3000;
            let pSize = (20 + (life * 60)) / window.camera.zoom;
            ctx.strokeStyle = p.color; ctx.lineWidth = 2 / window.camera.zoom; ctx.globalAlpha = 1.0 - life;
            ctx.beginPath(); ctx.arc(p.x, p.y, pSize, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1.0;
        });

        // Only one system is "in focus" for full orbital detail (the one
        // nearest the camera center), so dense clusters don't overlap.
        // Also anchors the DRADIS radar overlay.
        let focusedSystemId = null; let focusedSystemObj = null;
        if (window.camera.zoom > SYSTEM_ZOOM_THRESHOLD) {
            let nearestDist = Infinity;
            for (let s of allSystems) {
                if (!systemCanHaveBodies(s)) continue;
                let d = Math.hypot(s.x - cx, s.y - cy);
                if (d < nearestDist) { nearestDist = d; focusedSystemId = s.id; focusedSystemObj = s; }
            }
            // A selected star wins focus over raw distance, but only while it
            // is on screen (same hw+200/hh+200 cull bounds as below).
            const sel = window.selectedTarget;
            if (sel && sel.type === 'star' && systemCanHaveBodies(sel.data) && Math.abs(sel.data.x - cx) <= hw + 200 && Math.abs(sel.data.y - cy) <= hh + 200) {
                focusedSystemObj = sel.data; focusedSystemId = sel.data.id;
            }
        }
        window._radarFocusedSystem = focusedSystemObj;

        for (let s of allSystems) {
            if (Math.abs(s.x - cx) > hw + 200 || Math.abs(s.y - cy) > hh + 200) continue;
            let fowTier = window.getFowTier(s);

            if (fowTier === 1) {
                ctx.fillStyle = '#2a3b32'; ctx.beginPath(); ctx.arc(s.x, s.y, 4 / window.camera.zoom, 0, Math.PI * 2); ctx.fill();
            } else {
                if (s.type === 'Nebula' || s.hazard === 'Nebula') {
                    let grd = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.size * 1.8);
                    grd.addColorStop(0, (s.color || '#33ccff') + '44'); grd.addColorStop(1, (s.color || '#33ccff') + '00');
                    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 1.8, 0, Math.PI * 2); ctx.fill();
                } else if (s.type === 'Black Hole') {
                    ctx.fillStyle = '#000000'; ctx.shadowColor = `rgba(100, 50, 255, 0.9)`; ctx.shadowBlur = 18; ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
                } else {
                    ctx.fillStyle = s.color; ctx.shadowColor = s.hazard === 'Pulsar' ? '#ff3366' : s.color; ctx.shadowBlur = s.hazard === 'Pulsar' ? (12 + Math.sin(time * 0.01) * 6) : 8;
                    ctx.beginPath(); ctx.arc(s.x, s.y, s.size / (s.isCustom ? window.camera.zoom : 1), 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
                }
                if (window.camera.zoom > 0.15 && window.camera.zoom <= SYSTEM_ZOOM_THRESHOLD && s.type !== 'Nebula') {
                    ctx.fillStyle = s.isCustom ? `rgba(0, 229, 163, 0.8)` : `rgba(107, 130, 106, 0.8)`; ctx.font = `${Math.max(10, 12 / window.camera.zoom)}px Courier New`; ctx.fillText(window.getDisplaySystemName(s), s.x + 10, s.y + 4);
                }
            }

            if (window.camera.zoom > SYSTEM_ZOOM_THRESHOLD && systemCanHaveBodies(s) && fowTier === 3 && s.id === focusedSystemId) {
                for (let b of window.getSystemBodies(s)) {
                    let angle = b.baseAngle + (time * b.speed); let bx = s.x + Math.cos(angle) * b.radius; let by = s.y + Math.sin(angle) * b.radius;
                    ctx.beginPath(); ctx.arc(s.x, s.y, b.radius, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(0, 229, 163, 0.12)'; ctx.lineWidth = 1 / window.camera.zoom; ctx.stroke();
                    ctx.fillStyle = b.color; ctx.beginPath(); ctx.arc(bx, by, b.size, 0, Math.PI * 2); ctx.fill();
                }
            }
        }

        for (let m of globalShipMarkersCache) {
            if (m.docked_to) continue; // docked craft render as part of their master, not as their own token
            // Battle-Map-only tokens (e.g. strike craft launched from the Battle
            // Map hangar) are real ship_markers rows but are not drawn here.
            if (m.hide_from_galaxy_map) continue;
            if (Math.abs(m.x - cx) > hw + 50 || Math.abs(m.y - cy) > hh + 50) continue;
            const size = 10 / window.camera.zoom; let iffColor = typeof window.getIffColor === 'function' ? window.getIffColor(m.iff) : '#00e1ff';

            // Ownership ring: mine / another player's / Overseer-NPC, so drag
            // permission is visible before you try.
            const isMine = window.vesselHasOwner(m, currentUserId);
            const ownerIds = window.vesselOwnerIds(m);
            const ownerProfiles = ownerIds.map(id => allProfiles.find(p => p.id === id)).filter(Boolean);
            const isNpcAsset = ownerProfiles.length === 0 || ownerProfiles.every(p => p.role === 'dm');
            let ringColor = isMine ? '#00e5a3' : (isNpcAsset ? '#ff6b6b' : '#4a7ab5');

            // Dense Nebula EMCON: a non-owned contact inside a nebula is drawn
            // faded with its identity withheld (not hidden). The DM sees it normally.
            const nebulaObscured = !isMine && currentUserRole !== 'dm' && window.checkShipHazards(m).some(h => h.type === 'nebula');
            let tokenAlpha = nebulaObscured ? 0.35 : 1;

            ctx.save();
            ctx.globalAlpha = tokenAlpha;
            ctx.beginPath(); ctx.arc(m.x, m.y, size + (5 / window.camera.zoom), 0, Math.PI * 2);
            ctx.strokeStyle = ringColor; ctx.lineWidth = (isMine ? 2 : 1.5) / window.camera.zoom;
            if (isNpcAsset) ctx.setLineDash([4 / window.camera.zoom, 3 / window.camera.zoom]);
            ctx.stroke(); ctx.setLineDash([]);
            ctx.restore();

            ctx.save();
            ctx.globalAlpha = tokenAlpha;
            ctx.fillStyle = iffColor; ctx.beginPath(); ctx.moveTo(m.x, m.y - size); ctx.lineTo(m.x + size, m.y); ctx.lineTo(m.x, m.y + size); ctx.lineTo(m.x - size, m.y); ctx.closePath(); ctx.fill();
            ctx.restore();

            // Label: dark outline keeps it legible on any background; font size
            // is clamped across zoom levels.
            ctx.save();
            ctx.globalAlpha = tokenAlpha;
            let labelSize = Math.max(9, Math.min(13, 11 / window.camera.zoom));
            ctx.font = `${labelSize}px Courier New`;
            ctx.textBaseline = 'middle';
            let labelX = m.x + size + (6 / window.camera.zoom);
            let labelY = m.y;
            let ownerTag = isMine ? '' : (isNpcAsset ? ' [NPC]' : ` [${ownerProfiles.map(p => p.username || 'ALLY').join('/')}]`);
            let dockedCount = globalShipMarkersCache.filter(d => d.docked_to === m.id).length;
            let dockTag = dockedCount > 0 ? ` 🔗${dockedCount}` : '';
            let fuelTag = '';
            if (m.is_strike_craft) {
                const parent = globalShipMarkersCache.find(p => p.id === m.parent_id);
                const sq = parent ? (parent.ship_deployed || []).find(s => s.id === m.squadron_id) : null;
                if (sq) fuelTag = ` ⛽${sq.loiter}`;
            }
            let labelText = nebulaObscured ? `UNKNOWN CONTACT` + dockTag : m.name + ownerTag + dockTag + fuelTag;
            ctx.lineWidth = 3 / window.camera.zoom;
            ctx.strokeStyle = 'rgba(3, 4, 6, 0.85)';
            ctx.strokeText(labelText, labelX, labelY);
            ctx.fillStyle = iffColor;
            ctx.fillText(labelText, labelX, labelY);
            ctx.restore();
        }

        if (window.jumpPlottingActive && window.activeJumpShip) {
            let targetX = window.jumpTargetPoint ? window.jumpTargetPoint.x : (window._lastMouseWorldX || window.activeJumpShip.x);
            let targetY = window.jumpTargetPoint ? window.jumpTargetPoint.y : (window._lastMouseWorldY || window.activeJumpShip.y);
            ctx.save(); ctx.strokeStyle = '#00e1ff'; ctx.lineWidth = 2 / window.camera.zoom; ctx.setLineDash([8, 6]);
            ctx.beginPath(); ctx.moveTo(window.activeJumpShip.x, window.activeJumpShip.y); ctx.lineTo(targetX, targetY); ctx.stroke(); ctx.setLineDash([]);
            ctx.beginPath(); ctx.arc(targetX, targetY, (16 + Math.sin(time * 0.008) * 4) / window.camera.zoom, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        }

        // MEASURE TOOL DISTANCE TEXT (100 units = 1 LY)
        if (window.measuringTapeActive && window.measureStartPoint) {
            ctx.strokeStyle = '#00e5a3'; ctx.lineWidth = 2 / window.camera.zoom; ctx.setLineDash([4, 4]);
            let endX = window.measureEndPoint ? window.measureEndPoint.x : (window._lastMouseWorldX || window.measureStartPoint.x);
            let endY = window.measureEndPoint ? window.measureEndPoint.y : (window._lastMouseWorldY || window.measureStartPoint.y);
            ctx.beginPath(); ctx.moveTo(window.measureStartPoint.x, window.measureStartPoint.y); ctx.lineTo(endX, endY); ctx.stroke(); ctx.setLineDash([]);
            
            let dist = Math.hypot(endX - window.measureStartPoint.x, endY - window.measureStartPoint.y);
            let ly = (dist / 100).toFixed(2); let days1c = (ly * 365.25).toFixed(1); let hrs = Math.max(1, Math.round(dist / 250));
            ctx.fillStyle = '#00e5a3'; ctx.font = `${Math.max(10, 12 / window.camera.zoom)}px Courier New`;
            ctx.fillText(`Dist: ${dist.toFixed(1)}u (${ly} LY) | Sublight: ${days1c}d | FTL: ~${hrs}h`, endX + 15 / window.camera.zoom, endY);
        }

        let dynamicTarget = window.selectedTarget || window.hoveredTarget;
        if (dynamicTarget && dynamicTarget.data) {
            let obj = dynamicTarget.data; let ox = obj.x, oy = obj.y;
            if (dynamicTarget.type === 'body') { let angle = obj.baseAngle + (time * obj.speed); ox = obj.parentSystem.x + Math.cos(angle) * obj.radius; oy = obj.parentSystem.y + Math.sin(angle) * obj.radius; }
            let isLocked = !!window.selectedTarget; let pulseSize = isLocked ? (14 + Math.sin(time * 0.006) * 4) : 12;
            ctx.strokeStyle = isLocked ? '#00e5a3' : '#ffaa00'; ctx.lineWidth = 2 / window.camera.zoom; if (!isLocked) ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.arc(ox, oy, pulseSize / window.camera.zoom, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        }

        ctx.restore();
        updateCicTelemetry(cx, cy, window.camera.zoom, _gridSpacing);
        updateRadarSweepPosition(cssWidth, cssHeight);
    }
    // The next frame is always scheduled, so one bad frame (e.g. a malformed
    // row) can't stop the map. Errors are logged at most every 5 s, and
    // resize() resets the canvas, clearing any unbalanced ctx.save() stack.
    let lastRenderErrorAt = 0;
    // Skip the redraw while the Battle Map overlay covers the galaxy or the
    // tab is hidden (the full redraw starved touch handling on phones).
    // Nothing time-critical lives in render(): the campaign clock runs on its
    // own interval (js/ui.js), and hyperlane discovery catches up when visible.
    const battleMapPanelEl = document.getElementById('battle-map-panel');
    function galaxyIsCovered() {
        if (document.hidden) return true;
        return !!(battleMapPanelEl && battleMapPanelEl.style.display === 'block');
    }
    function renderLoop() {
        try {
            if (!galaxyIsCovered()) render();
        } catch (err) {
            if (Date.now() - lastRenderErrorAt > 5000) console.error('Galaxy map frame failed (map keeps running):', err);
            lastRenderErrorAt = Date.now();
            try { resize(); } catch (_) {}
        }
        requestAnimationFrame(renderLoop);
    }
    renderLoop();
};
