/* ==========================================================================
   1. SUPABASE CLIENT & GLOBAL STATE CONFIGURATION
   ========================================================================== */
const SUPABASE_URL = 'https://uodeeyfaizbjplvvslry.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7Kj1D_Frh3v0MLNuAyyROQ_rcaTx2F8';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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

/* ==========================================================================
   2. STRIKE CRAFT LORE DATABASE
   ========================================================================== */
const STRIKE_CRAFT_DB = {
    raven: {
        label: "Raven Gen 2 MkIV", base_hp: 200,
        weapons: [
            { name: "Dual .50 Cal Rotary", dice: "2d6", dmgType: "Impact" },
            { name: "Quad Gamma Pulse", dice: "4d6", dmgType: "Heat" },
            { name: "Hunter Seeker Rockets", dice: "4d10", dmgType: "Piercing" },
            { name: "Ship Killer Missiles", dice: "2d12", dmgType: "Impact/Heat" }
        ]
    },
    hawk: {
        label: "Hawk Medium Bomber", base_hp: 350,
        weapons: [
            { name: "Dual 120mm Autocannons", dice: "2d10", dmgType: "Impact" },
            { name: "Micro Railgun", dice: "1d12", dmgType: "Piercing" },
            { name: "Capitol Killer Missiles", dice: "1d20", dmgType: "Piercing" }
        ]
    },
    messenger: {
        label: "Messenger Shuttle", base_hp: 100,
        weapons: [
            { name: "Dual Link .50 Cal", dice: "2d6", dmgType: "Impact" },
            { name: "Hunter Seeker Rockets", dice: "4d10", dmgType: "Piercing" },
            { name: "Point Defense System", dice: "1d4", dmgType: "Impact" }
        ]
    }
};

/* ==========================================================================
   3. ACTIVE TOOL & MAP INTERACTION STATE
   ========================================================================== */
let measuringTapeActive = false;
let measureStartPoint = null;
let measureEndPoint = null;

let pingModeActive = false;
let activePings = [];

let jumpPlottingActive = false;
let activeJumpShip = null;
let jumpTargetPoint = null;
let selectedDriveSpeed = 250;

let territoryToolActive = false;
let territoryDrawActive = false;
let activeTerritoryVertices = [];

let hyperlaneDrawActive = false;
let activeHyperlaneNodes = [];

const driveSpeeds = {
    sublight: { name: "Sublight Thrusters (0.1c)", speed: 10, label: "0.1c Sublight" },
    ftl_class1: { name: "Standard Class 1 Warp Drive", speed: 250, label: "Class 1 Warp" },
    ftl_class2: { name: "Military Class 2 Hyperdrive", speed: 600, label: "Class 2 Hyperdrive" },
    ftl_fold: { name: "Experimental Fold/Jump Drive", speed: 2500, label: "Fold Jump" }
};

/* ==========================================================================
   4. IN-UNIVERSE CALENDAR & CHRONOLOGY ENGINE
   ========================================================================== */
let universeTimeHours = parseInt(localStorage.getItem('odyssey_universe_time') || '24192000'); 
let timeFlowActive = false;
let timeFlowInterval = null;

function formatUniverseTime(totalHours) {
    const hoursInDay = 24;
    const daysInMonth = 30;
    const monthsInYear = 12;
    const hoursInMonth = hoursInDay * daysInMonth;
    const hoursInYear = hoursInMonth * monthsInYear;

    let year = Math.floor(totalHours / hoursInYear);
    let remainder = totalHours % hoursInYear;
    let month = Math.floor(remainder / hoursInMonth) + 1;
    remainder %= hoursInMonth;
    let day = Math.floor(remainder / hoursInDay) + 1;
    let hour = remainder % hoursInDay;

    let mStr = month < 10 ? '0' + month : month;
    let dStr = day < 10 ? '0' + day : day;
    let hStr = hour < 10 ? '0' + hour : hour;

    return `YR ${year}.${mStr}.${dStr} // ${hStr}:00`;
}

function updateCalendarDisplay() {
    const timeStr = formatUniverseTime(universeTimeHours);
    const clockTicker = document.getElementById('clock-ticker-text');
    const modalClock = document.getElementById('modal-clock-display');
    if (clockTicker) clockTicker.innerText = timeStr;
    if (modalClock) modalClock.innerText = timeStr;
}

function initCalendarEngine() {
    updateCalendarDisplay();
    timeFlowInterval = setInterval(() => {
        if (timeFlowActive) {
            universeTimeHours += 1;
            updateCalendarDisplay();
        }
    }, 4000);
}

window.toggleCalendarControls = function() {
    const panel = document.getElementById('calendar-control-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    updateCalendarDisplay();
};

window.adjustTime = function(amount, unit) {
    if (currentUserRole !== 'dm') return;
    let multiplier = 1;
    if (unit === 'hours') multiplier = 1;
    if (unit === 'days') multiplier = 24;
    if (unit === 'months') multiplier = 24 * 30;
    if (unit === 'years') multiplier = 24 * 30 * 12;

    universeTimeHours += amount * multiplier;
    if (universeTimeHours < 0) universeTimeHours = 0;
    localStorage.setItem('odyssey_universe_time', universeTimeHours);
    updateCalendarDisplay();
    broadcastTimeSync();
};

window.applyManualTime = function() {
    if (currentUserRole !== 'dm') return;
    const yr = parseInt(document.getElementById('set-yr').value);
    const mo = parseInt(document.getElementById('set-mo').value) || 1;
    const da = parseInt(document.getElementById('set-da').value) || 1;
    const hr = parseInt(document.getElementById('set-hr').value) || 0;

    if (isNaN(yr)) { alert("Please enter a valid year."); return; }

    const hoursInDay = 24;
    const daysInMonth = 30;
    const monthsInYear = 12;
    const hoursInMonth = hoursInDay * daysInMonth;
    const hoursInYear = hoursInMonth * monthsInYear;

    universeTimeHours = (yr * hoursInYear) + ((mo - 1) * hoursInMonth) + ((da - 1) * hoursInDay) + hr;
    if (universeTimeHours < 0) universeTimeHours = 0;

    localStorage.setItem('odyssey_universe_time', universeTimeHours);
    updateCalendarDisplay();
    broadcastTimeSync();
    alert("Chronology manually updated.");
};

window.resetTimeline = function() {
    if (currentUserRole !== 'dm') return;
    if (!confirm("Reset timeline back to YR 2800.01.01?")) return;
    universeTimeHours = 24192000;
    localStorage.setItem('odyssey_universe_time', universeTimeHours);
    updateCalendarDisplay();
    broadcastTimeSync();
};

window.toggleTimeFlow = function() {
    if (currentUserRole !== 'dm') return;
    timeFlowActive = !timeFlowActive;
    const btn = document.getElementById('time-flow-btn');
    if (btn) {
        btn.innerText = timeFlowActive ? '⏸ PAUSE FLOW' : '▶ RESUME FLOW';
        btn.style.borderColor = timeFlowActive ? '#3c4e36' : '#00e5a3';
    }
};

function broadcastTimeSync() {
    db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `⏳ [TIMELINE ADJUSTED] Overseer shifted chronology to: ${formatUniverseTime(universeTimeHours)}`,
        message_type: 'text'
    });
}

/* ==========================================================================
   5. DATABASE SYNC, AUTH & STATE LOADERS
   ========================================================================== */
window.handleLogin = async function() {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('error-message');
    errorDiv.style.display = 'none';

    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
        errorDiv.innerText = "Access Denied: " + error.message;
        errorDiv.style.display = 'block';
        return;
    }
    fetchUserProfile(data.user);
};

async function fetchUserProfile(user) {
    currentUserId = user.id;
    currentUserEmail = user.email;
    const { data, error } = await db.from('profiles').select('*').eq('id', user.id).single();

    if (error) {
        document.getElementById('error-message').innerText = "Access Denied: Profile mapping missing.";
        document.getElementById('error-message').style.display = 'block';
        return;
    }

    currentUserRole = data.role;
    document.getElementById('login-wrapper').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';

    const badge = document.getElementById('user-role');
    badge.innerText = `Role: ${data.role}`;
    
    const scratchpadBtn = document.getElementById('dm-scratchpad-toggle-btn');
    const territoryBtn = document.getElementById('territory-tool-toggle-btn');
    const codexCreatorPanel = document.getElementById('codex-dm-creator-panel');
    const codexPerms = document.getElementById('codex-permission-indicator');
    
    if (data.role === 'dm') {
        badge.classList.add('role-dm');
        badge.innerText = 'OVERSEER (DM)';
        document.getElementById('dm-tools').style.display = 'block';
        document.getElementById('dm-time-controls-box').style.display = 'block';
        if (scratchpadBtn) scratchpadBtn.style.display = 'inline-block';
        if (territoryBtn) territoryBtn.style.display = 'inline-block';
        if (codexCreatorPanel) codexCreatorPanel.style.display = 'block';
        if (codexPerms) { codexPerms.innerText = '● OVERSEER AUTHORIZATION // FULL WRITE & EDIT ACCESS'; codexPerms.style.color = '#ff6b6b'; }
        
        const savedScratch = localStorage.getItem('odyssey_dm_scratchpad');
        if (savedScratch && document.getElementById('dm-scratchpad-input')) {
            document.getElementById('dm-scratchpad-input').value = savedScratch;
        }
    } else {
        if (scratchpadBtn) scratchpadBtn.style.display = 'none';
        if (territoryBtn) territoryBtn.style.display = 'none';
        if (codexCreatorPanel) codexCreatorPanel.style.display = 'none';
        if (codexPerms) { codexPerms.innerText = '● SECURITY CLEARANCE: LEVEL 2 // VIEW ONLY'; codexPerms.style.color = '#6b826a'; }
    }

    initPresenceChannel(data);
    initGalaxyEngine();
    initCalendarEngine();
    loadAllProfiles();
    loadPlayerNotes();
    loadCombatTracker();
    loadCampaignObjectives();
    loadChatLogs();
    loadTerritories();
    loadHyperlanes();
    loadCodexEntries();
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
        if (document.getElementById('character-terminal').style.display === 'block') { renderCharacterTerminalData(); }
        populateCommsRecipients();
    }
}

async function loadPlayerNotes() {
    const { data } = await db.from('player_notes').select('*').order('created_at', { ascending: false });
    if (data) { playerNotesList = data; renderTerminalNotes(); }
}

async function loadCombatTracker() {
    const { data } = await db.from('combat_tracker').select('*').order('initiative', { ascending: false });
    if (data) { combatantsList = data; renderCombatTracker(); }
}

async function loadCampaignObjectives() {
    const { data } = await db.from('campaign_objectives').select('*').order('created_at', { ascending: false });
    if (data) { campaignObjectivesList = data; renderCampaignObjectives(); }
}

async function loadChatLogs() {
    const { data } = await db.from('chat_logs').select('*').order('created_at', { ascending: true }).limit(50);
    if (data) { 
        chatLogsList = data; 
        if (chatLogsList.length === 0) {
            chatLogsList = [{ sender_id: 'system', content: '📡 [SYSTEM] Intrepid Horizon secure mainframe linked. Communication channels active.', message_type: 'text' }];
        }
        renderChatFeed(); 
    }
}

async function loadTerritories() {
    const { data } = await db.from('territories').select('*').order('created_at', { ascending: true });
    if (data) {
        globalTerritoriesCache = data;
        if (typeof renderTerritoryList === 'function') renderTerritoryList();
    }
}

async function loadHyperlanes() {
    const { data } = await db.from('hyperlanes').select('*');
    if (data) {
        globalHyperlanesCache = data;
        if (typeof renderHyperlaneList === 'function') renderHyperlaneList();
    }
}

async function checkAnomalyProximity(ship) {
    if (!ship) return;
    const DRADIS_RANGE = 180;
    
    let anomalies = globalDbSystemsCache.filter(s => s.luminosity === 'Hidden Anomaly');
    
    for (let anomaly of anomalies) {
        let dx = ship.x - anomaly.x;
        let dy = ship.y - anomaly.y;
        let dist = Math.sqrt(dx*dx + dy*dy);
        
        if (dist < DRADIS_RANGE) {
            await db.from('star_systems')
                .update({ luminosity: 'Revealed Anomaly', color: '#ff3333' })
                .eq('id', anomaly.id);
            
            await db.from('chat_logs').insert({
                sender_id: 'system',
                content: `🚨 [DRADIS ALERT] Vessel '${ship.name}' has detected a massive subspace anomaly at X:${Math.round(anomaly.x)} Y:${Math.round(anomaly.y)}. Sensor locks updated.`,
                message_type: 'text'
            });
            anomaly.luminosity = 'Revealed Anomaly';
            anomaly.color = '#ff3333';
        }
    }
}

/* ==========================================================================
   6. CLOUD CODEX ENGINE & DOCUMENT UPLOADER / EDITOR
   ========================================================================== */
async function loadCodexEntries() {
    const { data } = await db.from('codex_entries').select('*').order('created_at', { ascending: false });
    if (data && data.length > 0) {
        globalCodexEntriesCache = data;
    } else {
        globalCodexEntriesCache = [
            { id: 'cdx-1', category: 'factions', title: 'Task Force Black', subtitle: 'Allied Command', content: 'Autonomous deep-space exploration and containment fleet operating outside regular jurisdiction.' }
        ];
    }
    renderCodexMatrix();
    populateTerritoryFactionSelect();
}

window.switchCodexCategory = function(cat) {
    activeCodexCategory = cat;
    document.querySelectorAll('.codex-me-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`codex-rail-${cat}`);
    if (btn) btn.classList.add('active');

    const titles = {
        factions: '🛡️ Factions & Registered Powers',
        lore: '🌌 Sector Lore & Classified Intel',
        npcs: '👤 Key NPCs & Tactical Contacts',
        docs: '📄 Tactical Documents & Field Logs'
    };
    const header = document.getElementById('codex-deck-title');
    if (header) header.innerText = titles[cat] || 'Codex Archive';

    renderCodexMatrix();
};

window.filterCodexEntries = function(val) {
    codexSearchFilter = (val || '').toLowerCase().trim();
    renderCodexMatrix();
};

function renderCodexMatrix() {
    const container = document.getElementById('codex-entries-matrix');
    if (!container) return;

    let entries = globalCodexEntriesCache.filter(e => e.category === activeCodexCategory);
    if (codexSearchFilter) {
        entries = entries.filter(e => 
            (e.title && e.title.toLowerCase().includes(codexSearchFilter)) ||
            (e.subtitle && e.subtitle.toLowerCase().includes(codexSearchFilter)) ||
            (e.content && e.content.toLowerCase().includes(codexSearchFilter))
        );
    }

    if (entries.length === 0) {
        container.innerHTML = `<span style="font-size:11px; color:#6b826a;">No records located under this classification.</span>`;
        return;
    }

    let isDM = (currentUserRole === 'dm');
    let html = '';

    entries.forEach(e => {
        let docHtml = '';
        if (e.doc_data && e.doc_name) {
            docHtml = `
                <div class="codex-doc-pill" onclick="window.openCodexAttachment('${e.id}')">
                    📎 ATTACHMENT: ${e.doc_name} (${(e.doc_type || 'FILE').toUpperCase()})
                </div>
            `;
        }

        html += `
            <div class="codex-entry-card category-${e.category}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#00e5a3; font-size:13px; letter-spacing:1px;">${e.title}</strong>
                        <div style="font-size:10px; color:#6b826a; margin-top:2px;">${e.subtitle || 'General Record'}</div>
                    </div>
                    <div style="display:flex; gap:6px; align-items:center;">
                        <button class="layer-edit" onclick="window.openCodexFullscreen('${e.id}')" style="font-size:9px; padding:3px 8px;">⛶ FULLSCREEN</button>
                        ${isDM ? `<button class="layer-edit" onclick="window.editCodexEntry('${e.id}')" style="font-size:9px; padding:3px 8px; color:#ffaa00; border-color:#ffaa00;">✎ EDIT</button>` : ''}
                        ${isDM ? `<button class="layer-del" onclick="window.deleteCodexEntry('${e.id}')" style="font-size:9px; padding:3px 6px;">✕</button>` : ''}
                    </div>
                </div>
                <p style="margin:8px 0 4px 0; font-size:11px; color:#d4c5a9; line-height:1.5; max-height:80px; overflow:hidden; text-overflow:ellipsis;">
                    ${e.content || ''}
                </p>
                ${docHtml}
            </div>
        `;
    });

    container.innerHTML = html;
}

window.editCodexEntry = function(id) {
    if (currentUserRole !== 'dm') return;
    const entry = globalCodexEntriesCache.find(e => e.id === id);
    if (!entry) return;

    editingCodexId = id;
    document.getElementById('codex-creator-heading').innerText = `✎ Editing: ${entry.title}`;
    document.getElementById('new-codex-category').value = entry.category || 'lore';
    document.getElementById('new-codex-title').value = entry.title || '';
    document.getElementById('new-codex-subtitle').value = entry.subtitle || '';
    document.getElementById('new-codex-content').value = entry.content || '';
    
    document.getElementById('new-codex-doc-name').value = entry.doc_name || '';
    document.getElementById('new-codex-doc-data').value = entry.doc_data || '';
    document.getElementById('new-codex-doc-type').value = entry.doc_type || '';

    const currentDocWrapper = document.getElementById('codex-current-doc-wrapper');
    const currentDocName = document.getElementById('codex-current-doc-name');
    if (entry.doc_name && entry.doc_data) {
        currentDocWrapper.style.display = 'block';
        currentDocName.innerText = `📎 ${entry.doc_name} (${(entry.doc_type || 'file').toUpperCase()})`;
    } else {
        currentDocWrapper.style.display = 'none';
    }

    document.getElementById('btn-save-codex-entry').innerText = "✓ UPDATE CODEX ENTRY";
    document.getElementById('btn-cancel-codex-edit').style.display = "block";
};

window.cancelCodexEdit = function() {
    editingCodexId = null;
    document.getElementById('codex-creator-heading').innerText = "+ New Codex Entry";
    document.getElementById('new-codex-title').value = '';
    document.getElementById('new-codex-subtitle').value = '';
    document.getElementById('new-codex-content').value = '';
    document.getElementById('new-codex-doc-name').value = '';
    document.getElementById('new-codex-doc-data').value = '';
    document.getElementById('new-codex-doc-type').value = '';
    document.getElementById('codex-file-label').innerText = 'Click to upload / replace .txt, .md, .pdf, or image';
    document.getElementById('codex-current-doc-wrapper').style.display = 'none';

    document.getElementById('btn-save-codex-entry').innerText = "+ PUBLISH TO CODEX";
    document.getElementById('btn-cancel-codex-edit').style.display = "none";
};

window.removeCodexAttachmentFromForm = function() {
    document.getElementById('new-codex-doc-name').value = '';
    document.getElementById('new-codex-doc-data').value = '';
    document.getElementById('new-codex-doc-type').value = '';
    document.getElementById('codex-current-doc-wrapper').style.display = 'none';
    document.getElementById('codex-file-label').innerText = 'Click to upload / replace .txt, .md, .pdf, or image';
};

window.saveNewCodexEntry = async function() {
    if (currentUserRole !== 'dm') return;
    const cat = document.getElementById('new-codex-category').value;
    const title = document.getElementById('new-codex-title').value.trim();
    const subtitle = document.getElementById('new-codex-subtitle').value.trim();
    const content = document.getElementById('new-codex-content').value.trim();
    const docName = document.getElementById('new-codex-doc-name').value;
    const docData = document.getElementById('new-codex-doc-data').value;
    const docType = document.getElementById('new-codex-doc-type').value;

    if (!title) { alert("Please enter an entry title."); return; }

    const payload = {
        category: cat,
        title: title,
        subtitle: subtitle,
        content: content,
        doc_name: docName || null,
        doc_data: docData || null,
        doc_type: docType || null,
        created_by: currentUserId
    };

    if (editingCodexId) {
        const { error } = await db.from('codex_entries').update(payload).eq('id', editingCodexId);
        if (error) {
            alert("Failed to update Codex entry: " + error.message);
        } else {
            window.cancelCodexEdit();
            window.switchCodexCategory(cat);
            loadCodexEntries();
            await db.from('chat_logs').insert({
                sender_id: currentUserId,
                content: `📖 [CODEX REVISED] Overseer modified archive: '${title}' under [${cat.toUpperCase()}].`,
                message_type: 'text'
            });
        }
    } else {
        const { error } = await db.from('codex_entries').insert(payload);
        if (error) {
            alert("Failed to publish to Cloud Codex: " + error.message);
        } else {
            window.cancelCodexEdit();
            window.switchCodexCategory(cat);
            loadCodexEntries();
            await db.from('chat_logs').insert({
                sender_id: currentUserId,
                content: `📖 [CODEX PUBLISHED] Overseer filed archive: '${title}' under [${cat.toUpperCase()}].`,
                message_type: 'text'
            });
        }
    }
};

window.deleteCodexEntry = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!confirm("Permanently erase this record from the Cloud Codex?")) return;
    await db.from('codex_entries').delete().eq('id', id);
    if (editingCodexId === id) window.cancelCodexEdit();
    loadCodexEntries();
};

window.openCodexFullscreen = function(id) {
    const entry = globalCodexEntriesCache.find(e => e.id === id);
    if (!entry) return;

    const modal = document.getElementById('codex-fullscreen-reader');
    document.getElementById('reader-category-badge').innerText = (entry.category || 'LORE').toUpperCase();
    document.getElementById('reader-title').innerText = entry.title;
    document.getElementById('reader-subtitle').innerText = entry.subtitle || 'UNCLASSIFIED RECORD';
    document.getElementById('reader-body-content').innerText = entry.content || 'No narrative content recorded.';

    const actionBar = document.getElementById('reader-doc-action-bar');
    if (entry.doc_data && entry.doc_name) {
        actionBar.style.display = 'block';
        actionBar.innerHTML = `
            <button class="btn-reveal" onclick="window.openCodexAttachment('${entry.id}')" style="width:auto; font-size:11px; padding:6px 16px;">
                📥 OPEN / DOWNLOAD ATTACHED DOCUMENT (${entry.doc_name})
            </button>
        `;
    } else {
        actionBar.style.display = 'none';
    }

    modal.style.display = 'block';
};

window.closeCodexFullscreen = function() {
    document.getElementById('codex-fullscreen-reader').style.display = 'none';
};

window.openCodexAttachment = function(id) {
    const entry = globalCodexEntriesCache.find(e => e.id === id);
    if (!entry || !entry.doc_data) return;

    if (entry.doc_type === 'image' || entry.doc_type === 'pdf') {
        const win = window.open();
        win.document.write(`<iframe src="${entry.doc_data}" frameborder="0" style="border:0; top:0; left:0; bottom:0; right:0; width:100%; height:100%;" allowfullscreen></iframe>`);
    } else {
        const blob = new Blob([entry.doc_data], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = entry.doc_name || 'document.txt';
        a.click();
        URL.revokeObjectURL(url);
    }
};

function initPresenceChannel(userProfile) {
    presenceChannel = db.channel('online_map_users', { config: { presence: { key: currentUserId } } });
    presenceChannel.on('presence', { event: 'sync' }, () => { onlineUsersMap = presenceChannel.presenceState(); renderPresenceTicker(); })
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') { await presenceChannel.track({ online_at: new Date().toISOString(), username: userProfile.username || currentUserEmail.split('@')[0], role: userProfile.role, avatar_url: userProfile.avatar_url || '' }); }
        });
}

function renderPresenceTicker() {
    const listDiv = document.getElementById('presence-list');
    let html = '';
    Object.keys(onlineUsersMap).forEach(userId => {
        const presences = onlineUsersMap[userId];
        if (presences && presences.length > 0) {
            const p = presences[0];
            html += `<div class="presence-pill">🟢 ${p.username} ${p.role === 'dm' ? '[DM]' : ''}</div>`;
        }
    });
    listDiv.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No active commanders</span>';
}

window.handleLogout = async function() {
    if (presenceChannel) await presenceChannel.untrack();
    await db.auth.signOut();
    location.reload();
};

/* ==========================================================================
   7. TERMINAL & UI CONTROLLERS
   ========================================================================== */
const skillList = [
    "Athletics", "Stealth", "Survival", "Ballistic Weapons", 
    "Energy Weapons", "Explosives", "Computers", "Engineering", 
    "Sciences", "Mechanics", "Medical", "Speechcraft", "Melee", "Pilot"
];

function renderSkillInputs() {
    const container = document.getElementById('skills-input-container');
    if (!container) return;
    let html = '';
    skillList.forEach(skill => {
        const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_');
        html += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:4px 6px; border-radius:2px; border:1px solid #3c4e36;">
                <span style="font-size:10px; color:#d4c5a9;">${skill}</span>
                <input type="number" id="skill-${safeKey}" min="-100" max="100" value="0" style="width:65px; margin:0; text-align:right; font-size:10px; padding:2px;">
            </div>
        `;
    });
    container.innerHTML = html;
    
    const diceContainer = document.getElementById('dice-roller-skills');
    let dHtml = '';
    skillList.forEach(skill => {
        dHtml += `<label style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" class="roll-skill-cb" value="${skill}" style="width:auto; margin:0;"> ${skill}</label>`;
    });
    if(diceContainer) diceContainer.innerHTML = dHtml;
    
    const statContainer = document.getElementById('dice-roller-stats');
    let sHtml = '';
    ['Charisma', 'Dexterity', 'Intelligence', 'Strength', 'Toughness', 'Willpower'].forEach(st => {
        sHtml += `<label style="font-size: 11px; color: #d4c5a9;"><input type="checkbox" class="roll-stat-cb" value="${st}"> ${st}</label>`;
    });
    if(statContainer) statContainer.innerHTML = sHtml;
}
renderSkillInputs();

window.switchTermTab = function(tabName) {
    document.querySelectorAll('.term-tab-btn-vert').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.term-panel-content').forEach(p => p.classList.remove('active'));
    const activeBtn = document.getElementById(`term-tab-btn-${tabName}`);
    if (activeBtn) activeBtn.classList.add('active');
    const activePanel = document.getElementById(`term-panel-${tabName}`);
    if (activePanel) activePanel.classList.add('active');

    if (tabName === 'cargo') {
        populateCargoVesselSelect();
        renderTerminalCargoDeck();
    } else if (tabName === 'vessel') {
        populateVesselDeckSelect();
        window.renderVesselDeck();
    } else if (tabName === 'codex') {
        window.switchCodexCategory(activeCodexCategory);
    }
};

window.switchDmSubtab = function(subtab) {
    document.querySelectorAll('#dm-tools .hud-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#dm-tools .dm-subpanel').forEach(p => p.classList.remove('active'));
    
    const btn = document.getElementById(`dm-subtab-btn-${subtab}`);
    if (btn) btn.classList.add('active');
    
    const panel = document.getElementById(`dm-panel-${subtab}`);
    if (panel) panel.classList.add('active');
};

window.toggleCharacterTerminal = function() {
    const term = document.getElementById('character-terminal');
    term.style.display = term.style.display === 'block' ? 'none' : 'block';
    if (term.style.display === 'block') { loadAllProfiles(); loadCampaignObjectives(); loadPlayerNotes(); loadCodexEntries(); }
};

window.openFullCargoTerminal = function() {
    const term = document.getElementById('character-terminal');
    term.style.display = 'block';
    window.switchTermTab('cargo');
};

window.openFullCodexTerminal = function() {
    const term = document.getElementById('character-terminal');
    term.style.display = 'block';
    window.switchTermTab('codex');
};

window.toggleCombatTracker = function() {
    const panel = document.getElementById('combat-tracker-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
};

window.toggleCommsArray = function() {
    const panel = document.getElementById('comms-array-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    if (panel.style.display === 'block') { populateCommsRecipients(); loadChatLogs(); }
};

window.toggleDmScratchpad = function() {
    if (currentUserRole !== 'dm') return;
    const panel = document.getElementById('dm-scratchpad-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
};

window.saveDmScratchpad = function() {
    if (currentUserRole !== 'dm') return;
    const val = document.getElementById('dm-scratchpad-input').value;
    localStorage.setItem('odyssey_dm_scratchpad', val);
};

// --- DRAG UI MANAGEMENT ---
function makePanelDraggable(panelId, handleId, storageKey) {
    const panel = document.getElementById(panelId);
    const handle = document.getElementById(handleId);
    if (!panel || !handle) return;
    const savedPos = localStorage.getItem(storageKey);
    if (savedPos) {
        try {
            const { left, top } = JSON.parse(savedPos);
            panel.style.left = left; panel.style.top = top; panel.style.right = 'auto';
        } catch(e) {}
    }
    let isDragging = false, startX, startY, initialLeft, initialTop;
    handle.addEventListener('mousedown', (e) => {
        if (['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        initialLeft = rect.left; initialTop = rect.top;
        panel.style.right = 'auto';
        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const dx = moveEvent.clientX - startX; const dy = moveEvent.clientY - startY;
            let newLeft = Math.max(10, Math.min(window.innerWidth - rect.width - 10, initialLeft + dx));
            let newTop = Math.max(60, Math.min(window.innerHeight - rect.height - 10, initialTop + dy));
            panel.style.left = `${newLeft}px`; panel.style.top = `${newTop}px`;
        };
        const onMouseUp = () => {
            if (isDragging) { isDragging = false; localStorage.setItem(storageKey, JSON.stringify({ left: panel.style.left, top: panel.style.top })); }
            window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp);
        };
        window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
    });
}

makePanelDraggable('hud-overlay', 'hud-overlay-header', 'odyssey_hud_pos');
makePanelDraggable('combat-tracker-panel', 'combat-tracker-header', 'odyssey_combat_pos');
makePanelDraggable('dm-tools', 'dm-tools-header', 'odyssey_dm_pos');
makePanelDraggable('comms-array-panel', 'comms-array-header', 'odyssey_comms_pos');
makePanelDraggable('calendar-control-panel', 'calendar-control-header', 'odyssey_calendar_pos');
makePanelDraggable('dm-scratchpad-panel', 'dm-scratchpad-header', 'odyssey_scratchpad_pos');
makePanelDraggable('territory-control-panel', 'territory-control-header', 'odyssey_territory_pos');

window.resetUiLayout = function() {
    Object.keys(localStorage).forEach(k => {
        if (k.startsWith('odyssey_')) localStorage.removeItem(k);
    });
    location.reload();
};

/* --- TOOL TOGGLES & MAP DRAWING --- */
window.toggleHyperlanes = function() {
    hyperlanesVisible = !hyperlanesVisible;
    const btn = document.getElementById('hyperlane-toggle-btn');
    if (btn) {
        btn.style.borderColor = hyperlanesVisible ? '#3c4e36' : '#00e5a3';
        btn.style.color = hyperlanesVisible ? '#6b826a' : '#00e5a3';
    }
};

window.toggleTerritoryTool = function() {
    if (currentUserRole !== 'dm') return;
    const panel = document.getElementById('territory-control-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    if (panel.style.display === 'block') {
        populateTerritoryFactionSelect();
        renderTerritoryList();
    }
};

function populateTerritoryFactionSelect() {
    const select = document.getElementById('territory-faction-select');
    if (!select) return;
    let html = '<option value="Independent / Neutral">Independent / Neutral</option>';
    const factions = globalCodexEntriesCache.filter(e => e.category === 'factions');
    factions.forEach(f => {
        html += `<option value="${f.title}">${f.title}</option>`;
    });
    select.innerHTML = html;
}

window.startDrawingTerritory = function() {
    if (currentUserRole !== 'dm') return;
    territoryDrawActive = true;
    hyperlaneDrawActive = false; jumpPlottingActive = false; measuringTapeActive = false; pingModeActive = false;
    window.updateToolButtonStyles();
    activeTerritoryVertices = [];
    document.getElementById('btn-start-territory-draw').style.display = 'none';
    document.getElementById('btn-finish-territory-draw').style.display = 'block';
    document.getElementById('btn-cancel-territory-draw').style.display = 'block';
    document.getElementById('territory-drawing-status').style.display = 'block';
    document.getElementById('territory-drawing-status').innerText = 'Drawing Active: Click map to place nodes...';
};

window.cancelDrawingTerritory = function() {
    territoryDrawActive = false;
    window.updateToolButtonStyles();
    activeTerritoryVertices = [];
    document.getElementById('btn-start-territory-draw').style.display = 'block';
    document.getElementById('btn-finish-territory-draw').style.display = 'none';
    document.getElementById('btn-cancel-territory-draw').style.display = 'none';
    document.getElementById('territory-drawing-status').style.display = 'none';
};

window.finishActiveTerritory = async function() {
    if (activeTerritoryVertices.length < 3) {
        alert("A territory polygon requires at least 3 vertices.");
        return;
    }
    
    const name = document.getElementById('territory-name-input').value.trim() || `Sector Territory ${globalTerritoriesCache.length + 1}`;
    const faction = document.getElementById('territory-faction-select').value;
    const color = document.getElementById('territory-color-input').value;

    const payload = {
        name: name,
        faction_name: faction,
        color: color,
        vertices: activeTerritoryVertices,
        is_revealed: true,
        created_by: currentUserId
    };

    const { error } = await db.from('territories').insert(payload);
    if (error) {
        alert("Failed to save territory: " + error.message);
    } else {
        document.getElementById('territory-name-input').value = '';
        window.cancelDrawingTerritory();
        loadTerritories();
        
        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🗺️ [TERRITORY ESTABLISHED] Overseer ratified borders for: '${name}' (${faction}).`,
            message_type: 'text'
        });
    }
};

function renderTerritoryList() {
    const container = document.getElementById('territory-list-container');
    if (!container) return;
    let html = '';
    globalTerritoriesCache.forEach((t) => {
        html += `
            <div class="note-card" style="display:flex; justify-content:space-between; align-items:center; padding:6px; margin-bottom:2px; border-left:3px solid ${t.color};">
                <div>
                    <strong style="color:${t.color}; font-size:11px;">${t.name}</strong>
                    <div style="font-size:9px; color:#6b826a;">Faction: ${t.faction_name || 'Neutral'} (${(t.vertices || []).length} Nodes)</div>
                </div>
                <button class="layer-del" onclick="window.deleteTerritory('${t.id}')" style="padding:2px 6px; font-size:9px;">X</button>
            </div>
        `;
    });
    container.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No active territories plotted.</span>';
}

window.deleteTerritory = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!confirm("Permanently dissolve this territorial border?")) return;
    await db.from('territories').delete().eq('id', id);
    loadTerritories();
};

window.startDrawingHyperlane = function() {
    if (currentUserRole !== 'dm') return;
    hyperlaneDrawActive = true;
    territoryDrawActive = false; jumpPlottingActive = false; measuringTapeActive = false; pingModeActive = false;
    window.updateToolButtonStyles();
    activeHyperlaneNodes = [];
    document.getElementById('btn-start-hyperlane-draw').style.display = 'none';
    document.getElementById('btn-finish-hyperlane-draw').style.display = 'block';
    document.getElementById('btn-cancel-hyperlane-draw').style.display = 'block';
    document.getElementById('hyperlane-drawing-status').style.display = 'block';
    document.getElementById('hyperlane-drawing-status').innerText = 'Route Active: Click stars on map to link nodes...';
};

window.cancelDrawingHyperlane = function() {
    hyperlaneDrawActive = false;
    window.updateToolButtonStyles();
    activeHyperlaneNodes = [];
    document.getElementById('btn-start-hyperlane-draw').style.display = 'block';
    document.getElementById('btn-finish-hyperlane-draw').style.display = 'none';
    document.getElementById('btn-cancel-hyperlane-draw').style.display = 'none';
    document.getElementById('hyperlane-drawing-status').style.display = 'none';
};

window.finishActiveHyperlane = async function() {
    if (activeHyperlaneNodes.length < 2) { alert("A trade route requires at least 2 connected nodes."); return; }
    
    const name = prompt("Enter a designation for this Trade Route:", `Trade Route ${globalHyperlanesCache.length + 1}`);
    if(!name) return;

    const payload = {
        name: name,
        color: '#00e1ff',
        nodes: activeHyperlaneNodes,
        created_by: currentUserId
    };

    const { error } = await db.from('hyperlanes').insert(payload);
    if (error) {
        alert("Failed to save trade route: " + error.message);
    } else {
        window.cancelDrawingHyperlane();
        loadHyperlanes();
        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `⚡ [LOGISTICS] Overseer established a new Trade Route: '${name}'.`,
            message_type: 'text'
        });
    }
};

function renderHyperlaneList() {
    const container = document.getElementById('hyperlane-list-container');
    if (!container) return;
    let html = '';
    globalHyperlanesCache.forEach((h) => {
        html += `
            <div class="note-card" style="display:flex; justify-content:space-between; align-items:center; padding:6px; margin-bottom:2px; border-left:3px solid ${h.color || '#00e1ff'};">
                <div>
                    <strong style="color:${h.color || '#00e1ff'}; font-size:11px;">${h.name}</strong>
                    <div style="font-size:9px; color:#6b826a;">Nodes: ${(h.nodes || []).length}</div>
                </div>
                <button class="layer-del" onclick="window.deleteHyperlane('${h.id}')" style="padding:2px 6px; font-size:9px;">X</button>
            </div>
        `;
    });
    container.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No active trade routes plotted.</span>';
}

window.deleteHyperlane = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!confirm("Permanently sever this trade route?")) return;
    await db.from('hyperlanes').delete().eq('id', id);
    loadHyperlanes();
};

/* --- CHARACTER & DOSSIER SAVING --- */
window.saveTerminalProfile = async function() {
    const safeGet = (id) => document.getElementById(id) ? document.getElementById(id).value : '';
    await db.from('profiles').update({ username: safeGet('term-username'), avatar_url: safeGet('term-avatar') }).eq('id', currentUserId);

    const charPayload = {
        profile_id: currentUserId, name: safeGet('term-sheet-name'),
        stat_charisma: safeGet('stat-charisma'), stat_dexterity: safeGet('stat-dexterity'),
        stat_intelligence: safeGet('stat-intelligence'), stat_strength: safeGet('stat-strength'),
        stat_toughness: safeGet('stat-toughness'), stat_willpower: safeGet('stat-willpower'),
        vitality: parseInt(safeGet('term-vitality')) || 0, stress: parseInt(safeGet('term-stress')) || 0, adversity_tokens: parseInt(safeGet('term-adversity')) || 0,
        specialties: safeGet('term-specialties'), assets: safeGet('term-assets'), history: safeGet('term-history'),
        aug_head: safeGet('aug-head'), aug_torso: safeGet('aug-torso'),
        aug_larm: safeGet('aug-larm'), aug_rarm: safeGet('aug-rarm'), aug_lleg: safeGet('aug-lleg'), aug_rleg: safeGet('aug-rleg')
    };
    const { data: charData, error: charErr } = await db.from('characters').upsert(charPayload, { onConflict: 'profile_id' }).select().single();
    if (charErr) return;

    let skillsPayload = { character_id: charData.id };
    skillList.forEach(skill => {
        const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_');
        skillsPayload[safeKey] = parseInt(safeGet(`skill-${safeKey}`)) || 0;
    });
    await db.from('character_skills').upsert(skillsPayload, { onConflict: 'character_id' });
    alert("Character dossier & stats secured to database.");
    loadAllProfiles();
};

/* --- CARGO HUB --- */
function populateCargoVesselSelect() {
    const select = document.getElementById('cargo-vessel-select');
    if (!select) return;
    let html = '';
    globalShipMarkersCache.forEach(m => {
        html += `<option value="${m.id}">${m.name} (X: ${Math.round(m.x)}, Y: ${Math.round(m.y)})</option>`;
    });
    select.innerHTML = html || '<option value="">No active vessels found</option>';
}

window.switchCargoSubtab = function(subtab) {
    activeCargoSubtab = subtab;
    document.querySelectorAll('.cargo-subtab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`cargo-subtab-${subtab}`).classList.add('active');
    renderTerminalCargoDeck();
};

function renderTerminalCargoDeck() {
    const select = document.getElementById('cargo-vessel-select');
    const container = document.getElementById('terminal-cargo-items-container');
    const title = document.getElementById('cargo-category-title');
    if (!select || !container) return;

    const vesselId = select.value;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);

    if (!vessel) {
        container.innerHTML = '<span style="font-size:11px; color:#6b826a;">Select a valid vessel token above.</span>';
        return;
    }

    const cargo = sanitizeCargo(vessel.cargo_inventory);
    const currentCategoryItems = cargo[activeCargoSubtab] || [];

    let subtabNames = { perishables: '🍏 Perishables', expendables: '⚙️ Expendables', misc: '📦 Miscellaneous' };
    if (title) title.innerText = `${subtabNames[activeCargoSubtab]} Holdings`;

    let html = '';
    if (currentCategoryItems.length === 0) {
        html = `<span style="font-size:11px; color:#6b826a;">No cargo items recorded in this section. Use the form on the right to store items.</span>`;
    } else {
        currentCategoryItems.forEach((item, index) => {
            html += `
                <div class="note-card" style="display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:#030403;">
                    <div style="flex:2;">
                        <strong style="color:#00e5a3; font-size:12px;">${item.name}</strong>
                        <div style="font-size:10px; color:#6b826a;">Unit Type: ${item.unit || 'units'}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <button onclick="window.modifyCargoQty('${vessel.id}', ${index}, -1)" style="width:24px; padding:2px; font-size:12px; margin:0;">-</button>
                        <input type="number" value="${item.qty}" onchange="window.updateCargoQtyDirect('${vessel.id}', ${index}, this.value)" style="width:65px; margin:0; text-align:center; font-size:11px; padding:3px;">
                        <button onclick="window.modifyCargoQty('${vessel.id}', ${index}, 1)" style="width:24px; padding:2px; font-size:12px; margin:0;">+</button>
                        <button class="layer-del" onclick="window.removeCargoItem('${vessel.id}', ${index})" style="padding:3px 8px; font-size:10px; margin-left:6px;">X</button>
                    </div>
                </div>
            `;
        });
    }
    container.innerHTML = html;
}

window.modifyCargoQty = async function(vesselId, itemIndex, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let cargo = sanitizeCargo(vessel.cargo_inventory);
    if (cargo[activeCargoSubtab] && cargo[activeCargoSubtab][itemIndex]) {
        cargo[activeCargoSubtab][itemIndex].qty = Math.max(0, cargo[activeCargoSubtab][itemIndex].qty + delta);
        await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
        vessel.cargo_inventory = cargo;
        renderTerminalCargoDeck();
    }
};

window.updateCargoQtyDirect = async function(vesselId, itemIndex, newQty) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let cargo = sanitizeCargo(vessel.cargo_inventory);
    let val = Math.max(0, parseInt(newQty) || 0);
    if (cargo[activeCargoSubtab] && cargo[activeCargoSubtab][itemIndex]) {
        cargo[activeCargoSubtab][itemIndex].qty = val;
        await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
        vessel.cargo_inventory = cargo;
        renderTerminalCargoDeck();
    }
};

window.removeCargoItem = async function(vesselId, itemIndex) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    if (!confirm("Decommission this cargo item from vessel hold?")) return;
    let cargo = sanitizeCargo(vessel.cargo_inventory);
    if (cargo[activeCargoSubtab]) {
        cargo[activeCargoSubtab].splice(itemIndex, 1);
        await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
        vessel.cargo_inventory = cargo;
        renderTerminalCargoDeck();
    }
};

window.addNewCargoEntry = async function() {
    const select = document.getElementById('cargo-vessel-select');
    const category = document.getElementById('new-cargo-category').value;
    const name = document.getElementById('new-cargo-name').value.trim();
    const qty = Math.max(0, parseInt(document.getElementById('new-cargo-qty').value) || 0);
    const unit = document.getElementById('new-cargo-unit').value.trim() || 'units';

    if (!select || !select.value) { alert("Select a vessel token first."); return; }
    if (!name) { alert("Please enter an item name."); return; }

    let vessel = globalShipMarkersCache.find(m => m.id === select.value);
    if (!vessel) return;

    let cargo = sanitizeCargo(vessel.cargo_inventory);
    if (!cargo[category]) cargo[category] = [];

    cargo[category].push({ name, qty, unit });

    await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vessel.id);
    vessel.cargo_inventory = cargo;

    document.getElementById('new-cargo-name').value = '';
    document.getElementById('new-cargo-qty').value = '1';
    document.getElementById('new-cargo-unit').value = '';

    activeCargoSubtab = category;
    window.switchCargoSubtab(category);
    alert(`Stored ${qty} ${unit} of '${name}' in ${vessel.name} hold.`);
};

window.broadcastTerminalCargoManifest = async function() {
    const select = document.getElementById('cargo-vessel-select');
    if (!select || !select.value) return;
    let vessel = globalShipMarkersCache.find(m => m.id === select.value);
    if (!vessel) return;

    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `📦 [FULL CARGO MANIFEST] Vessel '${vessel.name}' synchronized manifest to fleet telemetry.`,
        message_type: 'text'
    });
    alert("Full cargo manifest broadcasted to Secure Comms!");
};

/* --- VESSEL DECK LOGIC (INTEGRITY, DECKS, WEAPONS, STANCE, HANGAR) --- */
function populateVesselDeckSelect() {
    const select = document.getElementById('vessel-deck-select');
    if (!select) return;
    let html = '';
    globalShipMarkersCache.forEach(m => {
        html += `<option value="${m.id}">${m.name}</option>`;
    });
    select.innerHTML = html || '<option value="">No active vessels found</option>';
}

window.switchVesselSubtab = function(subtab) {
    document.getElementById('vessel-subtab-core').classList.remove('active');
    document.getElementById('vessel-subtab-hangar').classList.remove('active');
    document.getElementById('vessel-core-view').style.display = 'none';
    document.getElementById('vessel-hangar-view').style.display = 'none';
    
    document.getElementById(`vessel-subtab-${subtab}`).classList.add('active');
    document.getElementById(`vessel-${subtab}-view`).style.display = 'block';
    
    window.renderVesselDeck();
};

window.updateShipStance = async function(shipId, stance) {
    await db.from('ship_markers').update({ ship_stance: stance }).eq('id', shipId);
    let ship = globalShipMarkersCache.find(s => s.id === shipId);
    if(ship) ship.ship_stance = stance;
    
    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `⚙️ [TACTICS] Vessel '${ship.name}' is now assuming **${stance.toUpperCase()}** stance.`,
        message_type: 'text'
    });
};

window.renderVesselDeck = function() {
    const select = document.getElementById('vessel-deck-select');
    if (!select || !select.value) return;

    const vesselId = select.value;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    // ----- RENDER CORE DIAGNOSTICS -----
    const healthContainer = document.getElementById('vessel-health-container');
    const decksContainer = document.getElementById('vessel-decks-container');
    const weaponsContainer = document.getElementById('vessel-weapons-container');

    if (healthContainer) {
        const s_int = vessel.integrity_shields !== undefined ? vessel.integrity_shields : 400;
        const s_max = vessel.max_shields || 400;
        const h_int = vessel.integrity_hull !== undefined ? vessel.integrity_hull : 300;
        const h_max = vessel.max_hull || 300;
        const r_int = vessel.integrity_reactive !== undefined ? vessel.integrity_reactive : 10;
        const r_max = vessel.max_reactive || 10;
        const a_int = vessel.integrity_ablative !== undefined ? vessel.integrity_ablative : 10;
        const a_max = vessel.max_ablative || 10;

        let currentStance = vessel.ship_stance || 'Balanced';
        let stanceHtml = `
            <div style="margin-top:10px; margin-bottom:10px; padding:6px; background:#0a1410; border:1px solid #00e5a3; border-radius:2px; display:flex; justify-content:space-between; align-items:center;">
                <label style="font-size:10px; color:#00e5a3; font-weight:bold;">TACTICAL STANCE:</label>
                <select onchange="window.updateShipStance('${vessel.id}', this.value)" style="width:160px; margin:0; padding:4px; font-size:10px; background:#040605; color:#00e5a3; border:1px solid #3c4e36;">
                    <option value="Balanced" ${currentStance === 'Balanced' ? 'selected' : ''}>Balanced (Standard)</option>
                    <option value="Aggressive" ${currentStance === 'Aggressive' ? 'selected' : ''}>Aggressive (+Dmg, -Def)</option>
                    <option value="Defensive" ${currentStance === 'Defensive' ? 'selected' : ''}>Defensive (+Def, -Dmg)</option>
                    <option value="Evasive" ${currentStance === 'Evasive' ? 'selected' : ''}>Evasive (Dodge Focus)</option>
                </select>
            </div>
        `;

        const makeBar = (label, current, max, color, key) => `
            <div style="margin-bottom: 8px;">
                <div style="display:flex; justify-content:space-between; font-size:10px; color:${color}; margin-bottom:2px;">
                    <strong>${label}</strong>
                    <span>${current} / ${max}</span>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    <button onclick="window.modifyShipHealth('${vessel.id}', '${key}', -10)" style="width:24px; padding:2px; font-size:10px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-10</button>
                    <button onclick="window.modifyShipHealth('${vessel.id}', '${key}', -1)" style="width:24px; padding:2px; font-size:12px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-</button>
                    <div style="flex-grow:1; height:12px; background:#030403; border:1px solid #3c4e36; border-radius:2px; overflow:hidden;">
                        <div style="width:${Math.max(0, Math.min(100, (current/max)*100))}%; height:100%; background:${current === 0 ? '#ff3333' : color}; transition:width 0.3s;"></div>
                    </div>
                    <button onclick="window.modifyShipHealth('${vessel.id}', '${key}', 1)" style="width:24px; padding:2px; font-size:12px; margin:0;">+</button>
                    <button onclick="window.modifyShipHealth('${vessel.id}', '${key}', 10)" style="width:24px; padding:2px; font-size:10px; margin:0;">+10</button>
                </div>
            </div>
        `;

        healthContainer.innerHTML = stanceHtml + makeBar('DEFLECTOR SHIELDS', s_int, s_max, '#00e1ff', 'shields') + makeBar('HULL INTEGRITY', h_int, h_max, '#ff3333', 'hull') + makeBar('REACTIVE ARMOR (PIERCE)', r_int, r_max, '#ffaa00', 'reactive') + makeBar('ABLATIVE ARMOR (HEAT)', a_int, a_max, '#ffaa00', 'ablative');
    }

    if (decksContainer) {
        let dHtml = '';
        const decks = vessel.ship_decks || [];
        if (decks.length === 0) dHtml = '<span style="font-size:10px; color:#6b826a;">No internal decks designated.</span>';
        else {
            decks.forEach((d, idx) => {
                dHtml += `
                <div style="margin-bottom: 8px; background: #030403; padding: 6px; border: 1px solid #00e1ff; border-radius: 2px;">
                    <div style="display:flex; justify-content:space-between; font-size:10px; color:#00e1ff; margin-bottom:2px;">
                        <strong>${d.name}</strong><span>${d.hp} / ${d.max_hp}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, -5)" style="width:24px; padding:2px; font-size:10px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-5</button>
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, -1)" style="width:24px; padding:2px; font-size:12px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-</button>
                        <div style="flex-grow:1; height:8px; background:#040605; border:1px solid #3c4e36; border-radius:2px; overflow:hidden;">
                            <div style="width:${Math.max(0, Math.min(100, (d.hp/d.max_hp)*100))}%; height:100%; background:${d.hp === 0 ? '#ff3333' : '#00e1ff'}; transition:width 0.3s;"></div>
                        </div>
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, 1)" style="width:24px; padding:2px; font-size:12px; margin:0;">+</button>
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, 5)" style="width:24px; padding:2px; font-size:10px; margin:0;">+5</button>
                        <button class="layer-del" onclick="window.deleteShipDeck('${vessel.id}', ${idx})" style="padding:2px 6px; font-size:10px; margin:0; margin-left:4px;">✕</button>
                    </div>
                </div>`;
            });
        }
        decksContainer.innerHTML = dHtml;
    }

    if (weaponsContainer) {
        let targetOptions = '<option value="">-- No Target --</option>';
        globalShipMarkersCache.forEach(m => { if(m.id !== vessel.id) targetOptions += `<option value="${m.id}">${m.name}</option>`; });

        const weapons = vessel.ship_weapons || [];
        let wHtml = '';
        if (weapons.length === 0) wHtml = '<span style="font-size:10px; color:#6b826a;">No weapon hardpoints installed.</span>';
        else {
            weapons.forEach((w, idx) => {
                wHtml += `
                <div class="note-card" style="padding:8px; margin-bottom:6px; background:#030403; border-color:#ff3333;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <strong style="color:#ff6b6b; font-size:12px;">[${w.loc || 'Unmounted'}] ${w.name}</strong>
                            <div style="font-size:10px; color:#d4c5a9;">${w.dice} ${w.modifier} ${w.explodes ? '💥' : ''}</div>
                        </div>
                        <div style="display:flex; gap:6px; align-items:center;">
                            <select id="wpn-target-${vessel.id}-${idx}" style="width:120px; height:20px; font-size:9px; margin:0; padding:0; background:#0a1410; color:#00e5a3; border:1px solid #3c4e36; border-radius:2px;">${targetOptions}</select>
                            <input type="number" id="wpn-volley-${vessel.id}-${idx}" value="1" min="1" title="Volley Count" style="width:35px; height:20px; font-size:10px; margin:0; padding:0; text-align:center; border:1px solid #ff6b6b; background:#0a1410; color:#ff6b6b; border-radius:2px;">
                            <button class="layer-edit" onclick="window.rollShipWeapon('${vessel.id}', ${idx})" style="padding:4px 10px; font-size:10px; border-color:#ff6b6b; color:#ff6b6b;">FIRE</button>
                            <button class="layer-del" onclick="window.deleteShipWeapon('${vessel.id}', ${idx})" style="padding:4px 8px; font-size:10px;">✕</button>
                        </div>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-top:8px; gap:8px;">
                        <div style="flex:1; text-align:center; background:#0a1410; border:1px solid #3c4e36; border-radius:2px; padding:4px;">
                            <div style="font-size:9px; color:#6b826a; margin-bottom:4px;">AMMO: ${w.ammo < 0 ? 'INF' : `${w.ammo}/${w.max_ammo}`}</div>
                            ${w.ammo >= 0 ? `<div style="display:flex; justify-content:center; gap:4px;"><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'ammo', -1)" style="width:20px; padding:2px; margin:0; font-size:10px;">-</button><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'ammo', 1)" style="width:20px; padding:2px; margin:0; font-size:10px;">+</button></div>` : ''}
                        </div>
                        <div style="flex:1; text-align:center; background:#0a1410; border:1px solid #3c4e36; border-radius:2px; padding:4px;">
                            <div style="font-size:9px; color:#6b826a; margin-bottom:4px;">COOLDOWN: ${w.cooldown || 0}</div>
                            <div style="display:flex; justify-content:center; gap:4px;"><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'cooldown', -1)" style="width:20px; padding:2px; margin:0; font-size:10px;">-</button><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'cooldown', 1)" style="width:20px; padding:2px; margin:0; font-size:10px;">+</button></div>
                        </div>
                        <div style="flex:1; text-align:center; background:#0a1410; border:1px solid #3c4e36; border-radius:2px; padding:4px;">
                            <div style="font-size:9px; color:#ffaa00; margin-bottom:4px;">OVERHEAT: ${w.overheat || 0}/10</div>
                            <div style="display:flex; justify-content:center; gap:4px;"><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'overheat', -1)" style="width:20px; padding:2px; margin:0; font-size:10px;">-</button><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'overheat', 1)" style="width:20px; padding:2px; margin:0; font-size:10px;">+</button></div>
                        </div>
                    </div>
                </div>`;
            });
        }
        weaponsContainer.innerHTML = wHtml;
    }

    // ----- RENDER HANGAR BAY & STRIKE CRAFT -----
    const embarkedContainer = document.getElementById('vessel-embarked-container');
    const deployedContainer = document.getElementById('vessel-deployed-container');

    if (embarkedContainer) {
        let eHtml = '';
        const hangar = vessel.ship_hangar || [];
        if (hangar.length === 0) eHtml = '<span style="font-size:10px; color:#6b826a;">No squadrons currently embarked.</span>';
        else {
            hangar.forEach((sq, idx) => {
                let dbStats = STRIKE_CRAFT_DB[sq.type];
                eHtml += `
                <div class="note-card" style="padding:6px; margin-bottom:4px; background:#030403; border-color:#00e1ff; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <strong style="color:#00e1ff; font-size:11px;">${sq.name}</strong>
                        <div style="font-size:9px; color:#6b826a;">${dbStats.label} | Units: ${sq.count} | Max HP: ${dbStats.base_hp * sq.count}</div>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button class="layer-edit" onclick="window.launchSquadron('${vessel.id}', ${idx})" style="padding:4px 10px; font-size:9px; border-color:#00e1ff; color:#00e1ff;">LAUNCH</button>
                        <button class="layer-del" onclick="window.deleteSquadron('${vessel.id}', ${idx}, false)" style="padding:4px 8px; font-size:9px;">✕</button>
                    </div>
                </div>`;
            });
        }
        embarkedContainer.innerHTML = eHtml;
    }

    if (deployedContainer) {
        let targetOptions = '<option value="">-- Target --</option>';
        globalShipMarkersCache.forEach(m => { if(m.id !== vessel.id) targetOptions += `<option value="${m.id}">${m.name}</option>`; });

        let dHtml = '';
        const deployed = vessel.ship_deployed || [];
        if (deployed.length === 0) dHtml = '<span style="font-size:10px; color:#6b826a;">No active flights in sector.</span>';
        else {
            deployed.forEach((sq, idx) => {
                let dbStats = STRIKE_CRAFT_DB[sq.type];
                let wpnOptions = '';
                dbStats.weapons.forEach((w, wIdx) => { wpnOptions += `<option value="${wIdx}">${w.name} (${w.dice})</option>`; });

                dHtml += `
                <div class="note-card" style="padding:8px; margin-bottom:6px; background:#030403; border-color:#ffaa00;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <strong style="color:#ffaa00; font-size:12px;">🛫 ${sq.name}</strong>
                            <div style="font-size:9px; color:#d4c5a9;">${dbStats.label} | Units: ${sq.count} | HP: ${sq.hp} / ${sq.max_hp}</div>
                            <div style="display:flex; align-items:center; gap:4px; margin-top:4px;">
                                <span style="font-size:9px; color:#ff6b6b;">BINGO FUEL LOITER: ${sq.loiter}/4</span>
                                <button onclick="window.modifySquadronLoiter('${vessel.id}', ${idx}, -1)" style="padding:0 4px; font-size:9px;">-</button>
                                <button onclick="window.modifySquadronLoiter('${vessel.id}', ${idx}, 1)" style="padding:0 4px; font-size:9px;">+</button>
                            </div>
                        </div>
                        <div style="display:flex; gap:6px; flex-direction:column; align-items:flex-end;">
                            <button class="layer-edit" onclick="window.recallSquadron('${vessel.id}', ${idx})" style="padding:4px 10px; font-size:9px; border-color:#00e5a3; color:#00e5a3;">RECALL TO HANGAR</button>
                            <button class="layer-del" onclick="window.deleteSquadron('${vessel.id}', ${idx}, true)" style="padding:2px 8px; font-size:8px;">RECORD CASUALTY</button>
                        </div>
                    </div>
                    
                    <div style="margin-top:8px; padding-top:6px; border-top:1px dashed #3c4e36; display:flex; gap:6px; align-items:center;">
                        <select id="sq-wpn-select-${vessel.id}-${idx}" style="flex:2; height:22px; font-size:9px; margin:0; padding:2px; background:#0a1410; color:#ffaa00; border:1px solid #3c4e36;">${wpnOptions}</select>
                        <select id="sq-target-${vessel.id}-${idx}" style="flex:1.5; height:22px; font-size:9px; margin:0; padding:2px; background:#0a1410; color:#00e5a3; border:1px solid #3c4e36;">${targetOptions}</select>
                        <button class="layer-edit" onclick="window.rollSquadronWeapon('${vessel.id}', ${idx})" style="flex:1; padding:4px; font-size:9px; border-color:#ffaa00; color:#ffaa00; margin:0;">FIRE</button>
                    </div>
                </div>`;
            });
        }
        deployedContainer.innerHTML = dHtml;
    }
};

/* --- STRIKE CRAFT HANGAR LOGIC --- */
window.commissionSquadron = async function() {
    const select = document.getElementById('vessel-deck-select');
    if (!select || !select.value) { alert("Select a vessel to commission to."); return; }
    
    const vesselId = select.value;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    const name = document.getElementById('new-squadron-name').value.trim();
    const type = document.getElementById('new-squadron-type').value;
    const count = parseInt(document.getElementById('new-squadron-size').value) || 4;

    if (!name) { alert("Enter a callsign for this squadron."); return; }

    let hangar = vessel.ship_hangar || [];
    let dbStats = STRIKE_CRAFT_DB[type];
    
    let sqId = 'sq_' + Math.random().toString(36).substr(2, 9);
    hangar.push({
        id: sqId,
        name: name,
        type: type,
        count: count,
        hp: dbStats.base_hp * count,
        max_hp: dbStats.base_hp * count,
        loiter: 4
    });

    await db.from('ship_markers').update({ ship_hangar: hangar }).eq('id', vessel.id);
    vessel.ship_hangar = hangar;

    document.getElementById('new-squadron-name').value = '';
    window.renderVesselDeck();
    
    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `🔧 [HANGAR OPS] ${name} (${count}x ${dbStats.label}) commissioned aboard ${vessel.name}.`,
        message_type: 'text'
    });
};

window.launchSquadron = async function(vesselId, idx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let hangar = vessel.ship_hangar || [];
    let deployed = vessel.ship_deployed || [];

    let sq = hangar.splice(idx, 1)[0];
    if (sq) {
        sq.loiter = 4; // Reset bingo fuel on launch
        deployed.push(sq);
        await db.from('ship_markers').update({ ship_hangar: hangar, ship_deployed: deployed }).eq('id', vessel.id);
        vessel.ship_hangar = hangar;
        vessel.ship_deployed = deployed;
        window.renderVesselDeck();

        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🛫 [FLIGHT OPS] ${sq.name} launched from ${vessel.name}. Cleared hot for 4 turns.`,
            message_type: 'text'
        });
    }
};

window.recallSquadron = async function(vesselId, idx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let hangar = vessel.ship_hangar || [];
    let deployed = vessel.ship_deployed || [];

    let sq = deployed.splice(idx, 1)[0];
    if (sq) {
        hangar.push(sq);
        await db.from('ship_markers').update({ ship_hangar: hangar, ship_deployed: deployed }).eq('id', vessel.id);
        vessel.ship_hangar = hangar;
        vessel.ship_deployed = deployed;
        window.renderVesselDeck();

        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🛬 [FLIGHT OPS] ${sq.name} recovered to ${vessel.name} hangar bay.`,
            message_type: 'text'
        });
    }
};

window.deleteSquadron = async function(vesselId, idx, isDeployed) {
    if (!confirm(isDeployed ? "Record this squadron as destroyed in combat?" : "Decommission this squadron from the hangar?")) return;
    
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let targetArray = isDeployed ? (vessel.ship_deployed || []) : (vessel.ship_hangar || []);
    let sq = targetArray.splice(idx, 1)[0];

    let updatePayload = isDeployed ? { ship_deployed: targetArray } : { ship_hangar: targetArray };
    await db.from('ship_markers').update(updatePayload).eq('id', vesselId);
    
    if (isDeployed) vessel.ship_deployed = targetArray;
    else vessel.ship_hangar = targetArray;

    window.renderVesselDeck();

    if (isDeployed && sq) {
        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `💥 [KIA REPORT] ${sq.name} destroyed in combat.`,
            message_type: 'text'
        });
    }
};

window.modifySquadronLoiter = async function(vesselId, idx, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let deployed = vessel.ship_deployed || [];
    if (deployed[idx]) {
        deployed[idx].loiter = Math.max(0, Math.min(10, deployed[idx].loiter + delta));
        await db.from('ship_markers').update({ ship_deployed: deployed }).eq('id', vesselId);
        vessel.ship_deployed = deployed;
        window.renderVesselDeck();
    }
};

window.rollSquadronWeapon = function(vesselId, sqIdx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let sq = (vessel.ship_deployed || [])[sqIdx];
    if (!sq) return;

    let wpnIdx = document.getElementById(`sq-wpn-select-${vesselId}-${sqIdx}`).value;
    let targetId = document.getElementById(`sq-target-${vesselId}-${sqIdx}`).value;
    
    let dbStats = STRIKE_CRAFT_DB[sq.type];
    let wpn = dbStats.weapons[wpnIdx];
    if (!wpn) return;

    let volleys = sq.count; // Squadron automatically fires its unit count
    if (volleys <= 0) return;

    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = wpn.dice.trim().match(diceRegex);
    if (!match) return;

    let baseNumDice = parseInt(match[1]) || 1;
    let numDice = baseNumDice * volleys;
    let diceFaces = parseInt(match[2]);

    let total = 0;
    let breakdown = [];

    for (let i = 0; i < numDice; i++) {
        let rollTotal = 0;
        let subRolls = [];
        let currentRoll;
        do {
            currentRoll = Math.floor(Math.random() * diceFaces) + 1;
            rollTotal += currentRoll;
            subRolls.push(currentRoll);
        } while (currentRoll === diceFaces && wpn.explodes);
        total += rollTotal;
        breakdown.push(`(d${diceFaces}: ${subRolls.join('💥')})`);
    }

    const breakdownText = breakdown.join(' + ');

    let targetShip = null;
    let combatLog = ``;
    let dmgType = wpn.dmgType || "Impact";
    let isPiercing = dmgType === "Piercing";
    let isHeat = dmgType === "Heat";

    if (targetId) {
        targetShip = globalShipMarkersCache.find(m => m.id === targetId);
        if (targetShip) {
            let tStance = targetShip.ship_stance || 'Balanced';
            if (tStance === 'Defensive') { total = Math.floor(total * 0.75); combatLog += `[Target Defensive: -25% Dmg] `; }
            if (tStance === 'Evasive') { total = Math.floor(total * 0.50); combatLog += `[Target Evasive: -50% Dmg] `; }
            if (tStance === 'Aggressive') { total = Math.floor(total * 1.25); combatLog += `[Target Aggressive: +25% Dmg] `; }

            let s_int = targetShip.integrity_shields !== undefined ? targetShip.integrity_shields : 400;
            let h_int = targetShip.integrity_hull !== undefined ? targetShip.integrity_hull : 300;
            let r_int = targetShip.integrity_reactive !== undefined ? targetShip.integrity_reactive : 10;
            let a_int = targetShip.integrity_ablative !== undefined ? targetShip.integrity_ablative : 10;
            
            let remainingDmg = total;

            let shieldDmg = Math.min(s_int, remainingDmg);
            s_int -= shieldDmg;
            remainingDmg -= shieldDmg;
            if (shieldDmg > 0) combatLog += `Shields absorbed: ${shieldDmg}. `;

            if (remainingDmg > 0) {
                if (isPiercing && r_int > 0) {
                    r_int -= 1;
                    combatLog += `[REACTIVE ARMOR] charge expended. Hull breach negated! `;
                    remainingDmg = 0;
                } else if (isHeat && a_int > 0) {
                    a_int -= 1;
                    combatLog += `[ABLATIVE ARMOR] charge expended. Hull damage negated! `;
                    remainingDmg = 0;
                } else {
                    let hullDmg = Math.min(h_int, remainingDmg);
                    h_int -= hullDmg;
                    remainingDmg -= hullDmg;
                    combatLog += `Hull suffered: ${hullDmg} damage! `;
                    if (h_int <= 0) combatLog += `**CRITICAL HULL BREACH!** `;
                }
            }

            db.from('ship_markers').update({
                integrity_shields: s_int,
                integrity_hull: h_int,
                integrity_reactive: r_int,
                integrity_ablative: a_int
            }).eq('id', targetShip.id);

            targetShip.integrity_shields = s_int;
            targetShip.integrity_hull = h_int;
            targetShip.integrity_reactive = r_int;
            targetShip.integrity_ablative = a_int;
        }
    }

    let targetString = targetShip ? ` at ${targetShip.name}` : ``;
    let breakdownString = `
        <div style="margin-top:4px; padding:4px; border-left:2px solid #ffaa00; background:rgba(255,170,0,0.1);">
            <strong>Damage Type:</strong> ${dmgType}<br>
            <strong>Base Output:</strong> ${breakdownText} = <strong style="color:#ff3333;">${total} Dmg</strong><br>
            ${targetShip ? `<strong>Target Report:</strong> ${combatLog}` : ''}
        </div>
    `;

    window.broadcastRoll(`[${sq.name}] FIRES ${wpn.name} (x${volleys})${targetString}`, breakdownString, total);
};

/* --- CORE SHIP COMBAT FIRE HANDLER --- */
window.rollShipWeapon = function(vesselId, idx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    
    let wpn = (vessel.ship_weapons || [])[idx];
    if (!wpn) return;

    let volleyInput = document.getElementById(`wpn-volley-${vesselId}-${idx}`);
    let volleys = volleyInput ? (parseInt(volleyInput.value) || 1) : 1;
    let targetSelect = document.getElementById(`wpn-target-${vesselId}-${idx}`);
    let targetId = targetSelect ? targetSelect.value : null;

    if (wpn.cooldown > 0) {
        if (!confirm(`[WARNING] ${wpn.name} is on cooldown! Firing will OVERRIDE and generate OVERHEAT. Proceed?`)) return;
        wpn.overheat = Math.min(10, (wpn.overheat || 0) + 1);
    } 
    
    if (wpn.ammo === 0) {
        alert(`[EMPTY] ${wpn.name} is out of ammunition!`); 
        return;
    }

    if (wpn.ammo > 0) {
        if (wpn.ammo < volleys) {
            alert(`[INSUFFICIENT AMMO] ${wpn.name} only has ${wpn.ammo} uses left!`);
            return;
        }
        wpn.ammo -= volleys; 
    }

    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = wpn.dice.trim().match(diceRegex);
    if (!match) { alert("Invalid dice format."); return; }

    let baseNumDice = parseInt(match[1]) || 1;
    let numDice = baseNumDice * volleys;
    let diceFaces = parseInt(match[2]);
    let modVal = (parseInt(wpn.modifier) || 0) * volleys;

    let total = 0;
    let breakdown = [];

    for (let i = 0; i < numDice; i++) {
        let rollTotal = 0;
        let subRolls = [];
        let currentRoll;
        do {
            currentRoll = Math.floor(Math.random() * diceFaces) + 1;
            rollTotal += currentRoll;
            subRolls.push(currentRoll);
        } while (currentRoll === diceFaces && wpn.explodes);
        
        total += rollTotal;
        breakdown.push(`(d${diceFaces}: ${subRolls.join('💥')})`);
    }

    total += modVal;
    
    // Apply Attacker Stance
    let stance = vessel.ship_stance || 'Balanced';
    if (stance === 'Aggressive') { total = Math.floor(total * 1.25); breakdown.push(`[Aggressive: +25%]`); } 
    else if (stance === 'Defensive') { total = Math.floor(total * 0.75); breakdown.push(`[Defensive: -25%]`); }

    if (modVal !== 0) breakdown.push(`[Mod: ${modVal >= 0 ? '+' : ''}${modVal}]`);
    const breakdownText = breakdown.join(' + ');
    
    // Target processing
    let targetShip = null;
    let combatLog = ``;
    let wpnLower = wpn.name.toLowerCase();
    let isPiercing = wpnLower.includes('pierce') || wpnLower.includes('piercing') || wpnLower.includes('rail') || wpnLower.includes('gauss');
    let isHeat = wpnLower.includes('heat') || wpnLower.includes('plasma') || wpnLower.includes('laser') || wpnLower.includes('gamma');
    let dmgType = isPiercing ? 'Piercing' : (isHeat ? 'Heat' : 'Impact/Ion');

    if (targetId) {
        targetShip = globalShipMarkersCache.find(m => m.id === targetId);
        if (targetShip) {
            let tStance = targetShip.ship_stance || 'Balanced';
            if (tStance === 'Defensive') { total = Math.floor(total * 0.75); combatLog += `[Target Defensive: -25% Dmg] `; }
            if (tStance === 'Evasive') { total = Math.floor(total * 0.50); combatLog += `[Target Evasive: -50% Dmg] `; }
            if (tStance === 'Aggressive') { total = Math.floor(total * 1.25); combatLog += `[Target Aggressive: +25% Dmg] `; }

            let s_int = targetShip.integrity_shields !== undefined ? targetShip.integrity_shields : 400;
            let h_int = targetShip.integrity_hull !== undefined ? targetShip.integrity_hull : 300;
            let r_int = targetShip.integrity_reactive !== undefined ? targetShip.integrity_reactive : 10;
            let a_int = targetShip.integrity_ablative !== undefined ? targetShip.integrity_ablative : 10;
            
            let remainingDmg = total;

            let shieldDmg = Math.min(s_int, remainingDmg);
            s_int -= shieldDmg;
            remainingDmg -= shieldDmg;
            if (shieldDmg > 0) combatLog += `Shields absorbed: ${shieldDmg}. `;

            if (remainingDmg > 0) {
                if (isPiercing && r_int > 0) {
                    r_int -= 1; combatLog += `[REACTIVE ARMOR] charge expended. Hull breach negated! `; remainingDmg = 0;
                } else if (isHeat && a_int > 0) {
                    a_int -= 1; combatLog += `[ABLATIVE ARMOR] charge expended. Hull damage negated! `; remainingDmg = 0;
                } else {
                    let hullDmg = Math.min(h_int, remainingDmg);
                    h_int -= hullDmg; remainingDmg -= hullDmg;
                    combatLog += `Hull suffered: ${hullDmg} damage! `;
                    if (h_int <= 0) combatLog += `**CRITICAL HULL BREACH!** `;
                }
            }

            db.from('ship_markers').update({ integrity_shields: s_int, integrity_hull: h_int, integrity_reactive: r_int, integrity_ablative: a_int }).eq('id', targetShip.id);
            targetShip.integrity_shields = s_int; targetShip.integrity_hull = h_int; targetShip.integrity_reactive = r_int; targetShip.integrity_ablative = a_int;
        }
    }

    db.from('ship_markers').update({ ship_weapons: vessel.ship_weapons }).eq('id', vesselId);
    window.renderVesselDeck();

    let volleyTag = volleys > 1 ? ` (x${volleys} Volley)` : '';
    let targetString = targetShip ? ` at ${targetShip.name}` : ` into the void`;
    let breakdownString = `
        <div style="margin-top:4px; padding:4px; border-left:2px solid #ffaa00; background:rgba(255,170,0,0.1);">
            <strong>Damage Type:</strong> ${dmgType}<br>
            <strong>Base Output:</strong> ${breakdownText} = <strong style="color:#ff3333;">${total} Dmg</strong><br>
            ${targetShip ? `<strong>Target Report:</strong> ${combatLog}` : ''}
        </div>`;
    window.broadcastRoll(`[${vessel.name}] FIRES [${wpn.loc || 'Mount'}]${volleyTag}${targetString}`, breakdownString, total);
};

/* --- DECK / MODIFIERS SAVING --- */
window.addShipDeck = async function() {
    const select = document.getElementById('vessel-deck-select');
    const name = document.getElementById('new-deck-name').value.trim();
    let maxHp = parseInt(document.getElementById('new-deck-hp').value) || 50;

    if (!select || !select.value) { alert("Select a diagnostic target vessel first."); return; }
    if (!name) { alert("Please enter a deck or system name."); return; }
    
    let vessel = globalShipMarkersCache.find(m => m.id === select.value);
    if (!vessel) return;

    let decks = vessel.ship_decks || [];
    decks.push({ name: name, hp: maxHp, max_hp: maxHp });

    await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vessel.id);
    vessel.ship_decks = decks;

    document.getElementById('new-deck-name').value = '';
    document.getElementById('new-deck-hp').value = '50';
    window.renderVesselDeck();
};

window.modifyShipDeckHealth = async function(vesselId, idx, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let decks = vessel.ship_decks || [];
    if (decks[idx]) {
        let current = decks[idx].hp;
        let max = decks[idx].max_hp;
        decks[idx].hp = Math.max(0, Math.min(max, current + delta));
        
        await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vesselId);
        vessel.ship_decks = decks;
        window.renderVesselDeck();
    }
};

window.deleteShipDeck = async function(vesselId, idx) {
    if (!confirm("Scrap this internal deck?")) return;
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let decks = vessel.ship_decks || [];
    decks.splice(idx, 1);

    await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vesselId);
    vessel.ship_decks = decks;
    window.renderVesselDeck();
};
