/* ==========================================================================
   js/battle-salvage.js - Battlefield salvage: data, realtime, gathering, conversion and the SALVAGE panel.
   Split out of js/battle-map.js (consolidation pass 2, 2026-10-08), code
   unchanged. Classic script sharing the global scope: loads right after
   battle-map.js (see index.html for the order).
   ========================================================================== */
/* --- BATTLEFIELD SALVAGE: data + panel --- */
window.globalBattlefieldSalvageCache = [];
const SALVAGE_GATHER_RANGE = 300; // matches the hazard-zone default radius already used elsewhere as this app's "nearby" scale

async function loadBattlefieldSalvage() {
    const { data, error } = await db.from('battlefield_salvage').select('*').order('created_at', { ascending: true });
    if (error) { console.error('loadBattlefieldSalvage failed', error); return; }
    window.globalBattlefieldSalvageCache = data || [];
    if (typeof window.renderSalvagePanel === 'function') window.renderSalvagePanel();
}
window.loadBattlefieldSalvage = loadBattlefieldSalvage;

let battlefieldSalvageRealtimeChannel = null;
function initBattlefieldSalvageRealtimeChannel() {
    battlefieldSalvageRealtimeChannel = db.channel('battlefield_salvage_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'battlefield_salvage' }, () => {
            loadBattlefieldSalvage();
        })
        .subscribe();
}
window.initBattlefieldSalvageRealtimeChannel = initBattlefieldSalvageRealtimeChannel;

window.toggleSalvagePanel = function() {
    const panel = document.getElementById('salvage-panel');
    if (!panel) return;
    const opening = panel.style.display !== 'block';
    panel.style.display = opening ? 'block' : 'none';
    if (opening) loadBattlefieldSalvage();
};

window.startSalvageGather = async function(salvageId) {
    const rec = window.globalBattlefieldSalvageCache.find(r => r.id === salvageId);
    if (!rec || rec.status !== 'available') return;
    const shipSelect = document.getElementById(`salvage-ship-${salvageId}`);
    const durationInput = document.getElementById(`salvage-duration-${salvageId}`);
    if (!shipSelect || !shipSelect.value) { alert('Select a vessel to gather with first.'); return; }
    const ship = globalShipMarkersCache.find(m => m.id === shipSelect.value);
    if (!ship) return;
    const dist = Math.hypot(ship.x - rec.x, ship.y - rec.y);
    if (dist > SALVAGE_GATHER_RANGE) { alert(`${ship.name} is too far from the wreckage to begin gathering (must be within ${SALVAGE_GATHER_RANGE} units).`); return; }
    const duration = Math.max(1, parseFloat(durationInput && durationInput.value) || 24);

    const { error } = await db.from('battlefield_salvage').update({
        status: 'gathering', gathering_ship_id: ship.id,
        gather_started_at_hours: window.universeTimeHours, gather_duration_hours: duration
    }).eq('id', salvageId);
    if (error) { alert('Failed to start gathering: ' + error.message); return; }
    await db.from('chat_logs').insert({ sender_id: null, content: `⏳ [SALVAGE] ${ship.name} began recovering wreckage — ready in ${duration}h.`, message_type: 'system' });
    loadBattlefieldSalvage();
};

window.updateSalvageQty = async function(salvageId) {
    if (currentUserRole !== 'dm') return;
    const input = document.getElementById(`salvage-qty-${salvageId}`);
    if (!input) return;
    const qty = Math.max(0, parseInt(input.value) || 0);
    await db.from('battlefield_salvage').update({ qty }).eq('id', salvageId);
    loadBattlefieldSalvage();
};

/* Runs on EVERY time advancement (js/ui.js processTimeAdvancement), not just
   daily ticks — a gather duration can be sub-day. Queries the DB directly
   rather than the local cache, since whichever client advances time should
   resolve every completed gather regardless of that client's own cache
   freshness. */
window.processSalvageGatherCompletion = async function(newHours) {
    const { data, error } = await db.from('battlefield_salvage').select('*').eq('status', 'gathering');
    if (error || !data || data.length === 0) return;
    let any = false;
    for (const rec of data) {
        if (rec.gather_started_at_hours === null || rec.gather_duration_hours === null) continue;
        if (newHours < rec.gather_started_at_hours + rec.gather_duration_hours) continue;
        const ship = globalShipMarkersCache.find(m => m.id === rec.gathering_ship_id);
        if (!ship) continue; // gathering vessel no longer exists — leave the record rather than silently discarding it

        // Bug-hunt pass (2026-09-24): claim the record FIRST by deleting it
        // and checking we were the one who deleted it. Two clients (or two
        // overlapping time ticks) processing the same completed gather used
        // to BOTH deliver the salvage before either deleted the record --
        // double cargo. Now only the client whose delete actually removed
        // the row delivers; if delivery then fails, the record is put back
        // so the next tick retries it instead of the salvage vanishing.
        const { data: claimed, error: claimErr } = await db.from('battlefield_salvage').delete().eq('id', rec.id).select();
        if (claimErr || !claimed || claimed.length === 0) continue; // already claimed/delivered elsewhere

        let cargo = (typeof window.sanitizeCargo === 'function') ? window.sanitizeCargo(ship.cargo_inventory || {}) : (ship.cargo_inventory || {});
        let existing = cargo.misc.find(i => (i.name || '').toLowerCase() === (rec.resource_name || '').toLowerCase());
        if (existing) existing.qty += rec.qty;
        else cargo.misc.push({ name: rec.resource_name, qty: rec.qty, unit: rec.unit || 'Tons' });

        const { error: deliverErr } = await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', ship.id);
        if (deliverErr) {
            console.error('processSalvageGatherCompletion: delivery failed, restoring salvage record for retry', deliverErr);
            await db.from('battlefield_salvage').insert(rec);
            if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData(); // resync the cargo cache we just touched
            continue;
        }
        ship.cargo_inventory = cargo;
        await db.from('chat_logs').insert({ sender_id: null, content: `📦 [SALVAGE] ${ship.name} recovered ${rec.qty}x ${rec.resource_name}.`, message_type: 'system' });
        any = true;
    }
    if (any) {
        // Pending-list follow-up (this session): "gather/salvage complete
        // has no chime hookup" — reusing playChime, the same SFX the Daily
        // Logistics 24-hour-cycle completion already uses for "something
        // finished" (js/ui.js), rather than inventing a new sound for this.
        if (window.AudioEngine) window.AudioEngine.playChime();
        loadBattlefieldSalvage();
        if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
    }
};

/* Manufacturing-deck post-processing — same once-daily cadence and linear
   HP-scaling pattern as window.processFleetGroupProduction (js/colonies.js),
   just sourced from per-ship salvage_processing_output/rate fields instead
   of a fleet_groups row, and consuming a cargo item instead of producing
   from nothing. Per-vessel try/catch isolation matches that function's own
   defense-in-depth convention (one bad vessel shouldn't block the rest). */
window.processSalvageConversion = async function(daysPassed) {
    if (typeof globalShipMarkersCache === 'undefined') return;
    for (const vessel of globalShipMarkersCache) {
        try {
            if (!vessel.salvage_processing_output || !(vessel.salvage_processing_rate > 0)) continue;
            let cargo = (typeof window.sanitizeCargo === 'function') ? window.sanitizeCargo(vessel.cargo_inventory || {}) : (vessel.cargo_inventory || {});
            let rawIdx = cargo.misc.findIndex(i => i.name.toLowerCase() === 'unprocessed wreckage salvage');
            if (rawIdx < 0 || !(cargo.misc[rawIdx].qty > 0)) continue;

            const mfgDeck = (vessel.ship_decks || []).find(d => d.type === 'manufacturing');
            const scale = mfgDeck ? Math.max(0, (mfgDeck.hp || 0) / (mfgDeck.max_hp || 1)) : 1;
            const maxConvertible = Math.max(0, Math.round(vessel.salvage_processing_rate * scale) * daysPassed);
            if (maxConvertible <= 0) continue;
            const consumed = Math.min(maxConvertible, cargo.misc[rawIdx].qty);
            if (consumed <= 0) continue;

            cargo.misc[rawIdx].qty -= consumed;
            if (cargo.misc[rawIdx].qty <= 0) cargo.misc.splice(rawIdx, 1);
            let outIdx = cargo.expendables.findIndex(i => i.name.toLowerCase() === vessel.salvage_processing_output.toLowerCase());
            if (outIdx >= 0) cargo.expendables[outIdx].qty += consumed;
            else cargo.expendables.push({ name: vessel.salvage_processing_output, qty: consumed, unit: 'Units' });

            await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vessel.id);
            vessel.cargo_inventory = cargo;
            await db.from('chat_logs').insert({
                sender_id: null,
                content: `⚙ [SALVAGE PROCESSING] ${vessel.name} refined ${consumed}x Unprocessed Wreckage Salvage into ${consumed}x ${vessel.salvage_processing_output}${mfgDeck ? ` (Manufacturing deck at ${Math.round(scale * 100)}%)` : ''}.`,
                message_type: 'system'
            });
        } catch (err) {
            console.error(`processSalvageConversion: failed for vessel "${vessel.name}" (${vessel.id})`, err);
        }
    }
};

window.saveSalvageProcessingConfig = async function(vesselId) {
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    if (currentUserRole !== 'dm' && !window.vesselHasOwner(vessel, currentUserId)) return;
    const outputInput = document.getElementById(`salvage-proc-output-${vesselId}`);
    const rateInput = document.getElementById(`salvage-proc-rate-${vesselId}`);
    const output = outputInput ? outputInput.value.trim() : '';
    const rate = Math.max(0, parseInt(rateInput && rateInput.value) || 0);
    const { error } = await db.from('ship_markers').update({ salvage_processing_output: output || null, salvage_processing_rate: rate }).eq('id', vesselId);
    if (error) { alert('Failed to save processing config: ' + error.message); return; }
    vessel.salvage_processing_output = output || null;
    vessel.salvage_processing_rate = rate;
    if (typeof window.showToast === 'function') window.showToast('Salvage processing configuration saved.');
};


// Salvage stays a normal draggable floating panel. Battle Map itself is NO
// LONGER draggable as of this session's full-screen build — it's now a
// fixed full-viewport overlay (same convention as #character-terminal),
// so a drag call on it would be meaningless/broken.
if (typeof makePanelDraggable === 'function') makePanelDraggable('salvage-panel', 'salvage-header', 'odyssey_salvage_pos');

window.renderSalvagePanel = function() {
    const container = document.getElementById('salvage-list-container');
    if (!container) return; // panel not in DOM yet
    const records = window.globalBattlefieldSalvageCache || [];
    if (records.length === 0) {
        container.innerHTML = '<span style="font-size:10px; color:#6b826a;">No recoverable wreckage detected.</span>';
        return;
    }
    const myShips = globalShipMarkersCache.filter(m => !m.is_strike_craft && window.vesselHasOwner(m, currentUserId));
    const shipOptionsHtml = myShips.map(m => `<option value="${m.id}">${m.name}</option>`).join('') || '<option value="">-- No vessels --</option>';

    container.innerHTML = records.map(rec => {
        const posLabel = `(${Math.round(rec.x)}, ${Math.round(rec.y)})`;
        if (rec.status === 'gathering') {
            const readyAt = (rec.gather_started_at_hours || 0) + (rec.gather_duration_hours || 0);
            const remainingH = Math.max(0, Math.round((readyAt - (window.universeTimeHours || 0)) * 10) / 10);
            const gatheringShip = globalShipMarkersCache.find(m => m.id === rec.gathering_ship_id);
            return `<div class="note-card" style="padding:6px; background:#030403; border-color:#ffaa00;">
                <div style="font-size:10px; color:#ffaa00;">⏳ Gathering at ${posLabel}</div>
                <div style="font-size:9px; color:#d4c5a9;">${gatheringShip ? gatheringShip.name : '(vessel missing)'} recovering ${rec.qty}x ${rec.resource_name} — ready in ~${remainingH}h.</div>
            </div>`;
        }
        // status === 'available'
        const dmQtyControl = currentUserRole === 'dm' ? `
            <div style="display:flex; gap:4px; align-items:center; margin-top:4px;">
                <label for="salvage-qty-${rec.id}" style="font-size:8px; color:#6b826a;">Qty:</label>
                <input type="number" id="salvage-qty-${rec.id}" value="${rec.qty}" min="0" style="width:50px; margin:0; font-size:9px; padding:2px; text-align:center;">
                <button class="layer-edit" onclick="window.updateSalvageQty('${rec.id}')" style="font-size:8px; padding:2px 6px;">SAVE</button>
            </div>` : '';
        return `<div class="note-card" style="padding:6px; background:#030403; border-color:#c9962f;">
            <div style="font-size:10px; color:#c9962f;">🛰️ Wreckage at ${posLabel}${rec.source_vessel_name ? ` — from ${rec.source_vessel_name}` : ''}</div>
            <div style="font-size:9px; color:#d4c5a9;">${rec.qty}x ${rec.resource_name}</div>
            <div style="display:flex; gap:4px; margin-top:4px; align-items:center;">
                <label for="salvage-ship-${rec.id}" style="display:none;">Gathering vessel</label>
                <select id="salvage-ship-${rec.id}" style="flex:1.5; margin:0; font-size:9px; padding:3px;">${shipOptionsHtml}</select>
                <label for="salvage-duration-${rec.id}" style="display:none;">Duration (hours)</label>
                <input type="number" id="salvage-duration-${rec.id}" value="24" min="1" title="Gather duration, hours" style="width:45px; margin:0; font-size:9px; padding:3px; text-align:center;">
                <button class="btn-deploy" onclick="window.startSalvageGather('${rec.id}')" style="font-size:9px; padding:3px 8px;">GATHER</button>
            </div>
            ${dmQtyControl}
        </div>`;
    }).join('');
};
