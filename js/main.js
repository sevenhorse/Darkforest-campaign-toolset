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

    // Self-healing LocalStorage parsing to prevent canvas lockups
    let bookmarkedTargets = [];
    try { 
        bookmarkedTargets = JSON.parse(localStorage.getItem('odyssey_bookmarks') || '[]'); 
        if(!Array.isArray(bookmarkedTargets)) bookmarkedTargets = [];
    } catch(e) { bookmarkedTargets = []; }

    let recentTargets = [];
    try { 
        recentTargets = JSON.parse(localStorage.getItem('odyssey_recents') || '[]'); 
        if(!Array.isArray(recentTargets)) recentTargets = [];
    } catch(e) { recentTargets = []; }

    let activeHudTab = 'telemetry';
    let globalProceduralSystemsCache = [];
    let globalShipMarkersCache = [];
    let globalDbSystemsCache = [];

    let activeCargoSubtab = 'perishables';
    let activeCodexSubtab = 'factions';
    let hyperlanesVisible = true; 

    let dmCodexData = JSON.parse(localStorage.getItem('odyssey_dm_codex') || JSON.stringify({
        factions: [
            { name: "Task Force Black", status: "Allied / Player Faction", notes: "Autonomous deep-space exploration and containment fleet." },
            { name: "The Syndicate", status: "Hostile / Smugglers", notes: "Operating in outer rim sectors. Controlling illicit black-market trade hubs." }
        ],
        lore: [
            { title: "The Dark Forest Anomaly", desc: "Unexplained subspace static emanating from Sector 1042. Communications drop instantly upon entry." },
            { title: "Project Odyssey-1000", desc: "Initiative to map 1,000 star systems and establish secure relays across uncharted space." }
        ],
        npcs: [
            { name: "Commander Vane", affiliation: "Task Force Black", location: "Flagship", notes: "Primary mission commander." },
            { name: "Broker Xylar", affiliation: "Independent Smuggler", location: "Sector 1012 Outpost", notes: "Knows rumors regarding ancient artifacts." }
        ]
    }));

    /* ==========================================================================
       1.5 WEB AUDIO API UI BEEPS
       ========================================================================== */
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    function playUIBeep() {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime); // High pitch start
        osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.1); // Quick drop
        gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime); // Low volume
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.1);
    }

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
        
        const codexNavBtn = document.getElementById('term-tab-btn-codex');
        const scratchpadBtn = document.getElementById('dm-scratchpad-toggle-btn');
        
        if (data.role === 'dm') {
            badge.classList.add('role-dm');
            badge.innerText = 'OVERSEER (DM)';
            document.getElementById('dm-tools').style.display = 'block';
            document.getElementById('dm-time-controls-box').style.display = 'block';
            if (codexNavBtn) codexNavBtn.style.display = 'flex';
            if (scratchpadBtn) scratchpadBtn.style.display = 'inline-block';
            
            // Load saved DM scratchpad
            const savedScratch = localStorage.getItem('odyssey_dm_scratchpad');
            if (savedScratch && document.getElementById('dm-scratchpad-input')) {
                document.getElementById('dm-scratchpad-input').value = savedScratch;
            }
        } else {
            if (codexNavBtn) codexNavBtn.style.display = 'none';
            if (scratchpadBtn) scratchpadBtn.style.display = 'none';
        }

        initPresenceChannel(data);
        initGalaxyEngine();
        initCalendarEngine();
        loadAllProfiles();
        loadPlayerNotes();
        loadCombatTracker();
        loadCampaignObjectives();
        loadChatLogs();
    }

    function updateTerminalBadges() {
        const bNotes = document.getElementById('badge-notes');
        const bCombat = document.getElementById('badge-combat');
        const bRoster = document.getElementById('badge-roster');
        
        if (bNotes) bNotes.innerText = (playerNotesList.length + campaignObjectivesList.filter(o => !o.completed).length) || '0';
        if (bCombat) bCombat.innerText = combatantsList.length || '0';
        if (bRoster) bRoster.innerText = allProfiles.length || '0';
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
            updateTerminalBadges();
        }
    }

    async function loadPlayerNotes() {
        const { data } = await db.from('player_notes').select('*').order('created_at', { ascending: false });
        if (data) { playerNotesList = data; renderTerminalNotes(); updateTerminalBadges(); }
    }

    async function loadCombatTracker() {
        const { data } = await db.from('combat_tracker').select('*').order('initiative', { ascending: false });
        if (data) { combatantsList = data; renderCombatTracker(); updateTerminalBadges(); }
    }

    async function loadCampaignObjectives() {
        const { data } = await db.from('campaign_objectives').select('*').order('created_at', { ascending: false });
        if (data) { campaignObjectivesList = data; renderCampaignObjectives(); updateTerminalBadges(); }
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
       5. TERMINAL & UI CONTROLLERS
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

    window.toggleSidebar = function() {
        const sidebar = document.getElementById('term-sidebar');
        const icon = document.getElementById('sidebar-toggle-icon');
        sidebar.classList.toggle('collapsed');
        if (sidebar.classList.contains('collapsed')) {
            icon.innerText = '▶';
        } else {
            icon.innerText = '◀ COLLAPSE SIDEBAR';
        }
        playUIBeep();
    };

    window.switchTermTab = function(tabName) {
        playUIBeep();
        document.querySelectorAll('.term-tab-btn-vert').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.term-panel-content').forEach(p => p.classList.remove('active'));
        document.getElementById(`term-tab-btn-${tabName}`).classList.add('active');
        document.getElementById(`term-panel-${tabName}`).classList.add('active');
        if (tabName === 'cargo') {
            populateCargoVesselSelect();
            renderTerminalCargoDeck();
        } else if (tabName === 'codex') {
            renderCodexDeck();
        }
    };

    window.toggleCharacterTerminal = function() {
        const term = document.getElementById('character-terminal');
        term.style.display = term.style.display === 'block' ? 'none' : 'block';
        if (term.style.display === 'block') { loadAllProfiles(); loadCampaignObjectives(); loadPlayerNotes(); }
    };

    window.openFullCargoTerminal = function() {
        const term = document.getElementById('character-terminal');
        term.style.display = 'block';
        window.switchTermTab('cargo');
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

    function makePanelDraggable(panelId, handleId, storageKey) {
        const panel = document.getElementById(panelId);
        const handle = document.getElementById(handleId);
        if (!panel || !handle) return;
        
        try {
            const savedPos = localStorage.getItem(storageKey);
            if (savedPos) {
                const { left, top } = JSON.parse(savedPos);
                panel.style.left = left; panel.style.top = top; panel.style.right = 'auto';
            }
        } catch(e) { console.warn("Failed to load panel state for", panelId); }

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
                if (isDragging) { 
                    isDragging = false; 
                    try { localStorage.setItem(storageKey, JSON.stringify({ left: panel.style.left, top: panel.style.top })); } catch(e){}
                }
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
        if(document.getElementById('my-terminal-avatar-preview')) document.getElementById('my-terminal-avatar-preview').src = myProfile.avatar_url || 'https://via.placeholder.com/60';
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
                        <img src="${p.avatar_url || 'https://via.placeholder.com/60'}" class="avatar-img" onerror="this.src='https://via.placeholder.com/60'">
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

    /* Overseer Codex (Viewable by All, Editable by DM) */
    window.switchCodexSubtab = function(subtab) {
        activeCodexSubtab = subtab;
        document.querySelectorAll('.codex-subtab-btn').forEach(b => b.classList.remove('active'));
        document.getElementById(`codex-subtab-${subtab}`).classList.add('active');
        renderCodexDeck();
    };

    function renderCodexDeck() {
        const container = document.getElementById('codex-content-container');
        if (!container) return;

        let isDM = (currentUserRole === 'dm');
        let html = '';

        if (activeCodexSubtab === 'factions') {
            html += `<h4 style="color:#ff6b6b; border-bottom:1px solid #3c4e36; padding-bottom:4px;">Registered Factions & Powers</h4>`;
            dmCodexData.factions.forEach((f, idx) => {
                html += `
                    <div class="note-card" style="border-color:${isDM ? '#ff3333' : '#3c4e36'};">
                        <div style="display:flex; justify-content:space-between;">
                            <strong style="color:#ff6b6b;">${f.name}</strong>
                            <span style="font-size:10px; color:#00e5a3;">Status: ${f.status}</span>
                        </div>
                        <p style="margin:4px 0; font-size:11px; color:#d4c5a9;">${f.notes}</p>
                        ${isDM ? `<button class="layer-del" onclick="window.deleteCodexEntry('factions', ${idx})" style="font-size:9px; padding:2px 6px;">Delete</button>` : ''}
                    </div>
                `;
            });
            if (isDM) {
                html += `
                    <div style="background:#040605; padding:8px; border:1px solid #ff3333; margin-top:10px;">
                        <input type="text" id="new-fac-name" placeholder="Faction Name..." style="font-size:10px; margin:2px 0;">
                        <input type="text" id="new-fac-status" placeholder="Status / Hostility..." style="font-size:10px; margin:2px 0;">
                        <textarea id="new-fac-notes" rows="2" placeholder="Faction notes..." style="font-size:10px; margin:2px 0;"></textarea>
                        <button class="btn-remove" onclick="window.addCodexEntry('factions')" style="font-size:10px; margin-top:4px;">+ ADD FACTION</button>
                    </div>
                `;
            }
        } else if (activeCodexSubtab === 'lore') {
            html += `<h4 style="color:#ff6b6b; border-bottom:1px solid #3c4e36; padding-bottom:4px;">Sector Lore & Secrets</h4>`;
            dmCodexData.lore.forEach((l, idx) => {
                html += `
                    <div class="note-card" style="border-color:${isDM ? '#ff3333' : '#3c4e36'};">
                        <strong style="color:#ff6b6b; font-size:12px;">${l.title}</strong>
                        <p style="margin:4px 0; font-size:11px; color:#d4c5a9; white-space:pre-wrap;">${l.desc}</p>
                        ${isDM ? `<button class="layer-del" onclick="window.deleteCodexEntry('lore', ${idx})" style="font-size:9px; padding:2px 6px;">Delete</button>` : ''}
                    </div>
                `;
            });
            if (isDM) {
                html += `
                    <div style="background:#040605; padding:8px; border:1px solid #ff3333; margin-top:10px;">
                        <input type="text" id="new-lore-title" placeholder="Lore Title..." style="font-size:10px; margin:2px 0;">
                        <textarea id="new-lore-desc" rows="2" placeholder="Secret lore details..." style="font-size:10px; margin:2px 0;"></textarea>
                        <button class="btn-remove" onclick="window.addCodexEntry('lore')" style="font-size:10px; margin-top:4px;">+ ADD LORE ENTRY</button>
                    </div>
                `;
            }
        } else if (activeCodexSubtab === 'npcs') {
            html += `<h4 style="color:#ff6b6b; border-bottom:1px solid #3c4e36; padding-bottom:4px;">Key NPCs & Contacts</h4>`;
            dmCodexData.npcs.forEach((n, idx) => {
                html += `
                    <div class="note-card" style="border-color:${isDM ? '#ff3333' : '#3c4e36'};">
                        <div style="display:flex; justify-content:space-between;">
                            <strong style="color:#ff6b6b;">${n.name}</strong>
                            <span style="font-size:10px; color:#00e1ff;">Loc: ${n.location}</span>
                        </div>
                        <p style="margin:2px 0; font-size:10px; color:#6b826a;">Affiliation: ${n.affiliation}</p>
                        <p style="margin:4px 0; font-size:11px; color:#d4c5a9;">${n.notes}</p>
                        ${isDM ? `<button class="layer-del" onclick="window.deleteCodexEntry('npcs', ${idx})" style="font-size:9px; padding:2px 6px;">Delete</button>` : ''}
                    </div>
                `;
            });
            if (isDM) {
                html += `
                    <div style="background:#040605; padding:8px; border:1px solid #ff3333; margin-top:10px;">
                        <div style="display:flex; gap:6px;">
                            <input type="text" id="new-npc-name" placeholder="NPC Name..." style="font-size:10px; margin:2px 0; flex:1;">
                            <input type="text" id="new-npc-loc" placeholder="Location..." style="font-size:10px; margin:2px 0; flex:1;">
                        </div>
                        <input type="text" id="new-npc-aff" placeholder="Affiliation..." style="font-size:10px; margin:2px 0;">
                        <textarea id="new-npc-notes" rows="2" placeholder="Notes..." style="font-size:10px; margin:2px 0;"></textarea>
                        <button class="btn-remove" onclick="window.addCodexEntry('npcs')" style="font-size:10px; margin-top:4px;">+ ADD NPC</button>
                    </div>
                `;
            }
        }
        container.innerHTML = html;
    }

    window.addCodexEntry = function(category) {
        if (currentUserRole !== 'dm') return;
        if (category === 'factions') {
            let name = document.getElementById('new-fac-name').value;
            let status = document.getElementById('new-fac-status').value;
            let notes = document.getElementById('new-fac-notes').value;
            if (!name) return;
            dmCodexData.factions.push({ name, status, notes });
        } else if (category === 'lore') {
            let title = document.getElementById('new-lore-title').value;
            let desc = document.getElementById('new-lore-desc').value;
            if (!title) return;
            dmCodexData.lore.push({ title, desc });
        } else if (category === 'npcs') {
            let name = document.getElementById('new-npc-name').value;
            let location = document.getElementById('new-npc-loc').value;
            let affiliation = document.getElementById('new-npc-aff').value;
            let notes = document.getElementById('new-npc-notes').value;
            if (!name) return;
            dmCodexData.npcs.push({ name, location, affiliation, notes });
        }
        localStorage.setItem('odyssey_dm_codex', JSON.stringify(dmCodexData));
        renderCodexDeck();
    };

    window.deleteCodexEntry = function(category, idx) {
        if (currentUserRole !== 'dm') return;
        if (!confirm("Delete this codex entry?")) return;
        dmCodexData[category].splice(idx, 1);
        localStorage.setItem('odyssey_dm_codex', JSON.stringify(dmCodexData));
        renderCodexDeck();
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
        if (!confirm("Wipe all custom stars and ships?")) return;
        try {
            const { error: e1 } = await db.from('star_systems').delete().neq('id', '00000000-0000-0000-0000-000000000000');
            const { error: e2 } = await db.from('ship_markers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
            if (e1 || e2) {
                alert("Wipe failed: " + (e1?.message || e2?.message));
            } else {
                window.clearSelectedTarget();
                loadGalaxyData();
                alert("Galaxy slate wiped successfully.");
            }
        } catch (e) {
            console.error("Wipe failed", e);
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
       6. PROCEDURAL GENERATION & GALAXY MAP ENGINE
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
        if(!system || system.type === 'Nebula') return []; 
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

        // High-DPI / Retina Display Scaling
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
                globalShipMarkersCache = shipMarkers;
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

        window.clearSelectedTarget = function() {
            selectedTarget = null;
            jumpPlottingActive = false;
            activeJumpShip = null;
            jumpTargetPoint = null;
            renderHUDTelemetry();
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

        /* Unified Input Core Handler for Map Interaction */
        function handleCanvasPointerDown(e) {
            if (e.target && e.target.closest && e.target.closest('.panel')) return; 
            if (e.button !== undefined && e.button !== 0) return;

            const worldPos = screenToWorld(e.clientX, e.clientY);
            
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

        /* Mouse Event Listeners */
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
                db.from('chat_logs').insert({ sender_id: currentUserId, content: `🚀 [NAVIGATION] Fleet token '${draggedMarker.name}' repositioned to X: ${Math.round(draggedMarker.x)}, Y: ${Math.round(draggedMarker.y)}.`, message_type: 'text' });
                draggedMarker = null; 
            }
            if (draggedStar) { await db.from('star_systems').update({ x: draggedStar.x, y: draggedStar.y }).eq('id', draggedStar.id); draggedStar = null; }
            camera.isDragging = false;
        });

        /* Touch Event Listeners (Mobile / Tablet) */
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
                if (measuringTapeActive) window.toggleMeasuringTool();
                else if (pingModeActive) window.togglePingMode();
                else if (jumpPlottingActive) window.cancelJumpPlotting();
                else window.clearSelectedTarget();
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
            try { localStorage.setItem('odyssey_bookmarks', JSON.stringify(bookmarkedTargets)); } catch(e){}
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
            if (!b || !b.data) return;
            selectedTarget = b;
            window.lockCameraOnSelected();
            renderHUDTelemetry();
        };

        window.jumpToRecent = function(index) {
            let r = recentTargets[index];
            if (!r || !r.data) return;
            selectedTarget = r;
            window.lockCameraOnSelected();
            renderHUDTelemetry();
        };

        window.switchHudTab = function(tab) {
            playUIBeep();
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
            if (currentUserRole !== 'dm' || !selectedTarget || selectedTarget.type !== 'body' || !selectedTarget.data) return;
            let b = selectedTarget.data;
            
            b.name = document.getElementById('edit-body-name').value;
            b.type = document.getElementById('edit-body-type').value;
            b.gravity = document.getElementById('edit-body-gravity').value;
            b.atmosphere = document.getElementById('edit-body-atmosphere').value;
            b.resources = document.getElementById('edit-body-resources').value;

            renderHUDTelemetry();
            alert("Celestial body properties synchronized to tactical display.");
        };

        /* Add to recents helper - with safety checks */
        function selectTargetAndPushRecent(target) {
            if (!target || !target.data) return;
            selectedTarget = target;
            let existsIndex = recentTargets.findIndex(r => r.data && r.data.id === target.data.id);
            if (existsIndex >= 0) recentTargets.splice(existsIndex, 1);
            recentTargets.unshift(target);
            if (recentTargets.length > 20) recentTargets.pop();
            try { localStorage.setItem('odyssey_recents', JSON.stringify(recentTargets)); } catch(e){}
            renderHUDTelemetry();
        }

        /* Tool toggles */
        window.toggleMeasuringTool = function() {
            measuringTapeActive = !measuringTapeActive;
            if(!measuringTapeActive) { measureStartPoint = null; measureEndPoint = null; }
            pingModeActive = false; jumpPlottingActive = false;
            window.updateToolButtonStyles();
        };

        window.togglePingMode = function() {
            pingModeActive = !pingModeActive;
            measuringTapeActive = false; jumpPlottingActive = false;
            window.updateToolButtonStyles();
        };

        window.updateToolButtonStyles = function() {
            const mBtn = document.getElementById('measuring-tape-toggle-btn');
            const pBtn = document.getElementById('ping-tool-toggle-btn');
            if(mBtn) { mBtn.style.borderColor = measuringTapeActive ? '#00e5a3' : '#3c4e36'; mBtn.style.color = measuringTapeActive ? '#00e5a3' : '#6b826a'; }
            if(pBtn) { pBtn.style.borderColor = pingModeActive ? '#00e5a3' : '#3c4e36'; pBtn.style.color = pingModeActive ? '#00e5a3' : '#6b826a'; }
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


        /* HUD Telemetry Renderer */
        function renderHUDTelemetry() {
            const content = document.getElementById('hud-content');
            
            // Self-healing state block for corrupt selection data
            if (selectedTarget && !selectedTarget.data) {
                selectedTarget = null;
            }

            if (activeHudTab === 'bookmarks') {
                let html = '<div style="font-size:11px;"><h4 style="margin:0 0 8px 0; color:#00e5a3;">Saved Bookmarks</h4>';
                if (!bookmarkedTargets || bookmarkedTargets.length === 0) {
                    html += '<span style="color:#6b826a; font-size:10px;">No saved bookmarks. Click bookmark on any target telemetry.</span>';
                } else {
                    bookmarkedTargets.forEach((b, idx) => {
                        if(!b.data) return;
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
                if (!recentTargets || recentTargets.length === 0) {
                    html += '<span style="color:#6b826a; font-size:10px;">No recent targets inspected.</span>';
                } else {
                    recentTargets.forEach((r, idx) => {
                        if(!r.data) return;
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

            if (!selectedTarget || !selectedTarget.data) { content.innerHTML = `<p style="margin: 0; font-size: 12px; color: #6b826a;">Hover or click a target...</p>`; return; }
            
            let isBookmarked = bookmarkedTargets.some(b => b.data && b.data.id === selectedTarget.data.id);
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
            if (selectedTarget && selectedTarget.data) {
                if (selectedTarget.type === 'star') focusSystemId = selectedTarget.data.id;
                if (selectedTarget.type === 'body' && selectedTarget.data.parentSystem) focusSystemId = selectedTarget.data.parentSystem.id;
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

            // Odyssey Feature Expansion: Render Hyperlane Trade Routes between nearby systems
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
                else if (s.type === 'Black Hole') {
                    ctx.strokeStyle = `rgba(255, 100, 50, ${0.6 * sysOpacity})`; ctx.lineWidth = 2 / camera.zoom;
                    ctx.beginPath(); ctx.ellipse(s.x, s.y, s.size * 1.8, s.size * 0.6, time * 0.001, 0, Math.PI * 2); ctx.stroke();
                    ctx.fillStyle = '#000000'; ctx.shadowColor = `rgba(100, 50, 255, ${0.8 * sysOpacity})`; ctx.shadowBlur = 15;
                    ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
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

            for (let m of shipMarkers) {
                if (Math.abs(m.x - cx) > hw + 50 || Math.abs(m.y - cy) > hh + 50) continue;
                const size = 10 / camera.zoom;
                ctx.fillStyle = m.color || '#00e1ff';
                ctx.beginPath(); ctx.moveTo(m.x, m.y - size); ctx.lineTo(m.x + size, m.y); ctx.lineTo(m.x, m.y + size); ctx.lineTo(m.x - size, m.y); ctx.closePath(); ctx.fill();
                if (camera.zoom > 0.1) { ctx.fillStyle = '#00e1ff'; ctx.font = `${Math.max(9, 11 / camera.zoom)}px Courier New`; ctx.fillText(m.name, m.x + 12, m.y + 3); }
            }

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

            if (selectedTarget && selectedTarget.data) {
                let obj = selectedTarget.data;
                let ox = obj.x, oy = obj.y;
                if (selectedTarget.type === 'body' && obj.parentSystem) {
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
       7. INITIALIZATION & UTILITIES
       ========================================================================== */
    function initAvatarUploadHandlers() {
        const dropzone = document.getElementById('avatar-dropzone');
        const fileInput = document.getElementById('avatar-file-input');
        const avatarPreview = document.getElementById('my-terminal-avatar-preview');
        const hiddenAvatarInput = document.getElementById('term-avatar');

        if (!dropzone || !fileInput) return;

        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = '#00e5a3'; });
        dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = '#3c4e36'; });
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = '#3c4e36';
            if (e.dataTransfer.files && e.dataTransfer.files[0]) { processImageFile(e.dataTransfer.files[0]); }
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) { processImageFile(e.target.files[0]); }
        });

        function processImageFile(file) {
            if (!file.type.startsWith('image/')) { alert('Please select a valid image file.'); return; }
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
    }

    document.addEventListener('DOMContentLoaded', initAvatarUploadHandlers);
