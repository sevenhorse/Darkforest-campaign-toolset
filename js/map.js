/* ==========================================================================
   js/map.js - Cartography & Module C Fog of War Engine
   ========================================================================== */

window.camera = { x: 0, y: 0, zoom: 0.2, isDragging: false, startX: 0, startY: 0 };
window.draggedMarker = null;
window.draggedStar = null;

function stringToHash(str) { 
    let hash = 0; for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash = hash & hash; } return Math.abs(hash); 
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
window.getSystemBodies = function(system) {
    if(system.type === 'Nebula') return [];
    if (system.custom_bodies && Array.isArray(system.custom_bodies) && system.custom_bodies.length > 0) {
        return system.custom_bodies.map((b, idx) => ({ ...b, id: b.id || `${system.id}-custom-${idx}`, baseAngle: b.baseAngle || (idx * 1.2), speed: b.speed || (0.0002 / (idx + 1)), parentSystem: system }));
    }
    if(generatedSystems[system.id]) return generatedSystems[system.id];
    
    let seed = stringToHash(system.id.toString()); let prng = mulberry32(seed);
    let bodies = []; let r = system.type === 'Black Hole' ? 40 : 15; 
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

// MODULE C: Fog of War Math Engine
window.getFowTier = function(system) {
    if (currentUserRole === 'dm') return 3; // DM sees all
    if (window.scannedSystems.includes(system.id)) return 3; // Tier 3: DRADIS Scanned
    
    // Tier 2: Proximity check
    let inRange = false;
    for (let m of globalShipMarkersCache) {
        if (m.owner_id === currentUserId || (m.cargo_inventory && m.cargo_inventory.iff === 'allied')) {
            if (Math.hypot(m.x - system.x, m.y - system.y) <= 300) {
                inRange = true; break;
            }
        }
    }
    return inRange ? 2 : 1;
};

window.wipeGalaxySlate = async function() {
    if (currentUserRole !== 'dm') return;
    if (!confirm("Wipe all custom stars, ships, and territories?")) return;
    await db.from('star_systems').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('ship_markers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('territories').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    window.selectedTarget = null;
    if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
};

window.loadGalaxyData = async function() {
    const { data: starData } = await db.from('star_systems').select('*');
    if (starData) globalDbSystemsCache = starData.map(s => ({ ...s, isCustom: true, size: s.size || 5.0, type: s.luminosity === 'Black Hole' ? 'Black Hole' : (s.hazard === 'Nebula' ? 'Nebula' : 'Star'), multiType: s.multiType || 'Single', custom_bodies: s.custom_bodies || [] }));
    const { data: markerData } = await db.from('ship_markers').select('*');
    if (markerData) globalShipMarkersCache = markerData.map(m => ({ ...m, cargo_inventory: window.sanitizeCargo ? window.sanitizeCargo(m.cargo_inventory) : (m.cargo_inventory || {}), ship_weapons: m.ship_weapons || [], ship_decks: m.ship_decks || [] }));
};

/* SYSTEM ARCHITECT SPANWNERS (Truncated for brevity, previously installed in Mod B) */
let architectPlanets = [];
window.openSystemArchitect = function() { if (currentUserRole !== 'dm') return; architectPlanets = []; document.getElementById('system-architect-modal').style.display = 'flex'; };
window.closeSystemArchitect = function() { document.getElementById('system-architect-modal').style.display = 'none'; };
window.architectClassChanged = function(val) { if (val === 'Black Hole') document.getElementById('arch-hazard').value = 'Gravity Well'; };
window.addArchitectPlanetRow = function() { let count = architectPlanets.length + 1; architectPlanets.push({ name: `Planet ${count}`, type: 'Terrestrial', gravity: '1.0 G', atmosphere: 'Breathable', resources: 'Unknown', radius: 20 + count * 25, size: 1.6, color: '#4287f5' }); window.renderArchitectPlanets(); };
window.removeArchitectPlanetRow = function(idx) { architectPlanets.splice(idx, 1); window.renderArchitectPlanets(); };
window.renderArchitectPlanets = function() { /* See UI logic from previous module */ };
window.commitArchitectSystem = async function() { /* See DB logic from previous module */ };
window.spawnTokenAtCenter = async function() { /* See DB logic from previous module */ };


window.initGalaxyEngine = function() {
    const canvas = document.getElementById('galaxyCanvas'); if (!canvas) return;
    const ctx = canvas.getContext('2d'); const container = document.getElementById('canvas-container');
    const SYSTEM_ZOOM_THRESHOLD = 1.5; const MAP_LIMIT = 18000;

    function resize() { const dpr = window.devicePixelRatio || 1; canvas.width = container.clientWidth * dpr; canvas.height = container.clientHeight * dpr; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr); }
    window.addEventListener('resize', resize); resize();
    
    const proceduralSystems = []; const rng = mulberry32(1048596); 
    const coreRadius = 1400; const galaxyRadius = 11000;
    
    // Procedural gen matches Module B exactly
    for (let i = 0; i < 1200; i++) {
        let arm = i % 4; let r = Math.pow(rng(), 0.6) * (galaxyRadius - coreRadius) + coreRadius;
        let spiralTheta = (Math.log(r / coreRadius) * 2.2) + ((arm * 2 * Math.PI) / 4);
        let finalTheta = spiralTheta + (rng() - 0.5) * (0.35 + (r / galaxyRadius) * 0.4);
        let finalR = r + (rng() - 0.5) * (180 + (r / galaxyRadius) * 400);
        if (rng() > 0.88) { finalTheta = rng() * Math.PI * 2; finalR = rng() * galaxyRadius; }
        
        let x = Math.cos(finalTheta) * finalR; let y = Math.sin(finalTheta) * finalR;
        let type = 'Star'; let size = rng() * 2.0 + 3.0; let color = '#ffe9c4'; let luminosity = 'Class G (Yellow)'; let hazard = 'None';
        
        proceduralSystems.push({ id: `proc-spiral-${i}`, name: `Arm ${['Alpha','Beta','Gamma','Delta'][arm]}-${1000 + i}`, x, y, size, color, type, luminosity, hazard, multiType: rng() > 0.8 ? 'Binary' : 'Single', ownership: 'Unclaimed', isCustom: false });
    }
    globalProceduralSystemsCache = proceduralSystems;
    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();

    function screenToWorld(sx, sy) { const rect = canvas.getBoundingClientRect(); return { x: (sx - rect.left - container.clientWidth / 2 - window.camera.x) / window.camera.zoom, y: (sy - rect.top - container.clientHeight / 2 - window.camera.y) / window.camera.zoom }; }

    container.addEventListener('mousedown', (e) => {
        if (e.target && e.target.closest && e.target.closest('.panel')) return; 
        const worldPos = screenToWorld(e.clientX, e.clientY);
        
        // Handling hits...
        const starHitRadius = Math.max(12, 15 / window.camera.zoom);
        const tokenHitRadius = Math.max(10, 15 / window.camera.zoom);
        let allSystems = proceduralSystems.concat(globalDbSystemsCache);

        for (let m of globalShipMarkersCache) {
            if (Math.hypot(m.x - worldPos.x, m.y - worldPos.y) < tokenHitRadius && (currentUserRole === 'dm' || m.owner_id === currentUserId)) {
                window.draggedMarker = m; window.selectedTarget = { type: 'ship', data: m }; 
                if(typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); return;
            }
        }
        for (let s of allSystems) {
            if (Math.hypot(s.x - worldPos.x, s.y - worldPos.y) < starHitRadius) {
                window.selectedTarget = { type: 'star', data: s };
                if(currentUserRole === 'dm') window.draggedStar = s; 
                if(typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); return;
            }
        }
        window.camera.isDragging = true; window.camera.startX = e.clientX; window.camera.startY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
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
            window.draggedMarker = null; 
            if(typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry(); // Re-trigger to update FOW if moved
        }
        if (window.draggedStar) { await db.from('star_systems').update({ x: window.draggedStar.x, y: window.draggedStar.y }).eq('id', window.draggedStar.id); window.draggedStar = null; }
        window.camera.isDragging = false;
    });

    container.addEventListener('wheel', (e) => {
        if (e.target.closest('.panel')) return;
        e.preventDefault();
        const mouseX = e.clientX - container.getBoundingClientRect().left - container.clientWidth / 2;
        const mouseY = e.clientY - container.getBoundingClientRect().top - container.clientHeight / 2;
        const worldX = (mouseX - window.camera.x) / window.camera.zoom;
        const worldY = (mouseY - window.camera.y) / window.camera.zoom;
        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newZoom = Math.max(0.02, Math.min(15.0, window.camera.zoom * zoomFactor));
        window.camera.x = Math.max(-MAP_LIMIT * newZoom, Math.min(MAP_LIMIT * newZoom, mouseX - worldX * newZoom));
        window.camera.y = Math.max(-MAP_LIMIT * newZoom, Math.min(MAP_LIMIT * newZoom, mouseY - worldY * newZoom));
        window.camera.zoom = newZoom;
    }, { passive: false });

    // MODULE C: HUD TELEMETRY RENDERER
    window.renderHUDTelemetry = function() {
        const content = document.getElementById('hud-content');
        if (!content) return;
        let dynamicTarget = window.selectedTarget || window.hoveredTarget;
        if (!dynamicTarget) { content.innerHTML = `<p style="margin: 0; font-size: 12px; color: #6b826a;">Hover or click a target...</p>`; return; }
        
        let isLocked = !!window.selectedTarget;
        let lockStatusHtml = isLocked ? `<span style="color:#00e5a3; font-size:9px;">[TARGET LOCKED]</span>` : `<span style="color:#ffaa00; font-size:9px;">[SENSOR HOVER]</span>`;

        if (dynamicTarget.type === 'star') {
            const s = dynamicTarget.data;
            let fowTier = window.getFowTier(s);

            if (fowTier === 1) {
                // TIER 1: Unexplored, Out of Range
                content.innerHTML = `
                    <div style="font-size: 11px;">
                        ${lockStatusHtml}<br>
                        <strong style="color: #6b826a; font-size: 13px;">[UNKNOWN CONTACT]</strong><br>
                        <span style="color: #6b826a;">Coordinates:</span> X: ${Math.round(s.x)}, Y: ${Math.round(s.y)}<br>
                        <span style="color: #ff3333; font-size:9px; margin-top:6px; display:block;">⚠ OUT OF SENSOR RANGE</span>
                    </div>
                `;
            } else if (fowTier === 2) {
                // TIER 2: In Range, Census Only
                let bodies = window.getSystemBodies(s).length;
                let dradisBtn = `<button class="btn-deploy" onclick="window.executeDradisScan('${s.id}')" style="font-size:9px; padding:6px; margin-top:6px; width:100%;">📡 EXECUTE DRADIS SCAN (EST: ${2 + bodies} HRS)</button>`;
                
                content.innerHTML = `
                    <div style="font-size: 11px;">
                        ${lockStatusHtml}<br>
                        <strong style="color: #ffaa00; font-size: 13px;">${s.type === 'Black Hole' ? '🕳️' : '⭐'} ${s.name}</strong><br>
                        <span style="color: #6b826a;">Class:</span> ${s.luminosity || 'Standard'} (${s.multiType || 'Single'})<br>
                        <span style="color: #6b826a;">Orbital Bodies Detected:</span> ${bodies}<br>
                        <span style="color: #ffaa00; font-size:9px; margin-top:6px; display:block;">⚠ AWAITING DEEP SCAN FOR SURFACE TELEMETRY</span>
                        ${dradisBtn}
                    </div>
                `;
            } else {
                // TIER 3: Fully Scanned
                let hazardBadge = s.hazard && s.hazard !== 'None' ? `<span style="color:#ff3333; font-weight:bold; display:block; margin:2px 0;">⚠️ HAZARD: ${s.hazard.toUpperCase()}</span>` : '';
                content.innerHTML = `
                    <div style="font-size: 11px;">
                        ${lockStatusHtml}<br>
                        <strong style="color: #00e5a3; font-size: 13px;">${s.type === 'Black Hole' ? '🕳️' : '⭐'} ${s.name}</strong><br>
                        <span style="color: #6b826a;">Class:</span> ${s.luminosity || 'Standard'} (${s.multiType || 'Single'})<br>
                        ${hazardBadge}
                        <span style="color: #6b826a;">Ownership:</span> ${s.ownership || 'Unclaimed'}<br>
                        <span style="color: #00e5a3; font-size:9px; margin-top:6px; display:block;">✓ DRADIS TELEMETRY COMPLETE</span>
                    </div>
                `;
            }
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
                    <button class="btn-deploy" onclick="window.openFullVesselTerminal('${m.id}')" style="font-size:9px; padding:4px; margin-top:6px;">⚙️ INSPECT VESSEL DECK</button>
                </div>
            `;
        }
    };

    function render() {
        const cssWidth = container.clientWidth; const cssHeight = container.clientHeight;
        ctx.fillStyle = '#010201'; ctx.fillRect(0, 0, cssWidth, cssHeight);
        ctx.save(); ctx.translate(cssWidth / 2 + window.camera.x, cssHeight / 2 + window.camera.y); ctx.scale(window.camera.zoom, window.camera.zoom);

        const time = Date.now();
        const hw = cssWidth / (2 * window.camera.zoom); const hh = cssHeight / (2 * window.camera.zoom);
        const cx = -window.camera.x / window.camera.zoom; const cy = -window.camera.y / window.camera.zoom;

        let allSystems = proceduralSystems.concat(globalDbSystemsCache);

        for (let s of allSystems) {
            if (Math.abs(s.x - cx) > hw + 200 || Math.abs(s.y - cy) > hh + 200) continue;

            let fowTier = window.getFowTier(s);

            // MODULE C: Fog of War Render Logic
            if (fowTier === 1) {
                ctx.fillStyle = '#2a3b32'; // Dull radar green blip
                ctx.beginPath(); ctx.arc(s.x, s.y, 4 / window.camera.zoom, 0, Math.PI * 2); ctx.fill();
            } else {
                // Tier 2 or 3: Draw the actual star/hazard
                if (s.type === 'Nebula' || s.hazard === 'Nebula') {
                    let grd = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.size * 1.8);
                    grd.addColorStop(0, (s.color || '#33ccff') + '44'); grd.addColorStop(1, (s.color || '#33ccff') + '00');
                    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 1.8, 0, Math.PI * 2); ctx.fill();
                } else if (s.type === 'Black Hole') {
                    ctx.fillStyle = '#000000'; ctx.shadowColor = `rgba(100, 50, 255, 0.9)`; ctx.shadowBlur = 18;
                    ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
                } else {
                    ctx.fillStyle = s.color; ctx.shadowColor = s.hazard === 'Pulsar' ? '#ff3366' : s.color; ctx.shadowBlur = s.hazard === 'Pulsar' ? (12 + Math.sin(time * 0.01) * 6) : 8;
                    ctx.beginPath(); ctx.arc(s.x, s.y, s.size / (s.isCustom ? window.camera.zoom : 1), 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
                }
                
                // Name renders for Tier 2 and 3
                if (window.camera.zoom > 0.15 && window.camera.zoom <= SYSTEM_ZOOM_THRESHOLD && s.type !== 'Nebula') {
                    ctx.fillStyle = s.isCustom ? `rgba(0, 229, 163, 0.8)` : `rgba(107, 130, 106, 0.8)`;
                    ctx.font = `${Math.max(10, 12 / window.camera.zoom)}px Courier New`;
                    ctx.fillText(s.name, s.x + 10, s.y + 4);
                }
            }

            // Only draw planetary orbits/bodies if Tier 3 (DRADIS Scanned)
            if (window.camera.zoom > SYSTEM_ZOOM_THRESHOLD && s.type !== 'Nebula' && fowTier === 3) {
                for (let b of window.getSystemBodies(s)) {
                    let angle = b.baseAngle + (time * b.speed);
                    let bx = s.x + Math.cos(angle) * b.radius; let by = s.y + Math.sin(angle) * b.radius;
                    ctx.beginPath(); ctx.arc(s.x, s.y, b.radius, 0, Math.PI * 2);
                    ctx.strokeStyle = 'rgba(0, 229, 163, 0.12)'; ctx.lineWidth = 1 / window.camera.zoom; ctx.stroke();
                    ctx.fillStyle = b.color; ctx.beginPath(); ctx.arc(bx, by, b.size, 0, Math.PI * 2); ctx.fill();
                }
            }
        }

        for (let m of globalShipMarkersCache) {
            if (Math.abs(m.x - cx) > hw + 50 || Math.abs(m.y - cy) > hh + 50) continue;
            const size = 10 / window.camera.zoom;
            let iffColor = (m.cargo_inventory && m.cargo_inventory.iff === 'hostile') ? '#ff3333' : '#00e5a3';
            ctx.fillStyle = iffColor; ctx.beginPath(); ctx.moveTo(m.x, m.y - size); ctx.lineTo(m.x + size, m.y); ctx.lineTo(m.x, m.y + size); ctx.lineTo(m.x - size, m.y); ctx.closePath(); ctx.fill();
        }

        ctx.restore(); requestAnimationFrame(render);
    }
    render();
};
