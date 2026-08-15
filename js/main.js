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

let editingCodexId = null;
let activeCargoSubtab = 'perishables';
let activeCodexCategory = 'factions';
let codexSearchFilter = '';
let hyperlanesVisible = true;

/* ==========================================================================
   2. ACTIVE TOOL & MAP INTERACTION STATE
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
let globalHyperlanesCache = [];

const driveSpeeds = {
    sublight: { name: "Sublight Thrusters (0.1c)", speed: 10, label: "0.1c Sublight" },
    ftl_class1: { name: "Standard Class 1 Warp Drive", speed: 250, label: "Class 1 Warp" },
    ftl_class2: { name: "Military Class 2 Hyperdrive", speed: 600, label: "Class 2 Hyperdrive" },
    ftl_fold: { name: "Experimental Fold/Jump Drive", speed: 2500, label: "Fold Jump" }
};

/* ==========================================================================
   3. IN-UNIVERSE CALENDAR & CHRONOLOGY ENGINE
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
   4. DATABASE SYNC, AUTH & STATE LOADERS
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

// --- NEW ANOMALY DETECTION ENGINE ---
async function checkAnomalyProximity(ship) {
    if (!ship) return;
    const DRADIS_RANGE = 180; // Distance required to trigger reveal
    
    let anomalies = globalDbSystemsCache.filter(s => s.luminosity === 'Hidden Anomaly');
    
    for (let anomaly of anomalies) {
        let dx = ship.x - anomaly.x;
        let dy = ship.y - anomaly.y;
        let dist = Math.sqrt(dx*dx + dy*dy);
        
        if (dist < DRADIS_RANGE) {
            // Trigger DRADIS Reveal
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
   5. CLOUD CODEX ENGINE & DOCUMENT UPLOADER / EDITOR
   ========================================================================== */
async function loadCodexEntries() {
    const { data } = await db.from('codex_entries').select('*').order('created_at', { ascending: false });
    if (data && data.length > 0) {
        globalCodexEntriesCache = data;
    } else {
        globalCodexEntriesCache = [
            { id: 'cdx-1', category: 'factions', title: 'Task Force Black', subtitle: 'Allied Command', content: 'Autonomous deep-space exploration and containment fleet operating outside regular jurisdiction.' },
            { id: 'cdx-2', category: 'factions', title: 'The Syndicate', subtitle: 'Hostile / Outer Rim', content: 'Loose cartel of rogue captains, smugglers, and black-market station masters.' },
            { id: 'cdx-3', category: 'lore', title: 'The Dark Forest Anomaly', subtitle: 'Sector 1042', content: 'Unexplained subspace static emanating from Sector 1042. Quantum communications drop instantly upon entry.' },
            { id: 'cdx-4', category: 'npcs', title: 'Commander Vane', subtitle: 'Task Force Black Flagship', content: 'Primary mission commander. Veteran of the First Contact Boundary skirmishes.' }
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
   6. TERMINAL & UI CONTROLLERS
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

// --- HYPERLANE ROUTE DRAWING LOGIC ---
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

function sanitizeCargo(inv) {
    if (!inv || typeof inv !== 'object' || Object.keys(inv).length === 0) {
        return {
            "perishables": [
                { name: "Standard Rations", qty: 90, unit: "Days" },
                { name: "Trauma MedKits", qty: 15, unit: "Crates" }
            ],
            "expendables": [
                { name: "Kinetic Rounds", qty: 500, unit: "Shots" },
                { name: "Energy Cores", qty: 200, unit: "Cells" },
                { name: "Titanium Armor Hull Plates", qty: 50, unit: "Units" }
            ],
            "misc": [
                { name: "Security Marines", qty: 6, unit: "Personnel" },
                { name: "Unprocessed Asteroid Salvage", qty: 3, unit: "Tons" }
            ]
        };
    }
    return inv;
}

/* Arsenal & Dice Roller */
function renderArsenalList() {
    const container = document.getElementById('arsenal-list-container');
    if (!container) return;
    const myProfile = allProfiles.find(p => p.id === currentUserId) || {};
    const arsenal = myProfile.arsenal || [];
    
    let html = '';
    arsenal.forEach(w => {
        html += `
        <div class="arsenal-row">
            <span style="font-size:11px; color:#00e5a3; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${w.name}</span>
            <span style="font-size:10px; color:#d4c5a9;">${w.dice}</span>
            <span style="font-size:10px; color:#d4c5a9;">${w.modifier}</span>
            <span style="font-size:10px;" title="Exploding Dice">${w.explodes ? '💥' : ''}</span>
            <div style="display:flex; gap:4px;">
                <button class="layer-edit" onclick="window.rollWeapon('${w.id}')" style="padding:4px; flex:1;">ROLL</button>
                <button class="layer-del" onclick="window.deleteWeapon('${w.id}')" style="padding:4px; width:22px;">X</button>
            </div>
        </div>
        `;
    });
    container.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No weapons in active arsenal.</span>';
}

window.addArsenalItem = async function() {
    const name = document.getElementById('new-wpn-name').value.trim();
    let dice = document.getElementById('new-wpn-dice').value.trim().toLowerCase();
    let mod = document.getElementById('new-wpn-mod').value.trim();
    const explodes = document.getElementById('new-wpn-explodes').checked;

    if (!name) return;
    if (!dice) dice = '1d6';
    if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
    if (!mod) mod = '+0';

    await db.from('character_arsenal').insert({
        profile_id: currentUserId, name: name, dice: dice, modifier: mod, explodes: explodes
    });

    document.getElementById('new-wpn-name').value = '';
    document.getElementById('new-wpn-dice').value = '';
    document.getElementById('new-wpn-mod').value = '';
    loadAllProfiles();
};

window.deleteWeapon = async function(id) {
    if (!confirm("Remove this weapon from your arsenal?")) return;
    await db.from('character_arsenal').delete().eq('id', id);
    loadAllProfiles();
};

window.rollWeapon = function(id) {
    const myProfile = allProfiles.find(p => p.id === currentUserId) || {};
    const wpn = (myProfile.arsenal || []).find(w => w.id === id);
    if (!wpn) return;

    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = wpn.dice.trim().match(diceRegex);
    if (!match) { alert("Invalid dice format. Use formats like 'd20' or '6d20'."); return; }

    let numDice = parseInt(match[1]) || 1;
    let diceFaces = parseInt(match[2]);
    let modVal = parseInt(wpn.modifier) || 0;

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
    if (modVal !== 0) breakdown.push(`[Mod: ${modVal >= 0 ? '+' : ''}${modVal}]`);

    const breakdownText = breakdown.join(' + ');
    const box = document.getElementById('dice-roll-result-box');
    
    box.style.display = 'block';
    box.innerHTML = `<strong>⚔️ ATTACK: ${wpn.name}</strong><br><span style="font-size:10px; color:#d4c5a9;">${breakdownText}</span><br><span style="font-size:14px; font-weight:bold; color:#00e5a3;">TOTAL RESULT: ${total}</span>`;
    
    window.broadcastRoll(`Attack - ${wpn.name}`, breakdownText, total);
};

window.executeDicePoolRoll = function() {
    const statCheckboxes = document.querySelectorAll('.roll-stat-cb:checked');
    const skillCheckboxes = document.querySelectorAll('.roll-skill-cb:checked');
    if (statCheckboxes.length === 0 && skillCheckboxes.length === 0) { alert("Select at least one core stat or skill."); return; }
    
    const myProfile = allProfiles.find(p => p.id === currentUserId) || { character: {}, skills: {} };
    const char = myProfile.character || {}; const skillsMap = myProfile.skills || {};
    const extraMod = parseInt(document.getElementById('roll-extra-mod').value) || 0;

    let breakdown = [], totalSum = 0;
    statCheckboxes.forEach(cb => {
        const diceType = char['stat_' + cb.value.toLowerCase()] || 'd6';
        const maxVal = parseInt(diceType.replace('d', '')) || 6;
        let subtotal = 0, rolls = [], currentRoll = 0;
        do {
            currentRoll = Math.floor(Math.random() * maxVal) + 1;
            subtotal += currentRoll; rolls.push(currentRoll);
        } while (currentRoll === maxVal);
        totalSum += subtotal;
        breakdown.push(`[${cb.value} (${diceType}): ${rolls.join(' 💥 ')} = <strong>${subtotal}</strong>]`);
    });

    skillCheckboxes.forEach(cb => {
        const safeKey = cb.value.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const skillVal = skillsMap[safeKey] !== undefined ? skillsMap[safeKey] : 0;
        totalSum += skillVal;
        breakdown.push(`[${cb.value}: ${skillVal >= 0 ? '+' : ''}${skillVal}]`);
    });
    totalSum += extraMod;
    if (extraMod !== 0) breakdown.push(`[Mod: ${extraMod >= 0 ? '+' : ''}${extraMod}]`);

    const box = document.getElementById('dice-roll-result-box');
    box.style.display = 'block';
    box.innerHTML = `<strong>🎲 POOL RESULT:</strong><br><span style="font-size:10px; color:#d4c5a9;">${breakdown.join(' + ')}</span><br><span style="font-size:14px; font-weight:bold; color:#00e5a3;">TOTAL RESULT: ${totalSum}</span>`;
    
    window.broadcastRoll("Combined Pool", breakdown.join(' + '), totalSum);
};

function renderCharacterTerminalData() {
    const myProfile = allProfiles.find(p => p.id === currentUserId) || { character: {}, skills: {}, arsenal: [] };
    const char = myProfile.character || {};
    const skillsMap = myProfile.skills || {};
    
    const safeSet = (id, val) => { if(document.getElementById(id)) document.getElementById(id).value = val; };
    
    safeSet('term-username', myProfile.username || currentUserEmail.split('@')[0]);
    safeSet('term-avatar', myProfile.avatar_url || '');
    if(document.getElementById('my-terminal-avatar-preview')) document.getElementById('my-terminal-avatar-preview').src = myProfile.avatar_url || "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 60 60'><rect width='60' height='60' fill='%23040605'/><text x='50%25' y='50%25' fill='%2300e5a3' font-size='20' font-family='monospace' text-anchor='middle' dominant-baseline='middle'>?</text></svg>";
    safeSet('term-sheet-name', char.name || '');
    safeSet('stat-charisma', char.stat_charisma || 'd6'); safeSet('stat-dexterity', char.stat_dexterity || 'd8');
    safeSet('stat-intelligence', char.stat_intelligence || 'd10'); safeSet('stat-strength', char.stat_strength || 'd8');
    safeSet('stat-toughness', char.stat_toughness || 'd6'); safeSet('stat-willpower', char.stat_willpower || 'd12');
    safeSet('term-vitality', char.vitality || 0); safeSet('term-stress', char.stress || 0); safeSet('term-adversity', char.adversity_tokens || 0);
    
    skillList.forEach(skill => {
        const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_');
        safeSet(`skill-${safeKey}`, skillsMap[safeKey] !== undefined ? skillsMap[safeKey] : 0);
    });

    safeSet('term-specialties', char.specialties || ''); 
    safeSet('term-assets', char.assets || '');
    safeSet('term-history', char.history || '');
    safeSet('aug-head', char.aug_head || '');
    safeSet('aug-torso', char.aug_torso || ''); safeSet('aug-larm', char.aug_larm || '');
    safeSet('aug-rarm', char.aug_rarm || ''); safeSet('aug-lleg', char.aug_lleg || '');
    safeSet('aug-rleg', char.aug_rleg || '');
    
    renderArsenalList();

    const rosterDiv = document.getElementById('crew-roster-container');
    if(rosterDiv) {
        let html = '';
        allProfiles.forEach(p => {
            const pChar = p.character || {};
            html += `
                <div class="note-card" style="display:flex; gap:12px; align-items:flex-start;">
                    <img src="${p.avatar_url || "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 60 60'><rect width='60' height='60' fill='%23040605'/><text x='50%25' y='50%25' fill='%2300e5a3' font-size='20' font-family='monospace' text-anchor='middle' dominant-baseline='middle'>?</text></svg>"}" class="avatar-img">
                    <div style="flex-grow:1;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <strong style="color:#00e5a3; font-size:12px;">${p.username || 'Commander'} ${p.role === 'dm' ? '[DM]' : ''}</strong>
                            <span style="font-size:10px; color:#ff6b6b;">Vit: ${pChar.vitality || 0}/10 | Stress: ${pChar.stress || 0}/20</span>
                        </div>
                        <p style="margin:2px 0; font-size:11px; color:#d4c5a9;"><strong>${pChar.name || 'Unnamed'}</strong></p>
                        <div style="font-size:10px; color:#6b826a; margin:2px 0;">
                            CH: ${pChar.stat_charisma || 'd6'} | DEX: ${pChar.stat_dexterity || 'd8'} | INT: ${pChar.stat_intelligence || 'd10'} | STR: ${pChar.stat_strength || 'd8'} | TOU: ${pChar.stat_toughness || 'd6'} | WIL: ${pChar.stat_willpower || 'd12'}
                        </div>
                        <p style="margin:4px 0 0 0; font-size:10px; color:#d4c5a9; background:#040605; padding:6px;">${pChar.specialties || 'No specialties recorded.'}</p>
                    </div>
                </div>
            `;
        });
        rosterDiv.innerHTML = html;
    }
}

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

/* Cargo Hub */
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

/* Objectives & Notes */
window.addCampaignObjective = async function() {
    const title = document.getElementById('new-obj-title').value;
    const description = document.getElementById('new-obj-desc').value;
    if (!title) return;
    await db.from('campaign_objectives').insert({ title, description, completed: false });
    document.getElementById('new-obj-title').value = ''; document.getElementById('new-obj-desc').value = '';
    loadCampaignObjectives();
};

window.toggleObjectiveComplete = async function(id, currentStatus) {
    await db.from('campaign_objectives').update({ completed: !currentStatus }).eq('id', id); loadCampaignObjectives();
};

window.deleteCampaignObjective = async function(id) {
    if (!confirm("Delete objective?")) return;
    await db.from('campaign_objectives').delete().eq('id', id); loadCampaignObjectives();
};

function renderCampaignObjectives() {
    const container = document.getElementById('objectives-list-container');
    if (!container) return;
    let html = '';
    campaignObjectivesList.forEach(obj => {
        html += `
            <div class="note-card" style="border-color:${obj.completed ? '#00e5a3' : '#3c4e36'}; opacity:${obj.completed ? '0.7' : '1'};">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong style="color:${obj.completed ? '#00e5a3' : '#00e5a3'}; font-size:11px; text-decoration:${obj.completed ? 'line-through' : 'none'};">${obj.title}</strong>
                    <div style="display:flex; gap:6px;">
                        <button class="layer-edit" onclick="window.toggleObjectiveComplete('${obj.id}', ${obj.completed})" style="font-size:9px;">${obj.completed ? 'Undo' : 'Complete'}</button>
                        <button class="layer-del" onclick="window.deleteCampaignObjective('${obj.id}')" style="font-size:9px;">X</button>
                    </div>
                </div>
                <p style="margin:4px 0 0 0; font-size:10px; color:#d4c5a9;">${obj.description || ''}</p>
            </div>
        `;
    });
    container.innerHTML = html;
}

window.createOrUpdateNote = async function() {
    const title = document.getElementById('term-note-title').value;
    const content = document.getElementById('term-note-content').value;
    const scope = document.getElementById('term-note-scope').value;
    if (!title) return;
    
    if (editingNoteId) {
        await db.from('player_notes').update({ title, content, share_scope: scope }).eq('id', editingNoteId);
        editingNoteId = null;
        document.getElementById('btn-create-note').innerText = "+ CREATE NOTE";
    } else {
        await db.from('player_notes').insert({ author_id: currentUserId, title, content, share_scope: scope, target_id: 'general' });
    }
    document.getElementById('term-note-title').value = ''; document.getElementById('term-note-content').value = '';
    loadPlayerNotes();
};

window.editNote = function(id) {
    let n = playerNotesList.find(x => x.id === id);
    if(!n) return;
    editingNoteId = id;
    document.getElementById('term-note-title').value = n.title;
    document.getElementById('term-note-content').value = n.content;
    document.getElementById('term-note-scope').value = n.share_scope;
    document.getElementById('btn-create-note').innerText = "UPDATE NOTE";
};

window.deleteNote = async function(id) {
    if(!confirm("Permanently delete this intel note?")) return;
    await db.from('player_notes').delete().eq('id', id);
    if(editingNoteId === id) {
        editingNoteId = null;
        document.getElementById('btn-create-note').innerText = "+ CREATE NOTE";
        document.getElementById('term-note-title').value = ''; 
        document.getElementById('term-note-content').value = '';
    }
    loadPlayerNotes();
};

function renderTerminalNotes() {
    const container = document.getElementById('term-notes-list-container');
    if (!container) return;
    let html = '';
    playerNotesList.forEach(n => {
        if (n.author_id !== currentUserId && n.share_scope === 'private') return;
        const isMine = n.author_id === currentUserId;
        html += `
            <div class="note-card">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <strong style="color:#00e5a3; font-size:11px;">${n.title}</strong>
                    ${isMine ? `
                    <div style="display:flex; gap:4px;">
                        <button class="layer-edit" onclick="window.editNote('${n.id}')" style="font-size:8px;">Edit</button>
                        <button class="layer-del" onclick="window.deleteNote('${n.id}')" style="font-size:8px;">X</button>
                    </div>
                    ` : ''}
                </div>
                <p style="margin:4px 0 2px 0; font-size:10px; color:#d4c5a9; white-space:pre-wrap;">${n.content || ''}</p>
                <span style="font-size:9px; color:#6b826a;">Scope: ${n.share_scope}</span>
            </div>
        `;
    });
    container.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No notes recorded.</span>';
}

/* Combat Tracker */
function renderCombatTracker() {
    const bodies = [document.getElementById('combat-tracker-body'), document.getElementById('terminal-combat-body')];
    let html = '';
    if (currentUserRole === 'dm') {
        html += `
            <div style="background:#040605; padding:8px; border:1px solid #3c4e36; margin-bottom:8px;">
                <input type="text" id="comb-name" placeholder="Combatant Name..." style="font-size:10px; margin:2px 0;">
                <div style="display:flex; gap:6px;">
                    <input type="number" id="comb-init" placeholder="Initiative" style="font-size:10px; margin:2px 0;">
                    <input type="text" id="comb-hp" placeholder="HP/Vit" value="10/10" style="font-size:10px; margin:2px 0;">
                </div>
                <button class="btn-reveal" onclick="window.addCombatant()" style="font-size:10px; margin-top:4px;">+ ADD TO INITIATIVE</button>
            </div>
        `;
    }
    html += '<div style="max-height:220px; overflow-y:auto;">';
    combatantsList.forEach(c => {
        html += `
            <div class="note-card" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; padding:6px;">
                <div>
                    <strong style="color:#00e5a3; font-size:11px;">[Init: ${c.initiative}] ${c.name}</strong>
                    <p style="margin:2px 0 0 0; font-size:10px; color:#6b826a;">HP/Status: ${c.hp}</p>
                </div>
                ${currentUserRole === 'dm' ? `<button class="layer-del" onclick="window.removeCombatant('${c.id}')" style="padding:2px 6px; font-size:9px;">X</button>` : ''}
            </div>
        `;
    });
    html += '</div>';
    bodies.forEach(b => { if (b) b.innerHTML = html; });
}

window.addCombatant = async function() {
    const name = document.getElementById('comb-name').value;
    const initiative = parseInt(document.getElementById('comb-init').value) || 10;
    const hp = document.getElementById('comb-hp').value;
    if (!name) return;
    await db.from('combat_tracker').insert({ name, initiative, hp }); loadCombatTracker();
};

window.removeCombatant = async function(id) { 
    await db.from('combat_tracker').delete().eq('id', id); loadCombatTracker(); 
};

window.wipeGalaxySlate = async function() {
    if (currentUserRole !== 'dm') return;
    if (!confirm("Wipe all custom stars, ships, and territories?")) return;
    const { error: e1 } = await db.from('star_systems').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { error: e2 } = await db.from('ship_markers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { error: e3 } = await db.from('territories').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e1 || e2 || e3) {
        alert("Wipe failed: " + (e1?.message || e2?.message || e3?.message));
    } else {
        selectedTarget = null;
        loadGalaxyData();
        loadTerritories();
        alert("Galaxy slate wiped successfully.");
    }
};

/* Comms / Chat */
window.sendChatMessage = async function() {
    const input = document.getElementById('comms-message-input');
    const content = input.value.trim();
    if (!content) return;
    const recipientId = document.getElementById('comms-recipient').value;
    await db.from('chat_logs').insert({ sender_id: currentUserId, content: content, message_type: 'text', recipient_id: recipientId === 'global' ? null : recipientId });
    input.value = '';
    loadChatLogs();
};

window.broadcastRoll = async function(title, breakdownText, totalSum) {
    await db.from('chat_logs').insert({ sender_id: currentUserId, content: `Rolled [${title}]: ${totalSum}`, message_type: 'roll', recipient_id: null, roll_data: { breakdown: breakdownText } });
    loadChatLogs();
};

function renderChatFeed() {
    const feed = document.getElementById('comms-chat-feed');
    if (!feed) return;
    let html = '';
    chatLogsList.forEach(log => {
        if (log.recipient_id && log.recipient_id !== currentUserId && log.sender_id !== currentUserId) return;
        const sender = allProfiles.find(p => p.id === log.sender_id);
        const senderName = sender ? (sender.username || 'Commander') : 'Unknown';
        const isDM = !!log.recipient_id;
        let headerColor = isDM ? '#c778dd' : '#00e5a3';
        let prefix = isDM ? '🔒 [PRIVATE]' : '🌐';
        if (log.sender_id === 'system') { headerColor = '#6b826a'; prefix = '⚙️'; }
        if (log.message_type === 'roll') { headerColor = '#ff6b6b'; prefix = '🎲 [ROLL]'; }
        let contentHTML = log.content;
        if (log.message_type === 'roll' && log.roll_data) { contentHTML = `<strong style="font-size:12px;">${log.content}</strong><br><span style="font-size:9px; color:#6b826a;">${log.roll_data.breakdown}</span>`; }
        html += `
            <div style="background: rgba(6,9,7,0.6); padding: 6px; border-left: 2px solid ${headerColor}; border-radius: 2px;">
                <div style="font-size: 9px; color: ${headerColor}; margin-bottom: 2px;">${prefix} <strong>${log.sender_id === 'system' ? 'SYSTEM' : senderName}</strong></div>
                <div style="font-size: 11px; color: #d4c5a9;">${contentHTML}</div>
            </div>
        `;
    });
    feed.innerHTML = html; feed.scrollTop = feed.scrollHeight;
}

function populateCommsRecipients() {
    const select = document.getElementById('comms-recipient');
    if (!select) return;
    let currentVal = select.value;
    let html = '<option value="global">🌐 Global Broadcast</option>';
    allProfiles.forEach(p => {
        if (p.id !== currentUserId) { html += `<option value="${p.id}">🔒 DM: ${p.username || 'Commander'}</option>`; }
    });
    select.innerHTML = html;
    if (select.querySelector(`option[value="${currentVal}"]`)) select.value = currentVal;
}

/* ==========================================================================
   7. PROCEDURAL GENERATION & GALAXY MAP ENGINE
   ========================================================================== */
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

function initGalaxyEngine() {
    const canvas = document.getElementById('galaxyCanvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('canvas-container');
    const SYSTEM_ZOOM_THRESHOLD = 1.5;

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

    let camera = { x: 0, y: 0, zoom: 0.2, isDragging: false, startX: 0, startY: 0 };
    
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

    let dbStarSystems = [];
    let shipMarkers = [];
    let selectedTarget = null;
    let draggedMarker = null;
    let draggedStar = null; 

    async function loadGalaxyData() {
        const { data: starData } = await db.from('star_systems').select('*');
        if (starData) {
            dbStarSystems = starData.map(s => ({ ...s, isCustom: true, size: 5.0, type: s.luminosity === 'Black Hole' ? 'Black Hole' : 'Star', multiType: 'Single' }));
            globalDbSystemsCache = dbStarSystems;
        }
        const { data: markerData } = await db.from('ship_markers').select('*');
        if (markerData) {
            shipMarkers = markerData.map(m => ({ ...m, cargo_inventory: sanitizeCargo(m.cargo_inventory) }));
            globalShipMarkersCache = markerData;
        }
    }
    loadGalaxyData();

    realtimeChannel = db.channel('public:galaxy_map_sync')
        .on('broadcast', { event: 'tactical_ping' }, payload => {
            activePings.push({
                x: payload.payload.x,
                y: payload.payload.y,
                color: payload.payload.color || '#00e5a3',
                user: payload.payload.username,
                startTime: Date.now()
            });
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'star_systems' }, () => { loadGalaxyData(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ship_markers' }, () => { loadGalaxyData(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'territories' }, () => { loadTerritories(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hyperlanes' }, () => { loadHyperlanes(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'codex_entries' }, () => { loadCodexEntries(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'combat_tracker' }, () => { loadCombatTracker(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_objectives' }, () => { loadCampaignObjectives(); })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_logs' }, () => { loadChatLogs(); })
        .subscribe();

    window.spawnStarSystemAtCenter = async function() {
        if (currentUserRole !== 'dm') return;
        const name = document.getElementById('dm-tool-name').value || 'New System';
        const luminosity = document.getElementById('dm-tool-luminosity').value;
        const color = document.getElementById('dm-tool-color').value;
        await db.from('star_systems').insert({ name, x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, size: 5.0, color, luminosity, ownership: 'Unclaimed', control: 'Uncontested', industry_tier: 1 });
        loadGalaxyData();
    };

    window.spawnTokenAtCenter = async function() {
        const driveType = document.getElementById('dm-tool-drivetype').value || 'ftl_class1';
        await db.from('ship_markers').insert({ owner_id: currentUserId, name: document.getElementById('dm-tool-name').value || 'Task Force Black', drive_type: driveType, x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, color: document.getElementById('dm-tool-color').value, cargo_inventory: {} });
        loadGalaxyData();
    };

    function screenToWorld(sx, sy) { 
        const rect = canvas.getBoundingClientRect(); 
        const cssWidth = container.clientWidth;
        const cssHeight = container.clientHeight;
        return { 
            x: (sx - rect.left - cssWidth / 2 - camera.x) / camera.zoom, 
            y: (sy - rect.top - cssHeight / 2 - camera.y) / camera.zoom 
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
            const snapDist = 30 / camera.zoom;
            
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
            let allSystems = proceduralSystems.concat(dbStarSystems);
            let hitRadius = Math.max(15, 25 / camera.zoom);
            
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
            let allSystems = proceduralSystems.concat(dbStarSystems);
            for (let s of allSystems) {
                let dx = s.x - worldPos.x, dy = s.y - worldPos.y;
                if (Math.sqrt(dx * dx + dy * dy) < 40) {
                    snapTarget = { x: s.x, y: s.y, name: s.name };
                    break;
                }
            }
            if (!snapTarget) {
                for (let m of shipMarkers) {
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
            renderHUDTelemetry();
            return;
        }

        if (e.shiftKey || pingModeActive) {
            triggerTacticalPing(worldPos.x, worldPos.y);
            return;
        }

        if (measuringTapeActive) {
            if (!measureStartPoint) {
                measureStartPoint = worldPos;
            } else if (!measureEndPoint) {
                measureEndPoint = worldPos;
            } else {
                measureStartPoint = worldPos;
                measureEndPoint = null;
            }
            return;
        }

        const starHitRadius = Math.max(12, 15 / camera.zoom);
        const tokenHitRadius = Math.max(10, 15 / camera.zoom);
        const planetHitRadius = Math.max(6, 12 / camera.zoom);

        let time = Date.now();
        let allSystems = proceduralSystems.concat(dbStarSystems);

        if (camera.zoom > SYSTEM_ZOOM_THRESHOLD) {
            for (let s of allSystems) {
                let dx = s.x - worldPos.x, dy = s.y - worldPos.y;
                if (Math.sqrt(dx*dx + dy*dy) < 250 && s.type !== 'Nebula') { 
                    for (let b of getSystemBodies(s)) {
                        let angle = b.baseAngle + (time * b.speed);
                        let bx = s.x + Math.cos(angle) * b.radius; let by = s.y + Math.sin(angle) * b.radius;
                        let pdx = bx - worldPos.x, pdy = by - worldPos.y;
                        let hitThreshold = b.isStar ? starHitRadius : planetHitRadius;
                        if (Math.sqrt(pdx*pdx + pdy*pdy) < hitThreshold) { 
                            selectTargetAndPushRecent({ type: 'body', data: b }); 
                            return; 
                        }
                    }
                }
            }
        }

        for (let m of shipMarkers) {
            let dx = m.x - worldPos.x, dy = m.y - worldPos.y;
            if (Math.sqrt(dx * dx + dy * dy) < tokenHitRadius && (currentUserRole === 'dm' || m.owner_id === currentUserId)) {
                draggedMarker = m; 
                selectTargetAndPushRecent({ type: 'ship', data: m }); 
                return;
            }
        }

        for (let s of dbStarSystems) {
            let dx = s.x - worldPos.x, dy = s.y - worldPos.y;
            if (Math.sqrt(dx * dx + dy * dy) < starHitRadius) {
                selectTargetAndPushRecent({ type: 'star', data: s });
                if (currentUserRole === 'dm') draggedStar = s; 
                return;
            }
        }
        
        for (let s of proceduralSystems) {
            let dx = s.x - worldPos.x, dy = s.y - worldPos.y;
            if (Math.sqrt(dx * dx + dy * dy) < starHitRadius) {
                selectTargetAndPushRecent({ type: 'star', data: s }); 
                return;
            }
        }

        camera.isDragging = true; 
        camera.startX = e.clientX; 
        camera.startY = e.clientY;
    }

    container.addEventListener('mousedown', handleCanvasPointerDown);

    window.addEventListener('mousemove', (e) => {
        const worldPos = screenToWorld(e.clientX, e.clientY);
        window._lastMouseWorldX = worldPos.x;
        window._lastMouseWorldY = worldPos.y;

        if (draggedMarker) { draggedMarker.x = worldPos.x; draggedMarker.y = worldPos.y; return; }
        if (draggedStar) { draggedStar.x = worldPos.x; draggedStar.y = worldPos.y; return; }
        if (camera.isDragging) {
            camera.x += e.clientX - camera.startX; camera.y += e.clientY - camera.startY;
            camera.startX = e.clientX; camera.startY = e.clientY;
        }
    });

    window.addEventListener('mouseup', async () => {
        if (draggedMarker) { 
            await db.from('ship_markers').update({ x: draggedMarker.x, y: draggedMarker.y }).eq('id', draggedMarker.id); 
            await checkAnomalyProximity(draggedMarker);
            db.from('chat_logs').insert({ sender_id: currentUserId, content: `🚀 [NAVIGATION] Fleet token '${draggedMarker.name}' repositioned to X: ${Math.round(draggedMarker.x)}, Y: ${Math.round(draggedMarker.y)}.`, message_type: 'text' });
            draggedMarker = null; 
        }
        if (draggedStar) { await db.from('star_systems').update({ x: draggedStar.x, y: draggedStar.y }).eq('id', draggedStar.id); draggedStar = null; }
        camera.isDragging = false;
    });

    container.addEventListener('touchstart', (e) => {
        if (e.target && e.target.closest && e.target.closest('.panel')) return;
        const pos = getTouchPos(e);
        const syntheticEvent = {
            clientX: pos.clientX,
            clientY: pos.clientY,
            button: 0,
            shiftKey: e.shiftKey || false,
            target: e.target,
            closest: (selector) => e.target.closest ? e.target.closest(selector) : null
        };
        handleCanvasPointerDown(syntheticEvent);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
        const pos = getTouchPos(e);
        const worldPos = screenToWorld(pos.clientX, pos.clientY);
        window._lastMouseWorldX = worldPos.x;
        window._lastMouseWorldY = worldPos.y;

        if (draggedMarker) { draggedMarker.x = worldPos.x; draggedMarker.y = worldPos.y; return; }
        if (draggedStar) { draggedStar.x = worldPos.x; draggedStar.y = worldPos.y; return; }
        if (camera.isDragging) {
            e.preventDefault(); 
            camera.x += pos.clientX - camera.startX; 
            camera.y += pos.clientY - camera.startY;
            camera.startX = pos.clientX; 
            camera.startY = pos.clientY;
        }
    }, { passive: false });

    window.addEventListener('touchend', async () => {
        if (draggedMarker) { 
            await db.from('ship_markers').update({ x: draggedMarker.x, y: draggedMarker.y }).eq('id', draggedMarker.id); 
            await checkAnomalyProximity(draggedMarker);
            db.from('chat_logs').insert({ sender_id: currentUserId, content: `🚀 [NAVIGATION] Fleet token '${draggedMarker.name}' repositioned via mobile telemetry.`, message_type: 'text' });
            draggedMarker = null; 
        }
        if (draggedStar) { await db.from('star_systems').update({ x: draggedStar.x, y: draggedStar.y }).eq('id', draggedStar.id); draggedStar = null; }
        camera.isDragging = false;
    });

    container.addEventListener('wheel', (e) => {
        if (e.target.closest('.panel')) return;
        e.preventDefault();

        const cssWidth = container.clientWidth;
        const cssHeight = container.clientHeight;
        const mouseX = e.clientX - container.getBoundingClientRect().left - cssWidth / 2;
        const mouseY = e.clientY - container.getBoundingClientRect().top - cssHeight / 2;

        const worldX = (mouseX - camera.x) / camera.zoom;
        const worldY = (mouseY - camera.y) / camera.zoom;

        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newZoom = Math.max(0.02, Math.min(15.0, camera.zoom * zoomFactor));

        camera.x = mouseX - worldX * newZoom;
        camera.y = mouseY - worldY * newZoom;
        camera.zoom = newZoom;
    }, { passive: false });

    container.addEventListener('dblclick', (e) => {
        if (e.target.closest('.panel')) return;
        const worldPos = screenToWorld(e.clientX, e.clientY);
        let allSystems = proceduralSystems.concat(dbStarSystems);
        
        for (let s of allSystems) {
            let dx = s.x - worldPos.x, dy = s.y - worldPos.y;
            if (Math.sqrt(dx * dx + dy * dy) < 30) {
                selectTargetAndPushRecent({ type: 'star', data: s });
                camera.x = -s.x * 2.5;
                camera.y = -s.y * 2.5;
                camera.zoom = 2.5;
                return;
            }
        }
    });

    window.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        if (e.key.toLowerCase() === 'f') {
            if (selectedTarget && selectedTarget.data) {
                window.lockCameraOnSelected();
            }
        }
        if (e.key === 'Escape') {
            if (document.getElementById('codex-fullscreen-reader').style.display === 'block') {
                window.closeCodexFullscreen();
                return;
            }
            if (measuringTapeActive) window.toggleMeasuringTool();
            if (pingModeActive) window.togglePingMode();
            if (jumpPlottingActive) window.cancelJumpPlotting();
            if (territoryDrawActive) window.cancelDrawingTerritory();
            if (hyperlaneDrawActive) window.cancelDrawingHyperlane();
        }
    });

    window.lockCameraOnSelected = function() {
        if (!selectedTarget || !selectedTarget.data) return;
        let targetX = selectedTarget.data.x;
        let targetY = selectedTarget.data.y;

        if (selectedTarget.type === 'body' && selectedTarget.data.parentSystem) {
            targetX = selectedTarget.data.parentSystem.x;
            targetY = selectedTarget.data.parentSystem.y;
        }

        camera.x = -targetX * camera.zoom;
        camera.y = -targetY * camera.zoom;
    };

    window.clearSelectedTarget = function() {
        selectedTarget = null;
        if (jumpPlottingActive) window.cancelJumpPlotting();
        if (measuringTapeActive) window.toggleMeasuringTool();
        if (hyperlaneDrawActive) window.cancelDrawingHyperlane();
        renderHUDTelemetry();
    };

    window.updateShipDriveType = async function(shipId, newDriveType) {
        await db.from('ship_markers').update({ drive_type: newDriveType }).eq('id', shipId);
        let ship = globalShipMarkersCache.find(s => s.id === shipId);
        if (ship) ship.drive_type = newDriveType;
        if (activeJumpShip && activeJumpShip.id === shipId) {
            selectedDriveSpeed = driveSpeeds[newDriveType] ? driveSpeeds[newDriveType].speed : 250;
        }
        renderHUDTelemetry();
    };

    window.startJumpPlottingMode = function() {
        if (!selectedTarget || selectedTarget.type !== 'ship') return;
        jumpPlottingActive = true;
        measuringTapeActive = false;
        pingModeActive = false;
        territoryDrawActive = false;
        hyperlaneDrawActive = false;
        activeJumpShip = selectedTarget.data;
        jumpTargetPoint = null;

        let driveKey = activeJumpShip.drive_type || 'ftl_class1';
        selectedDriveSpeed = driveSpeeds[driveKey] ? driveSpeeds[driveKey].speed : 250;

        if(typeof window.updateToolButtonStyles === 'function') window.updateToolButtonStyles();
        renderHUDTelemetry();
    };

    window.cancelJumpPlotting = function() {
        jumpPlottingActive = false;
        activeJumpShip = null;
        jumpTargetPoint = null;
        renderHUDTelemetry();
    };

    window.setDriveSpeedKey = function(key) {
        if (driveSpeeds[key]) {
            selectedDriveSpeed = driveSpeeds[key].speed;
            renderHUDTelemetry();
        }
    };

    window.executePlottedJump = async function() {
        if (!activeJumpShip || !jumpTargetPoint) return;
        let ship = activeJumpShip;
        let target = jumpTargetPoint;

        let dx = target.x - ship.x;
        let dy = target.y - ship.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        let tripHours = Math.max(1, Math.round(dist / selectedDriveSpeed));

        universeTimeHours += tripHours;
        localStorage.setItem('odyssey_universe_time', universeTimeHours);
        updateCalendarDisplay();

        ship.x = target.x;
        ship.y = target.y;

        await db.from('ship_markers').update({ x: target.x, y: target.y }).eq('id', ship.id);

        await checkAnomalyProximity(ship);

        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🚀 [FTL JUMP EXECUTION] Vessel '${ship.name}' completed jump to ${target.name || 'target coordinates'} (X: ${Math.round(target.x)}, Y: ${Math.round(target.y)}). Trip Duration: ${tripHours} hrs. Universe clock advanced to ${formatUniverseTime(universeTimeHours)}.`,
            message_type: 'text'
        });

        jumpPlottingActive = false;
        activeJumpShip = null;
        jumpTargetPoint = null;

        loadGalaxyData();
        renderHUDTelemetry();
        alert(`Jump executed! Vessel arrived at destination. Elapsed time: ${tripHours} hours.`);
    };

    window.toggleBookmarkSelected = function() {
        if (!selectedTarget || !selectedTarget.data) return;
        let existsIndex = bookmarkedTargets.findIndex(b => b.data.id === selectedTarget.data.id);
        if (existsIndex >= 0) {
            bookmarkedTargets.splice(existsIndex, 1);
        } else {
            bookmarkedTargets.push({ type: selectedTarget.type, data: selectedTarget.data });
        }
        localStorage.setItem('odyssey_bookmarks', JSON.stringify(bookmarkedTargets));
        renderHUDTelemetry();
    };

    window.shareBookmarkToChat = function(name, type) {
        db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `Shared Tactical Coordinate 📍 [${type.toUpperCase()}]: ${name}`,
            message_type: 'text'
        });
        alert("Bookmark broadcasted to Secure Comms!");
    };

    window.jumpToBookmark = function(index) {
        let b = bookmarkedTargets[index];
        if (!b) return;
        selectedTarget = b;
        window.lockCameraOnSelected();
        renderHUDTelemetry();
    };

    window.jumpToRecent = function(index) {
        let r = recentTargets[index];
        if (!r) return;
        selectedTarget = r;
        window.lockCameraOnSelected();
        renderHUDTelemetry();
    };

    window.switchHudTab = function(tab) {
        activeHudTab = tab;
        document.querySelectorAll('.hud-tab-btn').forEach(b => b.classList.remove('active'));
        if (tab === 'telemetry') document.getElementById('tab-btn-details').classList.add('active');
        if (tab === 'bookmarks') document.getElementById('tab-btn-bookmarks').classList.add('active');
        if (tab === 'recents') document.getElementById('tab-btn-recents').classList.add('active');
        renderHUDTelemetry();
    };

    window.saveDMStarProperties = async function(id) {
        if (currentUserRole !== 'dm') return;
        const name = document.getElementById('edit-star-name').value;
        const ownership = document.getElementById('edit-star-ownership').value;
        const luminosity = document.getElementById('edit-star-luminosity').value;
        const tier = parseInt(document.getElementById('edit-star-tier').value) || 0;

        await db.from('star_systems').update({ name, ownership, luminosity, industry_tier: tier }).eq('id', id);
        alert("Stellar system parameters updated.");
        loadGalaxyData();
    };

    window.saveDMBodyProperties = function(id) {
        if (currentUserRole !== 'dm' || !selectedTarget || selectedTarget.type !== 'body') return;
        let b = selectedTarget.data;
        
        b.name = document.getElementById('edit-body-name').value;
        b.type = document.getElementById('edit-body-type').value;
        b.gravity = document.getElementById('edit-body-gravity').value;
        b.atmosphere = document.getElementById('edit-body-atmosphere').value;
        b.resources = document.getElementById('edit-body-resources').value;

        renderHUDTelemetry();
        alert("Celestial body properties synchronized to tactical display.");
    };

    function selectTargetAndPushRecent(target) {
        selectedTarget = target;
        let existsIndex = recentTargets.findIndex(r => r.data.id === target.data.id);
        if (existsIndex >= 0) recentTargets.splice(existsIndex, 1);
        recentTargets.unshift(target);
        if (recentTargets.length > 20) recentTargets.pop();
        localStorage.setItem('odyssey_recents', JSON.stringify(recentTargets));
        renderHUDTelemetry();
    }

    window.toggleMeasuringTool = function() {
        measuringTapeActive = !measuringTapeActive;
        if(!measuringTapeActive) { measureStartPoint = null; measureEndPoint = null; }
        pingModeActive = false; jumpPlottingActive = false; territoryDrawActive = false; hyperlaneDrawActive = false;
        window.updateToolButtonStyles();
    };

    window.togglePingMode = function() {
        pingModeActive = !pingModeActive;
        measuringTapeActive = false; jumpPlottingActive = false; territoryDrawActive = false; hyperlaneDrawActive = false;
        window.updateToolButtonStyles();
    };

    window.updateToolButtonStyles = function() {
        const mBtn = document.getElementById('measuring-tape-toggle-btn');
        const pBtn = document.getElementById('ping-tool-toggle-btn');
        const tBtn = document.getElementById('territory-tool-toggle-btn');
        const hBtn = document.getElementById('btn-start-hyperlane-draw');
        if(mBtn) { mBtn.style.borderColor = measuringTapeActive ? '#00e5a3' : '#3c4e36'; mBtn.style.color = measuringTapeActive ? '#00e5a3' : '#6b826a'; }
        if(pBtn) { pBtn.style.borderColor = pingModeActive ? '#00e5a3' : '#3c4e36'; pBtn.style.color = pingModeActive ? '#00e5a3' : '#6b826a'; }
        if(tBtn) { tBtn.style.borderColor = territoryDrawActive ? '#00e5a3' : '#3c4e36'; tBtn.style.color = territoryDrawActive ? '#00e5a3' : '#6b826a'; }
        if(hBtn) { hBtn.style.borderColor = hyperlaneDrawActive ? '#00e1ff' : '#4a7ab5'; hBtn.style.color = hyperlaneDrawActive ? '#00e1ff' : '#a2c4f5'; }
    };

    function triggerTacticalPing(x, y) {
        if (!realtimeChannel) return;
        realtimeChannel.send({
            type: 'broadcast', event: 'tactical_ping',
            payload: { x, y, username: allProfiles.find(p => p.id === currentUserId)?.username || 'Commander', color: currentUserRole === 'dm' ? '#ff6b6b' : '#00e5a3' }
        });
        activePings.push({ x, y, color: currentUserRole === 'dm' ? '#ff6b6b' : '#00e5a3', user: allProfiles.find(p => p.id === currentUserId)?.username || 'Commander', startTime: Date.now() });
        if(pingModeActive) window.togglePingMode();
    }

    function renderHUDTelemetry() {
        const content = document.getElementById('hud-content');
        
        if (activeHudTab === 'bookmarks') {
            let html = '<div style="font-size:11px;"><h4 style="margin:0 0 8px 0; color:#00e5a3;">Saved Bookmarks</h4>';
            if (bookmarkedTargets.length === 0) {
                html += '<span style="color:#6b826a; font-size:10px;">No saved bookmarks. Click bookmark on any target telemetry.</span>';
            } else {
                bookmarkedTargets.forEach((b, idx) => {
                    html += `
                        <div class="note-card" style="display:flex; justify-content:space-between; align-items:center; padding:6px; margin-bottom:4px;">
                            <div><strong style="color:#00e5a3;">${b.data.name}</strong><br><span style="font-size:9px; color:#6b826a;">Type: ${b.type}</span></div>
                            <div style="display:flex; gap:4px;">
                                <button class="layer-edit" onclick="window.jumpToBookmark(${idx})" style="font-size:9px; padding:2px 6px;">Jump</button>
                                <button class="layer-edit" onclick="window.shareBookmarkToChat('${b.data.name}', '${b.type}')" style="font-size:9px; padding:2px 6px;" title="Share">Share</button>
                            </div>
                        </div>
                    `;
                });
            }
            html += '</div>';
            content.innerHTML = html;
            return;
        }

        if (activeHudTab === 'recents') {
            let html = '<div style="font-size:11px;"><h4 style="margin:0 0 8px 0; color:#00e5a3;">Recent Navigation Targets</h4>';
            if (recentTargets.length === 0) {
                html += '<span style="color:#6b826a; font-size:10px;">No recent targets inspected.</span>';
            } else {
                recentTargets.forEach((r, idx) => {
                    html += `
                        <div class="note-card" style="display:flex; justify-content:space-between; align-items:center; padding:6px; margin-bottom:4px;">
                            <div><strong style="color:#00e5a3;">${r.data.name}</strong><br><span style="font-size:9px; color:#6b826a;">Type: ${r.type}</span></div>
                            <button class="layer-edit" onclick="window.jumpToRecent(${idx})" style="font-size:9px; padding:2px 6px;">Jump</button>
                        </div>
                    `;
                });
            }
            html += '</div>';
            content.innerHTML = html;
            return;
        }

        if (!selectedTarget) { content.innerHTML = `<p style="margin: 0; font-size: 12px; color: #6b826a;">Hover or click a target...</p>`; return; }
        
        let isBookmarked = bookmarkedTargets.some(b => b.data.id === selectedTarget.data.id);
        let bookmarkBtn = `<button class="btn-reveal" onclick="window.toggleBookmarkSelected()" style="font-size:9px; padding:4px; margin-top:4px;">${isBookmarked ? '★ BOOKMARKED' : '☆ BOOKMARK'}</button>`;
        let lockBtn = `<button class="btn-reveal" onclick="window.lockCameraOnSelected()" style="font-size:9px; padding:4px; margin-top:4px;">🎯 LOCK VIEW (F)</button>`;

        if (selectedTarget.type === 'star') {
            const s = selectedTarget.data;
            let multiTag = s.multiType !== 'Single' ? ` | <span style="color: #ffaa00;">${s.multiType} System</span>` : '';
            
            let dmEditorBox = '';
            if (currentUserRole === 'dm' && s.isCustom) {
                dmEditorBox = `
                    <div style="background:#040605; border:1px solid #ff3366; padding:8px; margin-top:8px; border-radius:2px;">
                        <span style="font-size:9px; color:#ff6b6b; font-weight:bold;">🛠️ OVERSEER STAR EDITOR</span>
                        <label style="font-size:9px; color:#6b826a; display:block; margin-top:4px;">Name:</label>
                        <input type="text" id="edit-star-name" value="${s.name}" style="font-size:10px; margin:2px 0;">
                        
                        <label style="font-size:9px; color:#6b826a; display:block;">Faction Claim / Ownership:</label>
                        <input type="text" id="edit-star-ownership" value="${s.ownership || 'Unclaimed'}" style="font-size:10px; margin:2px 0;">
                        
                        <div style="display:flex; gap:6px;">
                            <div style="flex:1;">
                                <label style="font-size:9px; color:#6b826a;">Class:</label>
                                <select id="edit-star-luminosity" style="font-size:9px; margin:2px 0;">
                                    <option value="Class G (Yellow)" ${s.luminosity==='Class G (Yellow)'?'selected':''}>Class G</option>
                                    <option value="Class M (Red Dwarf)" ${s.luminosity==='Class M (Red Dwarf)'?'selected':''}>Class M</option>
                                    <option value="Class O (Blue Giant)" ${s.luminosity==='Class O (Blue Giant)'?'selected':''}>Class O</option>
                                    <option value="Black Hole" ${s.luminosity==='Black Hole'?'selected':''}>Black Hole</option>
                                    <option value="Hidden Anomaly" ${s.luminosity==='Hidden Anomaly'?'selected':''}>Hidden Anomaly (Stealth)</option>
                                </select>
                            </div>
                            <div style="flex:1;">
                                <label style="font-size:9px; color:#6b826a;">Industry Tier:</label>
                                <input type="number" id="edit-star-tier" value="${s.industry_tier || 0}" style="font-size:10px; margin:2px 0;">
                            </div>
                        </div>
                        <button class="btn-reveal" onclick="window.saveDMStarProperties('${s.id}')" style="font-size:9px; padding:6px; margin-top:6px; width:100%;">SAVE SYSTEM CHANGES</button>
                        <button class="btn-remove" onclick="window.deleteStarSystem('${s.id}')" style="font-size:9px; padding:4px; margin-top:4px;">DESTROY STAR SYSTEM</button>
                    </div>
                `;
            }

            content.innerHTML = `
                <div style="font-size: 11px;">
                    <strong style="color: #00e5a3; font-size: 13px;">${s.type === 'Black Hole' ? '🕳️' : '⭐'} ${s.name}</strong><br>
                    <span style="color: #6b826a;">Class:</span> ${s.luminosity || 'Standard'} ${multiTag}<br>
                    <span style="color: #6b826a;">Ownership:</span> ${s.ownership || 'Unclaimed'}<br>
                    ${s.isCustom ? `<span style="color: #6b826a;">Industry Tier:</span> ${s.industry_tier || 0}<br>` : ''}
                    <div style="display:flex; gap:6px;">${lockBtn} ${bookmarkBtn}</div>
                    ${dmEditorBox}
                </div>
            `;
        } else if (selectedTarget.type === 'ship') {
            const m = selectedTarget.data;
            const currentDrive = m.drive_type || 'ftl_class1';

            let driveOptionsHtml = '';
            Object.keys(driveSpeeds).forEach(k => {
                driveOptionsHtml += `<option value="${k}" ${currentDrive === k ? 'selected' : ''}>${driveSpeeds[k].label}</option>`;
            });

            let jumpPlotterBox = '';
            if (jumpPlottingActive && activeJumpShip && activeJumpShip.id === m.id) {
                let targetInfo = jumpTargetPoint 
                    ? `Target: <strong>${jumpTargetPoint.name || 'Custom Vector'}</strong> (X: ${Math.round(jumpTargetPoint.x)}, Y: ${Math.round(jumpTargetPoint.y)})` 
                    : `<span style="color:#ffaa00;">Click on any star or map sector to lock target coordinates...</span>`;

                let calcTimeStr = '';
                if (jumpTargetPoint) {
                    let dx = jumpTargetPoint.x - m.x;
                    let dy = jumpTargetPoint.y - m.y;
                    let dist = Math.sqrt(dx * dx + dy * dy);
                    let hrs = Math.max(1, Math.round(dist / selectedDriveSpeed));
                    let ly = (dist / 100).toFixed(2);
                    let days1c = (ly * 365.25).toFixed(1);
                    calcTimeStr = `
                        <div style="font-size:10px; color:#00e5a3; margin:4px 0; background:#030403; padding:6px; border:1px solid #3c4e36;">
                            Distance: ${dist.toFixed(1)} u (${ly} LY)<br>
                            FTL Trip Duration: <strong>~${hrs} hours</strong><br>
                            Light-speed Time (@1c): ~${days1c} days
                        </div>
                    `;
                }

                jumpPlotterBox = `
                    <div style="background:#040605; border:1px solid #00e1ff; padding:8px; margin-top:8px; border-radius:2px;">
                        <span style="font-size:9px; color:#00e1ff; font-weight:bold;">🌌 JUMP VECTOR PLOTTER</span>
                        <div style="font-size:10px; color:#d4c5a9; margin:4px 0;">${targetInfo}</div>
                        
                        <label style="font-size:9px; color:#6b826a; display:block; margin-top:4px;">Drive System Override:</label>
                        <select onchange="window.setDriveSpeedKey(this.value)" style="font-size:9px; margin:2px 0; background:#0a1410; color:#00e1ff;">
                            ${driveOptionsHtml}
                        </select>
                        
                        ${calcTimeStr}
                        
                        <div style="display:flex; gap:6px; margin-top:6px;">
                            <button class="btn-reveal" onclick="window.executePlottedJump()" ${!jumpTargetPoint ? 'disabled style="opacity:0.5;"' : ''} style="flex:2; font-size:9px; padding:6px;">🚀 EXECUTE JUMP & ADVANCE TIME</button>
                            <button class="btn-remove" onclick="window.cancelJumpPlotting()" style="flex:1; font-size:9px; padding:6px;">CANCEL</button>
                        </div>
                    </div>
                `;
            } else {
                jumpPlotterBox = `
                    <button class="btn-deploy" onclick="window.startJumpPlottingMode()" style="font-size:9px; padding:6px; margin-top:6px;">🌌 PLOT JUMP VECTOR</button>
                `;
            }

            content.innerHTML = `
                <div style="font-size: 11px;">
                    <strong style="color: #00e1ff; font-size: 13px;">🚀 ${m.name}</strong><br>
                    <span style="color: #6b826a;">Position:</span> X: ${Math.round(m.x)}, Y: ${Math.round(m.y)}<br>
                    <div style="margin:4px 0;">
                        <label style="color: #6b826a; font-size:10px;">Engine Drive:</label>
                        <select onchange="window.updateShipDriveType('${m.id}', this.value)" style="font-size:10px; padding:2px; background:#0a1410; color:#00e1ff; margin:2px 0;">
                            ${driveOptionsHtml}
                        </select>
                    </div>
                    <div style="display:flex; gap:6px;">${lockBtn} ${bookmarkBtn}</div>
                    ${jumpPlotterBox}
                    <button class="btn-deploy" onclick="window.openFullCargoTerminal()" style="font-size:9px; padding:4px; margin-top:6px;">📦 INSPECT FULL CARGO HOLD</button>
                    <button class="btn-remove" onclick="window.deleteShipToken('${m.id}')" style="font-size:9px; padding:4px; margin-top:4px;">DECOMMISSION</button>
                </div>
            `;
        } else if (selectedTarget.type === 'body') {
            const p = selectedTarget.data;
            const icon = p.isStar ? '⭐' : '🪐';

            let dmBodyEditorBox = '';
            if (currentUserRole === 'dm') {
                dmBodyEditorBox = `
                    <div style="background:#040605; border:1px solid #ff3366; padding:8px; margin-top:8px; border-radius:2px;">
                        <span style="font-size:9px; color:#ff6b6b; font-weight:bold;">🛠️ OVERSEER PLANET EDITOR</span>
                        <label style="font-size:9px; color:#6b826a; display:block; margin-top:4px;">Designation:</label>
                        <input type="text" id="edit-body-name" value="${p.name}" style="font-size:10px; margin:2px 0;">
                        
                        <div style="display:flex; gap:6px;">
                            <div style="flex:1;">
                                <label style="font-size:9px; color:#6b826a;">Body Type:</label>
                                <select id="edit-body-type" style="font-size:9px; margin:2px 0;">
                                    <option value="Terrestrial" ${p.type==='Terrestrial'?'selected':''}>Terrestrial</option>
                                    <option value="Gas Giant" ${p.type==='Gas Giant'?'selected':''}>Gas Giant</option>
                                    <option value="Ice World" ${p.type==='Ice World'?'selected':''}>Ice World</option>
                                    <option value="Barren Rock" ${p.type==='Barren Rock'?'selected':''}>Barren Rock</option>
                                    <option value="Volcanic" ${p.type==='Volcanic'?'selected':''}>Volcanic</option>
                                </select>
                            </div>
                            <div style="flex:1;">
                                <label style="font-size:9px; color:#6b826a;">Gravity:</label>
                                <input type="text" id="edit-body-gravity" value="${p.gravity}" style="font-size:10px; margin:2px 0;">
                            </div>
                        </div>

                        <label style="font-size:9px; color:#6b826a; display:block;">Atmosphere:</label>
                        <input type="text" id="edit-body-atmosphere" value="${p.atmosphere}" style="font-size:10px; margin:2px 0;">

                        <label style="font-size:9px; color:#6b826a; display:block;">Scan Data / Resources:</label>
                        <textarea id="edit-body-resources" rows="2" style="font-size:10px; margin:2px 0;">${p.resources}</textarea>

                        <button class="btn-reveal" onclick="window.saveDMBodyProperties('${p.id}')" style="font-size:9px; padding:6px; margin-top:6px; width:100%;">APPLY PLANETARY SCANS</button>
                    </div>
                `;
            }

            content.innerHTML = `
                <div style="font-size: 11px;">
                    <strong style="color: ${p.color}; font-size: 13px;">${icon} ${p.name}</strong><br>
                    <span style="color: #6b826a;">System:</span> ${p.parentSystem.name}<br>
                    <span style="color: #6b826a;">Class:</span> ${p.type} | <span style="color: #6b826a;">Grav:</span> ${p.gravity}<br>
                    <span style="color: #00e5a3; font-weight:bold; margin-top:4px; display:block;">Scans:</span> <span style="color: #d4c5a9;">${p.resources}</span>
                    <div style="display:flex; gap:6px;">${lockBtn} ${bookmarkBtn}</div>
                    ${dmBodyEditorBox}
                </div>
            `;
        }
    }

    window.updateStarName = async function(id) { await db.from('star_systems').update({ name: document.getElementById('edit-star-name').value }).eq('id', id); loadGalaxyData(); };
    window.deleteStarSystem = async function(id) { await db.from('star_systems').delete().eq('id', id); selectedTarget = null; renderHUDTelemetry(); loadGalaxyData(); };
    window.deleteShipToken = async function(id) { await db.from('ship_markers').delete().eq('id', id); selectedTarget = null; renderHUDTelemetry(); loadGalaxyData(); };

    window.handleGlobalSearchInput = function(query) {
        const dropdown = document.getElementById('search-results-dropdown');
        if (!query || query.trim().length === 0) {
            dropdown.style.display = 'none';
            return;
        }
        let q = query.toLowerCase();
        let matches = [];

        globalDbSystemsCache.forEach(s => { if(s.name.toLowerCase().includes(q)) matches.push({ type: 'star', data: s, label: `⭐ ${s.name} (Custom)` }); });
        globalProceduralSystemsCache.forEach(s => { if(s.name.toLowerCase().includes(q)) matches.push({ type: 'star', data: s, label: `✨ ${s.name}` }); });
        globalShipMarkersCache.forEach(m => { if(m.name.toLowerCase().includes(q)) matches.push({ type: 'ship', data: m, label: `🚀 ${m.name}` }); });

        if (matches.length === 0) {
            dropdown.innerHTML = '<div class="search-result-item" style="color:#6b826a;">No tactical matches found.</div>';
            dropdown.style.display = 'block';
            return;
        }

        let html = '';
        matches.slice(0, 8).forEach((item, idx) => {
            html += `<div class="search-result-item" onclick="window.selectSearchResult(${idx})" data-match-idx="${idx}">${item.label}</div>`;
        });
        dropdown.innerHTML = html;
        dropdown.style.display = 'block';
        window._currentSearchMatches = matches;
    };

    window.selectSearchResult = function(idx) {
        let item = window._currentSearchMatches[idx];
        if (!item) return;
        document.getElementById('search-results-dropdown').style.display = 'none';
        document.getElementById('global-terminal-search').value = '';
        selectTargetAndPushRecent(item);
        window.lockCameraOnSelected();
    };

    /* Canvas Main Render Loop */
    function render() {
        const cssWidth = container.clientWidth;
        const cssHeight = container.clientHeight;

        ctx.fillStyle = '#010201'; 
        ctx.fillRect(0, 0, cssWidth, cssHeight);

        ctx.save(); 
        ctx.translate(cssWidth / 2 + camera.x, cssHeight / 2 + camera.y); 
        ctx.scale(camera.zoom, camera.zoom);

        const time = Date.now();
        const hw = cssWidth / (2 * camera.zoom); 
        const hh = cssHeight / (2 * camera.zoom);
        const cx = -camera.x / camera.zoom; 
        const cy = -camera.y / camera.zoom;

        let focusSystemId = null;
        if (selectedTarget) {
            if (selectedTarget.type === 'star') focusSystemId = selectedTarget.data.id;
            if (selectedTarget.type === 'body') focusSystemId = selectedTarget.data.parentSystem.id;
        }

        let macroOpacity = 1.0;
        if (camera.zoom > SYSTEM_ZOOM_THRESHOLD && focusSystemId) {
            macroOpacity = Math.max(0, 1.0 - (camera.zoom - SYSTEM_ZOOM_THRESHOLD) * 1.5);
        }

        if (macroOpacity > 0) {
            ctx.strokeStyle = `rgba(0, 229, 163, ${0.05 * macroOpacity})`; 
            ctx.lineWidth = 1 / camera.zoom;
            let gridSize = 1000;
            let startX = Math.floor((cx - hw) / gridSize) * gridSize; let endX = Math.ceil((cx + hw) / gridSize) * gridSize;
            let startY = Math.floor((cy - hh) / gridSize) * gridSize; let endY = Math.ceil((cy + hh) / gridSize) * gridSize;
            ctx.beginPath();
            for (let x = startX; x <= endX; x += gridSize) { ctx.moveTo(x, startY); ctx.lineTo(x, endY); }
            for (let y = startY; y <= endY; y += gridSize) { ctx.moveTo(startX, y); ctx.lineTo(endX, y); }
            ctx.stroke();
        }

        let allSystems = proceduralSystems.concat(dbStarSystems);

        // Hyperlane Trade Routes (Procedural)
        if (hyperlanesVisible && camera.zoom < 2.0) {
            ctx.strokeStyle = 'rgba(0, 229, 163, 0.12)';
            ctx.lineWidth = 1 / camera.zoom;
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

        // Draw Custom Hand-Drawn Hyperlanes
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
                ctx.lineWidth = 3 / camera.zoom;
                ctx.shadowColor = route.color || '#00e1ff';
                ctx.shadowBlur = 10;
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.restore();
            });
        }

        // Draw hyperlane actively being built
        if (hyperlaneDrawActive && activeHyperlaneNodes.length > 0) {
            ctx.save();
            ctx.strokeStyle = '#00e1ff';
            ctx.lineWidth = 3 / camera.zoom;
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
                ctx.arc(v.x, v.y, 4 / camera.zoom, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.restore();
        }

        // RENDER SAVED TERRITORIES
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
            ctx.lineWidth = 2 / camera.zoom;
            ctx.shadowColor = t.color;
            ctx.shadowBlur = 8;
            ctx.stroke();
            ctx.shadowBlur = 0;

            if (camera.zoom > 0.04) {
                let avgX = t.vertices.reduce((sum, v) => sum + v.x, 0) / t.vertices.length;
                let avgY = t.vertices.reduce((sum, v) => sum + v.y, 0) / t.vertices.length;
                ctx.fillStyle = t.color;
                ctx.font = `bold ${Math.max(10, 14 / camera.zoom)}px Courier New`;
                ctx.textAlign = 'center';
                ctx.fillText(`⬡ ${t.name.toUpperCase()}`, avgX, avgY);
                if (t.faction_name) {
                    ctx.font = `${Math.max(8, 10 / camera.zoom)}px Courier New`;
                    ctx.fillText(`[${t.faction_name}]`, avgX, avgY + (14 / camera.zoom));
                }
                ctx.textAlign = 'left';
            }
            ctx.restore();
        });

        // RENDER TERRITORY DRAWING IN-PROGRESS
        if (territoryDrawActive && activeTerritoryVertices.length > 0) {
            ctx.save();
            const drawColor = document.getElementById('territory-color-input')?.value || '#00e5a3';
            ctx.strokeStyle = drawColor;
            ctx.lineWidth = 2 / camera.zoom;
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
                ctx.arc(v.x, v.y, (idx === 0 ? 6 : 4) / camera.zoom, 0, Math.PI * 2);
                ctx.fill();
            });

            if (activeTerritoryVertices.length >= 3 && window._lastMouseWorldX !== undefined) {
                let distToStart = Math.hypot(window._lastMouseWorldX - activeTerritoryVertices[0].x, window._lastMouseWorldY - activeTerritoryVertices[0].y);
                if (distToStart < 30 / camera.zoom) {
                    let pulse = (12 + Math.sin(time * 0.012) * 5) / camera.zoom;
                    ctx.strokeStyle = '#ffaa00';
                    ctx.lineWidth = 2 / camera.zoom;
                    ctx.beginPath();
                    ctx.arc(activeTerritoryVertices[0].x, activeTerritoryVertices[0].y, pulse, 0, Math.PI * 2);
                    ctx.stroke();

                    ctx.fillStyle = '#ffaa00';
                    ctx.font = `${Math.max(9, 11 / camera.zoom)}px Courier New`;
                    ctx.fillText('CLICK TO CLOSE SHAPE', activeTerritoryVertices[0].x + (15 / camera.zoom), activeTerritoryVertices[0].y - (10 / camera.zoom));
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
                ctx.strokeStyle = `rgba(255, 100, 50, ${0.6 * sysOpacity})`; ctx.lineWidth = 2 / camera.zoom;
                ctx.beginPath(); ctx.ellipse(s.x, s.y, s.size * 1.8, s.size * 0.6, time * 0.001, 0, Math.PI * 2); ctx.stroke();
                ctx.fillStyle = '#000000'; ctx.shadowColor = `rgba(100, 50, 255, ${0.8 * sysOpacity})`; ctx.shadowBlur = 15;
                ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
            }
            else if (s.luminosity === 'Hidden Anomaly') {
                if (currentUserRole === 'dm') {
                    ctx.globalAlpha = sysOpacity * 0.5; // Ghosted for DM
                    ctx.strokeStyle = '#ff3333';
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 2, 0, Math.PI * 2); ctx.stroke();
                    ctx.setLineDash([]);
                    if (camera.zoom > 0.5) {
                        ctx.fillStyle = '#ff3333';
                        ctx.font = `${Math.max(8, 10 / camera.zoom)}px Courier New`;
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
                ctx.beginPath(); ctx.arc(s.x, s.y, s.size / (s.isCustom ? camera.zoom : 1), 0, Math.PI * 2); ctx.fill();
                ctx.shadowBlur = 0;
            }

            ctx.globalAlpha = 1.0;

            if (camera.zoom > 0.15 && camera.zoom <= SYSTEM_ZOOM_THRESHOLD && s.type !== 'Nebula') {
                ctx.fillStyle = s.isCustom ? `rgba(0, 229, 163, ${sysOpacity})` : `rgba(107, 130, 106, ${sysOpacity})`;
                ctx.font = `${Math.max(10, 12 / camera.zoom)}px Courier New`;
                ctx.fillText(s.name, s.x + 10, s.y + 4);
            }

            if (camera.zoom > SYSTEM_ZOOM_THRESHOLD && s.type !== 'Nebula' && (isFocused || (!focusSystemId && sysOpacity > 0))) {
                let deepZoomFade = Math.min(1.0, (camera.zoom - SYSTEM_ZOOM_THRESHOLD) / 1.0);
                
                if (!isFocused && focusSystemId) deepZoomFade = 0;
                else if (!isFocused) deepZoomFade *= sysOpacity;

                if (deepZoomFade > 0) {
                    for(let b of getSystemBodies(s)) {
                        let angle = b.baseAngle + (time * b.speed);
                        let bx = s.x + Math.cos(angle) * b.radius; let by = s.y + Math.sin(angle) * b.radius;
                        
                        ctx.beginPath(); ctx.arc(s.x, s.y, b.radius, 0, Math.PI*2);
                        ctx.strokeStyle = `rgba(0, 229, 163, ${deepZoomFade * (b.isStar ? 0.05 : 0.15)})`; 
                        ctx.lineWidth = 1/camera.zoom; ctx.stroke();
                        
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
        for (let m of shipMarkers) {
            if (Math.abs(m.x - cx) > hw + 50 || Math.abs(m.y - cy) > hh + 50) continue;
            const size = 10 / camera.zoom;
            ctx.fillStyle = m.color || '#00e1ff';
            ctx.beginPath(); ctx.moveTo(m.x, m.y - size); ctx.lineTo(m.x + size, m.y); ctx.lineTo(m.x, m.y + size); ctx.lineTo(m.x - size, m.y); ctx.closePath(); ctx.fill();
            if (camera.zoom > 0.1) { ctx.fillStyle = '#00e1ff'; ctx.font = `${Math.max(9, 11 / camera.zoom)}px Courier New`; ctx.fillText(m.name, m.x + 12, m.y + 3); }
        }

        // Jump Plotter Reticle & Vector
        if (jumpPlottingActive && activeJumpShip) {
            let targetX = jumpTargetPoint ? jumpTargetPoint.x : (window._lastMouseWorldX || activeJumpShip.x);
            let targetY = jumpTargetPoint ? jumpTargetPoint.y : (window._lastMouseWorldY || activeJumpShip.y);
            let labelName = jumpTargetPoint ? jumpTargetPoint.name : "Target Lock";

            ctx.save();
            ctx.strokeStyle = '#00e1ff';
            ctx.lineWidth = 2 / camera.zoom;
            ctx.setLineDash([8, 6]);

            ctx.beginPath();
            ctx.moveTo(activeJumpShip.x, activeJumpShip.y);
            ctx.lineTo(targetX, targetY);
            ctx.stroke();
            ctx.setLineDash([]);

            let reticleSize = 16 + Math.sin(time * 0.008) * 4;
            ctx.strokeStyle = '#00e1ff';
            ctx.beginPath();
            ctx.arc(targetX, targetY, reticleSize / camera.zoom, 0, Math.PI * 2);
            ctx.stroke();

            let dx = targetX - activeJumpShip.x;
            let dy = targetY - activeJumpShip.y;
            let dist = Math.sqrt(dx * dx + dy * dy);
            let tripHours = Math.max(1, Math.round(dist / selectedDriveSpeed));
            let ly = (dist / 100).toFixed(2);
            let days1c = (ly * 365.25).toFixed(1);

            ctx.fillStyle = '#00e1ff';
            ctx.font = `${Math.max(11, 13 / camera.zoom)}px Courier New`;
            ctx.fillText(`🚀 JUMP VECTOR: ${labelName} (${dist.toFixed(1)} u / ${ly} LY)`, targetX + 18, targetY - 6);
            ctx.fillStyle = '#00e5a3';
            ctx.fillText(`⏱️ FTL Trip: ~${tripHours} hrs | @1c: ~${days1c} days`, targetX + 18, targetY + 12);
            ctx.restore();
        }

        // Measuring Tape
        if (measuringTapeActive && measureStartPoint) {
            ctx.strokeStyle = '#00e5a3';
            ctx.lineWidth = 2 / camera.zoom;
            ctx.setLineDash([4, 4]);

            let endX = measureEndPoint ? measureEndPoint.x : (window._lastMouseWorldX || measureStartPoint.x);
            let endY = measureEndPoint ? measureEndPoint.y : (window._lastMouseWorldY || measureStartPoint.y);

            ctx.beginPath();
            ctx.moveTo(measureStartPoint.x, measureStartPoint.y);
            ctx.lineTo(endX, endY);
            ctx.stroke();
            ctx.setLineDash([]);

            let dx = endX - measureStartPoint.x;
            let dy = endY - measureStartPoint.y;
            let distanceUnits = Math.sqrt(dx * dx + dy * dy);
            
            let lightYears = (distanceUnits / 100).toFixed(2);
            let travelTimeAt1cDays = (lightYears * 365.25).toFixed(1);
            let estimatedFTLHours = (distanceUnits / 250).toFixed(1);

            ctx.fillStyle = '#00e5a3';
            ctx.font = `${Math.max(11, 13 / camera.zoom)}px Courier New`;
            ctx.fillText(`📏 DIST: ${distanceUnits.toFixed(1)} u (${lightYears} LY)`, endX + 15, endY - 6);
            ctx.fillStyle = '#00e1ff';
            ctx.fillText(`⏱️ Travel Time: @1c: ~${travelTimeAt1cDays} days | FTL: ~${estimatedFTLHours} hrs`, endX + 15, endY + 12);
        }

        // Tactical Broadcast Pings
        const now = Date.now();
        for (let i = activePings.length - 1; i >= 0; i--) {
            let p = activePings[i];
            let elapsed = now - p.startTime;
            if (elapsed > 4000) { activePings.splice(i, 1); continue; }
            let alpha = 1.0 - (elapsed / 4000);
            let pulseRadius = (elapsed / 20) % 60 + 10;
            
            ctx.save();
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 2 / camera.zoom;
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(p.x, p.y, pulseRadius / camera.zoom, 0, Math.PI * 2);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(p.x, p.y, (pulseRadius * 0.5) / camera.zoom, 0, Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = p.color;
            ctx.font = `${Math.max(10, 12 / camera.zoom)}px Courier New`;
            ctx.fillText(`📍 PING: ${p.user}`, p.x + 15 / camera.zoom, p.y - 10 / camera.zoom);
            ctx.restore();
        }

        // Target Selection Reticle
        if (selectedTarget && selectedTarget.data) {
            let obj = selectedTarget.data;
            let ox = obj.x, oy = obj.y;
            if (selectedTarget.type === 'body') {
                let angle = obj.baseAngle + (time * obj.speed);
                ox = obj.parentSystem.x + Math.cos(angle) * obj.radius;
                oy = obj.parentSystem.y + Math.sin(angle) * obj.radius;
            }
            let pulseSize = 14 + Math.sin(time * 0.006) * 4;
            ctx.strokeStyle = '#00e5a3';
            ctx.lineWidth = 2 / camera.zoom;
            ctx.beginPath();
            ctx.arc(ox, oy, pulseSize / camera.zoom, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.restore(); requestAnimationFrame(render);
    }

    render();
}

/* ==========================================================================
   8. INITIALIZATION & FILE PROCESSORS
   ========================================================================== */
function initFileHandlers() {
    // 1. Avatar Upload
    const avatarDropzone = document.getElementById('avatar-dropzone');
    const avatarInput = document.getElementById('avatar-file-input');
    const avatarPreview = document.getElementById('my-terminal-avatar-preview');
    const hiddenAvatarInput = document.getElementById('term-avatar');

    if (avatarDropzone && avatarInput) {
        avatarDropzone.addEventListener('click', () => avatarInput.click());
        avatarDropzone.addEventListener('dragover', (e) => { e.preventDefault(); avatarDropzone.style.borderColor = '#00e5a3'; });
        avatarDropzone.addEventListener('dragleave', () => { avatarDropzone.style.borderColor = '#3c4e36'; });
        avatarDropzone.addEventListener('drop', (e) => {
            e.preventDefault(); avatarDropzone.style.borderColor = '#3c4e36';
            if (e.dataTransfer.files && e.dataTransfer.files[0]) processAvatarFile(e.dataTransfer.files[0]);
        });
        avatarInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) processAvatarFile(e.target.files[0]);
        });
    }

    function processAvatarFile(file) {
        if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
        const reader = new FileReader();
        reader.onload = function (event) {
            const img = new Image();
            img.onload = function () {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const maxDim = 256;
                let width = img.width; let height = img.height;
                if (width > height) { if (width > maxDim) { height *= maxDim / width; width = maxDim; } }
                else { if (height > maxDim) { width *= maxDim / height; height = maxDim; } }
                canvas.width = width; canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);
                const compressedBase64 = canvas.toDataURL('image/jpeg', 0.85);
                avatarPreview.src = compressedBase64;
                hiddenAvatarInput.value = compressedBase64;
                document.getElementById('dropzone-label').innerText = '✓ Image Loaded: ' + file.name;
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    }

    // 2. Codex Document Attachment Uploader
    const codexDropzone = document.getElementById('codex-file-dropzone');
    const codexFileInput = document.getElementById('codex-file-input');

    if (codexDropzone && codexFileInput) {
        codexDropzone.addEventListener('click', () => codexFileInput.click());
        codexDropzone.addEventListener('dragover', (e) => { e.preventDefault(); codexDropzone.style.borderColor = '#00e5a3'; });
        codexDropzone.addEventListener('dragleave', () => { codexDropzone.style.borderColor = '#ff6b6b'; });
        codexDropzone.addEventListener('drop', (e) => {
            e.preventDefault(); codexDropzone.style.borderColor = '#ff6b6b';
            if (e.dataTransfer.files && e.dataTransfer.files[0]) processCodexDoc(e.dataTransfer.files[0]);
        });
        codexFileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) processCodexDoc(e.target.files[0]);
        });
    }

    function processCodexDoc(file) {
        const isImage = file.type.startsWith('image/');
        const isPDF = file.type === 'application/pdf';
        const docNameInput = document.getElementById('new-codex-doc-name');
        const docDataInput = document.getElementById('new-codex-doc-data');
        const docTypeInput = document.getElementById('new-codex-doc-type');
        const label = document.getElementById('codex-file-label');
        const currentDocWrapper = document.getElementById('codex-current-doc-wrapper');
        const currentDocName = document.getElementById('codex-current-doc-name');

        docNameInput.value = file.name;

        if (isImage || isPDF) {
            docTypeInput.value = isImage ? 'image' : 'pdf';
            const reader = new FileReader();
            reader.onload = (e) => {
                docDataInput.value = e.target.result;
                label.innerText = `✓ Loaded ${docTypeInput.value.toUpperCase()}: ${file.name}`;
                currentDocWrapper.style.display = 'block';
                currentDocName.innerText = `📎 ${file.name} (${docTypeInput.value.toUpperCase()})`;
            };
            reader.readAsDataURL(file);
        } else {
            docTypeInput.value = 'text';
            const reader = new FileReader();
            reader.onload = (e) => {
                docDataInput.value = e.target.result;
                label.innerText = `✓ Loaded Document: ${file.name}`;
                currentDocWrapper.style.display = 'block';
                currentDocName.innerText = `📎 ${file.name} (TEXT/MD)`;
            };
            reader.readAsText(file);
        }
    }
}

document.addEventListener('DOMContentLoaded', initFileHandlers);
