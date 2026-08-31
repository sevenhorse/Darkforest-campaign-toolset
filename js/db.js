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
// Relativistic time-inversion constant (this session's lore fix — see
// window.executePlottedJump in js/map.js for where this is actually used).
// A plotted FTL jump's backward chronometer drift = distance * drive speed
// / this constant, so a faster/more exotic drive causes proportionally MORE
// drift for the same distance covered (a bigger causality violation for a
// bigger technological edge) — confirmed design, not guessed. Sublight
// drives cause none of this by default (see window.jumpInversionFtlOnly
// below). First-pass tuning, not battle-tested: 62500 was picked so a
// baseline Class 1 Warp jump between two just-barely-4-LY-apart stars (the
// new minimum star spacing) drifts ~2 hours, and a full width-of-the-galaxy
// jump on the same drive drifts ~128 hours (~5.3 days) — both matching the
// DM's own "a couple hours... several days" examples.
window.TEMPORAL_DRIFT_CONSTANT = 62500;

window.handleLogin = async function() {
    if (!db) { alert("Database connection failed."); return; }
    // Guards against a double-click firing two concurrent login flows — each
    // one independently created its own presence channel (and its own ping
    // listener), so a single ping would fire audio/visual twice until one of
    // the duplicate channels eventually dropped.
    if (window._loginInProgress) return;
    window._loginInProgress = true;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
        window._loginInProgress = false;
        const errorDiv = document.getElementById('error-message');
        if (errorDiv) { errorDiv.innerText = "Access Denied: " + error.message; errorDiv.style.display = 'block'; }
        return;
    }
    fetchUserProfile(data.user);
};

async function fetchUserProfile(user) {
    currentUserId = user.id; currentUserEmail = user.email;
    const { data, error } = await db.from('profiles').select('*').eq('id', user.id).single();
    // Bug fix (bug hunt, this session): this used to just `return` on error,
    // leaving window._loginInProgress stuck at true forever (it's only reset
    // in handleLogin's own sign-in-error branch, not here). A transient
    // network blip or RLS hiccup on this SELECT right after a successful
    // sign-in would leave the login screen frozen with no feedback, and
    // every subsequent login click would silently no-op at the
    // `_loginInProgress` guard in handleLogin -- only a full page reload
    // could recover. Reset the guard and surface an error the same way the
    // sign-in-error branch does.
    if (error) {
        window._loginInProgress = false;
        const errorDiv = document.getElementById('error-message');
        if (errorDiv) { errorDiv.innerText = "Access Denied: failed to load your profile (" + error.message + "). Please try again."; errorDiv.style.display = 'block'; }
        return;
    }

    currentUserRole = data.role;
    
    document.getElementById('login-wrapper').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    document.getElementById('user-role').innerText = `Role: ${data.role}`;
    
    if (data.role === 'dm') {
        document.getElementById('user-role').classList.add('role-dm');
        document.getElementById('user-role').innerText = 'OVERSEER (DM)';
        document.getElementById('dm-tools').style.display = 'block';
        // DM note #7 build (this session): Secret Repository's full-screen
        // editor tab lives in the Command Terminal now (same nav as Vessel
        // Deck/Ship Designer), not the floating DM Tools panel -- gated here
        // the same way every other DM-only element on this screen already is.
        const secretRepoTabBtn = document.getElementById('term-tab-btn-secretrepo');
        if (secretRepoTabBtn) secretRepoTabBtn.style.display = 'flex';
        // Strike Craft Designer build (this session): same DM-only tab-reveal
        // convention as Secret Repository just above.
        const strikeCraftTabBtn = document.getElementById('term-tab-btn-strikecraft');
        if (strikeCraftTabBtn) strikeCraftTabBtn.style.display = 'flex';
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
    if (typeof initShipMarkersRealtimeChannel === 'function') initShipMarkersRealtimeChannel();
    initSystemHazardsRealtimeChannel();
    initPerkDefinitionsRealtimeChannel();
    if (typeof initAugmentDefinitionsRealtimeChannel === 'function') initAugmentDefinitionsRealtimeChannel();
    if (typeof initGearDefinitionsRealtimeChannel === 'function') initGearDefinitionsRealtimeChannel();
    initHazardDefinitionsRealtimeChannel();
    initPlanetaryModifiersRealtimeChannel();
    initHyperlanesRealtimeChannel();
    initSystemOwnershipRealtimeChannel();
    if (typeof initBattleEncountersRealtimeChannel === 'function') initBattleEncountersRealtimeChannel();
    if (typeof initBattlefieldSalvageRealtimeChannel === 'function') initBattlefieldSalvageRealtimeChannel();
    if (typeof initSavedFleetsRealtimeChannel === 'function') initSavedFleetsRealtimeChannel();
    if (typeof initManufacturingBlueprintsRealtimeChannel === 'function') initManufacturingBlueprintsRealtimeChannel();
    if (typeof initManufacturingOrdersRealtimeChannel === 'function') initManufacturingOrdersRealtimeChannel();
    if (typeof initGalaxyEngine === 'function') initGalaxyEngine();
    if (typeof initCalendarEngine === 'function') initCalendarEngine();
    // Kick off the ambient music bed now that we have a real authenticated
    // session -- the music files live in a private Supabase Storage bucket
    // (signed URLs only), so this can't succeed before login the way the
    // old local-file version could.
    if (window.AudioEngine && !window.AudioEngine.isMuted()) window.AudioEngine.startAmbient();

    loadAllProfiles(); loadPlayerNotes(); loadCombatTracker(); loadCampaignObjectives();
    loadChatLogs(); loadPmPartnerList(); loadTerritories(); loadHyperlanes(); loadCodexEntries();
    if (typeof loadColonies === 'function') loadColonies();
    if (typeof loadFleetGroups === 'function') loadFleetGroups();
    if (typeof loadShipTemplates === 'function') loadShipTemplates();
    if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
    if (typeof loadSystemHazards === 'function') loadSystemHazards();
    if (typeof loadPerkDefinitions === 'function') loadPerkDefinitions();
    if (typeof loadAugmentDefinitions === 'function') loadAugmentDefinitions();
    if (typeof loadGearDefinitions === 'function') loadGearDefinitions();
    if (typeof window.loadStrikeCraftTemplates === 'function') window.loadStrikeCraftTemplates();
    if (typeof loadHazardDefinitions === 'function') loadHazardDefinitions();
    if (typeof loadPlanetaryModifiers === 'function') loadPlanetaryModifiers();
    loadSystemOwnershipOverrides();
    if (typeof loadBattleEncounters === 'function') loadBattleEncounters();
    if (typeof loadBattlefieldSalvage === 'function') loadBattlefieldSalvage();
    if (typeof loadSavedFleets === 'function') loadSavedFleets();
    if (typeof loadManufacturingBlueprints === 'function') loadManufacturingBlueprints();
    if (typeof loadManufacturingOrders === 'function') loadManufacturingOrders();
}

async function loadAllProfiles() {
    const { data: profData } = await db.from('profiles').select('*');
    const { data: charData } = await db.from('characters').select('*');
    const { data: skillData } = await db.from('character_skills').select('*');
    const { data: arsenalData } = await db.from('character_arsenal').select('*');
    const { data: perkData } = await db.from('character_perks').select('*');
    const { data: augmentData } = await db.from('character_augments').select('*');
    const { data: gearData } = await db.from('character_gear').select('*');

    if (profData) {
        allProfiles = profData.map(p => {
            const c = charData?.find(char => char.profile_id === p.id) || {};
            const s = skillData?.find(sk => sk.character_id === c.id) || {};
            const a = arsenalData?.filter(ars => ars.profile_id === p.id || ars.character_id === c.id) || [];
            const pk = perkData?.filter(perk => perk.character_id === c.id) || [];
            const ag = augmentData?.filter(aug => aug.character_id === c.id) || [];
            const gr = gearData?.filter(g => g.character_id === c.id) || [];
            return { ...p, character: c, skills: s, arsenal: a, perks: pk, augments: ag, gear: gr };
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
        if (chatLogsList.length === 0) chatLogsList = [{ sender_id: null, content: '📡 [SYSTEM] Intrepid Horizon secure mainframe linked.', message_type: 'system' }];
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

// Hazard Designer catalog — reusable blueprints, separate from the placed
// instances above (system_hazards). See js/ui.js for the CRUD.
async function loadHazardDefinitions() {
    const { data } = await db.from('hazard_definitions').select('*').order('created_at', { ascending: true });
    if (data) { window.hazardDefinitionsList = data; if (typeof window.renderHazardDefinitionsPanel === 'function') window.renderHazardDefinitionsPanel(); if (typeof window.populateHazardDefSelect === 'function') window.populateHazardDefSelect(); }
}

// Overseer Planet Editor persistence — DM edits to a body's scan data
// (name/type/gravity/atmosphere/resources) used to only mutate the
// in-memory object (window.saveDMBodyProperties in js/map.js never wrote
// to the DB), so edits vanished on refresh and never reached other
// players. planetary_modifiers is an existing-but-previously-unused table
// keyed on body_id (text, no FK — same reasoning as system_hazards.system_id:
// most bodies belong to the procedural galaxy, not a real star_systems row,
// so there's nothing to foreign-key against). It holds ONE override row per
// edited body; js/map.js merges these on top of a body's generated/base
// values every time it's read. Only the fields the current Overseer Planet
// Editor form actually exposes (custom_name/custom_type/custom_gravity/
// custom_atmosphere/custom_resources) are touched here — the table's other
// columns (industry/control/defenses/wealth/tech_level/infrastructure/
// resource_rating) aren't wired to any UI yet and are left alone.
window.globalPlanetaryModifiersCache = {}; // keyed by body_id for O(1) lookup in getSystemBodies
async function loadPlanetaryModifiers() {
    const { data } = await db.from('planetary_modifiers').select('*');
    if (data) {
        window.globalPlanetaryModifiersCache = {};
        data.forEach(row => { window.globalPlanetaryModifiersCache[row.body_id] = row; });
        // Re-render if a body is currently on screen so a DM edit (this
        // client's own, or synced in from another) shows immediately.
        if (window.selectedTarget && window.selectedTarget.type === 'body' && typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    }
}

// Territory Faction Ownership Flip: same procedural-vs-custom split as
// planetary_modifiers above, one level up (system ownership instead of
// body properties). Custom systems already have a real, live-reloaded
// `star_systems.ownership` column (no cache needed here for those) — this
// override table + cache exists ONLY for the ~2,641 procedurally-seeded
// systems, which have no database row at all to write ownership onto
// directly. window.applySystemOwnershipOverrides() (js/map.js) mutates
// the matching entries in globalProceduralSystemsCache in place after
// every load, so `.ownership` reads the same way regardless of which of
// the two persistence paths a given system actually uses.
window.globalSystemOwnershipCache = {}; // keyed by system_id (procedural systems only) -> { ownership, control }
async function loadSystemOwnershipOverrides() {
    const { data } = await db.from('system_ownership_overrides').select('*');
    window.globalSystemOwnershipCache = {};
    // Control follow-on (this session): cache value widened from a plain
    // ownership string to { ownership, control } — see the new checkpoint
    // in the architecture doc for why Control needed the same override-table
    // treatment procedural systems already had for Ownership.
    if (data) data.forEach(row => { window.globalSystemOwnershipCache[row.system_id] = { ownership: row.ownership, control: row.control }; });
    if (typeof window.applySystemOwnershipOverrides === 'function') window.applySystemOwnershipOverrides();
    if (window.selectedTarget && window.selectedTarget.type === 'star' && typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
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
    if (typeof window.populateHyperlaneFactionSelect === 'function') window.populateHyperlaneFactionSelect();
}

async function checkAnomalyProximity(ship) {
    if (!ship) return;
    const DRADIS_RANGE = 180;
    let anomalies = globalDbSystemsCache.filter(s => s.luminosity === 'Hidden Anomaly');
    for (let anomaly of anomalies) {
        let dist = Math.hypot(ship.x - anomaly.x, ship.y - anomaly.y);
        if (dist < DRADIS_RANGE) {
            // Bug fix (bug hunt, this session): mark the anomaly revealed in
            // the local cache BEFORE the awaits, not after. This can be
            // called repeatedly while a ship sits inside DRADIS_RANGE of the
            // same anomaly (e.g. once per movement tick); the old ordering
            // let every overlapping call still see 'Hidden Anomaly' during
            // its own DB round-trip, so a ship lingering near an anomaly for
            // more than one tick could fire the update/chat-log/klaxon
            // sequence multiple times for what should be a single one-time
            // reveal.
            anomaly.luminosity = 'Revealed Anomaly'; anomaly.color = '#ff3333';
            await db.from('star_systems').update({ luminosity: 'Revealed Anomaly', color: '#ff3333' }).eq('id', anomaly.id);
            await db.from('chat_logs').insert({ sender_id: null, content: `🚨 [DRADIS ALERT] Vessel '${ship.name}' detected a subspace anomaly at X:${Math.round(anomaly.x)} Y:${Math.round(anomaly.y)}.`, message_type: 'system' });
            if (window.AudioEngine) window.AudioEngine.playKlaxon();
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
    if (presenceChannel) { try { presenceChannel.unsubscribe(); } catch (e) {} } // defends against duplicate channels if this ever gets called twice
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

/* --- SHIP MARKERS (deployed vessels/stations/strike craft): REAL-TIME SYNC
   (Visual Polish follow-on, this session) ---
   Confirmed via grep before writing this: ship_markers had NO realtime
   channel anywhere in this app. Confirmed via pg_publication_tables that it
   was ALREADY in the supabase_realtime publication (unlike a brand new
   table, no migration or Database > Replication dashboard step was needed
   here — the gap was purely a missing client-side subscription). Without
   this, a vessel's HP/shields/weapons/ownership/decks only ever updated on
   the client that made the change — the Battle Map's token HP-color border,
   its ship-status cards' health bars, and the Vessel Deck all showed stale
   numbers on every OTHER connected client until something unrelated on
   THEIR end happened to call loadGalaxyData() again. Deliberately scoped to
   what actually matters for the Battle Map / Vessel Deck (what prompted
   this): re-renders those two surfaces (renderBattleMapPanel's own ship-
   status cards are covered transitively, since it calls
   window.renderBattleShipCards internally). Does NOT touch the overworld
   galaxy canvas (js/map.js) — a separate rendering pipeline with its own
   existing triggers, out of scope here. Also does NOT touch combat_tracker
   (a separate table with its own already-existing realtime channel above,
   used for personal/NPC initiative — its `hp` field is a point-in-time
   snapshot string, not live-linked back to ship_markers; a related but
   different gap, flagged, not fixed by this build).

   Same "echoes back to the acting client too" characteristic as every other
   channel here (see chat_logs_stream's comment) — a client that just fired
   a weapon will re-run this refresh redundantly on top of its own direct
   render calls. Harmless (an extra fetch + repaint), not worth filtering
   out, same as this app's other channels don't bother either. */
let shipMarkersRealtimeChannel = null;
function initShipMarkersRealtimeChannel() {
    shipMarkersRealtimeChannel = db.channel('ship_markers_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ship_markers' }, async () => {
            if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
            if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
            if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
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

/* --- PERK DEFINITIONS: REAL-TIME SYNC ---
   Matters more here than most tables — a player proposing a draft needs the
   DM's client to actually see it show up, and vice versa for approvals. */
let perkDefinitionsRealtimeChannel = null;
function initPerkDefinitionsRealtimeChannel() {
    perkDefinitionsRealtimeChannel = db.channel('perk_definitions_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'perk_definitions' }, () => {
            if (typeof loadPerkDefinitions === 'function') loadPerkDefinitions();
        })
        .subscribe();
}

// Augment Designer catalog -- same shape as the perk channel above.
// character_augments (the per-character installations) has no realtime
// channel of its own -- installing/removing is self-service on your own
// character and already patches the local cache immediately (js/ui.js),
// same convention character_perks already uses (also uncached-live).
let augmentDefinitionsRealtimeChannel;
function initAugmentDefinitionsRealtimeChannel() {
    augmentDefinitionsRealtimeChannel = db.channel('augment_definitions_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'augment_definitions' }, () => {
            if (typeof loadAugmentDefinitions === 'function') loadAugmentDefinitions();
        })
        .subscribe();
}

// Gear Designer catalog -- same shape as the perk/augment channels above.
// character_gear (the per-character loadout, including the equipped
// toggle) has no realtime channel of its own -- same self-service,
// uncached-live convention as character_perks/character_augments.
let gearDefinitionsRealtimeChannel;
function initGearDefinitionsRealtimeChannel() {
    gearDefinitionsRealtimeChannel = db.channel('gear_definitions_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'gear_definitions' }, () => {
            if (typeof loadGearDefinitions === 'function') loadGearDefinitions();
        })
        .subscribe();
}

/* --- HAZARD DEFINITIONS: REAL-TIME SYNC ---
   DM-only catalog, matching the ship_templates/perk_definitions pattern —
   mainly useful if the DM has two browser tabs open. */
let hazardDefinitionsRealtimeChannel = null;
function initHazardDefinitionsRealtimeChannel() {
    hazardDefinitionsRealtimeChannel = db.channel('hazard_definitions_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hazard_definitions' }, () => {
            if (typeof loadHazardDefinitions === 'function') loadHazardDefinitions();
        })
        .subscribe();
}

/* --- PLANETARY MODIFIERS (Overseer Planet Editor overrides): REAL-TIME SYNC ---
   So a DM's scan-data edit shows up on other clients (and the DM's own other
   tab) without needing a manual refresh — same pattern as system_hazards. */
let planetaryModifiersRealtimeChannel = null;
function initPlanetaryModifiersRealtimeChannel() {
    planetaryModifiersRealtimeChannel = db.channel('planetary_modifiers_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'planetary_modifiers' }, () => {
            if (typeof loadPlanetaryModifiers === 'function') loadPlanetaryModifiers();
        })
        .subscribe();
}

let systemOwnershipRealtimeChannel = null;
function initSystemOwnershipRealtimeChannel() {
    systemOwnershipRealtimeChannel = db.channel('system_ownership_overrides_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'system_ownership_overrides' }, () => {
            if (typeof loadSystemOwnershipOverrides === 'function') loadSystemOwnershipOverrides();
        })
        .subscribe();
}

/* --- HYPERLANES: REAL-TIME SYNC ---
   Was never wired up before this session (confirmed via grep — every other
   table in this app has a channel; this one didn't) — a DM's placed/edited/
   deleted route never synced live to other clients. Matters more now that
   routes are actually editable in place rather than just delete-and-redraw. */
let hyperlanesRealtimeChannel = null;
function initHyperlanesRealtimeChannel() {
    hyperlanesRealtimeChannel = db.channel('hyperlanes_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hyperlanes' }, () => {
            if (typeof loadHyperlanes === 'function') loadHyperlanes();
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

/* --- FEATURE: "JUMP TO SHIP" CAMERA SHORTCUT ---
   Pans the canvas to the user's own vessel and opens the character terminal
   straight to the Vessel Deck tab. Used to carry its own clock-rollback
   "temporal desync" flourish (see window.JUMP_TIME_INVERSION_MAX_HOURS /
   window.jumpInversionFtlOnly below) — that logic moved this session to
   window.executePlottedJump (js/map.js), the action that actually MOVES a
   ship, since attaching a real relativistic-drift game mechanic to a pure
   camera-recenter shortcut meant it could fire on a ship that was dragged
   into position by hand, or not fire at all if a player never happened to
   click this button, rather than consistently on every genuine jump. This
   function is now a plain camera/terminal shortcut with no calendar effect
   of its own. `ship_markers.last_ftl_position`, which only ever existed to
   support the old distance-since-last-jump calculation here, is no longer
   written or read anywhere — left in the DB as unused dead schema (like
   character_perks.perk_key before it), not worth a migration to drop. */
window.jumpToActiveShip = async function() {
    let ship = globalShipMarkersCache.find(m => m.owner_id === currentUserId);
    if (!ship) { alert("DRADIS Error: No active vessel found assigned to your callsign."); return; }

    window.selectedTarget = { type: 'ship', data: ship };
    if (typeof window.lockCameraOnSelected === 'function') window.lockCameraOnSelected();
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    if (typeof window.openFullVesselTerminal === 'function') window.openFullVesselTerminal(ship.id);
    if (window.AudioEngine) window.AudioEngine.playPing();
};

/* --- RELATIVISTIC TIME-INVERSION (this session's lore fix) ---
   Every genuine FTL jump (see window.executePlottedJump, js/map.js) makes
   the ship's chronometer read EARLIER than departure — scaled by distance
   covered and how exotic the drive is, per the DM's own confirmed lore rule
   — REPLACING the old forward "trip takes N hours" model entirely, not
   applying on top of it. Hard-capped so a single jump can't rewind more
   than ~7 days (168h) even on the most exotic drive across the full width
   of the galaxy; raised from this mechanic's old 72h cap (which predates
   this session, attached to the jumpToActiveShip shortcut above) once the
   DM confirmed a true edge-to-edge jump should be able to read "several
   days," not clip at 3. Only applies to FTL-drive vessels by default —
   sublight vessels cause none of this — but a DM can flip
   window.jumpInversionFtlOnly off (checkbox in the Chronology Control Deck
   panel) to apply it to every drive type. Always logged to Comms so a DM
   watching the timeline isn't surprised by it — it's automatic physics, not
   a way for players to freely rewind the clock at will (that stays
   DM-gated via window.adjustTime). */
window.JUMP_TIME_INVERSION_MAX_HOURS = 168;
window.jumpInversionFtlOnly = localStorage.getItem('odyssey_jump_ftl_only') !== 'false'; // default ON
window.setJumpInversionFtlOnly = function(checked) {
    window.jumpInversionFtlOnly = !!checked;
    localStorage.setItem('odyssey_jump_ftl_only', window.jumpInversionFtlOnly ? 'true' : 'false');
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
