/* ==========================================================================
   js/encounter-presets.js - Encounter Presets / Stage Mode
   (Command Terminal refactor, Phase 2, 2026-10-01)
   ==========================================================================
   Lets the DM build a battle ahead of time -- which ships, where, hidden or
   not, AI or not, friend/foe -- and launch it in one click, plus later
   reinforcement waves.

   DM-confirmed design (AskUserQuestion, 2026-10-01):
   - Staging happens in its own full-screen DM-only screen ("Encounter
     Stager"), opened from the Battle Map (📋 PRESETS). Nothing staged exists
     anywhere players can see until LAUNCH.
   - Presets live in `encounter_presets` (RLS: DM only). Launched-but-not-yet-
     arrived waves live in `battle_reinforcements` (RLS: DM only) -- NOT on
     the battle_encounters row players can read, so incoming reinforcements
     can't be spotted with browser tools.
   - Entities are REFERENCES: a ship template (deployed fresh at launch, so a
     later template edit is picked up) or an existing ship (e.g. a player's
     own ship, moved onto the grid at its staged spot).
   - Wave 1 arrives at launch. Later waves: a manual DEPLOY button, or
     automatically at the start of round N (launch = round 1).
   - Preset NPCs are Battle-Map-only (hide_from_galaxy_map), start at full
     health, and get auto-callsigns like any other deploy.
   - No terrain in this version.

   Loaded after js/battle-map.js (uses saveBattleTokens, loadBattleEncounters,
   clampToGrid, genBattleTokenId, window.resolveRoundTick). Feature switch:
   'encounter_presets' (seeded to DM ONLY). */

let encounterPresetsList = [];
let stagerPreset = null;      // working copy of the preset being edited
let stagerDirty = false;
let stagerSelectedKey = null;
let stagerLastPick = { template: '', fleet: '', ship: '', wave: 1 }; // keeps the ADD dropdowns where the DM left them across re-renders
let pendingReinforcements = []; // DM only: not-yet-deployed waves for the active battle
let pendingReinforcementsEncounterId = null;

const STAGE_TOKEN = 34;

function presetsAllowed() {
    return currentUserRole === 'dm' && typeof window.isFeatureOn === 'function' && window.isFeatureOn('encounter_presets');
}
function presetEsc(s) { return window.escapeHtml(s == null ? '' : String(s)); }
function newPresetData() {
    return { schema: 1, entities: [], waves: [{ id: 1, trigger: { type: 'on_launch' } }], notes: '' };
}
// Phase 7: the preset's map (library) sets the stager's size and shows its terrain.
function stagerMap() {
    const id = stagerPreset && stagerPreset.data.map && stagerPreset.data.map.map_id;
    return id && typeof window.battleMapById === 'function' ? window.battleMapById(id) : null;
}
function stagerDims() {
    const m = stagerMap();
    return typeof window.battleMapDims === 'function' ? window.battleMapDims(m) : { w: 920, h: 760 };
}
function stagerClamp(x, y) {
    const { w, h } = stagerDims();
    return { x: Math.max(0, Math.min(w - STAGE_TOKEN, x)), y: Math.max(0, Math.min(h - STAGE_TOKEN, y)) };
}
window.stagerSetMap = function (id) {
    if (!stagerPreset) return;
    stagerPreset.data.map = id ? { map_id: id } : null;
    stagerPreset.data.entities.forEach(e => { const p = stagerClamp(e.pos.x, e.pos.y); e.pos = { x: Math.round(p.x), y: Math.round(p.y) }; });
    markDirty();
    renderStager();
};
window.renderStagerIfOpen = function () { const ov = document.getElementById('encounter-stager'); if (ov && ov.style.display !== 'none') renderStager(); };
function presetEntityKey() { return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function allTemplates() {
    return (typeof shipTemplatesList !== 'undefined' ? shipTemplatesList : []).concat(window.secretShipTemplatesList || []);
}
function templateById(id) { return (typeof findAnyTemplateById === 'function') ? findAnyTemplateById(id) : allTemplates().find(t => t.id === id); }

// What a staged entity looks like on the stager grid / in lists.
function describeEntity(e) {
    if (e.source.kind === 'template') {
        const t = templateById(e.source.template_id);
        return { name: t ? t.name : '(deleted template)', missing: !t, iff: (e.overrides && e.overrides.iff !== undefined) ? e.overrides.iff : (t ? t.iff : null),
                 hidden: !!(e.overrides && e.overrides.is_hidden), ai: (e.overrides && e.overrides.ai_controlled !== undefined) ? !!e.overrides.ai_controlled : (typeof window.defaultAiForDeploy === 'function' ? window.defaultAiForDeploy(t) : !!(t && t.ai_controlled)), kind: 'template' };
    }
    const v = globalShipMarkersCache.find(m => m.id === e.source.ship_marker_id);
    return { name: v ? v.name : '(ship no longer exists)', missing: !v, iff: v ? v.iff : null, hidden: !!(e.overrides && e.overrides.is_hidden), ai: !!(v && v.ai_controlled), kind: 'ship' };
}
function iffColor(iff) { return iff === 'hostile' ? '#ff3333' : iff === 'friendly' ? '#00e1ff' : iff === 'neutral' ? '#ffaa00' : '#c9c9c9'; }

/* --- Data --- */
window.loadEncounterPresets = async function() {
    if (currentUserRole !== 'dm') return [];
    const { data, error } = await db.from('encounter_presets').select('*').order('updated_at', { ascending: false });
    if (error) { console.error('loadEncounterPresets failed', error); return encounterPresetsList; }
    encounterPresetsList = (data || []).map(p => ({ ...p, data: Object.assign(newPresetData(), p.data || {}) }));
    return encounterPresetsList;
};

/* --- Stager screen --- */
function ensureStagerOverlay() {
    let ov = document.getElementById('encounter-stager');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'encounter-stager';
    ov.style.cssText = 'display:none; position:fixed; inset:0; z-index:4000; background:#030403; color:#d4c5a9; overflow:auto; padding:12px; box-sizing:border-box;';
    document.body.appendChild(ov);
    return ov;
}

window.openEncounterStager = async function() {
    if (!presetsAllowed()) return;
    ensureStagerOverlay().style.display = 'block';
    await window.loadEncounterPresets();
    if (typeof window.battleMapsAllowed === 'function' && window.battleMapsAllowed()) await window.loadBattleMaps();
    if (!stagerPreset && encounterPresetsList.length > 0) selectPreset(encounterPresetsList[0].id, true);
    renderStager();
};
window.closeEncounterStager = async function() {
    if (stagerDirty && !(await window.showConfirmModal('You have unsaved changes to this preset. Close anyway?'))) return;
    stagerDirty = false;
    const ov = document.getElementById('encounter-stager');
    if (ov) ov.style.display = 'none';
};

function selectPreset(id, silent) {
    const p = encounterPresetsList.find(x => x.id === id);
    stagerPreset = p ? JSON.parse(JSON.stringify(p)) : null;
    stagerSelectedKey = null;
    stagerDirty = false;
    if (!silent) renderStager();
}
window.stagerOpenPreset = async function(id) {
    if (stagerDirty && !(await window.showConfirmModal('Discard unsaved changes to the current preset?'))) return;
    selectPreset(id);
};
window.stagerNewPreset = async function() {
    if (stagerDirty && !(await window.showConfirmModal('Discard unsaved changes to the current preset?'))) return;
    stagerPreset = { id: null, name: 'New Encounter', data: newPresetData() };
    stagerSelectedKey = null;
    stagerDirty = true;
    renderStager();
};
window.stagerSave = async function() {
    if (!stagerPreset || currentUserRole !== 'dm') return false;
    const nameEl = document.getElementById('stager-name');
    if (nameEl) stagerPreset.name = nameEl.value.trim() || 'Untitled Encounter';
    const notesEl = document.getElementById('stager-notes');
    if (notesEl) stagerPreset.data.notes = notesEl.value;
    const objEl = document.getElementById('stager-objective'); // Phase 4c: shown to players at launch
    if (objEl) stagerPreset.data.objective = objEl.value.trim();
    const row = { name: stagerPreset.name, data: stagerPreset.data, updated_at: new Date().toISOString() };
    let res;
    if (stagerPreset.id) res = await db.from('encounter_presets').update(row).eq('id', stagerPreset.id).select();
    else res = await db.from('encounter_presets').insert({ ...row, created_by: currentUserId }).select();
    if (res.error) { alert('Failed to save preset: ' + res.error.message); return false; }
    const saved = Array.isArray(res.data) ? res.data[0] : res.data;
    if (saved && saved.id) stagerPreset.id = saved.id;
    stagerDirty = false;
    await window.loadEncounterPresets();
    if (typeof window.showToast === 'function') window.showToast(`Preset "${stagerPreset.name}" saved.`);
    renderStager();
    return true;
};
window.stagerDeletePreset = async function() {
    if (!stagerPreset) return;
    if (!stagerPreset.id) { stagerPreset = null; stagerDirty = false; renderStager(); return; }
    if (!(await window.showConfirmModal(`Delete preset "${stagerPreset.name}"? Battles already launched from it are not affected.`))) return;
    const { error } = await db.from('encounter_presets').delete().eq('id', stagerPreset.id);
    if (error) { alert('Failed to delete preset: ' + error.message); return; }
    stagerPreset = null; stagerDirty = false;
    await window.loadEncounterPresets();
    renderStager();
};

function markDirty() { stagerDirty = true; const b = document.getElementById('stager-dirty'); if (b) b.textContent = '● unsaved changes'; }

function staggerPos(n) {
    const col = n % 8, row = Math.floor(n / 8);
    return stagerClamp(560 + col * 40 - 140, 120 + row * 50);
}
window.stagerAddTemplate = function() {
    const sel = document.getElementById('stager-add-template');
    if (!stagerPreset || !sel || !sel.value) return;
    stagerLastPick.template = sel.value;
    const e = { key: presetEntityKey(), source: { kind: 'template', template_id: sel.value }, pos: staggerPos(stagerPreset.data.entities.length), overrides: {}, wave: stagerCurrentWave() };
    stagerPreset.data.entities.push(e);
    stagerSelectedKey = e.key;
    markDirty(); renderStager();
};
window.stagerAddFleet = function() {
    const sel = document.getElementById('stager-add-fleet');
    if (!stagerPreset || !sel || !sel.value) return;
    stagerLastPick.fleet = sel.value;
    const fleet = (window.globalSavedFleetsCache || []).find(f => f.id === sel.value);
    if (!fleet) return;
    let added = 0;
    (fleet.members || []).forEach(m => {
        for (let i = 0; i < (m.quantity || 1); i++) {
            stagerPreset.data.entities.push({ key: presetEntityKey(), source: { kind: 'template', template_id: m.template_id }, pos: staggerPos(stagerPreset.data.entities.length), overrides: {}, wave: stagerCurrentWave() });
            added++;
        }
    });
    if (added) { markDirty(); renderStager(); }
};
window.stagerAddShip = function() {
    const sel = document.getElementById('stager-add-ship');
    if (!stagerPreset || !sel || !sel.value) return;
    stagerLastPick.ship = sel.value;
    if (stagerPreset.data.entities.some(e => e.source.kind === 'live_marker' && e.source.ship_marker_id === sel.value)) { alert('That ship is already in this preset.'); return; }
    const e = { key: presetEntityKey(), source: { kind: 'live_marker', ship_marker_id: sel.value }, pos: stagerClamp(80 + (stagerPreset.data.entities.length % 6) * 50, 600), overrides: {}, wave: 1 };
    stagerPreset.data.entities.push(e);
    stagerSelectedKey = e.key;
    markDirty(); renderStager();
};
function stagerCurrentWave() {
    const sel = document.getElementById('stager-add-wave');
    const w = sel ? parseInt(sel.value, 10) : 1;
    stagerLastPick.wave = w > 0 ? w : 1;
    return stagerLastPick.wave;
}
window.stagerSelect = function(key) { stagerSelectedKey = key; renderStager(); };
window.stagerUpdateEntity = function(key, field, value) {
    const e = stagerPreset && stagerPreset.data.entities.find(x => x.key === key);
    if (!e) return;
    e.overrides = e.overrides || {};
    if (field === 'wave') e.wave = Math.max(1, parseInt(value, 10) || 1);
    else if (field === 'iff') { if (value === '__template') delete e.overrides.iff; else e.overrides.iff = value || null; }
    else if (field === 'is_hidden') e.overrides.is_hidden = !!value;
    else if (field === 'ai_controlled') { if (value === '__template') delete e.overrides.ai_controlled; else e.overrides.ai_controlled = value === 'on'; }
    markDirty(); renderStager();
};
window.stagerRemoveEntity = function(key) {
    if (!stagerPreset) return;
    stagerPreset.data.entities = stagerPreset.data.entities.filter(x => x.key !== key);
    if (stagerSelectedKey === key) stagerSelectedKey = null;
    markDirty(); renderStager();
};
window.stagerAddWave = function() {
    if (!stagerPreset) return;
    const next = Math.max(...stagerPreset.data.waves.map(w => w.id)) + 1;
    stagerPreset.data.waves.push({ id: next, trigger: { type: 'manual' } });
    markDirty(); renderStager();
};
window.stagerUpdateWave = function(id, field, value) {
    const w = stagerPreset && stagerPreset.data.waves.find(x => x.id === id);
    if (!w || id === 1) return;
    if (field === 'type') w.trigger = value === 'round' ? { type: 'round', round: Math.max(2, (w.trigger && w.trigger.round) || 2) } : { type: 'manual' };
    if (field === 'round') w.trigger = { type: 'round', round: Math.max(2, parseInt(value, 10) || 2) };
    markDirty(); renderStager();
};
window.stagerRemoveWave = function(id) {
    if (!stagerPreset || id === 1) return;
    stagerPreset.data.waves = stagerPreset.data.waves.filter(w => w.id !== id);
    stagerPreset.data.entities.forEach(e => { if (e.wave === id) e.wave = 1; });
    markDirty(); renderStager();
};

function renderStager() {
    const ov = ensureStagerOverlay();
    if (ov.style.display === 'none') return;
    const p = stagerPreset;
    const list = encounterPresetsList.map(x => `<div style="display:flex; justify-content:space-between; align-items:center; gap:4px; padding:5px 6px; margin-bottom:4px; background:${p && p.id === x.id ? '#0a1a14' : '#050805'}; border:1px solid ${p && p.id === x.id ? '#00e5a3' : '#2a3a2a'}; cursor:pointer;" onclick="window.stagerOpenPreset('${x.id}')">
            <span style="font-size:10px;">${presetEsc(x.name)}</span><span style="font-size:9px; color:#6b826a;">${(x.data.entities || []).length} ships</span></div>`).join('') || '<div style="font-size:9px; color:#6b826a;">No presets yet.</div>';

    let center = '<div style="font-size:11px; color:#6b826a; padding:30px; text-align:center;">Pick a preset on the left, or make a new one.</div>';
    let right = '';
    if (p) {
        const waves = p.data.waves.slice().sort((a, b) => a.id - b.id);
        const waveOpts = (sel) => waves.map(w => `<option value="${w.id}" ${w.id === sel ? 'selected' : ''}>Wave ${w.id}</option>`).join('');
        const tokens = p.data.entities.map(e => {
            const d = describeEntity(e);
            const sel = e.key === stagerSelectedKey;
            const col = d.kind === 'ship' ? '#00e5a3' : iffColor(d.iff);
            return `<div class="stager-token" data-key="${e.key}" title="${presetEsc(d.name)} — wave ${e.wave}${d.hidden ? ' — hidden' : ''}${d.ai ? ' — AI' : ''}" style="position:absolute; left:${e.pos.x}px; top:${e.pos.y}px; width:${STAGE_TOKEN}px; height:${STAGE_TOKEN}px; border-radius:50%; border:2px ${d.hidden ? 'dashed' : 'solid'} ${col}; background:#0a1410; color:${col}; font-size:8px; display:flex; align-items:center; justify-content:center; text-align:center; cursor:grab; user-select:none; opacity:${d.missing ? 0.4 : (d.hidden ? 0.65 : 1)}; box-shadow:${sel ? '0 0 0 3px #ffd700' : 'none'}; touch-action:none;">
                <span style="pointer-events:none; overflow:hidden; white-space:nowrap; max-width:30px;">${presetEsc(d.name.slice(0, 6))}</span>
                <span style="position:absolute; top:-7px; right:-7px; background:#030403; border:1px solid ${col}; border-radius:6px; font-size:7px; padding:0 3px; pointer-events:none;">W${e.wave}${d.ai ? '🤖' : ''}</span></div>`;
        }).join('');
        const sd = stagerDims(), smap = stagerMap();
        const terrainSvg = smap && typeof window.renderBattleTerrainSvg === 'function'
            ? `<svg class="stager-terrain" width="${sd.w}" height="${sd.h}" viewBox="0 0 ${sd.w} ${sd.h}" style="position:absolute; left:0; top:0; pointer-events:none;">${window.renderBattleTerrainSvg(smap, sd.w, sd.h)}</svg>` : '';
        const mapPick = (typeof window.battleMapsAllowed === 'function' && window.battleMapsAllowed())
            ? `<div style="display:flex; gap:6px; align-items:center; margin-bottom:6px; flex-wrap:wrap;"><label for="stager-map" style="font-size:9px; color:#00e1ff;">🗺 Map</label>
                <select id="stager-map" onchange="window.stagerSetMap(this.value)" style="font-size:10px; margin:0; max-width:320px;">${window.battleMapOptionsHtml(p.data.map && p.data.map.map_id)}</select>
                <button class="layer-edit" onclick="window.openBattleMapEditor()" style="width:auto; font-size:9px; padding:3px 8px; margin:0;">EDIT MAPS</button>
                ${p.data.map && p.data.map.map_id && !smap ? '<span style="font-size:9px; color:#ff6b6b;">That map was deleted — the plain grid will be used.</span>' : ''}</div>` : '';
        center = `${mapPick}<div id="stager-grid-wrap" style="width:100%; overflow:hidden;">
            <div id="stager-grid" style="position:relative; width:${sd.w}px; height:${sd.h}px; background:#050a08; border:1px solid #2a3a2a; transform-origin:0 0; background-image:linear-gradient(rgba(60,78,54,0.18) 1px, transparent 1px), linear-gradient(90deg, rgba(60,78,54,0.18) 1px, transparent 1px); background-size:46px 46px;">${terrainSvg}${tokens}</div></div>
            <div style="font-size:9px; color:#6b826a; margin-top:4px;">Drag ships to position them. Click one to edit it. Dashed = hidden from players, W = wave, 🤖 = AI-controlled. Player ships (green) are moved onto the grid at launch.</div>`;

        const selE = p.data.entities.find(e => e.key === stagerSelectedKey);
        let editor = '<div style="font-size:9px; color:#6b826a;">Click a ship on the grid to edit it.</div>';
        if (selE) {
            const d = describeEntity(selE);
            const ov = selE.overrides || {};
            const tmplIff = selE.source.kind === 'template' ? (templateById(selE.source.template_id) || {}).iff : null;
            editor = `<div style="font-size:11px; color:#00e5a3; margin-bottom:4px;">${presetEsc(d.name)}${d.missing ? ' <span style="color:#ff6b6b;">(missing — will be skipped)</span>' : ''}</div>
                <label for="stager-e-wave" style="font-size:9px; color:#6b826a;">Arrives in</label>
                <select id="stager-e-wave" onchange="window.stagerUpdateEntity('${selE.key}','wave',this.value)" style="font-size:10px;">${waveOpts(selE.wave)}</select>
                ${selE.source.kind === 'template' ? `
                <label for="stager-e-iff" style="font-size:9px; color:#6b826a;">Friend / foe</label>
                <select id="stager-e-iff" onchange="window.stagerUpdateEntity('${selE.key}','iff',this.value)" style="font-size:10px;">
                    <option value="__template" ${ov.iff === undefined ? 'selected' : ''}>Template default (${presetEsc(tmplIff || 'unset')})</option>
                    <option value="hostile" ${ov.iff === 'hostile' ? 'selected' : ''}>⚠ Hostile</option>
                    <option value="neutral" ${ov.iff === 'neutral' ? 'selected' : ''}>◌ Neutral</option>
                    <option value="friendly" ${ov.iff === 'friendly' ? 'selected' : ''}>✓ Friendly</option>
                </select>
                <label for="stager-e-ai" style="font-size:9px; color:#6b826a;">AI control</label>
                <select id="stager-e-ai" onchange="window.stagerUpdateEntity('${selE.key}','ai_controlled',this.value)" style="font-size:10px;">
                    <option value="__template" ${ov.ai_controlled === undefined ? 'selected' : ''}>Template default</option>
                    <option value="on" ${ov.ai_controlled === true ? 'selected' : ''}>🤖 AI controlled</option>
                    <option value="off" ${ov.ai_controlled === false ? 'selected' : ''}>Manual</option>
                </select>` : '<div style="font-size:9px; color:#6b826a; margin:4px 0;">Existing ship — it keeps its own stats and owners; only its starting spot (and hidden) come from the preset.</div>'}
                <label for="stager-e-hidden" style="font-size:10px; display:flex; align-items:center; gap:4px; margin-top:6px; cursor:pointer;"><input type="checkbox" id="stager-e-hidden" ${ov.is_hidden ? 'checked' : ''} onchange="window.stagerUpdateEntity('${selE.key}','is_hidden',this.checked)" style="margin:0; width:auto;"> 🫥 Hidden from players at launch</label>
                <button class="layer-del" onclick="window.stagerRemoveEntity('${selE.key}')" style="margin-top:8px; font-size:9px;">✕ REMOVE FROM PRESET</button>`;
        }

        const tmplOpts = allTemplates().map(t => `<option value="${t.id}" ${t.id === stagerLastPick.template ? 'selected' : ''}>${presetEsc(t.name)}${t.is_secret ? ' 🔒' : ''}</option>`).join('') || '<option value="">-- No templates --</option>';
        const fleetOpts = (window.globalSavedFleetsCache || []).map(f => `<option value="${f.id}" ${f.id === stagerLastPick.fleet ? 'selected' : ''}>${presetEsc(f.name)}</option>`).join('') || '<option value="">-- No saved fleets --</option>';
        const profs = (typeof allProfiles !== 'undefined' ? allProfiles : []);
        const shipOpts = globalShipMarkersCache.filter(m => !m.is_strike_craft).map(m => {
            const playerOwned = (window.vesselOwnerIds ? window.vesselOwnerIds(m) : []).some(id => { const pr = profs.find(x => x.id === id); return pr && pr.role !== 'dm'; });
            return `<option value="${m.id}" ${m.id === stagerLastPick.ship ? 'selected' : ''}>${presetEsc(m.name)}${playerOwned ? ' (player)' : ''}</option>`;
        }).join('') || '<option value="">-- No ships --</option>';

        const waveRows = waves.map(w => w.id === 1
            ? `<div style="font-size:10px; padding:3px 0;">Wave 1 — arrives at launch (${p.data.entities.filter(e => e.wave === 1).length} ships)</div>`
            : `<div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap; padding:3px 0; font-size:10px;">Wave ${w.id} (${p.data.entities.filter(e => e.wave === w.id).length}):
                <label for="stager-w-type-${w.id}" style="display:none;">Wave ${w.id} trigger</label>
                <select id="stager-w-type-${w.id}" onchange="window.stagerUpdateWave(${w.id},'type',this.value)" style="font-size:9px; width:auto; margin:0;">
                    <option value="manual" ${w.trigger.type !== 'round' ? 'selected' : ''}>when I press deploy</option>
                    <option value="round" ${w.trigger.type === 'round' ? 'selected' : ''}>at start of round</option>
                </select>
                ${w.trigger.type === 'round' ? `<label for="stager-w-round-${w.id}" style="display:none;">Round</label><input type="number" id="stager-w-round-${w.id}" min="2" value="${w.trigger.round}" onchange="window.stagerUpdateWave(${w.id},'round',this.value)" style="width:50px; font-size:9px; margin:0;">` : ''}
                <button class="layer-del" onclick="window.stagerRemoveWave(${w.id})" style="width:auto; font-size:8px; padding:1px 5px; margin:0;" title="Remove wave (its ships move to wave 1)">✕</button></div>`).join('');

        right = `
            <div style="font-size:9px; color:#00e5a3; margin-bottom:2px;">ADD TO WAVE</div>
            <label for="stager-add-wave" style="display:none;">Wave for new ships</label>
            <select id="stager-add-wave" style="font-size:10px;">${waveOpts(waves.some(w => w.id === stagerLastPick.wave) ? stagerLastPick.wave : 1)}</select>
            <label for="stager-add-template" style="font-size:9px; color:#6b826a;">Ship template</label>
            <div style="display:flex; gap:4px;"><select id="stager-add-template" style="font-size:10px; flex:1; margin:0;">${tmplOpts}</select><button class="btn-deploy" onclick="window.stagerAddTemplate()" style="width:auto; font-size:9px; margin:0; padding:3px 8px;">+ ADD</button></div>
            <label for="stager-add-fleet" style="font-size:9px; color:#6b826a;">Saved fleet (adds each ship)</label>
            <div style="display:flex; gap:4px;"><select id="stager-add-fleet" style="font-size:10px; flex:1; margin:0;">${fleetOpts}</select><button class="btn-deploy" onclick="window.stagerAddFleet()" style="width:auto; font-size:9px; margin:0; padding:3px 8px;">+ ADD</button></div>
            <label for="stager-add-ship" style="font-size:9px; color:#6b826a;">Existing ship (e.g. a player's)</label>
            <div style="display:flex; gap:4px;"><select id="stager-add-ship" style="font-size:10px; flex:1; margin:0;">${shipOpts}</select><button class="btn-deploy" onclick="window.stagerAddShip()" style="width:auto; font-size:9px; margin:0; padding:3px 8px;">+ ADD</button></div>
            <h4 style="margin:12px 0 4px 0; color:#c9962f; font-size:11px;">Selected ship</h4>${editor}
            <h4 style="margin:12px 0 4px 0; color:#c9962f; font-size:11px;">Waves</h4>${waveRows}
            <button class="layer-edit" onclick="window.stagerAddWave()" style="font-size:9px; margin-top:4px;">+ ADD WAVE</button>
            <label for="stager-objective" style="font-size:9px; color:#ffaa00; display:block; margin-top:10px;">🎯 Objective (shown to players when launched)</label>
            <textarea id="stager-objective" rows="2" oninput="markStagerDirty()" style="font-size:10px; width:100%;">${presetEsc(p.data.objective || '')}</textarea>
            <label for="stager-notes" style="font-size:9px; color:#6b826a; display:block; margin-top:10px;">DM notes (never shown to players)</label>
            <textarea id="stager-notes" rows="3" oninput="markStagerDirty()" style="font-size:10px; width:100%;">${presetEsc(p.data.notes || '')}</textarea>`;
    }

    ov.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; border-bottom:1px solid #3c4e36; padding-bottom:8px; margin-bottom:8px;">
            <div><strong style="color:#c778dd; font-size:13px;">📋 ENCOUNTER STAGER</strong> <span style="font-size:9px; color:#ff6b6b; border:1px solid #ff6b6b; padding:1px 6px; margin-left:6px;">DM ONLY — players can't see anything here until you launch</span></div>
            <button class="btn-remove" onclick="window.closeEncounterStager()" style="width:auto; font-size:10px; margin:0; padding:4px 10px;">✕ CLOSE</button>
        </div>
        <div style="display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap;">
            <div style="width:190px; flex-shrink:0;">
                <button class="btn-deploy" onclick="window.stagerNewPreset()" style="font-size:10px; margin:0 0 8px 0;">+ NEW PRESET</button>
                ${list}
            </div>
            <div style="flex:1; min-width:300px;">
                ${p ? `<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
                    <label for="stager-name" style="display:none;">Preset name</label>
                    <input type="text" id="stager-name" value="${presetEsc(p.name)}" oninput="markStagerDirty()" style="font-size:12px; flex:1; min-width:160px; margin:0;">
                    <span id="stager-dirty" style="font-size:9px; color:#ffaa00;">${stagerDirty ? '● unsaved changes' : ''}</span>
                    <button class="btn-reveal" onclick="window.stagerSave()" style="width:auto; font-size:10px; margin:0; padding:4px 10px;">💾 SAVE</button>
                    <button class="btn-deploy" onclick="window.stagerLaunch()" style="width:auto; font-size:10px; margin:0; padding:4px 10px; border-color:#c778dd; color:#c778dd;">🚀 LAUNCH</button>
                    <button class="layer-del" onclick="window.stagerDeletePreset()" style="width:auto; font-size:9px; margin:0; padding:4px 8px;">✕ DELETE</button>
                </div>` : ''}
                ${center}
            </div>
            ${p ? `<div style="width:260px; max-width:100%; flex-shrink:0;">${right}</div>` : ''}
        </div>`;
    fitStagerGrid();
    wireStagerDrag();
}
// The name/notes inputs call markStagerDirty() from inline handlers.
window.markStagerDirty = markDirty;

function fitStagerGrid() {
    const wrap = document.getElementById('stager-grid-wrap');
    const grid = document.getElementById('stager-grid');
    if (!wrap || !grid) return;
    const { w, h } = stagerDims();
    const scale = Math.min(1, (wrap.clientWidth || w) / w);
    grid.style.transform = `scale(${scale})`;
    wrap.style.height = Math.ceil(h * scale) + 'px';
}
window.addEventListener('resize', () => { const ov = document.getElementById('encounter-stager'); if (ov && ov.style.display !== 'none') fitStagerGrid(); });

function wireStagerDrag() {
    const grid = document.getElementById('stager-grid');
    if (!grid) return;
    grid.querySelectorAll('.stager-token').forEach(el => {
        const key = el.getAttribute('data-key');
        el.addEventListener('pointerdown', (ev) => {
            ev.preventDefault();
            const e = stagerPreset.data.entities.find(x => x.key === key);
            if (!e) return;
            const rect = grid.getBoundingClientRect();
            const scale = rect.width / stagerDims().w || 1;
            const start = { x: ev.clientX, y: ev.clientY, ex: e.pos.x, ey: e.pos.y };
            let moved = false;
            el.setPointerCapture && el.setPointerCapture(ev.pointerId);
            const onMove = (mv) => {
                const dx = (mv.clientX - start.x) / scale, dy = (mv.clientY - start.y) / scale;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
                const pos = stagerClamp(start.ex + dx, start.ey + dy);
                el.style.left = pos.x + 'px'; el.style.top = pos.y + 'px';
                e.pos = { x: Math.round(pos.x), y: Math.round(pos.y) };
            };
            const onUp = () => {
                el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp);
                if (moved) { markDirty(); stagerSelectedKey = key; renderStager(); }
                else window.stagerSelect(key);
            };
            el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp);
        });
    });
}

/* --- Launch + waves --- */
// Deploys one wave's entities into the active battle. Returns the count placed.
async function deployPresetEntities(entities, waveId) {
    const enc = window.globalBattleEncounterCache;
    if (!enc) return 0;
    const placed = [];
    const skipped = [];
    const onGrid = new Set((enc.tokens || []).map(t => t.ship_marker_id));
    for (const e of entities) {
        const pos = clampToGrid(e.pos.x, e.pos.y);
        if (e.source.kind === 'template') {
            if (!templateById(e.source.template_id)) { skipped.push('(deleted template)'); continue; }
            const ov = e.overrides || {};
            const overrides = { hide_from_galaxy_map: true };
            if (ov.iff !== undefined) overrides.iff = ov.iff;
            if (ov.is_hidden) overrides.is_hidden = true;
            if (ov.ai_controlled !== undefined) overrides.ai_controlled = !!ov.ai_controlled;
            const id = await window.deployShipTemplate(e.source.template_id, { silent: true, overrides });
            if (id) placed.push({ id, pos }); else skipped.push(templateById(e.source.template_id).name);
        } else {
            const v = globalShipMarkersCache.find(m => m.id === e.source.ship_marker_id);
            if (!v) { skipped.push('(missing ship)'); continue; }
            if (onGrid.has(v.id)) continue; // already in this battle
            if (e.overrides && e.overrides.is_hidden && !v.is_hidden) {
                const { error } = await db.from('ship_markers').update({ is_hidden: true }).eq('id', v.id);
                if (!error) v.is_hidden = true;
            }
            placed.push({ id: v.id, pos });
        }
    }
    if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
    const cur = window.globalBattleEncounterCache;
    if (!cur) return 0;
    const tokens = (cur.tokens || []).slice();
    placed.forEach(p => {
        const v = globalShipMarkersCache.find(m => m.id === p.id);
        tokens.push({ token_id: genBattleTokenId(), ship_marker_id: p.id, x: p.pos.x, y: p.pos.y, move_remaining: v ? (v.tactical_speed ?? 160) : 160 });
    });
    if (placed.length) await saveBattleTokens(tokens);
    if (waveId > 1) {
        const visibleCount = placed.filter(p => { const v = globalShipMarkersCache.find(m => m.id === p.id); return !(v && v.is_hidden); }).length;
        if (visibleCount > 0) await db.from('chat_logs').insert({ sender_id: null, content: `🌊 [TACTICAL BATTLE MAP] Reinforcements! ${visibleCount} vessel${visibleCount === 1 ? '' : 's'} entered the engagement.`, message_type: 'system' });
        if (window.AudioEngine) window.AudioEngine.playKlaxon();
    }
    if (skipped.length && typeof window.showToast === 'function') window.showToast(`Skipped ${skipped.length}: ${skipped.join(', ')}`);
    return placed.length;
}
window.deployPresetEntities = deployPresetEntities;

window.stagerLaunch = async function() {
    if (!stagerPreset || currentUserRole !== 'dm') return;
    if (stagerPreset.data.entities.length === 0) { alert('Add at least one ship first.'); return; }
    if (stagerDirty) { if (!(await window.stagerSave())) return; }
    const preset = JSON.parse(JSON.stringify(stagerPreset));
    const active = window.globalBattleEncounterCache;
    const msg = active
        ? `Launch "${preset.name}"? This ENDS the current battle ("${active.name}") and starts a new one with wave 1 on the grid.`
        : `Launch "${preset.name}"? Starts a new battle with wave 1 on the grid.`;
    if (!(await window.showConfirmModal(msg))) return;
    await window.launchEncounterPreset(preset);
};

// Separate from the button so it can be called/tested directly.
window.launchEncounterPreset = async function(preset) {
    if (currentUserRole !== 'dm') return null;
    const active = window.globalBattleEncounterCache;
    if (active) {
        await db.from('battle_encounters').update({ is_active: false }).eq('id', active.id);
        await db.from('chat_logs').insert({ sender_id: null, content: `⚔️ [TACTICAL BATTLE MAP] Engagement ended: "${active.name}".`, message_type: 'system' });
    }
    const { data: encRows, error } = await db.from('battle_encounters').insert({ name: preset.name, is_active: true, created_by: currentUserId, tokens: [], tokens_migrated: true, objective: (preset.data.objective || '').trim() || null,
        map: (() => {
            const m = (preset.data.map && preset.data.map.map_id && typeof window.battleMapSnapshotById === 'function') ? window.battleMapSnapshotById(preset.data.map.map_id) : null;
            // Phase 10: terrain rules default ON when the map has terrain and the DM has the terrain tools.
            if (m) m.rules = !!(typeof window.terrainRulesAllowed === 'function' && window.terrainRulesAllowed() && Array.isArray(m.terrain) && m.terrain.length);
            return m;
        })() }).select();
    if (error) { alert('Failed to start the battle: ' + error.message); return null; }
    const newEnc = Array.isArray(encRows) ? encRows[0] : encRows;
    await db.from('chat_logs').insert({ sender_id: null, content: `⚔️ [TACTICAL BATTLE MAP] Engagement started: "${preset.name}".`, message_type: 'system' });
    await window.loadBattleEncounters();
    const waves = (preset.data.waves || []).slice().sort((a, b) => a.id - b.id);
    const wave1 = preset.data.entities.filter(e => (e.wave || 1) === 1);
    await deployPresetEntities(wave1, 1);
    // Later waves wait in the DM-only reinforcements table.
    const later = waves.filter(w => w.id > 1).map(w => ({
        encounter_id: newEnc.id, preset_id: preset.id || null, wave: w.id, trigger: w.trigger || { type: 'manual' },
        entities: preset.data.entities.filter(e => e.wave === w.id), rounds_elapsed: 0, deployed: false
    })).filter(r => r.entities.length > 0);
    if (later.length) {
        const { error: rErr } = await db.from('battle_reinforcements').insert(later);
        if (rErr) alert('Battle launched, but saving the later waves failed: ' + rErr.message);
    }
    await window.refreshPendingReinforcements(true);
    if (window.AudioEngine) window.AudioEngine.playKlaxon();
    const ov = document.getElementById('encounter-stager');
    if (ov) ov.style.display = 'none';
    const panel = document.getElementById('battle-map-panel');
    if (panel && panel.style.display !== 'block' && typeof window.toggleBattleMap === 'function') window.toggleBattleMap();
    else if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return newEnc ? newEnc.id : null;
};

window.refreshPendingReinforcements = async function(force) {
    const enc = window.globalBattleEncounterCache;
    if (currentUserRole !== 'dm' || !enc) { pendingReinforcements = []; pendingReinforcementsEncounterId = null; updatePresetButtons(); return; }
    if (!force && pendingReinforcementsEncounterId === enc.id) { updatePresetButtons(); return; }
    pendingReinforcementsEncounterId = enc.id;
    const { data, error } = await db.from('battle_reinforcements').select('*').eq('encounter_id', enc.id).eq('deployed', false);
    pendingReinforcements = error ? [] : (data || []).slice().sort((a, b) => a.wave - b.wave);
    updatePresetButtons();
};

async function deployReinforcementRow(row) {
    // Claim first so two DM tabs (or a manual click racing the round trigger) can't deploy twice.
    const { data: claimed, error } = await db.from('battle_reinforcements').update({ deployed: true }).eq('id', row.id).eq('deployed', false).select();
    if (error || !claimed || claimed.length === 0) return 0;
    const n = await deployPresetEntities(row.entities || [], row.wave);
    pendingReinforcements = pendingReinforcements.filter(r => r.id !== row.id);
    updatePresetButtons();
    return n;
}
window.deployReinforcementWave = async function(rowId) {
    if (currentUserRole !== 'dm') return;
    const row = pendingReinforcements.find(r => r.id === rowId);
    if (!row) return;
    if (!(await window.showConfirmModal(`Deploy wave ${row.wave} now (${(row.entities || []).length} ships)?`))) return;
    await deployReinforcementRow(row);
    closeWavesPopup();
};

// Round-triggered waves: counted on the DM's browser, which is the only one
// that resolves rounds (2026-09-30). Launch = round 1, so a "round 3" wave
// arrives after the 2nd round tick.
window.onHook('round-tick', 'reinforcement-waves', async () => {
    try {
        if (currentUserRole === 'dm' && window.globalBattleEncounterCache) {
            await window.refreshPendingReinforcements(true);
            for (const row of pendingReinforcements.slice()) {
                const elapsed = (row.rounds_elapsed || 0) + 1;
                await db.from('battle_reinforcements').update({ rounds_elapsed: elapsed }).eq('id', row.id);
                row.rounds_elapsed = elapsed;
                if (row.trigger && row.trigger.type === 'round' && elapsed + 1 >= (row.trigger.round || 2)) await deployReinforcementRow(row);
            }
        }
    } catch (err) { console.error('reinforcement waves: round check failed', err); }
});

/* --- Buttons on the Battle Map (DM + switch only) --- */
function ensurePresetButtons() {
    const dmControls = document.getElementById('battle-map-dm-controls');
    if (dmControls && !document.getElementById('battle-map-presets-btn-idle')) {
        const b = document.createElement('button');
        b.id = 'battle-map-presets-btn-idle';
        b.className = 'layer-edit';
        b.style.cssText = 'width:100%; font-size:10px; margin-top:6px; border-color:#c9962f; color:#c9962f; display:none;';
        b.textContent = '📋 ENCOUNTER PRESETS (stage & launch)';
        b.onclick = () => window.openEncounterStager();
        dmControls.appendChild(b);
    }
    const anchor = document.getElementById('battle-map-end-btn');
    if (anchor && !document.getElementById('battle-map-presets-btn')) {
        const b = document.createElement('button');
        b.id = 'battle-map-presets-btn';
        b.className = 'layer-edit';
        b.style.cssText = 'font-size:9px; padding:3px 8px; display:none; border-color:#c9962f; color:#c9962f;';
        b.textContent = '📋 PRESETS';
        b.onclick = () => window.openEncounterStager();
        anchor.parentNode.insertBefore(b, anchor);
        const w = document.createElement('button');
        w.id = 'battle-map-waves-btn';
        w.className = 'layer-edit';
        w.style.cssText = 'font-size:9px; padding:3px 8px; display:none; border-color:#00e1ff; color:#00e1ff;';
        w.onclick = () => openWavesPopup();
        anchor.parentNode.insertBefore(w, anchor);
    }
}
function updatePresetButtons() {
    ensurePresetButtons();
    const ok = presetsAllowed();
    const enc = window.globalBattleEncounterCache;
    const idle = document.getElementById('battle-map-presets-btn-idle');
    if (idle) idle.style.display = ok && !enc ? 'block' : 'none';
    const pb = document.getElementById('battle-map-presets-btn');
    if (pb) pb.style.display = ok && enc ? 'inline-block' : 'none';
    const wb = document.getElementById('battle-map-waves-btn');
    if (wb) {
        const n = (enc && pendingReinforcementsEncounterId === enc.id) ? pendingReinforcements.length : 0;
        wb.style.display = ok && enc && n > 0 ? 'inline-block' : 'none';
        wb.textContent = `🌊 WAVES (${n})`;
    }
}
function openWavesPopup() {
    closeWavesPopup();
    const box = document.createElement('div');
    box.id = 'battle-waves-popup';
    box.style.cssText = 'position:fixed; inset:0; z-index:5000; background:rgba(3,4,6,0.85); display:flex; align-items:center; justify-content:center;';
    const rows = pendingReinforcements.map(r => {
        const names = (r.entities || []).map(e => describeEntity(e).name);
        const when = r.trigger && r.trigger.type === 'round' ? `arrives automatically at round ${r.trigger.round}` : 'waiting for you';
        return `<div style="border:1px solid #2a3a2a; padding:6px; margin-bottom:6px;"><div style="font-size:11px; color:#00e1ff;">Wave ${r.wave} — ${when}</div>
            <div style="font-size:9px; color:#d4c5a9; margin:3px 0;">${presetEsc(names.join(', '))}</div>
            <button class="btn-deploy" onclick="window.deployReinforcementWave('${r.id}')" style="font-size:9px; margin:0;">🌊 DEPLOY WAVE ${r.wave} NOW</button></div>`;
    }).join('') || '<div style="font-size:10px; color:#6b826a;">No waves waiting.</div>';
    box.innerHTML = `<div class="panel" style="position:relative; width:360px; max-width:92vw; border-color:#00e1ff;"><h4 style="margin-top:0; color:#00e1ff;">Reinforcement waves</h4>${rows}
        <button onclick="document.getElementById('battle-waves-popup').remove()" style="margin-top:6px;">CLOSE</button></div>`;
    box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
    document.body.appendChild(box);
}
function closeWavesPopup() { const b = document.getElementById('battle-waves-popup'); if (b) b.remove(); }

// Keep the buttons in step with every Battle Map render and with switch changes.
window.onBattleMapRender('encounter-presets', () => {
    const enc = window.globalBattleEncounterCache;
    if (currentUserRole === 'dm' && enc && pendingReinforcementsEncounterId !== enc.id) window.refreshPendingReinforcements(false);
    else updatePresetButtons();
}, 10);
document.addEventListener('darkforest:features-changed', updatePresetButtons);

// Full undo (Phase 4a): a manually deployed wave is one undoable step
// (its ships leave the grid and the wave goes back to waiting).
if (typeof window.wrapBattleActionForUndo === 'function') window.wrapBattleActionForUndo('deployReinforcementWave', 'Deploy wave', { rows: true });
