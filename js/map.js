/* ==========================================================================
   js/map.js - Module B: 4-Arm Spiral Cartography & System Architect
   ========================================================================== */

window.camera = { x: 0, y: 0, zoom: 0.2, isDragging: false, startX: 0, startY: 0 };
window.draggedMarker = null;
window.draggedStar = null;

function stringToHash(str) { 
    let hash = 0; 
    for (let i = 0; i < str.length; i++) { 
        hash = ((hash << 5) - hash) + str.charCodeAt(i); 
        hash = hash & hash; 
    } 
    return Math.abs(hash); 
}

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
    
    // Check if custom planets were configured via the System Architect
    if (system.custom_bodies && Array.isArray(system.custom_bodies) && system.custom_bodies.length > 0) {
        return system.custom_bodies.map((b, idx) => ({
            ...b,
            id: b.id || `${system.id}-custom-${idx}`,
            baseAngle: b.baseAngle || (idx * 1.2),
            speed: b.speed || (0.0002 / (idx + 1)),
            parentSystem: system
        }));
    }

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
        globalDbSystemsCache = starData.map(s => ({ 
            ...s, 
            isCustom: true, 
            size: s.size || 5.0, 
            type: s.luminosity === 'Black Hole' ? 'Black Hole' : (s.hazard === 'Nebula' ? 'Nebula' : 'Star'),
            multiType: s.multiType || 'Single',
            custom_bodies: s.custom_bodies || []
        }));
    }
    const { data: markerData } = await db.from('ship_markers').select('*');
    if (markerData) {
        globalShipMarkersCache = markerData.map(m => ({ 
            ...m, 
            cargo_inventory: window.sanitizeCargo ? window.sanitizeCargo(m.cargo_inventory) : (m.cargo_inventory || {}), 
            ship_weapons: m.ship_weapons || [], 
            ship_decks: m.ship_decks || [] 
        }));
        
        const vesselDeckPanel = document.getElementById('term-panel-vessel');
        if (vesselDeckPanel && vesselDeckPanel.classList.contains('active')) {
            if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
        }
    }
};

/* ==========================================================================
   MODULE B: OVERSEER SYSTEM ARCHITECT (CUSTOM PRE-SPAWN)
   ========================================================================== */
let architectPlanets = [];

window.openSystemArchitect = function() {
    if (currentUserRole !== 'dm') return;
    architectPlanets = [];
    document.getElementById('arch-name').value = "Tartarus Prime";
    document.getElementById('arch-lum').value = "Class G (Yellow)";
    document.getElementById('arch-multi').value = "Single";
    document.getElementById('arch-hazard').value = "None";
    window.renderArchitectPlanets();
    document.getElementById('system-architect-modal').style.display = 'flex';
};

window.closeSystemArchitect = function() {
    document.getElementById('system-architect-modal').style.display = 'none';
};

window.architectClassChanged = function(val) {
    if (val === 'Black Hole') {
        document.getElementById('arch-hazard').value = 'Gravity Well';
    }
};

window.addArchitectPlanetRow = function() {
    let count = architectPlanets.length + 1;
    let rom = ["","I","II","III","IV","V","VI","VII","VIII"][count] || count;
    architectPlanets.push({
        name: `Tartarus ${rom}`,
        type: 'Terrestrial',
        gravity: '1.00 G',
        atmosphere: 'Breathable',
        resources: 'Titanium, Water Ice, Silicon',
        radius: 20 + count * 25,
        size: 1.6,
        color: '#4287f5'
    });
    window.renderArchitectPlanets();
};

window.removeArchitectPlanetRow = function(idx) {
    architectPlanets.splice(idx, 1);
    window.renderArchitectPlanets();
};

window.renderArchitectPlanets = function() {
    const cont = document.getElementById('arch-planets-container');
    if (!cont) return;
    if (architectPlanets.length === 0) {
        cont.innerHTML = `<span style="font-size:10px; color:#6b826a;">No custom planets added. (Procedural orbital simulation will default if empty).</span>`;
        return;
    }

    let html = '';
    architectPlanets.forEach((p, idx) => {
        html += `
            <div style="background:#030403; border:1px solid #3c4e36; padding:6px; border-radius:2px; font-size:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <input type="text" value="${p.name}" onchange="architectPlanets[${idx}].name=this.value" style="font-size:10px; padding:2px; width:140px; margin:0;">
                    <select onchange="architectPlanets[${idx}].type=this.value; architectPlanets[${idx}].color=getPlanetColor(this.value, Math.random); window.renderArchitectPlanets();" style="font-size:10px; margin:0; width:110px;">
                        <option value="Terrestrial" ${p.type==='Terrestrial'?'selected':''}>Terrestrial</option>
                        <option value="Gas Giant" ${p.type==='Gas Giant'?'selected':''}>Gas Giant</option>
                        <option value="Ice World" ${p.type==='Ice World'?'selected':''}>Ice World</option>
                        <option value="Barren Rock" ${p.type==='Barren Rock'?'selected':''}>Barren Rock</option>
                        <option value="Volcanic" ${p.type==='Volcanic'?'selected':''}>Volcanic</option>
                    </select>
                    <button class="layer-del" onclick="window.removeArchitectPlanetRow(${idx})" style="padding:1px 5px; font-size:9px;">✕</button>
                </div>
                <div style="display:flex; gap:6px;">
                    <input type="text" placeholder="Gravity" value="${p.gravity}" onchange="architectPlanets[${idx}].gravity=this.value" style="font-size:9px; padding:2px; flex:1; margin:0;">
                    <input type="text" placeholder="Atmosphere" value="${p.atmosphere}" onchange="architectPlanets[${idx}].atmosphere=this.value" style="font-size:9px; padding:2px; flex:1; margin:0;">
                    <input type="text" placeholder="Resource Scans" value="${p.resources}" onchange="architectPlanets[${idx}].resources=this.value" style="font-size:9px; padding:2px; flex:2; margin:0;">
                </div>
            </div>
        `;
    });
    cont.innerHTML = html;
};

window.commitArchitectSystem = async function() {
    if (currentUserRole !== 'dm') return;
    const name = document.getElementById('arch-name').value || 'Target System';
    const luminosity = document.getElementById('arch-lum').value;
    const multiType = document.getElementById('arch-multi').value;
    const hazard = document.getElementById('arch-hazard').value;

    let color = '#ffe9c4';
    if (luminosity === 'Class M (Red Dwarf)') color = '#ffb37b';
    if (luminosity === 'Class O (Blue Giant)') color = '#7694ff';
    if (luminosity === 'Black Hole') color = '#000000';
    if (luminosity === 'Hidden Anomaly') color = '#ff3333';

    let customBodiesClean = architectPlanets.map((p, idx) => ({
        ...p,
        isStar: false,
        radius: 25 + (idx + 1) * 30,
        baseAngle: idx * 1.25,
        speed: 0.0002 / (idx + 1)
    }));

    const payload = {
        name,
        x: -window.camera.x / window.camera.zoom,
        y: -window.camera.y / window.camera.zoom,
        size: luminosity === 'Black Hole' ? 7.0 : 5.0,
        color,
        luminosity,
        multiType,
        hazard,
        ownership: 'Unclaimed',
        control: 'Uncontested',
        industry_tier: 1,
        custom_bodies: customBodiesClean
    };

    await db.from('star_systems').insert(payload);
    window.closeSystemArchitect();
    if(typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
    alert(`System '${name}' materialized at sector center.`);
};

window.spawnTokenAtCenter = async function() {
    const driveType = document.getElementById('dm-tool-drivetype').value || 'ftl_class1';
    const name = document.getElementById('dm-tool-name').value || 'Task Force Black';
    const iffStatus = document.getElementById('dm-tool-iff') ? document.getElementById('dm-tool-iff').value : 'allied';
    
    let isJupiter = confirm(`Deploy '${name}' as a Jupiter-Class Heavy Cruiser? (Auto-fills weapons, health, and decks)`);
    
    let newCargo = typeof window.sanitizeCargo === 'function' ? window.sanitizeCargo({}) : {};
    newCargo.iff = iffStatus;

    let payload = { 
        owner_id: currentUserId, 
        name: name, 
        drive_type: driveType, 
        x: -window.camera.x / window.camera.zoom, 
        y: -window.camera.y / window.camera.zoom, 
        color: iffStatus === 'hostile' ? '#ff3333' : (iffStatus === 'neutral' ? '#ffaa00' : '#00e1ff'), 
        cargo_inventory: newCargo 
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
    }

    await db.from('ship_markers').insert(payload);
    if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

/* ==========================================================================
   MODULE B: 4-ARM SPIRAL GENERATION ENGINE
   ========================================================================== */
window.initGalaxyEngine = function() {
    const canvas = document.getElementById('galaxyCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('canvas-container');
    const SYSTEM_ZOOM_THRESHOLD = 1.5;
    const MAP_LIMIT = 18000;

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
    const rng = mulberry32(1048596); 
    const arms = 4;
    const totalStars = 1200;
    const galaxyRadius = 11000;
    const coreRadius = 1400;

    // 1. Supermassive Galactic Core (Accretion Zone)
    proceduralSystems.push({
        id: 'proc-core-blackhole',
        name: 'Sagittarius Prime',
        x: 0, y: 0, size: 10,
        color: '#000000', type: 'Black Hole',
        luminosity: 'Supermassive Singularity',
        hazard: 'Gravity Well',
        multiType: 'Single', ownership: 'Uninhabitable Core', isCustom: false
    });

    for (let i = 0; i < 120; i++) {
        let r = Math.pow(rng(), 0.7) * coreRadius + 120;
        let theta = rng() * Math.PI * 2;
        let x = Math.cos(theta) * r;
        let y = Math.sin(theta) * r;
        let heat = rng();
        
        let color = '#7694ff';
        let luminosity = 'Class O (Blue Giant)';
        let hazard = 'Pulsar';
        if (heat > 0.85) { color = '#000000'; luminosity = 'Singularity'; hazard = 'Gravity Well'; }
        else if (heat > 0.5) { color = '#ffe9c4'; luminosity = 'Class G (Yellow)'; hazard = 'None'; }

        proceduralSystems.push({
            id: `proc-core-${i}`,
            name: `Core Sector-${2000 + i}`,
            x, y, size: rng() * 2.5 + 3.5,
            color, type: luminosity === 'Singularity' ? 'Black Hole' : 'Star',
            luminosity, hazard, multiType: rng() > 0.7 ? 'Binary' : 'Single',
            ownership: 'Galactic Core', isCustom: false
        });
    }

    // 2. Logarithmic 4-Arm Spiral
    for (let i = 0; i < totalStars; i++) {
        let arm = i % arms;
        let r = Math.pow(rng(), 0.6) * (galaxyRadius - coreRadius) + coreRadius;
        
        // Logarithmic curve: theta = a * ln(r)
        let armOffset = (arm * 2 * Math.PI) / arms;
        let spiralTheta = (Math.log(r / coreRadius) * 2.2) + armOffset;
        
        // Arm Dispersion (closer to core = tighter; outer edges = broader scatter)
        let scatterAngle = (rng() - 0.5) * (0.35 + (r / galaxyRadius) * 0.4);
        let scatterRadius = (rng() - 0.5) * (180 + (r / galaxyRadius) * 400);

        let finalTheta = spiralTheta + scatterAngle;
        let finalR = r + scatterRadius;

        // Occasional Inter-Arm Outlier (12% chance)
        if (rng() > 0.88) {
            finalTheta = rng() * Math.PI * 2;
            finalR = rng() * galaxyRadius;
        }

        let x = Math.cos(finalTheta) * finalR;
        let y = Math.sin(finalTheta) * finalR;

        let multiRand = rng();
        let multiType = multiRand > 0.94 ? 'Trinary' : (multiRand > 0.75 ? 'Binary' : 'Single');
        
        let type = 'Star';
        let size = rng() * 2.0 + 3.0;
        let color = '#ffe9c4';
        let luminosity = 'Class G (Yellow)';
        let hazard = 'None';

        let starRoll = rng();
        if (starRoll > 0.985) {
            type = 'Black Hole'; color = '#000000'; size = 6.5; luminosity = 'Singularity'; hazard = 'Gravity Well';
        } else if (starRoll > 0.94) {
            type = 'Nebula'; color = ['#ff3366', '#33ccff', '#cc33ff', '#33ff99'][Math.floor(rng() * 4)];
            size = 120 + rng() * 120; luminosity = 'Gas Cloud'; hazard = 'Nebula';
        } else {
            let heat = rng();
            if (heat > 0.75) { color = '#7694ff'; luminosity = 'Class O (Blue Giant)'; if (rng() > 0.6) hazard = 'Pulsar'; }
            else if (heat > 0.35) { color = '#ffe9c4'; luminosity = 'Class G (Yellow)'; }
            else { color = '#ffb37b'; luminosity = 'Class M (Red Dwarf)'; size *= 0.8; }
        }

        proceduralSystems.push({
            id: `proc-spiral-${i}`,
            name: `Arm ${['Alpha','Beta','Gamma','Delta'][arm]}-${1000 + i}`,
            x, y, size, color, type, luminosity, hazard, multiType,
            ownership: 'Unclaimed', isCustom: false
        });
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

    function handleCanvasPointerDown(e) {
        if (e.target && e.target.closest && e.target.closest('.panel')) return; 
        if (e.button !== undefined && e.button !== 0) return;

        const worldPos = screenToWorld(e.clientX, e.clientY);
        
        if (territoryDrawActive) {
            const startNode = activeTerritoryVertices[0];
            const snapDist = 30 / window.camera.zoom;
            if (startNode && activeTerritoryVertices.length >= 3) {
                if (Math.hypot(worldPos.x - startNode.x, worldPos.y - startNode.y) < snapDist) {
                    window.finishActiveTerritory();
                    return;
                }
            }
            activeTerritoryVertices.push({ x: worldPos.x, y: worldPos.y });
            document.getElementById('territory-drawing-status').innerText = `Nodes: ${activeTerritoryVertices.length}`;
            return;
        }

        if (hyperlaneDrawActive) {
            let snapNode = { x: worldPos.x, y: worldPos.y, name: "Deep Space Node" };
            let allSystems = proceduralSystems.concat(globalDbSystemsCache);
            for (let s of allSystems) {
                if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < Math.max(15, 25 / window.camera.zoom)) {
                    snapNode = { x: s.x, y: s.y, id: s.id, name: s.name };
                    break;
                }
            }
            activeHyperlaneNodes.push(snapNode);
            return;
        }

        if (jumpPlottingActive && activeJumpShip) {
            let snapTarget = null;
            let allSystems = proceduralSystems.concat(globalDbSystemsCache);
            for (let s of allSystems) {
                if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < 40) {
                    snapTarget = { x: s.x, y: s.y, name: s.name, hazard: s.hazard };
                    break;
                }
            }
            if (snapTarget) {
                jumpTargetPoint = { x: snapTarget.x, y: snapTarget.y, name: snapTarget.name, hazard: snapTarget.hazard };
            } else {
                jumpTargetPoint = { x: worldPos.x, y: worldPos.y, name: `Sector (${Math.round(worldPos.x)}, ${Math.round(worldPos.y)})`, hazard: 'None' };
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
                if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < 250 && s.type !== 'Nebula') { 
                    for (let b of getSystemBodies(s)) {
                        let angle = b.baseAngle + (time * b.speed);
                        let bx = s.x + Math.cos(angle) * b.radius; let by = s.y + Math.sin(angle) * b.radius;
                        if (Math.hypot(bx - worldPos.x, by - worldPos.y) < (b.isStar ? starHitRadius : planetHitRadius)) { 
                            if(typeof selectTargetAndPushRecent === 'function') selectTargetAndPushRecent({ type: 'body', data: b }); 
                            return; 
                        }
                    }
                }
            }
        }

        for (let m of globalShipMarkersCache) {
            if (Math.hypot(m.x - worldPos.x, m.y - worldPos.y) < tokenHitRadius && (currentUserRole === 'dm' || m.owner_id === currentUserId)) {
                window.draggedMarker = m; 
                if(typeof selectTargetAndPushRecent === 'function') selectTargetAndPushRecent({ type: 'ship', data: m }); 
                return;
            }
        }

        for (let s of globalDbSystemsCache) {
            if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < starHitRadius) {
                if(typeof selectTargetAndPushRecent === 'function') selectTargetAndPushRecent({ type: 'star', data: s });
                if (currentUserRole === 'dm') window.draggedStar = s; 
                return;
            }
        }
        
        for (let s of proceduralSystems) {
            if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < starHitRadius) {
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
            window.draggedMarker = null; 
        }
        if (window.draggedStar) { 
            await db.from('star_systems').update({ x: window.draggedStar.x, y: window.draggedStar.y }).eq('id', window.draggedStar.id); 
            window.draggedStar = null; 
        }
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

        window.camera.x = Math.max(-MAP_LIMIT * newZoom, Math.min(MAP_LIMIT * newZoom, mouseX - worldX * newZoom));
        window.camera.y = Math.max(-MAP_LIMIT * newZoom, Math.min(MAP_LIMIT * newZoom, mouseY - worldY * newZoom));
        window.camera.zoom = newZoom;
    }, { passive: false });

    function selectTargetAndPushRecent(target) {
        window.selectedTarget = target;
        let existsIndex = recentTargets.findIndex(r => r.data.id === target.data.id);
        if (existsIndex >= 0) recentTargets.splice(existsIndex, 1);
        recentTargets.unshift(target);
        if (recentTargets.length > 20) recentTargets.pop();
        localStorage.setItem('odyssey_recents', JSON.stringify(recentTargets));
        if (typeof renderHUDTelemetry === 'function') renderHUDTelemetry();
    }

    function renderHUDTelemetry() {
        const content = document.getElementById('hud-content');
        if (!content) return;
        let dynamicTarget = window.selectedTarget || window.hoveredTarget;
        if (!dynamicTarget) { content.innerHTML = `<p style="margin: 0; font-size: 12px; color: #6b826a;">Hover or click a target...</p>`; return; }
        
        let isLocked = !!window.selectedTarget;
        let lockStatusHtml = isLocked ? `<span style="color:#00e5a3; font-size:9px;">[TARGET LOCKED]</span>` : `<span style="color:#ffaa00; font-size:9px;">[SENSOR HOVER]</span>`;
        let lockBtn = `<button class="btn-reveal" onclick="window.lockCameraOnSelected()" style="font-size:9px; padding:4px; margin-top:4px;">🎯 LOCK VIEW</button>`;

        if (dynamicTarget.type === 'star') {
            const s = dynamicTarget.data;
            let hazardBadge = s.hazard && s.hazard !== 'None' ? `<span style="color:#ff3333; font-weight:bold; display:block; margin:2px 0;">⚠️ HAZARD: ${s.hazard.toUpperCase()}</span>` : '';
            
            content.innerHTML = `
                <div style="font-size: 11px;">
                    ${lockStatusHtml}<br>
                    <strong style="color: #00e5a3; font-size: 13px;">${s.type === 'Black Hole' ? '🕳️' : '⭐'} ${s.name}</strong><br>
                    <span style="color: #6b826a;">Class:</span> ${s.luminosity || 'Standard'} (${s.multiType || 'Single'})<br>
                    ${hazardBadge}
                    <span style="color: #6b826a;">Coordinates:</span> X: ${Math.round(s.x)}, Y: ${Math.round(s.y)}<br>
                    <span style="color: #6b826a;">Ownership:</span> ${s.ownership || 'Unclaimed'}<br>
                    <div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''}</div>
                </div>
            `;
        } else if (dynamicTarget.type === 'ship') {
            const m = dynamicTarget.data;
            let iff = m.cargo_inventory && m.cargo_inventory.iff ? m.cargo_inventory.iff : 'allied';
            let iffColor = iff === 'hostile' ? '#ff3333' : (iff === 'neutral' ? '#ffaa00' : '#00e5a3');

            content.innerHTML = `
                <div style="font-size: 11px;">
                    ${lockStatusHtml}<br>
                    <strong style="color: ${iffColor}; font-size: 13px;">🚀 ${m.name} [${iff.toUpperCase()}]</strong><br>
                    <span style="color: #6b826a;">Position:</span> X: ${Math.round(m.x)}, Y: ${Math.round(m.y)}<br>
                    <span style="color: #00e1ff;">Drive:</span> ${m.drive_type || 'ftl_class1'}<br>
                    <div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''}</div>
                    <button class="btn-deploy" onclick="window.openFullVesselTerminal('${m.id}')" style="font-size:9px; padding:4px; margin-top:6px;">⚙️ INSPECT VESSEL DECK</button>
                </div>
            `;
        } else if (dynamicTarget.type === 'body') {
            const p = dynamicTarget.data;
            content.innerHTML = `
                <div style="font-size: 11px;">
                    ${lockStatusHtml}<br>
                    <strong style="color: ${p.color}; font-size: 13px;">🪐 ${p.name}</strong><br>
                    <span style="color: #6b826a;">System:</span> ${p.parentSystem.name}<br>
                    <span style="color: #6b826a;">Class:</span> ${p.type} | <span style="color: #6b826a;">Grav:</span> ${p.gravity}<br>
                    <span style="color: #00e5a3; font-weight:bold; margin-top:4px; display:block;">Scans:</span> <span style="color: #d4c5a9;">${p.resources}</span>
                    <div style="display:flex; gap:6px;">${isLocked ? lockBtn : ''}</div>
                </div>
            `;
        }
    }

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

        // Render Accretion Glow for Galactic Center
        if (window.camera.zoom < 0.8) {
            let coreGrd = ctx.createRadialGradient(0, 0, 100, 0, 0, 1800);
            coreGrd.addColorStop(0, 'rgba(118, 148, 255, 0.12)');
            coreGrd.addColorStop(0.5, 'rgba(0, 229, 163, 0.04)');
            coreGrd.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = coreGrd;
            ctx.beginPath();
            ctx.arc(0, 0, 1800, 0, Math.PI * 2);
            ctx.fill();
        }

        let allSystems = proceduralSystems.concat(globalDbSystemsCache);

        for (let s of allSystems) {
            if (Math.abs(s.x - cx) > hw + 200 || Math.abs(s.y - cy) > hh + 200) continue;

            if (s.type === 'Nebula' || s.hazard === 'Nebula') {
                let grd = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.size * 1.8);
                grd.addColorStop(0, (s.color || '#33ccff') + '44');
                grd.addColorStop(1, (s.color || '#33ccff') + '00');
                ctx.fillStyle = grd;
                ctx.beginPath();
                ctx.arc(s.x, s.y, s.size * 1.8, 0, Math.PI * 2);
                ctx.fill();
            } 
            else if (s.type === 'Black Hole') {
                ctx.strokeStyle = `rgba(255, 120, 50, 0.7)`; 
                ctx.lineWidth = 2 / window.camera.zoom;
                ctx.beginPath(); 
                ctx.ellipse(s.x, s.y, s.size * 2.2, s.size * 0.8, time * 0.001, 0, Math.PI * 2); 
                ctx.stroke();

                ctx.fillStyle = '#000000'; 
                ctx.shadowColor = `rgba(100, 50, 255, 0.9)`; 
                ctx.shadowBlur = 18;
                ctx.beginPath(); 
                ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); 
                ctx.fill(); 
                ctx.shadowBlur = 0;
            }
            else {
                ctx.fillStyle = s.color;
                ctx.shadowColor = s.hazard === 'Pulsar' ? '#ff3366' : s.color; 
                ctx.shadowBlur = s.hazard === 'Pulsar' ? (12 + Math.sin(time * 0.01) * 6) : 8;
                ctx.beginPath(); 
                ctx.arc(s.x, s.y, s.size / (s.isCustom ? window.camera.zoom : 1), 0, Math.PI * 2); 
                ctx.fill();
                ctx.shadowBlur = 0;
            }

            if (window.camera.zoom > SYSTEM_ZOOM_THRESHOLD && s.type !== 'Nebula') {
                for (let b of getSystemBodies(s)) {
                    let angle = b.baseAngle + (time * b.speed);
                    let bx = s.x + Math.cos(angle) * b.radius; 
                    let by = s.y + Math.sin(angle) * b.radius;
                    
                    ctx.beginPath(); 
                    ctx.arc(s.x, s.y, b.radius, 0, Math.PI * 2);
                    ctx.strokeStyle = 'rgba(0, 229, 163, 0.12)'; 
                    ctx.lineWidth = 1 / window.camera.zoom; 
                    ctx.stroke();

                    ctx.fillStyle = b.color;
                    ctx.beginPath(); 
                    ctx.arc(bx, by, b.size, 0, Math.PI * 2); 
                    ctx.fill();
                }
            }
        }

        // Render Ships
        for (let m of globalShipMarkersCache) {
            if (Math.abs(m.x - cx) > hw + 50 || Math.abs(m.y - cy) > hh + 50) continue;
            const size = 10 / window.camera.zoom;
            let iff = m.cargo_inventory && m.cargo_inventory.iff ? m.cargo_inventory.iff : 'allied';
            let iffColor = iff === 'hostile' ? '#ff3333' : (iff === 'neutral' ? '#ffaa00' : '#00e5a3');

            ctx.fillStyle = iffColor;
            ctx.beginPath(); 
            ctx.moveTo(m.x, m.y - size); 
            ctx.lineTo(m.x + size, m.y); 
            ctx.lineTo(m.x, m.y + size); 
            ctx.lineTo(m.x - size, m.y); 
            ctx.closePath(); 
            ctx.fill();
        }

        ctx.restore(); 
        requestAnimationFrame(render);
    }

    render();
};
