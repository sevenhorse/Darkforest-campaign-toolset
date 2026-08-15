/* ==========================================================================
   js/ui.js - Interface, Layout, Time & Menus
   ========================================================================== */

/* --- CALENDAR & TIME ENGINE --- */
window.universeTimeHours = parseInt(localStorage.getItem('odyssey_universe_time') || '24192000'); 
window.timeFlowActive = false;
window.timeFlowInterval = null;

window.formatUniverseTime = function(totalHours) {
    const hoursInDay = 24; const daysInMonth = 30; const monthsInYear = 12;
    const hoursInMonth = hoursInDay * daysInMonth; const hoursInYear = hoursInMonth * monthsInYear;

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
};

window.updateCalendarDisplay = function() {
    const timeStr = window.formatUniverseTime(window.universeTimeHours);
    const clockTicker = document.getElementById('clock-ticker-text');
    const modalClock = document.getElementById('modal-clock-display');
    if (clockTicker) clockTicker.innerText = timeStr;
    if (modalClock) modalClock.innerText = timeStr;
};

window.initCalendarEngine = function() {
    window.updateCalendarDisplay();
    window.timeFlowInterval = setInterval(() => {
        if (window.timeFlowActive) { 
            window.universeTimeHours += 1; 
            window.updateCalendarDisplay(); 
        }
    }, 4000);
};

window.toggleCalendarControls = function() {
    const panel = document.getElementById('calendar-control-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    window.updateCalendarDisplay();
};

window.adjustTime = function(amount, unit) {
    if (currentUserRole !== 'dm') return;
    let multiplier = 1;
    if (unit === 'hours') multiplier = 1;
    if (unit === 'days') multiplier = 24;
    if (unit === 'months') multiplier = 24 * 30;
    if (unit === 'years') multiplier = 24 * 30 * 12;

    window.universeTimeHours += amount * multiplier;
    if (window.universeTimeHours < 0) window.universeTimeHours = 0;
    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay();
    window.broadcastTimeSync();
};

window.applyManualTime = function() {
    if (currentUserRole !== 'dm') return;
    const yr = parseInt(document.getElementById('set-yr').value);
    const mo = parseInt(document.getElementById('set-mo').value) || 1;
    const da = parseInt(document.getElementById('set-da').value) || 1;
    const hr = parseInt(document.getElementById('set-hr').value) || 0;

    if (isNaN(yr)) { alert("Please enter a valid year."); return; }

    const hoursInDay = 24; const daysInMonth = 30; const monthsInYear = 12;
    const hoursInMonth = hoursInDay * daysInMonth; const hoursInYear = hoursInMonth * monthsInYear;

    window.universeTimeHours = (yr * hoursInYear) + ((mo - 1) * hoursInMonth) + ((da - 1) * hoursInDay) + hr;
    if (window.universeTimeHours < 0) window.universeTimeHours = 0;

    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay();
    window.broadcastTimeSync();
    alert("Chronology manually updated.");
};

window.resetTimeline = function() {
    if (currentUserRole !== 'dm') return;
    if (!confirm("Reset timeline back to YR 2800.01.01?")) return;
    window.universeTimeHours = 24192000;
    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay();
    window.broadcastTimeSync();
};

window.toggleTimeFlow = function() {
    if (currentUserRole !== 'dm') return;
    window.timeFlowActive = !window.timeFlowActive;
    const btn = document.getElementById('time-flow-btn');
    if (btn) {
        btn.innerText = window.timeFlowActive ? '⏸ PAUSE FLOW' : '▶ RESUME FLOW';
        btn.style.borderColor = window.timeFlowActive ? '#3c4e36' : '#00e5a3';
    }
};

window.broadcastTimeSync = function() {
    db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `⏳ [TIMELINE ADJUSTED] Overseer shifted chronology to: ${window.formatUniverseTime(window.universeTimeHours)}`,
        message_type: 'text'
    });
};

/* --- UI DRAGGING & HUD PANELS --- */
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
        startX = e.clientX; startY = e.clientY;
        initialLeft = panel.offsetLeft; initialTop = panel.offsetTop;
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
        panel.style.left = `${initialLeft}px`; panel.style.top = `${initialTop}px`;
        
        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const dx = moveEvent.clientX - startX; const dy = moveEvent.clientY - startY;
            let newLeft = Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, initialLeft + dx));
            let newTop = Math.max(60, Math.min(window.innerHeight - panel.offsetHeight - 10, initialTop + dy));
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
    Object.keys(localStorage).forEach(k => { if (k.startsWith('odyssey_')) localStorage.removeItem(k); });
    location.reload();
};

/* --- SKILLS & TERMINAL TOGGLES --- */
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
        if (typeof populateCargoVesselSelect === 'function') populateCargoVesselSelect();
        if (typeof renderTerminalCargoDeck === 'function') renderTerminalCargoDeck();
    } else if (tabName === 'vessel') {
        if (typeof populateVesselDeckSelect === 'function') populateVesselDeckSelect();
        if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
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
    if (term.style.display === 'block') { 
        if (typeof loadAllProfiles === 'function') loadAllProfiles(); 
        if (typeof loadCampaignObjectives === 'function') loadCampaignObjectives(); 
        if (typeof loadPlayerNotes === 'function') loadPlayerNotes(); 
        if (typeof loadCodexEntries === 'function') loadCodexEntries(); 
    }
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

window.openFullVesselTerminal = function(vesselId) {
    const term = document.getElementById('character-terminal');
    term.style.display = 'block';
    window.switchTermTab('vessel');
    if (vesselId) {
        const select = document.getElementById('vessel-deck-select');
        if (select) { 
            select.value = vesselId; 
            if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck(); 
        }
    }
};

window.toggleCombatTracker = function() {
    const panel = document.getElementById('combat-tracker-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
};

window.toggleCommsArray = function() {
    const panel = document.getElementById('comms-array-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    if (panel.style.display === 'block') { 
        if (typeof window.populateCommsRecipients === 'function') window.populateCommsRecipients(); 
        if (typeof loadChatLogs === 'function') loadChatLogs(); 
    }
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

/* --- CHARACTER DATA & DOSSIER --- */
window.renderCharacterTerminalData = function() {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    
    const c = myProf.character || {};
    const s = myProf.skills || {};
    
    const setVal = (id, val) => { const el = document.getElementById(id); if(el) el.value = val; };

    setVal('term-sheet-name', c.name || '');
    setVal('stat-charisma', c.stat_charisma || 'd4');
    setVal('stat-dexterity', c.stat_dexterity || 'd4');
    setVal('stat-intelligence', c.stat_intelligence || 'd4');
    setVal('stat-strength', c.stat_strength || 'd4');
    setVal('stat-toughness', c.stat_toughness || 'd4');
    setVal('stat-willpower', c.stat_willpower || 'd4');
    
    setVal('term-vitality', c.vitality || 0);
    setVal('term-stress', c.stress || 0);
    setVal('term-adversity', c.adversity_tokens || 0);
    
    setVal('term-specialties', c.specialties || '');
    setVal('term-assets', c.assets || '');
    setVal('term-history', c.history || '');
    
    setVal('aug-head', c.aug_head || '');
    setVal('aug-torso', c.aug_torso || '');
    setVal('aug-larm', c.aug_larm || '');
    setVal('aug-rarm', c.aug_rarm || '');
    setVal('aug-lleg', c.aug_lleg || '');
    setVal('aug-rleg', c.aug_rleg || '');
    
    skillList.forEach(skill => {
        const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_');
        setVal(`skill-${safeKey}`, s[safeKey] || 0);
    });

    if (typeof window.renderArsenal === 'function') window.renderArsenal();
    
    const badgeCombat = document.getElementById('badge-combat');
    if (badgeCombat) badgeCombat.innerText = (myProf.arsenal || []).length;
};

window.saveTerminalProfile = async function() {
    const safeGet = (id) => document.getElementById(id) ? document.getElementById(id).value : '';
    await db.from('profiles').update({ username: safeGet('term-username'), avatar_url: safeGet('term-avatar') }).eq('id', currentUserId);

    if (presenceChannel) {
        await presenceChannel.track({ 
            online_at: new Date().toISOString(), 
            username: safeGet('term-username') || currentUserEmail.split('@')[0], 
            role: currentUserRole, 
            avatar_url: safeGet('term-avatar') || '' 
        });
    }

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
    if (typeof loadAllProfiles === 'function') loadAllProfiles();
};

/* --- CODEX & LOG UI --- */
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

    if (typeof window.renderCodexMatrix === 'function') window.renderCodexMatrix();
};

window.filterCodexEntries = function(val) {
    codexSearchFilter = (val || '').toLowerCase().trim();
    if (typeof window.renderCodexMatrix === 'function') window.renderCodexMatrix();
};

window.renderCodexMatrix = function() {
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
};

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
            if (typeof loadCodexEntries === 'function') loadCodexEntries();
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
            if (typeof loadCodexEntries === 'function') loadCodexEntries();
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
    if (typeof loadCodexEntries === 'function') loadCodexEntries();
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

window.addCampaignObjective = async function() {
    const title = document.getElementById('new-obj-title').value;
    const description = document.getElementById('new-obj-desc').value;
    if (!title) return;
    await db.from('campaign_objectives').insert({ title, description, completed: false });
    document.getElementById('new-obj-title').value = ''; document.getElementById('new-obj-desc').value = '';
    if (typeof loadCampaignObjectives === 'function') loadCampaignObjectives();
};

window.toggleObjectiveComplete = async function(id, currentStatus) {
    await db.from('campaign_objectives').update({ completed: !currentStatus }).eq('id', id); 
    if (typeof loadCampaignObjectives === 'function') loadCampaignObjectives();
};

window.deleteCampaignObjective = async function(id) {
    if (!confirm("Delete objective?")) return;
    await db.from('campaign_objectives').delete().eq('id', id); 
    if (typeof loadCampaignObjectives === 'function') loadCampaignObjectives();
};

window.renderCampaignObjectives = function() {
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
};

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
    if (typeof loadPlayerNotes === 'function') loadPlayerNotes();
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
    if (typeof loadPlayerNotes === 'function') loadPlayerNotes();
};

window.renderTerminalNotes = function() {
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
};

window.sendChatMessage = async function() {
    const input = document.getElementById('comms-message-input');
    const content = input.value.trim();
    if (!content) return;
    const recipientId = document.getElementById('comms-recipient').value;
    await db.from('chat_logs').insert({ sender_id: currentUserId, content: content, message_type: 'text', recipient_id: recipientId === 'global' ? null : recipientId });
    input.value = '';
    if (typeof loadChatLogs === 'function') loadChatLogs();
};

window.broadcastRoll = async function(title, breakdownText, totalSum) {
    await db.from('chat_logs').insert({ sender_id: currentUserId, content: `Rolled ${title}: ${totalSum}`, message_type: 'roll', recipient_id: null, roll_data: { breakdown: breakdownText } });
    if (typeof loadChatLogs === 'function') loadChatLogs();
};

window.renderChatFeed = function() {
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
};

window.populateCommsRecipients = function() {
    const select = document.getElementById('comms-recipient');
    if (!select) return;
    let currentVal = select.value;
    let html = '<option value="global">🌐 Global Broadcast</option>';
    allProfiles.forEach(p => {
        if (p.id !== currentUserId) { html += `<option value="${p.id}">🔒 DM: ${p.username || 'Commander'}</option>`; }
    });
    select.innerHTML = html;
    if (select.querySelector(`option[value="${currentVal}"]`)) select.value = currentVal;
};

/* --- FILE UPLOAD ENGINE --- */
function initFileHandlers() {
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
