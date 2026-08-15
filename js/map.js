/* ==========================================================================
   js/map.js - Canvas Render Engine & Procedural Cartography
   ========================================================================== */

window.camera = { x: 0, y: 0, zoom: 0.2, isDragging: false, startX: 0, startY: 0 };
window.draggedMarker = null;
window.draggedStar = null;

function stringToHash(str) { let hash = 0; for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash = hash & hash; } return Math.abs(hash); }

function mulberry32(a) {
    return function() {
      var t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 8, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

const planetTypes = ['Terrestrial', 'Gas Giant', 'Ice World', 'Barren Rock', 'Volcanic'];
function getPlanetColor(type, prng) {
    if(type === 'Gas Giant') return ['#c4a482', '#e3a859', '#7da2a6'][Math.floor(prng()*3)];
    if(type === 'Ice World') return ['#a4d2ed', '#e6f5ff'][Math.floor(prng()*2)];
    if(type === 'Terrestrial') return ['#4287f5', '#4bb564', '#3b7852'][Math.floor(prng()*3)];
    if(type === 'Barren Rock') return ['#8a8a8a', '#a69b8d'][Math.floor(prng()*2)];
    if(type === 'Volcanic') return ['#d1451f', '#ff5e00'][Math.floor(prng()*2)];
    return '#ffffff';
}

function getPlanetResources(type, prng) {
    const rares = ['Uranium', 'Platinum', 'Dark Matter Trace', 'Neodymium', 'Promethium', 'Quantum Silicates'];
    const commons = ['Iron', 'Nickel', 'Cobalt', 'Silicon', 'Ice'];
    if (type === 'Gas Giant') return 'Hydrogen, Helium-3, Exotic Volatiles';
    if (type === 'Ice World') return 'Water Ice, Tritium, Methane';
    if (type === 'Terrestrial') return 'Organics, Carbon, ' + commons[Math.floor(prng()*commons.length)];
    if (type === 'Barren Rock') return commons[Math.floor(prng()*commons.length)] + ', ' + commons[Math.floor(prng()*commons.length)];
    if (type === 'Volcanic') return rares[Math.floor(prng()*rares.length)] + ', Basalt, Sulfur';
    return 'Unknown Scans';
}

let generatedSystems = {};
function getSystemBodies(system) {
    if(system.type === 'Nebula') return []; 
    if(generatedSystems[system.id]) return generatedSystems[system.id];
    
    let seed = stringToHash(system.id.toString()); 
    let prng = mulberry32(seed);
    let bodies = []; 
    let r = system.type === 'Black Hole' ? 40 : 15; 
    
    let multiType = system.multiType || 'Single'; 
    if (multiType === 'Binary' || multiType === 'Trinary') {
        r = 25 + prng() * 15;
        let c1Color = prng() > 0.5 ? '#ffb37b' : '#7694ff';
        bodies.push({
            id: system.id + '-B', name: system.name + ' B', isStar: true,
            radius: r, size: (system.size || 4) * (prng() * 0.4 + 0.4), type: 'Companion Star',
            baseAngle: prng() * Math.PI * 2, speed: ((prng() * 0.001) + 0.0005) * (prng() > 0.5 ? 1 : -1),
            color: c1Color, gravity: 'Stellar', atmosphere: 'Corona', resources: 'Plasma, Heat', parentSystem: system
        });
        if (multiType === 'Trinary') {
            r += 30 + prng() * 20;
            let c2Color = prng() > 0.5 ? '#ffe9c4' : '#ff3366';
            bodies.push({
                id: system.id + '-C', name: system.name + ' C', isStar: true,
                radius: r, size: (system.size || 4) * (prng() * 0.3 + 0.3), type: 'Companion Star',
                baseAngle: prng() * Math.PI * 2, speed: ((prng() * 0.0008) + 0.0003) * (prng() > 0.5 ? 1 : -1),
                color: c2Color, gravity: 'Stellar', atmosphere: 'Corona', resources: 'Plasma, Heat', parentSystem: system
            });
        }
    }
    
    let numPlanets = Math.floor(prng() * 5) + (system.type === 'Black Hole' ? 1 : 2); 
    for(let i=0; i<numPlanets; i++) {
        r += 25 + prng() * 30; 
        let pType = planetTypes[Math.floor(prng() * planetTypes.length)];
        bodies.push({
            id: system.id + '-p' + i,
            name: system.name + ' ' + (["","I","II","III","IV","V","VI","VII","VIII"][i+1] || i+1),
            isStar: false,
            radius: r, size: prng() * 1.5 + 0.8, type: pType,
            baseAngle: prng() * Math.PI * 2,
            speed: ((prng() * 0.0003) + 0.00005) * (prng() > 0.5 ? 1 : -1),
            color: getPlanetColor(pType, prng),
            gravity: (prng() * 1.8 + 0.1).toFixed(2) + ' G',
            atmosphere: pType === 'Barren Rock' ? 'None' : (prng()>0.5 ? 'Toxic' : 'Breathable'),
            resources: getPlanetResources(pType, prng),
            parentSystem: system
        });
    }
    generatedSystems[system.id] = bodies;
    return bodies;
}

window.wipeGalaxySlate = async function() {
    if (currentUserRole !== 'dm') return;
    if (!confirm("Wipe all custom stars, ships, and territories?")) return;
    const { error: e1 } = await db.from('star_systems').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { error: e2 } = await db.from('ship_markers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { error: e3 } = await db.from('territories').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e1 || e2 || e3) {
        alert("Wipe failed: " + (e1?.message || e2?.message || e3?.message));
    } else {
        window.selectedTarget = null;
        if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
        if(typeof loadTerritories === 'function') loadTerritories();
        alert("Galaxy slate wiped successfully.");
    }
};

window.loadGalaxyData = async function() {
    const { data: starData } = await db.from('star_systems').select('*');
    if (starData) {
        globalDbSystemsCache = starData.map(s => ({ ...s, isCustom: true, size: 5.0, type: s.luminosity === 'Black Hole' ? 'Black Hole' : 'Star', multiType: 'Single' }));
    }
    const { data: markerData } = await db.from('ship_markers').select('*');
    if (markerData) {
        globalShipMarkersCache = markerData.map(m => ({ ...m, cargo_inventory: sanitizeCargo(m.cargo_inventory), ship_weapons: m.ship_weapons || [], ship_decks: m.ship_decks || [] }));
        
        const vesselDeckPanel = document.getElementById('term-panel-vessel');
        if (vesselDeckPanel && vesselDeckPanel.classList.contains('active')) {
            if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
        }
    }
};

window.spawnStarSystemAtCenter = async function() {
    if (currentUserRole !== 'dm') return;
    const name = document.getElementById('dm-tool-name').value || 'New System';
    const luminosity = document.getElementById('dm-tool-luminosity').value;
    const color = document.getElementById('dm-tool-color').value;
    await db.from('star_systems').insert({ name, x: -window.camera.x / window.camera.zoom, y: -window.camera.y / window.camera.zoom, size: 5.0, color, luminosity, ownership: 'Unclaimed', control: 'Uncontested', industry_tier: 1 });
    if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

window.spawnTokenAtCenter = async function() {
    const driveType = document.getElementById('dm-tool-drivetype').value || 'ftl_class1';
    const name = document.getElementById('dm-tool-name').value || 'Task Force Black';
    const color = document.getElementById('dm-tool-color').value;
    
    let isJupiter = confirm(`Deploy '${name}' as a Jupiter-Class Heavy Cruiser? (Auto-fills weapons, health, and decks)`);
    
    let payload = { 
        owner_id: currentUserId, 
        name: name, 
        drive_type: driveType, 
        x: -window.camera.x / window.camera.zoom, 
        y: -window.camera.y / window.camera.zoom, 
        color: color, 
        cargo_inventory: {} 
    };

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
    } else {
        payload.integrity_shields = 100; payload.max_shields = 100;
        payload.integrity_hull = 100; payload.max_hull = 100;
        payload.integrity_reactive = 5; payload.max_reactive = 5;
        payload.integrity_ablative = 5; payload.max_ablative = 5;
        payload.ship_weapons = [];
        payload.ship_decks = [];
    }

    await db.from('ship_markers').insert(payload);
    if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

window.initGalaxyEngine = function() {
    const canvas = document.getElementById('galaxyCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('canvas-container');
    const SYSTEM_ZOOM_THRESHOLD = 1.5;
    
    const MAP_LIMIT = 15000;

    function resize() {
        const dpr = window.devicePixelRatio || 1;
        const cssWidth = container.clientWidth;
        const cssHeight = container.clientHeight;
        canvas.width = cssWidth * dpr;
        canvas.height = cssHeight * dpr;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
    }
    window.addEventListener('resize', resize); 
    resize();
    
    const proceduralSystems = [];
    const rng = mulberry32(4242); 
    const arms = 4;
    const totalStars = 1000;
    const galaxyRadius = 9000;
    const minDistance = 220;

    for (let i = 0; i < totalStars; i++) {
        let x, y, valid = false, attempts = 0;

        while (!valid && attempts < 40) {
            attempts++;
            let arm = i % arms;
            let radius = Math.pow(rng(), 0.65) * galaxyRadius + 400; 
            let spiralAngle = (radius * 0.00032) + (arm * 2 * Math.PI / arms);
            let scatter = (rng() - 0.5) * (1.0 + radius / 2500); 
            let angle = spiralAngle + scatter;

            if (rng() > 0.78) {
                angle = rng() * Math.PI * 2;
                radius = rng() * galaxyRadius;
            }

            x = Math.cos(angle) * radius;
            y = Math.sin(angle) * radius;

            valid = true;
            for (let j = Math.max(0, proceduralSystems.length - 200); j < proceduralSystems.length; j++) {
                let dx = proceduralSystems[j].x - x;
                let dy = proceduralSystems[j].y - y;
                if (Math.sqrt(dx * dx + dy * dy) < minDistance) {
                    valid = false;
                    break;
                }
            }
        }

        if (!valid) continue;

        let multiRand = rng();
        let multiType = 'Single';
        if (multiRand > 0.95) multiType = 'Trinary';
        else if (multiRand > 0.75) multiType = 'Binary';

        let type = 'Star'; 
        let size = rng() * 2.0 + 3.0;
        let color = '#ffe9c4'; 
        let luminosity = 'Class G (Yellow)';

        if (rng() > 0.985) {
            type = 'Black Hole'; color = '#000000'; size = 6; luminosity = 'Singularity';
        } else if (rng() > 0.96) {
            type = 'Nebula'; color = ['#ff3366', '#33ccff', '#cc33ff', '#33ff99'][Math.floor(rng() * 4)];
            size = 80 + rng() * 100; luminosity = 'Gas Cloud';
        } else {
            let heat = rng();
            if (heat > 0.8) { color = '#7694ff'; luminosity = 'Class O (Blue Giant)'; }
            else if (heat > 0.4) { color = '#ffe9c4'; luminosity = 'Class G (Yellow)'; }
            else { color = '#ffb37b'; luminosity = 'Class M (Red Dwarf)'; size *= 0.8; }
        }

        proceduralSystems.push({ id: 'proc-' + i, name: `Sector-${(1000 + i)}`, x, y, size, color, type, luminosity, multiType, ownership: 'Unclaimed', isCustom: false });
    }

    globalProceduralSystemsCache = proceduralSystems;

    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();

    function screenToWorld(sx, sy) { 
        const rect = canvas.getBoundingClientRect(); 
        const cssWidth = container.clientWidth;
        const cssHeight = container.clientHeight;
        return { 
            x: (sx - rect.left - cssWidth / 2 - window.camera.x) / window.camera.zoom, 
            y: (sy - rect.top - cssHeight / 2 - window.camera.y) / window.camera.zoom 
        }; 
    }

    function getTouchPos(e) {
        if (e.touches && e.touches.length > 0) return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
        if (e.changedTouches && e.changedTouches.length > 0) return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
        return { clientX: e.clientX, clientY: e.clientY };
    }

    function handleCanvasPointerDown(e) {
        if (e.target && e.target.closest && e.target.closest('.panel')) return; 
        if (e.button !== undefined && e.button !== 0) return;

        const worldPos = screenToWorld(e.clientX, e.clientY);
        
        if (territoryDrawActive) {
            const startNode = activeTerritoryVertices[0];
            const snapDist = 30 / window.camera.zoom;
            
            if (startNode && activeTerritoryVertices.length >= 3) {
                const distToStart = Math.hypot(worldPos.x - startNode.x, worldPos.y - startNode.y);
                if (distToStart < snapDist) {
                    window.finishActiveTerritory();
                    return;
                }
            }
            
            activeTerritoryVertices.push({ x: worldPos.x, y: worldPos.y });
            document.getElementById('territory-drawing-status').innerText = `Nodes Placed: ${activeTerritoryVertices.length} (Click initial node or button to save)`;
            return;
        }

        if (hyperlaneDrawActive) {
            let snapNode = { x: worldPos.x, y: worldPos.y, name: "Deep Space Point" };
            let allSystems = proceduralSystems.concat(globalDbSystemsCache);
            let hitRadius = Math.max(15, 25 / window.camera.zoom);
            
            for (let s of allSystems) {
                let dx = s.x - worldPos.x, dy = s.y - worldPos.y;
                if (Math.sqrt(dx * dx + dy * dy) < hitRadius) {
                    snapNode = { x: s.x, y: s.y, id: s.id, name: s.name };
                    break;
                }
            }
            
            activeHyperlaneNodes.push(snapNode);
            const statusDiv = document.getElementById('hyperlane-drawing-status');
            if(statusDiv) statusDiv.innerText = `Nodes Linked: ${activeHyperlaneNodes.length} (Click Save to finalize)`;
            return;
        }

        if (jumpPlottingActive && activeJumpShip) {
            let snapTarget = null;
            let allSystems = proceduralSystems.concat(globalDbSystemsCache);
            for (let s of allSystems) {
                let dx = s.x - worldPos.x, dy = s.y - worldPos.y;
                if (Math.sqrt(dx * dx + dy * dy) < 40) {
                    snapTarget = { x: s.x, y: s.y, name: s.name };
                    break;
                }
            }
            if (!snapTarget) {
                for (let m of globalShipMarkersCache) {
                    if (m.id === activeJumpShip.id) continue;
                    let dx = m.x - worldPos.x, dy = m.y - worldPos.y;
                    if (Math.sqrt(dx * dx + dy * dy) < 30) {
                        snapTarget = { x: m.x, y: m.y, name: m.name };
                        break;
                    }
                }
            }

            if (snapTarget) {
                jumpTargetPoint = { x: snapTarget.x, y: snapTarget.y, name: snapTarget.name };
            } else {
                jumpTargetPoint = { x: worldPos.x, y: worldPos.y, name: `Sector (${Math.round(worldPos.x)}, ${Math.round(worldPos.y)})` };
            }
            if (typeof renderHUDTelemetry === 'function') renderHUDTelemetry();
            return;
        }

        if (e.shiftKey || pingModeActive) {
            if(typeof triggerTacticalPing === 'function') triggerTacticalPing(worldPos.x, worldPos.y);
            return;
        }

        if (measuringTapeActive) {
            if (!measureStartPoint) { measureStartPoint = worldPos; } 
            else if (!measureEndPoint) { measureEndPoint = worldPos; } 
            else { measureStartPoint = worldPos; measureEndPoint = null; }
            return;
        }

        const starHitRadius = Math.max(12, 15 / window.camera.zoom);
        const tokenHitRadius = Math.max(10, 15 / window.camera.zoom);
        const planetHitRadius = Math.max(6, 12 / window.camera.zoom);

        let time = Date.now();
        let allSystems = proceduralSystems.concat(globalDbSystemsCache);

        if (window.camera.zoom > SYSTEM_ZOOM_THRESHOLD) {
            for (let s of allSystems) {
                let dx = s.x - worldPos.x, dy = s.y - worldPos.y;
                if (Math.sqrt(dx*dx + dy*dy) < 250 && s.type !== 'Nebula') { 
                    for (let b of getSystemBodies(s)) {
                        let angle = b.baseAngle + (time * b.speed);
                        let bx = s.x + Math.cos(angle) * b.radius; let by = s.y + Math.sin(angle) * b.radius;
                        let pdx = bx - worldPos.x, pdy = by - worldPos.y;
                        let hitThreshold = b.isStar ? starHitRadius : planetHitRadius;
                        if (Math.sqrt(pdx*pdx + pdy*pdy) < hitThreshold) { 
                            if(typeof selectTargetAndPushRecent === 'function') selectTargetAndPushRecent({ type: 'body', data: b }); 
                            return; 
                        }
                    }
                }
            }
        }

        for (let m of globalShipMarkersCache) {
            let dx = m.x - worldPos.x, dy = m.y - worldPos.y;
            if (Math.sqrt(dx * dx + dy * dy) < tokenHitRadius && (currentUserRole === 'dm' || m.owner_id === currentUserId)) {
                window.draggedMarker = m; 
                if(typeof selectTargetAndPushRecent === 'function') selectTargetAndPushRecent({ type: 'ship', data: m }); 
                return;
            }
        }

        for (let s of globalDbSystemsCache) {
            let dx = s.x - worldPos.x, dy = s.y - worldPos.y;
            if (Math.sqrt(dx * dx + dy * dy) < starHitRadius) {
                if(typeof selectTargetAndPushRecent === 'function') selectTargetAndPushRecent({ type: 'star', data: s });
                if (currentUserRole === 'dm') window.draggedStar = s; 
                return;
            }
        }
        
        for (let s of proceduralSystems) {
            let dx = s.x - worldPos.x, dy = s.y - worldPos.y;
            if (Math.sqrt(dx * dx + dy * dy) < starHitRadius) {
                if(typeof selectTargetAndPushRecent === 'function') selectTargetAndPushRecent({ type: 'star', data: s }); 
                return;
            }
        }

        window.camera.isDragging = true; 
        window.camera.startX = e.clientX; 
        window.camera.startY = e.clientY;
    }

    container.addEventListener('mousedown', handleCanvasPointerDown);

    window.addEventListener('mousemove', (e) => {
        const worldPos = screenToWorld(e.clientX, e.clientY);
        window._lastMouseWorldX = worldPos.x;
        window._lastMouseWorldY = worldPos.y;

        if (!window.camera.isDragging && !window.draggedMarker && !window.draggedStar && !territoryDrawActive && !hyperlaneDrawActive) {
            let hitRadius = Math.max(10, 15 / window.camera.zoom);
            let hitTarget = null;

            for (let m of globalShipMarkersCache) {
                if (Math.hypot(m.x - worldPos.x, m.y - worldPos.y) < hitRadius) { hitTarget = { type: 'ship', data: m }; break; }
            }
            if (!hitTarget) {
                for (let s of globalDbSystemsCache) {
                    if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < hitRadius) { hitTarget = { type: 'star', data: s }; break; }
                }
            }
            if (!hitTarget) {
                for (let s of proceduralSystems) {
                    if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < hitRadius) { hitTarget = { type: 'star', data: s }; break; }
                }
            }

            let foundId = hitTarget ? hitTarget.data.id : null;
            let hoverId = window.hoveredTarget ? window.hoveredTarget.data.id : null;
            
            if (foundId !== hoverId) {
                window.hoveredTarget = hitTarget;
                if (!window.selectedTarget && activeHudTab === 'telemetry') {
                    if (typeof renderHUDTelemetry === 'function') renderHUDTelemetry();
                }
            }
        }

        if (window.draggedMarker) { window.draggedMarker.x = worldPos.x; window.draggedMarker.y = worldPos.y; return; }
        if (window.draggedStar) { window.draggedStar.x = worldPos.x; window.draggedStar.y = worldPos.y; return; }
        
        if (window.camera.isDragging) {
            let dx = e.clientX - window.camera.startX;
            let dy = e.clientY - window.camera.startY;
            window.camera.x = Math.max(-MAP_LIMIT * window.camera.zoom, Math.min(MAP_LIMIT * window.camera.zoom, window.camera.x + dx));
            window.camera.y = Math.max(-MAP_LIMIT * window.camera.zoom, Math.min(MAP_LIMIT * window.camera.zoom, window.camera.y + dy));
            window.camera.startX = e.clientX; window.camera.startY = e.clientY;
        }
    });

    window.addEventListener('mouseup', async () => {
        if (window.draggedMarker) { 
            await db.from('ship_markers').update({ x: window.draggedMarker.x, y: window.draggedMarker.y }).eq('id', window.draggedMarker.id); 
            if(typeof checkAnomalyProximity === 'function') await checkAnomalyProximity(window.draggedMarker);
            db.from('chat_logs').insert({ sender_id: currentUserId, content: `🚀 [NAVIGATION] Fleet token '${window.draggedMarker.name}' repositioned to X: ${Math.round(window.draggedMarker.x)}, Y: ${Math.round(window.draggedMarker.y)}.`, message_type: 'text' });
            window.draggedMarker = null; 
        }
        if (window.draggedStar) { await db.from('star_systems').update({ x: window.draggedStar.x, y: window.draggedStar.y }).eq('id', window.draggedStar.id); window.draggedStar = null; }
        window.camera.isDragging = false;
    });

    container.addEventListener('touchstart', (e) => {
        if (e.target && e.target.closest && e.target.closest('.panel')) return;
        const pos = getTouchPos(e);
        const syntheticEvent = {
            clientX: pos.clientX, clientY: pos.clientY, button: 0,
            shiftKey: e.shiftKey || false, target: e.target,
            closest: (selector) => e.target.closest ? e.target.closest(selector) : null
        };
        handleCanvasPointerDown(syntheticEvent);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
        const pos = getTouchPos(e);
        const worldPos = screenToWorld(pos.clientX, pos.clientY);
        window._lastMouseWorldX = worldPos.x; window._lastMouseWorldY = worldPos.y;

        if (window.draggedMarker) { window.draggedMarker.x = worldPos.x; window.draggedMarker.y = worldPos.y; return; }
        if (window.draggedStar) { window.draggedStar.x = worldPos.x; window.draggedStar.y = worldPos.y; return; }
        
        if (window.camera.isDragging) {
            e.preventDefault(); 
            let dx = pos.clientX - window.camera.startX;
            let dy = pos.clientY - window.camera.startY;
            window.camera.x = Math.max(-MAP_LIMIT * window.camera.zoom, Math.min(MAP_LIMIT * window.camera.zoom, window.camera.x + dx));
            window.camera.y = Math.max(-MAP_LIMIT * window.camera.zoom, Math.min(MAP_LIMIT * window.camera.zoom, window.camera.y + dy));
            window.camera.startX = pos.clientX; window.camera.startY = pos.clientY;
        }
    }, { passive: false });

    window.addEventListener('touchend', async () => {
        if (window.draggedMarker) { 
            await db.from('ship_markers').update({ x: window.draggedMarker.x, y: window.draggedMarker.y }).eq('id', window.draggedMarker.id); 
            if(typeof checkAnomalyProximity === 'function') await checkAnomalyProximity(window.draggedMarker);
            db.from('chat_logs').insert({ sender_id: currentUserId, content: `🚀 [NAVIGATION] Fleet token '${window.draggedMarker.name}' repositioned via mobile telemetry.`, message_type: 'text' });
            window.draggedMarker = null; 
        }
        if (window.draggedStar) { await db.from('star_systems').update({ x: window.draggedStar.x, y: window.draggedStar.y }).eq('id', window.draggedStar.id); window.draggedStar = null; }
        window.camera.isDragging = false;
    });

    container.addEventListener('wheel', (e) => {
        if (e.target.closest('.panel')) return;
        e.preventDefault();

        const cssWidth = container.clientWidth;
        const cssHeight = container.clientHeight;
        const mouseX = e.clientX - container.getBoundingClientRect().left - cssWidth / 2;
        const mouseY = e.clientY - container.getBoundingClientRect().top - cssHeight / 2;

        const worldX = (mouseX - window.camera.x) / window.camera.zoom;
        const worldY = (mouseY - window.camera.y) / window.camera.zoom;

        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newZoom = Math.max(0.02, Math.min(15.0, window.camera.zoom * zoomFactor));

        let targetX = mouseX - worldX * newZoom;
        let targetY = mouseY - worldY * newZoom;
        window.camera.x = Math.max(-MAP_LIMIT * newZoom, Math.min(MAP_LIMIT * newZoom, targetX));
        window.camera.y = Math.max(-MAP_LIMIT * newZoom, Math.min(MAP_LIMIT * newZoom, targetY));
        window.camera.zoom = newZoom;
    }, { passive: false });

    /* Canvas Main Render Loop */
    function render() {
        const cssWidth = container.clientWidth;
        const cssHeight = container.clientHeight;

        ctx.fillStyle = '#010201'; 
        ctx.fillRect(0, 0, cssWidth, cssHeight);

        ctx.save(); 
        ctx.translate(cssWidth / 2 + window.camera.x, cssHeight / 2 + window.camera.y); 
        ctx.scale(window.camera.zoom, window.camera.zoom);

        const time = Date.now();
        const hw = cssWidth / (2 * window.camera.zoom); 
        const hh = cssHeight / (2 * window.camera.zoom);
        const cx = -window.camera.x / window.camera.zoom; 
        const cy = -window.camera.y / window.camera.zoom;

        let dynamicTarget = window.selectedTarget || window.hoveredTarget;
        let focusSystemId = null;
        if (dynamicTarget) {
            if (dynamicTarget.type === 'star') focusSystemId = dynamicTarget.data.id;
            if (dynamicTarget.type === 'body') focusSystemId = dynamicTarget.data.parentSystem.id;
        }

        let macroOpacity = 1.0;
        if (window.camera.zoom > SYSTEM_ZOOM_THRESHOLD && focusSystemId) {
            macroOpacity = Math.max(0, 1.0 - (window.camera.zoom - SYSTEM_ZOOM_THRESHOLD) * 1.5);
        }

        if (macroOpacity > 0) {
            ctx.strokeStyle = `rgba(0, 229, 163, ${0.05 * macroOpacity})`; 
            ctx.lineWidth = 1 / window.camera.zoom;
            let gridSize = 1000;
            let startX = Math.floor((cx - hw) / gridSize) * gridSize; let endX = Math.ceil((cx + hw) / gridSize) * gridSize;
            let startY = Math.floor((cy - hh) / gridSize) * gridSize; let endY = Math.ceil((cy + hh) / gridSize) * gridSize;
            ctx.beginPath();
            for (let x = startX; x <= endX; x += gridSize) { ctx.moveTo(x, startY); ctx.lineTo(x, endY); }
            for (let y = startY; y <= endY; y += gridSize) { ctx.moveTo(startX, y); ctx.lineTo(endX, y); }
            ctx.stroke();
        }

        let allSystems = proceduralSystems.concat(globalDbSystemsCache);

        if (hyperlanesVisible && window.camera.zoom < 2.0) {
            ctx.strokeStyle = 'rgba(0, 229, 163, 0.12)';
            ctx.lineWidth = 1 / window.camera.zoom;
            ctx.setLineDash([4, 12]);
            ctx.beginPath();
            for (let i = 0; i < allSystems.length; i += 3) {
                let s1 = allSystems[i];
                if (Math.abs(s1.x - cx) > hw + 300 || Math.abs(s1.y - cy) > hh + 300) continue;
                for (let j = i + 1; j < i + 3 && j < allSystems.length; j++) {
                    let s2 = allSystems[j];
                    let dx = s2.x - s1.x, dy = s2.y - s1.y;
                    if (Math.sqrt(dx*dx + dy*dy) < 800) {
                        ctx.moveTo(s1.x, s1.y);
                        ctx.lineTo(s2.x, s2.y);
                    }
                }
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        if (hyperlanesVisible) {
            globalHyperlanesCache.forEach(route => {
                if (!route.nodes || route.nodes.length < 2) return;
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(route.nodes[0].x, route.nodes[0].y);
                for (let k = 1; k < route.nodes.length; k++) {
                    ctx.lineTo(route.nodes[k].x, route.nodes[k].y);
                }
                ctx.strokeStyle = route.color || '#00e1ff';
                ctx.lineWidth = 3 / window.camera.zoom;
                ctx.shadowColor = route.color || '#00e1ff';
                ctx.shadowBlur = 10;
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.restore();
            });
        }

        if (hyperlaneDrawActive && activeHyperlaneNodes.length > 0) {
            ctx.save();
            ctx.strokeStyle = '#00e1ff';
            ctx.lineWidth = 3 / window.camera.zoom;
            ctx.beginPath();
            ctx.moveTo(activeHyperlaneNodes[0].x, activeHyperlaneNodes[0].y);
            for (let k = 1; k < activeHyperlaneNodes.length; k++) {
                ctx.lineTo(activeHyperlaneNodes[k].x, activeHyperlaneNodes[k].y);
            }
            if (window._lastMouseWorldX !== undefined) {
                ctx.lineTo(window._lastMouseWorldX, window._lastMouseWorldY);
            }
            ctx.stroke();
            
            activeHyperlaneNodes.forEach((v) => {
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(v.x, v.y, 4 / window.camera.zoom, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.restore();
        }

        globalTerritoriesCache.forEach(t => {
            if (!t.vertices || t.vertices.length < 3) return;
            
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(t.vertices[0].x, t.vertices[0].y);
            for (let k = 1; k < t.vertices.length; k++) {
                ctx.lineTo(t.vertices[k].x, t.vertices[k].y);
            }
            ctx.closePath();

            ctx.fillStyle = t.color + '22';
            ctx.fill();

            ctx.strokeStyle = t.color;
            ctx.lineWidth = 2 / window.camera.zoom;
            ctx.shadowColor = t.color;
            ctx.shadowBlur = 8;
            ctx.stroke();
            ctx.shadowBlur = 0;

            if (window.camera.zoom > 0.04) {
                let avgX = t.vertices.reduce((sum, v) => sum + v.x, 0) / t.vertices.length;
                let avgY = t.vertices.reduce((sum, v) => sum + v.y, 0) / t.vertices.length;
                ctx.fillStyle = t.color;
                ctx.font = `bold ${Math.max(10, 14 / window.camera.zoom)}px Courier New`;
                ctx.textAlign = 'center';
                ctx.fillText(`⬡ ${t.name.toUpperCase()}`, avgX, avgY);
                if (t.faction_name) {
                    ctx.font = `${Math.max(8, 10 / window.camera.zoom)}px Courier New`;
                    ctx.fillText(`[${t.faction_name}]`, avgX, avgY + (14 / window.camera.zoom));
                }
                ctx.textAlign = 'left';
            }
            ctx.restore();
        });

        if (territoryDrawActive && activeTerritoryVertices.length > 0) {
            ctx.save();
            const drawColor = document.getElementById('territory-color-input')?.value || '#00e5a3';
            ctx.strokeStyle = drawColor;
            ctx.lineWidth = 2 / window.camera.zoom;
            ctx.setLineDash([6, 6]);

            ctx.beginPath();
            ctx.moveTo(activeTerritoryVertices[0].x, activeTerritoryVertices[0].y);
            for (let k = 1; k < activeTerritoryVertices.length; k++) {
                ctx.lineTo(activeTerritoryVertices[k].x, activeTerritoryVertices[k].y);
            }
            if (window._lastMouseWorldX !== undefined) {
                ctx.lineTo(window._lastMouseWorldX, window._lastMouseWorldY);
            }
            ctx.stroke();
            ctx.setLineDash([]);

            activeTerritoryVertices.forEach((v, idx) => {
                ctx.fillStyle = idx === 0 ? '#ffaa00' : '#ffffff';
                ctx.beginPath();
                ctx.arc(v.x, v.y, (idx === 0 ? 6 : 4) / window.camera.zoom, 0, Math.PI * 2);
                ctx.fill();
            });

            if (activeTerritoryVertices.length >= 3 && window._lastMouseWorldX !== undefined) {
                let distToStart = Math.hypot(window._lastMouseWorldX - activeTerritoryVertices[0].x, window._lastMouseWorldY - activeTerritoryVertices[0].y);
                if (distToStart < 30 / window.camera.zoom) {
                    let pulse = (12 + Math.sin(time * 0.012) * 5) / window.camera.zoom;
                    ctx.strokeStyle = '#ffaa00';
                    ctx.lineWidth = 2 / window.camera.zoom;
                    ctx.beginPath();
                    ctx.arc(activeTerritoryVertices[0].x, activeTerritoryVertices[0].y, pulse, 0, Math.PI * 2);
                    ctx.stroke();

                    ctx.fillStyle = '#ffaa00';
                    ctx.font = `${Math.max(9, 11 / window.camera.zoom)}px Courier New`;
                    ctx.fillText('CLICK TO CLOSE SHAPE', activeTerritoryVertices[0].x + (15 / window.camera.zoom), activeTerritoryVertices[0].y - (10 / window.camera.zoom));
                }
            }
            ctx.restore();
        }

        // Stars & Systems
        for (let s of allSystems) {
            let isFocused = (s.id === focusSystemId);
            let sysOpacity = isFocused ? 1.0 : macroOpacity;

            if (sysOpacity <= 0) continue;

            let cullRadius = s.type === 'Nebula' ? s.size : 150;
            if (!isFocused && (Math.abs(s.x - cx) > hw + cullRadius || Math.abs(s.y - cy) > hh + cullRadius)) continue;

            ctx.globalAlpha = sysOpacity;

            if (s.type === 'Nebula') {
                let grd = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.size);
                grd.addColorStop(0, s.color + '33'); grd.addColorStop(1, s.color + '00');
                ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); ctx.fill();
            } 
            else if (s.type === 'Black Hole' && s.luminosity !== 'Hidden Anomaly' && s.luminosity !== 'Revealed Anomaly') {
                ctx.strokeStyle = `rgba(255, 100, 50, ${0.6 * sysOpacity})`; ctx.lineWidth = 2 / window.camera.zoom;
                ctx.beginPath(); ctx.ellipse(s.x, s.y, s.size * 1.8, s.size * 0.6, time * 0.001, 0, Math.PI * 2); ctx.stroke();
                ctx.fillStyle = '#000000'; ctx.shadowColor = `rgba(100, 50, 255, ${0.8 * sysOpacity})`; ctx.shadowBlur = 15;
                ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
            }
            else if (s.luminosity === 'Hidden Anomaly') {
                if (currentUserRole === 'dm') {
                    ctx.globalAlpha = sysOpacity * 0.5;
                    ctx.strokeStyle = '#ff3333';
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 2, 0, Math.PI * 2); ctx.stroke();
                    ctx.setLineDash([]);
                    if (window.camera.zoom > 0.5) {
                        ctx.fillStyle = '#ff3333';
                        ctx.font = `${Math.max(8, 10 / window.camera.zoom)}px Courier New`;
                        ctx.fillText("[HIDDEN]", s.x + 12, s.y - 10);
                    }
                }
            } 
            else if (s.luminosity === 'Revealed Anomaly') {
                ctx.fillStyle = '#ff3333';
                ctx.shadowColor = '#ff3333'; ctx.shadowBlur = 15;
                ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 1.5, 0, Math.PI * 2); ctx.fill();
                ctx.shadowBlur = 0;
            }
            else {
                ctx.fillStyle = s.color;
                ctx.shadowColor = s.color; ctx.shadowBlur = 8;
                ctx.beginPath(); ctx.arc(s.x, s.y, s.size / (s.isCustom ? window.camera.zoom : 1), 0, Math.PI * 2); ctx.fill();
                ctx.shadowBlur = 0;
            }

            ctx.globalAlpha = 1.0;

            if (window.camera.zoom > 0.15 && window.camera.zoom <= SYSTEM_ZOOM_THRESHOLD && s.type !== 'Nebula') {
                ctx.fillStyle = s.isCustom ? `rgba(0, 229, 163, ${sysOpacity})` : `rgba(107, 130, 106, ${sysOpacity})`;
                ctx.font = `${Math.max(10, 12 / window.camera.zoom)}px Courier New`;
                ctx.fillText(s.name, s.x + 10, s.y + 4);
            }

            if (window.camera.zoom > SYSTEM_ZOOM_THRESHOLD && s.type !== 'Nebula' && (isFocused || (!focusSystemId && sysOpacity > 0))) {
                let deepZoomFade = Math.min(1.0, (window.camera.zoom - SYSTEM_ZOOM_THRESHOLD) / 1.0);
                
                if (!isFocused && focusSystemId) deepZoomFade = 0;
                else if (!isFocused) deepZoomFade *= sysOpacity;

                if (deepZoomFade > 0) {
                    for(let b of getSystemBodies(s)) {
                        let angle = b.baseAngle + (time * b.speed);
                        let bx = s.x + Math.cos(angle) * b.radius; let by = s.y + Math.sin(angle) * b.radius;
                        
                        ctx.beginPath(); ctx.arc(s.x, s.y, b.radius, 0, Math.PI*2);
                        ctx.strokeStyle = `rgba(0, 229, 163, ${deepZoomFade * (b.isStar ? 0.05 : 0.15)})`; 
                        ctx.lineWidth = 1/window.camera.zoom; ctx.stroke();
                        
                        if (b.isStar) {
                            ctx.shadowColor = b.color; ctx.shadowBlur = 12;
                            ctx.fillStyle = b.color; ctx.globalAlpha = deepZoomFade;
                            ctx.beginPath(); ctx.arc(bx, by, b.size, 0, Math.PI*2); ctx.fill(); 
                            ctx.shadowBlur = 0; ctx.globalAlpha = 1.0;
                        } else {
                            ctx.fillStyle = b.color; ctx.globalAlpha = deepZoomFade;
                            ctx.beginPath(); ctx.arc(bx, by, b.size, 0, Math.PI*2); ctx.fill(); 
                            ctx.globalAlpha = 1.0;
                        }
                    }
                }
            }
        }

        // Fleet Markers
        for (let m of globalShipMarkersCache) {
            if (Math.abs(m.x - cx) > hw + 50 || Math.abs(m.y - cy) > hh + 50) continue;
            const size = 10 / window.camera.zoom;
            ctx.fillStyle = m.color || '#00e1ff';
            ctx.beginPath(); ctx.moveTo(m.x, m.y - size); ctx.lineTo(m.x + size, m.y); ctx.lineTo(m.x, m.y + size); ctx.lineTo(m.x - size, m.y); ctx.closePath(); ctx.fill();
            if (window.camera.zoom > 0.1) { ctx.fillStyle = '#00e1ff'; ctx.font = `${Math.max(9, 11 / window.camera.zoom)}px Courier New`; ctx.fillText(m.name, m.x + 12, m.y + 3); }
        }

        if (jumpPlottingActive && activeJumpShip) {
            let targetX = jumpTargetPoint ? jumpTargetPoint.x : (window._lastMouseWorldX || activeJumpShip.x);
            let targetY = jumpTargetPoint ? jumpTargetPoint.y : (window._lastMouseWorldY || activeJumpShip.y);
            let labelName = jumpTargetPoint ? jumpTargetPoint.name : "Target Lock";

            ctx.save();
            ctx.strokeStyle = '#00e1ff';
            ctx.lineWidth = 2 / window.camera.zoom;
            ctx.setLineDash([8, 6]);

            ctx.beginPath();
            ctx.moveTo(activeJumpShip.x, activeJumpShip.y);
            ctx.lineTo(targetX, targetY);
            ctx.stroke();
            ctx.setLineDash([]);

            let reticleSize = 16 + Math.sin(time * 0.008) * 4;
            ctx.strokeStyle = '#00e1ff';
            ctx.beginPath();
            ctx.arc(targetX, targetY, reticleSize / window.camera.zoom, 0, Math.PI * 2);
            ctx.stroke();

            ctx.restore();
        }

        if (measuringTapeActive && measureStartPoint) {
            ctx.strokeStyle = '#00e5a3';
            ctx.lineWidth = 2 / window.camera.zoom;
            ctx.setLineDash([4, 4]);

            let endX = measureEndPoint ? measureEndPoint.x : (window._lastMouseWorldX || measureStartPoint.x);
            let endY = measureEndPoint ? measureEndPoint.y : (window._lastMouseWorldY || measureStartPoint.y);

            ctx.beginPath();
            ctx.moveTo(measureStartPoint.x, measureStartPoint.y);
            ctx.lineTo(endX, endY);
            ctx.stroke();
            ctx.setLineDash([]);
            
            ctx.fillStyle = '#00e5a3';
            ctx.font = `${Math.max(11, 13 / window.camera.zoom)}px Courier New`;
        }

        if (dynamicTarget && dynamicTarget.data) {
            let obj = dynamicTarget.data;
            let ox = obj.x, oy = obj.y;
            if (dynamicTarget.type === 'body') {
                let angle = obj.baseAngle + (time * obj.speed);
                ox = obj.parentSystem.x + Math.cos(angle) * obj.radius;
                oy = obj.parentSystem.y + Math.sin(angle) * obj.radius;
            }
            
            let isLocked = !!window.selectedTarget;
            let pulseSize = isLocked ? (14 + Math.sin(time * 0.006) * 4) : 12;
            
            ctx.strokeStyle = isLocked ? '#00e5a3' : '#ffaa00';
            ctx.lineWidth = 2 / window.camera.zoom;
            if (!isLocked) ctx.setLineDash([4, 4]);

            ctx.beginPath();
            ctx.arc(ox, oy, pulseSize / window.camera.zoom, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.restore(); requestAnimationFrame(render);
    }

    render();
};
