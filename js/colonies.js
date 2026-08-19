/* ==========================================================================
   js/colonies.js - COLONY & PLAYER-CONTROLLED FLEET MANAGER
   Full CRUD for planetary colonies and auxiliary fleet task groups.
   Ownership follows the same pattern as ship_markers: DM bypasses all
   restrictions, players can only edit/delete assets they own (owner_id).
   ========================================================================== */

let coloniesList = [];
let fleetGroupsList = [];
let activeColoniesSubtab = 'colonies';

async function loadColonies() {
    const { data } = await db.from('colonies').select('*').order('created_at', { ascending: true });
    if (data) { coloniesList = data; if (typeof window.renderColoniesPanel === 'function') window.renderColoniesPanel(); }
}

async function loadFleetGroups() {
    const { data } = await db.from('fleet_groups').select('*').order('created_at', { ascending: true });
    if (data) { fleetGroupsList = data; if (typeof window.renderFleetGroupsPanel === 'function') window.renderFleetGroupsPanel(); }
}

window.switchColoniesSubtab = function(subtab) {
    activeColoniesSubtab = subtab;
    document.getElementById('colonies-subtab-colonies').classList.toggle('active', subtab === 'colonies');
    document.getElementById('colonies-subtab-fleets').classList.toggle('active', subtab === 'fleets');
    document.getElementById('colonies-view').style.display = subtab === 'colonies' ? 'block' : 'none';
    document.getElementById('fleets-view').style.display = subtab === 'fleets' ? 'block' : 'none';
};

function canManage(asset) {
    return currentUserRole === 'dm' || asset.owner_id === currentUserId;
}

/* --- COLONIES --- */

window.renderColoniesPanel = function() {
    const container = document.getElementById('colonies-list-container');
    if (container) {
        let html = '';
        if (coloniesList.length === 0) html = '<span style="font-size:10px; color:#6b826a;">No colonies established yet.</span>';
        const ordered = window.applySavedOrder('colonies', coloniesList);
        ordered.forEach(c => {
            const editable = canManage(c);
            const moraleColor = c.morale === 'Thriving' ? '#00e5a3' : c.morale === 'Unrest' ? '#ffaa00' : c.morale === 'Crisis' ? '#ff3333' : '#c9962f';
            html += `
                <div class="note-card">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <strong style="color:#ffaa00; font-size:12px;">${c.name}</strong>
                            <p style="margin:2px 0 0 0; font-size:10px; color:#d4c5a9;">POP: ${Number(c.population || 0).toLocaleString()} &nbsp;·&nbsp; MORALE: <span style="color:${moraleColor};">${c.morale}</span></p>
                            <p style="margin:2px 0 0 0; font-size:10px; color:#6b826a;">Producing: ${c.resource_output || 0}x ${c.resource_type || 'Unspecified'} / cycle</p>
                        </div>
                        <div style="display:flex; gap:4px;">
                            ${window.renderReorderArrows('colonies', ordered, c.id, 'moveColonyOrder')}
                            ${editable ? `<button class="layer-edit" onclick="window.openEditColonyModal('${c.id}')" style="padding:3px 7px; font-size:9px;">✎</button>
                            <button class="layer-del" onclick="window.deleteColony('${c.id}')" style="padding:3px 7px; font-size:9px;">✕</button>` : ''}
                        </div>
                    </div>
                    <div style="display:flex; gap:6px; margin-top:8px; align-items:center;">
                        <label for="colony-deliver-vessel-${c.id}" style="display:none;">Deliver To</label>
                        <select id="colony-deliver-vessel-${c.id}" style="flex:1; margin:0; font-size:9px; padding:3px;"></select>
                        <button class="btn-deploy" onclick="window.deliverColonyResources('${c.id}')" style="width:auto; margin:0; padding:4px 8px; font-size:9px;">DELIVER TO EXPENDABLES</button>
                    </div>
                </div>`;
        });
        container.innerHTML = html;
        // Populate each colony's delivery-target vessel dropdown.
        coloniesList.forEach(c => {
            const sel = document.getElementById(`colony-deliver-vessel-${c.id}`);
            if (!sel) return;
            sel.innerHTML = globalShipMarkersCache.map(m => `<option value="${m.id}">${m.name}</option>`).join('') || '<option value="">No vessels</option>';
        });
    }
    const badge = document.getElementById('badge-colonies');
    if (badge) badge.innerText = coloniesList.length + fleetGroupsList.length;
};
window.moveColonyOrder = function(id, direction) {
    window.moveListItem('colonies', window.applySavedOrder('colonies', coloniesList), id, direction);
    window.renderColoniesPanel();
};

window.addColony = async function() {
    const name = document.getElementById('new-colony-name').value.trim();
    if (!name) { alert("Enter a colony designation first."); return; }
    const population = parseInt(document.getElementById('new-colony-pop').value) || 0;
    const morale = document.getElementById('new-colony-morale').value;
    const resource_type = document.getElementById('new-colony-restype').value.trim() || 'Raw Materials';
    const resource_output = parseInt(document.getElementById('new-colony-resqty').value) || 0;

    const { error } = await db.from('colonies').insert({ owner_id: currentUserId, name, population, morale, resource_type, resource_output });
    if (error) { alert("Failed to establish colony: " + error.message); return; }

    document.getElementById('new-colony-name').value = '';
    document.getElementById('new-colony-pop').value = '0';
    document.getElementById('new-colony-restype').value = '';
    document.getElementById('new-colony-resqty').value = '10';
    if (typeof loadColonies === 'function') loadColonies();
};

window.deleteColony = async function(id) {
    const colony = coloniesList.find(c => c.id === id);
    if (colony && !canManage(colony)) return;
    if (!(await window.showConfirmModal(`Decommission colony "${colony ? colony.name : ''}"? This cannot be undone.`))) return;
    await db.from('colonies').delete().eq('id', id);
    if (typeof loadColonies === 'function') loadColonies();
};

window.deliverColonyResources = async function(id) {
    const colony = coloniesList.find(c => c.id === id);
    if (!colony) return;
    const select = document.getElementById(`colony-deliver-vessel-${id}`);
    const vesselId = select ? select.value : null;
    if (!vesselId) { alert("Select a vessel to receive the shipment first."); return; }
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    let existing = cargo.expendables.find(item => item.name.toLowerCase() === (colony.resource_type || '').toLowerCase());
    if (existing) { existing.qty += (colony.resource_output || 0); }
    else { cargo.expendables.push({ name: colony.resource_type || 'Raw Materials', qty: colony.resource_output || 0, unit: 'Units' }); }

    await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
    vessel.cargo_inventory = cargo;
    if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();

    await db.from('chat_logs').insert({
        sender_id: 'system',
        content: `📦 [SUPPLY RUN] ${colony.resource_output || 0}x ${colony.resource_type || 'Raw Materials'} delivered from ${colony.name} to ${vessel.name}'s expendables hold.`,
        message_type: 'text'
    });
};

/* --- COLONY EDIT MODAL --- */
(function() {
    let overlay, currentId;
    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'colony-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:380px; max-width:92vw; border-color:#ffaa00;">
            <h4 style="color:#ffaa00; margin-top:0;">Edit Colony</h4>
            <label for="colony-edit-name" style="font-size:9px; color:#6b826a;">Designation</label>
            <input type="text" id="colony-edit-name" style="border-color:#ffaa00;">
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="colony-edit-pop" style="font-size:9px; color:#6b826a;">Population</label><input type="number" id="colony-edit-pop" min="0" style="border-color:#ffaa00; text-align:center;"></div>
                <div style="flex:1;">
                    <label for="colony-edit-morale" style="font-size:9px; color:#6b826a;">Morale</label>
                    <select id="colony-edit-morale" style="border-color:#ffaa00;">
                        <option value="Thriving">Thriving</option>
                        <option value="Stable">Stable</option>
                        <option value="Unrest">Unrest</option>
                        <option value="Crisis">Crisis</option>
                    </select>
                </div>
            </div>
            <div style="display:flex; gap:6px;">
                <div style="flex:1.5;"><label for="colony-edit-restype" style="font-size:9px; color:#6b826a;">Resource Type</label><input type="text" id="colony-edit-restype" style="border-color:#ffaa00;"></div>
                <div style="flex:1;"><label for="colony-edit-resqty" style="font-size:9px; color:#6b826a;">Qty / Cycle</label><input type="number" id="colony-edit-resqty" min="0" style="border-color:#ffaa00; text-align:center;"></div>
            </div>
            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="colony-edit-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="colony-edit-save-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#ffaa00; color:#ffaa00;">SAVE CHANGES</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('colony-edit-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('colony-edit-save-btn').addEventListener('click', async () => {
            const updates = {
                name: document.getElementById('colony-edit-name').value.trim() || 'Unnamed Colony',
                population: parseInt(document.getElementById('colony-edit-pop').value) || 0,
                morale: document.getElementById('colony-edit-morale').value,
                resource_type: document.getElementById('colony-edit-restype').value.trim() || 'Raw Materials',
                resource_output: parseInt(document.getElementById('colony-edit-resqty').value) || 0
            };
            const { error } = await db.from('colonies').update(updates).eq('id', currentId);
            if (error) { alert("Failed to save colony changes: " + error.message); return; }
            overlay.style.display = 'none';
            if (typeof loadColonies === 'function') loadColonies();
        });
    }
    window.openEditColonyModal = function(id) {
        const colony = coloniesList.find(c => c.id === id);
        if (!colony) return;
        ensureModal();
        currentId = id;
        document.getElementById('colony-edit-name').value = colony.name || '';
        document.getElementById('colony-edit-pop').value = colony.population || 0;
        document.getElementById('colony-edit-morale').value = colony.morale || 'Stable';
        document.getElementById('colony-edit-restype').value = colony.resource_type || '';
        document.getElementById('colony-edit-resqty').value = colony.resource_output || 0;
        overlay.style.display = 'flex';
    };
})();

/* --- FLEET TASK GROUPS --- */

window.populateFleetFormSelects = function() {
    const shipSel = document.getElementById('new-fleet-ship');
    if (shipSel) shipSel.innerHTML = globalShipMarkersCache.map(m => `<option value="${m.id}">${m.name}</option>`).join('') || '<option value="">No vessels available</option>';
    const routeSel = document.getElementById('new-fleet-route');
    if (routeSel) routeSel.innerHTML = '<option value="">No Assigned Route</option>' + globalHyperlanesCache.map(r => `<option value="${r.id}">${r.name || 'Unnamed Route'}</option>`).join('');
};

window.locateFleetShip = function(shipId) {
    const ship = globalShipMarkersCache.find(m => m.id === shipId);
    if (!ship) return;
    window.selectedTarget = { type: 'ship', data: ship };
    if (typeof window.lockCameraOnSelected === 'function') window.lockCameraOnSelected();
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
};

window.renderFleetGroupsPanel = function() {
    const container = document.getElementById('fleets-list-container');
    if (container) {
        let html = '';
        if (fleetGroupsList.length === 0) html = '<span style="font-size:10px; color:#6b826a;">No fleet task groups commissioned yet.</span>';
        const statusColors = { 'Standby': '#6b826a', 'Patrolling': '#00e5a3', 'Escorting': '#00e1ff', 'Mining Operations': '#ffaa00', 'RTB': '#ff6b6b' };
        const ordered = window.applySavedOrder('fleet_groups', fleetGroupsList);
        ordered.forEach(f => {
            const editable = canManage(f);
            const ship = globalShipMarkersCache.find(m => m.id === f.linked_ship_id);
            const route = globalHyperlanesCache.find(r => r.id === f.patrol_hyperlane_id);

            let dockingLine = '';
            if (ship && editable) {
                if (ship.docked_to) {
                    const master = globalShipMarkersCache.find(m => m.id === ship.docked_to);
                    dockingLine = `<div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:9px; color:#a2c4f5;">
                        <span>🔗 Docked to ${master ? master.name : 'Unknown'}</span>
                        <button class="layer-del" onclick="window.undockShip('${ship.id}')" style="padding:2px 6px; font-size:8px;">DETACH</button>
                    </div>`;
                } else {
                    const otherShips = globalShipMarkersCache.filter(s => s.id !== ship.id && !s.docked_to);
                    if (otherShips.length > 0) {
                        dockingLine = `<div style="display:flex; gap:4px; margin-top:6px;">
                            <label for="fleet-dock-select-${f.id}" style="display:none;">Dock To</label>
                            <select id="fleet-dock-select-${f.id}" style="flex:1; margin:0; font-size:9px; padding:3px;">${otherShips.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
                            <button class="btn-reveal" onclick="window.dockShipToMaster('${ship.id}', document.getElementById('fleet-dock-select-${f.id}').value)" style="width:auto; margin:0; padding:3px 7px; font-size:9px;">🔗 DOCK</button>
                        </div>`;
                    }
                }
            }

            html += `
                <div class="note-card">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <strong style="color:#00e1ff; font-size:12px;">${f.name}</strong>
                            <p style="margin:2px 0 0 0; font-size:10px;">STATUS: <span style="color:${statusColors[f.status] || '#d4c5a9'};">${f.status}</span></p>
                            <p style="margin:2px 0 0 0; font-size:10px; color:#6b826a;">Vessel: ${ship ? ship.name : '— Unassigned —'} ${route ? `&nbsp;·&nbsp; Route: ${route.name || 'Unnamed'}` : ''}</p>
                        </div>
                        <div style="display:flex; gap:4px;">
                            ${window.renderReorderArrows('fleet_groups', ordered, f.id, 'moveFleetGroupOrder')}
                            ${ship ? `<button class="layer-edit" onclick="window.locateFleetShip('${ship.id}')" style="padding:3px 7px; font-size:9px;" title="Locate on DRADIS">🎯</button>` : ''}
                            ${editable ? `
                            <button class="layer-edit" onclick="window.openEditFleetModal('${f.id}')" style="padding:3px 7px; font-size:9px;">✎</button>
                            <button class="layer-del" onclick="window.deleteFleetGroup('${f.id}')" style="padding:3px 7px; font-size:9px;">✕</button>` : ''}
                        </div>
                    </div>
                    ${dockingLine}
                </div>`;
        });
        container.innerHTML = html;
    }
    const badge = document.getElementById('badge-colonies');
    if (badge) badge.innerText = coloniesList.length + fleetGroupsList.length;
};
window.moveFleetGroupOrder = function(id, direction) {
    window.moveListItem('fleet_groups', window.applySavedOrder('fleet_groups', fleetGroupsList), id, direction);
    window.renderFleetGroupsPanel();
};

window.addFleetGroup = async function() {
    const name = document.getElementById('new-fleet-name').value.trim();
    if (!name) { alert("Enter a task group designation first."); return; }
    const linked_ship_id = document.getElementById('new-fleet-ship').value || null;
    const status = document.getElementById('new-fleet-status').value;
    const patrol_hyperlane_id = document.getElementById('new-fleet-route').value || null;

    const { error } = await db.from('fleet_groups').insert({ owner_id: currentUserId, name, status, linked_ship_id, patrol_hyperlane_id });
    if (error) { alert("Failed to commission task group: " + error.message); return; }

    document.getElementById('new-fleet-name').value = '';
    if (typeof loadFleetGroups === 'function') loadFleetGroups();
};

window.deleteFleetGroup = async function(id) {
    const fleet = fleetGroupsList.find(f => f.id === id);
    if (fleet && !canManage(fleet)) return;
    if (!(await window.showConfirmModal(`Stand down task group "${fleet ? fleet.name : ''}"?`))) return;
    await db.from('fleet_groups').delete().eq('id', id);
    if (typeof loadFleetGroups === 'function') loadFleetGroups();
};

/* --- FLEET EDIT MODAL --- */
(function() {
    let overlay, currentId;
    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'fleet-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:380px; max-width:92vw; border-color:#00e1ff;">
            <h4 style="color:#00e1ff; margin-top:0;">Edit Task Group</h4>
            <label for="fleet-edit-name" style="font-size:9px; color:#6b826a;">Designation</label>
            <input type="text" id="fleet-edit-name" style="border-color:#00e1ff;">
            <label for="fleet-edit-ship" style="font-size:9px; color:#6b826a;">Linked Vessel Token</label>
            <select id="fleet-edit-ship" style="border-color:#00e1ff;"></select>
            <div style="display:flex; gap:6px;">
                <div style="flex:1;">
                    <label for="fleet-edit-status" style="font-size:9px; color:#6b826a;">Status</label>
                    <select id="fleet-edit-status" style="border-color:#00e1ff;">
                        <option value="Standby">Standby</option>
                        <option value="Patrolling">Patrolling</option>
                        <option value="Escorting">Escorting</option>
                        <option value="Mining Operations">Mining Operations</option>
                        <option value="RTB">RTB</option>
                    </select>
                </div>
                <div style="flex:1.3;">
                    <label for="fleet-edit-route" style="font-size:9px; color:#6b826a;">Patrol Route</label>
                    <select id="fleet-edit-route" style="border-color:#00e1ff;"><option value="">No Assigned Route</option></select>
                </div>
            </div>
            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="fleet-edit-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="fleet-edit-save-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#00e1ff; color:#00e1ff;">SAVE CHANGES</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('fleet-edit-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('fleet-edit-save-btn').addEventListener('click', async () => {
            const updates = {
                name: document.getElementById('fleet-edit-name').value.trim() || 'Unnamed Task Group',
                linked_ship_id: document.getElementById('fleet-edit-ship').value || null,
                status: document.getElementById('fleet-edit-status').value,
                patrol_hyperlane_id: document.getElementById('fleet-edit-route').value || null
            };
            const { error } = await db.from('fleet_groups').update(updates).eq('id', currentId);
            if (error) { alert("Failed to save task group changes: " + error.message); return; }
            overlay.style.display = 'none';
            if (typeof loadFleetGroups === 'function') loadFleetGroups();
        });
    }
    window.openEditFleetModal = function(id) {
        const fleet = fleetGroupsList.find(f => f.id === id);
        if (!fleet) return;
        ensureModal();
        currentId = id;
        document.getElementById('fleet-edit-name').value = fleet.name || '';
        document.getElementById('fleet-edit-ship').innerHTML = globalShipMarkersCache.map(m => `<option value="${m.id}">${m.name}</option>`).join('') || '<option value="">No vessels available</option>';
        document.getElementById('fleet-edit-ship').value = fleet.linked_ship_id || '';
        document.getElementById('fleet-edit-status').value = fleet.status || 'Standby';
        document.getElementById('fleet-edit-route').innerHTML = '<option value="">No Assigned Route</option>' + globalHyperlanesCache.map(r => `<option value="${r.id}">${r.name || 'Unnamed Route'}</option>`).join('');
        document.getElementById('fleet-edit-route').value = fleet.patrol_hyperlane_id || '';
        overlay.style.display = 'flex';
    };
})();
