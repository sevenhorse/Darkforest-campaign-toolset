/* ==========================================================================
   js/gear-designer.js - GEAR DESIGNER & APPROVAL WORKFLOW
   Converts non-weapon personal gear (uniforms, boots, packs, tools -- the
   free-text "Tactical Gear & Inventory" box, which had zero mechanical
   effect) into a real DB-backed catalog, same draft/approval shift Perk
   Designer and Augment Designer already made for their own systems.

   Two things deliberately differ from Augment Designer, per confirmed
   design (this feature's equivalent of those confirmed decisions):
   (1) NO fixed slots. Body Augments have 7 slots because that maps to
       something anatomically real; gear is a grab-bag (uniform, boots,
       backpack, tools) with no equivalent fixed structure in this game's
       rules, so a gear definition just goes into one flat catalog and a
       character's loadout is an open list, same shape as Arsenal weapons.
   (2) Each character_gear row has an `equipped` toggle. Unlike augments
       (installed always = active), gear can be owned-but-stowed (a spare
       uniform in the pack) without contributing its bonus -- only rows
       with equipped = true count toward getGearBonusFor / shield / DR /
       injury max. This also means two gear items that are meant to be
       mutually exclusive (two different uniforms) don't silently double
       up UNLESS the player also marks both equipped -- that's on the
       player, same trust model as everything else in this "blanket
       authenticated" project.
   Installing/removing/toggling gear on your own character stays
   self-service (no DM gate), matching Augments. Only the CATALOG
   (proposing/approving a definition) has the approval gate. Flavor-only
   and notes-only (no gear_definition_id at all) entries are first-class,
   same as Augments -- there was no legacy free-text data to migrate here
   (every character's `assets` field was already empty when this was
   built), so there's no backfill step this time.

   The existing free-text "Tactical Gear & Inventory" box on the sheet
   (characters.assets) is NOT replaced -- it stays as a catch-all for
   narrative/miscellaneous inventory (credits, servitors, whatever doesn't
   need mechanical tracking), same "small notes field alongside the
   picker" precedent set for Body Augmentations. This new Gear Loadout
   list sits above it for anything that should actually grant a bonus.
   ========================================================================== */

let gearDefinitionsList = [];

async function loadGearDefinitions() {
    const { data } = await db.from('gear_definitions').select('*').order('created_at', { ascending: true });
    if (data) { gearDefinitionsList = data; if (typeof window.renderGearDesignerPanel === 'function') window.renderGearDesignerPanel(); if (typeof window.renderGearLoadout === 'function') window.renderGearLoadout(); if (typeof window.updateShieldDisplay === 'function') window.updateShieldDisplay(); if (typeof window.updateInjuryMax === 'function') window.updateInjuryMax(); }
}

function canManageGear(g) {
    return currentUserRole === 'dm' || (g.status === 'draft' && g.created_by === currentUserId);
}

window.findGearDefinition = function(id) {
    return gearDefinitionsList.find(g => g.id === id);
};

window.getApprovedGear = function() {
    return gearDefinitionsList.filter(g => g.status === 'approved');
};

// Same lookup shape as getPerkBonusFor/getAugmentBonusFor, but only counts
// rows the player has actually marked equipped -- a stowed item contributes
// nothing, same as a row with no gear_definition_id (pure notes) contributes
// nothing.
window.getGearBonusFor = function(charGearList, targetType, targetName) {
    let total = 0;
    let sources = [];
    (charGearList || []).forEach(cg => {
        if (!cg.equipped) return;
        const def = window.findGearDefinition(cg.gear_definition_id);
        if (!def) return;
        (def.effects || []).forEach(eff => {
            if (eff.target === targetType && eff.name === targetName) {
                total += eff.bonus;
                sources.push(`${def.name} ${eff.bonus >= 0 ? '+' : ''}${eff.bonus}`);
            }
        });
    });
    return { total, sources };
};

window.renderGearDesignerPanel = function() {
    const container = document.getElementById('gear-designer-list-container');
    if (!container) return;
    let html = '';
    if (gearDefinitionsList.length === 0) html = '<span style="font-size:10px; color:#6b826a;">No gear defined yet.</span>';

    const pending = window.applySavedOrder('gear_pending', gearDefinitionsList.filter(g => g.status === 'draft'));
    const approved = window.applySavedOrder('gear_approved', gearDefinitionsList.filter(g => g.status === 'approved'));

    const renderCard = (g, listKey, siblingList) => {
        const editable = canManageGear(g);
        const proposer = allProfiles.find(p => p.id === g.created_by);
        // Bug fix (bug hunt, this session): `> 0` hid a negative bonus (fully
        // legal -- the form has no min="0" on these, and getEffectiveShieldMax/
        // getEffectiveDR/getEffectiveInjuryMax apply it unconditionally
        // regardless of sign) behind "No effects configured," masking a real
        // mechanical penalty from the DM. Same fix applied identically to
        // perk-designer.js and augment-designer.js's cards.
        let effectsLine = g.flavor_only
            ? '<span style="color:#c778dd;">Flavor only — no automatic mechanical effect.</span>'
            : [
                g.shield_max_bonus ? `<span style="color:#00e1ff;">Shield Max ${g.shield_max_bonus >= 0 ? '+' : ''}${g.shield_max_bonus}</span>` : '',
                g.dr_bonus ? `<span style="color:#c9962f;">DR ${g.dr_bonus >= 0 ? '+' : ''}${g.dr_bonus}</span>` : '',
                g.injury_max_bonus ? `<span style="color:#ff6b6b;">Injury Max ${g.injury_max_bonus >= 0 ? '+' : ''}${g.injury_max_bonus}</span>` : '',
                (g.effects || []).map(e => `${e.name} ${e.bonus >= 0 ? '+' : ''}${e.bonus}`).join(', ')
              ].filter(Boolean).join(' · ') || '<span style="color:#6b826a;">No effects configured.</span>';
        return `
            <div class="note-card" style="border-left: 3px solid ${g.status === 'draft' ? '#ffaa00' : '#00e5a3'};">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:${g.status === 'draft' ? '#ffaa00' : '#00e5a3'}; font-size:12px;">${g.name}</strong>
                        <span style="font-size:9px; color:#6b826a;"> ${g.status === 'draft' ? '· PENDING REVIEW' : ''}</span>
                        <div style="font-size:10px; color:#d4c5a9; margin-top:2px;">${g.description || ''}</div>
                        <div style="font-size:9px; margin-top:4px;">${effectsLine}</div>
                        ${proposer ? `<span class="author-tag">proposed by: ${proposer.username || 'Commander'}</span>` : ''}
                    </div>
                    <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; max-width:100px;">
                        ${window.renderReorderArrows(listKey, siblingList, g.id, 'moveGearDefinitionOrder')}
                        ${(currentUserRole === 'dm' && g.status === 'draft') ? `<button class="btn-deploy" onclick="window.approveGear('${g.id}')" style="width:auto; margin:0; padding:3px 6px; font-size:9px;">✓ APPROVE</button>` : ''}
                        ${editable ? `<button class="layer-edit" onclick="window.openEditGearModal('${g.id}')" style="padding:3px 6px; font-size:9px;">✎</button>` : ''}
                        ${editable ? `<button class="layer-del" onclick="window.deleteGearDefinition('${g.id}')" style="padding:3px 6px; font-size:9px;">✕</button>` : ''}
                    </div>
                </div>
            </div>`;
    };

    html = '';
    if (pending.length > 0) {
        html += `<h4 style="color:#ffaa00; font-size:11px; border-bottom:1px solid #ffaa00; padding-bottom:4px; margin-top:0;">Pending Review (${pending.length})</h4>`;
        pending.forEach(g => html += renderCard(g, 'gear_pending', pending));
    }
    html += `<h4 style="color:#00e5a3; font-size:11px; border-bottom:1px solid #3c4e36; padding-bottom:4px; margin-top:14px;">Approved Gear (${approved.length})</h4>`;
    if (approved.length === 0) html += '<span style="font-size:10px; color:#6b826a;">None approved yet.</span>';
    approved.forEach(g => html += renderCard(g, 'gear_approved', approved));

    container.innerHTML = html;

    const badge = document.getElementById('badge-geardesigner');
    if (badge) badge.innerText = pending.length > 0 ? `${pending.length} pending` : approved.length;
};

window.moveGearDefinitionOrder = function(id, direction) {
    const g = window.findGearDefinition(id);
    if (!g) return;
    const listKey = g.status === 'draft' ? 'gear_pending' : 'gear_approved';
    const siblingList = gearDefinitionsList.filter(x => x.status === g.status);
    window.moveListItem(listKey, window.applySavedOrder(listKey, siblingList), id, direction);
    window.renderGearDesignerPanel();
};

window.approveGear = async function(id) {
    if (currentUserRole !== 'dm') return;
    const g = window.findGearDefinition(id);
    if (!g) return;
    const { error } = await db.from('gear_definitions').update({ status: 'approved' }).eq('id', id);
    if (error) { alert("Failed to approve gear: " + error.message); return; }
    db.from('chat_logs').insert({ sender_id: null, content: `📋 [OVERSEER] Gear item "${g.name}" approved and added to the installable catalog.`, message_type: 'system' });
    if (typeof loadGearDefinitions === 'function') loadGearDefinitions();
};

window.deleteGearDefinition = async function(id) {
    const g = window.findGearDefinition(id);
    if (g && !canManageGear(g)) return;
    if (!(await window.showConfirmModal(`Permanently delete gear "${g ? g.name : ''}"? Any character carrying it keeps the loadout entry, but it loses its mechanical effects and shows as an unlinked/custom entry.`))) return;
    await db.from('gear_definitions').delete().eq('id', id);
    if (typeof loadGearDefinitions === 'function') loadGearDefinitions();
};

/* --- CREATE / EDIT GEAR MODAL (shared, with a repeatable effects sub-editor -- no slot checkboxes, unlike Augments) --- */
(function() {
    let overlay, currentId, workingEffects;

    function renderEffectsList() {
        const listEl = document.getElementById('gear-effects-list');
        if (!listEl) return;
        let html = '';
        if (workingEffects.length === 0) html = '<span style="font-size:9px; color:#6b826a;">No effects added — leave empty for a flavor-only gear item.</span>';
        workingEffects.forEach((e, idx) => {
            html += `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:4px 6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:3px;">
                <span style="font-size:10px; color:#d4c5a9;">${e.target === 'stat' ? '⚡' : '🔧'} ${e.name} ${e.bonus >= 0 ? '+' : ''}${e.bonus}</span>
                <button class="layer-del" onclick="window.removeGearEffectRow(${idx})" style="padding:1px 5px; font-size:8px;">✕</button>
            </div>`;
        });
        listEl.innerHTML = html;
    }

    window.removeGearEffectRow = function(idx) { workingEffects.splice(idx, 1); renderEffectsList(); };

    window.addGearEffectRow = function() {
        const targetType = document.getElementById('gear-eff-target').value;
        const name = document.getElementById('gear-eff-name').value;
        const bonus = parseInt(document.getElementById('gear-eff-bonus').value) || 0;
        if (!name || bonus === 0) { alert("Pick a stat/skill and a non-zero bonus (negative for a penalty)."); return; }
        workingEffects.push({ target: targetType, name, bonus });
        renderEffectsList();
    };

    function populateEffectNameOptions() {
        const targetType = document.getElementById('gear-eff-target').value;
        const nameSel = document.getElementById('gear-eff-name');
        const names = targetType === 'stat' ? window.PERK_STAT_NAMES : skillList;
        nameSel.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('');
    }

    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'gear-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:420px; max-width:94vw; max-height:88vh; overflow-y:auto; border-color:#c778dd;">
            <h4 style="color:#c778dd; margin-top:0;" id="gear-modal-title">Propose / Edit Gear</h4>
            <label for="gear-edit-name" style="font-size:9px; color:#6b826a;">Gear Name</label>
            <input type="text" id="gear-edit-name" style="border-color:#c778dd;">
            <label for="gear-edit-desc" style="font-size:9px; color:#6b826a;">Description</label>
            <textarea id="gear-edit-desc" rows="2" style="border-color:#c778dd;"></textarea>

            <label style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:8px;">
                <input type="checkbox" id="gear-edit-flavoronly" style="margin:0;"> Flavor Only (no automatic mechanical effect — cosmetic/narrative item)
            </label>

            <div id="gear-mechanical-section">
                <div style="display:flex; gap:6px; margin-top:6px;">
                    <div style="flex:1;"><label for="gear-edit-shieldbonus" style="font-size:9px; color:#00e1ff;">Shield Max Bonus:</label><input type="number" id="gear-edit-shieldbonus" value="0" style="border-color:#c778dd; text-align:center;"></div>
                    <div style="flex:1;"><label for="gear-edit-drbonus" style="font-size:9px; color:#c9962f;">DR Bonus:</label><input type="number" id="gear-edit-drbonus" value="0" style="border-color:#c778dd; text-align:center;"></div>
                    <div style="flex:1;"><label for="gear-edit-injurybonus" style="font-size:9px; color:#ff6b6b;">Injury Max Bonus:</label><input type="number" id="gear-edit-injurybonus" value="0" style="border-color:#c778dd; text-align:center;"></div>
                </div>

                <label style="font-size:9px; color:#6b826a; margin-top:6px; display:block;">Stat/Skill Effects (auto-applied to the roller):</label>
                <div id="gear-effects-list" style="margin-bottom:6px;"></div>
                <div style="background:#030403; padding:6px; border:1px solid #c778dd; border-radius:2px; display:flex; gap:4px; align-items:center;">
                    <select id="gear-eff-target" onchange="window.populateGearEffectNameOptionsPublic()" style="flex:1; margin:0; font-size:9px;">
                        <option value="skill">Skill</option>
                        <option value="stat">Stat</option>
                    </select>
                    <select id="gear-eff-name" style="flex:1.4; margin:0; font-size:9px;"></select>
                    <input type="number" id="gear-eff-bonus" placeholder="±N" style="flex:0.7; margin:0; font-size:9px; text-align:center;">
                    <button class="btn-reveal" onclick="window.addGearEffectRow()" style="width:auto; margin:0; padding:3px 8px; font-size:9px;">+</button>
                </div>
            </div>

            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="gear-edit-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="gear-edit-save-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#c778dd; color:#c778dd;">SAVE</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('gear-edit-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('gear-edit-flavoronly').addEventListener('change', (e) => {
            document.getElementById('gear-mechanical-section').style.display = e.target.checked ? 'none' : 'block';
        });
        window.populateGearEffectNameOptionsPublic = populateEffectNameOptions;
        populateEffectNameOptions();

        document.getElementById('gear-edit-save-btn').addEventListener('click', async () => {
            const name = document.getElementById('gear-edit-name').value.trim();
            if (!name) { alert("Enter a gear name."); return; }
            const flavorOnly = document.getElementById('gear-edit-flavoronly').checked;
            const payload = {
                name,
                description: document.getElementById('gear-edit-desc').value.trim(),
                flavor_only: flavorOnly,
                shield_max_bonus: flavorOnly ? 0 : (parseInt(document.getElementById('gear-edit-shieldbonus').value) || 0),
                dr_bonus: flavorOnly ? 0 : (parseInt(document.getElementById('gear-edit-drbonus').value) || 0),
                injury_max_bonus: flavorOnly ? 0 : (parseInt(document.getElementById('gear-edit-injurybonus').value) || 0),
                effects: flavorOnly ? [] : workingEffects
            };

            if (currentId) {
                const { error } = await db.from('gear_definitions').update(payload).eq('id', currentId);
                if (error) { alert("Failed to save gear: " + error.message); return; }
            } else {
                payload.created_by = currentUserId;
                // DM-authored gear goes straight in as approved; anyone
                // else's proposal starts as a draft pending DM review --
                // exact same rule as perk/augment proposals.
                payload.status = currentUserRole === 'dm' ? 'approved' : 'draft';
                const { error } = await db.from('gear_definitions').insert(payload);
                if (error) { alert("Failed to propose gear: " + error.message); return; }
            }
            overlay.style.display = 'none';
            if (typeof loadGearDefinitions === 'function') loadGearDefinitions();
        });
    }

    window.openNewGearModal = function() {
        ensureModal();
        currentId = null;
        workingEffects = [];
        document.getElementById('gear-modal-title').innerText = 'Propose New Gear';
        document.getElementById('gear-edit-name').value = '';
        document.getElementById('gear-edit-desc').value = '';
        document.getElementById('gear-edit-flavoronly').checked = false;
        document.getElementById('gear-mechanical-section').style.display = 'block';
        document.getElementById('gear-edit-shieldbonus').value = '0';
        document.getElementById('gear-edit-drbonus').value = '0';
        document.getElementById('gear-edit-injurybonus').value = '0';
        renderEffectsList();
        overlay.style.display = 'flex';
    };

    window.openEditGearModal = function(id) {
        const g = window.findGearDefinition(id);
        if (!g) return;
        ensureModal();
        currentId = id;
        workingEffects = JSON.parse(JSON.stringify(g.effects || []));
        document.getElementById('gear-modal-title').innerText = 'Edit Gear';
        document.getElementById('gear-edit-name').value = g.name || '';
        document.getElementById('gear-edit-desc').value = g.description || '';
        document.getElementById('gear-edit-flavoronly').checked = !!g.flavor_only;
        document.getElementById('gear-mechanical-section').style.display = g.flavor_only ? 'none' : 'block';
        document.getElementById('gear-edit-shieldbonus').value = g.shield_max_bonus || 0;
        document.getElementById('gear-edit-drbonus').value = g.dr_bonus || 0;
        document.getElementById('gear-edit-injurybonus').value = g.injury_max_bonus || 0;
        renderEffectsList();
        overlay.style.display = 'flex';
    };
})();
