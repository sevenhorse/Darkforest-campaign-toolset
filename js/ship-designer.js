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

    shipTemplatesList.forEach(t => {
        const editable = canManageTemplate(t);
        const owner = allProfiles.find(p => p.id === t.owner_id);
        const weaponCount = (t.ship_weapons || []).length;
        const slots = t.hardpoint_slots || 4;
        html += `
            <div class="note-card">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#00e1ff; font-size:12px;">${t.name}</strong>
                        <p style="margin:2px 0 0 0; font-size:10px; color:#d4c5a9;">${t.class || 'Frigate'} &nbsp;·&nbsp; ${(t.drive_type || 'ftl_class1').replace('ftl_', 'FTL ').replace('_', ' ').replace('sublight', 'Sublight')}</p>
                        <p style="margin:2px 0 0 0; font-size:10px; color:#6b826a;">Shields ${t.max_shields || 0} · Reactive ${t.max_reactive || 0} · Ablative ${t.max_ablative || 0} · Hardened ${t.max_hardened || 0} · Hull ${t.max_hull || 0}</p>
                        <p style="margin:2px 0 0 0; font-size:10px; color:#6b826a;">Hardpoints: ${weaponCount} / ${slots} installed</p>
                        <span class="author-tag">designer: ${owner ? (owner.username || 'Commander') : 'Unknown'}</span>
                    </div>
                    <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; max-width:120px;">
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

window.saveNewShipTemplate = async function() {
    const name = document.getElementById('new-template-name').value.trim();
    if (!name) { alert("Enter a vessel designation first."); return; }
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
        ship_weapons: [],
        ship_decks: [],
        is_secret: false
    };
    const { error } = await db.from('ship_templates').insert(payload);
    if (error) { alert("Failed to save vessel profile: " + error.message); return; }

    document.getElementById('new-template-name').value = '';
    document.getElementById('new-template-class').value = '';
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
        ship_weapons: JSON.parse(JSON.stringify(t.ship_weapons || [])),
        ship_decks: JSON.parse(JSON.stringify(t.ship_decks || []))
    };
    const { error } = await db.from('ship_markers').insert(payload);
    if (error) { alert("Failed to deploy vessel: " + error.message); return; }
    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
    if (window.AudioEngine) window.AudioEngine.playPing();
    alert(`${t.name} deployed to your current DRADIS position.`);
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
            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="tmpl-edit-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="tmpl-edit-save-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#00e1ff; color:#00e1ff;">SAVE CHANGES</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('tmpl-edit-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('tmpl-edit-save-btn').addEventListener('click', async () => {
            const updates = {
                name: document.getElementById('tmpl-edit-name').value.trim() || 'Unnamed Vessel',
                class: document.getElementById('tmpl-edit-class').value.trim() || 'Frigate',
                drive_type: document.getElementById('tmpl-edit-drive').value,
                max_shields: parseInt(document.getElementById('tmpl-edit-shields').value) || 0,
                max_reactive: parseInt(document.getElementById('tmpl-edit-reactive').value) || 0,
                max_ablative: parseInt(document.getElementById('tmpl-edit-ablative').value) || 0,
                max_hardened: parseInt(document.getElementById('tmpl-edit-hardened').value) || 0,
                max_hull: parseInt(document.getElementById('tmpl-edit-hull').value) || 0,
                hardpoint_slots: parseInt(document.getElementById('tmpl-edit-slots').value) || 4
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
        overlay.style.display = 'flex';
    };
})();

/* --- LOADOUT MODAL (weapon list, reuses the shared 12-type damage matrix) --- */
(function() {
    let overlay, currentId;
    function renderLoadoutList() {
        const t = findAnyTemplateById(currentId);
        if (!t) return;
        const listEl = document.getElementById('tmpl-loadout-list');
        const weapons = t.ship_weapons || [];
        let html = '';
        if (weapons.length === 0) html = '<span style="font-size:10px; color:#6b826a;">No hardpoints configured.</span>';
        weapons.forEach((w, idx) => {
            const dt = window.normalizeDamageType(w.damage_type || 'Impact');
            const info = window.DAMAGE_TYPES[dt];
            html += `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:4px;">
                <span style="font-size:10px; color:#d4c5a9;">${w.name} — ${w.dice}${w.modifier} · <span style="color:${info.color};">${dt}</span> · ${w.gun_count || 1}x guns</span>
                <button class="layer-del" onclick="window.removeTemplateWeapon(${idx})" style="padding:2px 6px; font-size:9px;">✕</button>
            </div>`;
        });
        listEl.innerHTML = html;
        const slots = t.hardpoint_slots || 4;
        document.getElementById('tmpl-loadout-slots-label').innerText = `${weapons.length} / ${slots} hardpoints used`;
    }

    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'template-loadout-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:440px; max-width:94vw; max-height:88vh; overflow-y:auto; border-color:#ff6b6b;">
            <h4 style="color:#ff6b6b; margin-top:0;">Weapon Loadout <span id="tmpl-loadout-slots-label" style="font-size:9px; color:#6b826a; font-weight:normal;"></span></h4>
            <div id="tmpl-loadout-list" style="max-height:220px; overflow-y:auto; margin-bottom:10px;"></div>
            <div style="background:#030403; padding:8px; border:1px solid #ff3333; border-radius:2px;">
                <label for="tmpl-loadout-name" style="font-size:9px; color:#ffaaaa;">Add Weapon</label>
                <input type="text" id="tmpl-loadout-name" placeholder="Weapon Name" style="border-color:#ff3333;">
                <div style="display:flex; gap:6px;">
                    <input type="text" id="tmpl-loadout-dice" placeholder="d20" style="flex:1; border-color:#ff3333; text-align:center;">
                    <input type="text" id="tmpl-loadout-mod" placeholder="+0" style="flex:1; border-color:#ff3333; text-align:center;">
                    <input type="number" id="tmpl-loadout-guns" placeholder="Guns" min="1" value="1" style="flex:1; border-color:#ff3333; text-align:center;">
                </div>
                <select id="tmpl-loadout-dmgtype" style="border-color:#ff3333;">${window.buildDamageTypeOptionsHtml('Impact')}</select>
                <button class="btn-remove" onclick="window.addTemplateWeapon()" style="width:100%; margin-top:6px; font-size:10px;">+ ADD HARDPOINT</button>
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
        if (weapons.length >= slots) { alert(`This hull only has ${slots} hardpoint slots — expand Hardpoint Slots in Edit Stats first.`); return; }

        const name = document.getElementById('tmpl-loadout-name').value.trim();
        if (!name) { alert("Enter a weapon name."); return; }
        let dice = document.getElementById('tmpl-loadout-dice').value.trim() || '1d10';
        let mod = document.getElementById('tmpl-loadout-mod').value.trim() || '+0';
        if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
        const gunCount = parseInt(document.getElementById('tmpl-loadout-guns').value) || 1;
        const dmgType = document.getElementById('tmpl-loadout-dmgtype').value;

        weapons.push({ loc: 'Hardpoint', name, dice, modifier: mod, explodes: false, ammo: -1, max_ammo: -1, cooldown: 0, overheat: 0, gun_count: gunCount, damage_type: dmgType });
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
        html += `
            <div class="note-card" style="border-color:#ff3333;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#ff6b6b; font-size:12px;">${t.name}</strong>
                        <p style="margin:2px 0 0 0; font-size:10px; color:#d4c5a9;">${t.class || 'Frigate'} · Hull ${t.max_hull || 0} · Shields ${t.max_shields || 0} · ${weaponCount}/${t.hardpoint_slots || 4} hardpoints</p>
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
    const payload = {
        owner_id: currentUserId,
        name,
        class: document.getElementById('new-secret-template-class').value.trim() || 'Frigate',
        drive_type: document.getElementById('new-secret-template-drive').value,
        max_shields: parseInt(document.getElementById('new-secret-template-shields').value) || 0,
        max_hull: parseInt(document.getElementById('new-secret-template-hull').value) || 100,
        hardpoint_slots: parseInt(document.getElementById('new-secret-template-slots').value) || 4,
        ship_weapons: [],
        ship_decks: [],
        is_secret: true
    };
    const { error } = await db.from('ship_templates').insert(payload);
    if (error) { alert("Failed to store repository template: " + error.message); return; }

    document.getElementById('new-secret-template-name').value = '';
    document.getElementById('new-secret-template-class').value = '';
    if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
};

window.deployTemplateToInitiative = async function(id) {
    const t = findAnyTemplateById(id);
    if (!t) return;
    const initInput = document.getElementById(`repo-init-${id}`);
    const initiative = initInput ? (parseInt(initInput.value) || 10) : 10;
    const { error } = await db.from('combat_tracker').insert({
        name: t.name, initiative, hp: `${t.max_hull || 0}/${t.max_hull || 0}`, owner_id: currentUserId
    });
    if (error) { alert("Failed to inject into initiative tracker: " + error.message); return; }
    if (typeof loadCombatTracker === 'function') loadCombatTracker();
    if (window.AudioEngine) window.AudioEngine.playPing();
};
