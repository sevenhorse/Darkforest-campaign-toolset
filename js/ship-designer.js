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

// IFF build (this session): shared badge renderer, used by both the public
// Ship Designer and Secret Repository card lists, and reusable anywhere else
// an `iff` value needs a consistent visual (e.g. the Vessel Deck, if it ever
// wants to show a ship's own designation to the DM). No badge at all for
// unset (null) -- same "no badge = no info" convention vessel_class already
// uses, rather than a distracting "UNSET" tag on every un-tagged ship.
window.IFF_LABELS = { friendly: '✓ FRIENDLY', neutral: '◌ NEUTRAL', hostile: '⚠ HOSTILE' };
window.IFF_COLORS = { friendly: '#00e5a3', neutral: '#c9962f', hostile: '#ff3333' };
window.renderIffBadge = function(iff) {
    if (!iff || !window.IFF_LABELS[iff]) return '';
    const color = window.IFF_COLORS[iff];
    return `<span style="font-size:8px; color:${color}; border:1px solid ${color}; border-radius:2px; padding:1px 4px; margin-left:6px;">${window.IFF_LABELS[iff]}</span>`;
};

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
        const iffBadge = window.renderIffBadge(t.iff);
        const classLine = t.is_station
            ? `${t.class || 'Station'} &nbsp;·&nbsp; Stationary Platform`
            : `${t.class || 'Frigate'} &nbsp;·&nbsp; ${(t.drive_type || 'ftl_class1').replace('ftl_', 'FTL ').replace('_', ' ').replace('sublight', 'Sublight')}`;
        const hardpointLine = t.is_station ? `Hardpoints: ${weaponCount} installed (no cap)` : `Hardpoints: ${weaponCount} / ${slots} installed`;
        html += `
            <div class="note-card">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#00e1ff; font-size:12px;">${t.name}</strong>${stationBadge}${classBadge}${iffBadge}
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
        is_secret: false,
        // IFF build (this session): a player's own new template defaults to
        // Friendly automatically -- no UI picker on this form (unlike the
        // Secret Repository's, which defaults to Hostile), since a player's
        // own ship is already always visible to them via ownership; this
        // just makes it consistently visible to OTHER players too, matching
        // the existing "any player can see/fire any other player's ships"
        // Battle Map convention. Changeable later via the shared Edit
        // Vessel Profile modal if it's ever repurposed as an antagonist.
        iff: 'friendly'
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
    if (t && !canManageTemplate(t)) return false;
    if (!(await window.showConfirmModal(`Permanently delete vessel profile "${t ? t.name : ''}"?`))) return false;
    await db.from('ship_templates').delete().eq('id', id);
    if (typeof loadShipTemplates === 'function') loadShipTemplates();
    if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
    // Return value added this session for window.deleteSecretRepoTemplateAndClose
    // below, which needs to know whether the delete actually happened (vs. the
    // DM cancelling the confirm modal) before deciding whether to leave the
    // full-screen editor. Purely additive -- every existing caller already
    // ignores this function's return value.
    return true;
};

window.deployShipTemplate = async function(id) {
    const t = findAnyTemplateById(id);
    if (!t) return;

    // QOL build (2026-08-31): templates can now carry their own hangar/cargo
    // (Secret Repository), so deploy pulls from the template instead of
    // always starting blank -- same "carries over" treatment ship_weapons/
    // ship_decks already got. A template with nothing set still falls back
    // to sanitizeCargo's generic starter loadout, unchanged from before.
    let newCargo = typeof window.sanitizeCargo === 'function' ? window.sanitizeCargo(JSON.parse(JSON.stringify(t.cargo_inventory || {}))) : {};
    // Fresh per-instance squadron ids so two ships deployed from the same
    // template never share a squadron id (launch/recall/damage lookups are
    // scoped to one vessel's own hangar array, but distinct ids are cheap
    // insurance against any future cross-vessel assumption).
    const newHangar = (t.ship_hangar || []).map(sq => ({ ...JSON.parse(JSON.stringify(sq)), id: 'sq_' + Math.random().toString(36).substr(2, 9) }));
    const payload = {
        owner_id: currentUserId,
        name: t.name,
        drive_type: t.drive_type || 'ftl_class1',
        x: -window.camera.x / window.camera.zoom,
        y: -window.camera.y / window.camera.zoom,
        // Polish pass (this session): was `t.color || '#00e1ff'` -- since no
        // template ever has a `color` field of its own (no color picker
        // exists in the template editor), EVERY deployed template hit that
        // hardcoded cyan fallback regardless of its IFF. Now derives from
        // the template's own iff (window.getIffColor, js/combat.js) instead,
        // matching the color the quick-spawn form already uses for the same
        // IFF value -- this is the actual fix for "spawned ship tokens
        // appear as cyan even when tagged hostile."
        color: t.color || (typeof window.getIffColor === 'function' ? window.getIffColor(t.iff) : '#00e1ff'),
        cargo_inventory: newCargo,
        integrity_shields: t.max_shields || 0, max_shields: t.max_shields || 0,
        integrity_reactive: t.max_reactive || 0, max_reactive: t.max_reactive || 0,
        integrity_ablative: t.max_ablative || 0, max_ablative: t.max_ablative || 0,
        integrity_hardened: t.max_hardened || 0, max_hardened: t.max_hardened || 0,
        integrity_hull: t.max_hull || 100, max_hull: t.max_hull || 100,
        tactical_speed: t.is_station ? 0 : (t.tactical_speed || 160),
        is_station: !!t.is_station,
        vessel_class: t.vessel_class || null,
        // IFF build (this session): carried from the template into the
        // live ship_markers row, same pattern as vessel_class -- so a
        // deployed vessel's friend/foe visibility doesn't depend on looking
        // back at a template that might later be edited/deleted. Still
        // editable afterward per-deployment via the Vessel Deck's EDIT BASE
        // STATS modal (js/combat.js), independent of the source template.
        iff: t.iff || null,
        ship_weapons: JSON.parse(JSON.stringify(t.ship_weapons || [])),
        ship_decks: JSON.parse(JSON.stringify(t.ship_decks || [])),
        ship_hangar: newHangar
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
            <div id="tmpl-edit-iff-wrap" style="display:none;">
                <label for="tmpl-edit-iff" style="font-size:9px; color:#ff6b6b;" title="IFF (Identify Friend/Foe) -- controls whether players can see/edit a deployed copy of this template in their Vessel Deck. Friendly is visible alongside a player's own ships; Neutral/Hostile/unset stay DM-only. DM-only field.">IFF Designation (DM only)</label>
                <select id="tmpl-edit-iff" style="border-color:#ff6b6b;">
                    <option value="">-- Unset (DM-only) --</option>
                    <option value="hostile">⚠ Hostile</option>
                    <option value="neutral">◌ Neutral</option>
                    <option value="friendly">✓ Friendly</option>
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
                vessel_class: document.getElementById('tmpl-edit-vesselclass').value || null,
                iff: document.getElementById('tmpl-edit-iff').value || null
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
        document.getElementById('tmpl-edit-iff').value = t.iff || '';
        const iffWrap = document.getElementById('tmpl-edit-iff-wrap');
        if (iffWrap) iffWrap.style.display = (currentUserRole === 'dm') ? 'block' : 'none';
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
        // Bug fix (bug hunt, this session): was `t.ship_weapons || []` with no
        // clone -- when t.ship_weapons is already an array (always true after
        // creation), `weapons` was the SAME reference, so weapons.push()
        // below mutated the live cached t.ship_weapons synchronously, before
        // the DB write even resolved (let alone succeeded). Clone so nothing
        // is mutated until the write is confirmed.
        const weapons = (t.ship_weapons || []).slice();
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
        // Bug fix (bug hunt, this session): clone before splicing (same
        // aliasing issue as addTemplateWeapon), and check the update's error
        // -- this used to fall through to `t.ship_weapons = weapons` and
        // re-render as if the delete succeeded even when the DB write
        // failed, which could later cause a real weapon to be silently lost
        // on the next full-column ship_weapons overwrite (e.g. a subsequent
        // add) once the wrongly-reduced local length passed its hardpoint
        // cap check.
        const weapons = (t.ship_weapons || []).slice();
        weapons.splice(idx, 1);
        const { error } = await db.from('ship_templates').update({ ship_weapons: weapons }).eq('id', currentId);
        if (error) { alert("Failed to remove weapon: " + error.message); return; }
        t.ship_weapons = weapons;
        renderLoadoutList();
    };

    window.addTemplateDeck = async function() {
        const t = findAnyTemplateById(currentId);
        if (!t) return;
        const name = document.getElementById('tmpl-deck-name').value.trim();
        if (!name) { alert("Enter a deck or subsystem name."); return; }
        const maxHp = parseInt(document.getElementById('tmpl-deck-hp').value) || 50;
        // Bug fix (bug hunt, this session): clone before mutating, same as
        // addTemplateWeapon above.
        const decks = (t.ship_decks || []).slice();
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
        // Bug fix (bug hunt, this session): clone + error-check, same as
        // removeTemplateWeapon above.
        const decks = (t.ship_decks || []).slice();
        decks.splice(idx, 1);
        const { error } = await db.from('ship_templates').update({ ship_decks: decks }).eq('id', currentId);
        if (error) { alert("Failed to remove deck: " + error.message); return; }
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
    window.populateNewTemplateCopySourceOptions();
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
        const iffBadge = window.renderIffBadge(t.iff);
        const hardpointTag = t.is_station ? `${weaponCount} hardpoints (no cap)` : `${weaponCount}/${t.hardpoint_slots || 4} hardpoints`;
        html += `
            <div class="note-card" style="border-color:#ff3333;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#ff6b6b; font-size:12px;">${t.name}</strong>${stationBadge}${classBadge}${iffBadge}
                        <p style="margin:2px 0 0 0; font-size:10px; color:#d4c5a9;">${t.class || 'Frigate'} · Hull ${t.max_hull || 0} · Shields ${t.max_shields || 0} · ${hardpointTag}</p>
                    </div>
                    <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; max-width:110px;">
                        <button class="layer-edit" onclick="window.openSecretRepoEditor('${t.id}')" style="padding:3px 6px; font-size:9px; border-color:#ff6b6b; color:#ff6b6b;">OPEN ▸</button>
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
    // Copy-From-Existing build (QOL request, 2026-08-31): if the DM used the
    // Copy From Existing dropdown or the deployed-name-match prompt above,
    // window.applyStatSnapshotToNewTemplateForm stashed the parts that have
    // no field on this quick-create form (ship_weapons/ship_decks/
    // ship_hangar/cargo_inventory) here rather than on a visible input.
    // Cleared after use either way so a later un-copied save doesn't
    // silently reuse stale data.
    const extras = window._pendingNewTemplateExtras || {};
    window._pendingNewTemplateExtras = null;
    const payload = {
        owner_id: currentUserId,
        name,
        class: document.getElementById('new-secret-template-class').value.trim() || 'Frigate',
        drive_type: document.getElementById('new-secret-template-drive').value,
        max_shields: parseInt(document.getElementById('new-secret-template-shields').value) || 0,
        max_reactive: parseInt(document.getElementById('new-secret-template-reactive').value) || 0,
        max_ablative: parseInt(document.getElementById('new-secret-template-ablative').value) || 0,
        max_hardened: parseInt(document.getElementById('new-secret-template-hardened').value) || 0,
        max_hull: parseInt(document.getElementById('new-secret-template-hull').value) || 100,
        hardpoint_slots: parseInt(document.getElementById('new-secret-template-slots').value) || 4,
        tactical_speed: isStation ? 0 : (parseInt(document.getElementById('new-secret-template-speed').value) || 160),
        is_station: isStation,
        ship_weapons: extras.ship_weapons || [],
        ship_decks: extras.ship_decks || [],
        ship_hangar: extras.ship_hangar || [],
        cargo_inventory: extras.cargo_inventory || null,
        is_secret: true,
        vessel_class: document.getElementById('new-secret-template-vesselclass').value || null,
        // IFF build (this session): Secret Repository templates are almost
        // always enemies, so this defaults to 'hostile' in the form itself
        // (see index.html) rather than left unset -- unlike vessel_class,
        // which has no sensible default and stays optional/cosmetic. A DM
        // planting a friendly NPC (e.g. an allied escort) picks Friendly
        // here instead, which is what makes it visible in players' Vessel
        // Deck once deployed -- see window.canViewVesselDeck (js/combat.js).
        iff: document.getElementById('new-secret-template-iff').value || 'hostile'
    };
    const { error } = await db.from('ship_templates').insert(payload);
    if (error) { alert("Failed to store repository template: " + error.message); return; }

    document.getElementById('new-secret-template-name').value = '';
    document.getElementById('new-secret-template-class').value = '';
    document.getElementById('new-secret-template-reactive').value = '0';
    document.getElementById('new-secret-template-ablative').value = '0';
    document.getElementById('new-secret-template-hardened').value = '0';
    document.getElementById('new-secret-template-vesselclass').value = '';
    document.getElementById('new-secret-template-iff').value = 'hostile';
    document.getElementById('new-secret-template-copysource').value = '';
    window.clearNewTemplateCopyHint();
    if (stationCheckbox) { stationCheckbox.checked = false; window.toggleStationFields('new-secret-template'); }
    if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
};

/* --- Copy From Existing / Copy From Deployed (QOL request, 2026-08-31) ---
   Two related asks bundled together: (1) a manual dropdown to clone stats
   from any ship "already made" (both the public Ship Designer's templates
   and this repository's own), and (2) an auto-detect that offers to copy a
   currently-deployed ship's stats when the Name field matches one exactly
   -- e.g. a DM who always names generic reinforcements "Raider Frigate"
   and wants to duplicate the one already on the map instead of retyping it.
   DM-confirmed design: always copies the DESIGN BASELINE (max/undamaged
   values, full ammo, 0 cooldown, decks/hangar at max HP), never a deployed
   ship's current battle damage -- a template represents a fresh stat
   block, not a memorialized snapshot of whatever state it happened to be
   in when copied. Confirmed to overwrite every stat field on this form
   except the Name the DM already typed. ship_weapons/ship_decks/
   ship_hangar/cargo_inventory have no field on this quick-create form, so
   they're staged in window._pendingNewTemplateExtras and picked up by
   saveNewSecretTemplate above instead. */
window.populateNewTemplateCopySourceOptions = function() {
    const sel = document.getElementById('new-secret-template-copysource');
    if (!sel) return;
    const secretOpts = (window.secretShipTemplatesList || []).map(t => `<option value="secret:${t.id}">${t.name}</option>`).join('');
    const publicOpts = (shipTemplatesList || []).map(t => `<option value="public:${t.id}">${t.name}</option>`).join('');
    sel.innerHTML = '<option value="">-- Don\'t copy, start blank --</option>'
        + (secretOpts ? `<optgroup label="Secret Repository">${secretOpts}</optgroup>` : '')
        + (publicOpts ? `<optgroup label="Public Ship Designer">${publicOpts}</optgroup>` : '');
};

function buildTemplateCopySnapshot(source, isLiveDeployed) {
    // max_shields/max_reactive/max_ablative/max_hardened/max_hull are
    // already the undamaged design ceiling on BOTH ship_templates and
    // ship_markers (integrity_* holds current/damaged values separately)
    // -- reading only the max_* columns here is what makes this "always
    // baseline, never current damage" by construction, no extra reset math
    // needed for the health layers themselves.
    const weapons = JSON.parse(JSON.stringify(source.ship_weapons || [])).map(w => ({
        ...w,
        ammo: (w.max_ammo !== undefined && w.max_ammo !== null) ? w.max_ammo : w.ammo,
        cooldown: 0, overheat: 0, standby_ammo: 0
    }));
    const decks = JSON.parse(JSON.stringify(source.ship_decks || [])).map(d => ({
        id: d.id || window.genDeckId(), name: d.name, hp: d.max_hp, max_hp: d.max_hp
    }));
    const hangar = JSON.parse(JSON.stringify(source.ship_hangar || [])).map(sq => ({
        ...sq, id: 'sq_' + Math.random().toString(36).substr(2, 9), hp: sq.max_hp
    }));
    const cargo = source.cargo_inventory ? JSON.parse(JSON.stringify(source.cargo_inventory)) : null;
    return {
        class: isLiveDeployed ? '' : (source.class || ''),
        drive_type: source.drive_type || 'ftl_class1',
        max_shields: source.max_shields || 0,
        max_reactive: source.max_reactive || 0,
        max_ablative: source.max_ablative || 0,
        max_hardened: source.max_hardened || 0,
        max_hull: source.max_hull || 100,
        hardpoint_slots: isLiveDeployed ? Math.max(4, weapons.length) : (source.hardpoint_slots || 4),
        tactical_speed: source.tactical_speed || 160,
        is_station: !!source.is_station,
        vessel_class: source.vessel_class || '',
        iff: source.iff || 'hostile',
        ship_weapons: weapons,
        ship_decks: decks,
        ship_hangar: hangar,
        cargo_inventory: cargo
    };
}

function applyStatSnapshotToNewTemplateForm(snapshot, sourceLabel) {
    document.getElementById('new-secret-template-class').value = snapshot.class;
    document.getElementById('new-secret-template-drive').value = snapshot.drive_type;
    document.getElementById('new-secret-template-shields').value = snapshot.max_shields;
    document.getElementById('new-secret-template-reactive').value = snapshot.max_reactive;
    document.getElementById('new-secret-template-ablative').value = snapshot.max_ablative;
    document.getElementById('new-secret-template-hardened').value = snapshot.max_hardened;
    document.getElementById('new-secret-template-hull').value = snapshot.max_hull;
    document.getElementById('new-secret-template-slots').value = snapshot.hardpoint_slots;
    document.getElementById('new-secret-template-speed').value = snapshot.tactical_speed;
    document.getElementById('new-secret-template-vesselclass').value = snapshot.vessel_class;
    document.getElementById('new-secret-template-iff').value = snapshot.iff;
    const stationCheckbox = document.getElementById('new-secret-template-station');
    if (stationCheckbox) { stationCheckbox.checked = snapshot.is_station; window.toggleStationFields('new-secret-template'); }

    window._pendingNewTemplateExtras = {
        ship_weapons: snapshot.ship_weapons, ship_decks: snapshot.ship_decks,
        ship_hangar: snapshot.ship_hangar, cargo_inventory: snapshot.cargo_inventory
    };

    const note = document.getElementById('new-secret-template-copynote');
    if (note) {
        note.style.display = 'block';
        note.innerText = `Copied from ${sourceLabel}: ${snapshot.ship_weapons.length} weapon(s), ${snapshot.ship_decks.length} deck(s), ${snapshot.ship_hangar.length} squadron(s), cargo${snapshot.cargo_inventory ? '' : ' (none)'} -- will be included when you STORE IN REPOSITORY.`;
    }
}

window.applyTemplateCopyToNewForm = function() {
    const sel = document.getElementById('new-secret-template-copysource');
    if (!sel || !sel.value) return;
    const [scope, id] = sel.value.split(':');
    const list = scope === 'public' ? (shipTemplatesList || []) : (window.secretShipTemplatesList || []);
    const source = list.find(t => t.id === id);
    if (!source) { alert("Couldn't find that template -- try re-opening the Secret Repository tab."); return; }
    applyStatSnapshotToNewTemplateForm(buildTemplateCopySnapshot(source, false), source.name);
};

window.checkDeployedNameMatch = function() {
    const nameInput = document.getElementById('new-secret-template-name');
    const hint = document.getElementById('new-secret-template-namehint');
    if (!nameInput || !hint) return;
    const name = nameInput.value.trim().toLowerCase();
    if (!name || typeof globalShipMarkersCache === 'undefined') { hint.style.display = 'none'; return; }
    const match = globalShipMarkersCache.find(m => (m.name || '').trim().toLowerCase() === name && !m.is_strike_craft);
    if (!match) { hint.style.display = 'none'; return; }
    hint.style.display = 'block';
    hint.innerHTML = `Found a deployed ship named "${match.name}" — <button class="layer-edit" onclick="window.applyDeployedShipCopyToNewForm('${match.id}')" style="padding:2px 6px; font-size:9px; border-color:#ffaa00; color:#ffaa00;">COPY ITS STATS</button>`;
};

window.clearNewTemplateCopyHint = function() {
    const hint = document.getElementById('new-secret-template-namehint');
    if (hint) hint.style.display = 'none';
    const note = document.getElementById('new-secret-template-copynote');
    if (note) note.style.display = 'none';
    window._pendingNewTemplateExtras = null;
};

window.applyDeployedShipCopyToNewForm = function(markerId) {
    if (typeof globalShipMarkersCache === 'undefined') return;
    const source = globalShipMarkersCache.find(m => m.id === markerId);
    if (!source) { alert("That deployed ship is no longer available -- it may have been destroyed or moved since."); return; }
    applyStatSnapshotToNewTemplateForm(buildTemplateCopySnapshot(source, true), `deployed "${source.name}"`);
    document.getElementById('new-secret-template-namehint').style.display = 'none';
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

/* --- SECRET REPOSITORY FULL-SCREEN EDITOR (DM note #7 build, this session) ---
   Replaces the old two-popup edit flow (openEditTemplateModal +
   openTemplateLoadoutModal) for Secret Repository templates ONLY -- the
   public Ship Designer's own templates keep using those two modals
   unchanged, per the DM's explicit scope choice (this is DM-side only).
   Lives in its own Command Terminal tab (term-panel-secretrepo, index.html)
   so it gets the same full-screen real estate as the Vessel Deck, which is
   literally what was asked for ("same full screen function as the vessel
   deck"). Visually modeled on the Vessel Deck's layout, but does NOT call
   its actual rendering functions (renderShipStanceHtml/HealthBars/Weapons)
   -- those are wired to live combat state (FIRE/LAUNCH buttons, target
   dropdowns, delta-based health mutation via window.modifyShipHealth) that
   doesn't exist for a design-time template with no "current" damage and no
   combat stance (DM-confirmed: stance dropped entirely, health shown as
   plain editable max-value numbers, not bars that would always read 100%).

   Real bug found and fixed as part of this build: the OLD template weapon
   form (still used by the public Ship Designer, untouched) only captured
   name/dice/mod/guns/damage_type/deck/explodes -- missing loc, range,
   cooldown_period, weapon_class, is_point_defense, ammo/max_ammo, the
   tiered-ammo standby fields, reload_cooldown_period, and ordnance_pattern
   entirely. Every one of those matters in actual combat (Battle Map
   targeting range, Point Defense eligibility, cooldowns, ammo limits...),
   so a DM designing a serious NPC in the repository had no way to set them
   and had to deploy-then-edit-live just to reach the full weapon editor --
   almost certainly why "spawn and then edit" was the DM's actual workflow
   despite the repository already existing. This editor's weapon add/edit
   forms now match window.addShipWeapon/openEditWeaponModal (js/combat.js)
   field-for-field, so a template built here needs no further live editing
   for anything the weapon system itself tracks. */
let editingRepoTemplateId = null;

window.openSecretRepoEditor = function(id) {
    const t = findAnyTemplateById(id);
    if (!t) return;
    editingRepoTemplateId = id;
    document.getElementById('secretrepo-list-view').style.display = 'none';
    document.getElementById('secretrepo-editor-view').style.display = 'block';
    window.renderSecretRepoEditorPanel();
};

window.closeSecretRepoEditor = function() {
    editingRepoTemplateId = null;
    const listView = document.getElementById('secretrepo-list-view');
    const editorView = document.getElementById('secretrepo-editor-view');
    if (listView) listView.style.display = 'block';
    if (editorView) editorView.style.display = 'none';
};

window.deleteSecretRepoTemplateAndClose = async function() {
    if (!editingRepoTemplateId) return;
    // Bug caught before shipping (this session): deleteShipTemplate shows its
    // own confirm modal and can be cancelled -- only close the editor if the
    // delete actually went through, or cancelling would still kick the DM
    // back to the list as if it had succeeded.
    const deleted = await window.deleteShipTemplate(editingRepoTemplateId);
    if (deleted) window.closeSecretRepoEditor();
};

function renderSecretRepoWeaponCard(w, idx) {
    const dt = window.normalizeDamageType(w.damage_type || 'Impact');
    const info = window.DAMAGE_TYPES[dt];
    const wClass = w.weapon_class === 'ordnance' ? 'ordnance' : 'direct_fire';
    const classBadge = wClass === 'ordnance' ? '<span style="font-size:8px; color:#c778dd; border:1px solid #c778dd; border-radius:2px; padding:1px 4px; margin-left:4px;">☠ ORDNANCE</span>' : '';
    const pdBadge = w.is_point_defense ? '<span style="font-size:8px; color:#66d9ff; border:1px solid #66d9ff; border-radius:2px; padding:1px 4px; margin-left:4px;">🛡 PD</span>' : '';
    const rangeBadge = w.range ? `<span style="font-size:8px; color:#6b826a; border:1px solid #3c4e36; border-radius:2px; padding:1px 4px; margin-left:4px;">📏 ${w.range}</span>` : '';
    const cooldownBadge = w.cooldown_period ? `<span style="font-size:8px; color:#ff9d4d; border:1px solid #ff9d4d; border-radius:2px; padding:1px 4px; margin-left:4px;">⏱ ${w.cooldown_period}</span>` : '';
    const singleBadge = (wClass === 'ordnance' && w.ordnance_pattern === 'single') ? '<span style="font-size:8px; color:#ff3333; border:1px solid #ff3333; border-radius:2px; padding:1px 4px; margin-left:4px;">⊕ SINGLE</span>' : '';
    const t = findAnyTemplateById(editingRepoTemplateId);
    const assignedDeck = (w.assigned_deck_id && t) ? (t.ship_decks || []).find(d => d.id === w.assigned_deck_id) : null;
    const deckBadge = assignedDeck ? `<span style="font-size:8px; color:#6b826a; border:1px solid #3c4e36; border-radius:2px; padding:1px 4px; margin-left:4px;">🔧 ${assignedDeck.name}</span>` : '';
    const ammoLabel = w.ammo < 0 ? 'INF' : `${w.ammo}/${w.max_ammo}`;
    const standbyLabel = w.max_standby_ammo > 0 ? ` · Standby ${w.standby_ammo || 0}/${w.max_standby_ammo} (${w.ammo_type || 'Kinetic Rounds'})` : '';
    return `<div class="note-card" style="padding:8px; margin-bottom:6px; background:#030403; border-color:#ff3333;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
                <strong style="color:#ff6b6b; font-size:12px;">[${w.loc || 'Unmounted'}] ${w.name}</strong>${classBadge}${pdBadge}${rangeBadge}${cooldownBadge}${singleBadge}${deckBadge}
                <div style="font-size:10px; color:#d4c5a9;">${w.dice} ${w.modifier} ${w.explodes ? '💥' : ''} · ${w.gun_count || 1}x Guns · <span style="color:${info.color};">${dt}</span> · Ammo: ${ammoLabel}${standbyLabel}</div>
            </div>
            <div style="display:flex; gap:6px;">
                <button class="layer-edit" onclick="window.openSecretRepoWeaponEditModal(${idx})" style="padding:4px 8px; font-size:10px;" title="Edit weapon">✎</button>
                <button class="layer-del" onclick="window.removeSecretRepoWeapon(${idx})" style="padding:4px 8px; font-size:10px;">✕</button>
            </div>
        </div>
    </div>`;
}

window.renderSecretRepoEditorPanel = function() {
    const container = document.getElementById('secretrepo-editor-container');
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!container || !t) return;

    t.ship_weapons = t.ship_weapons || [];
    t.ship_decks = t.ship_decks || [];
    t.ship_hangar = t.ship_hangar || [];
    // Cargo/Hangar build: unlike ship_weapons/ship_decks, cargo_inventory has
    // no natural "empty" state -- window.sanitizeCargo (js/combat.js) treats
    // null/{} as "never configured" and fills in the same generic starter
    // loadout every freshly-deployed ship gets today (rations, ammo, marines,
    // etc.), same convention as the live Cargo Deck. This is DISPLAY ONLY --
    // it doesn't persist until the DM actually edits something below.
    t.cargo_inventory = window.sanitizeCargo(t.cargo_inventory || {});
    if (window.ensureDeckIds(t.ship_decks)) {
        db.from('ship_templates').update({ ship_decks: t.ship_decks }).eq('id', t.id);
    }

    const stationBadge = t.is_station ? '<span style="font-size:8px; color:#c9962f; border:1px solid #c9962f; border-radius:2px; padding:1px 4px; margin-left:6px;">🛰 STATION</span>' : '';
    const classBadge = t.vessel_class ? `<span style="font-size:8px; color:#c9962f; border:1px solid #c9962f; border-radius:2px; padding:1px 4px; margin-left:6px;">${t.vessel_class === 'Capital' ? '⬢ CAPITAL' : '◆ ESCORT'}</span>` : '';
    const iffBadge = window.renderIffBadge(t.iff);
    const weaponCount = t.ship_weapons.length;
    const hardpointTag = t.is_station ? `${weaponCount} hardpoints (no cap — station)` : `${weaponCount} / ${t.hardpoint_slots || 4} hardpoints used`;

    let weaponsHtml = t.ship_weapons.length === 0
        ? '<span style="font-size:10px; color:#6b826a;">No weapon hardpoints installed.</span>'
        : t.ship_weapons.map((w, idx) => renderSecretRepoWeaponCard(w, idx)).join('');

    let decksHtml = t.ship_decks.length === 0
        ? '<span style="font-size:10px; color:#6b826a;">No internal decks configured.</span>'
        : t.ship_decks.map((d, idx) => `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:4px;">
            <span style="font-size:10px; color:#d4c5a9;">${d.name} — ${d.hp}/${d.max_hp} HP</span>
            <button class="layer-del" onclick="window.removeSecretRepoDeck(${idx})" style="padding:2px 6px; font-size:9px;">✕</button>
        </div>`).join('');

    const deckOptions = '<option value="">-- Not deck-gated --</option>' + t.ship_decks.map(d => `<option value="${d.id}">${d.name}</option>`).join('');

    let hangarHtml = t.ship_hangar.length === 0
        ? '<span style="font-size:10px; color:#6b826a;">No strike craft squadrons commissioned.</span>'
        : t.ship_hangar.map((sq, idx) => {
            const dbStats = (typeof STRIKE_CRAFT_DB !== 'undefined') ? STRIKE_CRAFT_DB[sq.type] : null;
            const chassisLabel = dbStats ? dbStats.label : (sq.type || 'Unknown Chassis');
            return `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:6px; border:1px solid #c778dd; border-radius:2px; margin-bottom:4px;">
                <span style="font-size:10px; color:#d4c5a9;"><strong style="color:#c778dd;">${sq.name}</strong> — ${chassisLabel} x${sq.count} (${sq.hp}/${sq.max_hp} HP)</span>
                <button class="layer-del" onclick="window.removeSecretRepoSquadron(${idx})" style="padding:2px 6px; font-size:9px;">✕</button>
            </div>`;
        }).join('');

    const strikeCraftTypeOptions = buildStrikeCraftTypeOptionsHtml();

    const cargoCategoryLabels = { perishables: 'Perishables', expendables: 'Expendables', misc: 'Misc' };
    let cargoHtml = ['perishables', 'expendables', 'misc'].map(cat => {
        const items = t.cargo_inventory[cat] || [];
        const itemsHtml = items.length === 0
            ? '<span style="font-size:9px; color:#6b826a;">Empty.</span>'
            : items.map((item, idx) => `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:4px 6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:3px;">
                <span style="font-size:10px; color:#d4c5a9;">${item.name} — ${item.qty} ${item.unit || 'Units'}</span>
                <button class="layer-del" onclick="window.removeSecretRepoCargoItem('${cat}', ${idx})" style="padding:2px 6px; font-size:9px;">✕</button>
            </div>`).join('');
        return `<div style="margin-bottom:8px;"><div style="font-size:9px; color:#00e5a3; margin-bottom:3px;">${cargoCategoryLabels[cat]}</div>${itemsHtml}</div>`;
    }).join('');

    container.innerHTML = `
        <div class="sheet-section" style="border-color:#ff3333;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
                <h3 style="color:#ff6b6b; margin:0;">${t.name}${stationBadge}${classBadge}${iffBadge}</h3>
                <button class="layer-del" onclick="window.deleteSecretRepoTemplateAndClose()" style="padding:4px 10px; font-size:9px;">🗑 DELETE TEMPLATE</button>
            </div>
            <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; margin-top:12px;">
                <div><label for="repo-edit-name" style="font-size:9px; color:#ffaaaa;">Vessel Designation:</label><input type="text" id="repo-edit-name" value="${t.name || ''}" style="border-color:#ff3333;"></div>
                <div><label for="repo-edit-class" style="font-size:9px; color:#ffaaaa;">Class:</label><input type="text" id="repo-edit-class" value="${t.class || ''}" style="border-color:#ff3333;"></div>
                <div><label for="repo-edit-drive" style="font-size:9px; color:#ffaaaa;">Drive Type:</label><select id="repo-edit-drive" style="border-color:#ff3333;">
                    <option value="ftl_class1" ${t.drive_type === 'ftl_class1' ? 'selected' : ''}>Class 1 Warp Drive</option>
                    <option value="ftl_class2" ${t.drive_type === 'ftl_class2' ? 'selected' : ''}>Class 2 Hyperdrive</option>
                    <option value="ftl_fold" ${t.drive_type === 'ftl_fold' ? 'selected' : ''}>Experimental Fold Drive</option>
                    <option value="sublight" ${t.drive_type === 'sublight' ? 'selected' : ''}>Sublight Thrusters</option>
                </select></div>
                <div><label for="repo-edit-vesselclass" style="font-size:9px; color:#c9962f;">Vessel Classification:</label><select id="repo-edit-vesselclass" style="border-color:#ff3333;">
                    <option value="" ${!t.vessel_class ? 'selected' : ''}>-- Unclassified --</option>
                    <option value="Capital" ${t.vessel_class === 'Capital' ? 'selected' : ''}>Capital Ship</option>
                    <option value="Escort" ${t.vessel_class === 'Escort' ? 'selected' : ''}>Escort</option>
                </select></div>
                <div><label for="repo-edit-iff" style="font-size:9px; color:#ff6b6b;">IFF Designation:</label><select id="repo-edit-iff" style="border-color:#ff3333;">
                    <option value="" ${!t.iff ? 'selected' : ''}>-- Unset (DM-only) --</option>
                    <option value="hostile" ${t.iff === 'hostile' ? 'selected' : ''}>⚠ Hostile</option>
                    <option value="neutral" ${t.iff === 'neutral' ? 'selected' : ''}>◌ Neutral</option>
                    <option value="friendly" ${t.iff === 'friendly' ? 'selected' : ''}>✓ Friendly</option>
                </select></div>
                <div style="display:flex; gap:10px; align-items:flex-end;">
                    <div style="flex:1;"><label for="repo-edit-speed" style="font-size:9px; color:#ffaaaa;">Tactical Speed:</label><input type="number" id="repo-edit-speed" value="${t.tactical_speed || 160}" min="0" style="border-color:#ff3333; text-align:center;"></div>
                    <div style="flex:1;"><label for="repo-edit-slots" style="font-size:9px; color:#ffaaaa;">Hardpoint Slots:</label><input type="number" id="repo-edit-slots" value="${t.hardpoint_slots || 4}" min="0" style="border-color:#ff3333; text-align:center;"></div>
                </div>
            </div>
            <label for="repo-edit-station" style="font-size:10px; color:#c9962f; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:10px;" title="Locks Tactical Speed to 0 and removes the Hardpoint Slots cap.">
                <input type="checkbox" id="repo-edit-station" ${t.is_station ? 'checked' : ''} onchange="window.toggleStationFields('repo-edit')" style="margin:0;"> 🛰 This is a Station
            </label>

            <h4 style="margin:16px 0 6px 0; border-bottom:1px solid #3c4e36; padding-bottom:4px; color:#ff6b6b;">Base Stats (design max values)</h4>
            <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:8px;">
                <div><label for="repo-edit-shields" style="font-size:9px; color:#00e1ff;">Shields:</label><input type="number" id="repo-edit-shields" value="${t.max_shields || 0}" min="0" style="border-color:#00e1ff; text-align:center;"></div>
                <div><label for="repo-edit-reactive" style="font-size:9px; color:#ffaa00;">Reactive:</label><input type="number" id="repo-edit-reactive" value="${t.max_reactive || 0}" min="0" style="border-color:#ffaa00; text-align:center;"></div>
                <div><label for="repo-edit-ablative" style="font-size:9px; color:#ffaa00;">Ablative:</label><input type="number" id="repo-edit-ablative" value="${t.max_ablative || 0}" min="0" style="border-color:#ffaa00; text-align:center;"></div>
                <div><label for="repo-edit-hardened" style="font-size:9px; color:#c9962f;">Hardened:</label><input type="number" id="repo-edit-hardened" value="${t.max_hardened || 0}" min="0" style="border-color:#c9962f; text-align:center;"></div>
                <div><label for="repo-edit-hull" style="font-size:9px; color:#ff3333;">Hull:</label><input type="number" id="repo-edit-hull" value="${t.max_hull || 0}" min="0" style="border-color:#ff3333; text-align:center;"></div>
            </div>
            <button class="btn-reveal" onclick="window.saveSecretRepoIdentityStats()" style="margin-top:10px; border-color:#ff6b6b; color:#ff6b6b;">SAVE CHANGES</button>
        </div>

        <div class="sheet-section" style="margin-top:16px; border-color:#ff3333;">
            <h4 style="margin:0 0 6px 0; border-bottom:1px solid #3c4e36; padding-bottom:4px; color:#ff6b6b;">Weapons <span style="font-size:9px; color:#6b826a; font-weight:normal;">${hardpointTag}</span></h4>
            <div id="secretrepo-weapons-list" style="margin-bottom:10px;">${weaponsHtml}</div>
            <div style="background:#030403; padding:8px; border:1px solid #ff3333; border-radius:2px;">
                <label for="repo-wpn-name" style="font-size:9px; color:#ffaaaa;">Add Weapon</label>
                <div style="display:flex; gap:6px;">
                    <input type="text" id="repo-wpn-loc" placeholder="Mount Loc" style="flex:1; border-color:#ff3333;">
                    <input type="text" id="repo-wpn-name" placeholder="Weapon Name" style="flex:2; border-color:#ff3333;">
                </div>
                <div style="display:flex; gap:6px; margin-top:4px;">
                    <input type="text" id="repo-wpn-dice" placeholder="1d10" style="flex:1; border-color:#ff3333; text-align:center;">
                    <input type="text" id="repo-wpn-mod" placeholder="+0" style="flex:1; border-color:#ff3333; text-align:center;">
                    <input type="number" id="repo-wpn-guns" placeholder="Guns" min="1" value="1" style="flex:1; border-color:#ff3333; text-align:center;">
                </div>
                <select id="repo-wpn-dmgtype" style="margin-top:4px;">${window.buildDamageTypeOptionsHtml('Impact')}</select>
                <div style="display:flex; gap:6px; margin-top:4px;">
                    <select id="repo-wpn-class" style="flex:1;">
                        <option value="direct_fire">Direct Fire</option>
                        <option value="ordnance">Ordnance</option>
                    </select>
                    <select id="repo-wpn-deck" style="flex:1;">${deckOptions}</select>
                </div>
                <div style="display:flex; gap:6px; margin-top:4px;">
                    <div style="flex:1;"><label for="repo-wpn-range" style="font-size:8px; color:#6b826a;" title="Battle Map targeting range, grid px. Reference tiers: LONG=400 (33% of the grid diagonal) &middot; MEDIUM=200 (16.5%) &middot; SHORT=100 (8.25%). Ordnance/missile weapons conventionally use 0 = unlimited launch distance (they travel over multiple turns via the ordnance mechanic instead of hitting instantly) -- 0 is also the default for any weapon left unset.">Range</label><input type="number" id="repo-wpn-range" min="0" placeholder="0=unlimited" title="Battle Map targeting range, grid px. Reference tiers: LONG=400 (33% of the grid diagonal) &middot; MEDIUM=200 (16.5%) &middot; SHORT=100 (8.25%). Ordnance/missile weapons conventionally use 0 = unlimited launch distance (they travel over multiple turns via the ordnance mechanic instead of hitting instantly) -- 0 is also the default for any weapon left unset." style="text-align:center;"></div>
                    <div style="flex:1;"><label for="repo-wpn-cooldown" style="font-size:8px; color:#6b826a;" title="Turns to recharge after firing, 0 = none">Cooldown</label><input type="number" id="repo-wpn-cooldown" min="0" placeholder="0" style="text-align:center;"></div>
                </div>
                <div style="display:flex; gap:6px; margin-top:4px;">
                    <div style="flex:1;"><label for="repo-wpn-ammo" style="font-size:8px; color:#6b826a;" title="Ready ammo capacity, blank = infinite">Ready Ammo</label><input type="number" id="repo-wpn-ammo" min="0" placeholder="blank=INF" style="text-align:center;"></div>
                    <label for="repo-wpn-pd" style="flex:1; font-size:10px; color:#66d9ff; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:12px;"><input type="checkbox" id="repo-wpn-pd" style="margin:0;"> Point Defense</label>
                </div>
                <details style="margin-top:6px;">
                    <summary style="font-size:9px; color:#ff9d4d; cursor:pointer;">Tiered Ammo / Ordnance (optional)</summary>
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <div style="flex:1;"><label for="repo-wpn-standbymax" style="font-size:8px; color:#ff9d4d;" title="0 = not used, hides RESUPPLY/RELOAD once deployed">Standby Max</label><input type="number" id="repo-wpn-standbymax" min="0" placeholder="0" style="text-align:center;"></div>
                        <div style="flex:1;"><label for="repo-wpn-ammotype" style="font-size:8px; color:#ff9d4d;">Ammo Type</label><input type="text" id="repo-wpn-ammotype" placeholder="Kinetic Rounds"></div>
                        <div style="flex:1;"><label for="repo-wpn-reloadcd" style="font-size:8px; color:#ff9d4d;" title="RELOAD sets Cooldown to this many rounds">Reload CD</label><input type="number" id="repo-wpn-reloadcd" min="0" placeholder="1" style="text-align:center;"></div>
                    </div>
                    <select id="repo-wpn-ordpattern" style="margin-top:4px;">
                        <option value="multi">Multi-Hit (6 payloads, default)</option>
                        <option value="single">Single Warhead</option>
                    </select>
                </details>
                <label for="repo-wpn-explodes" style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:6px;">
                    <input type="checkbox" id="repo-wpn-explodes" checked style="margin:0;"> Exploding Dice
                </label>
                <button class="btn-remove" onclick="window.addSecretRepoWeapon()" style="width:100%; margin-top:6px; font-size:10px;">+ ADD HARDPOINT</button>
            </div>
        </div>

        <div class="sheet-section" style="margin-top:16px; border-color:#00e1ff;">
            <h4 style="margin:0 0 6px 0; border-bottom:1px solid #3c4e36; padding-bottom:4px; color:#00e1ff;">Internal Decks</h4>
            <div id="secretrepo-decks-list" style="margin-bottom:10px;">${decksHtml}</div>
            <div style="background:#030403; padding:8px; border:1px solid #00e1ff; border-radius:2px;">
                <label for="repo-deck-name" style="font-size:9px; color:#6b826a;">Add Deck / Subsystem</label>
                <div style="display:flex; gap:6px;">
                    <input type="text" id="repo-deck-name" placeholder="e.g. Engineering, Bridge..." style="flex:2; border-color:#00e1ff;">
                    <input type="number" id="repo-deck-hp" placeholder="Max HP" value="50" style="flex:1; border-color:#00e1ff; text-align:center;">
                </div>
                <button class="btn-reveal" onclick="window.addSecretRepoDeck()" style="width:100%; margin-top:6px; font-size:10px; border-color:#00e1ff; color:#00e1ff;">+ ADD DECK</button>
            </div>
        </div>

        <div class="sheet-section" style="margin-top:16px; border-color:#c778dd;">
            <h4 style="margin:0 0 6px 0; border-bottom:1px solid #3c4e36; padding-bottom:4px; color:#c778dd;">Hangar / Strike Craft</h4>
            <div id="secretrepo-hangar-list" style="margin-bottom:10px;">${hangarHtml}</div>
            <div style="background:#030403; padding:8px; border:1px solid #c778dd; border-radius:2px;">
                <label for="repo-sq-name" style="font-size:9px; color:#6b826a;">Commission Squadron</label>
                <div style="display:flex; gap:6px;">
                    <input type="text" id="repo-sq-name" placeholder="Callsign" style="flex:2; border-color:#c778dd;">
                    <select id="repo-sq-type" style="flex:2; border-color:#c778dd;">${strikeCraftTypeOptions}</select>
                    <input type="number" id="repo-sq-count" placeholder="Count" min="1" value="4" style="flex:1; border-color:#c778dd; text-align:center;">
                </div>
                <button class="btn-reveal" onclick="window.addSecretRepoSquadron()" style="width:100%; margin-top:6px; font-size:10px; border-color:#c778dd; color:#c778dd;">+ ADD SQUADRON</button>
            </div>
        </div>

        <div class="sheet-section" style="margin-top:16px; border-color:#00e5a3;">
            <h4 style="margin:0 0 6px 0; border-bottom:1px solid #3c4e36; padding-bottom:4px; color:#00e5a3;">Cargo Hold</h4>
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:8px;">
                <label for="repo-cargo-synth" style="font-size:9px; color:#00e5a3;">Synth Capacity:</label>
                <input type="number" id="repo-cargo-synth" value="${t.cargo_inventory.synth_capacity}" min="0" style="width:60px; border-color:#00e5a3; text-align:center;" onchange="window.updateSecretRepoSynthCapacity(this.value)">
            </div>
            <div id="secretrepo-cargo-list" style="margin-bottom:10px;">${cargoHtml}</div>
            <div style="background:#030403; padding:8px; border:1px solid #00e5a3; border-radius:2px;">
                <label for="repo-cargo-name" style="font-size:9px; color:#6b826a;">Add Cargo Item</label>
                <div style="display:flex; gap:6px;">
                    <input type="text" id="repo-cargo-name" placeholder="Item Name" style="flex:2; border-color:#00e5a3;">
                    <input type="number" id="repo-cargo-qty" placeholder="Qty" min="0" value="1" style="flex:1; border-color:#00e5a3; text-align:center;">
                    <input type="text" id="repo-cargo-unit" placeholder="Unit" style="flex:1; border-color:#00e5a3;">
                </div>
                <select id="repo-cargo-category" style="margin-top:4px; border-color:#00e5a3;">
                    <option value="expendables">Expendables</option>
                    <option value="perishables">Perishables</option>
                    <option value="misc">Misc</option>
                </select>
                <button class="btn-reveal" onclick="window.addSecretRepoCargoItem()" style="width:100%; margin-top:6px; font-size:10px; border-color:#00e5a3; color:#00e5a3;">+ ADD ITEM</button>
            </div>
        </div>

        <div class="sheet-section" style="margin-top:16px;">
            <h4 style="margin:0 0 10px 0; border-bottom:1px solid #3c4e36; padding-bottom:4px; color:#d4c5a9;">Deploy</h4>
            <div style="display:flex; gap:6px; align-items:center;">
                <button class="btn-deploy" onclick="window.deployShipTemplate('${t.id}')" style="flex:2; margin:0;">🚀 DEPLOY TO MAP</button>
                <label for="repo-init-${t.id}" style="display:none;">Initiative</label>
                <input type="number" id="repo-init-${t.id}" value="10" style="flex:1; margin:0; text-align:center;">
                <button class="btn-remove" onclick="window.deployTemplateToInitiative('${t.id}')" style="flex:2; margin:0;">⚔ TO TRACKER</button>
            </div>
        </div>
    `;
    window.toggleStationFields('repo-edit');
};

window.saveSecretRepoIdentityStats = async function() {
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!t) return;
    const isStation = document.getElementById('repo-edit-station').checked;
    const payload = {
        name: document.getElementById('repo-edit-name').value.trim() || t.name,
        class: document.getElementById('repo-edit-class').value.trim() || 'Frigate',
        drive_type: document.getElementById('repo-edit-drive').value,
        max_shields: parseInt(document.getElementById('repo-edit-shields').value) || 0,
        max_reactive: parseInt(document.getElementById('repo-edit-reactive').value) || 0,
        max_ablative: parseInt(document.getElementById('repo-edit-ablative').value) || 0,
        max_hardened: parseInt(document.getElementById('repo-edit-hardened').value) || 0,
        max_hull: parseInt(document.getElementById('repo-edit-hull').value) || 0,
        hardpoint_slots: parseInt(document.getElementById('repo-edit-slots').value) || 4,
        tactical_speed: isStation ? 0 : (parseInt(document.getElementById('repo-edit-speed').value) || 160),
        is_station: isStation,
        vessel_class: document.getElementById('repo-edit-vesselclass').value || null,
        iff: document.getElementById('repo-edit-iff').value || null
    };
    const { error } = await db.from('ship_templates').update(payload).eq('id', editingRepoTemplateId);
    if (error) { alert("Failed to save template: " + error.message); return; }
    Object.assign(t, payload);
    window.renderSecretRepoEditorPanel();
    if (typeof window.renderSecretRepositoryPanel === 'function') window.renderSecretRepositoryPanel();
    if (window.AudioEngine) window.AudioEngine.playPing();
};

window.addSecretRepoWeapon = async function() {
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!t) return;
    const slots = t.hardpoint_slots || 4;
    const weapons = (t.ship_weapons || []).slice();
    if (!t.is_station && weapons.length >= slots) { alert(`This hull only has ${slots} hardpoint slots — expand Hardpoint Slots above first.`); return; }

    const name = document.getElementById('repo-wpn-name').value.trim();
    if (!name) { alert("Enter a weapon name."); return; }
    const loc = document.getElementById('repo-wpn-loc').value.trim() || 'Hardpoint';
    let dice = document.getElementById('repo-wpn-dice').value.trim().toLowerCase() || '1d10';
    let mod = document.getElementById('repo-wpn-mod').value.trim() || '+0';
    if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
    const gunCount = parseInt(document.getElementById('repo-wpn-guns').value) || 1;
    const damageType = document.getElementById('repo-wpn-dmgtype').value;
    const explodes = document.getElementById('repo-wpn-explodes').checked;
    const weaponClass = document.getElementById('repo-wpn-class').value === 'ordnance' ? 'ordnance' : 'direct_fire';
    const isPointDefense = document.getElementById('repo-wpn-pd').checked;
    const weaponRange = Math.max(0, parseInt(document.getElementById('repo-wpn-range').value) || 0);
    const cooldownPeriod = Math.max(0, parseInt(document.getElementById('repo-wpn-cooldown').value) || 0);
    const deckSelect = document.getElementById('repo-wpn-deck');
    const assignedDeckId = (deckSelect && deckSelect.value) ? deckSelect.value : null;
    const ammoStr = document.getElementById('repo-wpn-ammo').value.trim();
    const ammoVal = ammoStr === '' ? -1 : Math.max(0, parseInt(ammoStr) || 0);
    const standbyMax = Math.max(0, parseInt(document.getElementById('repo-wpn-standbymax').value) || 0);
    const ammoType = document.getElementById('repo-wpn-ammotype').value.trim() || 'Kinetic Rounds';
    const reloadCdInput = document.getElementById('repo-wpn-reloadcd').value.trim();
    const reloadCooldownPeriod = reloadCdInput !== '' ? Math.max(0, parseInt(reloadCdInput) || 0) : 1;
    const ordnancePattern = document.getElementById('repo-wpn-ordpattern').value === 'single' ? 'single' : 'multi';

    weapons.push({
        loc, name, dice, modifier: mod, explodes,
        ammo: ammoVal, max_ammo: ammoVal, cooldown: 0, overheat: 0, cooldown_period: cooldownPeriod,
        gun_count: gunCount, damage_type: damageType,
        weapon_class: weaponClass, is_point_defense: isPointDefense, range: weaponRange,
        assigned_deck_id: assignedDeckId,
        standby_ammo: 0, max_standby_ammo: standbyMax, ammo_type: ammoType,
        reload_cooldown_period: reloadCooldownPeriod, ordnance_pattern: ordnancePattern
    });

    const { error } = await db.from('ship_templates').update({ ship_weapons: weapons }).eq('id', editingRepoTemplateId);
    if (error) { alert("Failed to add weapon: " + error.message); return; }
    t.ship_weapons = weapons;
    document.getElementById('repo-wpn-name').value = '';
    document.getElementById('repo-wpn-loc').value = '';
    window.renderSecretRepoEditorPanel();
};

window.removeSecretRepoWeapon = async function(idx) {
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!t) return;
    const weapons = (t.ship_weapons || []).slice();
    weapons.splice(idx, 1);
    const { error } = await db.from('ship_templates').update({ ship_weapons: weapons }).eq('id', editingRepoTemplateId);
    if (error) { alert("Failed to remove weapon: " + error.message); return; }
    t.ship_weapons = weapons;
    window.renderSecretRepoEditorPanel();
};

window.addSecretRepoDeck = async function() {
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!t) return;
    const name = document.getElementById('repo-deck-name').value.trim();
    if (!name) { alert("Enter a deck or subsystem name."); return; }
    const maxHp = parseInt(document.getElementById('repo-deck-hp').value) || 50;
    const decks = (t.ship_decks || []).slice();
    decks.push({ name, hp: maxHp, max_hp: maxHp, id: window.genDeckId() });
    const { error } = await db.from('ship_templates').update({ ship_decks: decks }).eq('id', editingRepoTemplateId);
    if (error) { alert("Failed to add deck: " + error.message); return; }
    t.ship_decks = decks;
    document.getElementById('repo-deck-name').value = '';
    window.renderSecretRepoEditorPanel();
};

window.removeSecretRepoDeck = async function(idx) {
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!t) return;
    const decks = (t.ship_decks || []).slice();
    decks.splice(idx, 1);
    const { error } = await db.from('ship_templates').update({ ship_decks: decks }).eq('id', editingRepoTemplateId);
    if (error) { alert("Failed to remove deck: " + error.message); return; }
    t.ship_decks = decks;
    window.renderSecretRepoEditorPanel();
};

/* --- Secret Repository Hangar / Strike Craft (QOL request, 2026-08-31) ---
   Templates previously had no hangar of their own at all -- ship_hangar
   only existed on ship_markers (deployed instances), commissioned via the
   Vessel Deck's live "commission squadron" tool (window.commissionSquadron,
   js/squadrons.js), which requires an already-deployed vessel to target.
   This mirrors that same logic against a ship_templates row instead, so a
   DM can pre-load an NPC carrier's hangar before it's ever deployed. New
   `ship_templates.ship_hangar` column added this session (migration
   add_hangar_cargo_to_ship_templates) -- it did not exist before despite
   the architecture doc claiming otherwise (verified directly against the
   live schema before writing any of this; doc corrected separately). */
function buildStrikeCraftTypeOptionsHtml(selected) {
    if (typeof STRIKE_CRAFT_DB === 'undefined') return '<option value="">-- No chassis available --</option>';
    return Object.keys(STRIKE_CRAFT_DB).sort((a, b) => (STRIKE_CRAFT_DB[a].label || a).localeCompare(STRIKE_CRAFT_DB[b].label || b))
        .map(k => `<option value="${k}" ${k === selected ? 'selected' : ''}>${STRIKE_CRAFT_DB[k].label}</option>`).join('');
}

window.addSecretRepoSquadron = async function() {
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!t) return;
    const nameInput = document.getElementById('repo-sq-name');
    const name = nameInput.value.trim();
    if (!name) { alert("Enter a callsign for this squadron."); return; }
    const type = document.getElementById('repo-sq-type').value;
    const count = Math.max(1, parseInt(document.getElementById('repo-sq-count').value) || 4);
    const dbStats = (typeof STRIKE_CRAFT_DB !== 'undefined') ? STRIKE_CRAFT_DB[type] : null;
    if (!dbStats) { alert("No strike craft chassis available -- design one in the Strike Craft Designer first."); return; }
    const hangar = (t.ship_hangar || []).slice();
    hangar.push({ id: 'sq_' + Math.random().toString(36).substr(2, 9), name, type, count, hp: dbStats.base_hp * count, max_hp: dbStats.base_hp * count, loiter: 4 });
    const { error } = await db.from('ship_templates').update({ ship_hangar: hangar }).eq('id', t.id);
    if (error) { alert("Failed to add squadron: " + error.message); return; }
    t.ship_hangar = hangar;
    nameInput.value = '';
    window.renderSecretRepoEditorPanel();
};

window.removeSecretRepoSquadron = async function(idx) {
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!t) return;
    const hangar = (t.ship_hangar || []).slice();
    hangar.splice(idx, 1);
    const { error } = await db.from('ship_templates').update({ ship_hangar: hangar }).eq('id', t.id);
    if (error) { alert("Failed to remove squadron: " + error.message); return; }
    t.ship_hangar = hangar;
    window.renderSecretRepoEditorPanel();
};

/* --- Secret Repository Cargo Hold (QOL request, 2026-08-31) --- same gap
   as hangar above: cargo_inventory only existed on ship_markers, and every
   deployed ship silently got the SAME hardcoded starter loadout
   (window.sanitizeCargo's fallback, js/combat.js) regardless of template --
   there was no way to give one NPC vessel different starting cargo than
   another. New `ship_templates.cargo_inventory` column added this session
   (same migration as ship_hangar above). Uses window.sanitizeCargo's own
   three-category shape (perishables/expendables/misc) so this editor and
   the live Cargo Deck stay in sync on structure. */
window.addSecretRepoCargoItem = async function() {
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!t) return;
    const nameInput = document.getElementById('repo-cargo-name');
    const name = nameInput.value.trim();
    if (!name) { alert("Enter an item name."); return; }
    const qty = Math.max(0, parseInt(document.getElementById('repo-cargo-qty').value) || 0);
    const unit = document.getElementById('repo-cargo-unit').value.trim() || 'Units';
    const category = document.getElementById('repo-cargo-category').value;
    const cargo = window.sanitizeCargo(t.cargo_inventory || {});
    cargo[category].push({ name, qty, unit });
    const { error } = await db.from('ship_templates').update({ cargo_inventory: cargo }).eq('id', t.id);
    if (error) { alert("Failed to add cargo item: " + error.message); return; }
    t.cargo_inventory = cargo;
    nameInput.value = '';
    window.renderSecretRepoEditorPanel();
};

window.removeSecretRepoCargoItem = async function(category, idx) {
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!t) return;
    const cargo = window.sanitizeCargo(t.cargo_inventory || {});
    (cargo[category] || []).splice(idx, 1);
    const { error } = await db.from('ship_templates').update({ cargo_inventory: cargo }).eq('id', t.id);
    if (error) { alert("Failed to remove cargo item: " + error.message); return; }
    t.cargo_inventory = cargo;
    window.renderSecretRepoEditorPanel();
};

window.updateSecretRepoSynthCapacity = async function(val) {
    const t = findAnyTemplateById(editingRepoTemplateId);
    if (!t) return;
    const cargo = window.sanitizeCargo(t.cargo_inventory || {});
    cargo.synth_capacity = Math.max(0, parseInt(val) || 0);
    const { error } = await db.from('ship_templates').update({ cargo_inventory: cargo }).eq('id', t.id);
    if (error) { alert("Failed to update synth capacity: " + error.message); return; }
    t.cargo_inventory = cargo;
};

/* --- Secret Repository weapon EDIT modal -- mirrors combat.js's live
   openEditWeaponModal field-for-field (see the build note above), just
   targeting ship_templates via editingRepoTemplateId instead of a live
   vessel's ship_markers row. Kept as a small popup rather than inline,
   matching how the Vessel Deck itself edits an existing weapon (✎ button
   -> small modal) -- "full screen" was never about eliminating every
   modal, just the two disconnected ones this replaced. */
(function() {
    let overlay, currentIdx;
    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'secretrepo-wpn-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:400px; max-width:94vw; max-height:88vh; overflow-y:auto; border-color:#ff3333;">
            <h4 style="color:#ff6b6b; margin-top:0;">Edit Weapon</h4>
            <label for="rwe-loc" style="font-size:9px; color:#ffaaaa;">Mount Location</label>
            <input type="text" id="rwe-loc" style="border-color:#ff3333;">
            <label for="rwe-name" style="font-size:9px; color:#ffaaaa;">Weapon Name</label>
            <input type="text" id="rwe-name" style="border-color:#ff3333;">
            <div style="display:flex; gap:6px;">
                <input type="text" id="rwe-dice" placeholder="1d10" style="flex:1; border-color:#ff3333; text-align:center;">
                <input type="text" id="rwe-mod" placeholder="+0" style="flex:1; border-color:#ff3333; text-align:center;">
                <input type="number" id="rwe-guns" placeholder="Guns" min="1" style="flex:1; border-color:#ff3333; text-align:center;">
            </div>
            <div style="display:flex; gap:6px; margin-top:6px;">
                <input type="number" id="rwe-ammo" placeholder="Ready Ammo (blank=INF)" style="flex:1; border-color:#ff3333; text-align:center;">
                <input type="number" id="rwe-maxammo" placeholder="Max Ammo" style="flex:1; border-color:#ff3333; text-align:center;">
            </div>
            <label for="rwe-dmgtype" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;">Damage Type</label>
            <select id="rwe-dmgtype" style="border-color:#ff3333;">${window.buildDamageTypeOptionsHtml('Impact')}</select>
            <label for="rwe-class" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;">Weapon Class</label>
            <select id="rwe-class" style="border-color:#ff3333;">
                <option value="direct_fire">Direct Fire (standard)</option>
                <option value="ordnance">Ordnance (missile/torpedo)</option>
            </select>
            <label for="rwe-range" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;">Range (Battle Map grid px, 0 = unlimited)</label>
            <input type="number" id="rwe-range" min="0" style="border-color:#ff3333; text-align:center;">
            <label for="rwe-cooldown" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;">Cooldown Period (turns, 0 = none)</label>
            <input type="number" id="rwe-cooldown" min="0" style="border-color:#ff3333; text-align:center;">
            <label for="rwe-deck" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;">Assigned Deck (optional)</label>
            <select id="rwe-deck" style="border-color:#ff3333;"></select>
            <div style="display:flex; justify-content:space-between; margin-top:8px;">
                <label for="rwe-explodes" style="font-size:10px; color:#ffaaaa; display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="rwe-explodes" style="margin:0;"> Exploding Dice</label>
                <label for="rwe-pd" style="font-size:10px; color:#ffaaaa; display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="rwe-pd" style="margin:0;"> Point Defense</label>
            </div>
            <label style="font-size:9px; color:#ff9d4d; margin-top:10px; display:block; border-top:1px dashed #3c4e36; padding-top:6px;">Tiered Ammo — Standby Reserve (0 = not used)</label>
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="rwe-standby" style="font-size:9px; color:#ffaaaa;">Standby (current)</label><input type="number" id="rwe-standby" min="0" style="border-color:#ff9d4d; text-align:center;"></div>
                <div style="flex:1;"><label for="rwe-standbymax" style="font-size:9px; color:#ffaaaa;">Standby Max</label><input type="number" id="rwe-standbymax" min="0" style="border-color:#ff9d4d; text-align:center;"></div>
            </div>
            <label for="rwe-ammotype" style="font-size:9px; color:#ffaaaa;">Ammo Type</label>
            <input type="text" id="rwe-ammotype" placeholder="Kinetic Rounds" style="border-color:#ff9d4d;">
            <label for="rwe-reloadcd" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;">Reload Cooldown (rounds)</label>
            <input type="number" id="rwe-reloadcd" min="0" style="border-color:#ff9d4d; text-align:center;">
            <label for="rwe-ordpattern" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;">Ordnance Pattern (ordnance weapons only)</label>
            <select id="rwe-ordpattern" style="border-color:#ff9d4d;">
                <option value="multi">Multi-Hit (6 payloads, default)</option>
                <option value="single">Single Warhead</option>
            </select>
            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="rwe-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="rwe-save-btn" class="btn-reveal" style="flex:1; margin-top:0;">SAVE CHANGES</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('rwe-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('rwe-save-btn').addEventListener('click', async () => {
            const t = findAnyTemplateById(editingRepoTemplateId);
            if (!t || !t.ship_weapons || !t.ship_weapons[currentIdx]) { overlay.style.display = 'none'; return; }
            const weapons = t.ship_weapons.slice();
            let wpn = Object.assign({}, weapons[currentIdx]);

            wpn.loc = document.getElementById('rwe-loc').value.trim() || 'Hardpoint';
            wpn.name = document.getElementById('rwe-name').value.trim() || wpn.name;
            let dice = document.getElementById('rwe-dice').value.trim().toLowerCase();
            wpn.dice = dice || wpn.dice;
            let mod = document.getElementById('rwe-mod').value.trim();
            if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
            wpn.modifier = mod || '+0';
            wpn.explodes = document.getElementById('rwe-explodes').checked;
            wpn.damage_type = document.getElementById('rwe-dmgtype').value;
            wpn.weapon_class = document.getElementById('rwe-class').value === 'ordnance' ? 'ordnance' : 'direct_fire';
            wpn.is_point_defense = document.getElementById('rwe-pd').checked;
            wpn.range = Math.max(0, parseInt(document.getElementById('rwe-range').value) || 0);
            wpn.cooldown_period = Math.max(0, parseInt(document.getElementById('rwe-cooldown').value) || 0);
            const deckSel = document.getElementById('rwe-deck');
            wpn.assigned_deck_id = (deckSel && deckSel.value) ? deckSel.value : null;

            let gunsVal = parseInt(document.getElementById('rwe-guns').value);
            wpn.gun_count = (gunsVal && gunsVal > 0) ? gunsVal : 1;

            let ammoStr = document.getElementById('rwe-ammo').value.trim();
            let maxAmmoStr = document.getElementById('rwe-maxammo').value.trim();
            if (ammoStr === '') {
                wpn.ammo = -1; wpn.max_ammo = -1;
            } else {
                wpn.ammo = Math.max(0, parseInt(ammoStr) || 0);
                let maxAmmo = maxAmmoStr !== '' ? parseInt(maxAmmoStr) || wpn.ammo : (wpn.max_ammo && wpn.max_ammo > 0 ? wpn.max_ammo : wpn.ammo);
                wpn.max_ammo = Math.max(wpn.ammo, maxAmmo);
            }

            wpn.max_standby_ammo = Math.max(0, parseInt(document.getElementById('rwe-standbymax').value) || 0);
            wpn.standby_ammo = Math.max(0, Math.min(wpn.max_standby_ammo, parseInt(document.getElementById('rwe-standby').value) || 0));
            wpn.ammo_type = document.getElementById('rwe-ammotype').value.trim() || 'Kinetic Rounds';
            wpn.reload_cooldown_period = Math.max(0, parseInt(document.getElementById('rwe-reloadcd').value) || 0);
            wpn.ordnance_pattern = document.getElementById('rwe-ordpattern').value === 'single' ? 'single' : 'multi';

            weapons[currentIdx] = wpn;
            const { error } = await db.from('ship_templates').update({ ship_weapons: weapons }).eq('id', editingRepoTemplateId);
            if (error) { alert("Failed to save weapon changes: " + error.message); return; }
            t.ship_weapons = weapons;
            overlay.style.display = 'none';
            window.renderSecretRepoEditorPanel();
        });
    }

    window.openSecretRepoWeaponEditModal = function(idx) {
        const t = findAnyTemplateById(editingRepoTemplateId);
        if (!t || !t.ship_weapons || !t.ship_weapons[idx]) return;
        const wpn = t.ship_weapons[idx];
        ensureModal();
        currentIdx = idx;
        document.getElementById('rwe-loc').value = wpn.loc || '';
        document.getElementById('rwe-name').value = wpn.name || '';
        document.getElementById('rwe-dice').value = wpn.dice || '';
        document.getElementById('rwe-mod').value = wpn.modifier || '';
        document.getElementById('rwe-guns').value = wpn.gun_count || 1;
        document.getElementById('rwe-ammo').value = wpn.ammo < 0 ? '' : wpn.ammo;
        document.getElementById('rwe-maxammo').value = wpn.max_ammo < 0 ? '' : wpn.max_ammo;
        document.getElementById('rwe-dmgtype').value = window.normalizeDamageType(wpn.damage_type || 'Impact');
        document.getElementById('rwe-class').value = wpn.weapon_class === 'ordnance' ? 'ordnance' : 'direct_fire';
        document.getElementById('rwe-range').value = wpn.range || 0;
        document.getElementById('rwe-cooldown').value = wpn.cooldown_period || 0;
        const deckSel = document.getElementById('rwe-deck');
        deckSel.innerHTML = '<option value="">-- Not deck-gated --</option>' + (t.ship_decks || []).map(d => `<option value="${d.id}">${d.name}</option>`).join('');
        deckSel.value = wpn.assigned_deck_id || '';
        document.getElementById('rwe-explodes').checked = !!wpn.explodes;
        document.getElementById('rwe-pd').checked = !!wpn.is_point_defense;
        document.getElementById('rwe-standby').value = wpn.standby_ammo || 0;
        document.getElementById('rwe-standbymax').value = wpn.max_standby_ammo || 0;
        document.getElementById('rwe-ammotype').value = wpn.ammo_type || 'Kinetic Rounds';
        document.getElementById('rwe-reloadcd').value = wpn.reload_cooldown_period !== undefined ? wpn.reload_cooldown_period : 1;
        document.getElementById('rwe-ordpattern').value = wpn.ordnance_pattern === 'single' ? 'single' : 'multi';
        overlay.style.display = 'flex';
    };
})();


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

    // Bug fix (bug hunt, this session): `.slice()` only copies the outer
    // array -- `existing` was still the SAME member object living inside
    // fleet.members, so `existing.quantity += qty` mutated the live cache
    // in place before the DB write was even attempted, let alone confirmed
    // successful (unlike updateFleetMemberQty below, which already builds
    // an immutable copy via `.map`). Build an immutable copy here too.
    const rawMembers = fleet.members || [];
    const hasExisting = rawMembers.some(m => m.template_id === select.value);
    const members = hasExisting
        ? rawMembers.map(m => m.template_id === select.value ? { ...m, quantity: m.quantity + qty } : m)
        : [...rawMembers, { template_id: select.value, quantity: qty }];

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
