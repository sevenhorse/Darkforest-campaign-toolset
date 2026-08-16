/* ==========================================================================
   js/map.js - Cartography, Map Tools, & FOW Engine (100% COMPLETE & VERIFIED)
   ========================================================================== */

window.camera = { x: 0, y: 0, zoom: 0.2, isDragging: false, startX: 0, startY: 0 };
window.draggedMarker = null; 
window.draggedStar = null;

window.measuringTapeActive = false; window.measureStartPoint = null; window.measureEndPoint = null;
window.pingModeActive = false; window.activePings = [];
window.jumpPlottingActive = false; window.activeJumpShip = null; window.jumpTargetPoint = null; window.selectedDriveSpeed = 250;
window.territoryToolActive = false; window.territoryDrawActive = false; window.activeTerritoryVertices = [];
window.hyperlaneDrawActive = false; window.activeHyperlaneNodes = [];

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
window.getSystemBodies = function(system) {
    if(system.type === 'Nebula') return [];
    if (system.custom_bodies && Array.isArray(system.custom_bodies) && system.custom_bodies.length > 0) { return system.custom_bodies.map((b, idx) => ({ ...b, id: b.id || `${system.id}-custom-${idx}`, baseAngle: b.baseAngle || (idx * 1.2), speed: b.speed || (0.0002 / (idx + 1)), parentSystem: system })); }
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

/* FOW ENGINE */
window.getFowTier = function(system) {
    if (window.scannedSystems && window.scannedSystems.includes(system.id)) return 3; // Tier 3
    let inRange = false;
    for (let m of globalShipMarkersCache) {
        if (m.owner_id === currentUserId || (m.cargo_inventory && m.cargo_inventory.iff === 'allied') || currentUserRole === 'dm') {
            if (Math.hypot(m.x - system.x, m.y - system.y) <= 300) { inRange = true; break; }
        }
    }
    return inRange ? 2 : 1;
};

/* DB SYNC & WIPES */
window.wipeGalaxySlate = async function() {
    if (currentUserRole !== 'dm') return; if (!confirm("Wipe all custom stars, ships, and territories?")) return;
    await db.from('star_systems').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('ship_markers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('territories').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    window.selectedTarget = null; if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

window.loadGalaxyData = async function() {
    const { data: starData } = await db.from('star_systems').select('*');
    if (starData) globalDbSystemsCache = starData.map(s => ({ ...s, isCustom: true, size: s.size || 5.0, type: s.luminosity === 'Black Hole' ? 'Black Hole' : (s.hazard === 'Nebula' ? 'Nebula' : 'Star'), multiType: s.multiType || 'Single', custom_bodies: s.custom_bodies || [] }));
    const { data: markerData } = await db.from('ship_markers').select('*');
    if (markerData) globalShipMarkersCache = markerData.map(m => ({ ...m, cargo_inventory: window.sanitizeCargo ? window.sanitizeCargo(m.cargo_inventory) : (m.cargo_inventory || {}), ship_weapons: m.ship_weapons || [], ship_decks: m.ship_decks || [] }));
};

/* SYSTEM ARCHITECT */
let architectPlanets = [];
window.openSystemArchitect = function() { if (currentUserRole !== 'dm') return; architectPlanets = []; document.getElementById('system-architect-modal').style.display = 'flex'; };
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

window.commitArchitectSystem = async function() {
    if (currentUserRole !== 'dm') return;
    const name = document.getElementById('arch-name').value || 'Target System'; const luminosity = document.getElementById('arch-lum').value; const multiType = document.getElementById('arch-multi').value; const hazard = document.getElementById('arch-hazard').value;
    let color = '#ffe9c4'; if (luminosity === 'Class M (Red Dwarf)') color = '#ffb37b'; if (luminosity === 'Class O (Blue Giant)') color = '#7694ff'; if (luminosity === 'Black Hole') color = '#000000'; if (luminosity === 'Hidden Anomaly') color = '#ff3333';
    let customBodiesClean = architectPlanets.map((p, idx) => ({ ...p, isStar: false, radius: 25 + (idx + 1) * 30, baseAngle: idx * 1.25, speed: 0.0002 / (idx + 1) }));
    const payload = { name, x: -window.camera.x / window.camera.zoom, y: -window.camera.y / window.camera.zoom, size: luminosity === 'Black Hole' ? 7.0 : 5.0, color, luminosity, multiType, hazard, ownership: 'Unclaimed', control: 'Uncontested', industry_tier: 1, custom_bodies: customBodiesClean };
    await db.from('star_systems').insert(payload); window.closeSystemArchitect(); if(typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
};

window.spawnTokenAtCenter = async function() {
    const driveType = document.getElementById('dm-tool-drivetype').value || 'ftl_class1'; 
    const name = document.getElementById('dm-tool-name').value || 'Task Force Black'; 
    const iffStatus = document.getElementById('dm-tool-iff') ? document.getElementById('dm-tool-iff').value : 'allied';
    
    let isJupiter = false;
    if (name.toLowerCase().includes("task force black") || name.toLowerCase().includes("horizon")) {
        isJupiter = confirm(`Deploy '${name}' as a Jupiter-Class Heavy Cruiser? (Auto-fills weapons, health, and decks)`);
    }
    
    let newCargo = typeof window.sanitizeCargo === 'function' ? window.sanitizeCargo({}) : {}; 
    newCargo.iff = iffStatus;
    
    let payload = { owner_id: currentUserId, name: name, drive_type: driveType, x: -window.camera.x / window.camera.zoom, y: -window.camera.y / window.camera.zoom, color: iffStatus === 'hostile' ? '#ff3333' : (iffStatus === 'neutral' ? '#ffaa00' : '#00e1ff'), cargo_inventory: newCargo };

    if (isJupiter) {
        payload.integrity_shields = 400; payload.max_shields = 400;
        payload.integrity_hull = 300; payload.max_hull = 300;
        payload.integrity_reactive = 10; payload.max_reactive = 10;
        payload.integrity_ablative = 10; payload.max_ablative = 10;
        payload.ship_weapons = [
            { loc: "Primary", name: "Gauss Cannons", dice: "1d10", modifier: "+0", explodes: false, ammo: 10, max_ammo: 10, cooldown: 0, overheat: 0 },
            { loc: "Turrets", name: "Dual Railguns", dice: "1d20", modifier: "+0", explodes: false, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0 },
            { loc: "Spinal", name: "Gamma Lance", dice: "1d20", modifier: "+0", explodes: true, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0 },
            { loc: "Tubes", name: "Ship Killer Tubes", dice: "1d12", modifier: "+0", explodes: false, ammo: 48, max_ammo: 48, cooldown: 0, overheat: 0 },
            { loc: "Tubes", name: "Capitol Killer Tubes", dice: "1d20", modifier: "+0", explodes: false, ammo: 24, max_ammo: 24, cooldown: 0, overheat: 0 },
            { loc: "PDC", name: "PDC Grid", dice: "1d4", modifier: "+0", explodes: false, ammo: 12, max_ammo: 12, cooldown: 0, overheat: 0 },
            { loc: "PDL", name: "PDL Grid", dice: "1d4", modifier: "+0", explodes: false, ammo: 12, max_ammo: 12, cooldown: 0, overheat: 0 },
            { loc: "PDG", name: "PDG Grid", dice: "1d4", modifier: "+0", explodes: false, ammo: 10, max_ammo: 10, cooldown: 0, overheat: 0 },
            { loc: "Turrets", name: "Flak Guns", dice: "1d6", modifier: "+0", explodes: false, ammo: 10, max_ammo: 10, cooldown: 0, overheat: 0 },
            { loc: "Turrets", name: "Rapid Plasma Repeaters", dice: "1d12", modifier: "+0", explodes: false, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0 },
            { loc: "Spinal", name: "Thanix Enforcer", dice: "2d20", modifier: "+5", explodes: true, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0 },
            { loc: "Spinal", name: "Spinal EMP Cannon", dice: "2d12", modifier: "+0", explodes: false, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0 }
        ];
        payload.ship_decks = [
            { name: "Bridge / CIC", hp: 100, max_hp: 100 },
            { name: "Engineering / Core", hp: 150, max_hp: 150 },
            { name: "Life Support", hp: 100, max_hp: 100 },
            { name: "Flight Deck / Hangars", hp: 120, max_hp: 120 },
            { name: "Manufacturing", hp: 100, max_hp: 100 }
        ];
    }
    await db.from('ship_markers').insert(payload); if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

window.spawnStarSystemAtCenter = async function() {
    const name = document.getElementById('dm-tool-name').value || 'New System'; const luminosity = document.getElementById('dm-tool-luminosity').value; const color = document.getElementById('dm-tool-color').value;
    await db.from('star_systems').insert({ name, x: -window.camera.x / window.camera.zoom, y: -window.camera.y / window.camera.zoom, size: 5.0, color, luminosity, ownership: 'Unclaimed', control: 'Uncontested', industry_tier: 1 });
    if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
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

window.startDrawingTerritory = function() { window.territoryDrawActive = true; window.activeTerritoryVertices = []; document.getElementById('btn-start-territory-draw').style.display = 'none'; document.getElementById('btn-finish-territory-draw').style.display = 'block'; document.getElementById('btn-cancel-territory-draw').style.display = 'block'; document.getElementById('territory-drawing-status').style.display = 'block'; window.updateToolButtonStyles(); };
window.finishActiveTerritory = async function() {
    if (window.activeTerritoryVertices.length < 3) { alert("Requires at least 3 nodes."); return; }
    const name = document.getElementById('territory-name-input').value || 'New Sector'; const color = document.getElementById('territory-color-input').value || '#00e5a3'; const faction = document.getElementById('territory-faction-select') ? document.getElementById('territory-faction-select').value : '';
    await db.from('territories').insert({ name, color, vertices: window.activeTerritoryVertices, faction_name: faction }); window.cancelDrawingTerritory(); if (typeof window.loadTerritories === 'function') window.loadTerritories();
};
window.cancelDrawingTerritory = function() { window.territoryDrawActive = false; window.activeTerritoryVertices = []; document.getElementById('btn-start-territory-draw').style.display = 'block'; document.getElementById('btn-finish-territory-draw').style.display = 'none'; document.getElementById('btn-cancel-territory-draw').style.display = 'none'; document.getElementById('territory-drawing-status').style.display = 'none'; window.updateToolButtonStyles(); };

window.toggleHyperlanes = function() {
    if (currentUserRole === 'dm') { const hBtn = document.getElementById('btn-start-hyperlane-draw'); if(hBtn && hBtn.style.display !== 'none') { window.hyperlanesVisible = !window.hyperlanesVisible; } } else { window.hyperlanesVisible = !window.hyperlanesVisible; }
    window.updateToolButtonStyles();
};

window.startDrawingHyperlane = function() { window.hyperlaneDrawActive = true; window.activeHyperlaneNodes = []; document.getElementById('btn-start-hyperlane-draw').style.display = 'none'; document.getElementById('btn-finish-hyperlane-draw').style.display = 'block'; document.getElementById('btn-cancel-hyperlane-draw').style.display = 'block'; document.getElementById('hyperlane-drawing-status').style.display = 'block'; window.updateToolButtonStyles(); };
window.finishActiveHyperlane = async function() {
    if (window.activeHyperlaneNodes.length < 2) { alert("Requires at least 2 nodes."); return; }
    await db.from('hyperlanes').insert({ name: 'Trade Route', color: '#00e1ff', nodes: window.activeHyperlaneNodes });
    window.cancelDrawingHyperlane(); if (typeof loadHyperlanes === 'function') loadHyperlanes();
};
window.cancelDrawingHyperlane = function() { window.hyperlaneDrawActive = false; window.activeHyperlaneNodes = []; document.getElementById('btn-start-hyperlane-draw').style.display = 'block'; document.getElementById('btn-finish-hyperlane-draw').style.display = 'none'; document.getElementById('btn-cancel-hyperlane-draw').style.display = 'none'; document.getElementById('hyperlane-drawing-status').style.display = 'none'; window.updateToolButtonStyles(); };

window.triggerTacticalPing = function(x, y) {
    if (!realtimeChannel) return;
    if (window.AudioEngine) window.AudioEngine.playPing();
    realtimeChannel.send({ type: 'broadcast', event: 'tactical_ping', payload: { x, y, username: allProfiles.find(p => p.id === currentUserId)?.username || 'Commander', color: currentUserRole === 'dm' ? '#ff6b6b' : '#00e5a3' } });
    window.activePings.push({ x, y, color: currentUserRole === 'dm' ? '#ff6b6b' : '#00e5a3', user: allProfiles.find(p => p.id === currentUserId)?.username || 'Commander', startTime: Date.now() });
    if(window.pingModeActive) window.togglePingMode();
};

window.updateToolButtonStyles = function() {
    const mBtn = document.getElementById('measuring-tape-toggle-btn'); const pBtn = document.getElementById('ping-tool-toggle-btn'); const tBtn = document.getElementById('territory-tool-toggle-btn'); const hBtn = document.getElementById('btn-start-hyperlane-draw');
    if(mBtn) { mBtn.style.borderColor = window.measuringTapeActive ? '#00e5a3' : '#3c4e36'; mBtn.style.color = window.measuringTapeActive ? '#00e5a3' : '#6b826a'; }
    if(pBtn) { pBtn.style.borderColor = window.pingModeActive ? '#00e5a3' : '#3c4e36'; pBtn.style.color = window.pingModeActive ? '#00e5a3' : '#6b826a'; }
    if(tBtn) { tBtn.style.borderColor = window.territoryDrawActive ? '#00e5a3' : '#3c4e36'; tBtn.style.color = window.territoryDrawActive ? '#00e5a3' : '#6b826a'; }
    if(hBtn) { hBtn.style.borderColor = window.hyperlaneDrawActive ? '#00e1ff' : '#4a7ab5'; hBtn.style.color = window.hyperlaneDrawActive ? '#00e1ff' : '#a2c4f5'; }
};

window.clearSelectedTarget = function() {
    window.selectedTarget = null;
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
};

/* --- JUMP PLOTTING, TARGETS, SAVES --- */
window.startJumpPlottingMode = function() {
    if (!window.selectedTarget || window.selectedTarget.type !== 'ship') return;
    window.jumpPlottingActive = true; window.measuringTapeActive = false; window.pingModeActive = false; window.territoryDrawActive = false; window.hyperlaneDrawActive = false;
    window.activeJumpShip = window.selectedTarget.data; window.jumpTargetPoint = null;
    window.selectedDriveSpeed = driveSpeeds[window.activeJumpShip.drive_type || 'ftl_class1'].speed;
    window.updateToolButtonStyles(); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};
window.cancelJumpPlotting = function() { window.jumpPlottingActive = false; window.activeJumpShip = null; window.jumpTargetPoint = null; if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };
window.setDriveSpeedKey = function(key) { if (driveSpeeds[key]) { window.selectedDriveSpeed = driveSpeeds[key].speed; if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); } };
window.updateShipDriveType = async function(shipId, newDriveType) { await db.from('ship_markers').update({ drive_type: newDriveType }).eq('id', shipId); let ship = globalShipMarkersCache.find(s => s.id === shipId); if (ship) ship.drive_type = newDriveType; if (window.activeJumpShip && window.activeJumpShip.id === shipId) { window.selectedDriveSpeed = driveSpeeds[newDriveType].speed; } if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };
window.updateShipIff = async function(shipId, newIff) { let ship = globalShipMarkersCache.find(s => s.id === shipId); if (!ship) return; let cargo = ship.cargo_inventory || {}; cargo.iff = newIff; await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', shipId); ship.cargo_inventory = cargo; if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };

window.executePlottedJump = async function() {
    if (!window.activeJumpShip || !window.jumpTargetPoint) return;
    let ship = window.activeJumpShip; let target = window.jumpTargetPoint;
    let dist = Math.hypot(target.x - ship.x, target.y - ship.y);
    let tripHours = Math.max(1, Math.round(dist / window.selectedDriveSpeed));
    let fuelCost = Math.max(1, Math.round(dist / 100)); if (window.selectedDriveSpeed < 50) fuelCost = 0;
    
    let cargo = ship.cargo_inventory || {}; let expendables = cargo.expendables || [];
    let fuelIdx = expendables.findIndex(i => i.name.toLowerCase().includes('energy core') || i.name.toLowerCase().includes('fuel'));
    
    if (fuelCost > 0) {
        if (fuelIdx >= 0 && expendables[fuelIdx].qty >= fuelCost) { expendables[fuelIdx].qty -= fuelCost; cargo.expendables = expendables; } 
        else { if (window.AudioEngine) window.AudioEngine.playError(); alert(`Insufficient Fuel! Requires ${fuelCost} Energy Cores.`); return; }
    }

    if (window.AudioEngine) window.AudioEngine.playWarp();
    let oldTime = window.universeTimeHours; window.universeTimeHours += tripHours; localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    if (typeof window.updateCalendarDisplay === 'function') window.updateCalendarDisplay();

    ship.x = target.x; ship.y = target.y; ship.cargo_inventory = cargo;
    await db.from('ship_markers').update({ x: target.x, y: target.y, cargo_inventory: cargo }).eq('id', ship.id);
    if(typeof checkAnomalyProximity === 'function') await checkAnomalyProximity(ship);
    if(typeof window.processTimeAdvancement === 'function') await window.processTimeAdvancement(oldTime, window.universeTimeHours);

    await db.from('chat_logs').insert({ sender_id: currentUserId, content: `🚀 [FTL JUMP] Vessel '${ship.name}' completed jump to ${target.name}. Trip: ${tripHours} hrs.`, message_type: 'text' });
    window.cancelJumpPlotting(); if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

window.toggleBookmarkSelected = function() {
    if (!window.selectedTarget || !window.selectedTarget.data) return;
    let existsIndex = bookmarkedTargets.findIndex(b => b.data.id === window.selectedTarget.data.id);
    if (existsIndex >= 0) { bookmarkedTargets.splice(existsIndex, 1); } else { bookmarkedTargets.push({ type: window.selectedTarget.type, data: window.selectedTarget.data }); }
    localStorage.setItem('odyssey_bookmarks', JSON.stringify(bookmarkedTargets)); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};
window.shareBookmarkToChat = function(name, type) { db.from('chat_logs').insert({ sender_id: currentUserId, content: `Shared Coordinate 📍 [${type.toUpperCase()}]: ${name}`, message_type: 'text' }); alert("Broadcasted to Comms!"); };
window.jumpToBookmark = function(index) { let b = bookmarkedTargets[index]; if (!b) return; window.selectedTarget = b; window.lockCameraOnSelected(); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };
window.deleteBookmark = function(index) { bookmarkedTargets.splice(index, 1); localStorage.setItem('odyssey_bookmarks', JSON.stringify(bookmarkedTargets)); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };
window.jumpToRecent = function(index) { let r = recentTargets[index]; if (!r) return; window.selectedTarget = r; window.lockCameraOnSelected(); if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); };

window.saveDMStarProperties = async function(id) {
    if (currentUserRole !== 'dm') return;
    const name = document.getElementById('edit-star-name').value; const ownership = document.getElementById('edit-star-ownership').value; const luminosity = document.getElementById('edit-star-luminosity').value; const tier = parseInt(document.getElementById('edit-star-tier').value) || 0;
    await db.from('star_systems').update({ name, ownership, luminosity, industry_tier: tier }).eq('id', id); alert("Parameters updated."); if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};
window.saveDMBodyProperties = function(id) {
    if (currentUserRole !== 'dm' || !window.selectedTarget || window.selectedTarget.type !== 'body') return;
    let b = window.selectedTarget.data; b.name = document.getElementById('edit-body-name').value; b.type = document.getElementById('edit-body-type').value; b.gravity = document.getElementById('edit-body-gravity').value; b.atmosphere = document.getElementById('edit-body-atmosphere').value; b.resources = document.getElementById('edit-body-resources').value;
    if(typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); alert("Celestial body updated locally.");
};
window.deleteStarSystem = async function(id) { if (currentUserRole !== 'dm') return; if(!confirm("Destroy star system?")) return; await db.from('star_systems').delete().eq('id', id); window.clearSelectedTarget(); if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData(); };
window.deleteShipToken = async function(id) { if (currentUserRole !== 'dm') return; if(!confirm("Decommission token?")) return; await db.from('ship_markers').delete().eq('id', id); window.clearSelectedTarget(); if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData(); };

/* --- THE CANVAS ENGINE --- */
window.initGalaxyEngine = function() {
    const canvas = document.getElementById('galaxyCanvas'); if (!canvas) return;
    const ctx = canvas.getContext('2d'); const container = document.getElementById('canvas-container');
    const SYSTEM_ZOOM_THRESHOLD = 1.5; const MAP_LIMIT = 18000;

    function resize() { const dpr = window.devicePixelRatio || 1; canvas.width = container.clientWidth * dpr; canvas.height = container.clientHeight * dpr; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr); }
    window.addEventListener('resize', resize); resize();
    
    const proceduralSystems = []; const rng = mulberry32(1048596); 
    const coreRadius = 1400; const galaxyRadius = 11000;
    
    proceduralSystems.push({ id: 'proc-core-blackhole', name: 'Sagittarius Prime', x: 0, y: 0, size: 10, color: '#000000', type: 'Black Hole', luminosity: 'Supermassive Singularity', hazard: 'Gravity Well', multiType: 'Single', ownership: 'Uninhabitable Core', isCustom: false });
    for (let i = 0; i < 240; i++) {
        let r = Math.pow(rng(), 0.7) * coreRadius + 120; let theta = rng() * Math.PI * 2; let x = Math.cos(theta) * r; let y = Math.sin(theta) * r; let heat = rng();
        let color = '#7694ff'; let luminosity = 'Class O (Blue Giant)'; let hazard = 'Pulsar';
        if (heat > 0.85) { color = '#000000'; luminosity = 'Singularity'; hazard = 'Gravity Well'; } else if (heat > 0.5) { color = '#ffe9c4'; luminosity = 'Class G (Yellow)'; hazard = 'None'; }
        proceduralSystems.push({ id: `proc-core-${i}`, name: `Core Sector-${2000 + i}`, x, y, size: rng() * 2.5 + 3.5, color, type: luminosity === 'Singularity' ? 'Black Hole' : 'Star', luminosity, hazard, multiType: rng() > 0.7 ? 'Binary' : 'Single', ownership: 'Galactic Core', isCustom: false });
    }
    for (let i = 0; i < 2400; i++) {
        let arm = i % 4; 
        let r = Math.pow(rng(), 0.6) * (galaxyRadius - coreRadius) + coreRadius;
        
        // 1.6 winding factor removes the "pointiness", making arms open up gracefully
        let spiralTheta = (Math.log(r / coreRadius) * 1.6) + ((arm * 2 * Math.PI) / 4);
        // Doubled scatter angle to widen the arms
        let finalTheta = spiralTheta + (rng() - 0.5) * (0.8 + (r / galaxyRadius) * 0.8);
        // Doubled radius scatter to fill the gaps between arms
        let finalR = r + (rng() - 0.5) * (400 + (r / galaxyRadius) * 800);
        // Increased outlier chance from 12% to 18% to seed the dark voids with rogue stars
        if (rng() > 0.82) { finalTheta = rng() * Math.PI * 2; finalR = rng() * galaxyRadius; }
        
        let x = Math.cos(finalTheta) * finalR; let y = Math.sin(finalTheta) * finalR;
        let type = 'Star'; let size = rng() * 2.0 + 3.0; let color = '#ffe9c4'; let luminosity = 'Class G (Yellow)'; let hazard = 'None';
        
        let starRoll = rng();
        if (starRoll > 0.985) { type = 'Black Hole'; color = '#000000'; size = 6.5; luminosity = 'Singularity'; hazard = 'Gravity Well'; } 
        else if (starRoll > 0.94) { type = 'Nebula'; color = ['#ff3366', '#33ccff', '#cc33ff', '#33ff99'][Math.floor(rng() * 4)]; size = 120 + rng() * 120; luminosity = 'Gas Cloud'; hazard = 'Nebula'; } 
        else { let heat = rng(); if (heat > 0.75) { color = '#7694ff'; luminosity = 'Class O (Blue Giant)'; if (rng() > 0.6) hazard = 'Pulsar'; } else if (heat > 0.35) { color = '#ffe9c4'; luminosity = 'Class G (Yellow)'; } else { color = '#ffb37b'; luminosity = 'Class M (Red Dwarf)'; size *= 0.8; } }

        proceduralSystems.push({ id: `proc-spiral-${i}`, name: `Arm ${['Alpha','Beta','Gamma','Delta'][arm]}-${1000 + i}`, x, y, size, color, type, luminosity, hazard, multiType: rng() > 0.8 ? 'Binary' : 'Single', ownership: 'Unclaimed', isCustom: false });
    }
    globalProceduralSystemsCache = proceduralSystems;
    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();

    function screenToWorld(sx, sy) { const rect = canvas.getBoundingClientRect(); return { x: (sx - rect.left - container.clientWidth / 2 - window.camera.x) / window.camera.zoom, y: (sy - rect.top - container.clientHeight / 2 - window.camera.y) / window.camera.zoom }; }

    container.addEventListener('mousedown', (e) => {
        if (e.target && e.target.closest && e.target.closest('.panel')) return; 
        const worldPos = screenToWorld(e.clientX, e.clientY);
        
        if (window.territoryDrawActive) {
            const startNode = window.activeTerritoryVertices[0]; const snapDist = 30 / window.camera.zoom;
            if (startNode && window.activeTerritoryVertices.length >= 3 && Math.hypot(worldPos.x - startNode.x, worldPos.y - startNode.y) < snapDist) { window.finishActiveTerritory(); return; }
            window.activeTerritoryVertices.push({ x: worldPos.x, y: worldPos.y }); document.getElementById('territory-drawing-status').innerText = `Nodes: ${window.activeTerritoryVertices.length}`; return;
        }

        if (window.hyperlaneDrawActive) {
            let snapNode = { x: worldPos.x, y: worldPos.y, name: "Deep Space Node" };
            let allSystems = proceduralSystems.concat(globalDbSystemsCache);
            for (let s of allSystems) { if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < Math.max(15, 25 / window.camera.zoom)) { snapNode = { x: s.x, y: s.y, id: s.id, name: s.name }; break; } }
            window.activeHyperlaneNodes.push(snapNode); return;
        }

        if (window.jumpPlottingActive && window.activeJumpShip) {
            let snapTarget = null; let allSystems = proceduralSystems.concat(globalDbSystemsCache);
            for (let s of allSystems) { if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < 40) { snapTarget = { x: s.x, y: s.y, name: s.name, hazard: s.hazard }; break; } }
            if (snapTarget) { window.jumpTargetPoint = { x: snapTarget.x, y: snapTarget.y, name: snapTarget.name, hazard: snapTarget.hazard }; } 
            else { window.jumpTargetPoint = { x: worldPos.x, y: worldPos.y, name: `Sector (${Math.round(worldPos.x)}, ${Math.round(worldPos.y)})`, hazard: 'None' }; }
            if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); return;
        }

        if (e.shiftKey || window.pingModeActive) { if(typeof window.triggerTacticalPing === 'function') window.triggerTacticalPing(worldPos.x, worldPos.y); return; }

        if (window.measuringTapeActive) {
            if (!window.measureStartPoint) { window.measureStartPoint = worldPos; } else if (!window.measureEndPoint) { window.measureEndPoint = worldPos; } else { window.measureStartPoint = worldPos; window.measureEndPoint = null; }
            return;
        }

        const starHitRadius = Math.max(12, 15 / window.camera.zoom); const tokenHitRadius = Math.max(10, 15 / window.camera.zoom); const planetHitRadius = Math.max(6, 12 / window.camera.zoom);
        let time = Date.now(); let allSystems = proceduralSystems.concat(globalDbSystemsCache);

        if (window.camera.zoom > SYSTEM_ZOOM_THRESHOLD) {
            for (let s of allSystems) {
                if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < 250 && s.type !== 'Nebula') { 
                    for (let b of window.getSystemBodies(s)) {
                        let angle = b.baseAngle + (time * b.speed); let bx = s.x + Math.cos(angle) * b.radius; let by = s.y + Math.sin(angle) * b.radius;
                        if (Math.hypot(bx - worldPos.x, by - worldPos.y) < (b.isStar ? starHitRadius : planetHitRadius)) { 
                            window.selectedTarget = { type: 'body', data: b }; if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); return; 
                        }
                    }
                }
            }
        }

        for (let m of globalShipMarkersCache) {
            if (Math.hypot(m.x - worldPos.x, m.y - worldPos.y) < tokenHitRadius && (currentUserRole === 'dm' || m.owner_id === currentUserId)) {
                window.draggedMarker = m; window.selectedTarget = { type: 'ship', data: m }; 
                if(typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); return;
            }
        }
        for (let s of allSystems) {
            if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < starHitRadius) {
                window.selectedTarget = { type: 'star', data: s };
                if(currentUserRole === 'dm' && s.isCustom) window.draggedStar = s; 
                if(typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); return;
            }
        }
        window.camera.isDragging = true; window.camera.startX = e.clientX; window.camera.startY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
        const worldPos = screenToWorld(e.clientX, e.clientY); window._lastMouseWorldX = worldPos.x; window._lastMouseWorldY = worldPos.y;
        
        if (window.draggedMarker) { window.draggedMarker.x = worldPos.x; window.draggedMarker.y = worldPos.y; return; }
        if (window.draggedStar) { window.draggedStar.x = worldPos.x; window.draggedStar.y = worldPos.y; return; }

        if (window.camera.isDragging) {
            let dx = e.clientX - window.camera.startX; let dy = e.clientY - window.camera.startY;
            window.camera.x = Math.max(-MAP_LIMIT * window.camera.zoom, Math.min(MAP_LIMIT * window.camera.zoom, window.camera.x + dx));
            window.camera.y = Math.max(-MAP_LIMIT * window.camera.zoom, Math.min(MAP_LIMIT * window.camera.zoom, window.camera.y + dy));
            window.camera.startX = e.clientX; window.camera.startY = e.clientY;
        }
    });

    window.addEventListener('mouseup', async () => {
        if (window.draggedMarker) { 
            await db.from('ship_markers').update({ x: window.draggedMarker.x, y: window.draggedMarker.y }).eq('id', window.draggedMarker.id); 
            window.draggedMarker = null; if(typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); 
        }
        if (window.draggedStar) { await db.from('star_systems').update({ x: window.draggedStar.x, y: window.draggedStar.y }).eq('id', window.draggedStar.id); window.draggedStar = null; }
        window.camera.isDragging = false;
    });

    container.addEventListener('wheel', (e) => {
        if (e.target.closest('.panel')) return; e.preventDefault();
        const mouseX = e.clientX - container.getBoundingClientRect().left - container.clientWidth / 2;
        const mouseY = e.clientY - container.getBoundingClientRect().top - container.clientHeight / 2;
        const worldX = (mouseX - window.camera.x) / window.camera.zoom; const worldY = (mouseY - window.camera.y) / window.camera.zoom;
        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15; const newZoom = Math.max(0.02, Math.min(15.0, window.camera.zoom * zoomFactor));
        window.camera.x = Math.max(-MAP_LIMIT * newZoom, Math.min(MAP_LIMIT * newZoom, mouseX - worldX * newZoom));
        window.camera.y = Math.max(-MAP_LIMIT * newZoom, Math.min(MAP_LIMIT * newZoom, mouseY - worldY * newZoom));
        window.camera.zoom = newZoom;
    }, { passive: false });

    // HUD TELEMETRY RENDERER
    window.renderHUDTelemetry = function() {
        const content = document.getElementById('hud-content'); if (!content) return;
        
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
            if (currentUserRole === 'dm' && s.isCustom) {
                dmEditorBox = `<div style="background:#040605; border:1px solid #ff3366; padding:8px; margin-top:8px; border-radius:2px;">
                    <span style="font-size:9px; color:#ff6b6b; font-weight:bold;">🛠️ OVERSEER STAR EDITOR</span>
                    <label style="font-size:9px; color:#6b826a; display:block; margin-top:4px;">Name:</label><input type="text" id="edit-star-name" value="${s.name}" style="font-size:10px; margin:2px 0;">
                    <label style="font-size:9px; color:#6b826a; display:block;">Ownership:</label><input type="text" id="edit-star-ownership" value="${s.ownership || 'Unclaimed'}" style="font-size:10px; margin:2px 0;">
                    <div style="display:flex; gap:6px;"><div style="flex:1;"><label style="font-size:9px; color:#6b826a;">Class:</label><select id="edit-star-luminosity" style="font-size:9px; margin:2px 0;"><option value="Class G (Yellow)" ${s.luminosity==='Class G (Yellow)'?'selected':''}>Class G</option><option value="Class M (Red Dwarf)" ${s.luminosity==='Class M (Red Dwarf)'?'selected':''}>Class M</option><option value="Class O (Blue Giant)" ${s.luminosity==='Class O (Blue Giant)'?'selected':''}>Class O</option><option value="Black Hole" ${s.luminosity==='Black Hole'?'selected':''}>Black Hole</option><option value="Hidden Anomaly" ${s.luminosity==='Hidden Anomaly'?'selected':''}>Hidden Anomaly</option></select></div><div style="flex:1;"><label style="font-size:9px; color:#6b826a;">Tier:</label><input type="number" id="edit-star-tier" value="${s.industry_tier || 0}" style="font-size:10px; margin:2px 0;"></div></div>
                    <button class="btn-reveal" onclick="window.saveDMStarProperties('${s.id}')" style="font-size:9px; padding:6px; margin-top:6px; width:100%;">SAVE SYSTEM</button>
                    <button class="btn-remove" onclick="window.deleteStarSystem('${s.id}')" style="font-size:9px; padding:4px; margin-top:4px;">DESTROY</button></div>`;
            }

            if (fowTier === 1) {
                content.innerHTML = `<div style="font-size: 11px;">${lockStatusHtml}<br><strong style="color: #6b826a; font-size: 13px;">[UNKNOWN CONTACT]</strong><br><span style="color: #6b826a;">Coordinates:</span> X: ${Math.round(s.x)}, Y: ${Math.round(s.y)}<br><span style="color: #ff3333; font-size:9px; margin-top:6px; display:block;">⚠ OUT OF SENSOR RANGE</span><div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''} ${bookmarkBtn}</div>${dmEditorBox}</div>`;
            } else if (fowTier === 2) {
                let bodies = window.getSystemBodies(s).length; let dradisBtn = `<button class="btn-deploy" onclick="window.executeDradisScan('${s.id}')" style="font-size:9px; padding:6px; margin-top:6px; width:100%;">📡 EXECUTE DRADIS SCAN (EST: ${2 + bodies} HRS)</button>`;
                content.innerHTML = `<div style="font-size: 11px;">${lockStatusHtml}<br><strong style="color: #ffaa00; font-size: 13px;">${s.type === 'Black Hole' ? '🕳️' : '⭐'} ${s.name}</strong><br><span style="color: #6b826a;">Class:</span> ${s.luminosity || 'Standard'} (${s.multiType || 'Single'})<br><span style="color: #6b826a;">Orbital Bodies Detected:</span> ${bodies}<br><span style="color: #ffaa00; font-size:9px; margin-top:6px; display:block;">⚠ AWAITING DEEP SCAN FOR SURFACE TELEMETRY</span>${dradisBtn}<div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''} ${bookmarkBtn}</div>${dmEditorBox}</div>`;
            } else {
                let hazardBadge = s.hazard && s.hazard !== 'None' ? `<span style="color:#ff3333; font-weight:bold; display:block; margin:2px 0;">⚠️ HAZARD: ${s.hazard.toUpperCase()}</span>` : '';
                content.innerHTML = `<div style="font-size: 11px;">${lockStatusHtml}<br><strong style="color: #00e5a3; font-size: 13px;">${s.type === 'Black Hole' ? '🕳️' : '⭐'} ${s.name}</strong><br><span style="color: #6b826a;">Class:</span> ${s.luminosity || 'Standard'} (${s.multiType || 'Single'})<br>${hazardBadge}<span style="color: #6b826a;">Ownership:</span> ${s.ownership || 'Unclaimed'}<br><span style="color: #00e5a3; font-size:9px; margin-top:6px; display:block;">✓ DRADIS TELEMETRY COMPLETE</span><div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''} ${bookmarkBtn}</div>${dmEditorBox}</div>`;
            }
        } else if (dynamicTarget.type === 'ship') {
            const m = dynamicTarget.data; let iff = m.cargo_inventory && m.cargo_inventory.iff ? m.cargo_inventory.iff : 'allied'; let iffColor = iff === 'hostile' ? '#ff3333' : (iff === 'neutral' ? '#ffaa00' : '#00e5a3');
            
            let driveOptionsHtml = ''; Object.keys(driveSpeeds).forEach(k => { driveOptionsHtml += `<option value="${k}" ${m.drive_type === k ? 'selected' : ''}>${driveSpeeds[k].label}</option>`; });
            let dmIffBox = currentUserRole === 'dm' ? `<div style="margin:4px 0;"><label style="color: #6b826a; font-size:10px;">IFF Tag:</label><select onchange="window.updateShipIff('${m.id}', this.value)" style="font-size:10px; padding:2px; background:#0a1410; color:${iffColor}; border:1px solid ${iffColor}; margin:2px 0;"><option value="allied" ${iff === 'allied' ? 'selected' : ''} style="color:#00e5a3;">Allied</option><option value="hostile" ${iff === 'hostile' ? 'selected' : ''} style="color:#ff3333;">Hostile</option><option value="neutral" ${iff === 'neutral' ? 'selected' : ''} style="color:#ffaa00;">Neutral</option></select></div>` : '';

            let jumpPlotterBox = '';
            if (window.jumpPlottingActive && window.activeJumpShip && window.activeJumpShip.id === m.id) {
                let targetInfo = window.jumpTargetPoint ? `Target: <strong>${window.jumpTargetPoint.name || 'Custom Vector'}</strong> (X: ${Math.round(window.jumpTargetPoint.x)}, Y: ${Math.round(window.jumpTargetPoint.y)})` : `<span style="color:#ffaa00;">Click on any star or map sector to lock target coordinates...</span>`;
                let calcTimeStr = '';
                if (window.jumpTargetPoint) {
                    let dist = Math.hypot(window.jumpTargetPoint.x - m.x, window.jumpTargetPoint.y - m.y);
                    let hrs = Math.max(1, Math.round(dist / window.selectedDriveSpeed));
                    let fuelCost = window.selectedDriveSpeed < 50 ? 0 : Math.max(1, Math.round(dist / 100));
                    calcTimeStr = `<div style="font-size:10px; color:#00e5a3; margin:4px 0; background:#030403; padding:6px; border:1px solid #3c4e36;">Distance: ${dist.toFixed(1)} u<br>FTL Trip Duration: <strong>~${hrs} hours</strong><br><span style="color:#ffaa00;">Fuel Cost: ${fuelCost} Energy Cores</span></div>`;
                }
                jumpPlotterBox = `<div style="background:#040605; border:1px solid #00e1ff; padding:8px; margin-top:8px; border-radius:2px;"><span style="font-size:9px; color:#00e1ff; font-weight:bold;">🌌 JUMP VECTOR PLOTTER</span><div style="font-size:10px; color:#d4c5a9; margin:4px 0;">${targetInfo}</div><label style="font-size:9px; color:#6b826a; display:block; margin-top:4px;">Drive System Override:</label><select onchange="window.setDriveSpeedKey(this.value)" style="font-size:9px; margin:2px 0; background:#0a1410; color:#00e1ff;">${driveOptionsHtml}</select>${calcTimeStr}<div style="display:flex; gap:6px; margin-top:6px;"><button class="btn-reveal" onclick="window.executePlottedJump()" ${!window.jumpTargetPoint ? 'disabled style="opacity:0.5;"' : ''} style="flex:2; font-size:9px; padding:6px;">🚀 EXECUTE JUMP & ADVANCE TIME</button><button class="btn-remove" onclick="window.cancelJumpPlotting()" style="flex:1; font-size:9px; padding:6px;">CANCEL</button></div></div>`;
            } else if (isLocked) { jumpPlotterBox = `<button class="btn-deploy" onclick="window.startJumpPlottingMode()" style="font-size:9px; padding:6px; margin-top:6px;">🌌 PLOT JUMP VECTOR</button>`; }

            content.innerHTML = `<div style="font-size: 11px;">${lockStatusHtml}<br><strong style="color: ${iffColor}; font-size: 13px;">🚀 ${m.name} [${iff.toUpperCase()}]</strong><br><span style="color: #6b826a;">Position:</span> X: ${Math.round(m.x)}, Y: ${Math.round(m.y)}<br><div style="margin:4px 0;"><label style="color: #6b826a; font-size:10px;">Engine Drive:</label><select onchange="window.updateShipDriveType('${m.id}', this.value)" style="font-size:10px; padding:2px; background:#0a1410; color:#00e1ff; margin:2px 0;">${driveOptionsHtml}</select></div>${dmIffBox}<div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''} ${bookmarkBtn}</div>${jumpPlotterBox}<button class="btn-deploy" onclick="window.openFullVesselTerminal('${m.id}')" style="font-size:9px; padding:4px; margin-top:6px;">⚙️ INSPECT VESSEL DECK</button>${currentUserRole === 'dm' ? `<button class="btn-remove" onclick="window.deleteShipToken('${m.id}')" style="font-size:9px; padding:4px; margin-top:4px;">DECOMMISSION</button>` : ''}</div>`;
        } else if (dynamicTarget.type === 'body') {
            const p = dynamicTarget.data;
            let dmBodyEditorBox = currentUserRole === 'dm' ? `<div style="background:#040605; border:1px solid #ff3366; padding:8px; margin-top:8px; border-radius:2px;"><span style="font-size:9px; color:#ff6b6b; font-weight:bold;">🛠️ OVERSEER PLANET EDITOR</span><label style="font-size:9px; color:#6b826a; display:block; margin-top:4px;">Designation:</label><input type="text" id="edit-body-name" value="${p.name}" style="font-size:10px; margin:2px 0;"><div style="display:flex; gap:6px;"><div style="flex:1;"><label style="font-size:9px; color:#6b826a;">Body Type:</label><select id="edit-body-type" style="font-size:9px; margin:2px 0;"><option value="Terrestrial" ${p.type==='Terrestrial'?'selected':''}>Terrestrial</option><option value="Gas Giant" ${p.type==='Gas Giant'?'selected':''}>Gas Giant</option><option value="Ice World" ${p.type==='Ice World'?'selected':''}>Ice World</option><option value="Barren Rock" ${p.type==='Barren Rock'?'selected':''}>Barren Rock</option><option value="Volcanic" ${p.type==='Volcanic'?'selected':''}>Volcanic</option></select></div><div style="flex:1;"><label style="font-size:9px; color:#6b826a;">Gravity:</label><input type="text" id="edit-body-gravity" value="${p.gravity}" style="font-size:10px; margin:2px 0;"></div></div><label style="font-size:9px; color:#6b826a; display:block;">Atmosphere:</label><input type="text" id="edit-body-atmosphere" value="${p.atmosphere}" style="font-size:10px; margin:2px 0;"><label style="font-size:9px; color:#6b826a; display:block;">Scans:</label><textarea id="edit-body-resources" rows="2" style="font-size:10px; margin:2px 0;">${p.resources}</textarea><button class="btn-reveal" onclick="window.saveDMBodyProperties('${p.id}')" style="font-size:9px; padding:6px; margin-top:6px; width:100%;">APPLY SCANS</button></div>` : '';
            content.innerHTML = `<div style="font-size: 11px;">${lockStatusHtml}<br><strong style="color: ${p.color}; font-size: 13px;">🪐 ${p.name}</strong><br><span style="color: #6b826a;">System:</span> ${p.parentSystem.name}<br><span style="color: #6b826a;">Class:</span> ${p.type} | <span style="color: #6b826a;">Grav:</span> ${p.gravity}<br><span style="color: #00e5a3; font-weight:bold; margin-top:4px; display:block;">Scans:</span> <span style="color: #d4c5a9;">${p.resources}</span><div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''} ${bookmarkBtn}</div>${dmBodyEditorBox}</div>`;
        }
    };

    function render() {
        const cssWidth = container.clientWidth; const cssHeight = container.clientHeight;
        ctx.fillStyle = '#010201'; ctx.fillRect(0, 0, cssWidth, cssHeight);
        ctx.save(); ctx.translate(cssWidth / 2 + window.camera.x, cssHeight / 2 + window.camera.y); ctx.scale(window.camera.zoom, window.camera.zoom);

        const time = Date.now();
        const hw = cssWidth / (2 * window.camera.zoom); const hh = cssHeight / (2 * window.camera.zoom);
        const cx = -window.camera.x / window.camera.zoom; const cy = -window.camera.y / window.camera.zoom;

        if (window.camera.zoom < 0.8) { let coreGrd = ctx.createRadialGradient(0, 0, 100, 0, 0, 1800); coreGrd.addColorStop(0, 'rgba(118, 148, 255, 0.12)'); coreGrd.addColorStop(0.5, 'rgba(0, 229, 163, 0.04)'); coreGrd.addColorStop(1, 'rgba(0, 0, 0, 0)'); ctx.fillStyle = coreGrd; ctx.beginPath(); ctx.arc(0, 0, 1800, 0, Math.PI * 2); ctx.fill(); }

        let allSystems = proceduralSystems.concat(globalDbSystemsCache);

        if (window.hyperlanesVisible && window.camera.zoom < 2.0) {
            ctx.strokeStyle = 'rgba(0, 229, 163, 0.12)'; ctx.lineWidth = 1 / window.camera.zoom; ctx.setLineDash([4, 12]);
            ctx.beginPath();
            for (let i = 0; i < allSystems.length; i += 3) {
                let s1 = allSystems[i]; if (Math.abs(s1.x - cx) > hw + 300 || Math.abs(s1.y - cy) > hh + 300) continue;
                for (let j = i + 1; j < i + 3 && j < allSystems.length; j++) {
                    let s2 = allSystems[j]; if (Math.hypot(s2.x - s1.x, s2.y - s1.y) < 800) { ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); }
                }
            }
            ctx.stroke(); ctx.setLineDash([]);
        }

        if (window.hyperlanesVisible) {
            globalHyperlanesCache.forEach(route => {
                if (!route.nodes || route.nodes.length < 2) return;
                ctx.save(); ctx.beginPath(); ctx.moveTo(route.nodes[0].x, route.nodes[0].y);
                for (let k = 1; k < route.nodes.length; k++) { ctx.lineTo(route.nodes[k].x, route.nodes[k].y); }
                ctx.strokeStyle = route.color || '#00e1ff'; ctx.lineWidth = 3 / window.camera.zoom; ctx.shadowColor = route.color || '#00e1ff'; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0; ctx.restore();
            });
        }

        if (window.hyperlaneDrawActive && window.activeHyperlaneNodes.length > 0) {
            ctx.save(); ctx.strokeStyle = '#00e1ff'; ctx.lineWidth = 3 / window.camera.zoom; ctx.beginPath(); ctx.moveTo(window.activeHyperlaneNodes[0].x, window.activeHyperlaneNodes[0].y);
            for (let k = 1; k < window.activeHyperlaneNodes.length; k++) { ctx.lineTo(window.activeHyperlaneNodes[k].x, window.activeHyperlaneNodes[k].y); }
            if (window._lastMouseWorldX !== undefined) { ctx.lineTo(window._lastMouseWorldX, window._lastMouseWorldY); }
            ctx.stroke(); window.activeHyperlaneNodes.forEach((v) => { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(v.x, v.y, 4 / window.camera.zoom, 0, Math.PI * 2); ctx.fill(); }); ctx.restore();
        }

        /* MODULE C: FOW TERRITORY STEALTH HACK */
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
                ctx.fillText(`⬡ ${t.name.toUpperCase()}${isHidden ? ' (HIDDEN)' : ''}`, avgX, avgY);
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
                    ctx.fillStyle = s.isCustom ? `rgba(0, 229, 163, 0.8)` : `rgba(107, 130, 106, 0.8)`; ctx.font = `${Math.max(10, 12 / window.camera.zoom)}px Courier New`; ctx.fillText(s.name, s.x + 10, s.y + 4);
                }
            }

            if (window.camera.zoom > SYSTEM_ZOOM_THRESHOLD && s.type !== 'Nebula' && fowTier === 3) {
                for (let b of window.getSystemBodies(s)) {
                    let angle = b.baseAngle + (time * b.speed); let bx = s.x + Math.cos(angle) * b.radius; let by = s.y + Math.sin(angle) * b.radius;
                    ctx.beginPath(); ctx.arc(s.x, s.y, b.radius, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(0, 229, 163, 0.12)'; ctx.lineWidth = 1 / window.camera.zoom; ctx.stroke();
                    ctx.fillStyle = b.color; ctx.beginPath(); ctx.arc(bx, by, b.size, 0, Math.PI * 2); ctx.fill();
                }
            }
        }

        for (let m of globalShipMarkersCache) {
            if (Math.abs(m.x - cx) > hw + 50 || Math.abs(m.y - cy) > hh + 50) continue;
            const size = 10 / window.camera.zoom; let iffColor = (m.cargo_inventory && m.cargo_inventory.iff === 'hostile') ? '#ff3333' : '#00e5a3';
            ctx.fillStyle = iffColor; ctx.beginPath(); ctx.moveTo(m.x, m.y - size); ctx.lineTo(m.x + size, m.y); ctx.lineTo(m.x, m.y + size); ctx.lineTo(m.x - size, m.y); ctx.closePath(); ctx.fill();
        }

        if (window.jumpPlottingActive && window.activeJumpShip) {
            let targetX = window.jumpTargetPoint ? window.jumpTargetPoint.x : (window._lastMouseWorldX || window.activeJumpShip.x);
            let targetY = window.jumpTargetPoint ? window.jumpTargetPoint.y : (window._lastMouseWorldY || window.activeJumpShip.y);
            ctx.save(); ctx.strokeStyle = '#00e1ff'; ctx.lineWidth = 2 / window.camera.zoom; ctx.setLineDash([8, 6]);
            ctx.beginPath(); ctx.moveTo(window.activeJumpShip.x, window.activeJumpShip.y); ctx.lineTo(targetX, targetY); ctx.stroke(); ctx.setLineDash([]);
            ctx.beginPath(); ctx.arc(targetX, targetY, (16 + Math.sin(time * 0.008) * 4) / window.camera.zoom, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        }

        // RESTORED MEASURE TOOL DISTANCE TEXT
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

        ctx.restore(); requestAnimationFrame(render);
    }
    render();
};
