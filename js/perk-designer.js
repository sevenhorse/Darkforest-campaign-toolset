/* ==========================================================================
   js/perk-designer.js - PERK DESIGNER & APPROVAL WORKFLOW
   Converts perks from a hardcoded JS catalog (window.PERKS_DATA, seeded into
   this table once — see migration notes) into a real DB-backed catalog,
   same architectural shift Ship Designer made from "fixed presets" to
   "anyone can design and save one." Anyone can propose a perk (draft);
   only the DM can approve it into the assignable pool, or edit/delete
   anything. A player can edit/delete their own drafts pre-approval only.
   Flavor-only perks (zero mechanical effect — narrative-only rewards like
   "you can now do a limited magic thing") are a first-class option here,
   not a special case: just leave the effects list empty and check the box.
   ========================================================================== */

let perkDefinitionsList = [];
window.PERK_STAT_NAMES = ['Charisma', 'Dexterity', 'Intelligence', 'Strength', 'Toughness', 'Willpower'];

async function loadPerkDefinitions() {
    const { data } = await db.from('perk_definitions').select('*').order('created_at', { ascending: true });
    if (data) { perkDefinitionsList = data; if (typeof window.renderPerkDesignerPanel === 'function') window.renderPerkDesignerPanel(); if (typeof window.renderPerksPanel === 'function') window.renderPerksPanel(); if (typeof window.updateShieldDisplay === 'function') window.updateShieldDisplay(); }
}

function canManagePerk(p) {
    return currentUserRole === 'dm' || (p.status === 'draft' && p.created_by === currentUserId);
}

window.getApprovedPerksBySection = function(section) {
    return perkDefinitionsList.filter(p => p.status === 'approved' && p.section === section);
};

window.findPerkDefinition = function(id) {
    return perkDefinitionsList.find(p => p.id === id);
};

// The roller's actual lookup — unchanged shape from Phase 1, just now reads
// from the DB-loaded catalog instead of window.PERKS_DATA, via a character's
// assigned perk_definition_id rather than a hardcoded key string.
window.getPerkBonusFor = function(charPerksList, targetType, targetName) {
    let total = 0;
    let sources = [];
    (charPerksList || []).forEach(cp => {
        const def = window.findPerkDefinition(cp.perk_definition_id);
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

window.renderPerkDesignerPanel = function() {
    const container = document.getElementById('perk-designer-list-container');
    if (!container) return;

    // Search bar (QOL request, 2026-08-31): filters the SAME list that feeds
    // the pending/approved split below, by name or description, case-
    // insensitive. The pending/approved-count badge deliberately reads from
    // the unfiltered perkDefinitionsList further down instead of these
    // filtered arrays, so it doesn't fluctuate while someone is mid-search.
    const searchEl = document.getElementById('perk-designer-search');
    const searchTerm = searchEl ? searchEl.value.trim().toLowerCase() : '';
    const sourceList = searchTerm
        ? perkDefinitionsList.filter(p => (p.name || '').toLowerCase().includes(searchTerm) || (p.description || '').toLowerCase().includes(searchTerm))
        : perkDefinitionsList;

    const pending = window.applySavedOrder('perks_pending', sourceList.filter(p => p.status === 'draft'));
    const approved = window.applySavedOrder('perks_approved', sourceList.filter(p => p.status === 'approved'));

    const renderCard = (p, listKey, siblingList) => {
        const editable = canManagePerk(p);
        const proposer = allProfiles.find(a => a.id === p.created_by);
        // Bug fix (bug hunt, this session): these three used `> 0` to decide
        // whether to show the bonus at all, so a negative shield/DR/injury
        // bonus (fully accepted by the form -- none of the three number
        // inputs have min="0", and getEffectiveShieldMax/getEffectiveDR/
        // getEffectiveInjuryMax apply it unconditionally either way)
        // silently rendered as "No effects configured," hiding a real
        // mechanical penalty from the DM reviewing/approving it. Gate on
        // `!== 0` and format the sign, same as the stat/skill effects line
        // right below already does.
        let effectsLine = p.flavor_only
            ? '<span style="color:#c778dd;">Flavor only — no automatic mechanical effect.</span>'
            : [
                p.points_grant > 0 ? `<span style="color:#00e5a3;">+${p.points_grant} free skill points</span>` : '',
                p.shield_max_bonus ? `<span style="color:#00e1ff;">Shield Max ${p.shield_max_bonus >= 0 ? '+' : ''}${p.shield_max_bonus}</span>` : '',
                p.dr_bonus ? `<span style="color:#c9962f;">DR ${p.dr_bonus >= 0 ? '+' : ''}${p.dr_bonus}</span>` : '',
                p.injury_max_bonus ? `<span style="color:#ff6b6b;">Injury Max ${p.injury_max_bonus >= 0 ? '+' : ''}${p.injury_max_bonus}</span>` : '',
                (p.effects || []).map(e => `${e.name} ${e.bonus >= 0 ? '+' : ''}${e.bonus}`).join(', ')
              ].filter(Boolean).join(' · ') || '<span style="color:#6b826a;">No effects configured.</span>';
        return `
            <div class="note-card" style="border-left: 3px solid ${p.status === 'draft' ? '#ffaa00' : '#00e5a3'};">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:${p.status === 'draft' ? '#ffaa00' : '#00e5a3'}; font-size:12px;">${p.name}</strong>
                        <span style="font-size:9px; color:#6b826a;"> — Section ${p.section} ${p.status === 'draft' ? '· PENDING REVIEW' : ''}</span>
                        <div style="font-size:10px; color:#d4c5a9; margin-top:2px;">${p.description || ''}</div>
                        <div style="font-size:9px; margin-top:4px;">${effectsLine}</div>
                        ${proposer ? `<span class="author-tag">proposed by: ${proposer.username || 'Commander'}</span>` : ''}
                    </div>
                    <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; max-width:100px;">
                        ${window.renderReorderArrows(listKey, siblingList, p.id, 'movePerkDefinitionOrder')}
                        ${(currentUserRole === 'dm' && p.status === 'draft') ? `<button class="btn-deploy" onclick="window.approvePerk('${p.id}')" style="width:auto; margin:0; padding:3px 6px; font-size:9px;">✓ APPROVE</button>` : ''}
                        ${editable ? `<button class="layer-edit" onclick="window.openEditPerkModal('${p.id}')" style="padding:3px 6px; font-size:9px;">✎</button>` : ''}
                        ${editable ? `<button class="layer-del" onclick="window.deletePerkDefinition('${p.id}')" style="padding:3px 6px; font-size:9px;">✕</button>` : ''}
                    </div>
                </div>
            </div>`;
    };

    let html = '';
    if (perkDefinitionsList.length === 0) {
        html = '<span style="font-size:10px; color:#6b826a;">No perks defined yet.</span>';
    } else if (searchTerm && pending.length === 0 && approved.length === 0) {
        html = `<span style="font-size:10px; color:#6b826a;">No perks match "${searchEl.value.trim()}".</span>`;
    } else {
        if (pending.length > 0) {
            html += `<h4 style="color:#ffaa00; font-size:11px; border-bottom:1px solid #ffaa00; padding-bottom:4px; margin-top:0;">Pending Review (${pending.length})</h4>`;
            pending.forEach(p => html += renderCard(p, 'perks_pending', pending));
        }
        html += `<h4 style="color:#00e5a3; font-size:11px; border-bottom:1px solid #3c4e36; padding-bottom:4px; margin-top:14px;">Approved Perks (${approved.length})</h4>`;
        if (approved.length === 0) html += '<span style="font-size:10px; color:#6b826a;">None approved yet.</span>';
        approved.forEach(p => html += renderCard(p, 'perks_approved', approved));
    }

    container.innerHTML = html;

    // Badge intentionally reads unfiltered totals (not pending/approved
    // above, which are search-narrowed) so it stays stable while searching.
    const totalPending = perkDefinitionsList.filter(p => p.status === 'draft').length;
    const totalApproved = perkDefinitionsList.filter(p => p.status === 'approved').length;
    const badge = document.getElementById('badge-perkdesigner');
    if (badge) badge.innerText = totalPending > 0 ? `${totalPending} pending` : totalApproved;
};
window.movePerkDefinitionOrder = function(id, direction) {
    const p = window.findPerkDefinition(id);
    if (!p) return;
    const listKey = p.status === 'draft' ? 'perks_pending' : 'perks_approved';
    const siblingList = perkDefinitionsList.filter(x => x.status === p.status);
    window.moveListItem(listKey, window.applySavedOrder(listKey, siblingList), id, direction);
    window.renderPerkDesignerPanel();
};

window.approvePerk = async function(id) {
    if (currentUserRole !== 'dm') return;
    const p = window.findPerkDefinition(id);
    if (!p) return;
    const { error } = await db.from('perk_definitions').update({ status: 'approved' }).eq('id', id);
    if (error) { alert("Failed to approve perk: " + error.message); return; }
    db.from('chat_logs').insert({ sender_id: null, content: `📋 [OVERSEER] Specialization "${p.name}" approved and added to the active roster.`, message_type: 'system' });
    if (typeof loadPerkDefinitions === 'function') loadPerkDefinitions();
};

window.deletePerkDefinition = async function(id) {
    const p = window.findPerkDefinition(id);
    if (p && !canManagePerk(p)) return;
    // Bug fix (bug hunt, this session): this warning claimed holders "lose"
    // the perk, but the deletion below only removes the catalog row -- it
    // never touches character_perks, so every character keeps a now-
    // dangling character_perks row instead (matching what actually happens
    // for augments/gear, whose own confirm text says so accurately).
    if (!(await window.showConfirmModal(`Permanently delete perk "${p ? p.name : ''}"? Any character currently holding it keeps the selection record, but it loses its mechanical effects and shows as an unlinked/custom entry.`))) return;
    await db.from('perk_definitions').delete().eq('id', id);
    if (typeof loadPerkDefinitions === 'function') loadPerkDefinitions();
};

/* --- CREATE / EDIT PERK MODAL (shared, with a repeatable effects sub-editor) --- */
(function() {
    let overlay, currentId, workingEffects;

    function renderEffectsList() {
        const listEl = document.getElementById('perk-effects-list');
        if (!listEl) return;
        let html = '';
        if (workingEffects.length === 0) html = '<span style="font-size:9px; color:#6b826a;">No effects added — leave empty for a flavor-only perk.</span>';
        workingEffects.forEach((e, idx) => {
            html += `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:4px 6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:3px;">
                <span style="font-size:10px; color:#d4c5a9;">${e.target === 'stat' ? '⚡' : '🔧'} ${e.name} ${e.bonus >= 0 ? '+' : ''}${e.bonus}</span>
                <button class="layer-del" onclick="window.removePerkEffectRow(${idx})" style="padding:1px 5px; font-size:8px;">✕</button>
            </div>`;
        });
        listEl.innerHTML = html;
    }

    window.removePerkEffectRow = function(idx) { workingEffects.splice(idx, 1); renderEffectsList(); };

    window.addPerkEffectRow = function() {
        const targetType = document.getElementById('perk-eff-target').value;
        const name = document.getElementById('perk-eff-name').value;
        const bonus = parseInt(document.getElementById('perk-eff-bonus').value) || 0;
        if (!name || bonus === 0) { alert("Pick a stat/skill and a non-zero bonus (negative for a penalty)."); return; }
        workingEffects.push({ target: targetType, name, bonus });
        renderEffectsList();
    };

    function populateEffectNameOptions() {
        const targetType = document.getElementById('perk-eff-target').value;
        const nameSel = document.getElementById('perk-eff-name');
        const names = targetType === 'stat' ? window.PERK_STAT_NAMES : skillList;
        nameSel.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('');
    }

    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'perk-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:420px; max-width:94vw; max-height:88vh; overflow-y:auto; border-color:#c778dd;">
            <h4 style="color:#c778dd; margin-top:0;" id="perk-modal-title">Propose / Edit Perk</h4>
            <label for="perk-edit-name" style="font-size:9px; color:#6b826a;">Perk Name</label>
            <input type="text" id="perk-edit-name" style="border-color:#c778dd;">
            <label for="perk-edit-desc" style="font-size:9px; color:#6b826a;">Description</label>
            <textarea id="perk-edit-desc" rows="2" style="border-color:#c778dd;"></textarea>
            <label for="perk-edit-section" style="font-size:9px; color:#6b826a;">Section</label>
            <select id="perk-edit-section" style="border-color:#c778dd;">
                <option value="1">Section 1 — Character Creation Pick</option>
                <option value="2">Section 2 — DM-Awarded In-Play</option>
            </select>

            <label style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:8px;">
                <input type="checkbox" id="perk-edit-flavoronly" style="margin:0;"> Flavor Only (no automatic mechanical effect — e.g. narrative/magic-style rewards)
            </label>

            <div id="perk-mechanical-section">
                <label for="perk-edit-points" style="font-size:9px; color:#6b826a; margin-top:6px; display:block;">Free Skill Points Granted (e.g. Passive Boost — leave 0 if not a points-grant perk):</label>
                <input type="number" id="perk-edit-points" min="0" value="0" style="border-color:#c778dd;">

                <div style="display:flex; gap:6px; margin-top:6px;">
                    <div style="flex:1;"><label for="perk-edit-shieldbonus" style="font-size:9px; color:#00e1ff;">Shield Max Bonus:</label><input type="number" id="perk-edit-shieldbonus" value="0" style="border-color:#c778dd; text-align:center;"></div>
                    <div style="flex:1;"><label for="perk-edit-drbonus" style="font-size:9px; color:#c9962f;">DR Bonus:</label><input type="number" id="perk-edit-drbonus" value="0" style="border-color:#c778dd; text-align:center;"></div>
                    <div style="flex:1;"><label for="perk-edit-injurybonus" style="font-size:9px; color:#ff6b6b;">Injury Max Bonus:</label><input type="number" id="perk-edit-injurybonus" value="0" style="border-color:#c778dd; text-align:center;"></div>
                </div>

                <label style="font-size:9px; color:#6b826a; margin-top:6px; display:block;">Stat/Skill Effects (auto-applied to the roller):</label>
                <div id="perk-effects-list" style="margin-bottom:6px;"></div>
                <div style="background:#030403; padding:6px; border:1px solid #c778dd; border-radius:2px; display:flex; gap:4px; align-items:center;">
                    <select id="perk-eff-target" onchange="window.populateEffectNameOptionsPublic()" style="flex:1; margin:0; font-size:9px;">
                        <option value="skill">Skill</option>
                        <option value="stat">Stat</option>
                    </select>
                    <select id="perk-eff-name" style="flex:1.4; margin:0; font-size:9px;"></select>
                    <input type="number" id="perk-eff-bonus" placeholder="±N" style="flex:0.7; margin:0; font-size:9px; text-align:center;">
                    <button class="btn-reveal" onclick="window.addPerkEffectRow()" style="width:auto; margin:0; padding:3px 8px; font-size:9px;">+</button>
                </div>
            </div>

            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="perk-edit-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="perk-edit-save-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#c778dd; color:#c778dd;">SAVE</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('perk-edit-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('perk-edit-flavoronly').addEventListener('change', (e) => {
            document.getElementById('perk-mechanical-section').style.display = e.target.checked ? 'none' : 'block';
        });
        window.populateEffectNameOptionsPublic = populateEffectNameOptions;
        populateEffectNameOptions();

        document.getElementById('perk-edit-save-btn').addEventListener('click', async () => {
            const name = document.getElementById('perk-edit-name').value.trim();
            if (!name) { alert("Enter a perk name."); return; }
            const flavorOnly = document.getElementById('perk-edit-flavoronly').checked;
            const payload = {
                name,
                description: document.getElementById('perk-edit-desc').value.trim(),
                section: parseInt(document.getElementById('perk-edit-section').value) || 1,
                flavor_only: flavorOnly,
                points_grant: flavorOnly ? 0 : (parseInt(document.getElementById('perk-edit-points').value) || 0),
                shield_max_bonus: flavorOnly ? 0 : (parseInt(document.getElementById('perk-edit-shieldbonus').value) || 0),
                dr_bonus: flavorOnly ? 0 : (parseInt(document.getElementById('perk-edit-drbonus').value) || 0),
                injury_max_bonus: flavorOnly ? 0 : (parseInt(document.getElementById('perk-edit-injurybonus').value) || 0),
                effects: flavorOnly ? [] : workingEffects
            };

            if (currentId) {
                const { error } = await db.from('perk_definitions').update(payload).eq('id', currentId);
                if (error) { alert("Failed to save perk: " + error.message); return; }
            } else {
                payload.created_by = currentUserId;
                // DM-authored perks go straight in as approved; anyone else's
                // proposal starts as a draft pending DM review.
                payload.status = currentUserRole === 'dm' ? 'approved' : 'draft';
                const { error } = await db.from('perk_definitions').insert(payload);
                if (error) { alert("Failed to propose perk: " + error.message); return; }
            }
            overlay.style.display = 'none';
            if (typeof loadPerkDefinitions === 'function') loadPerkDefinitions();
        });
    }

    window.openNewPerkModal = function() {
        ensureModal();
        currentId = null;
        workingEffects = [];
        document.getElementById('perk-modal-title').innerText = 'Propose New Perk';
        document.getElementById('perk-edit-name').value = '';
        document.getElementById('perk-edit-desc').value = '';
        document.getElementById('perk-edit-section').value = '1';
        document.getElementById('perk-edit-flavoronly').checked = false;
        document.getElementById('perk-mechanical-section').style.display = 'block';
        document.getElementById('perk-edit-points').value = '0';
        document.getElementById('perk-edit-shieldbonus').value = '0';
        document.getElementById('perk-edit-drbonus').value = '0';
        document.getElementById('perk-edit-injurybonus').value = '0';
        renderEffectsList();
        overlay.style.display = 'flex';
    };

    window.openEditPerkModal = function(id) {
        const p = window.findPerkDefinition(id);
        if (!p) return;
        ensureModal();
        currentId = id;
        workingEffects = JSON.parse(JSON.stringify(p.effects || []));
        document.getElementById('perk-modal-title').innerText = 'Edit Perk';
        document.getElementById('perk-edit-name').value = p.name || '';
        document.getElementById('perk-edit-desc').value = p.description || '';
        document.getElementById('perk-edit-section').value = p.section || 1;
        document.getElementById('perk-edit-flavoronly').checked = !!p.flavor_only;
        document.getElementById('perk-mechanical-section').style.display = p.flavor_only ? 'none' : 'block';
        document.getElementById('perk-edit-points').value = p.points_grant || 0;
        document.getElementById('perk-edit-shieldbonus').value = p.shield_max_bonus || 0;
        document.getElementById('perk-edit-drbonus').value = p.dr_bonus || 0;
        document.getElementById('perk-edit-injurybonus').value = p.injury_max_bonus || 0;
        renderEffectsList();
        overlay.style.display = 'flex';
    };
})();
