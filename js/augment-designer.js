/* ==========================================================================
   js/augment-designer.js - AUGMENT DESIGNER & APPROVAL WORKFLOW
   Converts body augmentations from 7 plain free-text character columns
   (aug_head/aug_torso/aug_larm/aug_rarm/aug_lleg/aug_rleg/aug_internal --
   zero mechanical effect, just typed flavor) into a real DB-backed catalog,
   the exact same architectural shift Perk Designer made for perks: anyone
   can propose an augment (draft); only the DM can approve it into the
   installable pool, or edit/delete anything; a proposer can edit/delete
   their own drafts pre-approval only.

   Two things deliberately differ from Perk Designer, per confirmed design:
   (1) an augment definition is tagged to the body slot(s) it can actually
       be installed in (`slots`, a jsonb array of slot keys) -- a slot's
       install picker only offers definitions valid for that slot;
   (2) a slot can hold more than one installed augment at once (stacking,
       confirmed over "one per slot") -- so character-side data is a real
       join table (character_augments), not a single FK column per slot,
       same shape as character_perks.
   Installing/removing an augment on your own character stays self-service
   (no DM gate) -- this matches how the old free-text fields already worked
   (a player could type anything into their own dossier at any time); only
   the CATALOG (proposing/approving a definition) gets the perk-style
   approval gate. Flavor-only augments (zero mechanical effect) are a
   first-class option, same as flavor-only perks -- leave effects empty and
   check the box. A character_augments row with no augment_definition_id at
   all (pure notes, nothing catalogued) is also first-class -- this is how
   the pre-existing free-text values were migrated in, and stays available
   going forward for narrative-only detail nobody wants to formalize.
   ========================================================================== */

let augmentDefinitionsList = [];
window.AUGMENT_SLOT_KEYS = ['head', 'torso', 'l_arm', 'r_arm', 'l_leg', 'r_leg', 'internal'];
window.AUGMENT_SLOT_LABELS = { head: 'Head', torso: 'Torso', l_arm: 'Left Arm', r_arm: 'Right Arm', l_leg: 'Left Leg', r_leg: 'Right Leg', internal: 'Internal' };

async function loadAugmentDefinitions() {
    const { data } = await db.from('augment_definitions').select('*').order('created_at', { ascending: true });
    if (data) { augmentDefinitionsList = data; if (typeof window.renderAugmentDesignerPanel === 'function') window.renderAugmentDesignerPanel(); if (typeof window.renderAugmentSlots === 'function') window.renderAugmentSlots(); if (typeof window.updateShieldDisplay === 'function') window.updateShieldDisplay(); }
}

function canManageAugment(a) {
    return currentUserRole === 'dm' || (a.status === 'draft' && a.created_by === currentUserId);
}

window.findAugmentDefinition = function(id) {
    return augmentDefinitionsList.find(a => a.id === id);
};

window.getApprovedAugmentsForSlot = function(slot) {
    return augmentDefinitionsList.filter(a => a.status === 'approved' && (a.slots || []).includes(slot));
};

// Same lookup shape as window.getPerkBonusFor -- a character's installed
// augments (character_augments rows) resolved against the catalog and
// summed for a given stat/skill. A row with no augment_definition_id (pure
// notes) contributes nothing mechanically, same as a flavor-only perk.
window.getAugmentBonusFor = function(charAugmentsList, targetType, targetName) {
    let total = 0;
    let sources = [];
    (charAugmentsList || []).forEach(ca => {
        const def = window.findAugmentDefinition(ca.augment_definition_id);
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

window.renderAugmentDesignerPanel = function() {
    const container = document.getElementById('augment-designer-list-container');
    if (!container) return;

    // Search bar (QOL request, 2026-08-31): same pattern as perk-designer.js
    // and gear-designer.js -- filters by name/description, case-insensitive;
    // the badge below deliberately reads unfiltered totals so it doesn't
    // fluctuate while someone is mid-search.
    const searchEl = document.getElementById('augment-designer-search');
    const searchTerm = searchEl ? searchEl.value.trim().toLowerCase() : '';
    const sourceList = searchTerm
        ? augmentDefinitionsList.filter(a => (a.name || '').toLowerCase().includes(searchTerm) || (a.description || '').toLowerCase().includes(searchTerm))
        : augmentDefinitionsList;

    const pending = window.applySavedOrder('augments_pending', sourceList.filter(a => a.status === 'draft'));
    const approved = window.applySavedOrder('augments_approved', sourceList.filter(a => a.status === 'approved'));

    const renderCard = (a, listKey, siblingList) => {
        const editable = canManageAugment(a);
        const proposer = allProfiles.find(p => p.id === a.created_by);
        const slotTags = (a.slots || []).map(s => window.AUGMENT_SLOT_LABELS[s] || s).join(', ') || '<span style="color:#ff6b6b;">no slots tagged</span>';
        // Bug fix (bug hunt, this session): `> 0` hid a negative bonus (fully
        // legal -- the form has no min="0" on these, and getEffectiveShieldMax/
        // getEffectiveDR/getEffectiveInjuryMax apply it unconditionally
        // regardless of sign) behind "No effects configured," masking a real
        // mechanical penalty from the DM. Same fix applied identically to
        // perk-designer.js and gear-designer.js's cards.
        let effectsLine = a.flavor_only
            ? '<span style="color:#c778dd;">Flavor only — no automatic mechanical effect.</span>'
            : [
                a.shield_max_bonus ? `<span style="color:#00e1ff;">Shield Max ${a.shield_max_bonus >= 0 ? '+' : ''}${a.shield_max_bonus}</span>` : '',
                a.dr_bonus ? `<span style="color:#c9962f;">DR ${a.dr_bonus >= 0 ? '+' : ''}${a.dr_bonus}</span>` : '',
                a.injury_max_bonus ? `<span style="color:#ff6b6b;">Injury Max ${a.injury_max_bonus >= 0 ? '+' : ''}${a.injury_max_bonus}</span>` : '',
                (a.effects || []).map(e => `${e.name} ${e.bonus >= 0 ? '+' : ''}${e.bonus}`).join(', ')
              ].filter(Boolean).join(' · ') || '<span style="color:#6b826a;">No effects configured.</span>';
        return `
            <div class="note-card" style="border-left: 3px solid ${a.status === 'draft' ? '#ffaa00' : '#00e5a3'};">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:${a.status === 'draft' ? '#ffaa00' : '#00e5a3'}; font-size:12px;">${a.name}</strong>
                        <span style="font-size:9px; color:#6b826a;"> — ${slotTags} ${a.status === 'draft' ? '· PENDING REVIEW' : ''}</span>
                        <div style="font-size:10px; color:#d4c5a9; margin-top:2px;">${a.description || ''}</div>
                        <div style="font-size:9px; margin-top:4px;">${effectsLine}</div>
                        ${proposer ? `<span class="author-tag">proposed by: ${proposer.username || 'Commander'}</span>` : ''}
                    </div>
                    <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; max-width:100px;">
                        ${window.renderReorderArrows(listKey, siblingList, a.id, 'moveAugmentDefinitionOrder')}
                        ${(currentUserRole === 'dm' && a.status === 'draft') ? `<button class="btn-deploy" onclick="window.approveAugment('${a.id}')" style="width:auto; margin:0; padding:3px 6px; font-size:9px;">✓ APPROVE</button>` : ''}
                        ${editable ? `<button class="layer-edit" onclick="window.openEditAugmentModal('${a.id}')" style="padding:3px 6px; font-size:9px;">✎</button>` : ''}
                        ${editable ? `<button class="layer-del" onclick="window.deleteAugmentDefinition('${a.id}')" style="padding:3px 6px; font-size:9px;">✕</button>` : ''}
                    </div>
                </div>
            </div>`;
    };

    let html = '';
    if (augmentDefinitionsList.length === 0) {
        html = '<span style="font-size:10px; color:#6b826a;">No augments defined yet.</span>';
    } else if (searchTerm && pending.length === 0 && approved.length === 0) {
        html = `<span style="font-size:10px; color:#6b826a;">No augments match "${searchEl.value.trim()}".</span>`;
    } else {
        if (pending.length > 0) {
            html += `<h4 style="color:#ffaa00; font-size:11px; border-bottom:1px solid #ffaa00; padding-bottom:4px; margin-top:0;">Pending Review (${pending.length})</h4>`;
            pending.forEach(a => html += renderCard(a, 'augments_pending', pending));
        }
        html += `<h4 style="color:#00e5a3; font-size:11px; border-bottom:1px solid #3c4e36; padding-bottom:4px; margin-top:14px;">Approved Augments (${approved.length})</h4>`;
        if (approved.length === 0) html += '<span style="font-size:10px; color:#6b826a;">None approved yet.</span>';
        approved.forEach(a => html += renderCard(a, 'augments_approved', approved));
    }

    container.innerHTML = html;

    const totalPending = augmentDefinitionsList.filter(a => a.status === 'draft').length;
    const totalApproved = augmentDefinitionsList.filter(a => a.status === 'approved').length;
    const badge = document.getElementById('badge-augmentdesigner');
    if (badge) badge.innerText = totalPending > 0 ? `${totalPending} pending` : totalApproved;
};

window.moveAugmentDefinitionOrder = function(id, direction) {
    const a = window.findAugmentDefinition(id);
    if (!a) return;
    const listKey = a.status === 'draft' ? 'augments_pending' : 'augments_approved';
    const siblingList = augmentDefinitionsList.filter(x => x.status === a.status);
    window.moveListItem(listKey, window.applySavedOrder(listKey, siblingList), id, direction);
    window.renderAugmentDesignerPanel();
};

window.approveAugment = async function(id) {
    if (currentUserRole !== 'dm') return;
    const a = window.findAugmentDefinition(id);
    if (!a) return;
    const { error } = await db.from('augment_definitions').update({ status: 'approved' }).eq('id', id);
    if (error) { alert("Failed to approve augment: " + error.message); return; }
    db.from('chat_logs').insert({ sender_id: null, content: `📋 [OVERSEER] Augmentation "${a.name}" approved and added to the installable catalog.`, message_type: 'system' });
    if (typeof loadAugmentDefinitions === 'function') loadAugmentDefinitions();
};

window.deleteAugmentDefinition = async function(id) {
    const a = window.findAugmentDefinition(id);
    if (a && !canManageAugment(a)) return;
    if (!(await window.showConfirmModal(`Permanently delete augment "${a ? a.name : ''}"? Any character with it currently installed keeps the installation record, but it loses its mechanical effects and shows as an unlinked/custom entry.`))) return;
    await db.from('augment_definitions').delete().eq('id', id);
    if (typeof loadAugmentDefinitions === 'function') loadAugmentDefinitions();
};

/* --- CREATE / EDIT AUGMENT MODAL (shared, with a repeatable effects sub-editor + slot checkboxes) --- */
(function() {
    let overlay, currentId, workingEffects;

    function renderEffectsList() {
        const listEl = document.getElementById('aug-effects-list');
        if (!listEl) return;
        let html = '';
        if (workingEffects.length === 0) html = '<span style="font-size:9px; color:#6b826a;">No effects added — leave empty for a flavor-only augment.</span>';
        workingEffects.forEach((e, idx) => {
            html += `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:4px 6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:3px;">
                <span style="font-size:10px; color:#d4c5a9;">${e.target === 'stat' ? '⚡' : '🔧'} ${e.name} ${e.bonus >= 0 ? '+' : ''}${e.bonus}</span>
                <button class="layer-del" onclick="window.removeAugmentEffectRow(${idx})" style="padding:1px 5px; font-size:8px;">✕</button>
            </div>`;
        });
        listEl.innerHTML = html;
    }

    window.removeAugmentEffectRow = function(idx) { workingEffects.splice(idx, 1); renderEffectsList(); };

    window.addAugmentEffectRow = function() {
        const targetType = document.getElementById('aug-eff-target').value;
        const name = document.getElementById('aug-eff-name').value;
        const bonus = parseInt(document.getElementById('aug-eff-bonus').value) || 0;
        if (!name || bonus === 0) { alert("Pick a stat/skill and a non-zero bonus (negative for a penalty)."); return; }
        workingEffects.push({ target: targetType, name, bonus });
        renderEffectsList();
    };

    function populateEffectNameOptions() {
        const targetType = document.getElementById('aug-eff-target').value;
        const nameSel = document.getElementById('aug-eff-name');
        const names = targetType === 'stat' ? window.PERK_STAT_NAMES : skillList;
        nameSel.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('');
    }

    function slotCheckboxesHtml(checkedSlots) {
        return window.AUGMENT_SLOT_KEYS.map(s => `
            <label style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer;">
                <input type="checkbox" class="aug-slot-cb" value="${s}" ${checkedSlots.includes(s) ? 'checked' : ''} style="margin:0;"> ${window.AUGMENT_SLOT_LABELS[s]}
            </label>`).join('');
    }

    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'augment-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:420px; max-width:94vw; max-height:88vh; overflow-y:auto; border-color:#c778dd;">
            <h4 style="color:#c778dd; margin-top:0;" id="augment-modal-title">Propose / Edit Augment</h4>
            <label for="aug-edit-name" style="font-size:9px; color:#6b826a;">Augment Name</label>
            <input type="text" id="aug-edit-name" style="border-color:#c778dd;">
            <label for="aug-edit-desc" style="font-size:9px; color:#6b826a;">Description</label>
            <textarea id="aug-edit-desc" rows="2" style="border-color:#c778dd;"></textarea>

            <label style="font-size:9px; color:#6b826a; margin-top:6px; display:block;">Installable Slot(s):</label>
            <div style="display:flex; gap:4px; margin-bottom:2px;">
                <button type="button" onclick="window.selectAllAugmentSlots()" style="width:auto; margin:0; padding:2px 6px; font-size:8px;">ALL</button>
                <button type="button" onclick="window.selectNoAugmentSlots()" style="width:auto; margin:0; padding:2px 6px; font-size:8px;">NONE</button>
            </div>
            <div id="aug-slot-checkboxes" style="display:grid; grid-template-columns: 1fr 1fr; gap:4px; background:#030403; padding:6px; border:1px solid #3c4e36; border-radius:2px;"></div>

            <label style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:8px;">
                <input type="checkbox" id="aug-edit-flavoronly" style="margin:0;"> Flavor Only (no automatic mechanical effect — cosmetic/narrative augment)
            </label>

            <div id="aug-mechanical-section">
                <div style="display:flex; gap:6px; margin-top:6px;">
                    <div style="flex:1;"><label for="aug-edit-shieldbonus" style="font-size:9px; color:#00e1ff;">Shield Max Bonus:</label><input type="number" id="aug-edit-shieldbonus" value="0" style="border-color:#c778dd; text-align:center;"></div>
                    <div style="flex:1;"><label for="aug-edit-drbonus" style="font-size:9px; color:#c9962f;">DR Bonus:</label><input type="number" id="aug-edit-drbonus" value="0" style="border-color:#c778dd; text-align:center;"></div>
                    <div style="flex:1;"><label for="aug-edit-injurybonus" style="font-size:9px; color:#ff6b6b;">Injury Max Bonus:</label><input type="number" id="aug-edit-injurybonus" value="0" style="border-color:#c778dd; text-align:center;"></div>
                </div>

                <label style="font-size:9px; color:#6b826a; margin-top:6px; display:block;">Stat/Skill Effects (auto-applied to the roller):</label>
                <div id="aug-effects-list" style="margin-bottom:6px;"></div>
                <div style="background:#030403; padding:6px; border:1px solid #c778dd; border-radius:2px; display:flex; gap:4px; align-items:center;">
                    <select id="aug-eff-target" onchange="window.populateAugmentEffectNameOptionsPublic()" style="flex:1; margin:0; font-size:9px;">
                        <option value="skill">Skill</option>
                        <option value="stat">Stat</option>
                    </select>
                    <select id="aug-eff-name" style="flex:1.4; margin:0; font-size:9px;"></select>
                    <input type="number" id="aug-eff-bonus" placeholder="±N" style="flex:0.7; margin:0; font-size:9px; text-align:center;">
                    <button class="btn-reveal" onclick="window.addAugmentEffectRow()" style="width:auto; margin:0; padding:3px 8px; font-size:9px;">+</button>
                </div>
            </div>

            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="aug-edit-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="aug-edit-save-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#c778dd; color:#c778dd;">SAVE</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('aug-edit-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('aug-edit-flavoronly').addEventListener('change', (e) => {
            document.getElementById('aug-mechanical-section').style.display = e.target.checked ? 'none' : 'block';
        });
        window.populateAugmentEffectNameOptionsPublic = populateEffectNameOptions;
        window.selectAllAugmentSlots = function() { document.querySelectorAll('.aug-slot-cb').forEach(cb => cb.checked = true); };
        window.selectNoAugmentSlots = function() { document.querySelectorAll('.aug-slot-cb').forEach(cb => cb.checked = false); };
        populateEffectNameOptions();

        document.getElementById('aug-edit-save-btn').addEventListener('click', async () => {
            const name = document.getElementById('aug-edit-name').value.trim();
            if (!name) { alert("Enter an augment name."); return; }
            const flavorOnly = document.getElementById('aug-edit-flavoronly').checked;
            const slots = Array.from(document.querySelectorAll('.aug-slot-cb:checked')).map(cb => cb.value);
            if (slots.length === 0) { alert("Tag at least one installable slot (or click ALL for a universal augment)."); return; }
            const payload = {
                name,
                description: document.getElementById('aug-edit-desc').value.trim(),
                slots,
                flavor_only: flavorOnly,
                shield_max_bonus: flavorOnly ? 0 : (parseInt(document.getElementById('aug-edit-shieldbonus').value) || 0),
                dr_bonus: flavorOnly ? 0 : (parseInt(document.getElementById('aug-edit-drbonus').value) || 0),
                injury_max_bonus: flavorOnly ? 0 : (parseInt(document.getElementById('aug-edit-injurybonus').value) || 0),
                effects: flavorOnly ? [] : workingEffects
            };

            if (currentId) {
                const { error } = await db.from('augment_definitions').update(payload).eq('id', currentId);
                if (error) { alert("Failed to save augment: " + error.message); return; }
            } else {
                payload.created_by = currentUserId;
                // DM-authored augments go straight in as approved; anyone
                // else's proposal starts as a draft pending DM review --
                // exact same rule as perk proposals.
                payload.status = currentUserRole === 'dm' ? 'approved' : 'draft';
                const { error } = await db.from('augment_definitions').insert(payload);
                if (error) { alert("Failed to propose augment: " + error.message); return; }
            }
            overlay.style.display = 'none';
            if (typeof loadAugmentDefinitions === 'function') loadAugmentDefinitions();
        });
    }

    window.openNewAugmentModal = function() {
        ensureModal();
        currentId = null;
        workingEffects = [];
        document.getElementById('augment-modal-title').innerText = 'Propose New Augment';
        document.getElementById('aug-edit-name').value = '';
        document.getElementById('aug-edit-desc').value = '';
        document.getElementById('aug-slot-checkboxes').innerHTML = slotCheckboxesHtml([]);
        document.getElementById('aug-edit-flavoronly').checked = false;
        document.getElementById('aug-mechanical-section').style.display = 'block';
        document.getElementById('aug-edit-shieldbonus').value = '0';
        document.getElementById('aug-edit-drbonus').value = '0';
        document.getElementById('aug-edit-injurybonus').value = '0';
        renderEffectsList();
        overlay.style.display = 'flex';
    };

    window.openEditAugmentModal = function(id) {
        const a = window.findAugmentDefinition(id);
        if (!a) return;
        ensureModal();
        currentId = id;
        workingEffects = JSON.parse(JSON.stringify(a.effects || []));
        document.getElementById('augment-modal-title').innerText = 'Edit Augment';
        document.getElementById('aug-edit-name').value = a.name || '';
        document.getElementById('aug-edit-desc').value = a.description || '';
        document.getElementById('aug-slot-checkboxes').innerHTML = slotCheckboxesHtml(a.slots || []);
        document.getElementById('aug-edit-flavoronly').checked = !!a.flavor_only;
        document.getElementById('aug-mechanical-section').style.display = a.flavor_only ? 'none' : 'block';
        document.getElementById('aug-edit-shieldbonus').value = a.shield_max_bonus || 0;
        document.getElementById('aug-edit-drbonus').value = a.dr_bonus || 0;
        document.getElementById('aug-edit-injurybonus').value = a.injury_max_bonus || 0;
        renderEffectsList();
        overlay.style.display = 'flex';
    };
})();
