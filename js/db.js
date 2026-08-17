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
// Per-tab comms caches — General stays in chatLogsList (fetched fresh),
// Dice and each PM thread are fetched on demand so a busy Dice Streamer
// can't crowd General/PM history out of a shared row limit.
window.diceLogsList = null;
window.pmLogsCache = {};
window.pmPartnerIds = new Set();
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
window.globalSystemHazardsCache = [];

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
    initChatRealtimeChannel();
    initCombatTrackerRealtimeChannel();
    initColoniesRealtimeChannel();
    initShipTemplatesRealtimeChannel();
    initSystemHazardsRealtimeChannel();
    if (typeof initGalaxyEngine === 'function') initGalaxyEngine();
    if (typeof initCalendarEngine === 'function') initCalendarEngine();
    
    loadAllProfiles(); loadPlayerNotes(); loadCombatTracker(); loadCampaignObjectives();
    loadChatLogs(); loadPmPartnerList(); loadTerritories(); loadHyperlanes(); loadCodexEntries();
    if (typeof loadColonies === 'function') loadColonies();
    if (typeof loadFleetGroups === 'function') loadFleetGroups();
    if (typeof loadShipTemplates === 'function') loadShipTemplates();
    if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
    if (typeof loadSystemHazards === 'function') loadSystemHazards();
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

window.checkSysScan = function(log) {
    let match = log.content.match(/\[SYS_SCAN:(.+?)\]/);
    if (match && !window.scannedSystems.includes(match[1])) {
        window.scannedSystems.push(match[1]);
        localStorage.setItem('odyssey_scanned', JSON.stringify(window.scannedSystems));
        if (typeof renderCodexMatrix === 'function') renderCodexMatrix();
        return true;
    }
    return false;
};

async function loadChatLogs() {
    // "General Broadcast" channel only — dice rolls and PMs are fetched
    // separately (loadDiceLogs / loadPmLogs), each with their own limit.
    const { data } = await db.from('chat_logs').select('*')
        .is('recipient_id', null).neq('message_type', 'roll')
        .order('created_at', { ascending: false }).limit(75);
    if (data) { 
        chatLogsList = data.reverse(); 
        if (chatLogsList.length === 0) chatLogsList = [{ sender_id: 'system', content: '📡 [SYSTEM] Intrepid Horizon secure mainframe linked.', message_type: 'text' }];
        chatLogsList.forEach(log => window.checkSysScan(log));
        if (typeof renderChatFeed === 'function') renderChatFeed(); 
    }
}

async function loadDiceLogs() {
    const { data } = await db.from('chat_logs').select('*').eq('message_type', 'roll').order('created_at', { ascending: false }).limit(50);
    if (data) window.diceLogsList = data.reverse();
}

async function loadPmLogs(partnerId) {
    const { data } = await db.from('chat_logs').select('*')
        .or(`and(sender_id.eq.${currentUserId},recipient_id.eq.${partnerId}),and(sender_id.eq.${partnerId},recipient_id.eq.${currentUserId})`)
        .order('created_at', { ascending: false }).limit(50);
    if (data) window.pmLogsCache[partnerId] = data.reverse();
}

async function loadPmPartnerList() {
    // Lightweight metadata-only query (no message content) just to know which
    // PM tabs should exist — actual thread content loads lazily via loadPmLogs
    // the first time each tab is opened.
    const { data } = await db.from('chat_logs').select('sender_id, recipient_id')
        .or(`sender_id.eq.${currentUserId},recipient_id.eq.${currentUserId}`)
        .not('recipient_id', 'is', null);
    if (!data) return;
    data.forEach(row => {
        if (row.sender_id === currentUserId && row.recipient_id !== currentUserId) window.pmPartnerIds.add(row.recipient_id);
        else if (row.recipient_id === currentUserId && row.sender_id !== currentUserId) window.pmPartnerIds.add(row.sender_id);
    });
    if (typeof window.renderCommsTabBar === 'function') window.renderCommsTabBar();
}

async function loadTerritories() {
    const { data } = await db.from('territories').select('*').order('created_at', { ascending: true });
    if (data) { globalTerritoriesCache = data; if (typeof renderTerritoryList === 'function') renderTerritoryList(); }
}

async function loadHyperlanes() {
    const { data } = await db.from('hyperlanes').select('*');
    if (data) { globalHyperlanesCache = data; if (typeof renderHyperlaneList === 'function') renderHyperlaneList(); }
}

async function loadSystemHazards() {
    const { data } = await db.from('system_hazards').select('*');
    if (data) { window.globalSystemHazardsCache = data; if (typeof renderHazardZoneList === 'function') renderHazardZoneList(); }
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

/* --- PRESENCE: ACTIVITY BLURB TRACKING ---
   Supabase presence .track() replaces the ENTIRE payload for a key on every
   call, it doesn't merge — so both the profile fields (username/role/avatar)
   and the current activity string have to be re-sent together every time
   either one changes, or the other silently disappears from presence state.
   Everything routes through trackMyPresence() so that never happens. */
window.myPresenceProfile = { username: '', role: '', avatar_url: '' };
window.myCurrentActivity = 'Monitoring DRADIS';

async function trackMyPresence() {
    if (!presenceChannel) return;
    await presenceChannel.track({
        online_at: new Date().toISOString(),
        username: window.myPresenceProfile.username || currentUserEmail.split('@')[0],
        role: window.myPresenceProfile.role || currentUserRole,
        avatar_url: window.myPresenceProfile.avatar_url || '',
        activity: window.myCurrentActivity
    });
}

function initPresenceChannel(userProfile) {
    window.myPresenceProfile = { username: userProfile.username, role: userProfile.role, avatar_url: userProfile.avatar_url };
    presenceChannel = db.channel('online_map_users', { config: { presence: { key: currentUserId } } });
    realtimeChannel = presenceChannel;
    presenceChannel.on('presence', { event: 'sync' }, () => { 
        onlineUsersMap = presenceChannel.presenceState(); 
        if (typeof renderPresenceTicker === 'function') renderPresenceTicker(); 
    }).on('broadcast', { event: 'tactical_ping' }, ({ payload }) => {
        if (!payload) return;
        window.activePings.push({ x: payload.x, y: payload.y, color: payload.color, user: payload.username, startTime: Date.now() });
        if (window.AudioEngine) window.AudioEngine.playPing();
        if (typeof loadChatLogs === 'function') loadChatLogs();
    }).subscribe(async (status) => {
        if (status === 'SUBSCRIBED') { await trackMyPresence(); }
    });
}

// Re-track presence with fresh profile data (e.g. after a display handle change)
// so the Active Commanders ticker updates immediately instead of only on reload.
window.refreshMyPresence = async function(userProfile) {
    window.myPresenceProfile = { username: userProfile.username, role: userProfile.role || currentUserRole, avatar_url: userProfile.avatar_url };
    await trackMyPresence();
};

// Called whenever the user switches terminal tabs, opens/closes the terminal,
// etc. — see the TERM_TAB_ACTIVITY_LABELS hookup in ui.js.
window.broadcastActivity = async function(activityLabel) {
    if (!activityLabel || activityLabel === window.myCurrentActivity) return;
    window.myCurrentActivity = activityLabel;
    await trackMyPresence();
};

/* --- COMMS: REAL-TIME chat_logs SUBSCRIPTION ---
   Drives the multi-tab Comms Array — new PM tabs spawn/reopen and unread
   highlights fire the moment a row lands, instead of only on the next
   manual loadChatLogs() call. Requires Realtime replication to be enabled
   on the chat_logs table in the Supabase dashboard (Database > Replication)
   — without that, this channel connects but never receives INSERT events. */
let chatRealtimeChannel = null;
function initChatRealtimeChannel() {
    chatRealtimeChannel = db.channel('chat_logs_stream')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_logs' }, (payload) => {
            if (typeof window.handleIncomingChatLog === 'function') window.handleIncomingChatLog(payload.new);
        })
        .subscribe();
}

/* --- COMBAT INITIATIVE TRACKER: REAL-TIME SYNC ---
   Without this, a player's addCombatant()/removeCombatant() only ever
   updates their OWN client's combatantsList — nobody else, including the
   DM, finds out until something else on their end happens to re-trigger
   loadCombatTracker() (or they reload the page). Subscribing to every
   change on the table and just refetching keeps everyone's tracker in
   sync live. Same Supabase Realtime replication requirement as chat_logs
   (Database > Replication) — enable it for combat_tracker too. */
let combatTrackerRealtimeChannel = null;
function initCombatTrackerRealtimeChannel() {
    combatTrackerRealtimeChannel = db.channel('combat_tracker_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'combat_tracker' }, () => {
            if (typeof loadCombatTracker === 'function') loadCombatTracker();
        })
        .subscribe();
}

/* --- COLONIES & FLEET GROUPS: REAL-TIME SYNC ---
   Same reasoning as combat_tracker above — without this, one player's
   addColony()/addFleetGroup()/edits only update their own client. Requires
   Realtime replication enabled for both tables (Database > Replication). */
let coloniesRealtimeChannel = null;
let fleetGroupsRealtimeChannel = null;
function initColoniesRealtimeChannel() {
    coloniesRealtimeChannel = db.channel('colonies_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'colonies' }, () => {
            if (typeof loadColonies === 'function') loadColonies();
        })
        .subscribe();
    fleetGroupsRealtimeChannel = db.channel('fleet_groups_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'fleet_groups' }, () => {
            if (typeof loadFleetGroups === 'function') loadFleetGroups();
        })
        .subscribe();
}

/* --- SHIP TEMPLATES: REAL-TIME SYNC ---
   One table backs both the public Ship Designer and the DM Secret Repository
   (is_secret flag), so a change to either needs both lists refreshed —
   loadSecretShipTemplates() is a no-op for non-DM clients anyway. */
let shipTemplatesRealtimeChannel = null;
function initShipTemplatesRealtimeChannel() {
    shipTemplatesRealtimeChannel = db.channel('ship_templates_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ship_templates' }, () => {
            if (typeof loadShipTemplates === 'function') loadShipTemplates();
            if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
        })
        .subscribe();
}

/* --- SYSTEM HAZARDS: REAL-TIME SYNC --- */
let systemHazardsRealtimeChannel = null;
function initSystemHazardsRealtimeChannel() {
    systemHazardsRealtimeChannel = db.channel('system_hazards_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'system_hazards' }, () => {
            if (typeof loadSystemHazards === 'function') loadSystemHazards();
        })
        .subscribe();
}

function renderPresenceTicker() {
    const listDiv = document.getElementById('presence-list');
    if (!listDiv) return;
    let html = '';
    Object.keys(onlineUsersMap).forEach(userId => {
        const presences = onlineUsersMap[userId];
        if (presences && presences.length > 0) {
            const p = presences[0];
            const activity = (p.activity || 'Monitoring DRADIS').toLowerCase();
            html += `<div class="presence-pill" onclick="window.snapToCommander('${userId}')" title="Click to locate vessel">
                <span class="presence-name">🟢 ${p.username} ${p.role === 'dm' ? '[DM]' : ''}</span>
                <span class="presence-activity">${activity}</span>
            </div>`;
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

/* --- FEATURE: UNIVERSAL "JUMP TO SHIP" / SPACETIME INVERSION SHORTCUT ---
   Pans the canvas to the user's own vessel, opens the character terminal
   straight to the Vessel Deck tab, and applies an in-universe clock rollback
   as an Expeditionary-Force-style FTL jump time-inversion flourish. Rollback
   scales with distance since the ship's LAST recorded jump position (not
   camera position), using the same world-units -> FTL-hours conversion as
   the measuring tape tool for consistency, hard-capped at 72h. Only applies
   to FTL-drive vessels by default — sublight vessels just advance time
   normally — but a DM can flip window.jumpInversionFtlOnly off (checkbox in
   the Chronology Control Deck panel) to apply it to every drive type.
   Always logged to Comms so a DM watching the timeline isn't surprised by
   it — it's flavor, not a way for players to freely rewind the clock at
   will (that stays DM-gated via window.adjustTime). */
window.JUMP_TIME_INVERSION_MAX_HOURS = 72;
window.jumpInversionFtlOnly = localStorage.getItem('odyssey_jump_ftl_only') !== 'false'; // default ON
window.setJumpInversionFtlOnly = function(checked) {
    window.jumpInversionFtlOnly = !!checked;
    localStorage.setItem('odyssey_jump_ftl_only', window.jumpInversionFtlOnly ? 'true' : 'false');
};

window.jumpToActiveShip = async function() {
    let ship = globalShipMarkersCache.find(m => m.owner_id === currentUserId);
    if (!ship) { alert("DRADIS Error: No active vessel found assigned to your callsign."); return; }

    window.selectedTarget = { type: 'ship', data: ship };
    if (typeof window.lockCameraOnSelected === 'function') window.lockCameraOnSelected();
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    if (typeof window.openFullVesselTerminal === 'function') window.openFullVesselTerminal(ship.id);
    if (window.AudioEngine) window.AudioEngine.playPing();

    const isFtl = (ship.drive_type || 'ftl_class1') !== 'sublight';
    if (window.jumpInversionFtlOnly && !isFtl) return; // Sublight vessel: time advances normally, no inversion.

    let lastPos = ship.last_ftl_position || { x: ship.x, y: ship.y };
    let jumpDist = Math.hypot(ship.x - lastPos.x, ship.y - lastPos.y);

    // Gravity Well hazard: harder to navigate/plot a clean jump vector near
    // one, represented as inflated effective jump distance (and so, more
    // rollback hours) rather than inventing a separate movement-points
    // resource this app doesn't otherwise track.
    let gravityWellHit = (typeof window.checkShipHazards === 'function') ? window.checkShipHazards(ship).find(h => h.type === 'gravity_well') : null;
    let gravityWellNote = '';
    if (gravityWellHit) {
        const mult = 1 + (0.5 * (gravityWellHit.intensity || 1));
        jumpDist = jumpDist * mult;
        gravityWellNote = ` [GRAVITY WELL: jump vector distorted, effective distance x${mult}]`;
    }

    let rollbackHours = Math.min(window.JUMP_TIME_INVERSION_MAX_HOURS, Math.round(jumpDist / 250));

    // Baseline the ship's next jump distance from wherever it is right now.
    const newLastPos = { x: ship.x, y: ship.y };
    ship.last_ftl_position = newLastPos;
    db.from('ship_markers').update({ last_ftl_position: newLastPos }).eq('id', ship.id);

    if (typeof window.universeTimeHours === 'number' && rollbackHours > 0) {
        let oldTime = window.universeTimeHours;
        window.universeTimeHours = Math.max(0, window.universeTimeHours - rollbackHours);
        localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
        if (typeof window.updateCalendarDisplay === 'function') window.updateCalendarDisplay();
        if (typeof window.processTimeAdvancement === 'function') await window.processTimeAdvancement(oldTime, window.universeTimeHours);
        const cappedNote = jumpDist / 250 > window.JUMP_TIME_INVERSION_MAX_HOURS ? ' [CAPPED]' : '';
        await db.from('chat_logs').insert({
            sender_id: 'system',
            content: `🌀 [TEMPORAL DESYNC] ${ship.name} completed an FTL jump (${jumpDist.toFixed(1)}u since last transit). Chronometer reads ${rollbackHours}h prior to departure per relativistic inversion.${cappedNote}${gravityWellNote}`,
            message_type: 'text'
        });
        if (typeof loadChatLogs === 'function') loadChatLogs();
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
