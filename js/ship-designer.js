/* ==========================================================================
   js/ship-designer.js - CUSTOM SHIP BUILDER (Ship Designer terminal tab)
   Full CRUD on ship_templates (is_secret = false only — the Overseer Secret
   Repository is a separate view over the same table, filtered the other way).
   Ownership follows the same pattern as everything else in this app: DM
   bypasses all restrictions (GM override requirement), players can only
   edit/delete templates they own.
   ========================================================================== */

let shipTemplatesList = [];
let editingTemplateId = null;
window.secretShipTemplatesList = [];

async function loadShipTemplates() {
    const { data } = await db.from('ship_templates').select('*').eq('is_secret', false).order('created_at', { ascending: true });
    if (data) { shipTemplatesList = data; if (typeof window.renderShipDesignerPanel === 'function') window.renderShipDesignerPanel(); }
}

// DM-only — see the honest RLS note from earlier: the ship_templates policies
// actually enforce this at the database level (is_secret rows only return for
// a 'dm' role user), this client-side gate is just an extra courtesy so a
// non-DM client doesn't even attempt the query.
async function loadSecretShipTemplates() {
    if (currentUserRole !== 'dm') return;
    const { data } = await db.from('ship_templates').select('*').eq('is_secret', true).order('created_at', { ascending: true });
    if (data) { window.secretShipTemplatesList = data; if (typeof window.renderSecretRepositoryPanel === 'function') window.renderSecretRepositoryPanel(); }
}

// Both the public Ship Designer and the DM Secret Repository share the same
// table and the same edit/loadout/deploy machinery — this is the one place
// that knows to look in both lists, so nothing else needs to care which one
// a given template came from.
function findAnyTemplateById(id) {
    return shipTemplatesList.find(t => t.id === id) || (window.secretShipTemplatesList || []).find(t => t.id === id);
}

function canManageTemplate(t) {
    return currentUserRole === 'dm' || t.owner_id === currentUserId;
}

window.renderShipDesignerPanel = function() {
    const container = document.getElementById('ship-templates-list-container');
    if (!container) return;
    let html = '';
    if (shipTemplatesList.length === 0) html = '<span style="font-size:10px; color:#6b826a;">No vessel profiles designed yet.</span>';

    const ordered = window.applySavedOrder('ship_templates', shipTemplatesList);
    ordered.forEach(t => {
        const editable = canManageTemplate(t);
        const owner = allProfiles.find(p => p.id === t.owner_id);
        const weaponCount = (t.ship_weapons || []).length;
        const slots = t.hardpoint_slots || 4;
        // Station Designer build: a station has no hardpoint cap and doesn't
        // use drive_type (immobile, galaxy-scale FTL is irrelevant) — shown
        // with a distinct badge/line instead of the ship-oriented ones.
        const stationBadge = t.is_station ? `<span style="font-size:8px; color:#c9962f; border:1px solid #c9962f; border-radius:2px; padding:1px 4px; margin-left:6px;">🛰 STATION</span>` : '';
        // Squadron AI Stances build (this session) -- see the vessel_class
        // comment on saveNewShipTemplate (js/ship-designer.js) for what this
        // drives mechanically (Attack Capital Ships / Attack Escorts target
        // filtering). Purely a visibility badge here.
        const classBadge = t.vessel_class ? `<span style="font-size:8px; color:#c9962f; border:1px solid #c9962f; border-radius:2px; padding:1px 4px; margin-left:6px;">${t.vessel_class === 'Capital' ? '⬢ CAPITAL' : '◆ ESCORT'}</span>` : '';
        const classLine = t.is_station
            ? `${t.class || 'Station'} &nbsp;·&nbsp; Stationary Platform`
            : `${t.class || 'Frigate'} &nbsp;·&nbsp; ${(t.drive_type || 'ftl_class1').replace('ftl_', 'FTL ').replace('_', ' ').replace('sublight', 'Sublight')}`;
        const hardpointLine = t.is_station ? `Hardpoints: ${weaponCount} installed (no cap)` : `Hardpoints: ${weaponCount} / ${slots} installed`;
        html += `
            <div class="note-card">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#00e1ff; font-size:12px;">${t.name}</strong>${stationBadge}${classBadge}
                        <p style="margin:2px 0 0 0; font-size:10px; color:#d4c5a9;">${classLine}</p>
                        <p style="margin:2px 0 0 0; font-size:10px; color:#6b826a;">Shields ${t.max_shields || 0} · Reactive ${t.max_reactive || 0} · Ablative ${t.max_ablative || 0} · Hardened ${t.max_hardened || 0} · Hull ${t.max_hull || 0}</p>
                        <p style="margin:2px 0 0 0; font-size:10px; color:#6b826a;">${hardpointLine}</p>
                        <span class="author-tag">designer: ${owner ? (owner.username || 'Commander') : 'Unknown'}</span>
                    </div>
                    <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; max-width:120px;">
                        ${window.renderReorderArrows('ship_templates', ordered, t.id, 'moveShipTemplateOrder')}
                        <button class="btn-deploy" onclick="window.deployShipTemplate('${t.id}')" style="width:auto; margin:0; padding:4px 8px; font-size:9px;">🚀 DEPLOY</button>
                        ${editable ? `<button class="layer-edit" onclick="window.openEditTemplateModal('${t.id}')" style="padding:4px 7px; font-size:9px;">✎ STATS</button>` : ''}
                        ${editable ? `<button class="layer-edit" onclick="window.openTemplateLoadoutModal('${t.id}')" style="padding:4px 7px; font-size:9px; border-color:#ff6b6b; color:#ff6b6b;">⚔ LOADOUT</button>` : ''}
                        ${editable ? `<button class="layer-del" onclick="window.deleteShipTemplate('${t.id}')" style="padding:4px 7px; font-size:9px;">✕</button>` : ''}
                    </div>
                </div>
            </div>`;
    });
    container.innerHTML = html;
    const badge = document.getElementById('badge-shipdesigner');
    if (badge) badge.innerText = shipTemplatesList.length;

    const driveSel = document.getElementById('new-template-drive');
    if (driveSel && !driveSel.dataset.populated) {
        driveSel.innerHTML = `
            <option value="ftl_class1">Class 1 Warp Drive</option>
            <option value="ftl_class2">Class 2 Hyperdrive</option>
            <option value="ftl_fold">Experimental Fold Drive</option>
            <option value="sublight">Sublight Thrusters</option>`;
        driveSel.dataset.populated = 'true';
    }
};
window.moveShipTemplateOrder = function(id, direction) {
    window.moveListItem('ship_templates', window.applySavedOrder('ship_templates', shipTemplatesList), id, direction);
    window.renderShipDesignerPanel();
};

// Station Designer build: toggling "This is a Station" disables/zeroes the
// Tactical Speed input (stations are locked immobile — confirmed design,
// see the deploy/edit-modal comments below) and relabels the Hardpoint
// Slots field to make clear it won't be enforced for a station. Shared by
// both the "new template" form and the edit-template modal via an idPrefix.
window.toggleStationFields = function(idPrefix) {
    const isStation = document.getElementById(`${idPrefix}-station`).checked;
    const speedInput = document.getElementById(`${idPrefix}-speed`);
    const slotsInput = document.getElementById(`${idPrefix}-slots`);
    if (speedInput) {
        speedInput.disabled = isStation;
        if (isStation) speedInput.value = 0;
    }
    if (slotsInput) slotsInput.title = isStation ? 'Ignored for stations — no hardpoint cap' : '';
};

window.saveNewShipTemplate = async function() {
    const name = document.getElementById('new-template-name').value.trim();
    if (!name) { alert("Enter a vessel designation first."); return; }
    const isStation = document.getElementById('new-template-station').checked;
    const payload = {
        owner_id: currentUserId,
        name,
        class: document.getElementById('new-template-class').value.trim() || 'Frigate',
        drive_type: document.getElementById('new-template-drive').value,
        max_shields: parseInt(document.getElementById('new-template-shields').value) || 0,
        max_reactive: parseInt(document.getElementById('new-template-reactive').value) || 0,
        max_ablative: parseInt(document.getElementById('new-template-ablative').value) || 0,
        max_hardened: parseInt(document.getElementById('new-template-hardened').value) || 0,
        max_hull: parseInt(document.getElementById('new-template-hull').value) || 100,
        hardpoint_slots: parseInt(document.getElementById('new-template-slots').value) || 4,
        // Tactical Battle Map movement (added this session) — grid px/round
        // a deployed token can move before drag becomes DM-judgment-call
        // "overdrawn." Separate from drive_type/speed, which is the
        // galaxy-scale FTL travel stat and the wrong scale entirely for the
        // 460x380 tactical grid. Stations are locked to 0 — confirmed
        // design, enforced here regardless of what the (disabled) input
        // shows, in case it was toggled out of sync somehow.
        tactical_speed: isStation ? 0 : (parseInt(document.getElementById('new-template-speed').value) || 160),
        is_station: isStation,
        // Squadron AI Stances build (this session): optional, drives which
        // targets an AI-controlled squadron's Attack Capital Ships/Attack
        // Escorts stance will engage -- see STRIKE_CRAFT_DB's role-tag
        // comment (js/combat.js) and processBattleRoundAutomations
        // (js/battle-map.js) for where it's actually consumed. Purely
        // cosmetic (the class badge on the ship's stance card) for anyone
        // not using squadron AI.
        vessel_class: document.getElementById('new-template-vesselclass').value || null,
        ship_weapons: [],
        ship_decks: [],
        is_secret: false
    };
    const { error } = await db.from('ship_templates').insert(payload);
    if (error) { alert("Failed to save vessel profile: " + error.message); return; }

    document.getElementById('new-template-name').value = '';
    document.getElementById('new-template-class').value = '';
    document.getElementById('new-template-vesselclass').value = '';
    document.getElementById('new-template-station').checked = false;
    window.toggleStationFields('new-template');
    if (typeof loadShipTemplates === 'function') loadShipTemplates();
};

window.deleteShipTemplate = async function(id) {
    const t = findAnyTemplateById(id);
    if (t && !canManageTemplate(t)) return;
    if (!(await window.showConfirmModal(`Permanently delete vessel profile "${t ? t.name : ''}"?`))) return;
    await db.from('ship_templates').delete().eq('id', id);
    if (typeof loadShipTemplates === 'function') loadShipTemplates();
    if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
};

window.deployShipTemplate = async function(id) {
    const t = findAnyTemplateById(id);
    if (!t) return;

    let newCargo = typeof window.sanitizeCargo === 'function' ? window.sanitizeCargo({}) : {};
    const payload = {
        owner_id: currentUserId,
        name: t.name,
        drive_type: t.drive_type || 'ftl_class1',
        x: -window.camera.x / window.camera.zoom,
        y: -window.camera.y / window.camera.zoom,
        color: t.color || '#00e1ff',
        cargo_inventory: newCargo,
        integrity_shields: t.max_shields || 0, max_shields: t.max_shields || 0,
        integrity_reactive: t.max_reactive || 0, max_reactive: t.max_reactive || 0,
        integrity_ablative: t.max_ablative || 0, max_ablative: t.max_ablative || 0,
        integrity_hardened: t.max_hardened || 0, max_hardened: t.max_hardened || 0,
        integrity_hull: t.max_hull || 100, max_hull: t.max_hull || 100,
        tactical_speed: t.is_station ? 0 : (t.tactical_speed || 160),
        is_station: !!t.is_station,
        vessel_class: t.vessel_class || null,
        ship_weapons: JSON.parse(JSON.stringify(t.ship_weapons || [])),
        ship_decks: JSON.parse(JSON.stringify(t.ship_decks || []))
    };
    // .select().single() added this session (Tactical Battle Map build) so
    // callers can learn the new marker's id — e.g. to immediately place it
    // as a battle-map token. Purely additive: existing callers that ignore
    // the return value (deploying to the galaxy map) are unaffected.
    const { data, error } = await db.from('ship_markers').insert(payload).select().single();
    if (error) { alert("Failed to deploy vessel: " + error.message); return null; }
    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
    if (window.AudioEngine) window.AudioEngine.playPing();
    if (typeof window.showToast === 'function') window.showToast(`${t.name} deployed to your current DRADIS position.`);
    else alert(`${t.name} deployed to your current DRADIS position.`);
    return data ? data.id : null;
};

/* --- EDIT STATS MODAL --- */
(function() {
    let overlay, currentId;
    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'template-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:400px; max-width:92vw; border-color:#00e1ff;">
            <h4 style="color:#00e1ff; margin-top:0;">Edit Vessel Profile</h4>
            <label for="tmpl-edit-name" style="font-size:9px; color:#6b826a;">Designation</label>
            <input type="text" id="tmpl-edit-name" style="border-color:#00e1ff;">
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="tmpl-edit-class" style="font-size:9px; color:#6b826a;">Class</label><input type="text" id="tmpl-edit-class" style="border-color:#00e1ff;"></div>
                <div style="flex:1;">
                    <label for="tmpl-edit-drive" style="font-size:9px; color:#6b826a;">Drive Type</label>
                    <select id="tmpl-edit-drive" style="border-color:#00e1ff;">
                        <option value="ftl_class1">Class 1 Warp Drive</option>
                        <option value="ftl_class2">Class 2 Hyperdrive</option>
                        <option value="ftl_fold">Experimental Fold Drive</option>
                        <option value="sublight">Sublight Thrusters</option>
                    </select>
                </div>
            </div>
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="tmpl-edit-shields" style="font-size:9px; color:#6b826a;">Shields</label><input type="number" id="tmpl-edit-shields" min="0" style="border-color:#00e1ff; text-align:center;"></div>
                <div style="flex:1;"><label for="tmpl-edit-reactive" style="font-size:9px; color:#6b826a;">Reactive</label><input type="number" id="tmpl-edit-reactive" min="0" style="border-color:#00e1ff; text-align:center;"></div>
                <div style="flex:1;"><label for="tmpl-edit-ablative" style="font-size:9px; color:#6b826a;">Ablative</label><input type="number" id="tmpl-edit-ablative" min="0" style="border-color:#00e1ff; text-align:center;"></div>
            </div>
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="tmpl-edit-hardened" style="font-size:9px; color:#6b826a;">Hardened</label><input type="number" id="tmpl-edit-hardened" min="0" style="border-color:#00e1ff; text-align:center;"></div>
                <div style="flex:1;"><label for="tmpl-edit-hull" style="font-size:9px; color:#6b826a;">Hull</label><input type="number" id="tmpl-edit-hull" min="0" style="border-color:#00e1ff; text-align:center;"></div>
                <div style="flex:1;"><label for="tmpl-edit-slots" style="font-size:9px; color:#6b826a;">Hardpoint Slots</label><input type="number" id="tmpl-edit-slots" min="0" style="border-color:#00e1ff; text-align:center;"></div>
            </div>
            <div style="display:flex; gap:6px; align-items:flex-end;">
                <div style="flex:1;"><label for="tmpl-edit-speed" style="font-size:9px; color:#6b826a;" title="Battle Map movement allowance, grid px/round">Tactical Speed</label><input type="number" id="tmpl-edit-speed" min="0" style="border-color:#00e1ff; text-align:center;"></div>
                <div style="flex:1;"><label for="tmpl-edit-station" style="font-size:10px; color:#c9962f; display:flex; align-items:center; gap:4px; cursor:pointer; margin-bottom:8px;"><input type="checkbox" id="tmpl-edit-station" onchange="window.toggleStationFields('tmpl-edit')" style="margin:0;"> 🛰 This is a Station</label></div>
            </div>
            <div>
                <label for="tmpl-edit-vesselclass" style="font-size:9px; color:#c9962f;" title="Used by squadron AI Stances (Attack Capital Ships / Attack Escorts) to tell targets apart -- otherwise cosmetic.">Vessel Classification</label>
                <select id="tmpl-edit-vesselclass" style="border-color:#c9962f;">
                    <option value="">-- Unclassified --</option>
                    <option value="Capital">Capital Ship</option>
                    <option value="Escort">Escort</option>
                </select>
            </div>
            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="tmpl-edit-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="tmpl-edit-save-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#00e1ff; color:#00e1ff;">SAVE CHANGES</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('tmpl-edit-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('tmpl-edit-save-btn').addEventListener('click', async () => {
            const isStation = document.getElementById('tmpl-edit-station').checked;
            const updates = {
                name: document.getElementById('tmpl-edit-name').value.trim() || 'Unnamed Vessel',
                class: document.getElementById('tmpl-edit-class').value.trim() || 'Frigate',
                drive_type: document.getElementById('tmpl-edit-drive').value,
                max_shields: parseInt(document.getElementById('tmpl-edit-shields').value) || 0,
                max_reactive: parseInt(document.getElementById('tmpl-edit-reactive').value) || 0,
                max_ablative: parseInt(document.getElementById('tmpl-edit-ablative').value) || 0,
                max_hardened: parseInt(document.getElementById('tmpl-edit-hardened').value) || 0,
                max_hull: parseInt(document.getElementById('tmpl-edit-hull').value) || 0,
                hardpoint_slots: parseInt(document.getElementById('tmpl-edit-slots').value) || 4,
                tactical_speed: isStation ? 0 : (parseInt(document.getElementById('tmpl-edit-speed').value) || 160),
                is_station: isStation,
                vessel_class: document.getElementById('tmpl-edit-vesselclass').value || null
            };
            const { error } = await db.from('ship_templates').update(updates).eq('id', currentId);
            if (error) { alert("Failed to save changes: " + error.message); return; }
            overlay.style.display = 'none';
            if (typeof loadShipTemplates === 'function') loadShipTemplates();
            if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
        });
    }
    window.openEditTemplateModal = function(id) {
        const t = findAnyTemplateById(id);
        if (!t) return;
        ensureModal();
        currentId = id;
        document.getElementById('tmpl-edit-name').value = t.name || '';
        document.getElementById('tmpl-edit-class').value = t.class || '';
        document.getElementById('tmpl-edit-drive').value = t.drive_type || 'ftl_class1';
        document.getElementById('tmpl-edit-shields').value = t.max_shields || 0;
        document.getElementById('tmpl-edit-reactive').value = t.max_reactive || 0;
        document.getElementById('tmpl-edit-ablative').value = t.max_ablative || 0;
        document.getElementById('tmpl-edit-hardened').value = t.max_hardened || 0;
        document.getElementById('tmpl-edit-hull').value = t.max_hull || 0;
        document.getElementById('tmpl-edit-slots').value = t.hardpoint_slots || 4;
        document.getElementById('tmpl-edit-speed').value = t.tactical_speed || 160;
        document.getElementById('tmpl-edit-vesselclass').value = t.vessel_class || '';
        document.getElementById('tmpl-edit-station').checked = !!t.is_station;
        window.toggleStationFields('tmpl-edit');
        overlay.style.display = 'flex';
    };
})();

/* --- LOADOUT & DECKS MODAL (weapons + internal decks, reuses the shared
   12-type damage matrix) --- */
(function() {
    let overlay, currentId;
    function renderLoadoutList() {
        const t = findAnyTemplateById(currentId);
        if (!t) return;

        // Self-heal legacy decks missing a stable id — same pattern as
        // combat.js's renderVesselDeck (ship_decks predates weapon-deck
        // gating and has no id field otherwise).
        t.ship_decks = t.ship_decks || [];
        if (window.ensureDeckIds(t.ship_decks)) {
            db.from('ship_templates').update({ ship_decks: t.ship_decks }).eq('id', currentId);
        }

        const listEl = document.getElementById('tmpl-loadout-list');
        const weapons = t.ship_weapons || [];
        let html = '';
        if (weapons.length === 0) html = '<span style="font-size:10px; color:#6b826a;">No hardpoints configured.</span>';
        weapons.forEach((w, idx) => {
            const dt = window.normalizeDamageType(w.damage_type || 'Impact');
            const info = window.DAMAGE_TYPES[dt];
            const assignedDeck = w.assigned_deck_id ? t.ship_decks.find(d => d.id === w.assigned_deck_id) : null;
            const deckTag = assignedDeck ? ` · <span style="color:#6b826a;">🔧 ${assignedDeck.name}</span>` : '';
            html += `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:4px;">
                <span style="font-size:10px; color:#d4c5a9;">${w.name} — ${w.dice}${w.modifier} ${w.explodes ? '💥' : ''} · <span style="color:${info.color};">${dt}</span> · ${w.gun_count || 1}x guns${deckTag}</span>
                <button class="layer-del" onclick="window.removeTemplateWeapon(${idx})" style="padding:2px 6px; font-size:9px;">✕</button>
            </div>`;
        });
        listEl.innerHTML = html;
        const slots = t.hardpoint_slots || 4;
        document.getElementById('tmpl-loadout-slots-label').innerText = t.is_station ? `${weapons.length} hardpoints (no cap — station)` : `${weapons.length} / ${slots} hardpoints used`;

        const deckAssignSelect = document.getElementById('tmpl-loadout-deck');
        if (deckAssignSelect) {
            deckAssignSelect.innerHTML = '<option value="">-- Not deck-gated --</option>' + t.ship_decks.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
        }

        const deckListEl = document.getElementById('tmpl-decks-list');
        const decks = t.ship_decks || [];
        let deckHtml = '';
        if (decks.length === 0) deckHtml = '<span style="font-size:10px; color:#6b826a;">No internal decks configured.</span>';
        decks.forEach((d, idx) => {
            deckHtml += `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:4px;">
                <span style="font-size:10px; color:#d4c5a9;">${d.name} — ${d.hp}/${d.max_hp} HP</span>
                <button class="layer-del" onclick="window.removeTemplateDeck(${idx})" style="padding:2px 6px; font-size:9px;">✕</button>
            </div>`;
        });
        deckListEl.innerHTML = deckHtml;
    }

    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'template-loadout-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:440px; max-width:94vw; max-height:88vh; overflow-y:auto; border-color:#ff6b6b;">
            <h4 style="color:#ff6b6b; margin-top:0;">Weapon Loadout <span id="tmpl-loadout-slots-label" style="font-size:9px; color:#6b826a; font-weight:normal;"></span></h4>
            <div id="tmpl-loadout-list" style="max-height:180px; overflow-y:auto; margin-bottom:10px;"></div>
            <div style="background:#030403; padding:8px; border:1px solid #ff3333; border-radius:2px;">
                <label for="tmpl-loadout-name" style="font-size:9px; color:#ffaaaa;">Add Weapon</label>
                <input type="text" id="tmpl-loadout-name" placeholder="Weapon Name" style="border-color:#ff3333;">
                <div style="display:flex; gap:6px;">
                    <input type="text" id="tmpl-loadout-dice" placeholder="d20" style="flex:1; border-color:#ff3333; text-align:center;">
                    <input type="text" id="tmpl-loadout-mod" placeholder="+0" style="flex:1; border-color:#ff3333; text-align:center;">
                    <input type="number" id="tmpl-loadout-guns" placeholder="Guns" min="1" value="1" style="flex:1; border-color:#ff3333; text-align:center;">
                </div>
                <select id="tmpl-loadout-dmgtype" style="border-color:#ff3333;">${window.buildDamageTypeOptionsHtml('Impact')}</select>
                <label for="tmpl-loadout-deck" style="font-size:9px; color:#ffaaaa; margin-top:6px; display:block;" title="A destroyed deck can't fire its assigned weapons — Station Designer's lightweight section-damage mechanic.">Assigned Deck (optional):</label>
                <select id="tmpl-loadout-deck" style="border-color:#ff3333;"></select>
                <label for="tmpl-loadout-explodes" style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:6px;">
                    <input type="checkbox" id="tmpl-loadout-explodes" checked style="margin:0;"> Exploding Dice
                </label>
                <button class="btn-remove" onclick="window.addTemplateWeapon()" style="width:100%; margin-top:6px; font-size:10px;">+ ADD HARDPOINT</button>
            </div>

            <h4 style="color:#00e1ff; margin-top:14px; border-top:1px solid #3c4e36; padding-top:10px;">Internal Decks</h4>
            <div id="tmpl-decks-list" style="max-height:140px; overflow-y:auto; margin-bottom:10px;"></div>
            <div style="background:#030403; padding:8px; border:1px solid #00e1ff; border-radius:2px;">
                <label for="tmpl-deck-name" style="font-size:9px; color:#6b826a;">Add Deck / Subsystem</label>
                <div style="display:flex; gap:6px;">
                    <input type="text" id="tmpl-deck-name" placeholder="e.g. Engineering, Bridge..." style="flex:2; border-color:#00e1ff;">
                    <input type="number" id="tmpl-deck-hp" placeholder="Max HP" value="50" style="flex:1; border-color:#00e1ff; text-align:center;">
                </div>
                <button class="btn-reveal" onclick="window.addTemplateDeck()" style="width:100%; margin-top:6px; font-size:10px; border-color:#00e1ff; color:#00e1ff;">+ ADD DECK</button>
            </div>

            <button id="tmpl-loadout-close-btn" style="width:100%; margin-top:12px;">CLOSE</button>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('tmpl-loadout-close-btn').addEventListener('click', () => { overlay.style.display = 'none'; if (typeof loadShipTemplates === 'function') loadShipTemplates(); if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates(); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.style.display = 'none'; if (typeof loadShipTemplates === 'function') loadShipTemplates(); if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates(); } });
    }

    window.openTemplateLoadoutModal = function(id) {
        const t = findAnyTemplateById(id);
        if (!t) return;
        ensureModal();
        currentId = id;
        renderLoadoutList();
        overlay.style.display = 'flex';
    };

    window.addTemplateWeapon = async function() {
        const t = findAnyTemplateById(currentId);
        if (!t) return;
        const slots = t.hardpoint_slots || 4;
        const weapons = t.ship_weapons || [];
        // Station Designer build: no hardpoint cap for a station — confirmed
        // design, since a battlestation-scale platform needs far more
        // weapon batteries than any hull's slot count was meant to model.
        if (!t.is_station && weapons.length >= slots) { alert(`This hull only has ${slots} hardpoint slots — expand Hardpoint Slots in Edit Stats first.`); return; }

        const name = document.getElementById('tmpl-loadout-name').value.trim();
        if (!name) { alert("Enter a weapon name."); return; }
        let dice = document.getElementById('tmpl-loadout-dice').value.trim() || '1d10';
        let mod = document.getElementById('tmpl-loadout-mod').value.trim() || '+0';
        if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
        const gunCount = parseInt(document.getElementById('tmpl-loadout-guns').value) || 1;
        const dmgType = document.getElementById('tmpl-loadout-dmgtype').value;
        const explodes = document.getElementById('tmpl-loadout-explodes').checked;
        const deckSelect = document.getElementById('tmpl-loadout-deck');
        const assignedDeckId = (deckSelect && deckSelect.value) ? deckSelect.value : null;

        weapons.push({ loc: 'Hardpoint', name, dice, modifier: mod, explodes, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0, gun_count: gunCount, damage_type: dmgType, assigned_deck_id: assignedDeckId });
        const { error } = await db.from('ship_templates').update({ ship_weapons: weapons }).eq('id', currentId);
        if (error) { alert("Failed to add weapon: " + error.message); return; }
        t.ship_weapons = weapons;
        document.getElementById('tmpl-loadout-name').value = '';
        renderLoadoutList();
    };

    window.removeTemplateWeapon = async function(idx) {
        const t = findAnyTemplateById(currentId);
        if (!t) return;
        const weapons = t.ship_weapons || [];
        weapons.splice(idx, 1);
        await db.from('ship_templates').update({ ship_weapons: weapons }).eq('id', currentId);
        t.ship_weapons = weapons;
        renderLoadoutList();
    };

    window.addTemplateDeck = async function() {
        const t = findAnyTemplateById(currentId);
        if (!t) return;
        const name = document.getElementById('tmpl-deck-name').value.trim();
        if (!name) { alert("Enter a deck or subsystem name."); return; }
        const maxHp = parseInt(document.getElementById('tmpl-deck-hp').value) || 50;
        const decks = t.ship_decks || [];
        decks.push({ name, hp: maxHp, max_hp: maxHp, id: window.genDeckId() });
        const { error } = await db.from('ship_templates').update({ ship_decks: decks }).eq('id', currentId);
        if (error) { alert("Failed to add deck: " + error.message); return; }
        t.ship_decks = decks;
        document.getElementById('tmpl-deck-name').value = '';
        renderLoadoutList();
    };

    window.removeTemplateDeck = async function(idx) {
        const t = findAnyTemplateById(currentId);
        if (!t) return;
        const decks = t.ship_decks || [];
        decks.splice(idx, 1);
        await db.from('ship_templates').update({ ship_decks: decks }).eq('id', currentId);
        t.ship_decks = decks;
        renderLoadoutList();
    };
})();

/* --- OVERSEER SECRET SHIP REPOSITORY ---
   Same table (ship_templates), is_secret = true. Hidden from players both by
   the RLS policy on the table (real enforcement) and by living inside the
   DM Tools panel (already DM-only in the UI). Reuses the same edit/loadout/
   deploy machinery as the public Ship Designer above via findAnyTemplateById. */
window.renderSecretRepositoryPanel = function() {
    if (currentUserRole !== 'dm') return;
    const container = document.getElementById('secret-templates-list-container');
    if (!container) return;
    let html = '';
    if (window.secretShipTemplatesList.length === 0) html = '<span style="font-size:10px; color:#6b826a;">Repository empty — no hidden templates stored.</span>';

    window.secretShipTemplatesList.forEach(t => {
        const weaponCount = (t.ship_weapons || []).length;
        const stationBadge = t.is_station ? `<span style="font-size:8px; color:#c9962f; border:1px solid #c9962f; border-radius:2px; padding:1px 4px; margin-left:6px;">🛰 STATION</span>` : '';
        // Squadron AI Stances build (this session) -- see the vessel_class
        // comment on saveNewShipTemplate (js/ship-designer.js) for what this
        // drives mechanically (Attack Capital Ships / Attack Escorts target
        // filtering). Purely a visibility badge here.
        const classBadge = t.vessel_class ? `<span style="font-size:8px; color:#c9962f; border:1px solid #c9962f; border-radius:2px; padding:1px 4px; margin-left:6px;">${t.vessel_class === 'Capital' ? '⬢ CAPITAL' : '◆ ESCORT'}</span>` : '';
        const hardpointTag = t.is_station ? `${weaponCount} hardpoints (no cap)` : `${weaponCount}/${t.hardpoint_slots || 4} hardpoints`;
        html += `
            <div class="note-card" style="border-color:#ff3333;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#ff6b6b; font-size:12px;">${t.name}</strong>${stationBadge}${classBadge}
                        <p style="margin:2px 0 0 0; font-size:10px; color:#d4c5a9;">${t.class || 'Frigate'} · Hull ${t.max_hull || 0} · Shields ${t.max_shields || 0} · ${hardpointTag}</p>
                    </div>
                    <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; max-width:110px;">
                        <button class="layer-edit" onclick="window.openEditTemplateModal('${t.id}')" style="padding:3px 6px; font-size:9px;">✎</button>
                        <button class="layer-edit" onclick="window.openTemplateLoadoutModal('${t.id}')" style="padding:3px 6px; font-size:9px; border-color:#ff6b6b; color:#ff6b6b;">⚔</button>
                        <button class="layer-del" onclick="window.deleteShipTemplate('${t.id}')" style="padding:3px 6px; font-size:9px;">✕</button>
                    </div>
                </div>
                <div style="display:flex; gap:6px; margin-top:8px; align-items:center;">
                    <button class="btn-deploy" onclick="window.deployShipTemplate('${t.id}')" style="flex:1; margin:0; padding:4px 6px; font-size:9px;">🚀 DEPLOY TO MAP</button>
                    <label for="repo-init-${t.id}" style="display:none;">Initiative</label>
                    <input type="number" id="repo-init-${t.id}" placeholder="Init" value="10" style="width:50px; margin:0; padding:4px; font-size:9px; text-align:center;">
                    <button class="btn-remove" onclick="window.deployTemplateToInitiative('${t.id}')" style="flex:1; margin:0; padding:4px 6px; font-size:9px;">⚔ TO TRACKER</button>
                </div>
            </div>`;
    });
    container.innerHTML = html;

    const driveSel = document.getElementById('new-secret-template-drive');
    if (driveSel && !driveSel.dataset.populated) {
        driveSel.innerHTML = `
            <option value="ftl_class1">Class 1 Warp Drive</option>
            <option value="ftl_class2">Class 2 Hyperdrive</option>
            <option value="ftl_fold">Experimental Fold Drive</option>
            <option value="sublight">Sublight Thrusters</option>`;
        driveSel.dataset.populated = 'true';
    }
};

window.saveNewSecretTemplate = async function() {
    if (currentUserRole !== 'dm') return;
    const name = document.getElementById('new-secret-template-name').value.trim();
    if (!name) { alert("Enter a vessel designation first."); return; }
    const stationCheckbox = document.getElementById('new-secret-template-station');
    const isStation = stationCheckbox ? stationCheckbox.checked : false;
    const payload = {
        owner_id: currentUserId,
        name,
        class: document.getElementById('new-secret-template-class').value.trim() || 'Frigate',
        drive_type: document.getElementById('new-secret-template-drive').value,
        max_shields: parseInt(document.getElementById('new-secret-template-shields').value) || 0,
        max_hull: parseInt(document.getElementById('new-secret-template-hull').value) || 100,
        hardpoint_slots: parseInt(document.getElementById('new-secret-template-slots').value) || 4,
        tactical_speed: isStation ? 0 : (parseInt(document.getElementById('new-secret-template-speed').value) || 160),
        is_station: isStation,
        ship_weapons: [],
        ship_decks: [],
        is_secret: true,
        vessel_class: document.getElementById('new-secret-template-vesselclass').value || null
    };
    const { error } = await db.from('ship_templates').insert(payload);
    if (error) { alert("Failed to store repository template: " + error.message); return; }

    document.getElementById('new-secret-template-name').value = '';
    document.getElementById('new-secret-template-class').value = '';
    document.getElementById('new-secret-template-vesselclass').value = '';
    if (stationCheckbox) { stationCheckbox.checked = false; window.toggleStationFields('new-secret-template'); }
    if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
};

window.deployTemplateToInitiative = async function(id) {
    const t = findAnyTemplateById(id);
    if (!t) return;
    const initInput = document.getElementById(`repo-init-${id}`);
    const initiative = initInput ? (parseInt(initInput.value) || 10) : 10;
    // Pending-list follow-up (this session): is_npc: true set explicitly —
    // this is the DM's own tool for injecting a vessel/template as an
    // initiative combatant, an NPC-style entry regardless of the DM's own
    // profile happening to have a linked character.
    const { error } = await db.from('combat_tracker').insert({
        name: t.name, initiative, hp: `${t.max_hull || 0}/${t.max_hull || 0}`, owner_id: currentUserId, is_npc: true
    });
    if (error) { alert("Failed to inject into initiative tracker: " + error.message); return; }
    if (typeof loadCombatTracker === 'function') loadCombatTracker();
    if (window.AudioEngine) window.AudioEngine.playPing();
};

/* --- SAVED FLEETS (Battlefield Salvage/Battle Map follow-on, this session) ---
   Solves "don't make me re-deploy the same 4-ship raider squadron one
   template at a time every battle." Lives here (not battle-map.js) since
   it's fundamentally a Secret Repository CRUD feature — the actual
   deploy-to-grid action is what lives in battle-map.js (deployFleetToBattle),
   same file-ownership split as everything else deploy-related
   (deployShipTemplate lives here, deployTemplateToBattle lives there).

   A saved fleet is NOT a copy of any ship data — it's a named list of
   { template_id, quantity } references back into ship_templates, same
   "override/placement layer on top of the real entity" principle as
   battle_encounters.tokens. Deploying a fleet just calls the existing
   window.deployShipTemplate once per unit (quantity times per member),
   which already creates a fresh, fully-stocked ship_markers row each call —
   so reusing a fleet across battles never carries over battle damage from a
   prior fight; there's nothing TO carry over since each deploy is new.

   DM-only at the database level (see the saved_fleets_dm_only RLS policy,
   same "profiles.role = 'dm'" check ship_templates already uses for
   is_secret rows) — NOT the blanket-authenticated policy most tables in
   this app use, since a saved fleet has no public-facing variant at all. */
window.globalSavedFleetsCache = [];

async function loadSavedFleets() {
    if (currentUserRole !== 'dm') return; // client-side courtesy — RLS is the real gate
    const { data } = await db.from('saved_fleets').select('*').order('created_at', { ascending: true });
    if (data) { window.globalSavedFleetsCache = data; if (typeof window.renderSavedFleetsPanel === 'function') window.renderSavedFleetsPanel(); }
}
window.loadSavedFleets = loadSavedFleets;

let savedFleetsRealtimeChannel = null;
function initSavedFleetsRealtimeChannel() {
    savedFleetsRealtimeChannel = db.channel('saved_fleets_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'saved_fleets' }, () => {
            loadSavedFleets();
        })
        .subscribe();
}
window.initSavedFleetsRealtimeChannel = initSavedFleetsRealtimeChannel;

window.saveNewFleet = async function() {
    if (currentUserRole !== 'dm') return;
    const nameInput = document.getElementById('new-saved-fleet-name');
    const name = (nameInput && nameInput.value.trim()) || 'Untitled Fleet';

    // Pending-list follow-up (this session): "no duplicate-fleet-name
    // guard" — warns (doesn't hard-block) on an exact case-insensitive name
    // collision, since a DM might genuinely want two fleets sharing a name
    // (e.g. two variants of the same raiding party). Confirm-and-continue,
    // matching this app's existing "DM-trusted, ask rather than forbid"
    // pattern instead of introducing a new hard validation rule.
    const existing = (window.globalSavedFleetsCache || []).find(f => f.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
        if (!(await window.showConfirmModal(`A saved fleet named "${existing.name}" already exists. Create another one with the same name anyway?`))) return;
    }

    const { error } = await db.from('saved_fleets').insert({ name, owner_id: currentUserId, members: [] });
    if (error) { alert('Failed to save fleet: ' + error.message); return; }
    if (nameInput) nameInput.value = '';
    loadSavedFleets();
};

window.deleteSavedFleet = async function(id) {
    if (currentUserRole !== 'dm') return;
    const fleet = window.globalSavedFleetsCache.find(f => f.id === id);
    if (!(await window.showConfirmModal(`Permanently delete saved fleet "${fleet ? fleet.name : ''}"? This only removes the saved composition — it doesn't touch any templates in it or any vessel already deployed from it.`))) return;
    await db.from('saved_fleets').delete().eq('id', id);
    loadSavedFleets();
};

window.addFleetMember = async function(fleetId) {
    if (currentUserRole !== 'dm') return;
    const fleet = window.globalSavedFleetsCache.find(f => f.id === fleetId);
    if (!fleet) return;
    const select = document.getElementById(`fleet-add-tmpl-${fleetId}`);
    const qtyInput = document.getElementById(`fleet-add-qty-${fleetId}`);
    if (!select || !select.value) { alert('Select a template first.'); return; }
    const qty = Math.max(1, parseInt(qtyInput && qtyInput.value) || 1);

    const members = (fleet.members || []).slice();
    const existing = members.find(m => m.template_id === select.value);
    if (existing) existing.quantity += qty;
    else members.push({ template_id: select.value, quantity: qty });

    const { error } = await db.from('saved_fleets').update({ members }).eq('id', fleetId);
    if (error) { alert('Failed to add to fleet: ' + error.message); return; }
    fleet.members = members;
    if (qtyInput) qtyInput.value = '1';
    window.renderSavedFleetsPanel();
};

window.updateFleetMemberQty = async function(fleetId, templateId, delta) {
    if (currentUserRole !== 'dm') return;
    const fleet = window.globalSavedFleetsCache.find(f => f.id === fleetId);
    if (!fleet) return;
    const members = (fleet.members || []).map(m => m.template_id === templateId ? { ...m, quantity: Math.max(1, m.quantity + delta) } : m);
    await db.from('saved_fleets').update({ members }).eq('id', fleetId);
    fleet.members = members;
    window.renderSavedFleetsPanel();
};

window.removeFleetMember = async function(fleetId, templateId) {
    if (currentUserRole !== 'dm') return;
    const fleet = window.globalSavedFleetsCache.find(f => f.id === fleetId);
    if (!fleet) return;
    const members = (fleet.members || []).filter(m => m.template_id !== templateId);
    await db.from('saved_fleets').update({ members }).eq('id', fleetId);
    fleet.members = members;
    window.renderSavedFleetsPanel();
};

window.renderSavedFleetsPanel = function() {
    if (currentUserRole !== 'dm') return;
    const container = document.getElementById('saved-fleets-list-container');
    if (!container) return;
    const fleets = window.globalSavedFleetsCache || [];
    const allTemplates = (typeof shipTemplatesList !== 'undefined' ? shipTemplatesList : []).concat(window.secretShipTemplatesList || []);
    const tmplOptionsHtml = allTemplates.map(t => `<option value="${t.id}">${t.name}${t.is_secret ? ' 🔒' : ''}</option>`).join('') || '<option value="">-- No templates designed --</option>';

    if (fleets.length === 0) {
        container.innerHTML = '<span style="font-size:9px; color:#6b826a;">No saved fleets yet.</span>';
        return;
    }
    container.innerHTML = fleets.map(fleet => {
        const members = fleet.members || [];
        const memberRowsHtml = members.length === 0
            ? '<span style="font-size:8px; color:#6b826a;">Empty — add a vessel below.</span>'
            : members.map(m => {
                const t = findAnyTemplateById(m.template_id);
                return `<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 0; font-size:9px;">
                    <span style="color:#d4c5a9;">${t ? t.name : '(deleted template)'}${t && t.is_secret ? ' 🔒' : ''}</span>
                    <div style="display:flex; gap:3px; align-items:center;">
                        <button onclick="window.updateFleetMemberQty('${fleet.id}', '${m.template_id}', -1)" style="width:18px; padding:1px; margin:0; font-size:9px;">-</button>
                        <span style="min-width:14px; text-align:center; color:#ffaaaa;">${m.quantity}x</span>
                        <button onclick="window.updateFleetMemberQty('${fleet.id}', '${m.template_id}', 1)" style="width:18px; padding:1px; margin:0; font-size:9px;">+</button>
                        <button class="layer-del" onclick="window.removeFleetMember('${fleet.id}', '${m.template_id}')" style="font-size:8px; padding:1px 5px; margin-left:4px;">✕</button>
                    </div>
                </div>`;
            }).join('');
        return `
            <div class="note-card" style="border-color:#c778dd;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong style="color:#c778dd; font-size:12px;">${fleet.name}</strong>
                    <button class="layer-del" onclick="window.deleteSavedFleet('${fleet.id}')" style="padding:3px 6px; font-size:9px;">✕ DELETE FLEET</button>
                </div>
                <div style="margin-top:6px;">${memberRowsHtml}</div>
                <div style="display:flex; gap:4px; margin-top:8px; align-items:center; border-top:1px solid #3c4e36; padding-top:6px;">
                    <label for="fleet-add-tmpl-${fleet.id}" style="display:none;">Template</label>
                    <select id="fleet-add-tmpl-${fleet.id}" style="flex:2; font-size:9px; margin:0;">${tmplOptionsHtml}</select>
                    <label for="fleet-add-qty-${fleet.id}" style="display:none;">Quantity</label>
                    <input type="number" id="fleet-add-qty-${fleet.id}" value="1" min="1" style="width:36px; font-size:9px; margin:0; text-align:center;">
                    <button class="btn-deploy" onclick="window.addFleetMember('${fleet.id}')" style="font-size:9px; padding:3px 8px; border-color:#c778dd; color:#c778dd;">+ ADD</button>
                </div>
            </div>`;
    }).join('');
};
