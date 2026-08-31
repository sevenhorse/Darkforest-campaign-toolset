/* ==========================================================================
   js/strike-craft-designer.js - Strike Craft Designer (DM-only catalog CRUD)
   ========================================================================== */

/* Build (2026-08-31, DM request): STRIKE_CRAFT_DB (js/squadrons.js) was a
   hardcoded JS constant with exactly 3 chassis (raven/hawk/messenger) and
   ZERO in-app editor -- the Commission Squadron "Chassis Type" dropdown was
   even just 3 hardcoded <option> tags in index.html. Confirmed with the DM
   via AskUserQuestion: build a real DB-backed designer, same architectural
   shift Perk/Gear/Augment/Ship Designer already made from "fixed presets"
   to "DM can create/edit live." New table: strike_craft_templates (key,
   label, base_hp, weapons jsonb).

   KEY DESIGN CHOICE, flagged: rather than touching every one of the ~9 call
   sites across squadrons.js/combat.js that read STRIKE_CRAFT_DB[someKey],
   this file MUTATES the existing STRIKE_CRAFT_DB object's CONTENTS in place
   (never reassigns the binding) once the DB rows load. Every read site
   already does a live property lookup at call time (never a cached
   reference captured at parse time -- squadrons.js's own header comment
   confirms this was already the intended contract), so merging DB rows
   into the same object is a zero-risk way to make the whole app DB-aware
   with no other file touched. The 3 hardcoded chassis stay in the source as
   permanent fallback defaults: if a DM ever deletes the 'raven' row (say)
   from the database, in-memory STRIKE_CRAFT_DB still has a 'raven' entry
   compiled in, so any OLD squadron/hangar entry still referencing type
   'raven' keeps resolving instead of crashing -- same "fails open on a
   stale reference" convention this codebase already uses everywhere else.
   A brand-new DM-created chassis has no such fallback, so deleting it is a
   real, permanent removal (correct expected behavior for something that
   was never hardcoded). */

window.globalStrikeCraftTemplatesList = [];
let editingStrikeCraftId = null;

window.loadStrikeCraftTemplates = async function() {
    const { data, error } = await db.from('strike_craft_templates').select('*').order('created_at', { ascending: true });
    if (error) { console.error('loadStrikeCraftTemplates failed:', error.message); return; }
    window.globalStrikeCraftTemplatesList = data || [];
    // Merge into the shared STRIKE_CRAFT_DB catalog (js/squadrons.js) --
    // additive only, never deletes a key wholesale, see header comment.
    (data || []).forEach(row => {
        STRIKE_CRAFT_DB[row.key] = { label: row.label, base_hp: row.base_hp, weapons: row.weapons || [], _dbId: row.id };
    });
    if (typeof window.renderSquadronTypeOptions === 'function') window.renderSquadronTypeOptions();
    if (typeof window.renderStrikeCraftDesignerPanel === 'function') window.renderStrikeCraftDesignerPanel();
};

// Rebuilds the Commission Squadron "Chassis Type" dropdown (index.html,
// previously 3 hardcoded <option> tags) from STRIKE_CRAFT_DB's CURRENT
// keys, so a newly-designed chassis (or a renamed/deleted one) shows up
// without ever touching index.html again. Preserves the previously-selected
// value across a refresh when it still exists.
window.renderSquadronTypeOptions = function() {
    const sel = document.getElementById('new-squadron-type');
    if (!sel) return;
    const prevVal = sel.value;
    sel.innerHTML = Object.keys(STRIKE_CRAFT_DB).sort((a, b) => (STRIKE_CRAFT_DB[a].label || a).localeCompare(STRIKE_CRAFT_DB[b].label || b))
        .map(k => `<option value="${k}">${STRIKE_CRAFT_DB[k].label}</option>`).join('');
    if (prevVal && STRIKE_CRAFT_DB[prevVal]) sel.value = prevVal;
};

function findStrikeCraftTemplate(id) {
    return window.globalStrikeCraftTemplatesList.find(t => t.id === id);
}

window.renderStrikeCraftDesignerPanel = function() {
    const container = document.getElementById('strikecraft-list-container');
    if (!container) return;
    const searchEl = document.getElementById('strikecraft-designer-search');
    const term = searchEl ? searchEl.value.trim().toLowerCase() : '';
    const source = window.globalStrikeCraftTemplatesList || [];
    const filtered = term ? source.filter(t => (t.label || '').toLowerCase().includes(term) || (t.key || '').toLowerCase().includes(term)) : source;

    if (source.length === 0) { container.innerHTML = '<span style="font-size:10px; color:#6b826a;">No strike craft chassis designed yet.</span>'; return; }
    if (filtered.length === 0) { container.innerHTML = `<span style="font-size:10px; color:#6b826a;">No chassis match "${searchEl.value.trim()}".</span>`; return; }

    container.innerHTML = filtered.map(t => `
        <div class="note-card" style="padding:8px; margin-bottom:6px; background:#030403; border-color:#00e1ff;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <strong style="color:#00e1ff; font-size:12px;">${t.label}</strong>
                    <div style="font-size:10px; color:#6b826a;">key: ${t.key} &middot; ${t.base_hp} HP &middot; ${(t.weapons || []).length} weapon(s)</div>
                </div>
                <button class="layer-edit" onclick="window.openStrikeCraftEditor('${t.id}')" style="padding:3px 6px; font-size:9px; border-color:#00e1ff; color:#00e1ff;">OPEN &#9656;</button>
            </div>
        </div>`).join('');
};

window.addStrikeCraftChassis = async function() {
    const nameInput = document.getElementById('new-strikecraft-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) { alert("Enter a chassis name first."); return; }

    // Slug the key from the name at creation time only -- deliberately NOT
    // re-derived on later renames, since the key is what sq.type/hangar
    // entries persist by. Collides-with-existing-key gets a numeric suffix
    // rather than silently overwriting another chassis's catalog entry.
    let baseKey = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'chassis';
    let key = baseKey;
    let n = 2;
    while (STRIKE_CRAFT_DB[key]) { key = `${baseKey}_${n}`; n++; }

    const payload = { key, label: name, base_hp: 100, weapons: [] };
    const { data, error } = await db.from('strike_craft_templates').insert(payload).select().single();
    if (error) { alert("Failed to create chassis: " + error.message); return; }

    window.globalStrikeCraftTemplatesList.push(data);
    STRIKE_CRAFT_DB[data.key] = { label: data.label, base_hp: data.base_hp, weapons: data.weapons || [], _dbId: data.id };
    if (nameInput) nameInput.value = '';
    window.renderSquadronTypeOptions();
    window.renderStrikeCraftDesignerPanel();
    window.openStrikeCraftEditor(data.id);
};

window.openStrikeCraftEditor = function(id) {
    const t = findStrikeCraftTemplate(id);
    if (!t) return;
    editingStrikeCraftId = id;
    document.getElementById('strikecraft-list-view').style.display = 'none';
    document.getElementById('strikecraft-editor-view').style.display = 'block';
    window.renderStrikeCraftEditorPanel();
};

window.closeStrikeCraftEditor = function() {
    editingStrikeCraftId = null;
    const listView = document.getElementById('strikecraft-list-view');
    const editorView = document.getElementById('strikecraft-editor-view');
    if (listView) listView.style.display = 'block';
    if (editorView) editorView.style.display = 'none';
};

function renderStrikeCraftWeaponCard(w, idx) {
    const dt = window.normalizeDamageType(w.dmgType || 'Impact');
    const info = window.DAMAGE_TYPES[dt] || window.DAMAGE_TYPES['Impact'];
    const roleLabels = { anti_fighter: 'Anti-Fighter', anti_capital: 'Anti-Capital', point_defense: 'Point Defense', general: 'General' };
    const roleLabel = roleLabels[w.role] || 'General';
    const classBadge = w.weapon_class === 'ordnance' ? '<span style="font-size:8px; color:#c778dd; border:1px solid #c778dd; border-radius:2px; padding:1px 4px; margin-left:4px;">&#9760; ORDNANCE</span>' : '';
    const rangeBadge = w.range ? `<span style="font-size:8px; color:#6b826a; border:1px solid #3c4e36; border-radius:2px; padding:1px 4px; margin-left:4px;">&#128207; ${w.range}</span>` : '<span style="font-size:8px; color:#6b826a; border:1px solid #3c4e36; border-radius:2px; padding:1px 4px; margin-left:4px;">unlimited</span>';
    const cooldownBadge = w.cooldown_period ? `<span style="font-size:8px; color:#ff9d4d; border:1px solid #ff9d4d; border-radius:2px; padding:1px 4px; margin-left:4px;">&#9201; ${w.cooldown_period}</span>` : '';
    return `<div class="note-card" style="padding:8px; margin-bottom:6px; background:#030403; border-color:#00e1ff;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
                <strong style="color:#00e1ff; font-size:12px;">${w.name}</strong>${classBadge}${rangeBadge}${cooldownBadge}
                <div style="font-size:10px; color:#d4c5a9;">${w.dice} ${w.explodes ? '💥' : ''} &middot; <span style="color:${info.color};">${dt}</span> &middot; ${roleLabel}</div>
            </div>
            <button class="layer-del" onclick="window.removeStrikeCraftWeapon(${idx})" style="padding:4px 8px; font-size:10px;">&#10005;</button>
        </div>
    </div>`;
}

window.renderStrikeCraftEditorPanel = function() {
    const container = document.getElementById('strikecraft-editor-container');
    const t = findStrikeCraftTemplate(editingStrikeCraftId);
    if (!container || !t) return;

    t.weapons = t.weapons || [];
    const weaponsHtml = t.weapons.length === 0
        ? '<span style="font-size:10px; color:#6b826a;">No weapons on this chassis.</span>'
        : t.weapons.map((w, idx) => renderStrikeCraftWeaponCard(w, idx)).join('');

    container.innerHTML = `
        <div class="sheet-section" style="border-color:#00e1ff;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
                <h3 style="color:#00e1ff; margin:0;">${t.label} <span style="font-size:9px; color:#6b826a; font-weight:normal;">(key: ${t.key})</span></h3>
                <button class="layer-del" onclick="window.deleteStrikeCraftChassisAndClose()" style="padding:4px 10px; font-size:9px;">&#128465; DELETE CHASSIS</button>
            </div>
            <div style="display:grid; grid-template-columns: 2fr 1fr; gap:10px; margin-top:12px;">
                <div><label for="sc-edit-label" style="font-size:9px; color:#6b826a;">Chassis Name:</label><input type="text" id="sc-edit-label" value="${t.label || ''}" style="border-color:#00e1ff;"></div>
                <div><label for="sc-edit-hp" style="font-size:9px; color:#6b826a;">Base HP (per unit):</label><input type="number" id="sc-edit-hp" value="${t.base_hp || 100}" min="1" style="border-color:#00e1ff; text-align:center;"></div>
            </div>
            <p style="font-size:9px; color:#6b826a; margin:6px 0 0;">The key (<code>${t.key}</code>) is set once at creation and never changes, even if you rename this chassis -- it's what already-commissioned squadrons remember it by.</p>
            <button class="btn-reveal" onclick="window.saveStrikeCraftIdentity()" style="margin-top:10px; border-color:#00e1ff; color:#00e1ff;">SAVE CHANGES</button>
        </div>

        <div class="sheet-section" style="margin-top:16px; border-color:#00e1ff;">
            <h4 style="margin:0 0 6px 0; border-bottom:1px solid #3c4e36; padding-bottom:4px; color:#00e1ff;">Weapons</h4>
            <div id="strikecraft-weapons-list" style="margin-bottom:10px;">${weaponsHtml}</div>
            <div style="background:#030403; padding:8px; border:1px solid #00e1ff; border-radius:2px;">
                <label for="sc-wpn-name" style="font-size:9px; color:#6b826a;">Add Weapon</label>
                <div style="display:flex; gap:6px;">
                    <input type="text" id="sc-wpn-name" placeholder="Weapon Name" style="flex:2; border-color:#00e1ff;">
                    <input type="text" id="sc-wpn-dice" placeholder="2d6" style="flex:1; border-color:#00e1ff; text-align:center;">
                </div>
                <select id="sc-wpn-dmgtype" style="margin-top:4px;">${window.buildDamageTypeOptionsHtml('Impact')}</select>
                <div style="display:flex; gap:6px; margin-top:4px;">
                    <select id="sc-wpn-role" style="flex:1;" title="Which Squadron AI Stance this weapon is used for">
                        <option value="general">General</option>
                        <option value="anti_fighter">Anti-Fighter</option>
                        <option value="anti_capital">Anti-Capital</option>
                        <option value="point_defense">Point Defense</option>
                    </select>
                    <select id="sc-wpn-class" style="flex:1;">
                        <option value="direct_fire">Direct Fire</option>
                        <option value="ordnance">Ordnance</option>
                    </select>
                </div>
                <div style="display:flex; gap:6px; margin-top:4px;">
                    <div style="flex:1;"><label for="sc-wpn-range" style="font-size:8px; color:#6b826a;" title="Battle Map targeting range, 0 = unlimited">Range</label><input type="number" id="sc-wpn-range" min="0" placeholder="0=unlimited" style="text-align:center;"></div>
                    <div style="flex:1;"><label for="sc-wpn-cooldown" style="font-size:8px; color:#6b826a;" title="Turns to recharge after firing, 0 = none">Cooldown</label><input type="number" id="sc-wpn-cooldown" min="0" placeholder="0" style="text-align:center;"></div>
                </div>
                <label for="sc-wpn-explodes" style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:6px;">
                    <input type="checkbox" id="sc-wpn-explodes" style="margin:0;"> Exploding Dice
                </label>
                <button class="btn-remove" onclick="window.addStrikeCraftWeapon()" style="width:100%; margin-top:6px; font-size:10px;">+ ADD WEAPON</button>
            </div>
        </div>
    `;
};

window.saveStrikeCraftIdentity = async function() {
    const t = findStrikeCraftTemplate(editingStrikeCraftId);
    if (!t) return;
    const payload = {
        label: document.getElementById('sc-edit-label').value.trim() || t.label,
        base_hp: Math.max(1, parseInt(document.getElementById('sc-edit-hp').value) || 100)
    };
    const { error } = await db.from('strike_craft_templates').update(payload).eq('id', t.id);
    if (error) { alert("Failed to save chassis: " + error.message); return; }
    Object.assign(t, payload);
    STRIKE_CRAFT_DB[t.key] = { label: t.label, base_hp: t.base_hp, weapons: t.weapons || [], _dbId: t.id };
    window.renderStrikeCraftEditorPanel();
    window.renderStrikeCraftDesignerPanel();
    window.renderSquadronTypeOptions();
    if (window.AudioEngine) window.AudioEngine.playPing();
};

window.addStrikeCraftWeapon = async function() {
    const t = findStrikeCraftTemplate(editingStrikeCraftId);
    if (!t) return;
    const name = document.getElementById('sc-wpn-name').value.trim();
    const dice = document.getElementById('sc-wpn-dice').value.trim().toLowerCase();
    if (!name || !dice) { alert("Weapon name and dice are both required."); return; }
    if (!/^\d*d\d+$/i.test(dice)) { alert(`"${dice}" isn't a valid dice format (e.g. 2d6, d20).`); return; }

    const weapon = {
        name, dice,
        dmgType: document.getElementById('sc-wpn-dmgtype').value || 'Impact',
        role: document.getElementById('sc-wpn-role').value || 'general',
        weapon_class: document.getElementById('sc-wpn-class').value === 'ordnance' ? 'ordnance' : 'direct_fire',
        range: Math.max(0, parseInt(document.getElementById('sc-wpn-range').value) || 0),
        cooldown_period: Math.max(0, parseInt(document.getElementById('sc-wpn-cooldown').value) || 0),
        explodes: document.getElementById('sc-wpn-explodes').checked
    };

    t.weapons = t.weapons || [];
    t.weapons.push(weapon);
    const { error } = await db.from('strike_craft_templates').update({ weapons: t.weapons }).eq('id', t.id);
    if (error) { alert("Failed to save weapon: " + error.message); t.weapons.pop(); return; }
    STRIKE_CRAFT_DB[t.key] = { label: t.label, base_hp: t.base_hp, weapons: t.weapons, _dbId: t.id };

    document.getElementById('sc-wpn-name').value = '';
    document.getElementById('sc-wpn-dice').value = '';
    document.getElementById('sc-wpn-range').value = '';
    document.getElementById('sc-wpn-cooldown').value = '';
    document.getElementById('sc-wpn-explodes').checked = false;
    window.renderStrikeCraftEditorPanel();
    window.renderStrikeCraftDesignerPanel();
};

window.removeStrikeCraftWeapon = async function(idx) {
    const t = findStrikeCraftTemplate(editingStrikeCraftId);
    if (!t) return;
    if (!(await window.showConfirmModal(`Remove "${t.weapons[idx].name}" from ${t.label}?`))) return;
    t.weapons.splice(idx, 1);
    const { error } = await db.from('strike_craft_templates').update({ weapons: t.weapons }).eq('id', t.id);
    if (error) { alert("Failed to remove weapon: " + error.message); return; }
    STRIKE_CRAFT_DB[t.key] = { label: t.label, base_hp: t.base_hp, weapons: t.weapons, _dbId: t.id };
    window.renderStrikeCraftEditorPanel();
    window.renderStrikeCraftDesignerPanel();
};

window.deleteStrikeCraftChassisAndClose = async function() {
    const t = findStrikeCraftTemplate(editingStrikeCraftId);
    if (!t) return;
    if (!(await window.showConfirmModal(`Delete "${t.label}" from the catalog permanently? Any squadron already commissioned with this chassis keeps its current stats, but you won't be able to commission a NEW one of this type again${STRIKE_CRAFT_DB[t.key] && ['raven','hawk','messenger'].includes(t.key) ? ' -- it will fall back to its original built-in stats' : ''}.`))) return;
    const { error } = await db.from('strike_craft_templates').delete().eq('id', t.id);
    if (error) { alert("Failed to delete chassis: " + error.message); return; }
    window.globalStrikeCraftTemplatesList = window.globalStrikeCraftTemplatesList.filter(x => x.id !== t.id);
    // Deliberately does NOT delete STRIKE_CRAFT_DB[t.key] outright -- a
    // hardcoded default (raven/hawk/messenger) falls back to its compiled-in
    // shape automatically (see header comment); a custom chassis with no
    // such fallback is removed here so it stops appearing in the Commission
    // dropdown, matching a real delete.
    if (!['raven', 'hawk', 'messenger'].includes(t.key)) delete STRIKE_CRAFT_DB[t.key];
    window.closeStrikeCraftEditor();
    window.renderStrikeCraftDesignerPanel();
    window.renderSquadronTypeOptions();
};
