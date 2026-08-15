/* ==========================================================================
   js/ui.js - Interface, Layout, Time & Menus
   ========================================================================== */

/* --- CALENDAR & TIME ENGINE --- */
// Globals explicitly attached to window to prevent cross-file scoping dead zones
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
        avatarDropzone.addEventListener('drop', (e) => { e.preventDefault(); avatarDropzone.style.borderColor = '#3c4e36'; if (e.dataTransfer.files && e.dataTransfer.files[0]) processAvatarFile(e.dataTransfer.files[0]); });
        avatarInput.addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) processAvatarFile(e.target.files[0]); });
    }

    function processAvatarFile(file) {
        if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
        const reader = new FileReader();
        reader.onload = function (event) {
            const img = new Image();
            img.onload = function () {
                const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); const maxDim = 256;
                let width = img.width; let height = img.height;
                if (width > height) { if (width > maxDim) { height *= maxDim / width; width = maxDim; } } else { if (height > maxDim) { width *= maxDim / height; height = maxDim; } }
                canvas.width = width; canvas.height = height; ctx.drawImage(img, 0, 0, width, height);
                const compressedBase64 = canvas.toDataURL('image/jpeg', 0.85);
                avatarPreview.src = compressedBase64; hiddenAvatarInput.value = compressedBase64;
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
        codexDropzone.addEventListener('drop', (e) => { e.preventDefault(); codexDropzone.style.borderColor = '#ff6b6b'; if (e.dataTransfer.files && e.dataTransfer.files[0]) processCodexDoc(e.dataTransfer.files[0]); });
        codexFileInput.addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) processCodexDoc(e.target.files[0]); });
    }

    function processCodexDoc(file) {
        const isImage = file.type.startsWith('image/'); const isPDF = file.type === 'application/pdf';
        const docNameInput = document.getElementById('new-codex-doc-name'); const docDataInput = document.getElementById('new-codex-doc-data'); const docTypeInput = document.getElementById('new-codex-doc-type');
        const label = document.getElementById('codex-file-label'); const currentDocWrapper = document.getElementById('codex-current-doc-wrapper'); const currentDocName = document.getElementById('codex-current-doc-name');

        docNameInput.value = file.name;
        if (isImage || isPDF) {
            docTypeInput.value = isImage ? 'image' : 'pdf';
            const reader = new FileReader();
            reader.onload = (e) => {
                docDataInput.value = e.target.result; label.innerText = `✓ Loaded ${docTypeInput.value.toUpperCase()}: ${file.name}`;
                currentDocWrapper.style.display = 'block'; currentDocName.innerText = `📎 ${file.name} (${docTypeInput.value.toUpperCase()})`;
            };
            reader.readAsDataURL(file);
        } else {
            docTypeInput.value = 'text';
            const reader = new FileReader();
            reader.onload = (e) => {
                docDataInput.value = e.target.result; label.innerText = `✓ Loaded Document: ${file.name}`;
                currentDocWrapper.style.display = 'block'; currentDocName.innerText = `📎 ${file.name} (TEXT/MD)`;
            };
            reader.readAsText(file);
        }
    }
}
document.addEventListener('DOMContentLoaded', initFileHandlers);
