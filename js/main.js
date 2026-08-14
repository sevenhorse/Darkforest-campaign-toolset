/**
 * INTREPID HORIZON // CORE ARCHITECTURE
 * Modules: Map Engine, Territory Editor, Vessel Diagnostics, Tactical Battler
 */

// Defensive Cloud Init
const supabaseUrl = 'https://YOUR_SUPABASE_PROJECT.supabase.co';
const supabaseKey = 'YOUR_ANON_KEY';
const supabase = window.supabase.createClient(supabaseUrl, supabaseKey);

// Global State Machine
const EngineState = {
    isDM: true,
    dmOmniscience: true,
    factions: [],
    territories: [],
    stars: [],
    scans: [],
    
    drawing: {
        active: false,
        vertices: [],
        mousePos: null,
        selectedFaction: null,
        selectedColor: '#00e5ff'
    },

    vessel: {
        weapons: [],
    },

    // NEW: Battler State
    battler: {
        combatants: [],
        templates: []
    },

    // Shared Combat Log
    combatLog: [],

    ctx: null,
    width: 0,
    height: 0,
    camera: { x: 0, y: 0, zoom: 1 }
};

// ==========================================
// INITIALIZATION & FIXED TAB ROUTING
// ==========================================
async function initEngine() {
    const canvas = document.getElementById('galaxy-canvas');
    EngineState.ctx = canvas.getContext('2d');
    
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    bindNavigation();
    bindUIEvents();
    bindCanvasEvents(canvas);

    try {
        await Promise.all([
            loadFactions(),
            loadTerritories(),
            loadStars(),
            loadScans(),
            loadVesselData(),
            loadBattlerTemplates()
        ]);
        console.log("Intrepid Horizon: Systems Online.");
    } catch (error) {
        console.error("Cloud Sync Failure. Utilizing local cache fallback.", error);
    }

    requestAnimationFrame(renderLoop);
}

function bindNavigation() {
    // FIX: Using closest('li') to prevent inner text clicks from breaking routing
    document.querySelectorAll('.nav-tabs li').forEach(tab => {
        tab.addEventListener('click', (e) => {
            const clickedTab = e.target.closest('li');
            if (!clickedTab) return;

            // Remove active states
            document.querySelectorAll('.nav-tabs li').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
            
            // Set new active states
            clickedTab.classList.add('active');
            const targetId = clickedTab.dataset.target;
            document.getElementById(targetId).classList.add('active');
            
            // Ensure map resizes if opened
            if (targetId === 'galaxy-map-view') resizeCanvas();
        });
    });
}

function resizeCanvas() {
    const canvas = document.getElementById('galaxy-canvas');
    if(canvas.parentElement.clientWidth === 0) return; // Prevent collapse sizing
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
    EngineState.width = canvas.width;
    EngineState.height = canvas.height;
}

// ==========================================
// DATA RETRIEVAL (Mocks)
// ==========================================
async function loadFactions() {
    EngineState.factions = [
        { id: 'f1', name: 'United Earth Directorate' },
        { id: 'f2', name: 'Trisolaran Vanguard' },
        { id: 'f3', name: 'Bobiverse Fleet' }
    ];
    const select = document.getElementById('faction-select');
    select.innerHTML = EngineState.factions.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
}
async function loadTerritories() { EngineState.territories = []; }
async function loadStars() {
    for (let i = 0; i < 500; i++) {
        EngineState.stars.push({
            x: (Math.random() - 0.5) * 2000,
            y: (Math.random() - 0.5) * 2000,
            size: Math.random() * 3 + 1
        });
    }
}
async function loadScans() {
    EngineState.scans = [
        { x: 0, y: 0, radius: 400 },
        { x: 300, y: -200, radius: 400 }
    ];
}

// ==========================================
// TACTICAL SHIP BATTLER
// ==========================================
async function loadBattlerTemplates() {
    // Mocking pre-saved templates
    EngineState.battler.templates = [
        { name: "Pirate Frigate", mod: 2, shields: 20, armor: 30, hull: 50 },
        { name: "UED Patrol Cruiser", mod: 4, shields: 80, armor: 100, hull: 150 }
    ];
    updateRosterUI();
}

function deployCombatant(templateData = null) {
    let data = templateData;
    
    // If not deploying from a template, grab from form
    if (!data) {
        const nameInput = document.getElementById('battler-name').value.trim() || "Unknown Vessel";
        const mod = parseInt(document.getElementById('battler-mod').value) || 0;
        const shields = parseInt(document.getElementById('battler-shields').value) || 0;
        const armor = parseInt(document.getElementById('battler-armor').value) || 0;
        const hull = parseInt(document.getElementById('battler-hull').value) || 0;
        
        data = { name: nameInput, mod, shields, armor, hull };

        if (document.getElementById('battler-save-template').checked) {
            EngineState.battler.templates.push({...data});
            updateRosterUI();
        }
    }

    // Roll Initiative (d20 + Pilot Mod)
    const d20 = Math.floor(Math.random() * 20) + 1;
    const initiative = d20 + data.mod;

    const combatant = {
        id: 'c_' + Date.now() + Math.floor(Math.random()*1000),
        name: data.name,
        initiative: initiative,
        shields: data.shields,
        armor: data.armor,
        hull: data.hull
    };

    EngineState.battler.combatants.push(combatant);
    sortAndRenderTracker();
    
    logCombatAction(`Deployed [${combatant.name}]`, `Init Roll: d20(${d20}) + Mod(${data.mod})`, initiative, 'event');
}

function deployFromTemplate(index) {
    deployCombatant(EngineState.battler.templates[index]);
}

function applyDamage(id) {
    const input = document.getElementById(`dmg-input-${id}`);
    let damage = parseInt(input.value) || 0;
    if (damage <= 0) return;

    const unit = EngineState.battler.combatants.find(c => c.id === id);
    if (!unit) return;

    const startingDamage = damage;

    // Damage Cascade Logic
    if (unit.shields > 0) {
        if (damage <= unit.shields) { unit.shields -= damage; damage = 0; }
        else { damage -= unit.shields; unit.shields = 0; }
    }
    if (damage > 0 && unit.armor > 0) {
        if (damage <= unit.armor) { unit.armor -= damage; damage = 0; }
        else { damage -= unit.armor; unit.armor = 0; }
    }
    if (damage > 0 && unit.hull > 0) {
        unit.hull -= damage;
        if (unit.hull < 0) unit.hull = 0;
    }

    input.value = '';
    sortAndRenderTracker();
    logCombatAction(`Target Hit: [${unit.name}]`, `Cascade Impact`, `-${startingDamage} HP`, 'damage-event');
}

function removeCombatant(id) {
    EngineState.battler.combatants = EngineState.battler.combatants.filter(c => c.id !== id);
    sortAndRenderTracker();
}

function sortAndRenderTracker() {
    // Sort highest initiative first
    EngineState.battler.combatants.sort((a, b) => b.initiative - a.initiative);
    
    const tracker = document.getElementById('initiative-tracker');
    tracker.innerHTML = EngineState.battler.combatants.map(c => `
        <div class="combatant-card">
            <div class="header">
                <h4>${c.name}</h4>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <span class="init-badge">INIT: ${c.initiative}</span>
                    <button class="btn-danger" style="padding: 2px 6px; width: auto; margin:0;" onclick="removeCombatant('${c.id}')">X</button>
                </div>
            </div>
            <div class="body">
                <div class="health-metrics">
                    <div class="metric shields"><span>Shields</span><span class="val">${c.shields}</span></div>
                    <div class="metric armor"><span>Armor</span><span class="val">${c.armor}</span></div>
                    <div class="metric hull"><span>Hull</span><span class="val">${c.hull}</span></div>
                </div>
                <div class="damage-controls">
                    <input type="number" id="dmg-input-${c.id}" placeholder="Dmg">
                    <button class="btn-primary" style="width: auto; margin:0;" onclick="applyDamage('${c.id}')">Apply</button>
                </div>
            </div>
        </div>
    `).join('');
}

function updateRosterUI() {
    const roster = document.getElementById('standby-roster');
    roster.innerHTML = EngineState.battler.templates.map((t, index) => `
        <div class="roster-item">
            <span class="name">${t.name}</span>
            <button class="btn-primary" onclick="deployFromTemplate(${index})">Deploy</button>
        </div>
    `).join('');
}


// ==========================================
// VESSEL DIAGNOSTICS
// ==========================================
async function loadVesselData() {
    EngineState.vessel.weapons = [
        { id: 'w_' + Date.now(), name: 'Twin-Linked Railgun', dice: 8, exploding: true }
    ];
    updateVesselUI();
}

function mountWeapon() {
    const nameInput = document.getElementById('new-weapon-name');
    const diceSelect = document.getElementById('new-weapon-dice');
    const explodeToggle = document.getElementById('new-weapon-explode');

    if (!nameInput.value.trim()) return alert("Enter a weapon designation.");

    EngineState.vessel.weapons.push({
        id: 'w_' + Date.now(),
        name: nameInput.value.trim(),
        dice: parseInt(diceSelect.value),
        exploding: explodeToggle.checked
    });
    
    nameInput.value = '';
    updateVesselUI();
}

function rollWeaponDice(weaponId) {
    const weapon = EngineState.vessel.weapons.find(w => w.id === weaponId);
    if (!weapon) return;

    let rolls = [];
    let explosions = 0;
    
    let currentRoll = Math.floor(Math.random() * weapon.dice) + 1;
    rolls.push(currentRoll);
    let totalDamage = currentRoll;

    while (weapon.exploding && currentRoll === weapon.dice) {
        explosions++;
        currentRoll = Math.floor(Math.random() * weapon.dice) + 1;
        rolls.push(currentRoll);
        totalDamage += currentRoll;
    }

    const explosionStr = explosions > 0 ? `<span class="explosion-text"> (${explosions}x Exploded!)</span>` : '';
    logCombatAction(`System Fired: ${weapon.name}`, `Base: d${weapon.dice} | Rolls: [${rolls.join('] + [')}]${explosionStr}`, `Output Yield: ${totalDamage}`, 'event');
}

function updateVesselUI() {
    document.getElementById('weapon-list').innerHTML = EngineState.vessel.weapons.map(w => `
        <div class="weapon-card">
            <h4>${w.name}</h4>
            <div class="weapon-stats">
                <span>Output: <span class="stat-badge">d${w.dice}</span></span>
                <span>Protocol: <span class="stat-badge" style="color: ${w.exploding ? 'var(--accent-orange)' : 'var(--text-dim)'}">${w.exploding ? 'EXPLODING' : 'STATIC'}</span></span>
            </div>
            <button class="btn-roll" onclick="rollWeaponDice('${w.id}')">Execute Firing Sequence</button>
        </div>
    `).join('');
}


// ==========================================
// SHARED COMBAT LOG & MAP UI BINDINGS
// ==========================================
function bindUIEvents() {
    // Map UI
    document.getElementById('dm-omniscience-toggle').addEventListener('change', (e) => EngineState.dmOmniscience = e.target.checked);
    document.getElementById('btn-draw-territory').addEventListener('click', startDrawing);
    document.getElementById('btn-save-territory').addEventListener('click', saveTerritory);
    document.getElementById('btn-cancel-territory').addEventListener('click', cancelDrawing);
    document.getElementById('faction-select').addEventListener('change', (e) => EngineState.drawing.selectedFaction = e.target.value);
    document.getElementById('territory-color').addEventListener('input', (e) => EngineState.drawing.selectedColor = e.target.value);
    
    // Vessel & Battler UI
    document.getElementById('btn-mount-weapon').addEventListener('click', mountWeapon);
    document.getElementById('btn-deploy-unit').addEventListener('click', () => deployCombatant(null));
}

function logCombatAction(title, details, total, typeClass = 'event') {
    const timestamp = new Date().toLocaleTimeString([], { hour12: false });
    const entryHTML = `
        <div class="combat-entry ${typeClass}">
            <div class="timestamp">[${timestamp}] ${title}</div>
            <div class="roll-data">${details}</div>
            <div class="total">${total}</div>
        </div>
    `;

    EngineState.combatLog.unshift(entryHTML);
    if (EngineState.combatLog.length > 20) EngineState.combatLog.pop();

    // Sync to both views
    const html = EngineState.combatLog.join('');
    document.getElementById('vessel-combat-log').innerHTML = html;
    document.getElementById('battler-combat-log').innerHTML = html;
}

// ==========================================
// MAP DRAWING & RENDER ENGINE
// ==========================================
function bindCanvasEvents(canvas) {
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        EngineState.drawing.mousePos = {
            x: e.clientX - rect.left - EngineState.width / 2,
            y: e.clientY - rect.top - EngineState.height / 2
        };
    });
    canvas.addEventListener('click', () => {
        if (!EngineState.drawing.active) return;
        const pos = EngineState.drawing.mousePos;
        const startNode = EngineState.drawing.vertices[0];
        if (startNode && Math.hypot(pos.x - startNode.x, pos.y - startNode.y) < 20 && EngineState.drawing.vertices.length > 2) {
            finishDrawing();
        } else {
            EngineState.drawing.vertices.push({ x: pos.x, y: pos.y });
        }
    });
}
function startDrawing() {
    EngineState.drawing.active = true;
    EngineState.drawing.vertices = [];
    document.getElementById('btn-draw-territory').classList.add('hidden');
    document.getElementById('btn-cancel-territory').classList.remove('hidden');
    document.getElementById('drawing-instructions').classList.remove('hidden');
}
function cancelDrawing() {
    EngineState.drawing.active = false;
    EngineState.drawing.vertices = [];
    document.getElementById('btn-draw-territory').classList.remove('hidden');
    document.getElementById('btn-save-territory').classList.add('hidden');
    document.getElementById('btn-cancel-territory').classList.add('hidden');
    document.getElementById('drawing-instructions').classList.add('hidden');
}
function finishDrawing() {
    EngineState.drawing.active = false;
    document.getElementById('btn-save-territory').classList.remove('hidden');
    document.getElementById('drawing-instructions').innerText = "Shape closed. Ready to save.";
}
async function saveTerritory() {
    const factionId = document.getElementById('faction-select').value;
    if (!factionId) return alert("Select a Faction.");
    const payload = { faction_id: factionId, color: EngineState.drawing.selectedColor, vertices: EngineState.drawing.vertices };
    EngineState.territories.push(payload);
    cancelDrawing();
}

function renderLoop() {
    if (!document.getElementById('galaxy-map-view').classList.contains('active')) {
        requestAnimationFrame(renderLoop);
        return;
    }
    const ctx = EngineState.ctx;
    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 0, EngineState.width, EngineState.height);
    
    ctx.save();
    ctx.translate(EngineState.width / 2, EngineState.height / 2);

    ctx.fillStyle = '#ffffff';
    EngineState.stars.forEach(star => {
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fill();
    });

    EngineState.territories.forEach(renderTerritory);
    if (EngineState.drawing.vertices.length > 0) renderActiveDrawing();
    if (!EngineState.dmOmniscience) renderFogOfWar();

    ctx.restore();
    requestAnimationFrame(renderLoop);
}

function renderTerritory(territory) {
    if (!territory.vertices || territory.vertices.length < 3) return;
    const ctx = EngineState.ctx;
    ctx.beginPath();
    territory.vertices.forEach((v, index) => {
        let renderX = v.x; let renderY = v.y;
        if (!EngineState.dmOmniscience) {
            const snapCoord = calculateFowSnap(v.x, v.y);
            renderX = snapCoord.x; renderY = snapCoord.y;
        }
        if (index === 0) ctx.moveTo(renderX, renderY);
        else ctx.lineTo(renderX, renderY);
    });
    ctx.closePath();
    ctx.fillStyle = `${territory.color}33`; 
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = territory.color;
    ctx.stroke();
}
function renderActiveDrawing() {
    const ctx = EngineState.ctx;
    const vertices = EngineState.drawing.vertices;
    const pos = EngineState.drawing.mousePos;
    ctx.beginPath();
    ctx.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) ctx.lineTo(vertices[i].x, vertices[i].y);
    if (EngineState.drawing.active && pos) ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = EngineState.drawing.selectedColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    vertices.forEach((v, i) => {
        ctx.beginPath();
        const radius = (i === 0 && vertices.length > 2) ? 8 : 4;
        if (i === 0 && vertices.length > 2) ctx.fillStyle = '#ff7300';
        ctx.arc(v.x, v.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
    });
}
function calculateFowSnap(x, y) {
    let isRevealed = false; let closestScan = null; let minDistance = Infinity;
    EngineState.scans.forEach(scan => {
        const dist = Math.hypot(x - scan.x, y - scan.y);
        if (dist <= scan.radius) isRevealed = true;
        else if (dist < minDistance) { minDistance = dist; closestScan = scan; }
    });
    if (isRevealed) return { x, y };
    if (closestScan) {
        const angle = Math.atan2(y - closestScan.y, x - closestScan.x);
        return { x: closestScan.x + Math.cos(angle) * closestScan.radius, y: closestScan.y + Math.sin(angle) * closestScan.radius };
    }
    return { x, y };
}
function renderFogOfWar() {
    const ctx = EngineState.ctx;
    ctx.fillStyle = 'rgba(7, 9, 15, 0.95)';
    ctx.fillRect(-EngineState.width, -EngineState.height, EngineState.width * 2, EngineState.height * 2);
    ctx.globalCompositeOperation = 'destination-out';
    EngineState.scans.forEach(scan => {
        const gradient = ctx.createRadialGradient(scan.x, scan.y, scan.radius * 0.5, scan.x, scan.y, scan.radius);
        gradient.addColorStop(0, 'rgba(0,0,0,1)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(scan.x, scan.y, scan.radius, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
}

// Bootstrap
window.onload = initEngine;
