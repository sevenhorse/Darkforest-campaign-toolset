/* ==========================================================================
   js/ui.js - Interface, Layout, Time & Menus (100% COMPLETE)
   ========================================================================== */

/* --- CUSTOM CONFIRM MODAL ---
   Native confirm()/alert() can be permanently silenced by the browser if the
   user ever checks "Prevent this page from creating additional dialogs" —
   after that, confirm() just returns false with no prompt, forever, for the
   rest of the page session. This in-app modal replaces confirm() everywhere
   so DM/player actions gated behind a confirmation can never get bricked
   that way. window.showConfirmModal(message) returns a Promise<boolean>. */
(function() {
    let overlay, msgEl, okBtn, cancelBtn, resolver;
    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'custom-confirm-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:360px; max-width:90vw; border-color:#ff6b6b; text-align:center;">
            <p id="custom-confirm-message" style="color:#d4c5a9; font-size:13px; margin:0 0 16px 0; line-height:1.5;"></p>
            <div style="display:flex; gap:10px;">
                <button id="custom-confirm-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="custom-confirm-ok-btn" class="btn-remove" style="flex:1; margin-top:0;">CONFIRM</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        msgEl = document.getElementById('custom-confirm-message');
        okBtn = document.getElementById('custom-confirm-ok-btn');
        cancelBtn = document.getElementById('custom-confirm-cancel-btn');
        okBtn.addEventListener('click', () => finish(true));
        cancelBtn.addEventListener('click', () => finish(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
        document.addEventListener('keydown', (e) => { if (overlay.style.display !== 'none' && e.key === 'Escape') finish(false); });
    }
    function finish(result) {
        overlay.style.display = 'none';
        if (resolver) { resolver(result); resolver = null; }
    }
    window.showConfirmModal = function(message) {
        ensureModal();
        msgEl.textContent = message;
        overlay.style.display = 'flex';
        return new Promise((resolve) => { resolver = resolve; });
    };
})();

/* --- CALENDAR & TIME ENGINE --- */
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
        let rationsLogged = false;
        
        for (let vessel of globalShipMarkersCache) {
            let cargo = vessel.cargo_inventory || {};
            let changed = false;
            
            if (cargo.synth_capacity !== 10) { cargo.synth_capacity = 10; changed = true; }
            
            if (cargo.perishables) {
                let rationIdx = cargo.perishables.findIndex(i => i.name.toLowerCase().includes('ration') || i.name.toLowerCase().includes('food'));
                if (rationIdx >= 0 && cargo.perishables[rationIdx].qty > 0) {
                    cargo.perishables[rationIdx].qty -= 1; changed = true; rationsLogged = true;
                } else if (rationIdx >= 0 || cargo.perishables.length > 0) {
                    await db.from('chat_logs').insert({ sender_id: 'system', content: `⚠️ [CRITICAL] Vessel '${vessel.name}' has depleted Standard Rations. Starvation protocols active.`, message_type: 'text' });
                    if (window.AudioEngine) window.AudioEngine.playError();
                }
            }
            if (changed) { await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vessel.id); anyUpdated = true; }
        }
        
        if (anyUpdated) {
            let rationText = rationsLogged ? " Rations consumed." : "";
            await db.from('chat_logs').insert({ sender_id: 'system', content: `✨ [DAILY LOGISTICS] 24-hour cycle complete. Elder E-M Synthesizers recharged.${rationText}`, message_type: 'text' });
            if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
        }
    }
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
    const ftlOnlyCb = document.getElementById('jump-inversion-ftl-only');
    if (ftlOnlyCb) ftlOnlyCb.checked = window.jumpInversionFtlOnly;
};

window.adjustTime = async function(amount, unit) {
    if (currentUserRole !== 'dm') return;
    let multiplier = 1;
    if (unit === 'hours') multiplier = 1; if (unit === 'days') multiplier = 24;
    if (unit === 'months') multiplier = 24 * 30; if (unit === 'years') multiplier = 24 * 30 * 12;

    let oldTime = window.universeTimeHours;
    window.universeTimeHours += amount * multiplier;
    if (window.universeTimeHours < 0) window.universeTimeHours = 0;
    
    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay(); window.broadcastTimeSync();
    await window.processTimeAdvancement(oldTime, window.universeTimeHours);
};

window.applyManualTime = async function() {
    if (currentUserRole !== 'dm') return;
    const yr = parseInt(document.getElementById('set-yr').value);
    const mo = parseInt(document.getElementById('set-mo').value) || 1;
    const da = parseInt(document.getElementById('set-da').value) || 1;
    const hr = parseInt(document.getElementById('set-hr').value) || 0;

    if (isNaN(yr)) { alert("Please enter a valid year."); return; }

    const hoursInYear = 24 * 30 * 12; const hoursInMonth = 24 * 30; const hoursInDay = 24;
    let oldTime = window.universeTimeHours;
    window.universeTimeHours = (yr * hoursInYear) + ((mo - 1) * hoursInMonth) + ((da - 1) * hoursInDay) + hr;
    if (window.universeTimeHours < 0) window.universeTimeHours = 0;

    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay(); window.broadcastTimeSync();
    await window.processTimeAdvancement(oldTime, window.universeTimeHours);
    alert("Chronology manually updated.");
};

window.resetTimeline = async function() {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Reset timeline back to YR 2800.01.01?"))) return;
    let oldTime = window.universeTimeHours;
    window.universeTimeHours = 24192000;
    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay(); window.broadcastTimeSync();
    await window.processTimeAdvancement(oldTime, window.universeTimeHours);
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
    db.from('chat_logs').insert({ sender_id: currentUserId, content: `⏳ [TIMELINE ADJUSTED] Overseer shifted chronology to: ${window.formatUniverseTime(window.universeTimeHours)}`, message_type: 'text' });
};

/* --- UI PANELS, TABS & DRAGGING --- */
function makePanelDraggable(panelId, handleId, storageKey) {
    const panel = document.getElementById(panelId); const handle = document.getElementById(handleId);
    if (!panel || !handle) return;
    const savedPos = localStorage.getItem(storageKey);
    if (savedPos) {
        try {
            const { left, top } = JSON.parse(savedPos);
            const leftNum = parseFloat(left); const topNum = parseFloat(top);
            // Reject corrupted/invalid saved positions instead of applying them
            // blindly — a position captured while the panel was hidden (e.g.
            // pre-login, before #app-container is display:block) reads
            // offsetLeft/offsetTop as 0, which then gets saved as the panel's
            // permanent position and reloads at (0,0) every time until the
            // user happens to drag it and the drag's own clamping shoves it
            // back into view. Falling back to the CSS default position here
            // makes that self-healing instead of a recurring "snap" on click.
            if (isNaN(leftNum) || isNaN(topNum) || leftNum <= 0 || topNum <= 0) {
                localStorage.removeItem(storageKey);
            } else {
                panel.style.left = left; panel.style.top = top; panel.style.right = 'auto';
            }
        } catch(e) { localStorage.removeItem(storageKey); }
    }
    let isDragging = false, startX, startY, initialLeft, initialTop;
    handle.addEventListener('mousedown', (e) => {
        if (['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
        if (panel.offsetWidth === 0 && panel.offsetHeight === 0) return; // panel isn't actually laid out yet (e.g. hidden ancestor) — offsetLeft/Top would read as 0 and corrupt the saved position
        isDragging = true; startX = e.clientX; startY = e.clientY;
        initialLeft = panel.offsetLeft; initialTop = panel.offsetTop;
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
        panel.style.left = `${initialLeft}px`; panel.style.top = `${initialTop}px`;
        
        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const dx = moveEvent.clientX - startX; const dy = moveEvent.clientY - startY;
            panel.style.left = `${Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, initialLeft + dx))}px`;
            panel.style.top = `${Math.max(60, Math.min(window.innerHeight - panel.offsetHeight - 10, initialTop + dy))}px`;
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
    Object.keys(localStorage).forEach(k => { if (k.startsWith('odyssey_') && !k.includes('universe_time') && !k.includes('scanned')) localStorage.removeItem(k); });
    location.reload();
};

window.switchHudTab = function(tab) {
    window.activeHudTab = tab;
    document.querySelectorAll('#hud-overlay .hud-tab-btn').forEach(b => b.classList.remove('active'));
    if (tab === 'telemetry') document.getElementById('tab-btn-details')?.classList.add('active');
    if (tab === 'bookmarks') document.getElementById('tab-btn-bookmarks')?.classList.add('active');
    if (tab === 'recents') document.getElementById('tab-btn-recents')?.classList.add('active');
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};

window.switchDmSubtab = function(subtab) {
    document.querySelectorAll('#dm-tools .hud-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#dm-tools .dm-subpanel').forEach(p => p.classList.remove('active'));
    const btn = document.getElementById(`dm-subtab-btn-${subtab}`); if (btn) btn.classList.add('active');
    const panel = document.getElementById(`dm-panel-${subtab}`); if (panel) panel.classList.add('active');
};

window.TERM_TAB_ACTIVITY_LABELS = {
    stats: 'Viewing Character Dossier',
    combat: 'Managing Arsenal',
    cargo: 'Managing Cargo Manifest',
    vessel: 'Inspecting Vessel Deck',
    colonies: 'Managing Colonial Assets',
    notes: 'Editing Tactical Notes',
    roster: 'Reviewing Crew Roster',
    codex: 'Reviewing Sector Lore'
};

window.switchTermTab = function(tabName) {
    document.querySelectorAll('.term-tab-btn-vert').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.term-panel-content').forEach(p => p.classList.remove('active'));
    const activeBtn = document.getElementById(`term-tab-btn-${tabName}`); if (activeBtn) activeBtn.classList.add('active');
    const activePanel = document.getElementById(`term-panel-${tabName}`); if (activePanel) activePanel.classList.add('active');

    if (tabName === 'cargo' && typeof window.renderTerminalCargoDeck === 'function') { window.populateCargoVesselSelect(); window.renderTerminalCargoDeck(); }
    if (tabName === 'vessel' && typeof window.renderVesselDeck === 'function') { window.populateVesselDeckSelect(); window.renderVesselDeck(); }
    if (tabName === 'colonies') { if (typeof window.populateFleetFormSelects === 'function') window.populateFleetFormSelects(); if (typeof window.renderColoniesPanel === 'function') window.renderColoniesPanel(); if (typeof window.renderFleetGroupsPanel === 'function') window.renderFleetGroupsPanel(); }
    if (tabName === 'codex') window.switchCodexCategory(window.activeCodexCategory || 'factions');
    if (tabName === 'roster' && typeof window.renderCrewRoster === 'function') window.renderCrewRoster();

    const activityLabel = window.TERM_TAB_ACTIVITY_LABELS[tabName];
    if (activityLabel && typeof window.broadcastActivity === 'function') window.broadcastActivity(activityLabel);
};

window.toggleCharacterTerminal = function() {
    const term = document.getElementById('character-terminal');
    const opening = term.style.display !== 'block';
    term.style.display = opening ? 'block' : 'none';

    if (typeof window.broadcastActivity !== 'function') return;
    if (opening) {
        const activeBtn = document.querySelector('.term-tab-btn-vert.active');
        const tabName = activeBtn ? activeBtn.id.replace('term-tab-btn-', '') : 'stats';
        window.broadcastActivity(window.TERM_TAB_ACTIVITY_LABELS[tabName] || 'Reviewing Command Terminal');
    } else {
        window.broadcastActivity('Monitoring DRADIS');
    }
};

window.openFullDossierTerminal = function() { const term = document.getElementById('character-terminal'); term.style.display = 'block'; window.switchTermTab('stats'); };
window.openFullCargoTerminal = function() { const term = document.getElementById('character-terminal'); term.style.display = 'block'; window.switchTermTab('cargo'); };
window.openFullCodexTerminal = function() { const term = document.getElementById('character-terminal'); term.style.display = 'block'; window.switchTermTab('codex'); };
window.openFullVesselTerminal = function(vesselId) { 
    const term = document.getElementById('character-terminal'); term.style.display = 'block'; window.switchTermTab('vessel'); 
    if (vesselId) { const select = document.getElementById('vessel-deck-select'); if (select) { select.value = vesselId; if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck(); } }
};

/* --- FEATURE: "JUMP TO SHIP" BUTTON ON EVERY MAJOR OVERLAY HEADER ---
   Injected rather than hand-duplicated into each header block in index.html,
   so every panel gets an identical, consistently-styled shortcut button and
   future header markup changes don't risk the seven copies drifting apart. */
function injectJumpToShipButtons() {
    const headerIds = [
        'hud-overlay-header', 'combat-tracker-header', 'dm-tools-header',
        'comms-array-header', 'calendar-control-header', 'dm-scratchpad-header',
        'territory-control-header'
    ];
    headerIds.forEach(id => {
        const header = document.getElementById(id);
        if (!header || header.querySelector('.jump-to-ship-btn')) return; // already injected
        const btn = document.createElement('button');
        btn.className = 'layer-edit jump-to-ship-btn';
        btn.title = 'Jump to your vessel — opens Vessel Deck & inverts the chronometer';
        btn.style.cssText = 'padding:4px 8px; font-size:10px; margin-left:6px; white-space:nowrap;';
        btn.innerHTML = '🚀 JUMP';
        btn.onclick = (e) => { e.stopPropagation(); if (typeof window.jumpToActiveShip === 'function') window.jumpToActiveShip(); };
        header.appendChild(btn);
    });
}
injectJumpToShipButtons();

window.toggleCombatTracker = function() { const panel = document.getElementById('combat-tracker-panel'); panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; };
window.toggleCommsArray = function() { const panel = document.getElementById('comms-array-panel'); panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; if (panel.style.display === 'block' && typeof window.populateCommsRecipients === 'function') window.populateCommsRecipients(); };
window.toggleDmScratchpad = function() { if (currentUserRole !== 'dm') return; const panel = document.getElementById('dm-scratchpad-panel'); panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; };
window.saveDmScratchpad = function() { if (currentUserRole !== 'dm') return; const val = document.getElementById('dm-scratchpad-input').value; localStorage.setItem('odyssey_dm_scratchpad', val); };

/* --- SKILLS & CHARACTER TERMINAL --- */
const skillList = [ "Athletics", "Stealth", "Survival", "Ballistic Weapons", "Energy Weapons", "Explosives", "Computers", "Engineering", "Sciences", "Mechanics", "Medical", "Speechcraft", "Melee", "Pilot" ];
function renderSkillInputs() {
    const container = document.getElementById('skills-input-container'); if (!container) return;
    let html = '';
    skillList.forEach(skill => {
        const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_');
        html += `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:4px 6px; border-radius:2px; border:1px solid #3c4e36;">
                <span style="font-size:10px; color:#d4c5a9;">${skill}</span><input type="number" id="skill-${safeKey}" min="-100" max="100" value="0" style="width:65px; margin:0; text-align:right; font-size:10px; padding:2px;"></div>`;
    });
    container.innerHTML = html;
    
    const diceContainer = document.getElementById('dice-roller-skills'); let dHtml = '';
    skillList.forEach(skill => { dHtml += `<label style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" class="roll-skill-cb" value="${skill}" style="width:auto; margin:0;"> ${skill}</label>`; });
    if(diceContainer) diceContainer.innerHTML = dHtml;
    
    const statContainer = document.getElementById('dice-roller-stats'); let sHtml = '';
    ['Charisma', 'Dexterity', 'Intelligence', 'Strength', 'Toughness', 'Willpower'].forEach(st => { sHtml += `<label style="font-size: 11px; color: #d4c5a9;"><input type="checkbox" class="roll-stat-cb" value="${st}"> ${st}</label>`; });
    if(statContainer) statContainer.innerHTML = sHtml;
}
renderSkillInputs();

window.renderCharacterTerminalData = function() {
    const myProf = allProfiles.find(p => p.id === currentUserId); if (!myProf) return;
    const c = myProf.character || {}; const s = myProf.skills || {};
    const setVal = (id, val) => { const el = document.getElementById(id); if(el) el.value = val; };

    setVal('term-sheet-name', c.name || '');
    setVal('stat-charisma', c.stat_charisma || 'd4'); setVal('stat-dexterity', c.stat_dexterity || 'd4'); setVal('stat-intelligence', c.stat_intelligence || 'd4');
    setVal('stat-strength', c.stat_strength || 'd4'); setVal('stat-toughness', c.stat_toughness || 'd4'); setVal('stat-willpower', c.stat_willpower || 'd4');
    setVal('term-vitality', c.vitality || 0); setVal('term-stress', c.stress || 0); setVal('term-adversity', c.adversity_tokens || 0);
    setVal('term-specialties', c.specialties || ''); setVal('term-assets', c.assets || ''); setVal('term-history', c.history || '');
    setVal('aug-head', c.aug_head || ''); setVal('aug-torso', c.aug_torso || ''); setVal('aug-larm', c.aug_larm || '');
    setVal('aug-rarm', c.aug_rarm || ''); setVal('aug-lleg', c.aug_lleg || ''); setVal('aug-rleg', c.aug_rleg || '');
    
    skillList.forEach(skill => { const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_'); setVal(`skill-${safeKey}`, s[safeKey] || 0); });
    if (typeof window.renderArsenal === 'function') window.renderArsenal();
};

window.saveTerminalProfile = async function() {
    const safeGet = (id) => document.getElementById(id) ? document.getElementById(id).value : '';

    const newUsername = safeGet('term-username').trim(); const newAvatar = safeGet('term-avatar');
    if (newUsername) {
        let handleTaken = allProfiles.some(p => p.id !== currentUserId && (p.username || '').trim().toLowerCase() === newUsername.toLowerCase());
        if (handleTaken) { alert(`Handle "${newUsername}" is already in use by another Commander. Choose a different one.`); return; }
    }

    await db.from('profiles').update({ username: newUsername, avatar_url: newAvatar }).eq('id', currentUserId);

    const charPayload = {
        profile_id: currentUserId, name: safeGet('term-sheet-name'),
        stat_charisma: safeGet('stat-charisma'), stat_dexterity: safeGet('stat-dexterity'), stat_intelligence: safeGet('stat-intelligence'), stat_strength: safeGet('stat-strength'), stat_toughness: safeGet('stat-toughness'), stat_willpower: safeGet('stat-willpower'),
        vitality: parseInt(safeGet('term-vitality')) || 0, stress: parseInt(safeGet('term-stress')) || 0, adversity_tokens: parseInt(safeGet('term-adversity')) || 0,
        specialties: safeGet('term-specialties'), assets: safeGet('term-assets'), history: safeGet('term-history'),
        aug_head: safeGet('aug-head'), aug_torso: safeGet('aug-torso'), aug_larm: safeGet('aug-larm'), aug_rarm: safeGet('aug-rarm'), aug_lleg: safeGet('aug-lleg'), aug_rleg: safeGet('aug-rleg')
    };
    const { data: charData, error: charErr } = await db.from('characters').upsert(charPayload, { onConflict: 'profile_id' }).select().single();
    if (charErr) return;

    let skillsPayload = { character_id: charData.id };
    skillList.forEach(skill => { const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_'); skillsPayload[safeKey] = parseInt(safeGet(`skill-${safeKey}`)) || 0; });
    await db.from('character_skills').upsert(skillsPayload, { onConflict: 'character_id' });

    // Patch the local profile cache immediately so handle/avatar changes are reflected
    // right away (roster, chat feed, presence) instead of waiting on a reload or the
    // next chat message to trigger a re-render against fresh data.
    let myProf = allProfiles.find(p => p.id === currentUserId);
    if (myProf) { myProf.username = newUsername; myProf.avatar_url = newAvatar; }
    if (typeof window.refreshMyPresence === 'function' && myProf) window.refreshMyPresence(myProf);
    if (typeof renderChatFeed === 'function') renderChatFeed();
    if (typeof window.renderCrewRoster === 'function') window.renderCrewRoster();
    if (typeof window.populateCommsRecipients === 'function') window.populateCommsRecipients();

    alert("Character dossier & stats secured to database.");
    if (typeof loadAllProfiles === 'function') loadAllProfiles();
};

/* --- MODULE A: OVERSEER ROSTER --- */
window.renderCrewRoster = function() {
    const container = document.getElementById('crew-roster-container'); if (!container) return;
    let html = '';
    allProfiles.forEach(p => {
        let char = p.character || {};
        if (currentUserRole === 'dm') {
            html += `
                <div class="note-card" style="border-color:#ff6b6b; padding:10px;">
                    <div style="display:flex; gap:10px; align-items:flex-start;">
                        <img src="${p.avatar_url || ''}" style="width:40px; height:40px; border:1px solid #3c4e36; background:#040605; object-fit:cover;">
                        <div style="flex:1;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <div><strong style="color:#00e5a3; font-size:14px;">${char.name || p.username || 'Unknown'}</strong></div>
                                <button class="btn-reveal" onclick="window.snapToCommander('${p.id}')" style="font-size:9px; padding:2px 6px;">LOCATE VESSEL</button>
                            </div>
                            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px; margin-top:8px;">
                                <div><label style="font-size:9px; color:#ff6b6b;">Vitality</label><input type="number" id="dm-edit-vit-${p.id}" value="${char.vitality || 0}" style="font-size:10px; padding:2px; margin:0;"></div>
                                <div><label style="font-size:9px; color:#ffaa00;">Stress</label><input type="number" id="dm-edit-str-${p.id}" value="${char.stress || 0}" style="font-size:10px; padding:2px; margin:0;"></div>
                                <div><label style="font-size:9px; color:#00e5a3;">Adversity</label><input type="number" id="dm-edit-adv-${p.id}" value="${char.adversity_tokens || 0}" style="font-size:10px; padding:2px; margin:0;"></div>
                            </div>
                            <label style="font-size:9px; color:#6b826a; margin-top:6px; display:block;">Gear Override:</label>
                            <textarea id="dm-edit-assets-${p.id}" rows="2" style="font-size:10px; margin:2px 0;">${char.assets || ''}</textarea>
                            <button class="btn-reveal" onclick="window.dmUpdatePlayerStats('${p.id}')" style="width:100%; font-size:9px; margin-top:4px; border-color:#ff6b6b; color:#ff6b6b;">APPLY OVERRIDE</button>
                        </div>
                    </div>
                </div>
            `;
        } else {
            html += `
                <div class="note-card" style="padding:10px;">
                    <div style="display:flex; gap:10px; align-items:center;">
                        <img src="${p.avatar_url || ''}" style="width:40px; height:40px; border:1px solid #3c4e36; background:#040605; object-fit:cover;">
                        <div style="flex:1;">
                            <strong style="color:#00e5a3; font-size:14px;">${char.name || p.username || 'Unknown'}</strong><br>
                            <span style="color:#6b826a; font-size:10px;">Vitality: ${char.vitality || 0} | Stress: ${char.stress || 0}</span>
                        </div>
                    </div>
                </div>
            `;
        }
    });
    container.innerHTML = html;
};

window.dmUpdatePlayerStats = async function(profileId) {
    if (currentUserRole !== 'dm') return;
    const vit = parseInt(document.getElementById(`dm-edit-vit-${profileId}`).value) || 0;
    const str = parseInt(document.getElementById(`dm-edit-str-${profileId}`).value) || 0;
    const adv = parseInt(document.getElementById(`dm-edit-adv-${profileId}`).value) || 0;
    const assets = document.getElementById(`dm-edit-assets-${profileId}`).value;
    const prof = allProfiles.find(p => p.id === profileId);
    if (!prof || !prof.character) return;
    await db.from('characters').update({ vitality: vit, stress: str, adversity_tokens: adv, assets: assets }).eq('id', prof.character.id);
    db.from('chat_logs').insert({ sender_id: 'system', content: `⚙️ [OVERSEER] System parameters overridden for Commander ${prof.username}.`, message_type: 'text' });
    alert("Player metrics overridden and saved to cloud.");
};

/* --- MODULE C: CODEX, LORE & FOW --- */
window.switchCodexCategory = function(cat) {
    window.activeCodexCategory = cat;
    document.querySelectorAll('.codex-me-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`codex-rail-${cat}`); if (btn) btn.classList.add('active');
    if (typeof window.renderCodexMatrix === 'function') window.renderCodexMatrix();
};

window.filterCodexEntries = function(val) { window.codexSearchFilter = (val || '').toLowerCase().trim(); window.renderCodexMatrix(); };

window.renderCodexMatrix = function() {
    const container = document.getElementById('codex-entries-matrix'); if (!container) return;
    let entries = globalCodexEntriesCache.filter(e => e.category === window.activeCodexCategory);
    
    if (window.codexSearchFilter) {
        entries = entries.filter(e => (e.title && e.title.toLowerCase().includes(window.codexSearchFilter)) || (e.subtitle && e.subtitle.toLowerCase().includes(window.codexSearchFilter)) || (e.content && e.content.toLowerCase().includes(window.codexSearchFilter)));
    }

    entries = entries.filter(e => {
        if (currentUserRole === 'dm') return true;
        let linkMatch = (e.subtitle || '').match(/LINK:(.+)/);
        if (linkMatch) { return window.scannedSystems && window.scannedSystems.includes(linkMatch[1].trim()); }
        return true; 
    });

    if (entries.length === 0) { container.innerHTML = `<span style="font-size:11px; color:#6b826a;">No records located under this classification.</span>`; return; }

    let isDM = (currentUserRole === 'dm');
    let html = '';
    entries.forEach(e => {
        let cleanSubtitle = (e.subtitle || '').replace(/\|\s*LINK:.+/, '').trim(); 
        let docHtml = (e.doc_data && e.doc_name) ? `<div class="codex-doc-pill" onclick="window.openCodexAttachment('${e.id}')">📎 ATTACHMENT: ${e.doc_name} (${(e.doc_type || 'FILE').toUpperCase()})</div>` : '';
        html += `
            <div class="codex-entry-card category-${e.category}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div><strong style="color:#00e5a3; font-size:13px;">${e.title}</strong><div style="font-size:10px; color:#6b826a; margin-top:2px;">${cleanSubtitle || 'General Record'}</div></div>
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
    const entry = globalCodexEntriesCache.find(e => e.id === id); if (!entry) return;
    window.editingCodexId = id;
    document.getElementById('codex-creator-heading').innerText = `✎ Editing: ${entry.title}`;
    document.getElementById('new-codex-category').value = entry.category || 'lore';
    document.getElementById('new-codex-title').value = entry.title || '';
    document.getElementById('new-codex-content').value = entry.content || '';
    
    let sub = entry.subtitle || ''; let linkMatch = sub.match(/\|\s*LINK:(.+)/);
    if (linkMatch) {
        document.getElementById('new-codex-link').value = linkMatch[1].trim();
        sub = sub.replace(linkMatch[0], '').trim();
    } else {
        const linkInput = document.getElementById('new-codex-link'); if (linkInput) linkInput.value = '';
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
    
    if (linkInput && linkInput.value.trim() !== '') subtitle += ` | LINK:${linkInput.value.trim()}`;
    if (!title) { alert("Please enter an entry title."); return; }

    const payload = { category: cat, title: title, subtitle: subtitle, content: content, created_by: currentUserId };
    if (window.editingCodexId) { await db.from('codex_entries').update(payload).eq('id', window.editingCodexId); } 
    else { await db.from('codex_entries').insert(payload); }
    
    window.cancelCodexEdit(); window.switchCodexCategory(cat); if (typeof loadCodexEntries === 'function') loadCodexEntries();
};

window.cancelCodexEdit = function() {
    window.editingCodexId = null;
    document.getElementById('codex-creator-heading').innerText = "+ New Codex Entry";
    document.getElementById('new-codex-title').value = ''; document.getElementById('new-codex-subtitle').value = '';
    document.getElementById('new-codex-content').value = ''; 
    const linkInput = document.getElementById('new-codex-link'); if(linkInput) linkInput.value = '';
    document.getElementById('btn-save-codex-entry').innerText = "+ PUBLISH TO CODEX";
    document.getElementById('btn-cancel-codex-edit').style.display = "none";
};

window.deleteCodexEntry = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Permanently erase this record?"))) return;
    await db.from('codex_entries').delete().eq('id', id);
    if (window.editingCodexId === id) window.cancelCodexEdit();
    if (typeof loadCodexEntries === 'function') loadCodexEntries();
};

window.openCodexFullscreen = function(id) {
    const entry = globalCodexEntriesCache.find(e => e.id === id); if (!entry) return;
    const modal = document.getElementById('codex-fullscreen-reader');
    document.getElementById('reader-category-badge').innerText = (entry.category || 'LORE').toUpperCase();
    document.getElementById('reader-title').innerText = entry.title;
    document.getElementById('reader-subtitle').innerText = (entry.subtitle || '').replace(/\|\s*LINK:.+/, '').trim() || 'UNCLASSIFIED RECORD';
    document.getElementById('reader-body-content').innerText = entry.content || 'No narrative content recorded.';
    
    const actionBar = document.getElementById('reader-doc-action-bar');
    if (entry.doc_data && entry.doc_name) {
        actionBar.style.display = 'block';
        actionBar.innerHTML = `<button class="btn-reveal" onclick="window.openCodexAttachment('${entry.id}')" style="width:auto; font-size:11px; padding:6px 16px;">📥 OPEN / DOWNLOAD ATTACHED DOCUMENT (${entry.doc_name})</button>`;
    } else { actionBar.style.display = 'none'; }
    modal.style.display = 'block';
};

window.closeCodexFullscreen = function() { document.getElementById('codex-fullscreen-reader').style.display = 'none'; };

window.openCodexAttachment = function(id) {
    const entry = globalCodexEntriesCache.find(e => e.id === id); if (!entry || !entry.doc_data) return;
    if (entry.doc_type === 'image' || entry.doc_type === 'pdf') {
        const win = window.open(); win.document.write(`<iframe src="${entry.doc_data}" frameborder="0" style="border:0; top:0; left:0; bottom:0; right:0; width:100%; height:100%;" allowfullscreen></iframe>`);
    } else {
        const blob = new Blob([entry.doc_data], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = entry.doc_name || 'document.txt'; a.click(); URL.revokeObjectURL(url);
    }
};

window.removeCodexAttachmentFromForm = function() {
    document.getElementById('new-codex-doc-name').value = ''; document.getElementById('new-codex-doc-data').value = ''; document.getElementById('new-codex-doc-type').value = '';
    document.getElementById('codex-current-doc-wrapper').style.display = 'none'; document.getElementById('codex-file-label').innerText = 'Click to upload / replace .txt, .md, .pdf, or image';
};

/* --- MODULE C: FOG OF WAR (DRADIS SCANNING) --- */
window.executeDradisScan = async function(sysId) {
    let s = globalDbSystemsCache.find(x => x.id === sysId) || globalProceduralSystemsCache.find(x => x.id === sysId);
    if (!s) return;
    
    let bodies = window.getSystemBodies ? window.getSystemBodies(s).length : 2;
    let scanHours = 2 + bodies; 
    
    if (window.AudioEngine) window.AudioEngine.playPing();
    
    let oldTime = window.universeTimeHours; window.universeTimeHours += scanHours;
    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay(); await window.processTimeAdvancement(oldTime, window.universeTimeHours);

    if (window.scannedSystems && !window.scannedSystems.includes(sysId)) {
        window.scannedSystems.push(sysId);
        localStorage.setItem('odyssey_scanned', JSON.stringify(window.scannedSystems));
    }

    await db.from('chat_logs').insert({ sender_id: 'system', content: `📡 [DRADIS SWEEP] Task Force Black completed a deep scan of '${s.name}'. Operation took ${scanHours} hours. Orbital census uploaded to mainframe. [SYS_SCAN:${sysId}]`, message_type: 'text' });
    
    let unlockedLore = globalCodexEntriesCache.filter(e => (e.subtitle || '').includes(`LINK:${sysId}`));
    if (unlockedLore.length > 0) {
        await db.from('chat_logs').insert({ sender_id: 'system', content: `📖 [INTEL DECRYPTED] DRADIS sweep recovered hidden data caches. New Codex entries unlocked.`, message_type: 'text' });
    }

    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    if (typeof window.renderCodexMatrix === 'function') window.renderCodexMatrix();
};

/* --- NOTES & CAMPAIGN OBJECTIVES --- */
window.addCampaignObjective = async function() {
    const title = document.getElementById('new-obj-title').value; const description = document.getElementById('new-obj-desc').value;
    if (!title) return;
    await db.from('campaign_objectives').insert({ title, description, completed: false });
    document.getElementById('new-obj-title').value = ''; document.getElementById('new-obj-desc').value = '';
    if (typeof loadCampaignObjectives === 'function') loadCampaignObjectives();
};

window.toggleObjectiveComplete = async function(id, currentStatus) { await db.from('campaign_objectives').update({ completed: !currentStatus }).eq('id', id); if (typeof loadCampaignObjectives === 'function') loadCampaignObjectives(); };
window.deleteCampaignObjective = async function(id) { if (!(await window.showConfirmModal("Delete objective?"))) return; await db.from('campaign_objectives').delete().eq('id', id); if (typeof loadCampaignObjectives === 'function') loadCampaignObjectives(); };

window.renderCampaignObjectives = function() {
    const container = document.getElementById('objectives-list-container'); if (!container) return;
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
    const title = document.getElementById('term-note-title').value; const content = document.getElementById('term-note-content').value; const scope = document.getElementById('term-note-scope').value;
    if (!title) return;
    if (editingNoteId) {
        await db.from('player_notes').update({ title, content, share_scope: scope }).eq('id', editingNoteId); editingNoteId = null; document.getElementById('btn-create-note').innerText = "+ CREATE NOTE";
    } else { await db.from('player_notes').insert({ author_id: currentUserId, title, content, share_scope: scope, target_id: 'general' }); }
    document.getElementById('term-note-title').value = ''; document.getElementById('term-note-content').value = '';
    if (typeof loadPlayerNotes === 'function') loadPlayerNotes();
};

window.editNote = function(id) {
    let n = playerNotesList.find(x => x.id === id); if(!n) return; editingNoteId = id;
    document.getElementById('term-note-title').value = n.title; document.getElementById('term-note-content').value = n.content; document.getElementById('term-note-scope').value = n.share_scope;
    document.getElementById('btn-create-note').innerText = "UPDATE NOTE";
};

window.deleteNote = async function(id) {
    if(!(await window.showConfirmModal("Permanently delete this note?"))) return; await db.from('player_notes').delete().eq('id', id);
    if(editingNoteId === id) { editingNoteId = null; document.getElementById('btn-create-note').innerText = "+ CREATE NOTE"; document.getElementById('term-note-title').value = ''; document.getElementById('term-note-content').value = ''; }
    if (typeof loadPlayerNotes === 'function') loadPlayerNotes();
};

window.renderTerminalNotes = function() {
    const container = document.getElementById('term-notes-list-container'); if (!container) return;
    let html = '';
    playerNotesList.forEach(n => {
        if (n.author_id !== currentUserId && n.share_scope === 'private' && currentUserRole !== 'dm') return;
        const isMine = n.author_id === currentUserId; const isAudit = !isMine && n.share_scope === 'private' && currentUserRole === 'dm';
        let auditTag = isAudit ? `<span style="color:#ff3333; font-size:9px; margin-left:6px;">[OVERSEER AUDIT]</span>` : '';
        html += `
            <div class="note-card" style="border-color:${isAudit ? '#ff3333' : '#3c4e36'};">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <strong style="color:#00e5a3; font-size:11px;">${n.title} ${auditTag}</strong>
                    <div style="display:flex; gap:4px;">
                        <button class="layer-edit" onclick="window.openNoteFullscreen('${n.id}')" style="font-size:8px;">⛶ FULL</button>
                        ${isMine || currentUserRole === 'dm' ? `<button class="layer-edit" onclick="window.editNote('${n.id}')" style="font-size:8px;">Edit</button><button class="layer-del" onclick="window.deleteNote('${n.id}')" style="font-size:8px;">X</button>` : ''}
                    </div>
                </div>
                <p style="margin:4px 0 2px 0; font-size:10px; color:#d4c5a9; white-space:pre-wrap; max-height:40px; overflow:hidden; text-overflow:ellipsis;">${n.content || ''}</p>
                <span style="font-size:9px; color:#6b826a;">Scope: ${n.share_scope.toUpperCase()} | Author: ${allProfiles.find(p=>p.id===n.author_id)?.username || 'Unknown'}</span>
            </div>
        `;
    });
    container.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No notes recorded.</span>';
};

window.openNoteFullscreen = function(id) {
    let n = playerNotesList.find(x => x.id === id); if (!n) return;
    const modal = document.getElementById('codex-fullscreen-reader');
    document.getElementById('reader-category-badge').innerText = `INTEL LOG // ${(allProfiles.find(p=>p.id===n.author_id)?.username || 'Unknown').toUpperCase()}`;
    document.getElementById('reader-title').innerText = n.title;
    const isAudit = n.author_id !== currentUserId && n.share_scope === 'private' && currentUserRole === 'dm';
    document.getElementById('reader-subtitle').innerText = `Security Scope: ${n.share_scope.toUpperCase()}` + (isAudit ? ` [OVERSEER AUDIT BYPASS]` : '');
    document.getElementById('reader-body-content').innerText = n.content || 'No narrative content recorded.';
    document.getElementById('reader-doc-action-bar').style.display = 'none';
    modal.style.display = 'block';
};

/* --- COMMS & CHAT: MULTI-TAB ARCHITECTURE WITH PER-TAB PAGINATION ---
   Two persistent tabs (General Broadcast, Dice Streamer) plus one dynamic
   tab per DM conversation partner. Tab keys: 'general', 'dice', 'pm:<userId>'.
   Each channel has its OWN row limit fetched separately (see loadChatLogs /
   loadDiceLogs / loadPmLogs in db.js) so a busy Dice Streamer can't crowd
   General or PM history out of a shared cap. Dice and PM threads lazy-load
   the first time their tab is opened. Closing a PM tab is a local-only
   preference — it never touches the underlying conversation, and the tab
   auto-reopens the moment a new incoming message arrives on it. */
window.activeCommsTab = 'general';
window.closedPmTabs = new Set(JSON.parse(localStorage.getItem('odyssey_closed_pm_tabs') || '[]'));
window.commsUnread = {};

function persistClosedPmTabs() {
    localStorage.setItem('odyssey_closed_pm_tabs', JSON.stringify(Array.from(window.closedPmTabs)));
}

window.renderCommsTabBar = function() {
    const bar = document.getElementById('comms-tabs-bar'); if (!bar) return;
    let html = '';
    html += `<button class="comms-tab-btn ${window.activeCommsTab === 'general' ? 'active' : ''} ${window.commsUnread['general'] ? 'unread' : ''}" onclick="window.switchCommsTab('general')">General</button>`;
    html += `<button class="comms-tab-btn ${window.activeCommsTab === 'dice' ? 'active' : ''} ${window.commsUnread['dice'] ? 'unread' : ''}" onclick="window.switchCommsTab('dice')">🎲 Dice Streamer</button>`;

    window.pmPartnerIds.forEach(uid => {
        if (window.closedPmTabs.has(uid)) return;
        const key = `pm:${uid}`;
        const prof = allProfiles.find(p => p.id === uid);
        const name = prof ? (prof.username || 'Commander') : 'Unknown';
        html += `<button class="comms-tab-btn ${window.activeCommsTab === key ? 'active' : ''} ${window.commsUnread[key] ? 'unread' : ''}" onclick="window.switchCommsTab('${key}')">🔒 ${name}<span class="comms-tab-close" title="Close (keeps the conversation, just hides the tab)" onclick="event.stopPropagation(); window.closePmTab('${uid}')">✕</span></button>`;
    });

    bar.innerHTML = html;
};

window.switchCommsTab = async function(tabKey) {
    window.activeCommsTab = tabKey;
    window.commsUnread[tabKey] = false;
    window.renderCommsTabBar();

    // Lazy-load this channel's own history the first time it's opened.
    if (tabKey === 'dice' && !window.diceLogsList) { await loadDiceLogs(); }
    else if (tabKey.startsWith('pm:')) {
        const pid = tabKey.slice(3);
        if (!window.pmLogsCache[pid]) { await loadPmLogs(pid); }
    }

    window.renderChatFeed();
    const input = document.getElementById('comms-message-input');
    if (input) {
        const isDice = tabKey === 'dice';
        input.disabled = isDice;
        input.placeholder = isDice ? 'Dice Streamer is a read-only log...' : 'Transmit message...';
    }
};

window.closePmTab = function(userId) {
    window.closedPmTabs.add(userId);
    persistClosedPmTabs();
    if (window.activeCommsTab === `pm:${userId}`) window.switchCommsTab('general');
    else window.renderCommsTabBar();
};

window.startNewPmTab = function(userId) {
    if (!userId) return;
    window.pmPartnerIds.add(userId);
    window.closedPmTabs.delete(userId);
    persistClosedPmTabs();
    window.switchCommsTab(`pm:${userId}`);
    const select = document.getElementById('comms-recipient');
    if (select) select.value = '';
};

// Single choke point for adding a message into local state, used both for
// optimistic updates right after sending and for realtime-delivered rows.
// Dedupes by row id so a message never gets double-appended if both paths
// see it (e.g. Realtime not enabled yet, or a slow round trip).
window.appendLocalChatLog = function(log) {
    if (!log || log.id === undefined) return;
    const alreadyIn = (arr) => arr && arr.some(l => l.id === log.id);

    let tabKey = 'general';
    if (log.message_type === 'roll') {
        tabKey = 'dice';
        if (window.diceLogsList && !alreadyIn(window.diceLogsList)) window.diceLogsList.push(log);
    } else if (log.recipient_id) {
        const partnerId = log.sender_id === currentUserId ? log.recipient_id : log.sender_id;
        tabKey = `pm:${partnerId}`;
        window.pmPartnerIds.add(partnerId);
        if (log.sender_id !== currentUserId && window.closedPmTabs.has(partnerId)) {
            window.closedPmTabs.delete(partnerId); // an incoming message reopens a closed tab
            persistClosedPmTabs();
        }
        if (window.pmLogsCache[partnerId] && !alreadyIn(window.pmLogsCache[partnerId])) window.pmLogsCache[partnerId].push(log);
    } else {
        if (!alreadyIn(chatLogsList)) { chatLogsList.push(log); window.checkSysScan(log); }
    }

    if (tabKey === window.activeCommsTab) {
        window.renderChatFeed();
    } else {
        if (log.sender_id !== currentUserId) {
            window.commsUnread[tabKey] = true;
            if (window.AudioEngine) window.AudioEngine.playPing();
        }
        window.renderCommsTabBar();
    }
};

// Realtime handler — see initChatRealtimeChannel() in db.js.
window.handleIncomingChatLog = function(newLog) {
    if (!newLog) return;
    // Only messages I'm actually party to: global (no recipient), or ones
    // where I'm the sender or the recipient.
    if (newLog.recipient_id && newLog.recipient_id !== currentUserId && newLog.sender_id !== currentUserId) return;
    window.appendLocalChatLog(newLog);
};

window.sendChatMessage = async function() {
    const input = document.getElementById('comms-message-input'); const content = input.value.trim(); if (!content) return;
    const tab = window.activeCommsTab;
    if (tab === 'dice') return; // read-only stream, not a chat room

    const recipientId = tab.startsWith('pm:') ? tab.slice(3) : null;
    const { data, error } = await db.from('chat_logs').insert({ sender_id: currentUserId, content: content, message_type: 'text', recipient_id: recipientId }).select().single();
    input.value = '';
    if (!error && data) window.appendLocalChatLog(data);
};

window.broadcastRoll = async function(title, breakdownText, totalSum) {
    const { data, error } = await db.from('chat_logs').insert({ sender_id: currentUserId, content: `Rolled ${title}: ${totalSum}`, message_type: 'roll', recipient_id: null, roll_data: { breakdown: breakdownText } }).select().single();
    if (!error && data) window.appendLocalChatLog(data);
};

window.renderChatFeed = function() {
    const feed = document.getElementById('comms-chat-feed'); if (!feed) return;
    window.renderCommsTabBar();
    const tab = window.activeCommsTab;
    let source = [];
    if (tab === 'general') source = chatLogsList;
    else if (tab === 'dice') source = window.diceLogsList || [];
    else if (tab.startsWith('pm:')) source = window.pmLogsCache[tab.slice(3)] || [];

    let html = '';
    source.forEach(log => {
        const sender = allProfiles.find(p => p.id === log.sender_id); const senderName = sender ? (sender.username || 'Commander') : 'Unknown';
        const isDM = !!log.recipient_id; let headerColor = isDM ? '#c778dd' : '#00e5a3'; let prefix = isDM ? '🔒 [PRIVATE]' : '🌐';
        if (log.sender_id === 'system') { headerColor = '#6b826a'; prefix = '⚙️'; }
        if (log.message_type === 'roll') { headerColor = '#ff6b6b'; prefix = '🎲 [ROLL]'; }
        if (log.message_type === 'ping') { headerColor = '#00e1ff'; prefix = '📍 [PING]'; }
        let contentHTML = log.content;
        if (log.message_type === 'roll' && log.roll_data) { contentHTML = `<strong style="font-size:12px;">${log.content}</strong><br><span style="font-size:9px; color:#6b826a;">${log.roll_data.breakdown}</span>`; }
        if (log.message_type === 'ping' && log.roll_data) { contentHTML = `${log.content} <button class="layer-edit" onclick="window.jumpToPingLocation(${log.roll_data.x}, ${log.roll_data.y})" style="padding:2px 8px; font-size:9px; margin-left:6px;">JUMP TO LOCATION</button>`; }
        html += `<div style="background: rgba(6,9,7,0.6); padding: 6px; border-left: 2px solid ${headerColor}; border-radius: 2px;"><div style="font-size: 9px; color: ${headerColor}; margin-bottom: 2px;">${prefix} <strong>${log.sender_id === 'system' ? 'SYSTEM' : senderName}</strong></div><div style="font-size: 11px; color: #d4c5a9;">${contentHTML}</div></div>`;
    });
    feed.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No messages in this channel yet.</span>';
    feed.scrollTop = feed.scrollHeight;
};

window.populateCommsRecipients = function() {
    const select = document.getElementById('comms-recipient'); if (!select) return;
    let html = '<option value="">+ New DM...</option>';
    allProfiles.forEach(p => { if (p.id !== currentUserId) { html += `<option value="${p.id}">${p.username || 'Commander'}</option>`; } });
    select.innerHTML = html;
};

/* --- FILE UPLOAD ENGINE --- */
function initFileHandlers() {
    const avatarDropzone = document.getElementById('avatar-dropzone'); const avatarInput = document.getElementById('avatar-file-input');
    const avatarPreview = document.getElementById('my-terminal-avatar-preview'); const hiddenAvatarInput = document.getElementById('term-avatar');

    if (avatarDropzone && avatarInput) {
        avatarDropzone.addEventListener('click', () => avatarInput.click());
        avatarDropzone.addEventListener('dragover', (e) => { e.preventDefault(); avatarDropzone.style.borderColor = '#00e5a3'; });
        avatarDropzone.addEventListener('dragleave', () => { avatarDropzone.style.borderColor = '#3c4e36'; });
        avatarDropzone.addEventListener('drop', (e) => { e.preventDefault(); avatarDropzone.style.borderColor = '#3c4e36'; if (e.dataTransfer.files && e.dataTransfer.files[0]) processAvatarFile(e.dataTransfer.files[0]); });
        avatarInput.addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) processAvatarFile(e.target.files[0]); });
    }

    function processAvatarFile(file) {
        if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
        const reader = new FileReader();
        reader.onload = function (event) {
            const img = new Image();
            img.onload = function () {
                const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d');
                const maxDim = 256; let width = img.width; let height = img.height;
                if (width > height) { if (width > maxDim) { height *= maxDim / width; width = maxDim; } } else { if (height > maxDim) { width *= maxDim / height; height = maxDim; } }
                canvas.width = width; canvas.height = height; ctx.drawImage(img, 0, 0, width, height);
                const compressedBase64 = canvas.toDataURL('image/jpeg', 0.85);
                avatarPreview.src = compressedBase64; hiddenAvatarInput.value = compressedBase64; document.getElementById('dropzone-label').innerText = '✓ Image Loaded';
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    }

    const codexDropzone = document.getElementById('codex-file-dropzone'); const codexFileInput = document.getElementById('codex-file-input');
    if (codexDropzone && codexFileInput) {
        codexDropzone.addEventListener('click', () => codexFileInput.click());
        codexDropzone.addEventListener('dragover', (e) => { e.preventDefault(); codexDropzone.style.borderColor = '#00e5a3'; });
        codexDropzone.addEventListener('dragleave', () => { codexDropzone.style.borderColor = '#ff6b6b'; });
        codexDropzone.addEventListener('drop', (e) => { e.preventDefault(); codexDropzone.style.borderColor = '#ff6b6b'; if (e.dataTransfer.files && e.dataTransfer.files[0]) processCodexDoc(e.dataTransfer.files[0]); });
        codexFileInput.addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) processCodexDoc(e.target.files[0]); });
    }

    function processCodexDoc(file) {
        const isImage = file.type.startsWith('image/'); const isPDF = file.type === 'application/pdf';
        const docNameInput = document.getElementById('new-codex-doc-name'); const docDataInput = document.getElementById('new-codex-doc-data'); const docTypeInput = document.getElementById('new-codex-doc-type');
        docNameInput.value = file.name;
        if (isImage || isPDF) {
            docTypeInput.value = isImage ? 'image' : 'pdf';
            const reader = new FileReader();
            reader.onload = (e) => { docDataInput.value = e.target.result; document.getElementById('codex-file-label').innerText = `✓ Loaded: ${file.name}`; document.getElementById('codex-current-doc-wrapper').style.display = 'block'; document.getElementById('codex-current-doc-name').innerText = `📎 ${file.name}`; };
            reader.readAsDataURL(file);
        } else {
            docTypeInput.value = 'text';
            const reader = new FileReader();
            reader.onload = (e) => { docDataInput.value = e.target.result; document.getElementById('codex-file-label').innerText = `✓ Loaded Document: ${file.name}`; document.getElementById('codex-current-doc-wrapper').style.display = 'block'; document.getElementById('codex-current-doc-name').innerText = `📎 ${file.name}`; };
            reader.readAsText(file);
        }
    }
}
document.addEventListener('DOMContentLoaded', initFileHandlers);

/* --- CARTOGRAPHY MANAGERS (TERRITORIES & ROUTES) --- */
window.populateTerritoryFactionSelect = function() {
    const select = document.getElementById('territory-faction-select');
    if (!select) return;
    let html = '<option value="">-- No Faction / Neutral --</option>';
    const factions = globalCodexEntriesCache.filter(e => e.category === 'factions');
    factions.forEach(f => { html += `<option value="${f.title}">${f.title}</option>`; });
    select.innerHTML = html;
};

window.renderTerritoryList = function() {
    const container = document.getElementById('territory-list-container');
    if (!container) return;
    let html = '';
    globalTerritoriesCache.forEach(t => {
        let isHidden = t.faction_name && t.faction_name.includes('[HIDDEN]');
        let displayFaction = t.faction_name ? t.faction_name.replace('[HIDDEN] ', '').replace('[HIDDEN]', '') : 'None';
        
        html += `
            <div class="note-card" style="border-left: 3px solid ${t.color}; padding: 6px; margin-bottom: 4px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong style="color: ${t.color}; font-size: 11px;">${t.name}</strong><br>
                        <span style="font-size: 9px; color: #6b826a;">Faction: ${displayFaction}</span>
                    </div>
                    <div style="display: flex; gap: 4px;">
                        ${currentUserRole === 'dm' ? `
                        <button class="layer-edit" onclick="window.toggleTerritoryVisibility('${t.id}', ${isHidden})" style="font-size: 9px; padding: 2px 4px;">${isHidden ? '👁️ Unhide' : '🌫️ Hide'}</button>
                        <button class="layer-del" onclick="window.deleteTerritory('${t.id}')" style="font-size: 9px; padding: 2px 4px;">✕</button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    });
    container.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No active territories.</span>';
};

window.toggleTerritoryVisibility = async function(id, currentlyHidden) {
    if (currentUserRole !== 'dm') return;
    const t = globalTerritoriesCache.find(x => x.id === id);
    if (!t) return;
    
    let newFaction = t.faction_name || '';
    if (currentlyHidden) {
        newFaction = newFaction.replace('[HIDDEN] ', '').replace('[HIDDEN]', '');
    } else {
        newFaction = '[HIDDEN] ' + newFaction;
    }
    
    await db.from('territories').update({ faction_name: newFaction }).eq('id', id);
    if (typeof loadTerritories === 'function') loadTerritories();
};

window.deleteTerritory = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Permanently erase this territory border?"))) return;
    await db.from('territories').delete().eq('id', id);
    if (typeof loadTerritories === 'function') loadTerritories();
};

window.renderHyperlaneList = function() {
    const container = document.getElementById('hyperlane-list-container');
    if (!container) return;
    let html = '';
    globalHyperlanesCache.forEach(h => {
        html += `
            <div class="note-card" style="border-left: 3px solid ${h.color || '#00e1ff'}; padding: 6px; margin-bottom: 4px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong style="color: ${h.color || '#00e1ff'}; font-size: 11px;">Trade Route (${h.nodes?.length || 0} Jumps)</strong>
                    ${currentUserRole === 'dm' ? `<button class="layer-del" onclick="window.deleteHyperlane('${h.id}')" style="font-size: 9px; padding: 2px 4px;">✕</button>` : ''}
                </div>
            </div>
        `;
    });
    container.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No active routes.</span>';
};

window.deleteHyperlane = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Permanently erase this trade route?"))) return;
    await db.from('hyperlanes').delete().eq('id', id);
    if (typeof loadHyperlanes === 'function') loadHyperlanes();
};
