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

/* --- REORDERABLE LISTS (personal, per-browser, up/down arrows) ---
   Player-requested: manual reordering across the Command Terminal's lists,
   mobile-friendly (up/down buttons, not drag-and-drop). Confirmed design:
   PERSONAL preference only — stored in this browser's localStorage, never
   synced to the DB. No risk of two players' (or a player's and the DM's)
   reordering fighting over one shared list, and no schema/migration needed
   across the ~8 affected tables.

   This module only covers lists backed by rows with a real, stable `id`
   (ship templates, perk definitions, colonies, fleet groups, codex entries,
   campaign objectives, notes, arsenal weapons). A couple of lists elsewhere
   (cargo manifest items, ship deck items in combat.js) are plain JSONB
   arrays with no stable per-item id — those use direct index-swap-and-save
   to the DB instead, right next to their existing add/remove/edit logic,
   since for them the array order already IS the persisted data.

   Usage pattern per list (see colonies.js/ship-designer.js/etc for examples):
     1. In the render function: const ordered = window.applySavedOrder('mykey', myList);
        ...iterate `ordered` instead of the raw list...
        ...include `${window.renderReorderArrows('mykey', ordered, item.id, 'moveMyListOrder')}` in each row...
     2. Add a small wrapper: window.moveMyListOrder = function(id, dir) {
          window.moveListItem('mykey', window.applySavedOrder('mykey', myList), id, dir);
          window.renderMyListPanel();
        };
   Use a distinct key per independently-orderable sub-list (e.g. a catalog
   split into "pending"/"approved" sections gets two keys, one per section). */
window.getSavedListOrder = function(key) {
    try { return JSON.parse(localStorage.getItem('order_' + key)) || []; } catch (e) { return []; }
};
window.saveListOrder = function(key, orderedIds) {
    localStorage.setItem('order_' + key, JSON.stringify(orderedIds));
};
// Sorts `items` (array of objects with an `id`) by this browser's saved
// order for `key`. Items with no saved position keep their original
// relative order, effectively appended after any items that do have one
// (Array.prototype.sort is stable in all modern browsers).
window.applySavedOrder = function(key, items) {
    const saved = window.getSavedListOrder(key);
    if (!saved.length) return items;
    const rank = new Map(saved.map((id, i) => [id, i]));
    return [...items].sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
        const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
        return ra - rb;
    });
};
// Moves item `id` one slot up/down within `items` (pass the same
// already-ordered array the caller is currently rendering) and persists
// the resulting order under `key`. Caller re-renders afterward.
window.moveListItem = function(key, items, id, direction) {
    const order = items.map(it => it.id);
    const i = order.indexOf(id);
    if (i === -1) return;
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    window.saveListOrder(key, order);
};
// Renders a compact up/down arrow pair for one row. `items` must be the
// same ordered array the caller is iterating over (so position, and
// disabled state at the ends, is correct). `moveFnName` is the bare name
// of a window-scoped wrapper function (called as window.<moveFnName>) that
// calls window.moveListItem then re-renders the owning panel.
window.renderReorderArrows = function(key, items, id, moveFnName) {
    const order = items.map(it => it.id);
    const i = order.indexOf(id);
    const upDisabled = i <= 0 ? 'disabled' : '';
    const downDisabled = (i === -1 || i === order.length - 1) ? 'disabled' : '';
    return `<span class="reorder-arrows">
        <button type="button" class="reorder-btn" ${upDisabled} onclick="event.stopPropagation(); window.${moveFnName}('${id}', 'up')" title="Move up">▲</button>
        <button type="button" class="reorder-btn" ${downDisabled} onclick="event.stopPropagation(); window.${moveFnName}('${id}', 'down')" title="Move down">▼</button>
    </span>`;
};

/* --- TOAST NOTIFICATIONS ---
   Same reasoning as the confirm modal above: a plain alert() for "save
   succeeded" messages has the identical browser-disable-dialogs
   vulnerability confirm() had — once a user checks "Prevent this page from
   creating additional dialogs," every subsequent alert() silently no-ops,
   and a save action that ends in a swallowed alert() can look like it did
   nothing. This is a non-blocking, self-dismissing notification that can't
   be disabled the same way. */
(function() {
    let container;
    function ensureContainer() {
        if (container) return;
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed; bottom:24px; right:24px; z-index:6000; display:flex; flex-direction:column; gap:8px; pointer-events:none;';
        document.body.appendChild(container);
    }
    window.showToast = function(message, tone) {
        ensureContainer();
        const color = tone === 'error' ? '#ff3333' : '#00e5a3';
        const toast = document.createElement('div');
        toast.style.cssText = `background:#040605; border:1px solid ${color}; color:${color}; padding:10px 16px; border-radius:2px; font-size:11px; box-shadow:0 0 12px rgba(0,229,163,0.15); opacity:0; transition:opacity 0.25s ease; max-width:320px;`;
        toast.textContent = message;
        container.appendChild(toast);
        requestAnimationFrame(() => { toast.style.opacity = '1'; });
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3200);
    };
})();

/* --- CALENDAR & TIME ENGINE ---
   Live-synced this session (was per-browser localStorage only before, with
   zero cross-client sync beyond a "hey I changed it" chat announcement —
   see the new checkpoint in the architecture doc for the full design and
   why). Source of truth is now the `campaign_clock` table (a singleton
   row, id=1, `js/db.js`'s `driveSpeeds`-adjacent constants aren't involved
   here). `window.universeTimeHours` is still the in-memory value every
   other function reads, and localStorage still gets written on every
   update as a last-known-value cache for the instant before the next
   page's async load resolves — it is NOT the source of truth anymore,
   just a display fallback. */
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
                    await db.from('chat_logs').insert({ sender_id: null, content: `⚠️ [CRITICAL] Vessel '${vessel.name}' has depleted Standard Rations. Starvation protocols active.`, message_type: 'system' });
                    if (window.AudioEngine) window.AudioEngine.playError();
                }
            }
            if (changed) { await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vessel.id); anyUpdated = true; }
        }
        
        if (anyUpdated) {
            let rationText = rationsLogged ? " Rations consumed." : "";
            await db.from('chat_logs').insert({ sender_id: null, content: `✨ [DAILY LOGISTICS] 24-hour cycle complete. Elder E-M Synthesizers recharged.${rationText}`, message_type: 'system' });
            if (window.AudioEngine) window.AudioEngine.playChime();
            if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
        }

        // Fleet Group Economy: hybrid manual-config + automatic tick — production
        // configured on a fleet group runs every daily cycle until changed.
        if (typeof window.processFleetGroupProduction === 'function') {
            await window.processFleetGroupProduction(daysPassed);
        }

        // Battlefield Salvage — Manufacturing-deck post-processing: same
        // once-daily cadence as fleet group production, converting raw
        // wreckage sitting in any ship's cargo into a DM-configured output.
        if (typeof window.processSalvageConversion === 'function') {
            await window.processSalvageConversion(daysPassed);
        }
    }

    // Battlefield Salvage — Gather timer completion check runs on EVERY
    // advancement (not just daysPassed > 0): a gather duration can be a
    // handful of hours, so it shouldn't have to wait for a full day to
    // resolve. Uses the absolute clock value directly rather than daysPassed.
    if (typeof window.processSalvageGatherCompletion === 'function') {
        await window.processSalvageGatherCompletion(newHours);
    }

    // Manufacturing Orders — same "every tick, not just daily" reasoning as
    // Battlefield Salvage's gather completion above: a build's duration can
    // be sub-day.
    if (typeof window.processManufacturingOrders === 'function') {
        await window.processManufacturingOrders(newHours);
    }
};

// Small shared helper — every write path below ends by applying the same
// button-state refresh, so this stays in one place instead of five.
function syncTimeFlowButton() {
    const btn = document.getElementById('time-flow-btn');
    if (btn) { btn.innerText = window.timeFlowActive ? '⏸ PAUSE FLOW' : '▶ RESUME FLOW'; btn.style.borderColor = window.timeFlowActive ? '#3c4e36' : '#00e5a3'; }
}

window.initCalendarEngine = async function() {
    // Load (and, if needed, seed/bootstrap) the shared campaign_clock row.
    // This browser's own pre-sync localStorage value is only used as a
    // fallback seed if the row doesn't exist yet at all, or (DM only, one
    // time) to become the new shared truth per the DM's own confirmed
    // choice — see the block comment below.
    const localSeedHours = window.universeTimeHours;
    let clockRow = null;
    try {
        const { data } = await db.from('campaign_clock').select('*').eq('id', 1).maybeSingle();
        clockRow = data;
    } catch (e) { /* falls through to the localStorage-only fallback below */ }

    if (!clockRow) {
        const { data: inserted } = await db.from('campaign_clock').insert({ id: 1, universe_time_hours: localSeedHours, time_flow_active: false }).select().maybeSingle();
        clockRow = inserted;
    } else if (currentUserRole === 'dm' && localStorage.getItem('odyssey_clock_migrated_to_shared') !== 'true') {
        // One-time migration bootstrap, DM only: per the DM's own confirmed
        // choice, THIS browser's currently-displayed local time becomes the
        // new shared truth for the whole table — overriding whatever the
        // table was left at (its own default, or another player's earlier
        // insert-fallback above). Gated by a localStorage flag so it only
        // ever fires once per browser, not on every reload — otherwise a
        // stale local snapshot could keep clobbering real shared progress.
        const { data: updated } = await db.from('campaign_clock').update({ universe_time_hours: localSeedHours }).eq('id', 1).select().maybeSingle();
        clockRow = updated || clockRow;
    }
    localStorage.setItem('odyssey_clock_migrated_to_shared', 'true');

    if (clockRow) {
        window.universeTimeHours = clockRow.universe_time_hours;
        window.timeFlowActive = clockRow.time_flow_active;
    }
    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay();
    syncTimeFlowButton();

    // Realtime mirror: every client (DM and players alike) just reflects
    // whatever the table says — NOT re-running processTimeAdvancement here.
    // Whichever client's own action caused the change already ran that
    // locally, exactly once, before writing to the DB (see adjustTime /
    // applyManualTime / resetTimeline / the passive tick below / and
    // executePlottedJump in js/map.js). Re-running it again on every other
    // connected client on receipt would double (or N-times-over) the daily
    // tick's real DB side effects — ration consumption, fleet production,
    // salvage conversion — once per connected browser instead of once.
    db.channel('campaign_clock_stream')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'campaign_clock' }, (payload) => {
            if (!payload.new) return;
            window.universeTimeHours = payload.new.universe_time_hours;
            window.timeFlowActive = payload.new.time_flow_active;
            localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
            window.updateCalendarDisplay();
            syncTimeFlowButton();
        })
        .subscribe();

    // Passive flow tick: only the DM's own browser actually drives writes
    // (confirmed design — with a shared clock, every connected client
    // ticking independently would advance time once per connected browser
    // per interval, N times too fast). Every non-DM client's interval (and
    // any second DM browser tab) just no-ops here; they still see the
    // ticking value live via the realtime mirror above.
    window.timeFlowInterval = setInterval(async () => {
        if (currentUserRole !== 'dm' || !window.timeFlowActive) return;
        const { data, error } = await db.rpc('adjust_campaign_clock', { delta_hours: 1 });
        if (error || !data || !data[0]) return;
        const { old_hours, new_hours } = data[0];
        window.universeTimeHours = new_hours;
        localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
        window.updateCalendarDisplay();
        await window.processTimeAdvancement(old_hours, new_hours);
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

    // Delta operation — uses the atomic RPC (row-locked server-side) rather
    // than a client-computed read-then-write, so this can't race a
    // simultaneous passive tick or a player's FTL jump into a lost update.
    const { data, error } = await db.rpc('adjust_campaign_clock', { delta_hours: amount * multiplier });
    if (error || !data || !data[0]) { alert("Failed to adjust chronology: " + (error ? error.message : "unknown error")); return; }
    const { old_hours, new_hours } = data[0];

    window.universeTimeHours = new_hours;
    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay(); window.broadcastTimeSync();
    await window.processTimeAdvancement(old_hours, new_hours);
};

window.applyManualTime = async function() {
    if (currentUserRole !== 'dm') return;
    const yr = parseInt(document.getElementById('set-yr').value);
    const mo = parseInt(document.getElementById('set-mo').value) || 1;
    const da = parseInt(document.getElementById('set-da').value) || 1;
    const hr = parseInt(document.getElementById('set-hr').value) || 0;

    if (isNaN(yr)) { alert("Please enter a valid year."); return; }

    const hoursInYear = 24 * 30 * 12; const hoursInMonth = 24 * 30; const hoursInDay = 24;
    let newTime = (yr * hoursInYear) + ((mo - 1) * hoursInMonth) + ((da - 1) * hoursInDay) + hr;
    if (newTime < 0) newTime = 0;

    // Absolute set (not a delta) — "it is now exactly this date" is
    // supposed to overwrite whatever was there, so this uses a plain
    // update rather than the RPC. Reads a fresh old-value immediately
    // before writing to keep the processTimeAdvancement day-crossing math
    // accurate even if this client's own cached value had drifted.
    const { data: current } = await db.from('campaign_clock').select('universe_time_hours').eq('id', 1).maybeSingle();
    let oldTime = current ? current.universe_time_hours : window.universeTimeHours;

    const { error } = await db.from('campaign_clock').update({ universe_time_hours: newTime, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) { alert("Failed to set chronology: " + error.message); return; }

    window.universeTimeHours = newTime;
    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay(); window.broadcastTimeSync();
    await window.processTimeAdvancement(oldTime, newTime);
    alert("Chronology manually updated.");
};

window.resetTimeline = async function() {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Reset timeline back to YR 2800.01.01? This affects the shared campaign clock for everyone."))) return;

    const { data: current } = await db.from('campaign_clock').select('universe_time_hours').eq('id', 1).maybeSingle();
    let oldTime = current ? current.universe_time_hours : window.universeTimeHours;
    const newTime = 24192000;

    const { error } = await db.from('campaign_clock').update({ universe_time_hours: newTime, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) { alert("Failed to reset timeline: " + error.message); return; }

    window.universeTimeHours = newTime;
    localStorage.setItem('odyssey_universe_time', window.universeTimeHours);
    window.updateCalendarDisplay(); window.broadcastTimeSync();
    await window.processTimeAdvancement(oldTime, newTime);
};

window.toggleTimeFlow = async function() {
    if (currentUserRole !== 'dm') return;
    window.timeFlowActive = !window.timeFlowActive;
    syncTimeFlowButton();
    // Persisted so every client's realtime mirror knows flow is active —
    // matters for the passive-tick driver check in initCalendarEngine
    // above, and for any future player-facing "time is flowing" indicator.
    await db.from('campaign_clock').update({ time_flow_active: window.timeFlowActive, updated_at: new Date().toISOString() }).eq('id', 1);
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
makePanelDraggable('credits-panel', 'credits-header', 'odyssey_credits_pos');

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
    manufacturing: 'Reviewing Manufacturing',
    shipdesigner: 'Designing Vessel Profiles',
    perkdesigner: 'Designing Specializations',
    augmentdesigner: 'Designing Augmentations',
    geardesigner: 'Designing Gear',
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
    if (tabName === 'combat') { (async () => { if (!window.diceLogsList) { window.diceLogsList = []; if (typeof loadDiceLogs === 'function') await loadDiceLogs(); } if (typeof window.renderArsenalDiceFeed === 'function') window.renderArsenalDiceFeed(); })(); }
    if (tabName === 'colonies') { if (typeof window.populateFleetFormSelects === 'function') window.populateFleetFormSelects(); if (typeof window.renderColoniesPanel === 'function') window.renderColoniesPanel(); if (typeof window.renderFleetGroupsPanel === 'function') window.renderFleetGroupsPanel(); }
    if (tabName === 'manufacturing' && typeof window.renderManufacturingPanel === 'function') window.renderManufacturingPanel();
    if (tabName === 'shipdesigner' && typeof window.renderShipDesignerPanel === 'function') window.renderShipDesignerPanel();
    if (tabName === 'perkdesigner' && typeof window.renderPerkDesignerPanel === 'function') window.renderPerkDesignerPanel();
    if (tabName === 'augmentdesigner' && typeof window.renderAugmentDesignerPanel === 'function') window.renderAugmentDesignerPanel();
    if (tabName === 'geardesigner' && typeof window.renderGearDesignerPanel === 'function') window.renderGearDesignerPanel();
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

// Was called from index.html but never actually defined anywhere — the
// "COLLAPSE SIDEBAR" button did nothing. The CSS (.term-sidebar.collapsed)
// already existed, just needed the toggle wired up.
window.toggleSidebar = function() {
    const sidebar = document.getElementById('term-sidebar');
    const icon = document.getElementById('sidebar-toggle-icon');
    if (!sidebar) return;
    const collapsed = sidebar.classList.toggle('collapsed');
    if (icon) icon.innerText = collapsed ? '»' : 'COLLAPSE SIDEBAR';
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
// Not DM-gated (unlike the scratchpad above) -- attribution info is fine for anyone to see.
window.toggleCreditsPanel = function() { const panel = document.getElementById('credits-panel'); if (panel) panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; };
window.saveDmScratchpad = function() { if (currentUserRole !== 'dm') return; const val = document.getElementById('dm-scratchpad-input').value; localStorage.setItem('odyssey_dm_scratchpad', val); };

/* --- SKILLS & CHARACTER TERMINAL --- */
const skillList = [ "Athletics", "Stealth", "Survival", "Ballistic Weapons", "Energy Weapons", "Explosives", "Computers", "Engineering", "Sciences", "Mechanics", "Medical", "Speechcraft" ];
function renderSkillInputs() {
    const container = document.getElementById('skills-input-container'); if (!container) return;
    let html = '';
    skillList.forEach(skill => {
        const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_');
        html += `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:6px 8px; border-radius:2px; border:1px solid #3c4e36;">
                <span style="font-size:11px; color:#d4c5a9;">${skill}</span><input type="number" id="skill-${safeKey}" min="-100" max="100" value="0" style="width:74px; margin:0; text-align:right; font-size:13px; padding:4px 8px 4px 4px;"></div>`;
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
    setVal('term-shield-current', c.shield_current || 0); setVal('term-shield-max', c.shield_max || 0); setVal('term-dr', c.dr || 0);
    setVal('term-specialties', c.specialties || ''); setVal('term-assets', c.assets || ''); setVal('term-history', c.history || ''); setVal('term-personal-history', c.personal_history || '');

    skillList.forEach(skill => { const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_'); setVal(`skill-${safeKey}`, s[safeKey] || 0); });
    window.updateInjuryMax();
    window.updateShieldDisplay();
    if (typeof window.renderArsenal === 'function') window.renderArsenal();
    if (typeof window.renderPerksPanel === 'function') window.renderPerksPanel();
    if (typeof window.renderAugmentSlots === 'function') window.renderAugmentSlots();
    if (typeof window.renderGearLoadout === 'function') window.renderGearLoadout();
};

// Shield Max and DR are player-set base values (representing raw equipment,
// same philosophy as manually-tracked skills), with any perk bonuses (e.g.
// Special Forces Trooper) added automatically on top for display — same
// "don't make the player remember to add it" principle the roller already
// applies to skill/stat perk bonuses.
window.getEffectiveShieldMax = function(char, perksList, augmentsList, gearList) {
    let base = char.shield_max || 0;
    let bonus = 0;
    (perksList || []).forEach(cp => {
        const def = typeof window.findPerkDefinition === 'function' ? window.findPerkDefinition(cp.perk_definition_id) : null;
        if (def) bonus += (def.shield_max_bonus || 0);
    });
    (augmentsList || []).forEach(ca => {
        const def = typeof window.findAugmentDefinition === 'function' ? window.findAugmentDefinition(ca.augment_definition_id) : null;
        if (def) bonus += (def.shield_max_bonus || 0);
    });
    (gearList || []).forEach(cg => {
        if (!cg.equipped) return;
        const def = typeof window.findGearDefinition === 'function' ? window.findGearDefinition(cg.gear_definition_id) : null;
        if (def) bonus += (def.shield_max_bonus || 0);
    });
    return base + bonus;
};
window.getEffectiveDR = function(char, perksList, augmentsList, gearList) {
    let base = char.dr || 0;
    let bonus = 0;
    (perksList || []).forEach(cp => {
        const def = typeof window.findPerkDefinition === 'function' ? window.findPerkDefinition(cp.perk_definition_id) : null;
        if (def) bonus += (def.dr_bonus || 0);
    });
    (augmentsList || []).forEach(ca => {
        const def = typeof window.findAugmentDefinition === 'function' ? window.findAugmentDefinition(ca.augment_definition_id) : null;
        if (def) bonus += (def.dr_bonus || 0);
    });
    (gearList || []).forEach(cg => {
        if (!cg.equipped) return;
        const def = typeof window.findGearDefinition === 'function' ? window.findGearDefinition(cg.gear_definition_id) : null;
        if (def) bonus += (def.dr_bonus || 0);
    });
    return base + bonus;
};
// Injury Max = floor(Toughness die face value / 2) — the base tabletop rule —
// plus any injury_max_bonus from approved perks/augments (e.g. "Fully
// Synthetic +5"), same additive-bonus pattern as Shield Max/DR above. Gear
// (e.g. a uniform's "+1 injuries") is NOT a source yet — there's no
// armor/gear catalog in this schema, so a gear-granted bonus like that has
// to be modeled as a small perk or augment for now; a real gear system is a
// separate, not-yet-built feature.
window.getEffectiveInjuryMax = function(char, perksList, augmentsList, gearList) {
    const faces = parseInt(((char && char.stat_toughness) || 'd4').replace('d', '')) || 4;
    let base = Math.floor(faces / 2);
    let bonus = 0;
    (perksList || []).forEach(cp => {
        const def = typeof window.findPerkDefinition === 'function' ? window.findPerkDefinition(cp.perk_definition_id) : null;
        if (def) bonus += (def.injury_max_bonus || 0);
    });
    (augmentsList || []).forEach(ca => {
        const def = typeof window.findAugmentDefinition === 'function' ? window.findAugmentDefinition(ca.augment_definition_id) : null;
        if (def) bonus += (def.injury_max_bonus || 0);
    });
    (gearList || []).forEach(cg => {
        if (!cg.equipped) return;
        const def = typeof window.findGearDefinition === 'function' ? window.findGearDefinition(cg.gear_definition_id) : null;
        if (def) bonus += (def.injury_max_bonus || 0);
    });
    return base + bonus;
};

window.updateShieldDisplay = function() {
    const label = document.getElementById('term-shield-effective');
    if (!label) return;
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    const effMax = window.getEffectiveShieldMax(myProf.character || {}, myProf.perks, myProf.augments, myProf.gear);
    const effDR = window.getEffectiveDR(myProf.character || {}, myProf.perks, myProf.augments, myProf.gear);
    const baseMax = (myProf.character || {}).shield_max || 0;
    const baseDR = (myProf.character || {}).dr || 0;
    let bits = [];
    if (effMax !== baseMax) bits.push(`Effective Max: ${effMax} (base ${baseMax} + perks/augments/gear)`);
    if (effDR !== baseDR) bits.push(`Effective DR: ${effDR} (base ${baseDR} + perks/augments/gear)`);
    label.innerText = bits.join(' · ');
};

// "Recharge" = new encounter — shield resets to its full effective max
// (base + perk/augment/gear bonuses), matching the confirmed rule that it
// regenerates automatically between encounters rather than needing a DM
// repair action.
window.rechargeShield = async function() {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character || !myProf.character.id) { alert("Please save your Dossier & Stats once first."); return; }
    const effMax = window.getEffectiveShieldMax(myProf.character, myProf.perks, myProf.augments, myProf.gear);
    const input = document.getElementById('term-shield-current');
    if (input) input.value = effMax;
    await db.from('characters').update({ shield_current: effMax }).eq('id', myProf.character.id);
    myProf.character.shield_current = effMax;
    if (typeof window.showToast === 'function') window.showToast(`Shield recharged to ${effMax}.`);
};

// Injuries max = half the face value of whichever die is assigned to
// Toughness (per the tabletop rules), recalculating live if that die ever
// changes — was a flat 0-10 "Vitality" field that didn't track the actual
// rule at all. Now also folds in any injury_max_bonus from the player's
// approved perks/augments/equipped gear via getEffectiveInjuryMax, same as
// shield/DR.
window.updateInjuryMax = function() {
    const toughnessSel = document.getElementById('stat-toughness');
    const injuryInput = document.getElementById('term-vitality');
    const injuryLabel = document.getElementById('term-vitality-label');
    if (!toughnessSel || !injuryInput) return;
    const myProf = allProfiles.find(p => p.id === currentUserId);
    const pseudoChar = { stat_toughness: toughnessSel.value || 'd4' };
    const baseMax = Math.floor((parseInt((toughnessSel.value || 'd4').replace('d', '')) || 4) / 2);
    const max = window.getEffectiveInjuryMax(pseudoChar, myProf && myProf.perks, myProf && myProf.augments, myProf && myProf.gear);
    injuryInput.max = max;
    if (parseInt(injuryInput.value) > max) injuryInput.value = max;
    if (injuryLabel) injuryLabel.innerText = max !== baseMax ? `Injuries (0-${max}, base ${baseMax} + perks/augments/gear):` : `Injuries (0-${max}):`;
};

/* --- PERKS PANEL (Dossier tab) ---
   Section 1 is self-selected, editable anytime (honor-system table, matches
   how skill tracking already works — no hard lock). As of this session,
   Section 1 is NO LONGER single-pick: a player can hold any number of
   Section 1 specializations simultaneously (picker + ADD, each with its own
   remove button), matching the "no cap" convention Section 2 already used.
   Section 2 remains DM-awarded only, from the Crew Roster tab (see
   window.awardSection2Perk in that render function) — a player still can't
   grant Section 2 perks to themselves, and this session did not add
   player-side removal for Section 2 (out of the confirmed scope — DM awards
   are still DM-only to undo, same as before). */
window.renderPerksPanel = function() {
    const container = document.getElementById('perks-panel-container');
    if (!container) return;
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    const perks = myProf.perks || [];
    const section1 = perks.filter(p => p.section === 1);
    const section2 = perks.filter(p => p.section === 2);

    const sec1Choices = typeof window.getApprovedPerksBySection === 'function' ? window.getApprovedPerksBySection(1) : [];
    const sec1PickedIds = new Set(section1.map(p => p.perk_definition_id));
    const sec1Available = sec1Choices.filter(p => !sec1PickedIds.has(p.id));
    let sec1PickerOptions = '<option value="">— Select a Specialization —</option>';
    sec1Available.forEach(p => {
        sec1PickerOptions += `<option value="${p.id}">${p.name}</option>`;
    });

    let sec1Html = section1.length === 0 ? '<span style="font-size:10px; color:#6b826a;">None selected yet.</span>' : '';
    section1.forEach(p => {
        const def = window.findPerkDefinition(p.perk_definition_id);
        if (!def) return;
        sec1Html += `<div style="background:#030403; padding:6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:4px; display:flex; justify-content:space-between; align-items:flex-start; gap:6px;">
            <div style="flex:1;">
                <strong style="color:#00e5a3; font-size:11px;">${def.name}</strong>
                <div style="font-size:9px; color:#6b826a;">${def.description || ''}</div>
            </div>
            <button onclick="window.removeSection1Perk('${p.id}')" title="Remove specialization" style="width:auto; margin:0; padding:2px 6px; font-size:9px; border-color:#ff6b6b; color:#ff6b6b;">✕</button>
        </div>`;
    });

    let sec2Html = section2.length === 0 ? '<span style="font-size:10px; color:#6b826a;">None awarded yet.</span>' : '';
    section2.forEach(p => {
        const def = window.findPerkDefinition(p.perk_definition_id);
        if (!def) return;
        sec2Html += `<div style="background:#030403; padding:6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:4px;">
            <strong style="color:#ffaa00; font-size:11px;">${def.name}</strong>
            <div style="font-size:9px; color:#6b826a;">${def.description || ''}</div>
        </div>`;
    });

    container.innerHTML = `
        <div style="margin-top:10px; border-top:1px solid #3c4e36; padding-top:8px;">
            <label style="font-size:9px; color:#6b826a;">Section 1 Specializations (character creation pick, no cap):</label>
            <div style="margin-top:4px;">${sec1Html}</div>
            <div style="display:flex; gap:4px; margin-top:6px;">
                <label for="perk-section1-picker" style="display:none;">Add Specialization</label>
                <select id="perk-section1-picker" style="flex:1; margin:0; font-size:11px;">${sec1PickerOptions}</select>
                <button class="btn-deploy" onclick="window.addSection1Perk()" style="width:auto; margin:0; padding:4px 8px; font-size:9px;">+ ADD</button>
            </div>
        </div>
        <div style="margin-top:10px;">
            <label style="font-size:9px; color:#6b826a;">Section 2 Perks (DM-awarded, no cap):</label>
            <div style="margin-top:4px;">${sec2Html}</div>
        </div>
    `;
};

window.addSection1Perk = async function() {
    const select = document.getElementById('perk-section1-picker');
    const perkDefId = select ? select.value : null;
    if (!perkDefId) return;
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character || !myProf.character.id) { alert("Please save your Dossier & Stats once first before selecting a specialization."); return; }
    const already = (myProf.perks || []).some(p => p.section === 1 && p.perk_definition_id === perkDefId);
    if (already) return;
    const { data, error } = await db.from('character_perks').insert({ character_id: myProf.character.id, perk_definition_id: perkDefId, section: 1 }).select().single();
    if (error) { alert("Failed to save specialization: " + error.message); return; }
    myProf.perks = myProf.perks || [];
    myProf.perks.push(data);
    if (typeof window.renderPerksPanel === 'function') window.renderPerksPanel();
};

window.removeSection1Perk = async function(perkRowId) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    await db.from('character_perks').delete().eq('id', perkRowId);
    myProf.perks = (myProf.perks || []).filter(p => p.id !== perkRowId);
    if (typeof window.renderPerksPanel === 'function') window.renderPerksPanel();
};

/* --- AUGMENT SLOTS (Dossier tab, Section 5) ---
   Replaces the old 7 plain free-text fields with 7 slots, each showing its
   currently-installed augment(s) (stacking allowed, confirmed design) plus
   an install row: a picker of DM-approved augments valid for that slot,
   and an optional notes field. Installing/removing on your OWN character
   is self-service, same as Section 1 perks — no DM gate here; only the
   catalog itself (proposing/approving a definition, in Augment Designer)
   is gated. A row can be notes-only with no catalog augment picked at all,
   matching how the old free-text fields let a player type anything with
   zero mechanical backing — this is how existing pre-session data was
   migrated in (see darkforest-architecture-reference.md). */
window.renderAugmentSlots = function() {
    const container = document.getElementById('augment-slots-container');
    if (!container) return;
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    const augments = myProf.augments || [];

    let html = '';
    (window.AUGMENT_SLOT_KEYS || []).forEach(slot => {
        const label = window.AUGMENT_SLOT_LABELS[slot] || slot;
        const installed = augments.filter(ca => ca.slot === slot);
        const choices = typeof window.getApprovedAugmentsForSlot === 'function' ? window.getApprovedAugmentsForSlot(slot) : [];
        let pickerOptions = '<option value="">— No catalog augment / narrative only —</option>';
        choices.forEach(a => { pickerOptions += `<option value="${a.id}">${a.name}</option>`; });

        let installedHtml = installed.length === 0 ? '<span style="font-size:9px; color:#6b826a;">Nothing installed.</span>' : '';
        installed.forEach(ca => {
            const def = typeof window.findAugmentDefinition === 'function' ? window.findAugmentDefinition(ca.augment_definition_id) : null;
            const title = def ? def.name : (ca.notes ? '(uncatalogued)' : 'Unknown');
            installedHtml += `<div style="background:#030403; padding:5px 6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:3px; display:flex; justify-content:space-between; align-items:flex-start; gap:6px;">
                <div style="flex:1;">
                    ${def ? `<strong style="color:#00e5a3; font-size:10px;">${def.name}</strong>` : `<strong style="color:#6b826a; font-size:10px;">${title}</strong>`}
                    ${ca.notes ? `<div style="font-size:9px; color:#d4c5a9;">${ca.notes}</div>` : ''}
                </div>
                <button onclick="window.removeCharacterAugment('${ca.id}')" title="Remove" style="width:auto; margin:0; padding:2px 6px; font-size:9px; border-color:#ff6b6b; color:#ff6b6b;">✕</button>
            </div>`;
        });

        const safeSlot = slot;
        html += `<div style="margin-bottom:10px; border-top:1px solid #3c4e36; padding-top:6px;">
            <label style="font-size:9px; color:#6b826a;">${label}:</label>
            <div style="margin-top:3px;">${installedHtml}</div>
            <div style="display:flex; gap:4px; margin-top:4px;">
                <label for="aug-slot-picker-${safeSlot}" style="display:none;">Add Augment</label>
                <select id="aug-slot-picker-${safeSlot}" style="flex:1; margin:0; font-size:10px;">${pickerOptions}</select>
            </div>
            <div style="display:flex; gap:4px; margin-top:3px;">
                <label for="aug-slot-notes-${safeSlot}" style="display:none;">Notes</label>
                <input type="text" id="aug-slot-notes-${safeSlot}" placeholder="Notes (optional flavor)" style="flex:1; margin:0; font-size:10px;">
                <button class="btn-deploy" onclick="window.installAugment('${safeSlot}')" style="width:auto; margin:0; padding:4px 8px; font-size:9px;">+ INSTALL</button>
            </div>
        </div>`;
    });
    container.innerHTML = html;
};

window.installAugment = async function(slot) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character || !myProf.character.id) { alert("Please save your Dossier & Stats once first before installing an augment."); return; }
    const picker = document.getElementById(`aug-slot-picker-${slot}`);
    const notesInput = document.getElementById(`aug-slot-notes-${slot}`);
    const augmentDefId = picker && picker.value ? picker.value : null;
    const notes = notesInput ? notesInput.value.trim() : '';
    if (!augmentDefId && !notes) { alert("Pick an augment from the catalog and/or enter a note — can't install a completely empty entry."); return; }
    const { data, error } = await db.from('character_augments').insert({ character_id: myProf.character.id, slot, augment_definition_id: augmentDefId, notes: notes || null }).select().single();
    if (error) { alert("Failed to install augment: " + error.message); return; }
    myProf.augments = myProf.augments || [];
    myProf.augments.push(data);
    if (picker) picker.value = '';
    if (notesInput) notesInput.value = '';
    if (typeof window.renderAugmentSlots === 'function') window.renderAugmentSlots();
    if (typeof window.updateShieldDisplay === 'function') window.updateShieldDisplay();
    if (typeof window.updateInjuryMax === 'function') window.updateInjuryMax();
};

window.removeCharacterAugment = async function(rowId) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    await db.from('character_augments').delete().eq('id', rowId);
    myProf.augments = (myProf.augments || []).filter(ca => ca.id !== rowId);
    if (typeof window.renderAugmentSlots === 'function') window.renderAugmentSlots();
    if (typeof window.updateShieldDisplay === 'function') window.updateShieldDisplay();
    if (typeof window.updateInjuryMax === 'function') window.updateInjuryMax();
};

/* --- GEAR LOADOUT (Dossier tab, Section 4) ---
   Sits above the pre-existing free-text "Tactical Gear & Inventory" box
   (characters.assets, untouched) as a flat, unslotted list — confirmed
   design: gear doesn't get fixed slots like Body Augments do, since there's
   no anatomical (or other) fixed structure to hang them on. Each row also
   carries an `equipped` toggle (confirmed design: owned-but-stowed gear
   shouldn't contribute its bonus) — only equipped rows count in
   getGearBonusFor / shield / DR / injury max. Same self-service rule as
   Augments: installing/removing/toggling on your OWN character needs no DM
   approval; only the catalog itself is gated (Gear Designer tab). A row can
   be notes-only with no catalog gear picked at all, same as Augments. */
window.renderGearLoadout = function() {
    const container = document.getElementById('gear-loadout-container');
    if (!container) return;
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    const gear = myProf.gear || [];

    const choices = typeof window.getApprovedGear === 'function' ? window.getApprovedGear() : [];
    let pickerOptions = '<option value="">— No catalog gear / narrative only —</option>';
    choices.forEach(g => { pickerOptions += `<option value="${g.id}">${g.name}</option>`; });

    let installedHtml = gear.length === 0 ? '<span style="font-size:9px; color:#6b826a;">Nothing in your loadout.</span>' : '';
    gear.forEach(cg => {
        const def = typeof window.findGearDefinition === 'function' ? window.findGearDefinition(cg.gear_definition_id) : null;
        const title = def ? def.name : (cg.notes ? '(uncatalogued)' : 'Unknown');
        installedHtml += `<div style="background:#030403; padding:5px 6px; border:1px solid ${cg.equipped ? '#3c4e36' : '#6b826a'}; border-radius:2px; margin-bottom:3px; display:flex; justify-content:space-between; align-items:flex-start; gap:6px; ${cg.equipped ? '' : 'opacity:0.6;'}">
            <div style="flex:1;">
                ${def ? `<strong style="color:#00e5a3; font-size:10px;">${def.name}</strong>` : `<strong style="color:#6b826a; font-size:10px;">${title}</strong>`}
                ${!cg.equipped ? '<span style="font-size:8px; color:#6b826a;"> (stowed — not contributing bonuses)</span>' : ''}
                ${cg.notes ? `<div style="font-size:9px; color:#d4c5a9;">${cg.notes}</div>` : ''}
            </div>
            <div style="display:flex; gap:3px; flex-shrink:0;">
                <button onclick="window.toggleCharacterGearEquipped('${cg.id}')" title="${cg.equipped ? 'Stow' : 'Equip'}" style="width:auto; margin:0; padding:2px 6px; font-size:9px;">${cg.equipped ? 'STOW' : 'EQUIP'}</button>
                <button onclick="window.removeCharacterGear('${cg.id}')" title="Remove" style="width:auto; margin:0; padding:2px 6px; font-size:9px; border-color:#ff6b6b; color:#ff6b6b;">✕</button>
            </div>
        </div>`;
    });

    container.innerHTML = `
        <div style="margin-top:3px;">${installedHtml}</div>
        <div style="display:flex; gap:4px; margin-top:4px;">
            <label for="gear-loadout-picker" style="display:none;">Add Gear</label>
            <select id="gear-loadout-picker" style="flex:1; margin:0; font-size:10px;">${pickerOptions}</select>
        </div>
        <div style="display:flex; gap:4px; margin-top:3px;">
            <label for="gear-loadout-notes" style="display:none;">Notes</label>
            <input type="text" id="gear-loadout-notes" placeholder="Notes (optional flavor)" style="flex:1; margin:0; font-size:10px;">
            <button class="btn-deploy" onclick="window.addCharacterGear()" style="width:auto; margin:0; padding:4px 8px; font-size:9px;">+ ADD</button>
        </div>`;
};

window.addCharacterGear = async function() {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character || !myProf.character.id) { alert("Please save your Dossier & Stats once first before adding gear."); return; }
    const picker = document.getElementById('gear-loadout-picker');
    const notesInput = document.getElementById('gear-loadout-notes');
    const gearDefId = picker && picker.value ? picker.value : null;
    const notes = notesInput ? notesInput.value.trim() : '';
    if (!gearDefId && !notes) { alert("Pick a gear item from the catalog and/or enter a note — can't add a completely empty entry."); return; }
    const { data, error } = await db.from('character_gear').insert({ character_id: myProf.character.id, gear_definition_id: gearDefId, notes: notes || null, equipped: true }).select().single();
    if (error) { alert("Failed to add gear: " + error.message); return; }
    myProf.gear = myProf.gear || [];
    myProf.gear.push(data);
    if (picker) picker.value = '';
    if (notesInput) notesInput.value = '';
    if (typeof window.renderGearLoadout === 'function') window.renderGearLoadout();
    if (typeof window.updateShieldDisplay === 'function') window.updateShieldDisplay();
    if (typeof window.updateInjuryMax === 'function') window.updateInjuryMax();
};

window.toggleCharacterGearEquipped = async function(rowId) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    const row = (myProf.gear || []).find(cg => cg.id === rowId);
    if (!row) return;
    const newVal = !row.equipped;
    const { error } = await db.from('character_gear').update({ equipped: newVal }).eq('id', rowId);
    if (error) { alert("Failed to update gear: " + error.message); return; }
    row.equipped = newVal;
    if (typeof window.renderGearLoadout === 'function') window.renderGearLoadout();
    if (typeof window.updateShieldDisplay === 'function') window.updateShieldDisplay();
    if (typeof window.updateInjuryMax === 'function') window.updateInjuryMax();
};

window.removeCharacterGear = async function(rowId) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    await db.from('character_gear').delete().eq('id', rowId);
    myProf.gear = (myProf.gear || []).filter(cg => cg.id !== rowId);
    if (typeof window.renderGearLoadout === 'function') window.renderGearLoadout();
    if (typeof window.updateShieldDisplay === 'function') window.updateShieldDisplay();
    if (typeof window.updateInjuryMax === 'function') window.updateInjuryMax();
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
        shield_current: parseInt(safeGet('term-shield-current')) || 0, shield_max: parseInt(safeGet('term-shield-max')) || 0, dr: parseInt(safeGet('term-dr')) || 0,
        specialties: safeGet('term-specialties'), assets: safeGet('term-assets'), history: safeGet('term-history'), personal_history: safeGet('term-personal-history')
        // aug_head/aug_torso/aug_larm/aug_rarm/aug_lleg/aug_rleg/aug_internal deliberately
        // omitted -- those 7 columns are superseded by the character_augments table
        // (Augment Designer build) and their DOM inputs no longer exist. Leaving them
        // out of this payload means the upsert never touches those columns again, so
        // the pre-migration legacy text stays exactly as backfilled rather than being
        // blanked out on the next save.
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
    if (typeof window.updateShieldDisplay === 'function') window.updateShieldDisplay();
    if (typeof window.updateInjuryMax === 'function') window.updateInjuryMax();

    if (typeof window.showToast === 'function') window.showToast("Character dossier & stats secured to database.");
    else alert("Character dossier & stats secured to database.");
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
                                <div style="display:flex; gap:4px;">
                                    <button class="btn-reveal" onclick="window.openDmSheetEditor('${p.id}')" style="font-size:9px; padding:2px 6px; border-color:#ff6b6b; color:#ff6b6b;">EDIT SHEET</button>
                                    <button class="btn-reveal" onclick="window.snapToCommander('${p.id}')" style="font-size:9px; padding:2px 6px;">LOCATE VESSEL</button>
                                </div>
                            </div>
                            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px; margin-top:8px;">
                                <div><label style="font-size:9px; color:#ff6b6b;">Injuries</label><input type="number" id="dm-edit-vit-${p.id}" value="${char.vitality || 0}" style="font-size:10px; padding:2px; margin:0;"></div>
                                <div><label style="font-size:9px; color:#ffaa00;">Stress</label><input type="number" id="dm-edit-str-${p.id}" value="${char.stress || 0}" style="font-size:10px; padding:2px; margin:0;"></div>
                                <div><label style="font-size:9px; color:#00e5a3;">Adversity</label><input type="number" id="dm-edit-adv-${p.id}" value="${char.adversity_tokens || 0}" style="font-size:10px; padding:2px; margin:0;"></div>
                            </div>
                            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px; margin-top:6px;">
                                <div><label style="font-size:9px; color:#00e1ff;">Shield Cur</label><input type="number" id="dm-edit-shieldcur-${p.id}" value="${char.shield_current || 0}" style="font-size:10px; padding:2px; margin:0;"></div>
                                <div><label style="font-size:9px; color:#00e1ff;">Shield Max</label><input type="number" id="dm-edit-shieldmax-${p.id}" value="${char.shield_max || 0}" style="font-size:10px; padding:2px; margin:0;"></div>
                                <div><label style="font-size:9px; color:#c9962f;">DR</label><input type="number" id="dm-edit-dr-${p.id}" value="${char.dr || 0}" style="font-size:10px; padding:2px; margin:0;"></div>
                            </div>
                            <label style="font-size:9px; color:#6b826a; margin-top:6px; display:block;">Misc. Inventory Override:</label>
                            <textarea id="dm-edit-assets-${p.id}" rows="2" style="font-size:10px; margin:2px 0;">${char.assets || ''}</textarea>
                            <button class="btn-reveal" onclick="window.dmUpdatePlayerStats('${p.id}')" style="width:100%; font-size:9px; margin-top:4px; border-color:#ff6b6b; color:#ff6b6b;">APPLY OVERRIDE</button>
                            <div style="display:flex; gap:4px; margin-top:8px; border-top:1px solid #3c4e36; padding-top:6px;">
                                <label for="dm-award-perk-${p.id}" style="display:none;">Award Perk</label>
                                <select id="dm-award-perk-${p.id}" style="flex:1; margin:0; font-size:9px; padding:3px;">${(typeof window.getApprovedPerksBySection === 'function' ? window.getApprovedPerksBySection(2) : []).map(pk => `<option value="${pk.id}">${pk.name}</option>`).join('')}</select>
                                <button class="btn-deploy" onclick="window.awardSection2Perk('${p.id}')" style="width:auto; margin:0; padding:4px 8px; font-size:9px;">AWARD</button>
                            </div>
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
                            <span style="color:#6b826a; font-size:10px;">Injuries: ${char.vitality || 0} | Stress: ${char.stress || 0} | Shield: ${char.shield_current || 0}/${char.shield_max || 0}</span>
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
    const shieldCur = parseInt(document.getElementById(`dm-edit-shieldcur-${profileId}`).value) || 0;
    const shieldMax = parseInt(document.getElementById(`dm-edit-shieldmax-${profileId}`).value) || 0;
    const dr = parseInt(document.getElementById(`dm-edit-dr-${profileId}`).value) || 0;
    const assets = document.getElementById(`dm-edit-assets-${profileId}`).value;
    const prof = allProfiles.find(p => p.id === profileId);
    if (!prof || !prof.character) return;
    await db.from('characters').update({ vitality: vit, stress: str, adversity_tokens: adv, shield_current: shieldCur, shield_max: shieldMax, dr: dr, assets: assets }).eq('id', prof.character.id);
    db.from('chat_logs').insert({ sender_id: null, content: `⚙️ [OVERSEER] System parameters overridden for Commander ${prof.username}.`, message_type: 'system' });
    if (typeof window.showToast === 'function') window.showToast("Player metrics overridden and saved to cloud.");
    else alert("Player metrics overridden and saved to cloud.");
};

window.awardSection2Perk = async function(profileId) {
    if (currentUserRole !== 'dm') return;
    const select = document.getElementById(`dm-award-perk-${profileId}`);
    const perkDefId = select ? select.value : null;
    if (!perkDefId) return;
    const perkDef = window.findPerkDefinition(perkDefId);
    if (!perkDef) return;
    const prof = allProfiles.find(p => p.id === profileId);
    if (!prof || !prof.character || !prof.character.id) { alert("This player hasn't saved a character sheet yet — nothing to award the perk to."); return; }

    // Bugfix: this insert used to run with no duplicate check at all, so
    // clicking Award twice (or awarding a perk the player already has)
    // silently created a second character_perks row pointing at the same
    // definition, double-counting its effects. Guard against that here,
    // regardless of which section the existing link is in.
    const alreadyHas = (prof.perks || []).some(p => p.perk_definition_id === perkDefId);
    if (alreadyHas) { alert(`${prof.username || 'This commander'} already has ${perkDef.name} — not awarding a duplicate.`); return; }

    const { data, error } = await db.from('character_perks').insert({ character_id: prof.character.id, perk_definition_id: perkDefId, section: 2 }).select().single();
    if (error) { alert("Failed to award perk: " + error.message); return; }
    prof.perks = prof.perks || [];
    prof.perks.push(data);

    await db.from('chat_logs').insert({
        sender_id: null,
        content: `🎖️ [OVERSEER] ${prof.username || 'Commander'} was awarded the specialization: ${perkDef.name}.`,
        message_type: 'system'
    });
    if (typeof window.showToast === 'function') window.showToast(`Awarded ${perkDef.name} to ${prof.username || 'Commander'}.`);
    if (typeof window.renderCrewRoster === 'function') window.renderCrewRoster();
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
        // Codex "hide" checkbox (this session) — an unconditional DM-only
        // switch, checked first and separately from the DRADIS LINK:
        // mechanic below (an entry could theoretically have both set; hidden
        // wins regardless of scan state).
        if (e.is_hidden) return false;
        let linkMatch = (e.subtitle || '').match(/LINK:(.+)/);
        if (linkMatch) { return window.scannedSystems && window.scannedSystems.includes(linkMatch[1].trim()); }
        return true;
    });

    if (entries.length === 0) { container.innerHTML = `<span style="font-size:11px; color:#6b826a;">No records located under this classification.</span>`; return; }

    let isDM = (currentUserRole === 'dm');
    const orderKey = 'codex_' + window.activeCodexCategory;
    const ordered = window.applySavedOrder(orderKey, entries);
    let html = '';
    ordered.forEach(e => {
        let cleanSubtitle = (e.subtitle || '').replace(/\|\s*LINK:.+/, '').trim();
        let docHtml = (e.doc_data && e.doc_name) ? `<div class="codex-doc-pill" onclick="window.openCodexAttachment('${e.id}')">📎 ATTACHMENT: ${e.doc_name} (${(e.doc_type || 'FILE').toUpperCase()})</div>` : '';
        let authorName = allProfiles.find(p => p.id === e.created_by)?.username || 'Unknown';
        // Codex "hide" checkbox (this session) — badge is DM-view-only
        // (isDM already gates everything else in this card that shouldn't
        // reach a player; a hidden entry never even reaches a non-DM's
        // `entries` array above, so there's no risk of a player seeing this
        // badge and inferring a hidden entry exists).
        let hiddenBadge = (isDM && e.is_hidden) ? `<span style="font-size:8px; color:#ff6b6b; border:1px solid #ff6b6b; border-radius:2px; padding:1px 5px; white-space:nowrap;" title="Hidden from players">🚫 HIDDEN</span>` : '';
        html += `
            <div class="codex-entry-card category-${e.category}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div><strong style="color:#00e5a3; font-size:13px;">${e.title}</strong> ${hiddenBadge}<div style="font-size:10px; color:#6b826a; margin-top:2px;">${cleanSubtitle || 'General Record'}</div></div>
                    <div style="display:flex; gap:6px; align-items:center;">
                        ${window.renderReorderArrows(orderKey, ordered, e.id, 'moveCodexEntryOrder')}
                        <button class="layer-edit" onclick="window.openCodexFullscreen('${e.id}')" style="font-size:9px; padding:3px 8px;">⛶ FULLSCREEN</button>
                        ${isDM ? `<button class="layer-edit" onclick="window.editCodexEntry('${e.id}')" style="font-size:9px; padding:3px 8px; color:#ffaa00; border-color:#ffaa00;">✎ EDIT</button>` : ''}
                        ${isDM ? `<button class="layer-del" onclick="window.deleteCodexEntry('${e.id}')" style="font-size:9px; padding:3px 6px;">✕</button>` : ''}
                    </div>
                </div>
                <p style="margin:8px 0 4px 0; font-size:11px; color:#d4c5a9; line-height:1.5; max-height:80px; overflow:hidden; text-overflow:ellipsis;">${e.content || ''}</p>
                ${docHtml}
                <span class="author-tag">author: ${authorName}</span>
            </div>
        `;
    });
    container.innerHTML = html;
};
window.moveCodexEntryOrder = function(id, direction) {
    const orderKey = 'codex_' + window.activeCodexCategory;
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
    window.moveListItem(orderKey, window.applySavedOrder(orderKey, entries), id, direction);
    window.renderCodexMatrix();
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
    const hiddenCheckbox = document.getElementById('new-codex-hidden');
    if (hiddenCheckbox) hiddenCheckbox.checked = !!entry.is_hidden;
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

    // Codex "hide" checkbox (this session) — see the form's own comment in
    // index.html for how this differs from the DRADIS LINK: mechanic above.
    const hiddenCheckbox = document.getElementById('new-codex-hidden');
    const isHidden = hiddenCheckbox ? hiddenCheckbox.checked : false;

    if (window.editingCodexId) {
        // Never touch created_by on an edit — it should stay whoever
        // originally authored the entry, not whoever most recently edited it.
        const payload = { category: cat, title: title, subtitle: subtitle, content: content, is_hidden: isHidden };
        await db.from('codex_entries').update(payload).eq('id', window.editingCodexId);
    } else {
        const payload = { category: cat, title: title, subtitle: subtitle, content: content, created_by: currentUserId, is_hidden: isHidden };
        await db.from('codex_entries').insert(payload);
    }

    window.cancelCodexEdit(); window.switchCodexCategory(cat); if (typeof loadCodexEntries === 'function') loadCodexEntries();
};

window.cancelCodexEdit = function() {
    window.editingCodexId = null;
    document.getElementById('codex-creator-heading').innerText = "+ New Codex Entry";
    document.getElementById('new-codex-title').value = ''; document.getElementById('new-codex-subtitle').value = '';
    document.getElementById('new-codex-content').value = '';
    const linkInput = document.getElementById('new-codex-link'); if(linkInput) linkInput.value = '';
    const hiddenCheckbox = document.getElementById('new-codex-hidden'); if (hiddenCheckbox) hiddenCheckbox.checked = false;
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

/* --- CODEX MARKDOWN + CHARTS (this session) ---
   Codex entry content was 100% plain text before this build (rendered via
   .innerText, no formatting of any kind). Confirmed design, via
   AskUserQuestion: markdown syntax typed directly into the existing
   content textarea (not a separate visual table-builder), rendered via the
   marked.js CDN script now loaded in index.html (same CDN-script pattern
   already established there for Supabase) — gets tables, bold/italic,
   headers, and lists essentially for free as a side effect of picking
   markdown for tables specifically. "Graphs" = real charts rendered from
   typed-in data (not just inline image embedding), via a small custom
   ```chart fenced-block DSL parsed out BEFORE the remaining text reaches
   marked, then rendered into a <canvas> with Chart.js (also CDN-loaded).

   Deliberately scoped to the FULLSCREEN reader only — the small card
   preview in renderCodexMatrix keeps showing raw, un-rendered text. A
   table or chart mid-render inside that card's 80px-clipped, overflow-
   hidden preview box would look broken far more often than it would look
   useful; the fullscreen reader has no such height constraint. This means
   an entry with a table/chart will show its literal markdown/DSL syntax
   in the card view and only render properly once opened — a deliberate
   tradeoff, not an oversight.

   No HTML sanitization is applied to marked's output (DOMPurify or
   similar was NOT added). This is consistent with — not a new gap beyond —
   this app's existing "DM-trusted" content model: DM-authored codex
   content was ALREADY interpolated unescaped into the card preview's
   innerHTML before this build (raw HTML in `content` would already have
   rendered there), and every other DM-facing text field in this app
   (chat, notes, blueprint descriptions) carries the same trust assumption.
   Flagging plainly rather than silently deciding sanitization wasn't
   needed. */
function parseCodexChartBlock(raw) {
    const VALID_TYPES = ['bar', 'pie', 'line', 'doughnut'];
    let type = 'bar', title = '';
    const labels = [], values = [];
    (raw || '').split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
        const m = line.match(/^([^:]+):\s*(.+)$/);
        if (!m) return;
        const key = m[1].trim().toLowerCase();
        const val = m[2].trim();
        if (key === 'type') {
            if (VALID_TYPES.includes(val.toLowerCase())) type = val.toLowerCase();
        } else if (key === 'title') {
            title = val;
        } else {
            const num = parseFloat(val.replace(/,/g, ''));
            if (!isNaN(num)) { labels.push(m[1].trim()); values.push(num); }
        }
    });
    return { type, title, labels, values };
}

window.renderCodexMarkdown = function(rawContent) {
    const charts = [];
    let chartIdx = 0;
    // Extract ```chart fenced blocks BEFORE handing off to marked, so its
    // own generic fenced-code-block handling never sees (and code-block-
    // formats) them. Each is swapped for a plain-text %%codex-chart-N%%
    // token that survives markdown parsing intact -- marked just wraps an
    // unrecognized lone line in its own <p>, which is found-and-replaced
    // with the real <canvas> markup afterward.
    const withoutCharts = (rawContent || '').replace(/```chart\s*\n([\s\S]*?)```/gi, (match, body) => {
        const id = `codex-chart-${chartIdx++}`;
        charts.push({ id, ...parseCodexChartBlock(body) });
        return `\n\n%%${id}%%\n\n`;
    });

    let html;
    if (typeof marked !== 'undefined') {
        html = (typeof marked.parse === 'function') ? marked.parse(withoutCharts) : marked(withoutCharts);
    } else {
        // marked.js failed to load (offline CDN, ad-blocker, etc.) --
        // fails open to a plain-text-with-line-breaks rendering rather
        // than an empty/broken reader.
        html = withoutCharts.replace(/</g, '&lt;').replace(/\n/g, '<br>');
    }

    charts.forEach(c => {
        const canvasHtml = `<div class="codex-chart-wrap"><canvas id="${c.id}"></canvas></div>`;
        // marked wraps the lone placeholder line in its own <p>...</p> --
        // strip that wrapper too, not just the token itself, so a <canvas>
        // never ends up nested inside a <p> (invalid HTML, breaks layout).
        const wrapped = new RegExp(`<p>\\s*%%${c.id}%%\\s*</p>`);
        if (wrapped.test(html)) html = html.replace(wrapped, canvasHtml);
        else html = html.replace(new RegExp(`%%${c.id}%%`), canvasHtml); // fallback if no <p> wrapper was found
    });

    return { html, charts };
};

window.openCodexFullscreen = function(id) {
    const entry = globalCodexEntriesCache.find(e => e.id === id); if (!entry) return;
    const modal = document.getElementById('codex-fullscreen-reader');
    const authorName = allProfiles.find(p => p.id === entry.created_by)?.username || 'Unknown';
    document.getElementById('reader-category-badge').innerText = `${(entry.category || 'LORE').toUpperCase()} // ${authorName.toUpperCase()}`;
    document.getElementById('reader-title').innerText = entry.title;
    document.getElementById('reader-subtitle').innerText = (entry.subtitle || '').replace(/\|\s*LINK:.+/, '').trim() || 'UNCLASSIFIED RECORD';

    // Destroy any Chart.js instances left over from a PREVIOUSLY opened
    // entry first -- Chart.js throws "Canvas is already in use" if a new
    // Chart is created on a canvas id that still has a live instance
    // attached, and canvas ids are per-entry (codex-chart-0, -1, ...) so
    // reopening a different entry would collide with the last one's
    // leftover instances otherwise.
    (window.activeCodexCharts || []).forEach(c => { try { c.destroy(); } catch (e) {} });
    window.activeCodexCharts = [];

    const rendered = (typeof window.renderCodexMarkdown === 'function')
        ? window.renderCodexMarkdown(entry.content || 'No narrative content recorded.')
        : { html: entry.content || 'No narrative content recorded.', charts: [] };
    document.getElementById('reader-body-content').innerHTML = `<div class="codex-markdown">${rendered.html}</div>`;

    if (typeof Chart !== 'undefined') {
        const palette = ['#00e5a3', '#00e1ff', '#ffaa00', '#ff6b6b', '#c778dd', '#7cbf3f', '#66d9ff', '#ffe066'];
        rendered.charts.forEach(c => {
            const canvas = document.getElementById(c.id);
            if (!canvas || c.labels.length === 0) return; // no valid Label: Number lines -- nothing to plot, leave the empty wrapper rather than crash Chart.js on empty data
            try {
                window.activeCodexCharts.push(new Chart(canvas, {
                    type: c.type,
                    data: { labels: c.labels, datasets: [{ label: c.title || '', data: c.values, backgroundColor: palette, borderColor: '#3c4e36' }] },
                    options: {
                        responsive: true,
                        plugins: { title: { display: !!c.title, text: c.title, color: '#d4c5a9' }, legend: { labels: { color: '#d4c5a9' } } },
                        scales: (c.type === 'bar' || c.type === 'line') ? { x: { ticks: { color: '#d4c5a9' }, grid: { color: '#3c4e36' } }, y: { ticks: { color: '#d4c5a9' }, grid: { color: '#3c4e36' } } } : {}
                    }
                }));
            } catch (err) { console.error('Codex chart render failed for', c.id, err); }
        });
    }

    const actionBar = document.getElementById('reader-doc-action-bar');
    if (entry.doc_data && entry.doc_name) {
        actionBar.style.display = 'block';
        actionBar.innerHTML = `<button class="btn-reveal" onclick="window.openCodexAttachment('${entry.id}')" style="width:auto; font-size:11px; padding:6px 16px;">📥 OPEN / DOWNLOAD ATTACHED DOCUMENT (${entry.doc_name})</button>`;
    } else { actionBar.style.display = 'none'; }
    modal.style.display = 'block';
};

window.closeCodexFullscreen = function() {
    document.getElementById('codex-fullscreen-reader').style.display = 'none';
    (window.activeCodexCharts || []).forEach(c => { try { c.destroy(); } catch (e) {} });
    window.activeCodexCharts = [];
};

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

    await db.from('chat_logs').insert({ sender_id: null, content: `📡 [DRADIS SWEEP] Task Force Black completed a deep scan of '${s.name}'. Operation took ${scanHours} hours. Orbital census uploaded to mainframe. [SYS_SCAN:${sysId}]`, message_type: 'system' });
    
    let unlockedLore = globalCodexEntriesCache.filter(e => (e.subtitle || '').includes(`LINK:${sysId}`));
    if (unlockedLore.length > 0) {
        await db.from('chat_logs').insert({ sender_id: null, content: `📖 [INTEL DECRYPTED] DRADIS sweep recovered hidden data caches. New Codex entries unlocked.`, message_type: 'system' });
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
    const ordered = window.applySavedOrder('objectives', campaignObjectivesList);
    ordered.forEach(obj => {
        html += `
            <div class="note-card" style="border-color:${obj.completed ? '#00e5a3' : '#3c4e36'}; opacity:${obj.completed ? '0.7' : '1'};">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong style="color:${obj.completed ? '#00e5a3' : '#00e5a3'}; font-size:11px; text-decoration:${obj.completed ? 'line-through' : 'none'};">${obj.title}</strong>
                    <div style="display:flex; gap:6px;">
                        ${window.renderReorderArrows('objectives', ordered, obj.id, 'moveObjectiveOrder')}
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
window.moveObjectiveOrder = function(id, direction) {
    window.moveListItem('objectives', window.applySavedOrder('objectives', campaignObjectivesList), id, direction);
    window.renderCampaignObjectives();
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
    const visibleNotes = playerNotesList.filter(n => !(n.author_id !== currentUserId && n.share_scope === 'private' && currentUserRole !== 'dm'));
    const ordered = window.applySavedOrder('notes', visibleNotes);
    ordered.forEach(n => {
        const isMine = n.author_id === currentUserId; const isAudit = !isMine && n.share_scope === 'private' && currentUserRole === 'dm';
        let auditTag = isAudit ? `<span style="color:#ff3333; font-size:9px; margin-left:6px;">[OVERSEER AUDIT]</span>` : '';
        html += `
            <div class="note-card" style="border-color:${isAudit ? '#ff3333' : '#3c4e36'};">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <strong style="color:#00e5a3; font-size:11px;">${n.title} ${auditTag}</strong>
                    <div style="display:flex; gap:4px;">
                        ${window.renderReorderArrows('notes', ordered, n.id, 'moveNoteOrder')}
                        <button class="layer-edit" onclick="window.openNoteFullscreen('${n.id}')" style="font-size:8px;">⛶ FULL</button>
                        ${isMine || currentUserRole === 'dm' ? `<button class="layer-edit" onclick="window.editNote('${n.id}')" style="font-size:8px;">Edit</button><button class="layer-del" onclick="window.deleteNote('${n.id}')" style="font-size:8px;">X</button>` : ''}
                    </div>
                </div>
                <p style="margin:4px 0 2px 0; font-size:10px; color:#d4c5a9; white-space:pre-wrap; max-height:40px; overflow:hidden; text-overflow:ellipsis;">${n.content || ''}</p>
                <span class="author-tag">scope: ${n.share_scope} · author: ${allProfiles.find(p=>p.id===n.author_id)?.username || 'Unknown'}</span>
            </div>
        `;
    });
    container.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No notes recorded.</span>';
};
window.moveNoteOrder = function(id, direction) {
    const visibleNotes = playerNotesList.filter(n => !(n.author_id !== currentUserId && n.share_scope === 'private' && currentUserRole !== 'dm'));
    window.moveListItem('notes', window.applySavedOrder('notes', visibleNotes), id, direction);
    window.renderTerminalNotes();
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
        if (typeof window.renderArsenalDiceFeed === 'function') window.renderArsenalDiceFeed();
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
    // Comms chirp (2026-08 audio polish) -- skip on my own messages: this
    // realtime handler also fires for the sender's own INSERT (echoed back
    // by Supabase), and sendChatMessage() already appends it locally
    // without a sound, so chirping here too would double-fire on send.
    if (window.AudioEngine && newLog.sender_id !== currentUserId) window.AudioEngine.playChirp();
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
        if (log.message_type === 'system') { headerColor = '#6b826a'; prefix = '⚙️'; }
        if (log.message_type === 'roll') { headerColor = '#ff6b6b'; prefix = '🎲 [ROLL]'; }
        if (log.message_type === 'ping') { headerColor = '#00e1ff'; prefix = '📍 [PING]'; }
        let contentHTML = log.content;
        if (log.message_type === 'roll' && log.roll_data) { contentHTML = `<strong style="font-size:12px;">${log.content}</strong><br><span style="font-size:9px; color:#6b826a;">${log.roll_data.breakdown}</span>`; }
        if (log.message_type === 'ping' && log.roll_data) { contentHTML = `${log.content} <button class="layer-edit" onclick="window.jumpToPingLocation(${log.roll_data.x}, ${log.roll_data.y})" style="padding:2px 8px; font-size:9px; margin-left:6px;">JUMP TO LOCATION</button>`; }
        html += `<div style="background: rgba(6,9,7,0.6); padding: 6px; border-left: 2px solid ${headerColor}; border-radius: 2px;"><div style="font-size: 9px; color: ${headerColor}; margin-bottom: 2px;">${prefix} <strong>${log.message_type === 'system' ? 'SYSTEM' : senderName}</strong></div><div style="font-size: 11px; color: #d4c5a9;">${contentHTML}</div></div>`;
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
// Shared by the territory faction select and the new hyperlane faction
// select (below) — same source list (codex 'factions' entries), same
// "no faction" fallback option, just a different target <select>.
window.populateFactionSelect = function(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    let html = '<option value="">-- No Faction / Neutral --</option>';
    const factions = globalCodexEntriesCache.filter(e => e.category === 'factions');
    factions.forEach(f => { html += `<option value="${f.title}">${f.title}</option>`; });
    select.innerHTML = html;
};
window.populateTerritoryFactionSelect = function() { window.populateFactionSelect('territory-faction-select'); };
window.populateHyperlaneFactionSelect = function() { window.populateFactionSelect('hyperlane-faction-select'); };

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
                        <button class="layer-apply" onclick="window.applyTerritoryToGalaxy('${t.id}')" style="font-size: 9px; padding: 2px 4px;">🚩 Apply</button>
                        <button class="layer-edit" onclick="window.startEditTerritory('${t.id}')" style="font-size: 9px; padding: 2px 4px;">✏️ Edit</button>
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
    if (!(await window.showConfirmModal("Permanently erase this territory border? Any systems it currently owns will be un-claimed back to Unclaimed."))) return;
    const t = globalTerritoriesCache.find(x => x.id === id);
    if (t && typeof window.releaseTerritoryOwnership === 'function') {
        await window.releaseTerritoryOwnership(t);
    }
    await db.from('territories').delete().eq('id', id);
    if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
    if (typeof loadSystemOwnershipOverrides === 'function') await loadSystemOwnershipOverrides();
    if (typeof loadTerritories === 'function') await loadTerritories();
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};

window.renderHyperlaneList = function() {
    const container = document.getElementById('hyperlane-list-container');
    if (!container) return;
    let html = '';
    globalHyperlanesCache.forEach(h => {
        const factionTag = h.faction_name ? `<span style="font-size:9px; color:#6b826a;"> · ${h.faction_name}</span>` : '';
        html += `
            <div class="note-card" style="border-left: 3px solid ${h.color || '#00e1ff'}; padding: 6px; margin-bottom: 4px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong style="color: ${h.color || '#00e1ff'}; font-size: 11px;">${h.name || 'Trade Route'}</strong>${factionTag}<br>
                        <span style="font-size: 9px; color: #6b826a;">${h.nodes?.length || 0} Jumps</span>
                    </div>
                    ${currentUserRole === 'dm' ? `<div style="display:flex; gap:4px;">
                        <button class="layer-edit" onclick="window.startEditHyperlane('${h.id}')" style="font-size: 9px; padding: 2px 4px;">✎ Edit</button>
                        <button class="layer-del" onclick="window.deleteHyperlane('${h.id}')" style="font-size: 9px; padding: 2px 4px;">✕</button>
                    </div>` : ''}
                </div>
            </div>
        `;
    });
    container.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No active routes.</span>';
};

window.deleteHyperlane = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Permanently erase this trade route?"))) return;
    if (window.editingHyperlaneId === id) window.cancelDrawingHyperlane(); // was being edited — bail out of that state first
    await db.from('hyperlanes').delete().eq('id', id);
    if (typeof loadHyperlanes === 'function') loadHyperlanes();
};

/* --- HAZARD DESIGNER CATALOG (DM-only) ---
   Reusable hazard blueprints — same "design once, save it, place instances
   later" shift Ship Designer/Perk Designer made. Simpler than either of
   those: no draft/approval workflow and no per-owner permissions, because
   hazard placement has always been entirely DM-only (see placeHazardZone
   below) — there's no player-facing side of this feature to gate, so a
   flat DM-only catalog (confirmed design decision) is all it needs. */
let editingHazardDefId = null;

window.renderHazardDefinitionsPanel = function() {
    const container = document.getElementById('hazard-def-list-container');
    if (!container) return;
    const list = window.hazardDefinitionsList || [];
    const hazardColors = { pulsar: '#ff3366', nebula: '#c778dd', gravity_well: '#7694ff' };
    let html = '';
    if (list.length === 0) html = '<span style="font-size:10px; color:#6b826a;">No hazard blueprints designed yet.</span>';
    list.forEach(d => {
        const color = hazardColors[d.hazard_type] || '#ffaa00';
        html += `
            <div class="note-card" style="border-left: 3px solid ${color}; padding: 6px; margin-bottom: 4px;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div>
                        <strong style="color: ${color}; font-size: 11px;">${d.name}</strong>
                        <div style="font-size:9px; color:#6b826a;">${d.hazard_type.replace('_', ' ').toUpperCase()} · Radius: ${d.default_radius}u · Intensity: ${d.default_intensity}</div>
                        ${d.description ? `<div style="font-size:9px; color:#d4c5a9; margin-top:2px;">${d.description}</div>` : ''}
                    </div>
                    <div style="display:flex; gap:4px;">
                        <button class="layer-edit" onclick="window.openEditHazardDefinition('${d.id}')" style="font-size: 9px; padding: 2px 6px;">✎</button>
                        <button class="layer-del" onclick="window.deleteHazardDefinition('${d.id}')" style="font-size: 9px; padding: 2px 4px;">✕</button>
                    </div>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
};

window.saveHazardDefinition = async function() {
    if (currentUserRole !== 'dm') return;
    const name = document.getElementById('new-hazdef-name').value.trim();
    if (!name) { alert("Enter a blueprint name first."); return; }
    const hazard_type = document.getElementById('new-hazdef-type').value;
    const default_radius = Math.min(parseFloat(document.getElementById('new-hazdef-radius').value) || 300, window.SYSTEM_HAZARD_MAX_RADIUS);
    const default_intensity = parseInt(document.getElementById('new-hazdef-intensity').value) || 1;
    const description = document.getElementById('new-hazdef-desc').value.trim();

    if (editingHazardDefId) {
        const { error } = await db.from('hazard_definitions').update({ name, hazard_type, default_radius, default_intensity, description }).eq('id', editingHazardDefId);
        if (error) { alert("Failed to update blueprint: " + error.message); return; }
    } else {
        const { error } = await db.from('hazard_definitions').insert({ name, hazard_type, default_radius, default_intensity, description, created_by: currentUserId });
        if (error) { alert("Failed to save blueprint: " + error.message); return; }
    }
    window.cancelHazardDefinitionEdit();
    if (typeof loadHazardDefinitions === 'function') loadHazardDefinitions();
};

window.openEditHazardDefinition = function(id) {
    const d = (window.hazardDefinitionsList || []).find(x => x.id === id);
    if (!d) return;
    editingHazardDefId = id;
    document.getElementById('new-hazdef-name').value = d.name || '';
    document.getElementById('new-hazdef-type').value = d.hazard_type || 'pulsar';
    document.getElementById('new-hazdef-radius').value = d.default_radius || 300;
    document.getElementById('new-hazdef-intensity').value = d.default_intensity || 1;
    document.getElementById('new-hazdef-desc').value = d.description || '';
    document.getElementById('hazard-def-form-heading').innerText = `✎ Editing: ${d.name}`;
    document.getElementById('btn-save-hazard-def').innerText = '✓ UPDATE DEFINITION';
    document.getElementById('btn-cancel-hazard-def-edit').style.display = 'block';
};

window.cancelHazardDefinitionEdit = function() {
    editingHazardDefId = null;
    document.getElementById('hazard-def-form-heading').innerText = '+ New Hazard Definition';
    document.getElementById('new-hazdef-name').value = '';
    document.getElementById('new-hazdef-radius').value = '300';
    document.getElementById('new-hazdef-intensity').value = '1';
    document.getElementById('new-hazdef-desc').value = '';
    document.getElementById('btn-save-hazard-def').innerText = '+ SAVE DEFINITION';
    document.getElementById('btn-cancel-hazard-def-edit').style.display = 'none';
};

window.deleteHazardDefinition = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Delete this hazard blueprint? Zones already placed from it are unaffected."))) return;
    await db.from('hazard_definitions').delete().eq('id', id);
    if (editingHazardDefId === id) window.cancelHazardDefinitionEdit();
    if (typeof loadHazardDefinitions === 'function') loadHazardDefinitions();
};

// Populates the catalog-definition dropdown in the placement form below.
window.populateHazardDefSelect = function() {
    const sel = document.getElementById('new-hazard-def');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Ad-hoc (no catalog blueprint) —</option>' +
        (window.hazardDefinitionsList || []).map(d => `<option value="${d.id}">${d.name}</option>`).join('');
};

// Target-system picker for hazard placement: a searchable autocomplete,
// not a plain <select> — system_hazards.system_id turns out to be a plain
// text column with no foreign key (confirmed via a live schema check), so
// it can point at ANY system id, including the ~2,641 procedurally
// generated galaxy systems (proc-core-*/proc-spiral-*), not just the
// handful of DM-placed custom ones. A <select> with 2,600+ options isn't
// usable, so this mirrors the existing global search bar's pattern
// (window.handleGlobalSearchInput in js/map.js): type to filter by name,
// click a result to select it. Selection is held in
// window._hazardTargetSystemId (not a form field value) since procedural
// system ids aren't real rows a <select>/<option> pairing would suit.
window._hazardSystemSearchResults = [];
window._hazardTargetSystemId = null;
let _hazardSystemDropdownEscaped = false;
window.handleHazardSystemSearch = function(query) {
    // Same overflow-clipping problem/fix as the global search dropdown:
    // #dm-tools scrolls (overflow-y:auto), which still clips a tall
    // absolutely-positioned child — escape to <body> once, position:fixed
    // from then on, anchored under the input via getBoundingClientRect.
    if (!_hazardSystemDropdownEscaped) {
        const dd = document.getElementById('hazard-system-search-dropdown');
        if (dd) { document.body.appendChild(dd); _hazardSystemDropdownEscaped = true; }
    }
    const dropdown = document.getElementById('hazard-system-search-dropdown');
    const inputEl = document.getElementById('new-hazard-system-search');
    if (!dropdown || !inputEl) return;

    // Typing invalidates whatever was previously selected until a result
    // is actually clicked again — prevents placing against a stale pick
    // if the DM edits the text without choosing a new match.
    window._hazardTargetSystemId = null;
    const tag = document.getElementById('hazard-system-selected-tag');
    if (tag) tag.style.display = 'none';

    query = (query || '').trim().toLowerCase();
    if (!query) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; window._hazardSystemSearchResults = []; return; }

    const allSystems = (typeof globalProceduralSystemsCache !== 'undefined' ? globalProceduralSystemsCache : []).concat(typeof globalDbSystemsCache !== 'undefined' ? globalDbSystemsCache : []);
    const results = allSystems.filter(s => s.name && s.name.toLowerCase().includes(query)).slice(0, 10);
    window._hazardSystemSearchResults = results;

    const rect = inputEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.width = rect.width + 'px';

    if (results.length === 0) {
        dropdown.innerHTML = '<div class="search-result-item" style="cursor:default; color:#6b826a;">No matches</div>';
    } else {
        dropdown.innerHTML = results.map((s, idx) => `<div class="search-result-item" onclick="window.selectHazardTargetSystem(${idx})">${s.name} ${s.isCustom ? '<span style="color:#00e5a3; font-size:9px;">[CUSTOM]</span>' : '<span style="color:#6b826a; font-size:9px;">[GALAXY]</span>'}</div>`).join('');
    }
    dropdown.style.display = 'block';
};
window.selectHazardTargetSystem = function(idx) {
    const s = window._hazardSystemSearchResults[idx];
    if (!s) return;
    window._hazardTargetSystemId = s.id;
    const inputEl = document.getElementById('new-hazard-system-search');
    if (inputEl) inputEl.value = s.name;
    const tag = document.getElementById('hazard-system-selected-tag');
    if (tag) { tag.innerText = `🔗 Tied to: ${s.name} (click to clear)`; tag.style.display = 'block'; }
    const dropdown = document.getElementById('hazard-system-search-dropdown');
    if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
};
window.clearHazardTargetSystem = function() {
    window._hazardTargetSystemId = null;
    const inputEl = document.getElementById('new-hazard-system-search');
    if (inputEl) inputEl.value = '';
    const tag = document.getElementById('hazard-system-selected-tag');
    if (tag) tag.style.display = 'none';
};
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('hazard-system-search-dropdown');
    const input = document.getElementById('new-hazard-system-search');
    if (!dropdown || dropdown.style.display === 'none') return;
    if (e.target === input || dropdown.contains(e.target)) return;
    dropdown.innerHTML = ''; dropdown.style.display = 'none';
});

// Prefills type/radius/intensity from a chosen blueprint — the instance's
// fields stay independently editable afterward (same blueprint-vs-deployed-
// instance split Ship Designer/ship_markers already use).
window.applyHazardDefToPlacementForm = function(defId) {
    if (!defId) return;
    const d = (window.hazardDefinitionsList || []).find(x => x.id === defId);
    if (!d) return;
    document.getElementById('new-hazard-type').value = d.hazard_type || 'pulsar';
    document.getElementById('new-hazard-radius').value = Math.min(d.default_radius || 300, window.SYSTEM_HAZARD_MAX_RADIUS);
    document.getElementById('new-hazard-intensity').value = d.default_intensity || 1;
};

/* --- SYSTEM HAZARD ZONES (DM controls) ---
   Explicit, precisely-placed instances — independent of the implicit
   per-system hazard flavor field, which window.checkShipHazards() (map.js)
   already folds in automatically. This is for a DM who wants a hazard NOT
   centered on a star, multiple hazards in one system, or a hazard on a
   system that was generated without one.
   Radius is always clamped to window.SYSTEM_HAZARD_MAX_RADIUS (map.js) —
   previously unbounded, which let a zone visually engulf half the map.
   Tying a zone to a system (system_id) is optional and PURELY informational
   as of this session — it's shown in the list below so a DM can tell which
   hazard belongs to which system, but it no longer drives Fog of War.
   (It used to: a tied zone's visibility was gated by the tied system's own
   FOW tier. That broke down because this function places a new zone at
   wherever the camera happens to be centered — with zero enforced
   relationship to whatever system was searched/tied — so a zone could be
   tied to a discovered system while physically sitting on an undiscovered
   one, or vice versa. FOW gating now checks the zone's OWN x/y directly via
   window.isPositionSensorVisible (map.js), same as the implicit per-star
   ring, so every hazard's visibility always matches where it actually is,
   tied or not — see drawHazardZones in map.js for the full reasoning.) */
window.placeHazardZone = async function() {
    if (currentUserRole !== 'dm') return;
    // system_id is a plain text column (no FK) — can be a real star_systems
    // uuid OR a procedural id like "proc-spiral-1204"; see
    // window.handleHazardSystemSearch above for why this isn't a <select>.
    const systemId = window._hazardTargetSystemId || null;
    const defId = document.getElementById('new-hazard-def').value || null;
    const type = document.getElementById('new-hazard-type').value;
    const radius = Math.min(parseFloat(document.getElementById('new-hazard-radius').value) || 300, window.SYSTEM_HAZARD_MAX_RADIUS);
    const intensity = parseInt(document.getElementById('new-hazard-intensity').value) || 1;
    const payload = {
        system_id: systemId,
        definition_id: defId,
        hazard_type: type,
        x: -window.camera.x / window.camera.zoom,
        y: -window.camera.y / window.camera.zoom,
        radius, intensity
    };
    const { error } = await db.from('system_hazards').insert(payload);
    if (error) { alert("Failed to place hazard zone: " + error.message); return; }
    window.clearHazardTargetSystem();
    if (typeof loadSystemHazards === 'function') loadSystemHazards();
};

window.renderHazardZoneList = function() {
    const container = document.getElementById('hazard-zone-list-container');
    if (!container) return;
    const hazardColors = { pulsar: '#ff3366', nebula: '#c778dd', gravity_well: '#7694ff' };
    // Ties can point at either a custom (DB) system or a procedural one —
    // check both caches, same as window.handleHazardSystemSearch.
    const allTieableSystems = (typeof globalProceduralSystemsCache !== 'undefined' ? globalProceduralSystemsCache : []).concat(typeof globalDbSystemsCache !== 'undefined' ? globalDbSystemsCache : []);
    let html = '';
    (window.globalSystemHazardsCache || []).forEach(hz => {
        const color = hazardColors[hz.hazard_type] || '#ffaa00';
        const tiedSystem = hz.system_id ? allTieableSystems.find(s => s.id === hz.system_id) : null;
        // "FOW-gated" here means the zone's own position, not this tie — see
        // the comment above window.placeHazardZone for why the tie itself
        // stopped being a FOW input this session. Every zone (tied or not)
        // is now hidden at tier 1 based on where it actually sits.
        const tieTag = hz.system_id
            ? `<span style="color:#00e5a3;">🔗 Linked to: ${tiedSystem ? tiedSystem.name : 'Unknown system'} (informational only)</span>`
            : `<span style="color:#6b826a;">Untied</span>`;
        html += `
            <div class="note-card" style="border-left: 3px solid ${color}; padding: 6px; margin-bottom: 4px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong style="color: ${color}; font-size: 11px;">${hz.hazard_type.replace('_', ' ').toUpperCase()}</strong>
                        <div style="font-size:9px; color:#6b826a;">Radius: ${hz.radius}u &nbsp;·&nbsp; Intensity: ${hz.intensity}</div>
                        <div style="font-size:9px; margin-top:2px;">${tieTag}</div>
                    </div>
                    <button class="layer-del" onclick="window.deleteHazardZone('${hz.id}')" style="font-size: 9px; padding: 2px 4px;">✕</button>
                </div>
            </div>
        `;
    });
    container.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No explicit hazard zones placed.</span>';
};

window.deleteHazardZone = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Remove this hazard zone?"))) return;
    await db.from('system_hazards').delete().eq('id', id);
    if (typeof loadSystemHazards === 'function') loadSystemHazards();
};
