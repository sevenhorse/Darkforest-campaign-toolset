/* ==========================================================================
   js/dm-sheet-editor.js - DM CHARACTER SHEET EDITOR (via Crew Roster)
   Full-parity DM edit access to any player's character sheet, opened from
   a new "EDIT SHEET" button on each Crew Roster card. Confirmed design
   (two AskUserQuestion rounds): (1) full parity with everything a player
   can edit on their own Dossier & Stats tab -- name, all 6 stat dice, all
   12 skills, the 3 narrative text fields, arsenal weapons, and the ability
   to install/remove that character's perks, augments, and gear -- not just
   the handful of numeric overrides the roster card already had; (2) a
   dedicated modal, built as its OWN implementation rather than reusing the
   self-service Dossier tab's rendering functions (which are hardcoded to
   `currentUserId`/`myProf`) -- safer than refactoring those to accept an
   arbitrary target profile, at the cost of some duplication with
   perk-designer.js/augment-designer.js/gear-designer.js/ui.js/combat.js's
   own self-service equivalents.

   Deliberately OUT of scope (not asked, not built): creating a brand-new
   character for a profile that hasn't saved one yet (this edits an
   EXISTING character row only -- opening the modal for a profile with no
   saved character alerts and refuses, same guard style as
   installAugment/awardSection2Perk); rolling/attacking with a weapon from
   this view (arsenal here is add/edit/remove only, not the dice roller);
   and the pre-existing roster quick-override card (Injuries/Stress/
   Adversity/Shield/DR/misc-inventory text + Award Perk) is left exactly as
   it was, for fast combat-speed tweaks -- this modal is the complete-sheet
   view, not a replacement for that shortcut. Both write to the same
   underlying columns, same as the player's own tab and the quick override
   already both writing to `vitality`/`stress`/etc. today.

   Every sub-list here (Perks/Augments/Gear/Arsenal) saves immediately on
   each action, same as the self-service versions -- only the top "core
   sheet" fields (name/stats/skills/vitals/narrative) batch into one SAVE
   button, mirroring saveTerminalProfile's shape.
   ========================================================================== */

(function() {
    let overlay, targetProfileId, editingArsenalId;

    function targetProf() { return allProfiles.find(p => p.id === targetProfileId); }

    function statSelectHtml(id, current) {
        const dice = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'];
        return `<select id="${id}" class="stat-die-select">${dice.map(d => `<option value="${d}" ${current === d ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
    }

    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'dmse-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.9); z-index:5500; align-items:flex-start; justify-content:center; overflow-y:auto; padding:30px 0;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:520px; max-width:94vw; border-color:#ff6b6b;">
            <h4 style="color:#ff6b6b; margin-top:0;">Edit Character Sheet — <span id="dmse-username"></span></h4>

            <label for="dmse-name" style="font-size:9px; color:#6b826a;">Character Name</label>
            <input type="text" id="dmse-name" style="border-color:#ff6b6b;">

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:6px;">
                <div><label style="font-size:9px; color:#6b826a;">Charisma:</label><div id="dmse-stat-charisma-wrap"></div></div>
                <div><label style="font-size:9px; color:#6b826a;">Dexterity:</label><div id="dmse-stat-dexterity-wrap"></div></div>
                <div><label style="font-size:9px; color:#6b826a;">Intelligence:</label><div id="dmse-stat-intelligence-wrap"></div></div>
                <div><label style="font-size:9px; color:#6b826a;">Strength:</label><div id="dmse-stat-strength-wrap"></div></div>
                <div><label style="font-size:9px; color:#6b826a;">Toughness:</label><div id="dmse-stat-toughness-wrap"></div></div>
                <div><label style="font-size:9px; color:#6b826a;">Willpower:</label><div id="dmse-stat-willpower-wrap"></div></div>
            </div>

            <div style="display:flex; gap:8px; margin-top:8px;">
                <div style="flex:1;"><label style="font-size:9px; color:#ff6b6b;">Injuries</label><input type="number" id="dmse-vit" value="0"></div>
                <div style="flex:1;"><label style="font-size:9px; color:#ffaa00;">Stress</label><input type="number" id="dmse-stress" value="0"></div>
                <div style="flex:1;"><label style="font-size:9px; color:#00e5a3;">Adversity</label><input type="number" id="dmse-adv" value="0"></div>
            </div>
            <div style="display:flex; gap:8px; margin-top:6px;">
                <div style="flex:1;"><label style="font-size:9px; color:#00e1ff;">Shield Cur</label><input type="number" id="dmse-shieldcur" value="0"></div>
                <div style="flex:1;"><label style="font-size:9px; color:#00e1ff;">Shield Max</label><input type="number" id="dmse-shieldmax" value="0"></div>
                <div style="flex:1;"><label style="font-size:9px; color:#c9962f;">DR</label><input type="number" id="dmse-dr" value="0"></div>
            </div>

            <label style="font-size:9px; color:#6b826a; margin-top:8px; display:block;">Skill Proficiencies</label>
            <div id="dmse-skills-grid" style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px;"></div>

            <label for="dmse-specialties" style="font-size:9px; color:#6b826a; margin-top:8px; display:block;">Additional Specialties</label>
            <textarea id="dmse-specialties" rows="2"></textarea>
            <label for="dmse-history" style="font-size:9px; color:#6b826a; margin-top:4px; display:block;">Credits, Real Estate & Liquid Assets</label>
            <textarea id="dmse-history" rows="2"></textarea>
            <label for="dmse-personalhistory" style="font-size:9px; color:#6b826a; margin-top:4px; display:block;">Personal History</label>
            <textarea id="dmse-personalhistory" rows="2"></textarea>
            <label for="dmse-assets" style="font-size:9px; color:#6b826a; margin-top:4px; display:block;">Miscellaneous Inventory</label>
            <textarea id="dmse-assets" rows="2"></textarea>

            <button class="btn-reveal" id="dmse-save-core-btn" style="width:100%; margin-top:10px; border-color:#ff6b6b; color:#ff6b6b;">SAVE SHEET</button>

            <div style="border-top:1px solid #3c4e36; margin-top:14px; padding-top:8px;">
                <label style="font-size:9px; color:#6b826a; display:block; margin-bottom:4px;">Perks</label>
                <div id="dmse-perks-list" style="margin-bottom:6px;"></div>
                <!-- Multi-select (QOL request, 2026-08-31): was a single <select> +
                     AWARD button. Now a scrollable checklist + one batch button --
                     see renderPerksList/awardPerk below for the populate/insert side. -->
                <div id="dmse-award-perk-list" style="max-height:100px; overflow-y:auto; border:1px solid #3c4e36; border-radius:2px; padding:4px 6px; background:#030403; margin-bottom:4px;"></div>
                <button class="btn-deploy" id="dmse-award-perk-btn" style="width:100%; margin:0; padding:4px 8px; font-size:9px;">AWARD SELECTED</button>
            </div>

            <div style="border-top:1px solid #3c4e36; margin-top:14px; padding-top:8px;">
                <label style="font-size:9px; color:#6b826a; display:block; margin-bottom:4px;">Body Augmentations</label>
                <div id="dmse-augments-list"></div>
            </div>

            <div style="border-top:1px solid #3c4e36; margin-top:14px; padding-top:8px;">
                <label style="font-size:9px; color:#6b826a; display:block; margin-bottom:4px;">Gear Loadout</label>
                <div id="dmse-gear-list" style="margin-bottom:6px;"></div>
                <div style="display:flex; gap:4px;">
                    <label for="dmse-gear-picker" style="display:none;">Add Gear</label>
                    <select id="dmse-gear-picker" style="flex:1; margin:0; font-size:10px;"></select>
                </div>
                <div style="display:flex; gap:4px; margin-top:3px;">
                    <label for="dmse-gear-notes" style="display:none;">Notes</label>
                    <input type="text" id="dmse-gear-notes" placeholder="Notes (optional flavor)" style="flex:1; margin:0; font-size:10px;">
                    <button class="btn-deploy" id="dmse-gear-add-btn" style="width:auto; margin:0; padding:4px 8px; font-size:9px;">+ ADD</button>
                </div>
            </div>

            <div style="border-top:1px solid #3c4e36; margin-top:14px; padding-top:8px;">
                <label style="font-size:9px; color:#6b826a; display:block; margin-bottom:4px;">Arsenal (Weapons / Powers)</label>
                <div id="dmse-arsenal-list" style="margin-bottom:6px;"></div>
                <input type="text" id="dmse-arsenal-name" placeholder="Name" style="margin-bottom:4px;">
                <div style="display:flex; gap:6px;">
                    <input type="text" id="dmse-arsenal-dice" placeholder="Dice (e.g. 1d10)" style="flex:1; margin:0; text-align:center;">
                    <input type="text" id="dmse-arsenal-mod" placeholder="Mod (e.g. +2)" style="flex:1; margin:0; text-align:center;">
                </div>
                <div style="display:flex; gap:6px; margin-top:4px;">
                    <input type="number" id="dmse-arsenal-ammo" min="0" placeholder="Ammo (blank=∞)" style="flex:1; margin:0; text-align:center;">
                    <input type="number" id="dmse-arsenal-maxammo" min="0" placeholder="Max Ammo" style="flex:1; margin:0; text-align:center;">
                </div>
                <select id="dmse-arsenal-dmgtype" style="margin-top:4px;"><option value="">No Damage Type</option></select>
                <label style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:4px;">
                    <input type="checkbox" id="dmse-arsenal-explodes" style="margin:0;"> Exploding Dice
                </label>
                <div style="display:flex; gap:6px; margin-top:6px;">
                    <button id="dmse-arsenal-cancel-btn" style="flex:1; margin-top:0; display:none;">CANCEL EDIT</button>
                    <button class="btn-deploy" id="dmse-arsenal-save-btn" style="flex:1; margin-top:0;">+ ADD WEAPON</button>
                </div>
            </div>

            <button id="dmse-close-btn" style="width:100%; margin-top:16px;">CLOSE</button>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('dmse-arsenal-dmgtype').insertAdjacentHTML('beforeend', window.buildDamageTypeOptionsHtml(''));
        document.getElementById('dmse-close-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });

        document.getElementById('dmse-save-core-btn').addEventListener('click', saveCoreSheet);
        document.getElementById('dmse-award-perk-btn').addEventListener('click', awardPerk);
        document.getElementById('dmse-gear-add-btn').addEventListener('click', addGear);
        document.getElementById('dmse-arsenal-save-btn').addEventListener('click', saveArsenalItem);
        document.getElementById('dmse-arsenal-cancel-btn').addEventListener('click', resetArsenalForm);
    }

    async function saveCoreSheet() {
        const prof = targetProf();
        if (!prof || !prof.character || !prof.character.id) return;
        const getVal = id => document.getElementById(id).value;
        const charPayload = {
            name: getVal('dmse-name'),
            stat_charisma: getVal('dmse-stat-charisma'), stat_dexterity: getVal('dmse-stat-dexterity'), stat_intelligence: getVal('dmse-stat-intelligence'),
            stat_strength: getVal('dmse-stat-strength'), stat_toughness: getVal('dmse-stat-toughness'), stat_willpower: getVal('dmse-stat-willpower'),
            vitality: parseInt(getVal('dmse-vit')) || 0, stress: parseInt(getVal('dmse-stress')) || 0, adversity_tokens: parseInt(getVal('dmse-adv')) || 0,
            shield_current: parseInt(getVal('dmse-shieldcur')) || 0, shield_max: parseInt(getVal('dmse-shieldmax')) || 0, dr: parseInt(getVal('dmse-dr')) || 0,
            specialties: getVal('dmse-specialties'), history: getVal('dmse-history'), personal_history: getVal('dmse-personalhistory'), assets: getVal('dmse-assets')
            // Deliberately no aug_*/profile_id/id fields -- this UPDATEs an existing
            // character row by id only, same reasoning as saveTerminalProfile's own
            // aug_* omission (those 7 columns are dead schema, see the architecture
            // doc). Never creates a new character row -- see file header.
        };
        const { error } = await db.from('characters').update(charPayload).eq('id', prof.character.id);
        if (error) { alert("Failed to save sheet: " + error.message); return; }

        let skillsPayload = {};
        skillList.forEach(skill => { const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_'); skillsPayload[safeKey] = parseInt(getVal(`dmse-skill-${safeKey}`)) || 0; });
        await db.from('character_skills').update(skillsPayload).eq('character_id', prof.character.id);

        db.from('chat_logs').insert({ sender_id: null, content: `⚙️ [OVERSEER] ${prof.username || 'A commander'}'s character sheet was edited directly.`, message_type: 'system' });
        if (typeof window.showToast === 'function') window.showToast("Character sheet saved.");
        if (typeof window.loadAllProfiles === 'function') window.loadAllProfiles();
    }

    function renderPerksList() {
        const container = document.getElementById('dmse-perks-list');
        const prof = targetProf();
        if (!container || !prof) return;
        const perks = prof.perks || [];
        if (perks.length === 0) { container.innerHTML = '<span style="font-size:9px; color:#6b826a;">No perks held.</span>'; return; }
        container.innerHTML = perks.map(cp => {
            const def = typeof window.findPerkDefinition === 'function' ? window.findPerkDefinition(cp.perk_definition_id) : null;
            return `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:4px 6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:3px;">
                <span style="font-size:10px; color:#d4c5a9;">${def ? def.name : '(unlinked)'} <span style="color:#6b826a; font-size:8px;">Sec.${cp.section}</span></span>
                <button class="layer-del" onclick="window.dmRemoveCharacterPerk('${cp.id}', '${targetProfileId}')" style="padding:1px 5px; font-size:8px;">✕</button>
            </div>`;
        }).join('');

        const listEl = document.getElementById('dmse-award-perk-list');
        const approved = typeof window.getApprovedPerksBySection === 'function' ? window.getApprovedPerksBySection(2) : [];
        const heldIds = new Set(perks.map(cp => cp.perk_definition_id));
        const awardable = approved.filter(pk => !heldIds.has(pk.id));
        listEl.innerHTML = awardable.length === 0
            ? '<span style="font-size:9px; color:#6b826a;">No unheld approved perks.</span>'
            : awardable.map(pk => `<label style="display:flex; align-items:center; gap:4px; font-size:9px; color:#d4c5a9; padding:1px 0; cursor:pointer;"><input type="checkbox" class="dmse-award-perk-check" value="${pk.id}">${pk.name}</label>`).join('');
    }

    window.dmRemoveCharacterPerk = async function(rowId, profileId) {
        if (currentUserRole !== 'dm') return;
        await db.from('character_perks').delete().eq('id', rowId);
        const prof = allProfiles.find(p => p.id === profileId);
        if (prof) prof.perks = (prof.perks || []).filter(p => p.id !== rowId);
        renderPerksList();
        if (typeof window.renderCrewRoster === 'function') window.renderCrewRoster();
    };

    async function awardPerk() {
        const checks = Array.from(document.querySelectorAll('#dmse-award-perk-list .dmse-award-perk-check:checked'));
        if (checks.length === 0) return;
        const prof = targetProf();
        if (!prof || !prof.character || !prof.character.id) return;
        // Checklist already excludes currently-held perks (see renderPerksList),
        // so this is a defensive re-check rather than the primary guard.
        const alreadyHeldIds = new Set((prof.perks || []).map(p => p.perk_definition_id));
        const toAward = [...new Set(checks.map(c => c.value))].filter(id => !alreadyHeldIds.has(id));
        if (toAward.length === 0) return;
        const payload = toAward.map(id => ({ character_id: prof.character.id, perk_definition_id: id, section: 2 }));
        const { data, error } = await db.from('character_perks').insert(payload).select();
        if (error) { alert("Failed to award perk(s): " + error.message); return; }
        prof.perks = prof.perks || [];
        prof.perks.push(...(data || []));
        const names = toAward.map(id => { const d = window.findPerkDefinition(id); return d ? d.name : 'Unknown perk'; });
        db.from('chat_logs').insert({ sender_id: null, content: `🎖️ [OVERSEER] ${prof.username || 'Commander'} was awarded the specialization${names.length > 1 ? 's' : ''}: ${names.join(', ')}.`, message_type: 'system' });
        renderPerksList();
        if (typeof window.renderCrewRoster === 'function') window.renderCrewRoster();
    }

    function renderAugmentsList() {
        const container = document.getElementById('dmse-augments-list');
        const prof = targetProf();
        if (!container || !prof) return;
        const augments = prof.augments || [];
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
                installedHtml += `<div style="background:#030403; padding:4px 6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:3px; display:flex; justify-content:space-between; align-items:flex-start; gap:6px;">
                    <div style="flex:1;">${def ? `<strong style="color:#00e5a3; font-size:10px;">${def.name}</strong>` : `<strong style="color:#6b826a; font-size:10px;">${title}</strong>`}${ca.notes ? `<div style="font-size:9px; color:#d4c5a9;">${ca.notes}</div>` : ''}</div>
                    <button onclick="window.dmRemoveCharacterAugment('${ca.id}', '${targetProfileId}')" style="width:auto; margin:0; padding:2px 6px; font-size:9px; border-color:#ff6b6b; color:#ff6b6b;">✕</button>
                </div>`;
            });

            html += `<div style="margin-bottom:8px; border-top:1px solid #3c4e36; padding-top:5px;">
                <label style="font-size:9px; color:#6b826a;">${label}:</label>
                <div style="margin-top:3px;">${installedHtml}</div>
                <div style="display:flex; gap:4px; margin-top:3px;">
                    <label for="dmse-aug-picker-${slot}" style="display:none;">Add Augment</label>
                    <select id="dmse-aug-picker-${slot}" style="flex:1; margin:0; font-size:10px;">${pickerOptions}</select>
                </div>
                <div style="display:flex; gap:4px; margin-top:3px;">
                    <label for="dmse-aug-notes-${slot}" style="display:none;">Notes</label>
                    <input type="text" id="dmse-aug-notes-${slot}" placeholder="Notes (optional flavor)" style="flex:1; margin:0; font-size:10px;">
                    <button class="btn-deploy" onclick="window.dmInstallAugment('${slot}')" style="width:auto; margin:0; padding:4px 8px; font-size:9px;">+ INSTALL</button>
                </div>
            </div>`;
        });
        container.innerHTML = html;
    }

    window.dmInstallAugment = async function(slot) {
        const prof = targetProf();
        if (!prof || !prof.character || !prof.character.id) return;
        const picker = document.getElementById(`dmse-aug-picker-${slot}`);
        const notesInput = document.getElementById(`dmse-aug-notes-${slot}`);
        const augmentDefId = picker && picker.value ? picker.value : null;
        const notes = notesInput ? notesInput.value.trim() : '';
        if (!augmentDefId && !notes) { alert("Pick an augment from the catalog and/or enter a note — can't install a completely empty entry."); return; }
        const { data, error } = await db.from('character_augments').insert({ character_id: prof.character.id, slot, augment_definition_id: augmentDefId, notes: notes || null }).select().single();
        if (error) { alert("Failed to install augment: " + error.message); return; }
        prof.augments = prof.augments || [];
        prof.augments.push(data);
        renderAugmentsList();
        if (typeof window.renderAugmentSlots === 'function' && targetProfileId === currentUserId) window.renderAugmentSlots();
    };

    window.dmRemoveCharacterAugment = async function(rowId, profileId) {
        if (currentUserRole !== 'dm') return;
        await db.from('character_augments').delete().eq('id', rowId);
        const prof = allProfiles.find(p => p.id === profileId);
        if (prof) prof.augments = (prof.augments || []).filter(ca => ca.id !== rowId);
        renderAugmentsList();
    };

    function renderGearList() {
        const container = document.getElementById('dmse-gear-list');
        const prof = targetProf();
        if (!container || !prof) return;
        const gear = prof.gear || [];
        container.innerHTML = gear.length === 0 ? '<span style="font-size:9px; color:#6b826a;">Nothing in loadout.</span>' : gear.map(cg => {
            const def = typeof window.findGearDefinition === 'function' ? window.findGearDefinition(cg.gear_definition_id) : null;
            const title = def ? def.name : (cg.notes ? '(uncatalogued)' : 'Unknown');
            return `<div style="background:#030403; padding:4px 6px; border:1px solid ${cg.equipped ? '#3c4e36' : '#6b826a'}; border-radius:2px; margin-bottom:3px; display:flex; justify-content:space-between; align-items:flex-start; gap:6px; ${cg.equipped ? '' : 'opacity:0.6;'}">
                <div style="flex:1;">${def ? `<strong style="color:#00e5a3; font-size:10px;">${def.name}</strong>` : `<strong style="color:#6b826a; font-size:10px;">${title}</strong>`}${!cg.equipped ? '<span style="font-size:8px; color:#6b826a;"> (stowed)</span>' : ''}${cg.notes ? `<div style="font-size:9px; color:#d4c5a9;">${cg.notes}</div>` : ''}</div>
                <div style="display:flex; gap:3px; flex-shrink:0;">
                    <button onclick="window.dmToggleCharacterGearEquipped('${cg.id}', '${targetProfileId}')" style="width:auto; margin:0; padding:2px 6px; font-size:9px;">${cg.equipped ? 'STOW' : 'EQUIP'}</button>
                    <button onclick="window.dmRemoveCharacterGear('${cg.id}', '${targetProfileId}')" style="width:auto; margin:0; padding:2px 6px; font-size:9px; border-color:#ff6b6b; color:#ff6b6b;">✕</button>
                </div>
            </div>`;
        }).join('');

        const picker = document.getElementById('dmse-gear-picker');
        const choices = typeof window.getApprovedGear === 'function' ? window.getApprovedGear() : [];
        picker.innerHTML = '<option value="">— No catalog gear / narrative only —</option>' + choices.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
    }

    async function addGear() {
        const prof = targetProf();
        if (!prof || !prof.character || !prof.character.id) return;
        const picker = document.getElementById('dmse-gear-picker');
        const notesInput = document.getElementById('dmse-gear-notes');
        const gearDefId = picker && picker.value ? picker.value : null;
        const notes = notesInput ? notesInput.value.trim() : '';
        if (!gearDefId && !notes) { alert("Pick a gear item from the catalog and/or enter a note — can't add a completely empty entry."); return; }
        const { data, error } = await db.from('character_gear').insert({ character_id: prof.character.id, gear_definition_id: gearDefId, notes: notes || null, equipped: true }).select().single();
        if (error) { alert("Failed to add gear: " + error.message); return; }
        prof.gear = prof.gear || [];
        prof.gear.push(data);
        if (notesInput) notesInput.value = '';
        renderGearList();
        if (typeof window.renderGearLoadout === 'function' && targetProfileId === currentUserId) window.renderGearLoadout();
    }

    window.dmToggleCharacterGearEquipped = async function(rowId, profileId) {
        const prof = allProfiles.find(p => p.id === profileId);
        const row = prof ? (prof.gear || []).find(cg => cg.id === rowId) : null;
        if (!row) return;
        const newVal = !row.equipped;
        const { error } = await db.from('character_gear').update({ equipped: newVal }).eq('id', rowId);
        if (error) { alert("Failed to update gear: " + error.message); return; }
        row.equipped = newVal;
        renderGearList();
    };

    window.dmRemoveCharacterGear = async function(rowId, profileId) {
        if (currentUserRole !== 'dm') return;
        await db.from('character_gear').delete().eq('id', rowId);
        const prof = allProfiles.find(p => p.id === profileId);
        if (prof) prof.gear = (prof.gear || []).filter(cg => cg.id !== rowId);
        renderGearList();
    };

    function renderArsenalList() {
        const container = document.getElementById('dmse-arsenal-list');
        const prof = targetProf();
        if (!container || !prof) return;
        const arsenal = prof.arsenal || [];
        container.innerHTML = arsenal.length === 0 ? '<span style="font-size:9px; color:#6b826a;">No weapons/powers.</span>' : arsenal.map(w => {
            let ammoLabel = (w.ammo !== null && w.ammo !== undefined) ? ` (${w.ammo}/${w.max_ammo !== null && w.max_ammo !== undefined ? w.max_ammo : '∞'})` : '';
            return `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:4px 6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:3px;">
                <span style="font-size:10px; color:#d4c5a9;">${w.name} <span style="color:#6b826a;">${w.dice} ${w.modifier}</span>${ammoLabel}</span>
                <div style="display:flex; gap:3px;">
                    <button class="layer-edit" onclick="window.dmLoadArsenalForEdit('${w.id}')" style="padding:1px 5px; font-size:8px;">✎</button>
                    <button class="layer-del" onclick="window.dmDeleteArsenalItem('${w.id}', '${targetProfileId}')" style="padding:1px 5px; font-size:8px;">✕</button>
                </div>
            </div>`;
        }).join('');
    }

    function resetArsenalForm() {
        editingArsenalId = null;
        document.getElementById('dmse-arsenal-name').value = '';
        document.getElementById('dmse-arsenal-dice').value = '';
        document.getElementById('dmse-arsenal-mod').value = '';
        document.getElementById('dmse-arsenal-ammo').value = '';
        document.getElementById('dmse-arsenal-maxammo').value = '';
        document.getElementById('dmse-arsenal-dmgtype').value = '';
        document.getElementById('dmse-arsenal-explodes').checked = false;
        document.getElementById('dmse-arsenal-save-btn').innerText = '+ ADD WEAPON';
        document.getElementById('dmse-arsenal-cancel-btn').style.display = 'none';
    }

    window.dmLoadArsenalForEdit = function(id) {
        const prof = targetProf();
        const w = prof ? (prof.arsenal || []).find(x => x.id === id) : null;
        if (!w) return;
        editingArsenalId = id;
        document.getElementById('dmse-arsenal-name').value = w.name || '';
        document.getElementById('dmse-arsenal-dice').value = w.dice || '';
        document.getElementById('dmse-arsenal-mod').value = w.modifier || '+0';
        document.getElementById('dmse-arsenal-ammo').value = (w.ammo === null || w.ammo === undefined) ? '' : w.ammo;
        document.getElementById('dmse-arsenal-maxammo').value = (w.max_ammo === null || w.max_ammo === undefined) ? '' : w.max_ammo;
        document.getElementById('dmse-arsenal-dmgtype').value = w.damage_type || '';
        document.getElementById('dmse-arsenal-explodes').checked = !!w.explodes;
        document.getElementById('dmse-arsenal-save-btn').innerText = 'SAVE CHANGES';
        document.getElementById('dmse-arsenal-cancel-btn').style.display = 'block';
    };

    async function saveArsenalItem() {
        const prof = targetProf();
        if (!prof || !prof.character || !prof.character.id) return;
        const name = document.getElementById('dmse-arsenal-name').value.trim();
        if (!name) { alert("Enter a weapon/power name."); return; }
        let dice = document.getElementById('dmse-arsenal-dice').value.trim().toLowerCase() || '1d20';
        let mod = document.getElementById('dmse-arsenal-mod').value.trim();
        if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
        if (!mod) mod = '+0';
        const ammoStr = document.getElementById('dmse-arsenal-ammo').value.trim();
        const maxAmmoStr = document.getElementById('dmse-arsenal-maxammo').value.trim();
        const ammoVal = ammoStr === '' ? null : Math.max(0, parseInt(ammoStr) || 0);
        const maxAmmoVal = maxAmmoStr === '' ? ammoVal : Math.max(0, parseInt(maxAmmoStr) || 0);
        const payload = {
            name, dice, modifier: mod,
            explodes: document.getElementById('dmse-arsenal-explodes').checked,
            damage_type: document.getElementById('dmse-arsenal-dmgtype').value || null,
            ammo: ammoVal, max_ammo: maxAmmoVal
        };

        if (editingArsenalId) {
            const { error } = await db.from('character_arsenal').update(payload).eq('id', editingArsenalId);
            if (error) { alert("Failed to save weapon: " + error.message); return; }
            const w = (prof.arsenal || []).find(x => x.id === editingArsenalId);
            if (w) Object.assign(w, payload);
        } else {
            payload.profile_id = prof.id;
            payload.character_id = prof.character.id;
            const { data, error } = await db.from('character_arsenal').insert(payload).select().single();
            if (error) { alert("Failed to add weapon: " + error.message); return; }
            prof.arsenal = prof.arsenal || [];
            prof.arsenal.push(data);
        }
        resetArsenalForm();
        renderArsenalList();
        if (typeof window.renderArsenal === 'function' && targetProfileId === currentUserId) window.renderArsenal();
    }

    window.dmDeleteArsenalItem = async function(id, profileId) {
        if (!(await window.showConfirmModal("Remove this item from their arsenal?"))) return;
        await db.from('character_arsenal').delete().eq('id', id);
        const prof = allProfiles.find(p => p.id === profileId);
        if (prof) prof.arsenal = (prof.arsenal || []).filter(w => w.id !== id);
        renderArsenalList();
    };

    window.openDmSheetEditor = function(profileId) {
        if (currentUserRole !== 'dm') return;
        const prof = allProfiles.find(p => p.id === profileId);
        if (!prof || !prof.character || !prof.character.id) { alert("This player hasn't saved a character sheet yet — nothing to edit."); return; }
        ensureModal();
        targetProfileId = profileId;
        resetArsenalForm();
        const char = prof.character;
        const skills = prof.skills || {};

        document.getElementById('dmse-username').innerText = prof.username || 'Commander';
        document.getElementById('dmse-name').value = char.name || '';
        ['charisma', 'dexterity', 'intelligence', 'strength', 'toughness', 'willpower'].forEach(stat => {
            document.getElementById(`dmse-stat-${stat}-wrap`).innerHTML = statSelectHtml(`dmse-stat-${stat}`, char[`stat_${stat}`] || 'd4');
        });
        document.getElementById('dmse-vit').value = char.vitality || 0;
        document.getElementById('dmse-stress').value = char.stress || 0;
        document.getElementById('dmse-adv').value = char.adversity_tokens || 0;
        document.getElementById('dmse-shieldcur').value = char.shield_current || 0;
        document.getElementById('dmse-shieldmax').value = char.shield_max || 0;
        document.getElementById('dmse-dr').value = char.dr || 0;
        document.getElementById('dmse-specialties').value = char.specialties || '';
        document.getElementById('dmse-history').value = char.history || '';
        document.getElementById('dmse-personalhistory').value = char.personal_history || '';
        document.getElementById('dmse-assets').value = char.assets || '';

        document.getElementById('dmse-skills-grid').innerHTML = skillList.map(skill => {
            const safeKey = skill.toLowerCase().replace(/[^a-z0-9]/g, '_');
            return `<div><label style="font-size:8px; color:#6b826a;">${skill}</label><input type="number" id="dmse-skill-${safeKey}" value="${skills[safeKey] || 0}" style="font-size:10px; padding:2px;"></div>`;
        }).join('');

        renderPerksList();
        renderAugmentsList();
        renderGearList();
        renderArsenalList();

        overlay.style.display = 'flex';
    };
})();
