/* ==========================================================================
   js/db.js - Core State, Auth & Database Sync
   ========================================================================== */
console.log('%c [SYSTEM] DB.JS LOADED SUCCESSFULLY', 'color: #00e5a3; font-weight: bold; font-size: 14px;');

const SUPABASE_URL = 'https://uodeeyfaizbjplvvslry.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7Kj1D_Frh3v0MLNuAyyROQ_rcaTx2F8';

let db = null;
if (window.supabase) {
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
    console.error("CRITICAL ERROR: Supabase CDN failed to load. Check internet connection or AdBlockers.");
}

let currentUserRole = 'player';
let currentUserId = null;
let currentUserEmail = '';
let realtimeChannel = null;
let presenceChannel = null;

let onlineUsersMap = {};
let allProfiles = [];
let playerNotesList = [];
let combatantsList = [];
let campaignObjectivesList = [];
let chatLogsList = [];
let editingNoteId = null;

let bookmarkedTargets = JSON.parse(localStorage.getItem('odyssey_bookmarks') || '[]');
let recentTargets = JSON.parse(localStorage.getItem('odyssey_recents') || '[]');

// MODULE C: Fog of War DRADIS Scan State
window.scannedSystems = JSON.parse(localStorage.getItem('odyssey_scanned') || '[]');

let activeHudTab = 'telemetry';
let globalProceduralSystemsCache = [];
let globalShipMarkersCache = [];
let globalDbSystemsCache = [];
let globalTerritoriesCache = [];
let globalCodexEntriesCache = [];
let globalHyperlanesCache = [];

let editingCodexId = null;
let activeCargoSubtab = 'perishables';
let activeCodexCategory = 'factions';
let codexSearchFilter = '';
let hyperlanesVisible = true;

window.hoveredTarget = null;
window.selectedTarget = null;

let measuringTapeActive = false; let measureStartPoint = null; let measureEndPoint = null;
// NOTE: ping state lives on window (window.pingModeActive / window.activePings), set in map.js
let jumpPlottingActive = false; let activeJumpShip = null; let jumpTargetPoint = null; let selectedDriveSpeed = 250;
let territoryToolActive = false; let territoryDrawActive = false; let activeTerritoryVertices = [];
let hyperlaneDrawActive = false; let activeHyperlaneNodes = [];

const driveSpeeds = {
    sublight: { name: "Sublight Thrusters (0.1c)", speed: 10, label: "0.1c Sublight" },
    ftl_class1: { name: "Standard Class 1 Warp Drive", speed: 250, label: "Class 1 Warp" },
    ftl_class2: { name: "Military Class 2 Hyperdrive", speed: 600, label: "Class 2 Hyperdrive" },
    ftl_fold: { name: "Experimental Fold/Jump Drive", speed: 2500, label: "Fold Jump" }
};

window.handleLogin = async function() {
    if (!db) { alert("Database connection failed."); return; }
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
        const errorDiv = document.getElementById('error-message');
        if (errorDiv) { errorDiv.innerText = "Access Denied: " + error.message; errorDiv.style.display = 'block'; }
        return;
    }
    fetchUserProfile(data.user);
};

async function fetchUserProfile(user) {
    currentUserId = user.id; currentUserEmail = user.email;
    const { data, error } = await db.from('profiles').select('*').eq('id', user.id).single();
    if (error) return;

    currentUserRole = data.role;
    
    document.getElementById('login-wrapper').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    document.getElementById('user-role').innerText = `Role: ${data.role}`;
    
    if (data.role === 'dm') {
        document.getElementById('user-role').classList.add('role-dm');
        document.getElementById('user-role').innerText = 'OVERSEER (DM)';
        document.getElementById('dm-tools').style.display = 'block';
        document.getElementById('dm-time-controls-box').style.display = 'block';
        document.getElementById('dm-scratchpad-toggle-btn').style.display = 'inline-block';
        document.getElementById('territory-tool-toggle-btn').style.display = 'inline-block';
        document.getElementById('codex-dm-creator-panel').style.display = 'block';
        document.getElementById('codex-permission-indicator').innerText = '● OVERSEER AUTHORIZATION';
        document.getElementById('codex-permission-indicator').style.color = '#ff6b6b';
        
        const savedScratch = localStorage.getItem('odyssey_dm_scratchpad');
        if (savedScratch) document.getElementById('dm-scratchpad-input').value = savedScratch;
    }

    initPresenceChannel(data);
    if (typeof initGalaxyEngine === 'function') initGalaxyEngine();
    if (typeof initCalendarEngine === 'function') initCalendarEngine();
    
    loadAllProfiles(); loadPlayerNotes(); loadCombatTracker(); loadCampaignObjectives();
    loadChatLogs(); loadTerritories(); loadHyperlanes(); loadCodexEntries();
}

async function loadAllProfiles() {
    const { data: profData } = await db.from('profiles').select('*');
    const { data: charData } = await db.from('characters').select('*');
    const { data: skillData } = await db.from('character_skills').select('*');
    const { data: arsenalData } = await db.from('character_arsenal').select('*');

    if (profData) {
        allProfiles = profData.map(p => {
            const c = charData?.find(char => char.profile_id === p.id) || {};
            const s = skillData?.find(sk => sk.character_id === c.id) || {};
            const a = arsenalData?.filter(ars => ars.profile_id === p.id || ars.character_id === c.id) || [];
            return { ...p, character: c, skills: s, arsenal: a };
        });
        
        const myProf = allProfiles.find(p => p.id === currentUserId);
        if (myProf) {
            document.getElementById('term-username').value = myProf.username || '';
            if (myProf.avatar_url) {
                document.getElementById('my-terminal-avatar-preview').src = myProf.avatar_url;
                document.getElementById('term-avatar').value = myProf.avatar_url;
            }
        }
        if (typeof window.renderCharacterTerminalData === 'function') window.renderCharacterTerminalData(); 
        if (typeof window.renderCrewRoster === 'function') window.renderCrewRoster();
        if (typeof populateCommsRecipients === 'function') populateCommsRecipients();
    }
}

async function loadPlayerNotes() {
    const { data } = await db.from('player_notes').select('*').order('created_at', { ascending: false });
    if (data) { playerNotesList = data; if (typeof renderTerminalNotes === 'function') renderTerminalNotes(); }
}

async function loadCombatTracker() {
    const { data } = await db.from('combat_tracker').select('*').order('initiative', { ascending: false });
    if (data) { combatantsList = data; if (typeof renderCombatTracker === 'function') renderCombatTracker(); }
}

async function loadCampaignObjectives() {
    const { data } = await db.from('campaign_objectives').select('*').order('created_at', { ascending: false });
    if (data) { campaignObjectivesList = data; if (typeof renderCampaignObjectives === 'function') renderCampaignObjectives(); }
}

async function loadChatLogs() {
    const { data } = await db.from('chat_logs').select('*').order('created_at', { ascending: false }).limit(50);
    if (data) { 
        chatLogsList = data.reverse(); 
        if (chatLogsList.length === 0) chatLogsList = [{ sender_id: 'system', content: '📡 [SYSTEM] Intrepid Horizon secure mainframe linked.', message_type: 'text' }];
        
        // MODULE C: Parse DRADIS Scans to sync FOW across all players
        let newScans = false;
        chatLogsList.forEach(log => {
            let match = log.content.match(/\[SYS_SCAN:(.+?)\]/);
            if (match && !window.scannedSystems.includes(match[1])) {
                window.scannedSystems.push(match[1]);
                newScans = true;
            }
        });
        if (newScans) {
            localStorage.setItem('odyssey_scanned', JSON.stringify(window.scannedSystems));
            if (typeof renderCodexMatrix === 'function') renderCodexMatrix();
        }

        if (typeof renderChatFeed === 'function') renderChatFeed(); 
    }
}

async function loadTerritories() {
    const { data } = await db.from('territories').select('*').order('created_at', { ascending: true });
    if (data) { globalTerritoriesCache = data; if (typeof renderTerritoryList === 'function') renderTerritoryList(); }
}

async function loadHyperlanes() {
    const { data } = await db.from('hyperlanes').select('*');
    if (data) { globalHyperlanesCache = data; if (typeof renderHyperlaneList === 'function') renderHyperlaneList(); }
}

async function loadCodexEntries() {
    const { data } = await db.from('codex_entries').select('*').order('created_at', { ascending: false });
    if (data && data.length > 0) {
        globalCodexEntriesCache = data;
    } else {
        globalCodexEntriesCache = [{ id: 'cdx-1', category: 'factions', title: 'Task Force Black', subtitle: 'Allied Command', content: 'Autonomous fleet.' }];
    }
    if (typeof renderCodexMatrix === 'function') renderCodexMatrix();
    if (typeof populateTerritoryFactionSelect === 'function') populateTerritoryFactionSelect();
}

async function checkAnomalyProximity(ship) {
    if (!ship) return;
    const DRADIS_RANGE = 180;
    let anomalies = globalDbSystemsCache.filter(s => s.luminosity === 'Hidden Anomaly');
    for (let anomaly of anomalies) {
        let dist = Math.hypot(ship.x - anomaly.x, ship.y - anomaly.y);
        if (dist < DRADIS_RANGE) {
            await db.from('star_systems').update({ luminosity: 'Revealed Anomaly', color: '#ff3333' }).eq('id', anomaly.id);
            await db.from('chat_logs').insert({ sender_id: 'system', content: `🚨 [DRADIS ALERT] Vessel '${ship.name}' detected a subspace anomaly at X:${Math.round(anomaly.x)} Y:${Math.round(anomaly.y)}.`, message_type: 'text' });
            if (window.AudioEngine) window.AudioEngine.playKlaxon();
            anomaly.luminosity = 'Revealed Anomaly'; anomaly.color = '#ff3333';
        }
    }
}

function initPresenceChannel(userProfile) {
    presenceChannel = db.channel('online_map_users', { config: { presence: { key: currentUserId } } });
    realtimeChannel = presenceChannel;
    presenceChannel.on('presence', { event: 'sync' }, () => { 
        onlineUsersMap = presenceChannel.presenceState(); 
        if (typeof renderPresenceTicker === 'function') renderPresenceTicker(); 
    }).on('broadcast', { event: 'tactical_ping' }, ({ payload }) => {
        if (!payload) return;
        window.activePings.push({ x: payload.x, y: payload.y, color: payload.color, user: payload.username, startTime: Date.now() });
        if (window.AudioEngine) window.AudioEngine.playPing();
    }).subscribe(async (status) => {
        if (status === 'SUBSCRIBED') { 
            await presenceChannel.track({ online_at: new Date().toISOString(), username: userProfile.username || currentUserEmail.split('@')[0], role: userProfile.role, avatar_url: userProfile.avatar_url || '' }); 
        }
    });
}

// Re-track presence with fresh profile data (e.g. after a display handle change)
// so the Active Commanders ticker updates immediately instead of only on reload.
window.refreshMyPresence = async function(userProfile) {
    if (!presenceChannel) return;
    await presenceChannel.track({ online_at: new Date().toISOString(), username: userProfile.username || currentUserEmail.split('@')[0], role: userProfile.role || currentUserRole, avatar_url: userProfile.avatar_url || '' });
};

function renderPresenceTicker() {
    const listDiv = document.getElementById('presence-list');
    if (!listDiv) return;
    let html = '';
    Object.keys(onlineUsersMap).forEach(userId => {
        const presences = onlineUsersMap[userId];
        if (presences && presences.length > 0) {
            const p = presences[0];
            html += `<div class="presence-pill" onclick="window.snapToCommander('${userId}')" style="cursor:pointer;" title="Click to locate vessel">🟢 ${p.username} ${p.role === 'dm' ? '[DM]' : ''}</div>`;
        }
    });
    listDiv.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No active commanders</span>';
}

window.snapToCommander = function(userId) {
    let ship = globalShipMarkersCache.find(m => m.owner_id === userId);
    if (ship) {
        window.selectedTarget = { type: 'ship', data: ship };
        if (typeof window.lockCameraOnSelected === 'function') window.lockCameraOnSelected();
        if (typeof renderHUDTelemetry === 'function') window.renderHUDTelemetry();
        document.getElementById('character-terminal').style.display = 'none'; 
        if (window.AudioEngine) window.AudioEngine.playPing();
    } else {
        alert("DRADIS Error: No active vessel found assigned to this commander.");
    }
};

window.exportCampaignBackup = function() {
    if (currentUserRole !== 'dm') return;
    const backup = {
        timestamp: new Date().toISOString(), universeTimeHours: window.universeTimeHours,
        starSystems: globalDbSystemsCache, shipMarkers: globalShipMarkersCache,
        territories: globalTerritoriesCache, hyperlanes: globalHyperlanesCache,
        codexEntries: globalCodexEntriesCache, combatants: combatantsList
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `task_force_black_backup_${Date.now()}.json`);
    document.body.appendChild(downloadAnchorNode); downloadAnchorNode.click(); downloadAnchorNode.remove();
};

window.handleLogout = async function() {
    if (presenceChannel) await presenceChannel.untrack();
    await db.auth.signOut();
    location.reload();
};
