/**
 * INTREPID HORIZON // GALAXY MAP ENGINE
 * Core Architecture: Render loop, Fog of War, and Territory Drawing
 */

// Defensive Cloud Init (Mock config, assumes live keys injected by deployment pipeline)
const supabaseUrl = 'https://YOUR_SUPABASE_PROJECT.supabase.co';
const supabaseKey = 'YOUR_ANON_KEY';
const supabase = window.supabase.createClient(supabaseUrl, supabaseKey);

// Global State Machine
const EngineState = {
    isDM: true, // Tied to authentication profile
    dmOmniscience: true,
    factions: [],
    territories: [],
    stars: [],
    scans: [], // Array of coordinates {x, y, radius: 40} representing deep scans
    
    // Territory Drawing State
    drawing: {
        active: false,
        vertices: [],
        mousePos: null,
        selectedFaction: null,
        selectedColor: '#00e5ff'
    },

    // Camera & Canvas
    ctx: null,
    width: 0,
    height: 0,
    camera: { x: 0, y: 0, zoom: 1 }
};

// ==========================================
// INITIALIZATION & SUPABASE SYNC
// ==========================================
async function initEngine() {
    const canvas = document.getElementById('galaxy-canvas');
    EngineState.ctx = canvas.getContext('2d');
    
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    bindUIEvents();
    bindCanvasEvents(canvas);

    // Defensive data loading
    try {
        await Promise.all([
            loadFactions(),
            loadTerritories(),
            loadStars(),
            loadScans()
        ]);
        console.log("Intrepid Horizon: Systems Online.");
    } catch (error) {
        console.error("Cloud Sync Failure. Utilizing local cache fallback.", error);
    }

    // Start 60fps render loop
    requestAnimationFrame(renderLoop);
}

function resizeCanvas() {
    const canvas = document.getElementById('galaxy-canvas');
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
    EngineState.width = canvas.width;
    EngineState.height = canvas.height;
}

// ==========================================
// DATA RETRIEVAL (Mocks for Structure)
// ==========================================
async function loadFactions() {
    // In production: const { data } = await supabase.from('factions').select('*');
    EngineState.factions = [
        { id: 'f1', name: 'United Earth Directorate' },
        { id: 'f2', name: 'Trisolaran Vanguard' },
        { id: 'f3', name: 'Bobiverse Fleet' }
    ];
    
    const select = document.getElementById('faction-select');
    select.innerHTML = EngineState.factions.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
}

async function loadTerritories() {
    // In production: const { data } = await supabase.from('territories').select('*');
    EngineState.territories = []; // Empty for now, populated by drawing
}

async function loadStars() {
    // Generate mock stars for procedural engine
    for (let i = 0; i < 500; i++) {
        EngineState.stars.push({
            x: (Math.random() - 0.5) * 2000,
            y: (Math.random() - 0.5) * 2000,
            size: Math.random() * 3 + 1
        });
    }
}

async function loadScans() {
    // Mocking past deep scans made by players
    EngineState.scans = [
        { x: 0, y: 0, radius: 400 }, // Starting sector
        { x: 300, y: -200, radius: 400 } // Explored sector
    ];
}

// ==========================================
// DRAWING MECHANICS & UI BINDS
// ==========================================
function bindUIEvents() {
    document.getElementById('dm-omniscience-toggle').addEventListener('change', (e) => {
        EngineState.dmOmniscience = e.target.checked;
    });

    document.getElementById('btn-draw-territory').addEventListener('click', startDrawing);
    document.getElementById('btn-save-territory').addEventListener('click', saveTerritory);
    document.getElementById('btn-cancel-territory').addEventListener('click', cancelDrawing);
    
    document.getElementById('faction-select').addEventListener('change', (e) => {
        EngineState.drawing.selectedFaction = e.target.value;
    });
    
    document.getElementById('territory-color').addEventListener('input', (e) => {
        EngineState.drawing.selectedColor = e.target.value;
    });
}

function bindCanvasEvents(canvas) {
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        // Adjust for camera in full engine, simplified here
        EngineState.drawing.mousePos = {
            x: e.clientX - rect.left - EngineState.width / 2,
            y: e.clientY - rect.top - EngineState.height / 2
        };
    });

    canvas.addEventListener('click', (e) => {
        if (!EngineState.drawing.active) return;
        
        const pos = EngineState.drawing.mousePos;
        const startNode = EngineState.drawing.vertices[0];
        
        // Node snapping to close shape (20px tolerance)
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
    if (!factionId) return alert("Select a Faction to assign this territory to.");
    
    const payload = {
        faction_id: factionId,
        color: EngineState.drawing.selectedColor,
        vertices: EngineState.drawing.vertices
    };

    try {
        // Defensive Cloud Insert
        if (supabase?.auth) {
            const { error } = await supabase.from('territories').insert([payload]);
            if (error) throw error;
        }
        
        // Update local state immediately
        EngineState.territories.push(payload);
        cancelDrawing();
        
    } catch (err) {
        console.error("Cloud Save Failed:", err);
        alert("Failed to sync to Cloud Codex. Try again.");
    }
}

// ==========================================
// RENDER ENGINE & FOG OF WAR LOGIC
// ==========================================
function renderLoop() {
    const ctx = EngineState.ctx;
    
    // Clear Canvas
    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 0, EngineState.width, EngineState.height);
    
    ctx.save();
    // Center camera
    ctx.translate(EngineState.width / 2, EngineState.height / 2);

    // 1. Render Stars
    ctx.fillStyle = '#ffffff';
    EngineState.stars.forEach(star => {
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fill();
    });

    // 2. Render Territories (The Core Request)
    EngineState.territories.forEach(renderTerritory);

    // 3. Render Active Drawing
    if (EngineState.drawing.vertices.length > 0) {
        renderActiveDrawing();
    }

    // 4. Render Fog of War (Player View)
    if (!EngineState.dmOmniscience) {
        renderFogOfWar();
    }

    ctx.restore();
    requestAnimationFrame(renderLoop);
}

function renderTerritory(territory) {
    if (!territory.vertices || territory.vertices.length < 3) return;
    const ctx = EngineState.ctx;
    
    ctx.beginPath();
    
    territory.vertices.forEach((v, index) => {
        // --- DYNAMIC NODE SNAPPING LOGIC ---
        // If DM is viewing, show true coords.
        // If Player is viewing, pull unknown coords toward nearest scanned area.
        let renderX = v.x;
        let renderY = v.y;

        if (!EngineState.dmOmniscience) {
            const snapCoord = calculateFowSnap(v.x, v.y);
            renderX = snapCoord.x;
            renderY = snapCoord.y;
        }

        if (index === 0) ctx.moveTo(renderX, renderY);
        else ctx.lineTo(renderX, renderY);
    });
    
    ctx.closePath();
    
    // Styling based on faction color
    // Use defensive parsing to inject alpha channel for fill
    ctx.fillStyle = `${territory.color}33`; // 20% opacity hex
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
    
    for (let i = 1; i < vertices.length; i++) {
        ctx.lineTo(vertices[i].x, vertices[i].y);
    }
    
    if (EngineState.drawing.active && pos) {
        ctx.lineTo(pos.x, pos.y);
    }
    
    ctx.strokeStyle = EngineState.drawing.selectedColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]); // Dashed line for active drawing
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Draw Nodes
    ctx.fillStyle = '#ffffff';
    vertices.forEach((v, i) => {
        ctx.beginPath();
        // Highlight start node to indicate closing the shape
        const radius = (i === 0 && vertices.length > 2) ? 8 : 4;
        if (i === 0 && vertices.length > 2) ctx.fillStyle = '#ff7300';
        ctx.arc(v.x, v.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
    });
}

function calculateFowSnap(x, y) {
    // Checks if the vertex falls within ANY deep scan ping.
    let isRevealed = false;
    let closestScan = null;
    let minDistance = Infinity;

    EngineState.scans.forEach(scan => {
        const dist = Math.hypot(x - scan.x, y - scan.y);
        if (dist <= scan.radius) {
            isRevealed = true;
        } else if (dist < minDistance) {
            minDistance = dist;
            closestScan = scan;
        }
    });

    if (isRevealed) return { x, y };

    // If hidden, calculate vector to pull vertex to the perimeter of the closest scan
    // This creates the dynamic "snapping" outward as players push their ships further.
    if (closestScan) {
        const angle = Math.atan2(y - closestScan.y, x - closestScan.x);
        return {
            x: closestScan.x + Math.cos(angle) * closestScan.radius,
            y: closestScan.y + Math.sin(angle) * closestScan.radius
        };
    }
    
    return { x, y }; // Fallback
}

function renderFogOfWar() {
    const ctx = EngineState.ctx;
    
    // Create a dark overlay that we "punch holes" into using destination-out composite
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
