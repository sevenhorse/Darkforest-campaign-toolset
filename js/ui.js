/* ==========================================================================
   js/ui.js - Interface, Layout, Time & Menus
   ========================================================================== */

window.universeTimeHours = parseInt(localStorage.getItem('odyssey_universe_time') || '24192000'); 
window.timeFlowActive = false;
window.timeFlowInterval = null;

window.formatUniverseTime = function(totalHours) {
    const hoursInDay = 24; const daysInMonth = 30; const monthsInYear = 12;
    const hoursInMonth = hoursInDay * daysInMonth; const hoursInYear = hoursInMonth * monthsInYear;
    let year = Math.floor(totalHours / hoursInYear); let remainder = totalHours % hoursInYear;
    let month = Math.floor(remainder / hoursInMonth) + 1; remainder %= hoursInMonth;
    let day = Math.floor(remainder / hoursInDay) + 1; let hour = remainder % hoursInDay;
    return `YR ${year}.${month < 10 ? '0'+month : month}.${day < 10 ? '0'+day : day} // ${hour < 10 ? '0'+hour : hour}:00`;
};

window.updateCalendarDisplay = function() {
    const timeStr = window.formatUniverseTime(window.universeTimeHours);
    const clockTicker = document.getElementById('clock-ticker-text');
    const modalClock = document.getElementById('modal-clock-display');
    if (clockTicker) clockTicker.innerText = timeStr;
    if (modalClock) modalClock.innerText = timeStr;
};

window.processTimeAdvancement = async function(oldHours, newHours) {
    let daysPassed = Math.floor(newHours / 24) - Math.floor(oldHours / 24);
    if (daysPassed > 0 && typeof globalShipMarkersCache !== 'undefined') {
        let anyUpdated = false;
        for (let vessel of globalShipMarkersCache) {
            let cargo = vessel.cargo_inventory || {};
            if (cargo.synth_capacity !== 10) { cargo.synth_capacity = 10; anyUpdated = true; }
            if (anyUpdated) await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vessel.id);
        }
        if (anyUpdated) {
            await db.from('chat_logs').insert({ sender_id: 'system', content: `✨ [DAILY LOGISTICS] 24-hour cycle complete. Elder Synthesizers recharged.`, message_type: 'text' });
        }
    }
};

// MODULE C: Complexity-Scaled DRADIS Scan Execution
window.executeDradisScan = async function(sysId) {
    let s = globalDbSystemsCache.find(x => x.id === sysId) || globalProceduralSystemsCache.find(x => x.id === sysId);
    if (!s) return;
    
    // Calculate Complexity
    let bodies = window.getSystemBodies(s).length;
    let scanHours = 2 + bodies; // Base 2 hours + 1 hr per planet
    
    if (window.AudioEngine) window.AudioEngine.playPing();
    
    // Advance Time
    let oldTime = window.universeTimeHours;
    window.universeTimeHours += scanHours;
    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay();
    await window.processTimeAdvancement(oldTime, window.universeTimeHours);

    // Record the Scan
    if (!window.scannedSystems.includes(sysId)) {
        window.scannedSystems.push(sysId);
        localStorage.setItem('odyssey_scanned', JSON.stringify(window.scannedSystems));
    }

    // Broadcast to Fleet (Also automatically syncs FOW for other online players via chat parser)
    await db.from('chat_logs').insert({
        sender_id: 'system',
        content: `📡 [DRADIS SWEEP] Task Force Black completed a deep scan of '${s.name}'. Operation took ${scanHours} hours. Orbital census uploaded to mainframe. [SYS_SCAN:${sysId}]`,
        message_type: 'text'
    });

    // Check for Discovery-Linked Codex Lore
    let unlockedLore = globalCodexEntriesCache.filter(e => (e.subtitle || '').includes(`LINK:${sysId}`));
    if (unlockedLore.length > 0) {
        await db.from('chat_logs').insert({
            sender_id: 'system',
            content: `📖 [INTEL DECRYPTED] DRADIS sweep recovered hidden data caches. New Codex entries unlocked.`,
            message_type: 'text'
        });
    }

    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    if (typeof window.renderCodexMatrix === 'function') window.renderCodexMatrix();
};

window.initCalendarEngine = function() {
    window.updateCalendarDisplay();
    window.timeFlowInterval = setInterval(async () => {
        if (window.timeFlowActive) { 
            let oldTime = window.universeTimeHours;
            window.universeTimeHours += 1; 
            localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
            window.updateCalendarDisplay(); 
            await window.processTimeAdvancement(oldTime, window.universeTimeHours);
        }
    }, 4000);
};

window.toggleCalendarControls = function() {
    const panel = document.getElementById('calendar-control-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    window.updateCalendarDisplay();
};

/* Terminal Tabs & UI Resets (Truncated for brevity) */
window.switchTermTab = function(tabName) {
    document.querySelectorAll('.term-tab-btn-vert').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.term-panel-content').forEach(p => p.classList.remove('active'));
    const activeBtn = document.getElementById(`term-tab-btn-${tabName}`); if (activeBtn) activeBtn.classList.add('active');
    const activePanel = document.getElementById(`term-panel-${tabName}`); if (activePanel) activePanel.classList.add('active');
    if (tabName === 'codex') window.switchCodexCategory(activeCodexCategory);
    if (tabName === 'roster' && typeof window.renderCrewRoster === 'function') window.renderCrewRoster();
};
window.toggleCharacterTerminal = function() { const term = document.getElementById('character-terminal'); term.style.display = term.style.display === 'block' ? 'none' : 'block'; };

/* MODULE C: CODEX FILTERING & SYSTEM LINKING */
window.switchCodexCategory = function(cat) {
    activeCodexCategory = cat;
    document.querySelectorAll('.codex-me-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`codex-rail-${cat}`); if (btn) btn.classList.add('active');
    if (typeof window.renderCodexMatrix === 'function') window.renderCodexMatrix();
};

window.renderCodexMatrix = function() {
    const container = document.getElementById('codex-entries-matrix');
    if (!container) return;

    let entries = globalCodexEntriesCache.filter(e => e.category === activeCodexCategory);
    
    // MODULE C: Filter out Discovery-Linked lore if players haven't scanned it yet!
    entries = entries.filter(e => {
        if (currentUserRole === 'dm') return true; // DM sees everything
        let linkMatch = (e.subtitle || '').match(/LINK:(.+)/);
        if (linkMatch) {
            // Only show if the linked system ID has been DRADIS Scanned
            return window.scannedSystems.includes(linkMatch[1].trim());
        }
        return true; // Not linked to a system, show normally
    });

    if (entries.length === 0) {
        container.innerHTML = `<span style="font-size:11px; color:#6b826a;">No records located under this classification.</span>`;
        return;
    }

    let isDM = (currentUserRole === 'dm');
    let html = '';

    entries.forEach(e => {
        let cleanSubtitle = (e.subtitle || '').replace(/\|\s*LINK:.+/, '').trim(); // Hide the ugly LINK text from players
        let docHtml = (e.doc_data && e.doc_name) ? `<div class="codex-doc-pill" onclick="window.openCodexAttachment('${e.id}')">📎 ATTACHMENT: ${e.doc_name} (${(e.doc_type || 'FILE').toUpperCase()})</div>` : '';

        html += `
            <div class="codex-entry-card category-${e.category}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#00e5a3; font-size:13px; letter-spacing:1px;">${e.title}</strong>
                        <div style="font-size:10px; color:#6b826a; margin-top:2px;">${cleanSubtitle || 'General Record'}</div>
                    </div>
                    <div style="display:flex; gap:6px; align-items:center;">
                        <button class="layer-edit" onclick="window.openCodexFullscreen('${e.id}')" style="font-size:9px; padding:3px 8px;">⛶ FULLSCREEN</button>
                        ${isDM ? `<button class="layer-edit" onclick="window.editCodexEntry('${e.id}')" style="font-size:9px; padding:3px 8px; color:#ffaa00; border-color:#ffaa00;">✎ EDIT</button>` : ''}
                        ${isDM ? `<button class="layer-del" onclick="window.deleteCodexEntry('${e.id}')" style="font-size:9px; padding:3px 6px;">✕</button>` : ''}
                    </div>
                </div>
                <p style="margin:8px 0 4px 0; font-size:11px; color:#d4c5a9; line-height:1.5; max-height:80px; overflow:hidden; text-overflow:ellipsis;">${e.content || ''}</p>
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
    document.getElementById('new-codex-content').value = entry.content || '';
    
    // Parse out the Linked System ID if it exists
    let sub = entry.subtitle || '';
    let linkMatch = sub.match(/\|\s*LINK:(.+)/);
    if (linkMatch) {
        document.getElementById('new-codex-link').value = linkMatch[1].trim();
        sub = sub.replace(linkMatch[0], '').trim();
    } else {
        const linkInput = document.getElementById('new-codex-link');
        if (linkInput) linkInput.value = '';
    }
    document.getElementById('new-codex-subtitle').value = sub;

    document.getElementById('btn-save-codex-entry').innerText = "✓ UPDATE CODEX ENTRY";
    document.getElementById('btn-cancel-codex-edit').style.display = "block";
};

window.saveNewCodexEntry = async function() {
    if (currentUserRole !== 'dm') return;
    const cat = document.getElementById('new-codex-category').value;
    const title = document.getElementById('new-codex-title').value.trim();
    let subtitle = document.getElementById('new-codex-subtitle').value.trim();
    const content = document.getElementById('new-codex-content').value.trim();
    const linkInput = document.getElementById('new-codex-link');
    
    // Append the Linked System ID to the subtitle so we don't have to alter the Supabase database schema!
    if (linkInput && linkInput.value.trim() !== '') {
        subtitle += ` | LINK:${linkInput.value.trim()}`;
    }

    if (!title) { alert("Please enter an entry title."); return; }

    const payload = { category: cat, title: title, subtitle: subtitle, content: content, created_by: currentUserId };

    if (editingCodexId) {
        await db.from('codex_entries').update(payload).eq('id', editingCodexId);
        window.cancelCodexEdit(); window.switchCodexCategory(cat); if (typeof loadCodexEntries === 'function') loadCodexEntries();
    } else {
        await db.from('codex_entries').insert(payload);
        window.cancelCodexEdit(); window.switchCodexCategory(cat); if (typeof loadCodexEntries === 'function') loadCodexEntries();
    }
};

window.cancelCodexEdit = function() {
    editingCodexId = null;
    document.getElementById('codex-creator-heading').innerText = "+ New Codex Entry";
    document.getElementById('new-codex-title').value = ''; document.getElementById('new-codex-subtitle').value = '';
    document.getElementById('new-codex-content').value = ''; 
    const linkInput = document.getElementById('new-codex-link'); if(linkInput) linkInput.value = '';
    document.getElementById('btn-save-codex-entry').innerText = "+ PUBLISH TO CODEX";
    document.getElementById('btn-cancel-codex-edit').style.display = "none";
};

/* Boilerplate functions kept intact for Comms and Chat UI */
window.toggleCommsArray = function() { const panel = document.getElementById('comms-array-panel'); panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; };
window.sendChatMessage = async function() { const input = document.getElementById('comms-message-input'); const content = input.value.trim(); if (!content) return; await db.from('chat_logs').insert({ sender_id: currentUserId, content: content, message_type: 'text' }); input.value = ''; };
window.renderChatFeed = function() { const feed = document.getElementById('comms-chat-feed'); if (!feed) return; let html = ''; chatLogsList.forEach(log => { const senderName = allProfiles.find(p => p.id === log.sender_id)?.username || 'System'; let headerColor = log.sender_id === 'system' ? '#6b826a' : '#00e5a3'; html += `<div style="background: rgba(6,9,7,0.6); padding: 6px; border-left: 2px solid ${headerColor}; border-radius: 2px;"><div style="font-size: 9px; color: ${headerColor}; margin-bottom: 2px;"><strong>${senderName}</strong></div><div style="font-size: 11px; color: #d4c5a9;">${log.content}</div></div>`; }); feed.innerHTML = html; feed.scrollTop = feed.scrollHeight; };
