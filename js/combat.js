/* ==========================================================================
   js/combat.js - Tactical Engine, Arsenal & Diagnostics
   ========================================================================== */

const STRIKE_CRAFT_DB = {
    raven: {
        label: "Raven Gen 2 MkIV", base_hp: 200,
        weapons: [
            { name: "Dual .50 Cal Rotary", dice: "2d6", dmgType: "Impact" },
            { name: "Quad Gamma Pulse", dice: "4d6", dmgType: "Heat" },
            { name: "Hunter Seeker Rockets", dice: "4d10", dmgType: "Piercing" },
            { name: "Ship Killer Missiles", dice: "2d12", dmgType: "Impact/Heat", weapon_class: "ordnance" }
        ]
    },
    hawk: {
        label: "Hawk Medium Bomber", base_hp: 350,
        weapons: [
            { name: "Dual 120mm Autocannons", dice: "2d10", dmgType: "Impact" },
            { name: "Micro Railgun", dice: "1d12", dmgType: "Piercing" },
            { name: "Capitol Killer Missiles", dice: "1d20", dmgType: "Piercing", weapon_class: "ordnance" }
        ]
    },
    messenger: {
        label: "Messenger Shuttle", base_hp: 100,
        weapons: [
            { name: "Dual Link .50 Cal", dice: "2d6", dmgType: "Impact" },
            { name: "Hunter Seeker Rockets", dice: "4d10", dmgType: "Piercing" },
            { name: "Point Defense System", dice: "1d4", dmgType: "Impact" }
        ]
    }
};

// Strike Craft Grid Position build (this session): squadron tokens now get a
// real tactical_speed like any other ship_markers row, since they're placed
// as real Battle Map tokens (see spawnSquadronToken below) instead of only
// existing as an Initiative Tracker entry + Hangar Bay panel row. No real
// balance number exists for fighter speed yet -- this is a flagged
// placeholder (2x the capital-ship default of 80), same "flat default the
// DM tunes later" convention as every other first-pass number in this app
// (Battlefield Salvage's 5-ton default, the 24h gather duration, etc.).
// There's currently no live editor for an already-deployed vessel's
// tactical_speed (only set at ship-template deploy time) -- same gap
// applies here, not a new one introduced by this build.
const SQUADRON_TACTICAL_SPEED = 160;

/* --- PERKS & SPECIALIZATIONS ---
   The perk catalog and lookup logic moved to js/perk-designer.js — perks are
   now a real DB-backed catalog (perk_definitions table) instead of a
   hardcoded object here, so DM and players can design/propose new ones
   instead of being limited to whatever's written into this file. See that
   file for window.PERKS_DATA's replacement (perkDefinitionsList) and
   window.getPerkBonusFor's new DB-driven implementation. */


window.sanitizeCargo = function(inv) {
    if (!inv || typeof inv !== 'object' || Object.keys(inv).length === 0) {
        inv = {
            "perishables": [
                { name: "Standard Rations", qty: 90, unit: "Days" },
                { name: "Trauma MedKits", qty: 15, unit: "Crates" }
            ],
            "expendables": [
                { name: "Kinetic Rounds", qty: 500, unit: "Shots" },
                { name: "Energy Cores", qty: 200, unit: "Cells" },
                { name: "Titanium Armor Hull Plates", qty: 50, unit: "Units" }
            ],
            "misc": [
                { name: "Security Marines", qty: 6, unit: "Personnel" },
                { name: "Unprocessed Asteroid Salvage", qty: 3, unit: "Tons" }
            ]
        };
    }
    // Guarantee all three arrays exist even on a non-empty-but-partial
    // object (e.g. hand-edited or legacy cargo missing one field) — every
    // caller of this function (deliverColonyResources, the fleet-group
    // production tick, the cargo UI) reads/pushes into these directly
    // without its own null-guard, so a missing array here would throw a
    // few call sites downstream instead of failing safely right here.
    if (!Array.isArray(inv.perishables)) inv.perishables = [];
    if (!Array.isArray(inv.expendables)) inv.expendables = [];
    if (!Array.isArray(inv.misc)) inv.misc = [];
    if (inv.synth_capacity === undefined) inv.synth_capacity = 10;
    return inv;
};

window.populateCargoVesselSelect = function() {
    const select = document.getElementById('cargo-vessel-select');
    if (!select) return;
    let html = '';
    globalShipMarkersCache.forEach(m => {
        html += `<option value="${m.id}">${m.name} (X: ${Math.round(m.x)}, Y: ${Math.round(m.y)})</option>`;
    });
    select.innerHTML = html || '<option value="">No active vessels found</option>';
};

window.switchCargoSubtab = function(subtab) {
    activeCargoSubtab = subtab;
    document.querySelectorAll('.cargo-subtab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`cargo-subtab-${subtab}`).classList.add('active');
    window.renderTerminalCargoDeck();
};

window.renderTerminalCargoDeck = function() {
    const select = document.getElementById('cargo-vessel-select');
    const container = document.getElementById('terminal-cargo-items-container');
    const title = document.getElementById('cargo-category-title');
    if (!select || !container) return;

    const vesselId = select.value;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);

    if (!vessel) {
        container.innerHTML = '<span style="font-size:11px; color:#6b826a;">Select a valid vessel token above.</span>';
        return;
    }

    const cargo = window.sanitizeCargo(vessel.cargo_inventory);
    const currentCategoryItems = cargo[activeCargoSubtab] || [];

    let subtabNames = { perishables: '🍏 Perishables', expendables: '⚙️ Expendables', misc: '📦 Miscellaneous' };
    if (title) title.innerText = `${subtabNames[activeCargoSubtab]} Holdings`;

    let synthHtml = `
        <div style="background:#0a1410; border:1px solid #00e5a3; padding:8px; margin-bottom:12px; border-radius:2px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <strong style="color:#00e5a3; font-size:12px;">✨ Elder E-M Synthesizer</strong>
                    <div style="font-size:9px; color:#6b826a;">Daily Mass Conversion Capacity (Recharges @ 24h)</div>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    <button onclick="window.modifySynthCapacity('${vessel.id}', -1)" style="padding:2px 8px; font-size:10px;">-1</button>
                    <strong style="color:#00e5a3; font-size:14px; margin:0 10px;">${cargo.synth_capacity} / 10</strong>
                    <button onclick="window.modifySynthCapacity('${vessel.id}', 1)" style="padding:2px 8px; font-size:10px;">+1</button>
                </div>
            </div>
            
            <div style="margin-top:10px; padding-top:8px; border-top:1px dashed #3c4e36; display:flex; gap:6px; align-items:center;">
                <label for="synth-cat-${vessel.id}" style="display:none;">Category</label>
                <select id="synth-cat-${vessel.id}" style="font-size:10px; margin:0; flex:1; background:#040605; color:#00e5a3; border:1px solid #00e5a3;">
                    <option value="expendables">⚙️ Expendables</option>
                    <option value="perishables">🍏 Perishables</option>
                    <option value="misc">📦 Misc</option>
                </select>
                <label for="synth-name-${vessel.id}" style="display:none;">Item</label>
                <input type="text" id="synth-name-${vessel.id}" placeholder="Item to synthesize..." style="font-size:10px; margin:0; flex:2; border:1px solid #00e5a3; background:#030403; color:#00e5a3;">
                <label for="synth-qty-${vessel.id}" style="display:none;">Qty</label>
                <input type="number" id="synth-qty-${vessel.id}" placeholder="Tons" min="1" max="10" value="1" style="font-size:10px; margin:0; flex:0.5; text-align:center; border:1px solid #00e5a3; background:#030403; color:#00e5a3;">
                <button class="btn-reveal" onclick="window.executeSynthesis('${vessel.id}')" style="margin:0; font-size:10px; padding:4px 10px; border-color:#00e5a3; flex:1;">CONVERT MASS</button>
            </div>
        </div>
    `;

    let html = synthHtml;
    
    if (currentCategoryItems.length === 0) {
        html += `<span style="font-size:11px; color:#6b826a;">No cargo items recorded in this section. Use the form on the right to store items.</span>`;
    } else {
        currentCategoryItems.forEach((item, index) => {
            // Cargo items are a plain JSONB array with no stable per-item id
            // (unlike Arsenal/Colonies/etc), so reordering here directly
            // swaps array entries and saves — the array order already IS
            // the persisted data, there's nothing separate to key by.
            const upDisabled = index === 0 ? 'disabled' : '';
            const downDisabled = index === currentCategoryItems.length - 1 ? 'disabled' : '';
            html += `
                <div class="note-card" style="display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:#030403;">
                    <div style="flex:2;">
                        <strong style="color:#00e5a3; font-size:12px;">${item.name}</strong>
                        <div style="font-size:10px; color:#6b826a;">Unit Type: ${item.unit || 'units'}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span class="reorder-arrows">
                            <button type="button" class="reorder-btn" ${upDisabled} onclick="window.moveCargoItem('${vessel.id}', ${index}, 'up')" title="Move up">▲</button>
                            <button type="button" class="reorder-btn" ${downDisabled} onclick="window.moveCargoItem('${vessel.id}', ${index}, 'down')" title="Move down">▼</button>
                        </span>
                        <button onclick="window.modifyCargoQty('${vessel.id}', ${index}, -1)" style="width:24px; padding:2px; font-size:12px; margin:0;">-</button>
                        <label for="cargo-qty-${vessel.id}-${index}" style="display:none;">Quantity</label>
                        <input type="number" id="cargo-qty-${vessel.id}-${index}" value="${item.qty}" onchange="window.updateCargoQtyDirect('${vessel.id}', ${index}, this.value)" style="width:65px; margin:0; text-align:center; font-size:11px; padding:3px;">
                        <button onclick="window.modifyCargoQty('${vessel.id}', ${index}, 1)" style="width:24px; padding:2px; font-size:12px; margin:0;">+</button>
                        <button class="layer-del" onclick="window.removeCargoItem('${vessel.id}', ${index})" style="padding:3px 8px; font-size:10px; margin-left:6px;">X</button>
                    </div>
                </div>
            `;
        });
    }
    container.innerHTML = html;
};

window.executeSynthesis = async function(vesselId) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    
    let cat = document.getElementById(`synth-cat-${vesselId}`).value;
    let name = document.getElementById(`synth-name-${vesselId}`).value.trim();
    let qty = parseInt(document.getElementById(`synth-qty-${vesselId}`).value) || 0;
    
    if (!name) { alert("Please enter a designation for the synthesized material."); return; }
    if (qty <= 0) { alert("Quantity must be at least 1."); return; }
    
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    
    if (cargo.synth_capacity < qty) {
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`Insufficient synthesizer capacity. You need ${qty} Tons, but only have ${cargo.synth_capacity} available.`);
        return;
    }
    
    cargo.synth_capacity -= qty;
    
    if (!cargo[cat]) cargo[cat] = [];
    let existingItem = cargo[cat].find(i => i.name.toLowerCase() === name.toLowerCase());
    
    if (existingItem) {
        existingItem.qty += qty;
    } else {
        cargo[cat].push({ name: name, qty: qty, unit: "Units" });
    }
    
    await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
    vessel.cargo_inventory = cargo;
    
    document.getElementById(`synth-name-${vesselId}`).value = '';
    document.getElementById(`synth-qty-${vesselId}`).value = '1';
    
    activeCargoSubtab = cat;
    window.switchCargoSubtab(cat);
    
    if (window.AudioEngine) window.AudioEngine.playShoot();

    db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `✨ [SYNTHESIS] '${vessel.name}' converted ${qty} Ton(s) of mass into **${name}**.`,
        message_type: 'text'
    });
};

window.modifySynthCapacity = async function(vesselId, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    cargo.synth_capacity = Math.max(0, Math.min(10, cargo.synth_capacity + delta));
    await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
    vessel.cargo_inventory = cargo;
    window.renderTerminalCargoDeck();
};

window.modifyCargoQty = async function(vesselId, itemIndex, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    if (cargo[activeCargoSubtab] && cargo[activeCargoSubtab][itemIndex]) {
        cargo[activeCargoSubtab][itemIndex].qty = Math.max(0, cargo[activeCargoSubtab][itemIndex].qty + delta);
        await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
        vessel.cargo_inventory = cargo;
        window.renderTerminalCargoDeck();
    }
};

window.updateCargoQtyDirect = async function(vesselId, itemIndex, newQty) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    let val = Math.max(0, parseInt(newQty) || 0);
    if (cargo[activeCargoSubtab] && cargo[activeCargoSubtab][itemIndex]) {
        cargo[activeCargoSubtab][itemIndex].qty = val;
        await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
        vessel.cargo_inventory = cargo;
        window.renderTerminalCargoDeck();
    }
};

window.removeCargoItem = async function(vesselId, itemIndex) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    if (!(await window.showConfirmModal("Decommission this cargo item from vessel hold?"))) return;
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    if (cargo[activeCargoSubtab]) {
        cargo[activeCargoSubtab].splice(itemIndex, 1);
        await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
        vessel.cargo_inventory = cargo;
        window.renderTerminalCargoDeck();
    }
};

// Cargo items have no stable id (see renderTerminalCargoDeck) — reorder is
// a direct array-index swap, saved straight to the DB like every other
// cargo mutation here, not the personal localStorage helper used elsewhere.
window.moveCargoItem = async function(vesselId, index, direction) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    const arr = cargo[activeCargoSubtab];
    if (!arr) return;
    const j = direction === 'up' ? index - 1 : index + 1;
    if (j < 0 || j >= arr.length) return;
    [arr[index], arr[j]] = [arr[j], arr[index]];
    await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
    vessel.cargo_inventory = cargo;
    window.renderTerminalCargoDeck();
};

window.addNewCargoEntry = async function() {
    const select = document.getElementById('cargo-vessel-select');
    const category = document.getElementById('new-cargo-category').value;
    const name = document.getElementById('new-cargo-name').value.trim();
    const qty = Math.max(0, parseInt(document.getElementById('new-cargo-qty').value) || 0);
    const unit = document.getElementById('new-cargo-unit').value.trim() || 'units';

    if (!select || !select.value) { alert("Select a vessel token first."); return; }
    if (!name) { alert("Please enter an item name."); return; }

    let vessel = globalShipMarkersCache.find(m => m.id === select.value);
    if (!vessel) return;

    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    if (!cargo[category]) cargo[category] = [];

    cargo[category].push({ name, qty, unit });

    await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vessel.id);
    vessel.cargo_inventory = cargo;

    document.getElementById('new-cargo-name').value = '';
    document.getElementById('new-cargo-qty').value = '1';
    document.getElementById('new-cargo-unit').value = '';

    activeCargoSubtab = category;
    window.switchCargoSubtab(category);
    alert(`Stored ${qty} ${unit} of '${name}' in ${vessel.name} hold.`);
};

window.broadcastTerminalCargoManifest = async function() {
    const select = document.getElementById('cargo-vessel-select');
    if (!select || !select.value) return;
    let vessel = globalShipMarkersCache.find(m => m.id === select.value);
    if (!vessel) return;

    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `📦 [FULL CARGO MANIFEST] Vessel '${vessel.name}' synchronized manifest to fleet telemetry.`,
        message_type: 'text'
    });
    alert("Full cargo manifest broadcasted to Secure Comms!");
};

/* --- VESSEL DECK LOGIC --- */
window.populateVesselDeckSelect = function() {
    const select = document.getElementById('vessel-deck-select');
    if (!select) return;
    let html = '';
    globalShipMarkersCache.forEach(m => {
        html += `<option value="${m.id}">${m.name}</option>`;
    });
    select.innerHTML = html || '<option value="">No active vessels found</option>';
};

window.switchVesselSubtab = function(subtab) {
    document.getElementById('vessel-subtab-core').classList.remove('active');
    document.getElementById('vessel-subtab-hangar').classList.remove('active');
    document.getElementById('vessel-core-view').style.display = 'none';
    document.getElementById('vessel-hangar-view').style.display = 'none';
    
    document.getElementById(`vessel-subtab-${subtab}`).classList.add('active');
    document.getElementById(`vessel-${subtab}-view`).style.display = 'block';
    
    window.renderVesselDeck();
};

window.updateShipStance = async function(shipId, stance) {
    await db.from('ship_markers').update({ ship_stance: stance }).eq('id', shipId);
    let ship = globalShipMarkersCache.find(s => s.id === shipId);
    if(ship) ship.ship_stance = stance;

    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `⚙️ [TACTICS] Vessel '${ship.name}' is now assuming **${stance.toUpperCase()}** stance.`,
        message_type: 'text'
    });
    if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
};

/* --- SHARED SHIP STATUS RENDERERS ---
   Extracted this session so the Vessel Deck (js/combat.js) and the Battle
   Map's full-screen ship-status cards (js/battle-map.js) show identical
   stance/health markup from ONE implementation, not two independently
   maintained copies. No id-lookup dependencies (stance's onchange and the
   health bars' onclick handlers all pass values directly as arguments), so
   these two are safe to reuse verbatim with no prefixing needed — unlike
   the weapon-row renderer below, which DOES need per-caller unique element
   ids since two callers can legitimately render the same weapon's
   target/volley controls into the DOM at once. */
window.renderShipStanceHtml = function(vessel) {
    let currentStance = vessel.ship_stance || 'Balanced';
    return `
        <div style="margin-top:10px; margin-bottom:10px; padding:6px; background:#0a1410; border:1px solid #00e5a3; border-radius:2px; display:flex; justify-content:space-between; align-items:center;">
            <label for="vessel-stance-${vessel.id}" style="font-size:10px; color:#00e5a3; font-weight:bold;">TACTICAL STANCE:</label>
            <select id="vessel-stance-${vessel.id}" onchange="window.updateShipStance('${vessel.id}', this.value)" style="width:160px; margin:0; padding:4px; font-size:10px; background:#040605; color:#00e5a3; border:1px solid #3c4e36;">
                <option value="Balanced" ${currentStance === 'Balanced' ? 'selected' : ''}>Balanced (Standard)</option>
                <option value="Aggressive" ${currentStance === 'Aggressive' ? 'selected' : ''}>Aggressive (+Dmg, -Def)</option>
                <option value="Defensive" ${currentStance === 'Defensive' ? 'selected' : ''}>Defensive (+Def, -Dmg)</option>
                <option value="Evasive" ${currentStance === 'Evasive' ? 'selected' : ''}>Evasive (Dodge Focus)</option>
            </select>
        </div>
    `;
};

// editable=false renders the same 5 bars with no +/-/-10/+10 buttons — used
// for an enemy/NPC vessel's card on the Battle Map, where a player can see
// health but shouldn't be able to adjust it themselves.
window.renderShipHealthBarsHtml = function(vessel, editable) {
    const s_int = vessel.integrity_shields !== undefined ? vessel.integrity_shields : 400;
    const s_max = vessel.max_shields || 400;
    const h_int = vessel.integrity_hull !== undefined ? vessel.integrity_hull : 300;
    const h_max = vessel.max_hull || 300;
    const r_int = vessel.integrity_reactive !== undefined ? vessel.integrity_reactive : 10;
    const r_max = vessel.max_reactive || 10;
    const a_int = vessel.integrity_ablative !== undefined ? vessel.integrity_ablative : 10;
    const a_max = vessel.max_ablative || 10;
    const hd_int = vessel.integrity_hardened !== undefined ? vessel.integrity_hardened : 0;
    const hd_max = vessel.max_hardened || 0;

    const makeBar = (label, current, max, color, key) => `
        <div style="margin-bottom: 8px;">
            <div style="display:flex; justify-content:space-between; font-size:10px; color:${color}; margin-bottom:2px;">
                <strong>${label}</strong>
                <span>${current} / ${max}</span>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                ${editable ? `<button onclick="window.modifyShipHealth('${vessel.id}', '${key}', -10)" style="width:24px; padding:2px; font-size:10px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-10</button>
                <button onclick="window.modifyShipHealth('${vessel.id}', '${key}', -1)" style="width:24px; padding:2px; font-size:12px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-</button>` : ''}
                <div style="flex-grow:1; height:12px; background:#030403; border:1px solid #3c4e36; border-radius:2px; overflow:hidden;">
                    <div style="width:${Math.max(0, Math.min(100, (current/max)*100))}%; height:100%; background:${current === 0 ? '#ff3333' : color}; transition:width 0.3s;"></div>
                </div>
                ${editable ? `<button onclick="window.modifyShipHealth('${vessel.id}', '${key}', 1)" style="width:24px; padding:2px; font-size:12px; margin:0;">+</button>
                <button onclick="window.modifyShipHealth('${vessel.id}', '${key}', 10)" style="width:24px; padding:2px; font-size:10px; margin:0;">+10</button>` : ''}
            </div>
        </div>
    `;

    return makeBar('DEFLECTOR SHIELDS', s_int, s_max, '#00e1ff', 'shields') + makeBar('REACTIVE ARMOR (IMPACT/EXPLOSIVE)', r_int, r_max, '#ffaa00', 'reactive') + makeBar('ABLATIVE ARMOR (HEAT/ENERGY)', a_int, a_max, '#ffaa00', 'ablative') + makeBar('HARDENED ARMOR', hd_int, Math.max(1, hd_max), '#c9962f', 'hardened') + makeBar('HULL INTEGRITY', h_int, h_max, '#ff3333', 'hull');
};

// idPrefix distinguishes this weapon row's target/volley element ids from
// another simultaneous render of the SAME weapon elsewhere in the DOM (the
// Vessel Deck uses '' — unchanged from before this session; the Battle Map
// cards use 'bm-'). showManageButtons hides the ✎ edit / ✕ delete weapon
// buttons — those are weapon-DESIGN actions, out of place on an in-combat
// HUD, so the Battle Map cards render with showManageButtons:false while
// the Vessel Deck (the one place weapons should be edited) keeps them.
window.renderShipWeaponsHtml = function(vessel, opts) {
    opts = opts || {};
    const idPrefix = opts.idPrefix || '';
    const showManageButtons = opts.showManageButtons !== false;
    const weapons = vessel.ship_weapons || [];
    if (weapons.length === 0) return '<span style="font-size:10px; color:#6b826a;">No weapon hardpoints installed.</span>';
    let wHtml = '';
    weapons.forEach((w, idx) => {
        const battleScoped = (typeof window.getBattleScopedTargets === 'function') ? window.getBattleScopedTargets(vessel.id, w.range) : null;
        const targetCandidates = battleScoped || globalShipMarkersCache.filter(m => m.id !== vessel.id);
        let targetOptions = '<option value="">-- No Target --</option>';
        targetCandidates.forEach(m => { targetOptions += `<option value="${m.id}">${m.is_strike_craft ? '🛩️ ' : ''}${m.name}</option>`; });

        let wDmgType = window.normalizeDamageType(w.damage_type || window.inferLegacyDamageType(w.name));
        let wDmgInfo = window.DAMAGE_TYPES[wDmgType];
        let wClass = w.weapon_class === 'ordnance' ? 'ordnance' : 'direct_fire';
        let classBadge = wClass === 'ordnance' ? `<span style="font-size:8px; color:#c778dd; border:1px solid #c778dd; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Ordnance — multi-turn flight, counter-fireable by Point Defense">☠ ORDNANCE</span>` : '';
        let pdBadge = w.is_point_defense ? `<span style="font-size:8px; color:#66d9ff; border:1px solid #66d9ff; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Point Defense — auto-fires at inbound ordnance and engaged strike craft on Advance Round">🛡 PD</span>` : '';
        let rangeBadge = w.range ? `<span style="font-size:8px; color:#6b826a; border:1px solid #3c4e36; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Battle Map targeting range">📏 ${w.range}</span>` : '';

        // Station Designer build: a weapon optionally assigned to a deck is
        // disabled once that deck's HP hits 0 -- see genDeckId/ensureDeckIds
        // above. Fails open (no badge, weapon fires normally) if the
        // assigned deck was since deleted, same "don't corrupt on a stale
        // reference" precedent as this project's other jsonb override links.
        let assignedDeck = w.assigned_deck_id ? (vessel.ship_decks || []).find(d => d.id === w.assigned_deck_id) : null;
        let deckDestroyed = !!(assignedDeck && assignedDeck.hp <= 0);
        let deckBadge = assignedDeck ? `<span style="font-size:8px; color:${deckDestroyed ? '#ff3333' : '#6b826a'}; border:1px solid ${deckDestroyed ? '#ff3333' : '#3c4e36'}; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Tied to the ${assignedDeck.name} deck — a destroyed deck can't fire its assigned weapons">🔧 ${assignedDeck.name}${deckDestroyed ? ' DESTROYED' : ''}</span>` : '';
        let fireDisabledAttr = deckDestroyed ? 'disabled' : '';
        let fireDisabledStyle = deckDestroyed ? ' opacity:0.4; cursor:not-allowed;' : '';
        let fireDisabledTitle = deckDestroyed ? `title="${assignedDeck.name} deck destroyed — cannot fire"` : '';
        wHtml += `
        <div class="note-card" style="padding:8px; margin-bottom:6px; background:#030403; border-color:#ff3333;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                    <strong style="color:#ff6b6b; font-size:12px;">[${w.loc || 'Unmounted'}] ${w.name}</strong>${classBadge}${pdBadge}${rangeBadge}${deckBadge}
                    <div style="font-size:10px; color:#d4c5a9;">${w.dice} ${w.modifier} ${w.explodes ? '💥' : ''} · ${w.gun_count || 1}x Guns · <span class="dmg-tooltip" style="color:${wDmgInfo.color}; cursor:help;" title="${window.getDamageTypeTooltip(wDmgType)}">${wDmgType} ⓘ</span></div>
                </div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <label for="${idPrefix}wpn-target-${vessel.id}-${idx}" style="display:none;">Target</label>
                    <select id="${idPrefix}wpn-target-${vessel.id}-${idx}"
                        onfocus="window.showWeaponRangeRing && window.showWeaponRangeRing('${vessel.id}', ${w.range || 0})"
                        onmouseenter="window.showWeaponRangeRing && window.showWeaponRangeRing('${vessel.id}', ${w.range || 0})"
                        onblur="window.hideWeaponRangeRing && window.hideWeaponRangeRing()"
                        onmouseleave="window.hideWeaponRangeRing && window.hideWeaponRangeRing()"
                        style="width:120px; height:20px; font-size:9px; margin:0; padding:0; background:#0a1410; color:#00e5a3; border:1px solid #3c4e36; border-radius:2px;">${targetOptions}</select>
                    <label for="${idPrefix}wpn-volley-${vessel.id}-${idx}" style="display:none;">Volley</label>
                    <input type="number" id="${idPrefix}wpn-volley-${vessel.id}-${idx}" value="1" min="1" max="${w.gun_count || 1}" title="Volley Count (max ${w.gun_count || 1} guns)" style="width:35px; height:20px; font-size:10px; margin:0; padding:0; text-align:center; border:1px solid #ff6b6b; background:#0a1410; color:#ff6b6b; border-radius:2px;">
                    ${wClass === 'ordnance'
                        ? `<button class="layer-edit" ${fireDisabledAttr} ${fireDisabledTitle} onclick="window.launchOrdnance('${vessel.id}', ${idx}, '${idPrefix}')" style="padding:4px 10px; font-size:10px; border-color:#c778dd; color:#c778dd;${fireDisabledStyle}" ${deckDestroyed ? '' : 'title="Launches a multi-turn payload if this vessel is a token in an active battle; resolves instantly otherwise"'}>LAUNCH</button>`
                        : `<button class="layer-edit" ${fireDisabledAttr} ${fireDisabledTitle} onclick="window.rollShipWeapon('${vessel.id}', ${idx}, '${idPrefix}')" style="padding:4px 10px; font-size:10px; border-color:#ff6b6b; color:#ff6b6b;${fireDisabledStyle}">FIRE</button>`}
                    ${showManageButtons ? `<button class="layer-edit" onclick="window.openEditWeaponModal('${vessel.id}', ${idx})" style="padding:4px 8px; font-size:10px;" title="Edit weapon">✎</button>
                    <button class="layer-del" onclick="window.deleteShipWeapon('${vessel.id}', ${idx})" style="padding:4px 8px; font-size:10px;">✕</button>` : ''}
                </div>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:8px; gap:8px;">
                <div style="flex:1; text-align:center; background:#0a1410; border:1px solid #3c4e36; border-radius:2px; padding:4px;">
                    <div style="font-size:9px; color:#6b826a; margin-bottom:4px;">AMMO: ${w.ammo < 0 ? 'INF' : `${w.ammo}/${w.max_ammo}`}</div>
                    ${w.ammo >= 0 ? `<div style="display:flex; justify-content:center; gap:4px;"><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'ammo', -1)" style="width:20px; padding:2px; margin:0; font-size:10px;">-</button><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'ammo', 1)" style="width:20px; padding:2px; margin:0; font-size:10px;">+</button></div>` : ''}
                </div>
                <div style="flex:1; text-align:center; background:#0a1410; border:1px solid #3c4e36; border-radius:2px; padding:4px;">
                    <div style="font-size:9px; color:#6b826a; margin-bottom:4px;">COOLDOWN: ${w.cooldown || 0}</div>
                    <div style="display:flex; justify-content:center; gap:4px;"><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'cooldown', -1)" style="width:20px; padding:2px; margin:0; font-size:10px;">-</button><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'cooldown', 1)" style="width:20px; padding:2px; margin:0; font-size:10px;">+</button></div>
                </div>
                <div style="flex:1; text-align:center; background:#0a1410; border:1px solid #3c4e36; border-radius:2px; padding:4px;">
                    <div style="font-size:9px; color:#ffaa00; margin-bottom:4px;">OVERHEAT: ${w.overheat || 0}/10</div>
                    <div style="display:flex; justify-content:center; gap:4px;"><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'overheat', -1)" style="width:20px; padding:2px; margin:0; font-size:10px;">-</button><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'overheat', 1)" style="width:20px; padding:2px; margin:0; font-size:10px;">+</button></div>
                </div>
            </div>
        </div>`;
    });
    return wHtml;
};

window.renderVesselDeck = function() {
    const select = document.getElementById('vessel-deck-select');
    if (!select || !select.value) return;

    const vesselId = select.value;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    // Station Designer build: self-heal any legacy decks (created before
    // weapon-deck-gating existed) that lack a stable id — see genDeckId/
    // ensureDeckIds above. Persists once, silently, the first time this
    // vessel's decks are rendered after the fix ships.
    vessel.ship_decks = vessel.ship_decks || [];
    if (window.ensureDeckIds(vessel.ship_decks)) {
        db.from('ship_markers').update({ ship_decks: vessel.ship_decks }).eq('id', vessel.id);
    }

    const healthContainer = document.getElementById('vessel-health-container');
    const decksContainer = document.getElementById('vessel-decks-container');
    const weaponsContainer = document.getElementById('vessel-weapons-container');

    // One-time populate of the static "new weapon" damage-type select — it
    // has no options in index.html's markup since DAMAGE_TYPES lives here in
    // JS, not duplicated into static HTML (same reasoning as the edit modal).
    const newWpnDmgTypeSelect = document.getElementById('new-ship-wpn-dmgtype');
    if (newWpnDmgTypeSelect && newWpnDmgTypeSelect.options.length === 0) {
        newWpnDmgTypeSelect.innerHTML = window.buildDamageTypeOptionsHtml('Impact');
    }

    // Re-populated every render (not one-time like the damage-type select
    // above) since which decks exist can change vessel to vessel and render
    // to render — unlike DAMAGE_TYPES, which is static.
    const newWpnDeckSelect = document.getElementById('new-ship-wpn-deck');
    if (newWpnDeckSelect) {
        const decks = vessel.ship_decks || [];
        newWpnDeckSelect.innerHTML = '<option value="">-- Not deck-gated --</option>' + decks.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
    }

    if (healthContainer) {
        let resetBtn = `<div style="display:flex; gap:6px; margin-bottom:10px;"><button class="btn-reveal" onclick="window.resetShipStats('${vessel.id}')" style="flex:1; font-size:10px; margin:0; border-color:#00e5a3;">↺ RESET COMBAT STATS</button><button class="layer-edit" onclick="window.openEditMaxStatsModal('${vessel.id}')" style="flex:1; font-size:10px; margin:0; border-color:#c9962f; color:#c9962f;">✎ EDIT BASE STATS</button></div>`;

        // Stance selector + health bars are shared with the Battle Map's
        // full-screen ship-status cards (see window.renderShipStanceHtml /
        // window.renderShipHealthBarsHtml below) — one implementation, two
        // call sites, so they can't drift apart. Reset/Edit Base Stats stay
        // Vessel-Deck-only (an admin/setup action, not a combat one).
        healthContainer.innerHTML = window.renderShipStanceHtml(vessel) + resetBtn + window.renderShipHealthBarsHtml(vessel, true);
    }

    if (decksContainer) {
        let dHtml = '';
        const decks = vessel.ship_decks || [];
        if (decks.length === 0) dHtml = '<span style="font-size:10px; color:#6b826a;">No internal decks designated.</span>';
        else {
            const DECK_TYPE_LABELS = { bridge: 'BRIDGE / CIC', engineering: 'ENGINEERING', manufacturing: 'MANUFACTURING', life_support: 'LIFE SUPPORT', hangar: 'HANGAR', weapons: 'WEAPONS', medical: 'MEDICAL', quarters: 'QUARTERS', cargo: 'CARGO', other: 'UNCLASSIFIED' };
            decks.forEach((d, idx) => {
                // Ship decks are a plain JSONB array with no stable per-item
                // id, same situation as cargo — reorder swaps array entries
                // directly and saves, rather than going through the
                // localStorage helper used for id-backed lists.
                const upDisabled = idx === 0 ? 'disabled' : '';
                const downDisabled = idx === decks.length - 1 ? 'disabled' : '';
                const deckType = d.type || 'other';
                const typeLabel = DECK_TYPE_LABELS[deckType] || 'UNCLASSIFIED';
                const bStatus = d.boarding_status || 'secure';
                const bLabel = window.BOARDING_STATUS_LABELS[bStatus] || 'SECURE';
                const bColor = window.BOARDING_STATUS_COLORS[bStatus] || '#00e5a3';
                // Boarding status is DM-adjudicated only — the app tracks the
                // status label, it does not enforce any dice/rules resolution.
                const boardingControl = currentUserRole === 'dm'
                    ? `<button onclick="window.cycleShipDeckBoardingStatus('${vessel.id}', ${idx})" title="Cycle boarding status (DM only)" style="font-size:9px; padding:2px 6px; margin:0; background:#030403; border-color:${bColor}; color:${bColor};">⚔ ${bLabel}</button>`
                    : `<span style="font-size:9px; padding:2px 6px; border:1px solid ${bColor}; color:${bColor}; border-radius:2px;">⚔ ${bLabel}</span>`;
                dHtml += `
                <div style="margin-bottom: 8px; background: #030403; padding: 6px; border: 1px solid #00e1ff; border-radius: 2px;">
                    <div style="display:flex; justify-content:space-between; font-size:10px; color:#00e1ff; margin-bottom:2px;">
                        <strong>${d.name} <span style="font-size:8px; color:#6b826a; font-weight:normal;">[${typeLabel}]</span></strong><span>${d.hp} / ${d.max_hp}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
                        <span class="reorder-arrows">
                            <button type="button" class="reorder-btn" ${upDisabled} onclick="window.moveShipDeckOrder('${vessel.id}', ${idx}, 'up')" title="Move up">▲</button>
                            <button type="button" class="reorder-btn" ${downDisabled} onclick="window.moveShipDeckOrder('${vessel.id}', ${idx}, 'down')" title="Move down">▼</button>
                        </span>
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, -5)" style="width:24px; padding:2px; font-size:10px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-5</button>
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, -1)" style="width:24px; padding:2px; font-size:12px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-</button>
                        <div style="flex-grow:1; height:8px; background:#040605; border:1px solid #3c4e36; border-radius:2px; overflow:hidden;">
                            <div style="width:${Math.max(0, Math.min(100, (d.hp/d.max_hp)*100))}%; height:100%; background:${d.hp === 0 ? '#ff3333' : '#00e1ff'}; transition:width 0.3s;"></div>
                        </div>
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, 1)" style="width:24px; padding:2px; font-size:12px; margin:0;">+</button>
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, 5)" style="width:24px; padding:2px; font-size:10px; margin:0;">+5</button>
                        <button class="layer-del" onclick="window.deleteShipDeck('${vessel.id}', ${idx})" style="padding:2px 6px; font-size:10px; margin:0; margin-left:4px;">✕</button>
                    </div>
                    <div style="display:flex; justify-content:flex-end;">${boardingControl}</div>
                </div>`;
            });
        }
        decksContainer.innerHTML = dHtml;

        // Whole-ship ownership reassignment — DM-only, NOT gated by any
        // specific deck's boarding_status (the DM adjudicates narratively
        // when a boarding action actually culminates in a hull capture).
        const ownershipContainer = document.getElementById('vessel-ownership-container');
        if (ownershipContainer) {
            if (currentUserRole === 'dm') {
                let ownerOptions = '';
                allProfiles.forEach(p => {
                    ownerOptions += `<option value="${p.id}" ${p.id === vessel.owner_id ? 'selected' : ''}>${p.username || 'Commander'}${p.id === vessel.owner_id ? ' (current)' : ''}</option>`;
                });
                ownershipContainer.innerHTML = `
                <div style="background:#030403; padding:8px; border:1px solid #ff6b6b; border-radius:2px; margin-top:10px;">
                    <label for="vessel-ownership-select-${vessel.id}" style="font-size: 9px; color: #ff6b6b;">⚔ BOARDING CAPTURE — Reassign Vessel Ownership (DM only):</label>
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <select id="vessel-ownership-select-${vessel.id}" style="flex:1; margin:0; border-color:#ff6b6b;">${ownerOptions}</select>
                        <button class="layer-del" onclick="window.reassignVesselOwnership('${vessel.id}')" style="flex:0 0 auto; font-size:10px; margin:0;">TRANSFER</button>
                    </div>
                </div>`;
            } else {
                ownershipContainer.innerHTML = '';
            }
        }

        // Battlefield Salvage — Manufacturing-deck post-processing config.
        // Mirrors the fleet_groups production fields exactly (nullable
        // output / zero rate = "not configured", same convention), just
        // scoped to this ship instead of a fleet group. DM or the vessel's
        // own owner can set it; everyone else sees nothing here.
        const salvageContainer = document.getElementById('vessel-salvage-container');
        if (salvageContainer) {
            if (currentUserRole === 'dm' || vessel.owner_id === currentUserId) {
                salvageContainer.innerHTML = `
                <div style="background:#030403; padding:8px; border:1px solid #c9962f; border-radius:2px; margin-top:10px;">
                    <label style="font-size: 9px; color: #c9962f;">⚙ Salvage Processing (Manufacturing deck, scales with its HP%):</label>
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <label for="salvage-proc-output-${vessel.id}" style="display:none;">Output resource</label>
                        <input type="text" id="salvage-proc-output-${vessel.id}" placeholder="Output resource (e.g. Refined Alloys)" value="${vessel.salvage_processing_output || ''}" style="flex:2; margin:0; font-size:9px; padding:3px; border-color:#c9962f;">
                        <label for="salvage-proc-rate-${vessel.id}" style="display:none;">Rate per day</label>
                        <input type="number" id="salvage-proc-rate-${vessel.id}" placeholder="Rate/day" min="0" value="${vessel.salvage_processing_rate || 0}" style="flex:1; margin:0; font-size:9px; padding:3px; text-align:center; border-color:#c9962f;">
                        <button class="layer-edit" onclick="window.saveSalvageProcessingConfig('${vessel.id}')" style="flex:0 0 auto; font-size:9px; margin:0; border-color:#c9962f; color:#c9962f;">SAVE</button>
                    </div>
                    <p style="font-size:8px; color:#6b826a; margin:4px 0 0 0;">Converts "Unprocessed Wreckage Salvage" from this ship's own cargo into the named resource, up to Rate/day (scaled down if the Manufacturing deck is damaged, full rate if no Manufacturing deck is installed). Rate 0 = disabled.</p>
                </div>`;
            } else {
                salvageContainer.innerHTML = '';
            }
        }

        // Manufacturing Bay — start a build order from this vessel's own
        // cargo. Unlike Salvage Processing/Fleet Group Production, a
        // Manufacturing-type deck is a hard requirement here (confirmed
        // design), not just an output-scaling factor — no deck, no builds
        // from this vessel at all. DM or the vessel's own owner only, same
        // permission shape as Salvage Processing. See js/manufacturing.js.
        const mfgContainer = document.getElementById('vessel-manufacturing-container');
        if (mfgContainer) {
            if (currentUserRole === 'dm' || vessel.owner_id === currentUserId) {
                const mfgDeck = (vessel.ship_decks || []).find(d => d.type === 'manufacturing');
                if (!mfgDeck) {
                    mfgContainer.innerHTML = `<div style="background:#030403; padding:8px; border:1px solid #3c4e36; border-radius:2px; margin-top:10px;">
                        <p style="font-size:9px; color:#6b826a; margin:0;">🏭 No Manufacturing-type deck installed — this vessel cannot run build orders.</p>
                    </div>`;
                } else {
                    const myProf = (typeof allProfiles !== 'undefined') ? allProfiles.find(p => p.id === currentUserId) : null;
                    const discountPct = (myProf && typeof window.getManufacturingDiscountPct === 'function') ? window.getManufacturingDiscountPct(myProf.perks) : 0;
                    // Approved-only -- a still-pending proposal (see the
                    // manufacturing_blueprints approval workflow in
                    // js/manufacturing.js) isn't buildable yet.
                    const blueprints = (typeof manufacturingBlueprintsList !== 'undefined') ? manufacturingBlueprintsList.filter(b => b.status !== 'draft') : [];
                    const bpOptions = blueprints.length
                        ? blueprints.map(bp => `<option value="${bp.id}">${bp.name}</option>`).join('')
                        : '<option value="">No approved blueprints yet</option>';
                    const inProgress = (window.globalManufacturingOrdersCache || []).filter(o => o.source_type === 'vessel' && o.vessel_id === vessel.id);
                    let progressHtml = '';
                    inProgress.forEach(o => {
                        const remaining = Math.max(0, (o.started_at_hours || 0) + (o.duration_hours || 0) - (window.universeTimeHours || 0));
                        // This box is already gated to the DM/vessel-owner above, so
                        // anyone seeing it can also cancel from here -- same
                        // window.cancelManufacturingOrder used by the Manufacturing
                        // tab's own dashboard list, just a closer, contextual copy
                        // of the same button.
                        progressHtml += `<div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;"><p style="margin:0; font-size:8px; color:#6b826a;">⏳ Building "${o.blueprint_name}" — ready in ~${remaining.toFixed(1)}h</p><button class="layer-del" onclick="window.cancelManufacturingOrder('${o.id}')" style="flex:0 0 auto; padding:1px 5px; font-size:8px; margin-left:6px;" title="Cancel this build and refund any deducted resources">✕</button></div>`;
                    });
                    // Deck-damage time note -- same display convention as Fleet
                    // Group Production's "Effective: Nx/day (Manufacturing deck
                    // Y%)" line in js/colonies.js, but for TIME instead of an
                    // output rate. Floored at 10% efficiency to match the actual
                    // scaling window.startVesselManufacturingOrder applies.
                    const deckScale = mfgDeck.max_hp > 0 ? Math.max(0.1, mfgDeck.hp / mfgDeck.max_hp) : 1;
                    const deckNote = deckScale < 1 ? ` — <span style="color:#ff9b6b;">Manufacturing deck at ${Math.round(deckScale * 100)}% (builds take ${(1 / deckScale).toFixed(1)}x longer)</span>` : '';
                    mfgContainer.innerHTML = `
                    <div style="background:#030403; padding:8px; border:1px solid #c9962f; border-radius:2px; margin-top:10px;">
                        <label style="font-size: 9px; color: #c9962f;">🏭 Manufacturing Bay (Manufacturing deck installed)${discountPct ? ` — ${discountPct}% perk discount applies` : ''}${deckNote}:</label>
                        <div style="display:flex; gap:6px; margin-top:4px;">
                            <label for="mfg-vessel-blueprint-${vessel.id}" style="display:none;">Blueprint</label>
                            <select id="mfg-vessel-blueprint-${vessel.id}" style="flex:1; margin:0; font-size:9px; padding:3px; border-color:#c9962f;">${bpOptions}</select>
                            <button class="btn-deploy" onclick="window.startVesselManufacturingOrder('${vessel.id}')" style="flex:0 0 auto; font-size:9px; padding:4px 8px; margin:0;">BUILD</button>
                        </div>
                        ${progressHtml}
                    </div>`;
                }
            } else {
                mfgContainer.innerHTML = '';
            }
        }
    }

    if (weaponsContainer) {
        // Shared with the Battle Map's ship-status cards -- see
        // window.renderShipWeaponsHtml above renderVesselDeck. Vessel Deck
        // keeps its plain (unprefixed) element ids and the manage buttons,
        // unchanged from before this session.
        weaponsContainer.innerHTML = window.renderShipWeaponsHtml(vessel, { idPrefix: '', showManageButtons: true });
    }

    const embarkedContainer = document.getElementById('vessel-embarked-container');
    const deployedContainer = document.getElementById('vessel-deployed-container');

    if (embarkedContainer) {
        let eHtml = '';
        const hangar = vessel.ship_hangar || [];
        if (hangar.length === 0) eHtml = '<span style="font-size:10px; color:#6b826a;">No squadrons currently embarked.</span>';
        else {
            hangar.forEach((sq, idx) => {
                let dbStats = STRIKE_CRAFT_DB[sq.type];
                eHtml += `
                <div class="note-card" style="padding:6px; margin-bottom:4px; background:#030403; border-color:#00e1ff; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <strong style="color:#00e1ff; font-size:11px;">${sq.name}</strong>
                        <div style="font-size:9px; color:#6b826a;">${dbStats.label} | Units: ${sq.count} | Max HP: ${dbStats.base_hp * sq.count}</div>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button class="layer-edit" onclick="window.launchSquadron('${vessel.id}', ${idx})" style="padding:4px 10px; font-size:9px; border-color:#00e1ff; color:#00e1ff;">🚀 LAUNCH WING</button>
                        <button class="layer-del" onclick="window.deleteSquadron('${vessel.id}', ${idx}, false)" style="padding:4px 8px; font-size:9px;">✕</button>
                    </div>
                </div>`;
            });
        }
        embarkedContainer.innerHTML = eHtml;
    }

    if (deployedContainer) {
        let targetOptions = '<option value="">-- Target --</option>';
        globalShipMarkersCache.forEach(m => { if(m.id !== vessel.id) targetOptions += `<option value="${m.id}">${m.is_strike_craft ? '🛩️ ' : ''}${m.name}</option>`; });

        let dHtml = '';
        const deployed = vessel.ship_deployed || [];
        if (deployed.length === 0) dHtml = '<span style="font-size:10px; color:#6b826a;">No active flights in sector.</span>';
        else {
            deployed.forEach((sq, idx) => {
                let dbStats = STRIKE_CRAFT_DB[sq.type];
                let wpnOptions = '';
                dbStats.weapons.forEach((w, wIdx) => { wpnOptions += `<option value="${wIdx}">${w.name} (${w.dice})</option>`; });

                dHtml += `
                <div class="note-card" style="padding:8px; margin-bottom:6px; background:#030403; border-color:#ffaa00;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <strong style="color:#ffaa00; font-size:12px;">🛫 ${sq.name}</strong>
                            <div style="font-size:9px; color:#d4c5a9;">${dbStats.label} | Units: ${sq.count} | HP: ${sq.hp} / ${sq.max_hp}</div>
                            <div style="display:flex; align-items:center; gap:4px; margin-top:4px;">
                                <span style="font-size:9px; color:#ff6b6b;">BINGO FUEL LOITER: ${sq.loiter}/4</span>
                                <button onclick="window.modifySquadronLoiter('${vessel.id}', ${idx}, -1)" style="padding:0 4px; font-size:9px;">-</button>
                                <button onclick="window.modifySquadronLoiter('${vessel.id}', ${idx}, 1)" style="padding:0 4px; font-size:9px;">+</button>
                            </div>
                        </div>
                        <div style="display:flex; gap:6px; flex-direction:column; align-items:flex-end;">
                            <button class="layer-edit" onclick="window.recallSquadron('${vessel.id}', ${idx})" style="padding:4px 10px; font-size:9px; border-color:#00e5a3; color:#00e5a3;">RECALL TO HANGAR</button>
                            <button class="layer-del" onclick="window.deleteSquadron('${vessel.id}', ${idx}, true)" style="padding:2px 8px; font-size:8px;">RECORD CASUALTY</button>
                        </div>
                    </div>
                    
                    <div style="margin-top:8px; padding-top:6px; border-top:1px dashed #3c4e36; display:flex; gap:6px; align-items:center;">
                        <label for="sq-wpn-select-${vessel.id}-${idx}" style="display:none;">Weapon</label>
                        <select id="sq-wpn-select-${vessel.id}-${idx}" style="flex:2; height:22px; font-size:9px; margin:0; padding:2px; background:#0a1410; color:#ffaa00; border:1px solid #3c4e36;">${wpnOptions}</select>
                        <label for="sq-target-${vessel.id}-${idx}" style="display:none;">Target</label>
                        <select id="sq-target-${vessel.id}-${idx}" style="flex:1.5; height:22px; font-size:9px; margin:0; padding:2px; background:#0a1410; color:#00e5a3; border:1px solid #3c4e36;">${targetOptions}</select>
                        <button class="layer-edit" onclick="window.rollSquadronWeapon('${vessel.id}', ${idx})" style="flex:1; padding:4px; font-size:9px; border-color:#ffaa00; color:#ffaa00; margin:0;">FIRE</button>
                    </div>
                </div>`;
            });
        }
        deployedContainer.innerHTML = dHtml;
    }

    // Keep the Battle Map's full-screen ship-status cards in sync with
    // anything that just changed here (health, weapons, stance, ammo,
    // cooldown...) — renderVesselDeck is already the "something about a
    // vessel changed" signal every mutating function in this file calls, so
    // hooking in here covers all of them in one place instead of touching
    // ~20 call sites individually. No-ops if the Battle Map isn't open or
    // there's no active encounter (renderBattleMapPanel bails out early).
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};

window.modifyShipHealth = async function(vesselId, key, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    // ECONOMY: Titanium Hull Plate constraint for healing
    if (key === 'hull' && delta > 0) {
        let cargo = vessel.cargo_inventory || window.sanitizeCargo({});
        let expendables = cargo.expendables || [];
        let platesIdx = expendables.findIndex(i => i.name.toLowerCase().includes('hull plate'));
        let cost = Math.ceil(delta / 10);
        
        if (platesIdx >= 0 && expendables[platesIdx].qty >= cost) {
            expendables[platesIdx].qty -= cost;
            cargo.expendables = expendables;
            await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
            vessel.cargo_inventory = cargo;
            
            db.from('chat_logs').insert({
                sender_id: currentUserId,
                content: `🔧 [REPAIR LOG] ${vessel.name} consumed ${cost}x Hull Plate(s) to restore ${delta} Hull Integrity.`,
                message_type: 'text'
            });
            if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
        } else {
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`Cannot repair hull! Requires at least ${cost} Titanium Armor Hull Plate(s) in Expendables cargo.`);
            return;
        }
    }

    let dbKey = 'integrity_' + key;
    let maxKey = 'max_' + key;
    let current = vessel[dbKey] !== undefined ? vessel[dbKey] : 100;
    // Was `vessel[maxKey] || 100` — but max_hardened is legitimately 0 for most
    // ships (no hardened plating installed by default), and 0 is falsy, so that
    // fallback silently let Hardened Armor climb to 100 via the +/- buttons
    // regardless of the ship's actual (often zero) capacity.
    let max = vessel[maxKey] !== undefined ? vessel[maxKey] : 100;

    current = Math.max(0, Math.min(max, current + delta));
    let payload = {}; payload[dbKey] = current;
    
    await db.from('ship_markers').update(payload).eq('id', vesselId);
    vessel[dbKey] = current;
    window.renderVesselDeck();
};

/* --- STRIKE CRAFT MAP/INITIATIVE PRESENCE ---
   The hangar/deployed system above (ship_hangar / ship_deployed JSONB on the
   carrier) is the single source of truth for squadron HP and fuel — it
   already existed and already works. This layer just gives a DEPLOYED
   squadron a companion ship_markers token (visible/selectable on the map)
   and a companion combat_tracker row (visible in Initiative), linked back
   via squadron_id, WITHOUT duplicating fuel/HP into a second place that
   could drift out of sync with the real data on the carrier.

   Strike Craft Grid Position build (this session, confirmed design): a
   squadron's ship_markers token is now ALSO placed onto the active Battle
   Map grid automatically on launch, if a battle is currently active — no
   separate manual placement step, matching the precedent this token/tracker
   spawn already set. Staggered near the carrier's own token if the carrier
   is itself currently placed (window.addSquadronToBattleMap, battle-map.js
   — that file owns all battle_encounters reads/writes, so this delegates
   rather than reaching into that table directly, same cross-file convention
   as window.checkBattleTokenDestroyed/playWeaponFireEffect/launchOrdnance).
   No-op if no battle is active, or if a squadron was already deployed
   before this build shipped — those don't retroactively get a token; recall
   + relaunch picks one up. Flagged, not silently glossed over. */
async function spawnSquadronToken(vessel, sq) {
    const { data: tokenRow, error: tokenError } = await db.from('ship_markers').insert({
        owner_id: vessel.owner_id, name: sq.name,
        x: vessel.x + (Math.random() * 80 - 40), y: vessel.y + (Math.random() * 80 - 40),
        drive_type: 'sublight', color: '#ffaa00', tactical_speed: SQUADRON_TACTICAL_SPEED,
        cargo_inventory: window.sanitizeCargo({}),
        integrity_hull: sq.hp, max_hull: sq.max_hp,
        integrity_shields: 0, max_shields: 0, integrity_reactive: 0, max_reactive: 0,
        integrity_ablative: 0, max_ablative: 0, integrity_hardened: 0, max_hardened: 0,
        parent_id: vessel.id, is_strike_craft: true, squadron_id: sq.id
    }).select().single();
    if (tokenError) { console.error('Failed to spawn squadron token:', tokenError.message); }

    const { error: trackerError } = await db.from('combat_tracker').insert({
        name: sq.name, initiative: 14, hp: `${sq.hp}/${sq.max_hp}`,
        owner_id: vessel.owner_id, parent_id: vessel.id, squadron_id: sq.id, is_strike_craft: true
    });
    if (trackerError) { console.error('Failed to inject squadron into initiative tracker:', trackerError.message); }

    if (!tokenError && tokenRow && typeof window.addSquadronToBattleMap === 'function') {
        await window.addSquadronToBattleMap(vessel, sq, tokenRow.id, SQUADRON_TACTICAL_SPEED);
    }

    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
    if (typeof loadCombatTracker === 'function') loadCombatTracker();
}

async function despawnSquadronToken(squadronId) {
    // Capture the marker's id BEFORE deleting it -- globalShipMarkersCache
    // still holds the pre-delete row at this point (only loadGalaxyData(),
    // called at the end of this function without awaiting, refreshes it),
    // so this is a safe synchronous lookup, not a race.
    const markerRow = globalShipMarkersCache.find(m => m.squadron_id === squadronId && m.is_strike_craft);

    await db.from('ship_markers').delete().eq('squadron_id', squadronId);
    await db.from('combat_tracker').delete().eq('squadron_id', squadronId);

    if (markerRow && typeof window.removeBattleTokenByMarkerId === 'function') {
        await window.removeBattleTokenByMarkerId(markerRow.id);
    }

    if (typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
    if (typeof loadCombatTracker === 'function') loadCombatTracker();
}

// Strike craft tokens got their own integrity_hull as a one-time snapshot at
// spawn time so they could render/take damage like any other ship_markers
// row — but the REAL squadron HP (shown in the carrier's Hangar Bay panel,
// and what bingo-fuel recall/casualty logic reads) lives in the parent's
// ship_deployed[].hp. Without this, damage taken via ship-to-ship weapon
// fire against a strike craft token would silently never reach the actual
// squadron record — exactly the kind of dual-source drift this whole
// system was designed to avoid. Called after any damage resolution against
// a target that turns out to be a strike craft.
async function syncSquadronHpToParent(targetShip) {
    if (!targetShip.is_strike_craft || !targetShip.parent_id || !targetShip.squadron_id) return;
    const parent = globalShipMarkersCache.find(m => m.id === targetShip.parent_id);
    if (!parent) return;
    const deployed = parent.ship_deployed || [];
    const sq = deployed.find(s => s.id === targetShip.squadron_id);
    if (!sq) return;
    sq.hp = Math.max(0, Math.min(sq.max_hp, targetShip.integrity_hull));
    await db.from('ship_markers').update({ ship_deployed: deployed }).eq('id', parent.id);
    parent.ship_deployed = deployed;
    if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
}

window.commissionSquadron = async function() {
    const select = document.getElementById('vessel-deck-select');
    if (!select || !select.value) { alert("Select a vessel to commission to."); return; }
    
    const vesselId = select.value;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    const name = document.getElementById('new-squadron-name').value.trim();
    const type = document.getElementById('new-squadron-type').value;
    const count = parseInt(document.getElementById('new-squadron-size').value) || 4;

    if (!name) { alert("Enter a callsign for this squadron."); return; }

    let hangar = vessel.ship_hangar || [];
    let dbStats = STRIKE_CRAFT_DB[type];
    
    let sqId = 'sq_' + Math.random().toString(36).substr(2, 9);
    hangar.push({
        id: sqId, name: name, type: type, count: count,
        hp: dbStats.base_hp * count, max_hp: dbStats.base_hp * count, loiter: 4
    });

    await db.from('ship_markers').update({ ship_hangar: hangar }).eq('id', vessel.id);
    vessel.ship_hangar = hangar;

    document.getElementById('new-squadron-name').value = '';
    window.renderVesselDeck();
    
    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `🔧 [HANGAR OPS] ${name} (${count}x ${dbStats.label}) commissioned aboard ${vessel.name}.`,
        message_type: 'text'
    });
};

window.launchSquadron = async function(vesselId, idx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let hangar = vessel.ship_hangar || [];
    let deployed = vessel.ship_deployed || [];

    let sq = hangar.splice(idx, 1)[0];
    if (sq) {
        sq.loiter = 4;
        deployed.push(sq);
        await db.from('ship_markers').update({ ship_hangar: hangar, ship_deployed: deployed }).eq('id', vessel.id);
        vessel.ship_hangar = hangar;
        vessel.ship_deployed = deployed;
        window.renderVesselDeck();

        if (window.AudioEngine) window.AudioEngine.playWarp();
        await spawnSquadronToken(vessel, sq);

        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🛫 [FLIGHT OPS] ${sq.name} launched from ${vessel.name}. Cleared hot for 4 turns.`,
            message_type: 'text'
        });
    }
};

window.recallSquadron = async function(vesselId, idx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let hangar = vessel.ship_hangar || [];
    let deployed = vessel.ship_deployed || [];

    let sq = deployed.splice(idx, 1)[0];
    if (sq) {
        hangar.push(sq);
        await db.from('ship_markers').update({ ship_hangar: hangar, ship_deployed: deployed }).eq('id', vessel.id);
        vessel.ship_hangar = hangar;
        vessel.ship_deployed = deployed;
        window.renderVesselDeck();
        await despawnSquadronToken(sq.id);

        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🛬 [FLIGHT OPS] ${sq.name} recovered to ${vessel.name} hangar bay.`,
            message_type: 'text'
        });
    }
};

window.deleteSquadron = async function(vesselId, idx, isDeployed) {
    if (!(await window.showConfirmModal(isDeployed ? "Record this squadron as destroyed in combat?" : "Decommission this squadron from the hangar?"))) return;
    
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let targetArray = isDeployed ? (vessel.ship_deployed || []) : (vessel.ship_hangar || []);
    let sq = targetArray.splice(idx, 1)[0];

    let updatePayload = isDeployed ? { ship_deployed: targetArray } : { ship_hangar: targetArray };
    await db.from('ship_markers').update(updatePayload).eq('id', vesselId);
    
    if (isDeployed) vessel.ship_deployed = targetArray;
    else vessel.ship_hangar = targetArray;

    if (isDeployed && sq) await despawnSquadronToken(sq.id);

    window.renderVesselDeck();

    if (isDeployed && sq) {
        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `💥 [KIA REPORT] ${sq.name} destroyed in combat.`,
            message_type: 'text'
        });
    }
};

window.modifySquadronLoiter = async function(vesselId, idx, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let deployed = vessel.ship_deployed || [];
    if (deployed[idx]) {
        deployed[idx].loiter = Math.max(0, Math.min(10, deployed[idx].loiter + delta));
        await db.from('ship_markers').update({ ship_deployed: deployed }).eq('id', vesselId);
        vessel.ship_deployed = deployed;
        window.renderVesselDeck();
    }
};

window.modifyShipWeaponStat = async function(vesselId, idx, statKey, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel || !vessel.ship_weapons || !vessel.ship_weapons[idx]) return;
    let wpn = vessel.ship_weapons[idx];
    
    if (statKey === 'ammo' && wpn.ammo >= 0) wpn.ammo = Math.max(0, Math.min(wpn.max_ammo, wpn.ammo + delta));
    if (statKey === 'cooldown') wpn.cooldown = Math.max(0, wpn.cooldown + delta);
    if (statKey === 'overheat') wpn.overheat = Math.max(0, Math.min(10, wpn.overheat + delta));
    
    const { error } = await db.from('ship_markers').update({ ship_weapons: vessel.ship_weapons }).eq('id', vesselId);
    if (error) console.error("Weapon stat sync failed:", error);
    window.renderVesselDeck();
};

window.resetShipStats = async function(vesselId) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    if (!(await window.showConfirmModal("Restore maximum health profiles and resupply all ammunition banks for this vessel?"))) return;
    
    let payload = {
        integrity_shields: vessel.max_shields || 400,
        integrity_hull: vessel.max_hull || 300,
        integrity_reactive: vessel.max_reactive || 10,
        integrity_ablative: vessel.max_ablative || 10,
        integrity_hardened: vessel.max_hardened || 0
    };
    Object.assign(vessel, payload);
    
    if (vessel.ship_weapons) {
        vessel.ship_weapons.forEach(w => { 
            if(w.ammo >= 0) w.ammo = w.max_ammo; 
            w.cooldown = 0; 
            w.overheat = 0; 
        });
        payload.ship_weapons = vessel.ship_weapons;
    }
    
    await db.from('ship_markers').update(payload).eq('id', vesselId);
    window.renderVesselDeck();
    if (typeof window.showToast === 'function') window.showToast("Vessel combat stats reset to maximums.");
    else alert("Vessel combat stats reset to maximums.");
};

/* --- EDIT VESSEL BASE STATS ---
   There was no way to set a deployed ship's MAX stats at all — only current
   values via the +/- buttons, which are clamped TO the max but never let you
   change what that max actually is. Every ship not spawned from the Jupiter
   preset or a Ship Designer template had max_hardened stuck at 0 with no way
   to give it real Hardened Armor capacity post-deployment. */
(function() {
    let overlay, currentId;
    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'maxstats-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:360px; max-width:92vw; border-color:#c9962f;">
            <h4 style="color:#c9962f; margin-top:0;">Edit Vessel Base Stats</h4>
            <p style="font-size:9px; color:#6b826a; margin-top:0;">Changes the ship's maximum values. Current values are clamped down if they'd otherwise exceed the new max.</p>
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="maxstats-shields" style="font-size:9px; color:#6b826a;">Shields</label><input type="number" id="maxstats-shields" min="0" style="border-color:#c9962f; text-align:center;"></div>
                <div style="flex:1;"><label for="maxstats-hull" style="font-size:9px; color:#6b826a;">Hull</label><input type="number" id="maxstats-hull" min="0" style="border-color:#c9962f; text-align:center;"></div>
            </div>
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="maxstats-reactive" style="font-size:9px; color:#6b826a;">Reactive</label><input type="number" id="maxstats-reactive" min="0" style="border-color:#c9962f; text-align:center;"></div>
                <div style="flex:1;"><label for="maxstats-ablative" style="font-size:9px; color:#6b826a;">Ablative</label><input type="number" id="maxstats-ablative" min="0" style="border-color:#c9962f; text-align:center;"></div>
                <div style="flex:1;"><label for="maxstats-hardened" style="font-size:9px; color:#6b826a;">Hardened</label><input type="number" id="maxstats-hardened" min="0" style="border-color:#c9962f; text-align:center;"></div>
            </div>
            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="maxstats-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="maxstats-save-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#c9962f; color:#c9962f;">SAVE CHANGES</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('maxstats-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('maxstats-save-btn').addEventListener('click', async () => {
            const vessel = globalShipMarkersCache.find(m => m.id === currentId);
            if (!vessel) { overlay.style.display = 'none'; return; }
            const newMax = {
                max_shields: parseInt(document.getElementById('maxstats-shields').value) || 0,
                max_hull: parseInt(document.getElementById('maxstats-hull').value) || 0,
                max_reactive: parseInt(document.getElementById('maxstats-reactive').value) || 0,
                max_ablative: parseInt(document.getElementById('maxstats-ablative').value) || 0,
                max_hardened: parseInt(document.getElementById('maxstats-hardened').value) || 0
            };
            const clamped = {
                integrity_shields: Math.min(vessel.integrity_shields !== undefined ? vessel.integrity_shields : newMax.max_shields, newMax.max_shields),
                integrity_hull: Math.min(vessel.integrity_hull !== undefined ? vessel.integrity_hull : newMax.max_hull, newMax.max_hull),
                integrity_reactive: Math.min(vessel.integrity_reactive !== undefined ? vessel.integrity_reactive : newMax.max_reactive, newMax.max_reactive),
                integrity_ablative: Math.min(vessel.integrity_ablative !== undefined ? vessel.integrity_ablative : newMax.max_ablative, newMax.max_ablative),
                integrity_hardened: Math.min(vessel.integrity_hardened !== undefined ? vessel.integrity_hardened : newMax.max_hardened, newMax.max_hardened)
            };
            const { error } = await db.from('ship_markers').update({ ...newMax, ...clamped }).eq('id', currentId);
            if (error) { alert("Failed to save base stats: " + error.message); return; }
            Object.assign(vessel, newMax, clamped);
            overlay.style.display = 'none';
            window.renderVesselDeck();
        });
    }
    window.openEditMaxStatsModal = function(vesselId) {
        const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
        if (!vessel) return;
        ensureModal();
        currentId = vesselId;
        document.getElementById('maxstats-shields').value = vessel.max_shields || 0;
        document.getElementById('maxstats-hull').value = vessel.max_hull || 0;
        document.getElementById('maxstats-reactive').value = vessel.max_reactive || 0;
        document.getElementById('maxstats-ablative').value = vessel.max_ablative || 0;
        document.getElementById('maxstats-hardened').value = vessel.max_hardened || 0;
        overlay.style.display = 'flex';
    };
})();

window.rollSquadronWeapon = async function(vesselId, sqIdx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let sq = (vessel.ship_deployed || [])[sqIdx];
    if (!sq) return;

    let wpnIdx = document.getElementById(`sq-wpn-select-${vesselId}-${sqIdx}`).value;
    let targetId = document.getElementById(`sq-target-${vesselId}-${sqIdx}`).value;
    
    let dbStats = STRIKE_CRAFT_DB[sq.type];
    let wpn = dbStats.weapons[wpnIdx];
    if (!wpn) return;

    let volleys = sq.count;
    if (volleys <= 0) return;

    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = wpn.dice.trim().match(diceRegex);
    if (!match) return;

    let baseNumDice = parseInt(match[1]) || 1;
    let numDice = baseNumDice * volleys;
    let diceFaces = parseInt(match[2]);

    let canExplode = wpn.explodes && diceFaces >= 2;

    let total = 0;
    let breakdown = [];

    for (let i = 0; i < numDice; i++) {
        let rollTotal = 0;
        let subRolls = [];
        let currentRoll;
        do {
            currentRoll = Math.floor(Math.random() * diceFaces) + 1;
            rollTotal += currentRoll;
            subRolls.push(currentRoll);
        } while (currentRoll === diceFaces && canExplode);
        total += rollTotal;
        breakdown.push(`(d${diceFaces}: ${subRolls.join('💥')})`);
    }

    const breakdownText = breakdown.join(' + ');

    let targetShip = null;
    let combatLog = ``;
    let dmgType = window.normalizeDamageType(wpn.dmgType || 'Impact');

    if (targetId) {
        targetShip = globalShipMarkersCache.find(m => m.id === targetId);
        if (targetShip) {
            let tStance = targetShip.ship_stance || 'Balanced';
            if (tStance === 'Defensive') { total = Math.floor(total * 0.75); combatLog += `[Target Defensive: -25% Dmg] `; }
            if (tStance === 'Evasive') { total = Math.floor(total * 0.50); combatLog += `[Target Evasive: -50% Dmg] `; }
            if (tStance === 'Aggressive') { total = Math.floor(total * 1.25); combatLog += `[Target Aggressive: +25% Dmg] `; }

            let categoryMult = 1;
            if (dmgType !== 'Healing') {
                if (targetShip.is_strike_craft) {
                    categoryMult = (dmgType === 'Flak') ? 2 : 0.5;
                    combatLog += `[TARGET: STRIKE CRAFT] ${dmgType} effectiveness x${categoryMult}. `;
                } else if (dmgType === 'Flak') {
                    categoryMult = 0.4;
                    combatLog += `[TARGET: SHIP] Flak is a poor fit for capital-scale armor (x${categoryMult}). `;
                }
            }
            total = Math.ceil(total * categoryMult);

            const result = window.resolveShipDamage(targetShip, dmgType, total);
            combatLog += result.log;

            await db.from('ship_markers').update({
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened
            }).eq('id', targetShip.id);
            Object.assign(targetShip, {
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened
            });
            await syncSquadronHpToParent(targetShip);

            // Tactical Battle Map: if this target is a token in the active
            // battle and just hit 0 hull, auto-withdraw its token (does not
            // touch this ship_markers row itself). No-op outside a battle.
            if (typeof window.checkBattleTokenDestroyed === 'function') await window.checkBattleTokenDestroyed(targetShip);

            // Strike Craft Grid Position build (this session): a beam flash
            // between the squadron's own token and its target, same
            // playWeaponFireEffect used by rollShipWeapon — no longer
            // deliberately skipped now that squadrons have a real token to
            // draw the beam from. Local-only, same flagged limitation as
            // ship-weapon fire (no broadcast channel exists in this
            // codebase — see the Animation Engine checkpoint).
            if (typeof window.playWeaponFireEffect === 'function') {
                const sqShipSelf = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
                if (sqShipSelf) {
                    const beamColor = (window.DAMAGE_TYPES[dmgType] && window.DAMAGE_TYPES[dmgType].color) || '#ffaa00';
                    window.playWeaponFireEffect(sqShipSelf.id, targetShip.id, beamColor);
                }
            }

            // Range/Ordnance build (prior session): persist which target this
            // squadron last fired at. Strike Craft Grid Position build (this
            // session): Point Defense no longer reads this as a position
            // stand-in — squadrons now have a real Battle Map token, so PD
            // checks that directly (see window.processBattleRoundAutomations,
            // js/battle-map.js). Kept as a harmless "last engaged" record,
            // not currently read by anything else.
            sq.target_id = targetShip.id;
            await db.from('ship_markers').update({ ship_deployed: vessel.ship_deployed }).eq('id', vessel.id);
        }
    }

    let targetString = targetShip ? ` at ${targetShip.name}` : ``;
    let breakdownString = `
        <div style="margin-top:4px; padding:4px; border-left:2px solid #ffaa00; background:rgba(255,170,0,0.1);">
            <strong>Damage Type:</strong> ${dmgType}<br>
            <strong>Base Output:</strong> ${breakdownText} = <strong style="color:#ff3333;">${total} Dmg</strong><br>
            ${targetShip ? `<strong>Target Report:</strong> ${combatLog}` : ''}
        </div>
    `;

    if (window.AudioEngine) window.AudioEngine.playShoot();

    if(typeof window.broadcastRoll === 'function') {
        await window.broadcastRoll(`[${sq.name}] FIRES ${wpn.name} (x${volleys})${targetString}`, breakdownString, total);
    }
};

window.rollShipWeapon = async function(vesselId, idx, idPrefix) {
    idPrefix = idPrefix || '';
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let wpn = (vessel.ship_weapons || [])[idx];
    if (!wpn) return;

    // Station Designer build: a weapon tied to a deck can't fire once that
    // deck's HP hits 0. The badge in renderShipWeaponsHtml is purely visual
    // (and disables the button) — this is the authoritative check, since the
    // button-disable can be bypassed by a stale render. Fails open if the
    // assigned deck no longer exists (same "don't corrupt on a stale
    // reference" precedent as elsewhere in this app).
    if (wpn.assigned_deck_id) {
        const assignedDeck = (vessel.ship_decks || []).find(d => d.id === wpn.assigned_deck_id);
        if (assignedDeck && assignedDeck.hp <= 0) {
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`[DECK DESTROYED] ${wpn.name} is mounted on the ${assignedDeck.name} deck, which has been destroyed and can no longer fire.`);
            return;
        }
    }

    let volleyInput = document.getElementById(`${idPrefix}wpn-volley-${vesselId}-${idx}`);
    let volleys = volleyInput ? (parseInt(volleyInput.value) || 1) : 1;
    let targetSelect = document.getElementById(`${idPrefix}wpn-target-${vesselId}-${idx}`);
    let targetId = targetSelect ? targetSelect.value : null;

    let gunCount = wpn.gun_count || 1;
    if (volleys > gunCount) {
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[MOUNT LIMIT] ${wpn.name} has ${gunCount} gun(s) installed — cannot fire a volley of ${volleys}.`);
        return;
    }

    if (wpn.cooldown > 0) {
        if (!(await window.showConfirmModal(`[WARNING] ${wpn.name} is on cooldown! Firing will OVERRIDE and generate OVERHEAT. Proceed?`))) return;
        wpn.overheat = Math.min(10, (wpn.overheat || 0) + 1);
    } 
    
    if (wpn.ammo === 0) {
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[EMPTY] ${wpn.name} is out of ammunition!`); 
        return;
    }

    if (wpn.ammo > 0) {
        if (wpn.ammo < volleys) {
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`[INSUFFICIENT AMMO] ${wpn.name} only has ${wpn.ammo} uses left!`);
            return;
        }
        wpn.ammo -= volleys; 
    }

    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = wpn.dice.trim().match(diceRegex);
    if (!match) { alert("Invalid dice format."); return; }

    let baseNumDice = parseInt(match[1]) || 1;
    let numDice = baseNumDice * volleys;
    let diceFaces = parseInt(match[2]);
    let modVal = (parseInt(wpn.modifier) || 0) * volleys;

    let canExplode = wpn.explodes && diceFaces >= 2;

    let total = 0;
    let breakdown = [];

    for (let i = 0; i < numDice; i++) {
        let rollTotal = 0;
        let subRolls = [];
        let currentRoll;
        do {
            currentRoll = Math.floor(Math.random() * diceFaces) + 1;
            rollTotal += currentRoll;
            subRolls.push(currentRoll);
        } while (currentRoll === diceFaces && canExplode);
        
        total += rollTotal;
        breakdown.push(`(d${diceFaces}: ${subRolls.join('💥')})`);
    }

    total += modVal;
    
    let stance = vessel.ship_stance || 'Balanced';
    if (stance === 'Aggressive') { total = Math.floor(total * 1.25); breakdown.push(`[Aggressive: +25%]`); } 
    else if (stance === 'Defensive') { total = Math.floor(total * 0.75); breakdown.push(`[Defensive: -25%]`); }

    if (modVal !== 0) breakdown.push(`[Mod: ${modVal >= 0 ? '+' : ''}${modVal}]`);
    const breakdownText = breakdown.join(' + ');
    
    let targetShip = null;
    let combatLog = ``;
    let dmgType = window.normalizeDamageType(wpn.damage_type || window.inferLegacyDamageType(wpn.name));

    if (targetId) {
        targetShip = globalShipMarkersCache.find(m => m.id === targetId);
        if (targetShip) {
            let tStance = targetShip.ship_stance || 'Balanced';
            if (tStance === 'Defensive') { total = Math.floor(total * 0.75); combatLog += `[Target Defensive: -25% Dmg] `; }
            if (tStance === 'Evasive') { total = Math.floor(total * 0.50); combatLog += `[Target Evasive: -50% Dmg] `; }
            if (tStance === 'Aggressive') { total = Math.floor(total * 1.25); combatLog += `[Target Aggressive: +25% Dmg] `; }

            let categoryMult = 1;
            if (dmgType !== 'Healing') {
                if (targetShip.is_strike_craft) {
                    categoryMult = (dmgType === 'Flak') ? 2 : 0.5;
                    combatLog += `[TARGET: STRIKE CRAFT] ${dmgType} effectiveness x${categoryMult}. `;
                } else if (dmgType === 'Flak') {
                    categoryMult = 0.4;
                    combatLog += `[TARGET: SHIP] Flak is a poor fit for capital-scale armor (x${categoryMult}). `;
                }
            }
            total = Math.ceil(total * categoryMult);

            const result = window.resolveShipDamage(targetShip, dmgType, total);
            combatLog += result.log;

            await db.from('ship_markers').update({
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened
            }).eq('id', targetShip.id);
            Object.assign(targetShip, {
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened
            });
            await syncSquadronHpToParent(targetShip);

            // Tactical Battle Map: if this target is a token in the active
            // battle and just hit 0 hull, auto-withdraw its token (does not
            // touch this ship_markers row itself). No-op outside a battle.
            if (typeof window.checkBattleTokenDestroyed === 'function') await window.checkBattleTokenDestroyed(targetShip);

            // Animation Engine build (this session): a brief beam flash on
            // the Battle Map grid between firer and target, colored by this
            // shot's damage type. window.playWeaponFireEffect no-ops
            // silently if the Battle Map isn't open or either vessel isn't
            // currently a token in an active battle, so this is safe to
            // call unconditionally. Local-only — see the checkpoint notes
            // for why this doesn't sync to other connected viewers the way
            // the in-flight-ordnance animation does.
            if (typeof window.playWeaponFireEffect === 'function') {
                const beamColor = (window.DAMAGE_TYPES[dmgType] && window.DAMAGE_TYPES[dmgType].color) || '#ff3333';
                window.playWeaponFireEffect(vesselId, targetShip.id, beamColor);
            }
        }
    }

    await db.from('ship_markers').update({ ship_weapons: vessel.ship_weapons }).eq('id', vesselId);
    window.renderVesselDeck();

    let volleyTag = volleys > 1 ? ` (x${volleys} Volley)` : '';
    let targetString = targetShip ? ` at ${targetShip.name}` : ` into the void`;
    let breakdownString = `
        <div style="margin-top:4px; padding:4px; border-left:2px solid #ffaa00; background:rgba(255,170,0,0.1);">
            <strong>Damage Type:</strong> ${dmgType}<br>
            <strong>Base Output:</strong> ${breakdownText} = <strong style="color:#ff3333;">${total} Dmg</strong><br>
            ${targetShip ? `<strong>Target Report:</strong> ${combatLog}` : ''}
        </div>`;
        
    if (window.AudioEngine) window.AudioEngine.playShoot();

    if(typeof window.broadcastRoll === 'function') {
        await window.broadcastRoll(`[${vessel.name}] FIRES [${wpn.loc || 'Mount'}]${volleyTag}${targetString}`, breakdownString, total);
    }
};

/* Station Designer build (this session): weapons can optionally be tied to a
   specific deck (assigned_deck_id on the ship_weapons entry), so a destroyed
   deck disables its assigned weapons -- the lightweight "independently-
   destroyable section" mechanic confirmed for stations, reusing the existing
   ship_decks HP tracking rather than a new sub-entity model. Needs a STABLE
   id per deck (array index isn't safe -- moveShipDeckOrder already reorders
   entries, which would silently reassign a weapon to a different deck).
   ship_decks predates this and has no id field, so genDeckId/ensureDeckIds
   self-heal legacy decks the same way this project already handles legacy
   hyperlane nodes: an id is added the first time a deck is touched (any
   render pass here or in ship-designer.js's loadout modal) and persisted,
   rather than requiring every existing deck to be manually re-created. */
function genDeckId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('deck-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}
window.genDeckId = genDeckId;
window.ensureDeckIds = function(decks) {
    let changed = false;
    (decks || []).forEach(d => { if (!d.id) { d.id = genDeckId(); changed = true; } });
    return changed;
};

window.addShipDeck = async function() {
    const select = document.getElementById('vessel-deck-select');
    const name = document.getElementById('new-deck-name').value.trim();
    let maxHp = parseInt(document.getElementById('new-deck-hp').value) || 50;
    const typeSelect = document.getElementById('new-deck-type');
    const type = typeSelect ? typeSelect.value : 'other';

    if (!select || !select.value) { alert("Select a diagnostic target vessel first."); return; }
    if (!name) { alert("Please enter a deck or system name."); return; }

    let vessel = globalShipMarkersCache.find(m => m.id === select.value);
    if (!vessel) return;

    let decks = vessel.ship_decks || [];
    decks.push({ name: name, hp: maxHp, max_hp: maxHp, type: type, boarding_status: 'secure', id: genDeckId() });

    await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vessel.id);
    vessel.ship_decks = decks;

    document.getElementById('new-deck-name').value = '';
    document.getElementById('new-deck-hp').value = '50';
    if (typeSelect) typeSelect.value = 'other';
    window.renderVesselDeck();
};

window.modifyShipDeckHealth = async function(vesselId, idx, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let decks = vessel.ship_decks || [];
    if (decks[idx]) {
        let current = decks[idx].hp;
        let max = decks[idx].max_hp;
        decks[idx].hp = Math.max(0, Math.min(max, current + delta));
        
        await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vesselId);
        vessel.ship_decks = decks;
        window.renderVesselDeck();
    }
};

window.deleteShipDeck = async function(vesselId, idx) {
    if (!(await window.showConfirmModal("Scrap this internal deck?"))) return;
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let decks = vessel.ship_decks || [];
    decks.splice(idx, 1);

    await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vesselId);
    vessel.ship_decks = decks;
    window.renderVesselDeck();
};

window.moveShipDeckOrder = async function(vesselId, idx, direction) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let decks = vessel.ship_decks || [];
    const j = direction === 'up' ? idx - 1 : idx + 1;
    if (j < 0 || j >= decks.length) return;
    [decks[idx], decks[j]] = [decks[j], decks[idx]];
    await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vesselId);
    vessel.ship_decks = decks;
    window.renderVesselDeck();
};

/* --- BOARDING ACTION SYSTEM (prototype) ---
   DM-narrated, app-tracked-only: no automated dice or rules enforcement.
   Per-deck boarding_status cycles Secure -> Contested -> Captured -> Secure.
   Whole-ship ownership transfer is a SEPARATE, DM-only action below —
   it is not gated by any specific deck's boarding_status, since the DM
   adjudicates when a boarding action actually results in a hull capture. */
window.BOARDING_STATUS_CYCLE = ['secure', 'contested', 'captured'];
window.BOARDING_STATUS_LABELS = { secure: 'SECURE', contested: 'CONTESTED', captured: 'CAPTURED' };
window.BOARDING_STATUS_COLORS = { secure: '#00e5a3', contested: '#ffaa00', captured: '#ff3333' };

window.cycleShipDeckBoardingStatus = async function(vesselId, idx) {
    if (currentUserRole !== 'dm') return;
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let decks = vessel.ship_decks || [];
    if (!decks[idx]) return;

    const cycle = window.BOARDING_STATUS_CYCLE;
    const current = decks[idx].boarding_status || 'secure';
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
    decks[idx].boarding_status = next;

    await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vesselId);
    vessel.ship_decks = decks;
    window.renderVesselDeck();
};

window.reassignVesselOwnership = async function(vesselId) {
    if (currentUserRole !== 'dm') return;
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    const select = document.getElementById(`vessel-ownership-select-${vesselId}`);
    if (!select || !select.value) { alert("Select a new owner first."); return; }
    const newOwnerId = select.value;
    if (newOwnerId === vessel.owner_id) return;

    const newOwnerName = allProfiles.find(p => p.id === newOwnerId)?.username || 'Commander';

    if (!(await window.showConfirmModal(`Transfer ownership of "${vessel.name}" to ${newOwnerName}? This represents a completed boarding capture.`))) return;

    await db.from('ship_markers').update({ owner_id: newOwnerId }).eq('id', vesselId);
    vessel.owner_id = newOwnerId;

    try {
        await db.from('chat_logs').insert({
            sender_id: null,
            content: `⚔️ BOARDING RESOLVED: "${vessel.name}" has been captured — ownership transferred to ${newOwnerName}.`,
            message_type: 'system'
        });
    } catch (e) { /* chat log is best-effort, don't block the transfer on it */ }

    window.renderVesselDeck();
    if (typeof window.showToast === 'function') window.showToast(`Ownership of ${vessel.name} transferred.`);
};

/* Inject Ammo / Gun Count / Damage Type fields into the "Mount New Weapon System"
   form. These fields didn't exist in the HTML at all (the ammo field was being
   looked up by addShipWeapon() but never rendered), and there was no way to set
   damage type or gun count when installing a weapon. Anchored off the exploding-dice
   checkbox, which is guaranteed to exist, so this works without touching index.html. */

/* --- 12-TIER DAMAGE TYPE MATRIX ---
   Single source of truth for every damage-type dropdown, tooltip, and the
   combat cascade resolution in rollShipWeapon(). Defense layer order is:
   Shields -> Reactive Armor -> Ablative Armor -> Hardened Armor -> Hull.
   blockedBy: array of layers that fully negate the hit (consumes a charge
   at whichever of those layers the damage reaches first). Empty array means
   nothing blocks it outright.
   bypassesLayers: skips straight past those layers as if they weren't there.
   hullMult: multiplier applied once damage actually reaches Hull.
   shieldMode: 'normal' | 'antimatter' (partial bypass) | 'ion' (double dmg
   to shields, minimal hull dmg) | 'exotic' (only thing shields fully stop). */
window.DAMAGE_TYPES = {
    'Impact':    { color: '#d4c5a9', blockedBy: ['reactive'], bypassesLayers: [], hullMult: 1, shieldMode: 'normal',
        desc: 'Standard kinetic ordnance — the baseline most weapons default to.', shreds: 'Unarmored hull, light craft', mitigatedBy: 'Reactive Armor' },
    'Piercing':  { color: '#ffaa00', blockedBy: [], bypassesLayers: ['reactive', 'ablative'], hullMult: 1, shieldMode: 'normal',
        desc: 'Armor-defeating penetrators engineered to punch through countermeasures.', shreds: 'Reactive & Ablative Armor — ignores both entirely', mitigatedBy: 'Hardened Armor, Hull' },
    'Explosive': { color: '#ff6b6b', blockedBy: ['reactive'], bypassesLayers: [], hullMult: 1, shieldMode: 'normal',
        desc: 'Warheads detonating on impact for wide-area kinetic shock.', shreds: 'Unarmored hull, strike craft formations', mitigatedBy: 'Reactive Armor' },
    'Flak':      { color: '#ffe066', blockedBy: [], bypassesLayers: [], hullMult: 1, shieldMode: 'normal',
        desc: 'Proximity-fused shrapnel bursts built to shred small, fast, fragile targets.', shreds: 'Strike Craft — devastating vs fighters/bombers', mitigatedBy: 'Capital-scale Hull (weak vs Ships)' },
    'Energy':    { color: '#00e1ff', blockedBy: ['ablative'], bypassesLayers: [], hullMult: 1, shieldMode: 'normal',
        desc: 'Directed-energy beams and pulses — lasers, particle cannons, plasma bolts.', shreds: 'Unarmored hull, exposed systems', mitigatedBy: 'Ablative Armor' },
    'Antimatter':{ color: '#c778dd', blockedBy: [], bypassesLayers: ['reactive', 'ablative', 'hardened'], hullMult: 2, shieldMode: 'antimatter',
        desc: 'Exotic matter-antimatter warheads — among the most destructive ordnance in known space.', shreds: 'Hardened Armor & Hull — a genuine capital ship hull-melter', mitigatedBy: 'Shields (only partially)' },
    'Exotic':    { color: '#33ff99', blockedBy: [], bypassesLayers: ['reactive', 'ablative', 'hardened'], hullMult: 1, shieldMode: 'exotic',
        desc: 'Anomalous or poorly-understood physics effects with no established countermeasure.', shreds: 'All armor layers — ignored entirely', mitigatedBy: 'Shields only' },
    'Ion':       { color: '#7694ff', blockedBy: [], bypassesLayers: ['reactive', 'ablative', 'hardened'], hullMult: 0.25, shieldMode: 'ion',
        desc: 'Electromagnetic pulse weaponry designed to overload power systems, not breach hull.', shreds: 'Shields & reactor systems — bypasses all physical armor', mitigatedBy: 'Nothing stops it, but it barely scratches Hull' },
    'Heat':      { color: '#ff3333', blockedBy: ['ablative'], bypassesLayers: [], hullMult: 1, shieldMode: 'normal',
        desc: 'Thermal lances and incendiary ordnance that cooks through plating.', shreds: 'Unarmored hull, exposed systems', mitigatedBy: 'Ablative Armor' },
    'Cold':      { color: '#66d9ff', blockedBy: [], bypassesLayers: [], hullMult: 1.25, shieldMode: 'normal',
        desc: 'Cryogenic disruptors that embrittle plating rather than melting it outright.', shreds: 'Exposed Hull once armor is stripped — brittle-fracture bonus', mitigatedBy: 'Nothing specific; weak vs intact armor' },
    'Corrosive': { color: '#7cbf3f', blockedBy: ['reactive', 'ablative'], bypassesLayers: ['hardened'], hullMult: 1, shieldMode: 'normal',
        desc: 'Acidic or nanite-based agents that eat through even hardened plating.', shreds: 'Hardened Armor specifically — ignores it entirely', mitigatedBy: 'Reactive Armor, Ablative Armor' },
    'Healing':   { color: '#00e5a3', blockedBy: [], bypassesLayers: [], hullMult: 1, shieldMode: 'normal',
        desc: 'Repair-drone swarms, nanite weaves, or damage-control beams — restores rather than harms.', shreds: 'Nothing — restores Shields first, then Hull', mitigatedBy: 'N/A' }
};

window.buildDamageTypeOptionsHtml = function(selected) {
    return Object.keys(window.DAMAGE_TYPES).map(k => `<option value="${k}" ${k === selected ? 'selected' : ''}>${k}</option>`).join('');
};

/* --- WEAPON CLASSIFICATION (Ordnance groundwork) ---
   ship_weapons entries previously had no structured category at all — a
   "missile" was indistinguishable from a turret except by its free-text
   name. weapon_class is new: 'direct_fire' (default/legacy, resolves same
   turn as today) vs 'ordnance' (missiles/torpedoes — conceptually a
   multi-turn flight subject to point-defense counter-fire). is_point_defense
   flags a weapon (PDC/PDL/PDG-style) as a valid counter-fire system.
   IMPORTANT: this is schema + UI groundwork only. Neither field is read by
   any resolution logic yet — the actual multi-turn flight/counter-fire loop
   is deferred to the Tactical Battle Map Phase 2 build, once battle
   encounters exist for that loop to operate against. Legacy weapons with no
   weapon_class fall back to 'direct_fire' everywhere, same convention as
   ship_decks' type fallback. */
window.WEAPON_CLASS_LABELS = { direct_fire: 'Direct Fire', ordnance: 'Ordnance' };

// Native title tooltips (reliable, no extra markup) built from the shared table.
window.getDamageTypeTooltip = function(dmgType, context) {
    const info = window.DAMAGE_TYPES[dmgType];
    if (!info) {
        console.warn(`getDamageTypeTooltip: no entry for damage type "${dmgType}" — falling back to generic text instead of a blank tooltip.`);
        return `${dmgType || 'Unknown'}\nNo tactical data on file for this damage type.`;
    }
    if (context === 'arsenal') {
        // Personal Arsenal weapons don't interact with the ship armor cascade
        // (Shields/Reactive/Ablative/Hardened/Hull) — that's a ship-to-ship
        // mechanic. Showing the full "shreds/mitigated by" breakdown here
        // would imply a mechanical effect that doesn't actually apply to
        // personal combat, so this stays flavor-only.
        return `${dmgType}\n${info.desc}`;
    }
    return `${dmgType}\n${info.desc}\n\nSHREDS: ${info.shreds}\nMITIGATED BY: ${info.mitigatedBy}`;
};

function injectWeaponFormExtras() {
    if (document.getElementById('new-ship-wpn-guns')) return; // already injected
    const explodesCb = document.getElementById('new-ship-wpn-explodes');
    if (!explodesCb) return;
    const row = explodesCb.parentElement.parentElement;
    if (!row) return;
    row.insertAdjacentHTML('beforebegin', `
        <div style="display:flex; gap:6px; margin-bottom:6px;">
            <label for="new-ship-wpn-ammo" style="display:none;">Ammo</label>
            <input type="number" id="new-ship-wpn-ammo" placeholder="Ammo (blank = ∞)" min="0" style="flex:1; margin:0; text-align:center; border-color:#ff3333;">
            <label for="new-ship-wpn-guns" style="display:none;">Gun Count</label>
            <input type="number" id="new-ship-wpn-guns" placeholder="Guns" min="1" value="1" title="Number of physical guns/mounts in this battery — caps max volley size" style="flex:1; margin:0; text-align:center; border-color:#ff3333;">
            <label for="new-ship-wpn-dmgtype" style="display:none;">Damage Type</label>
            <select id="new-ship-wpn-dmgtype" style="flex:1.6; margin:0; border-color:#ff3333;">
                ${window.buildDamageTypeOptionsHtml('Impact')}
            </select>
        </div>`);
}
injectWeaponFormExtras();

function injectArsenalDamageTypeOptions() {
    const sel = document.getElementById('new-wpn-dmgtype');
    if (!sel || sel.dataset.populated) return;
    sel.insertAdjacentHTML('beforeend', window.buildDamageTypeOptionsHtml(''));
    sel.dataset.populated = 'true';
}
injectArsenalDamageTypeOptions();

/* Legacy weapons installed before damage_type existed as an explicit field had
   their damage type guessed from keywords in the weapon's name, or used the
   old combined "Impact/Ion" label before the 12-type matrix split those into
   separate types. Keep both fallbacks so old installed weapons keep behaving
   the same, but new/edited weapons always use the explicit field. */
window.inferLegacyDamageType = function(name) {
    let n = (name || '').toLowerCase();
    if (n.includes('pierce') || n.includes('piercing') || n.includes('rail') || n.includes('gauss')) return 'Piercing';
    if (n.includes('heat') || n.includes('plasma') || n.includes('laser') || n.includes('gamma')) return 'Heat';
    if (n.includes('flak') || n.includes('pdc') || n.includes('pdl') || n.includes('pdg')) return 'Flak';
    return 'Impact';
};
window.normalizeDamageType = function(dmgType) {
    if (dmgType === 'Impact/Ion') return 'Impact'; // pre-12-type legacy label
    return (dmgType && window.DAMAGE_TYPES[dmgType]) ? dmgType : 'Impact';
};

/* --- CASCADE DEFENSE RESOLUTION ---
   Shields -> Reactive Armor -> Ablative Armor -> Hardened Armor -> Hull.
   Each damage type's interaction with that cascade is fully data-driven
   from DAMAGE_TYPES above — this function is the single place that logic
   actually executes, so NPC/template ships (Overseer repository) and player
   ships resolve identically once deployment wiring exists. */
window.resolveShipDamage = function(targetShip, dmgType, totalDamage) {
    let s = targetShip.integrity_shields !== undefined ? targetShip.integrity_shields : 400;
    let r = targetShip.integrity_reactive !== undefined ? targetShip.integrity_reactive : 10;
    let a = targetShip.integrity_ablative !== undefined ? targetShip.integrity_ablative : 10;
    let hd = targetShip.integrity_hardened !== undefined ? targetShip.integrity_hardened : 0;
    let h = targetShip.integrity_hull !== undefined ? targetShip.integrity_hull : 300;
    let log = '';
    const info = window.DAMAGE_TYPES[dmgType] || window.DAMAGE_TYPES['Impact'];

    if (dmgType === 'Healing') {
        let sMax = targetShip.max_shields || 400; let hMax = targetShip.max_hull || 300;
        let toShields = Math.min(totalDamage, Math.max(0, sMax - s)); s += toShields;
        let toHull = Math.min(totalDamage - toShields, Math.max(0, hMax - h)); h += toHull;
        log += `Repair systems restored ${toShields} Shields`; if (toHull > 0) log += ` and ${toHull} Hull`; log += `. `;
        return { integrity_shields: s, integrity_reactive: r, integrity_ablative: a, integrity_hardened: hd, integrity_hull: h, log };
    }

    let remainingDmg = totalDamage;

    // --- SHIELDS ---
    if (info.shieldMode === 'antimatter') {
        let normalAbsorb = Math.min(s, remainingDmg);
        let leak = Math.floor(normalAbsorb * 0.5);
        s -= normalAbsorb;
        remainingDmg = (remainingDmg - normalAbsorb) + leak;
        if (normalAbsorb > 0) log += `[ANTIMATTER] Shields partially overwhelmed (absorbed ${normalAbsorb - leak}, ${leak} bled through). `;
    } else if (info.shieldMode === 'ion') {
        let ionShieldDmg = Math.min(s, remainingDmg * 2);
        s -= ionShieldDmg;
        remainingDmg = Math.max(0, Math.floor((remainingDmg - Math.ceil(ionShieldDmg / 2)) * 0.25));
        log += `[ION SURGE] Shield capacitors overloaded (-${ionShieldDmg}). Physical armor bypassed entirely. `;
    } else {
        let absorb = Math.min(s, remainingDmg); s -= absorb; remainingDmg -= absorb;
        if (absorb > 0) log += `Shields absorbed ${absorb}. `;
    }

    // --- ARMOR LAYERS ---
    if (remainingDmg > 0) {
        const bypassesReactive = info.bypassesLayers.includes('reactive');
        const bypassesAblative = info.bypassesLayers.includes('ablative');
        const bypassesHardened = info.bypassesLayers.includes('hardened');

        if (!bypassesReactive && info.blockedBy.includes('reactive') && r > 0) {
            r -= 1; log += `[REACTIVE ARMOR] charge expended — ${dmgType} damage negated! `; remainingDmg = 0;
        } else if (!bypassesAblative && info.blockedBy.includes('ablative') && a > 0) {
            a -= 1; log += `[ABLATIVE ARMOR] charge expended — ${dmgType} damage negated! `; remainingDmg = 0;
        } else {
            if (bypassesHardened) {
                if (hd > 0) log += `[${dmgType.toUpperCase()}] bypasses Hardened Armor entirely! `;
            } else if (hd > 0) {
                let hdAbsorb = Math.min(hd, remainingDmg);
                hd -= hdAbsorb; remainingDmg -= hdAbsorb;
                if (hdAbsorb > 0) log += `Hardened Armor absorbed ${hdAbsorb}. `;
            }

            if (remainingDmg > 0) {
                let hullMult = info.hullMult;
                if (dmgType === 'Cold' && hd <= 0) hullMult = 1.25; // brittle-fracture bonus once armor's stripped
                let hullDmg = Math.min(h, Math.ceil(remainingDmg * hullMult));
                h -= hullDmg; remainingDmg -= hullDmg;
                log += `Hull suffered ${hullDmg} damage! `;
                if (h <= 0) log += `**CRITICAL HULL BREACH!** `;
            }
        }
    }

    return { integrity_shields: s, integrity_reactive: r, integrity_ablative: a, integrity_hardened: hd, integrity_hull: h, log };
};

window.addShipWeapon = async function() {
    const select = document.getElementById('vessel-deck-select');
    const loc = document.getElementById('new-ship-wpn-loc').value.trim() || 'Hull Mount';
    const name = document.getElementById('new-ship-wpn-name').value.trim();
    let dice = document.getElementById('new-ship-wpn-dice').value.trim().toLowerCase();
    let mod = document.getElementById('new-ship-wpn-mod').value.trim();
    const explodes = document.getElementById('new-ship-wpn-explodes').checked;
    
    let ammoInput = document.getElementById('new-ship-wpn-ammo');
    let ammoVal = -1;
    if (ammoInput && ammoInput.value.trim() !== '') {
        ammoVal = Math.max(0, parseInt(ammoInput.value) || 0);
    }

    let gunsInput = document.getElementById('new-ship-wpn-guns');
    let gunCount = (gunsInput && parseInt(gunsInput.value) > 0) ? parseInt(gunsInput.value) : 1;

    let dmgTypeSelect = document.getElementById('new-ship-wpn-dmgtype');
    let damageType = (dmgTypeSelect && dmgTypeSelect.value) ? dmgTypeSelect.value : 'Impact';

    let classSelect = document.getElementById('new-ship-wpn-class');
    let weaponClass = (classSelect && classSelect.value === 'ordnance') ? 'ordnance' : 'direct_fire';
    let pdCheckbox = document.getElementById('new-ship-wpn-pd');
    let isPointDefense = pdCheckbox ? pdCheckbox.checked : false;
    let rangeInput = document.getElementById('new-ship-wpn-range');
    // 0 = unlimited (no Battle Map targeting restriction) — the default for
    // every new weapon and for every legacy weapon that predates this field.
    let weaponRange = rangeInput ? Math.max(0, parseInt(rangeInput.value) || 0) : 0;
    let deckSelect = document.getElementById('new-ship-wpn-deck');
    let assignedDeckId = (deckSelect && deckSelect.value) ? deckSelect.value : null;

    if (!select || !select.value) { alert("Select a vessel token first."); return; }
    if (!name) { alert("Please enter a weapon system name."); return; }
    if (!dice) dice = '1d10';
    if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
    if (!mod) mod = '+0';

    let vessel = globalShipMarkersCache.find(m => m.id === select.value);
    if (!vessel) return;

    let weapons = vessel.ship_weapons || [];
    weapons.push({
        loc, name, dice, modifier: mod, explodes,
        ammo: ammoVal, max_ammo: ammoVal, cooldown: 0, overheat: 0,
        gun_count: gunCount, damage_type: damageType,
        weapon_class: weaponClass, is_point_defense: isPointDefense, range: weaponRange,
        assigned_deck_id: assignedDeckId
    });

    await db.from('ship_markers').update({ ship_weapons: weapons }).eq('id', vessel.id);
    vessel.ship_weapons = weapons;

    document.getElementById('new-ship-wpn-loc').value = '';
    document.getElementById('new-ship-wpn-name').value = '';
    document.getElementById('new-ship-wpn-dice').value = '';
    document.getElementById('new-ship-wpn-mod').value = '';
    if (ammoInput) ammoInput.value = '';
    if (gunsInput) gunsInput.value = '1';
    if (classSelect) classSelect.value = 'direct_fire';
    if (pdCheckbox) pdCheckbox.checked = false;
    if (rangeInput) rangeInput.value = '0';
    if (deckSelect) deckSelect.value = '';
    window.renderVesselDeck();
};

window.deleteShipWeapon = async function(vesselId, idx) {
    if (!(await window.showConfirmModal("Uninstall this weapon system?"))) return;
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let weapons = vessel.ship_weapons || [];
    weapons.splice(idx, 1);

    await db.from('ship_markers').update({ ship_weapons: weapons }).eq('id', vesselId);
    vessel.ship_weapons = weapons;
    window.renderVesselDeck();
};

/* --- WEAPON EDIT MODAL ---
   Previously the only way to change an installed weapon's stats was to delete
   it and re-add it from scratch, losing any accumulated ammo/cooldown/overheat
   state in the process. This lets a DM edit any field in place. */
(function() {
    let overlay, currentVesselId, currentIdx;
    function ensureEditModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'weapon-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:380px; max-width:92vw; border-color:#ff6b6b;">
            <h4 style="color:#ff6b6b; margin-top:0;">Edit Weapon System</h4>
            <label for="wpn-edit-loc" style="font-size:9px; color:#ffaaaa;">Mount Location</label>
            <input type="text" id="wpn-edit-loc" style="border-color:#ff3333;">
            <label for="wpn-edit-name" style="font-size:9px; color:#ffaaaa;">Name</label>
            <input type="text" id="wpn-edit-name" style="border-color:#ff3333;">
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="wpn-edit-dice" style="font-size:9px; color:#ffaaaa;">Dice</label><input type="text" id="wpn-edit-dice" style="border-color:#ff3333; text-align:center;"></div>
                <div style="flex:1;"><label for="wpn-edit-mod" style="font-size:9px; color:#ffaaaa;">Mod</label><input type="text" id="wpn-edit-mod" style="border-color:#ff3333; text-align:center;"></div>
            </div>
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="wpn-edit-ammo" style="font-size:9px; color:#ffaaaa;">Ammo (blank=∞)</label><input type="number" id="wpn-edit-ammo" min="0" style="border-color:#ff3333; text-align:center;"></div>
                <div style="flex:1;"><label for="wpn-edit-maxammo" style="font-size:9px; color:#ffaaaa;">Max Ammo</label><input type="number" id="wpn-edit-maxammo" min="0" style="border-color:#ff3333; text-align:center;"></div>
                <div style="flex:1;"><label for="wpn-edit-guns" style="font-size:9px; color:#ffaaaa;">Gun Count</label><input type="number" id="wpn-edit-guns" min="1" style="border-color:#ff3333; text-align:center;"></div>
            </div>
            <label for="wpn-edit-dmgtype" style="font-size:9px; color:#ffaaaa;">Damage Type</label>
            <select id="wpn-edit-dmgtype" style="border-color:#ff3333;">
                ${window.buildDamageTypeOptionsHtml('Impact')}
            </select>
            <label for="wpn-edit-class" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;">Weapon Class</label>
            <select id="wpn-edit-class" style="border-color:#ff3333;">
                <option value="direct_fire">Direct Fire (standard)</option>
                <option value="ordnance">Ordnance (missile/torpedo — multi-turn, counter-fireable)</option>
            </select>
            <label for="wpn-edit-range" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;" title="Battle Map targeting range, grid px. 0 = unlimited.">Range (Battle Map grid px, 0 = unlimited)</label>
            <input type="number" id="wpn-edit-range" min="0" style="border-color:#ff3333; text-align:center;">
            <label for="wpn-edit-deck" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;" title="A destroyed deck can't fire its assigned weapons.">Assigned Deck (optional — ties this weapon's firing to a deck's HP)</label>
            <select id="wpn-edit-deck" style="border-color:#ff3333;"></select>
            <div style="display:flex; justify-content:space-between; margin-top:8px;">
                <label for="wpn-edit-explodes" style="font-size:10px; color:#ffaaaa; display:flex; align-items:center; gap:4px; cursor:pointer;">
                    <input type="checkbox" id="wpn-edit-explodes" style="margin:0;"> Exploding Dice
                </label>
                <label for="wpn-edit-pd" style="font-size:10px; color:#ffaaaa; display:flex; align-items:center; gap:4px; cursor:pointer;">
                    <input type="checkbox" id="wpn-edit-pd" style="margin:0;"> Point Defense
                </label>
            </div>
            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="wpn-edit-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="wpn-edit-save-btn" class="btn-reveal" style="flex:1; margin-top:0;">SAVE CHANGES</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('wpn-edit-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('wpn-edit-save-btn').addEventListener('click', async () => {
            let vessel = globalShipMarkersCache.find(m => m.id === currentVesselId);
            if (!vessel || !vessel.ship_weapons || !vessel.ship_weapons[currentIdx]) { overlay.style.display = 'none'; return; }
            let wpn = vessel.ship_weapons[currentIdx];

            wpn.loc = document.getElementById('wpn-edit-loc').value.trim() || 'Hull Mount';
            wpn.name = document.getElementById('wpn-edit-name').value.trim() || wpn.name;
            let dice = document.getElementById('wpn-edit-dice').value.trim().toLowerCase();
            wpn.dice = dice || wpn.dice;
            let mod = document.getElementById('wpn-edit-mod').value.trim();
            if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
            wpn.modifier = mod || '+0';
            wpn.explodes = document.getElementById('wpn-edit-explodes').checked;
            wpn.damage_type = document.getElementById('wpn-edit-dmgtype').value;
            wpn.weapon_class = document.getElementById('wpn-edit-class').value === 'ordnance' ? 'ordnance' : 'direct_fire';
            wpn.is_point_defense = document.getElementById('wpn-edit-pd').checked;
            wpn.range = Math.max(0, parseInt(document.getElementById('wpn-edit-range').value) || 0);
            const deckSel = document.getElementById('wpn-edit-deck');
            wpn.assigned_deck_id = (deckSel && deckSel.value) ? deckSel.value : null;

            let gunsVal = parseInt(document.getElementById('wpn-edit-guns').value);
            wpn.gun_count = (gunsVal && gunsVal > 0) ? gunsVal : 1;

            let ammoStr = document.getElementById('wpn-edit-ammo').value.trim();
            let maxAmmoStr = document.getElementById('wpn-edit-maxammo').value.trim();
            if (ammoStr === '') {
                wpn.ammo = -1; wpn.max_ammo = -1;
            } else {
                wpn.ammo = Math.max(0, parseInt(ammoStr) || 0);
                let maxAmmo = maxAmmoStr !== '' ? parseInt(maxAmmoStr) || wpn.ammo : (wpn.max_ammo && wpn.max_ammo > 0 ? wpn.max_ammo : wpn.ammo);
                wpn.max_ammo = Math.max(wpn.ammo, maxAmmo);
            }

            const { error } = await db.from('ship_markers').update({ ship_weapons: vessel.ship_weapons }).eq('id', currentVesselId);
            if (error) { alert("Failed to save weapon changes: " + error.message); return; }
            overlay.style.display = 'none';
            window.renderVesselDeck();
        });
    }

    window.openEditWeaponModal = function(vesselId, idx) {
        let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
        if (!vessel || !vessel.ship_weapons || !vessel.ship_weapons[idx]) return;
        let wpn = vessel.ship_weapons[idx];
        ensureEditModal();
        currentVesselId = vesselId; currentIdx = idx;
        document.getElementById('wpn-edit-loc').value = wpn.loc || '';
        document.getElementById('wpn-edit-name').value = wpn.name || '';
        document.getElementById('wpn-edit-dice').value = wpn.dice || '';
        document.getElementById('wpn-edit-mod').value = wpn.modifier || '+0';
        document.getElementById('wpn-edit-ammo').value = (wpn.ammo === undefined || wpn.ammo < 0) ? '' : wpn.ammo;
        document.getElementById('wpn-edit-maxammo').value = (wpn.max_ammo === undefined || wpn.max_ammo < 0) ? '' : wpn.max_ammo;
        document.getElementById('wpn-edit-guns').value = wpn.gun_count || 1;
        document.getElementById('wpn-edit-dmgtype').value = window.normalizeDamageType(wpn.damage_type || window.inferLegacyDamageType(wpn.name));
        document.getElementById('wpn-edit-explodes').checked = !!wpn.explodes;
        document.getElementById('wpn-edit-class').value = wpn.weapon_class === 'ordnance' ? 'ordnance' : 'direct_fire';
        document.getElementById('wpn-edit-pd').checked = !!wpn.is_point_defense;
        document.getElementById('wpn-edit-range').value = wpn.range || 0;

        // Deck dropdown re-populated fresh every open (decks can change
        // between edits) — self-heals missing deck ids the same way
        // renderVesselDeck does, so an old deck with no id still shows up.
        vessel.ship_decks = vessel.ship_decks || [];
        if (window.ensureDeckIds(vessel.ship_decks)) {
            db.from('ship_markers').update({ ship_decks: vessel.ship_decks }).eq('id', vessel.id);
        }
        const deckSel = document.getElementById('wpn-edit-deck');
        deckSel.innerHTML = '<option value="">-- Not deck-gated --</option>' + vessel.ship_decks.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
        deckSel.value = wpn.assigned_deck_id || '';

        overlay.style.display = 'flex';
    };
})();

window.broadcastVesselStatus = async function() {
    const select = document.getElementById('vessel-deck-select');
    if (!select || !select.value) return;
    let vessel = globalShipMarkersCache.find(m => m.id === select.value);
    if (!vessel) return;

    const s_int = vessel.integrity_shields !== undefined ? vessel.integrity_shields : 400;
    const h_int = vessel.integrity_hull !== undefined ? vessel.integrity_hull : 300;
    const r_int = vessel.integrity_reactive !== undefined ? vessel.integrity_reactive : 10;
    const a_int = vessel.integrity_ablative !== undefined ? vessel.integrity_ablative : 10;

    if(typeof db !== 'undefined') {
        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🛡️ [VESSEL DIAGNOSTICS] ${vessel.name} status check:<br><span style="color:#00e1ff">Shields: ${s_int}</span> | <span style="color:#ff3333">Hull: ${h_int}</span><br><span style="color:#ffaa00">Reactive Armor: ${r_int}</span> | <span style="color:#ffaa00">Ablative Armor: ${a_int}</span>`,
            message_type: 'text'
        });
        alert("Vessel diagnostic broadcasted to Secure Comms!");
    }
};

/* --- PERSONAL ARSENAL --- */
window.renderArsenal = function() {
    const container = document.getElementById('arsenal-list-container');
    if (!container) return;
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    
    let arsenal = myProf.arsenal || [];
    let html = '';
    if (arsenal.length === 0) {
        html = '<span style="font-size:10px; color:#6b826a;">No active weapons or powers in arsenal.</span>';
    } else {
        const ordered = window.applySavedOrder('arsenal', arsenal);
        ordered.forEach((w, idx) => {
            let dmgBadge = '';
            if (w.damage_type && window.DAMAGE_TYPES[window.normalizeDamageType(w.damage_type)]) {
                let dt = window.normalizeDamageType(w.damage_type);
                let info = window.DAMAGE_TYPES[dt];
                dmgBadge = `<span class="dmg-tooltip" style="font-size:9px; color:${info.color}; text-align:center; cursor:help;" title="${window.getDamageTypeTooltip(dt, 'arsenal')}">${dt} ⓘ</span>`;
            } else {
                dmgBadge = `<span style="font-size:9px; color:#6b826a; text-align:center;">—</span>`;
            }
            let ammoLabel = '';
            if (w.ammo !== null && w.ammo !== undefined) {
                ammoLabel = `<div style="font-size:9px; color:${w.ammo <= 0 ? '#ff3333' : '#6b826a'};">Ammo: ${w.ammo}/${w.max_ammo !== null && w.max_ammo !== undefined ? w.max_ammo : '∞'}</div>`;
            }
            html += `
                <div class="arsenal-row">
                    <div><strong style="color:#ffaa00; font-size:11px;">${w.name}</strong>${ammoLabel}</div>
                    <span style="font-size:13px; font-weight:bold; color:#d4c5a9; text-align:center;">${w.dice}</span>
                    <span style="font-size:10px; color:#d4c5a9; text-align:center;">${w.modifier}</span>
                    <span style="font-size:10px; text-align:center;" title="Explodes">${w.explodes ? '💥' : ''}</span>
                    ${dmgBadge}
                    <div style="display:flex; gap:4px;">
                        ${window.renderReorderArrows('arsenal', ordered, w.id, 'moveArsenalOrder')}
                        <button class="layer-edit" onclick="window.rollArsenalWeapon('${w.id}')" style="padding:2px 6px; font-size:9px; border-color:#ffaa00; color:#ffaa00;">ROLL</button>
                        <button class="layer-edit" onclick="window.openArsenalAttackModal('${w.id}')" title="Resolve Attack (to-hit vs. a target, then damage if it hits)" style="padding:2px 6px; font-size:9px; border-color:#ff3333; color:#ff3333;">⚔</button>
                        <button class="layer-edit" onclick="window.openEditArsenalModal('${w.id}')" style="padding:2px 5px; font-size:9px;">✎</button>
                        <button class="layer-del" onclick="window.deleteArsenalItem('${w.id}')" style="padding:2px 5px; font-size:9px;">✕</button>
                    </div>
                </div>
            `;
        });
    }
    container.innerHTML = html;
    
    const badgeCombat = document.getElementById('badge-combat');
    if (badgeCombat) badgeCombat.innerText = arsenal.length;
};
window.moveArsenalOrder = function(id, direction) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    const arsenal = myProf.arsenal || [];
    window.moveListItem('arsenal', window.applySavedOrder('arsenal', arsenal), id, direction);
    window.renderArsenal();
};

window.addArsenalItem = async function() {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character) { alert("Please save your Dossier & Stats first before adding weapons."); return; }
    
    const name = document.getElementById('new-wpn-name').value.trim();
    let dice = document.getElementById('new-wpn-dice').value.trim().toLowerCase();
    let mod = document.getElementById('new-wpn-mod').value.trim();
    const explodes = document.getElementById('new-wpn-explodes').checked;
    const dmgTypeSelect = document.getElementById('new-wpn-dmgtype');
    const damageType = dmgTypeSelect ? dmgTypeSelect.value : ''; // optional — blank is valid
    const ammoInput = document.getElementById('new-wpn-ammo');
    const ammoVal = (ammoInput && ammoInput.value.trim() !== '') ? Math.max(0, parseInt(ammoInput.value) || 0) : null; // null = untracked/infinite

    if (!name) { alert("Enter a weapon/power name."); return; }
    if (!dice) dice = '1d20';
    if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
    if (!mod) mod = '+0';

    const payload = {
        profile_id: currentUserId,
        character_id: myProf.character.id,
        name: name,
        dice: dice,
        modifier: mod,
        explodes: explodes,
        damage_type: damageType || null,
        ammo: ammoVal,
        max_ammo: ammoVal
    };

    const { error } = await db.from('character_arsenal').insert(payload);
    if (error) { alert("Failed to add weapon: " + error.message); return; }
    
    document.getElementById('new-wpn-name').value = '';
    document.getElementById('new-wpn-dice').value = '';
    document.getElementById('new-wpn-mod').value = '';
    if (ammoInput) ammoInput.value = '';
    if (dmgTypeSelect) dmgTypeSelect.value = '';
    if(typeof window.loadAllProfiles === 'function') window.loadAllProfiles();
};

// Reuses the same lazy-loaded window.diceLogsList the Comms "Dice Streamer"
// tab already maintains — no separate query/cache needed, just a second
// place that renders the same data so you don't have to leave this screen
// to see what you just rolled.
window.renderArsenalDiceFeed = function() {
    const container = document.getElementById('arsenal-dice-feed');
    if (!container) return;
    const rolls = window.diceLogsList || [];
    if (rolls.length === 0) { container.innerHTML = '<span style="font-size:10px; color:#6b826a;">No rolls yet this session.</span>'; return; }
    let html = '';
    rolls.slice(-8).reverse().forEach(log => {
        const sender = allProfiles.find(p => p.id === log.sender_id);
        const senderName = sender ? (sender.username || 'Commander') : 'Unknown';
        html += `<div style="background:rgba(6,9,7,0.6); padding:6px; border-left:2px solid #ff6b6b; border-radius:2px; margin-bottom:4px;">
            <div style="font-size:9px; color:#ff6b6b; margin-bottom:2px;">🎲 <strong>${senderName}</strong></div>
            <div style="font-size:10px; color:#d4c5a9;"><strong>${log.content}</strong>${log.roll_data ? `<br><span style="font-size:9px; color:#6b826a;">${log.roll_data.breakdown}</span>` : ''}</div>
        </div>`;
    });
    container.innerHTML = html;
};

window.deleteArsenalItem = async function(id) {
    if (!(await window.showConfirmModal("Remove this item from your arsenal?"))) return;
    await db.from('character_arsenal').delete().eq('id', id);
    if(typeof window.loadAllProfiles === 'function') window.loadAllProfiles();
};

/* --- EDIT ARSENAL ITEM MODAL --- */
(function() {
    let overlay, currentId;
    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'arsenal-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:360px; max-width:92vw; border-color:#ffaa00;">
            <h4 style="color:#ffaa00; margin-top:0;">Edit Arsenal Item</h4>
            <label for="arsenal-edit-name" style="font-size:9px; color:#6b826a;">Weapon / Power Name</label>
            <input type="text" id="arsenal-edit-name" style="border-color:#ffaa00;">
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="arsenal-edit-dice" style="font-size:9px; color:#6b826a;">Dice</label><input type="text" id="arsenal-edit-dice" style="border-color:#ffaa00; text-align:center;"></div>
                <div style="flex:1;"><label for="arsenal-edit-mod" style="font-size:9px; color:#6b826a;">Mod</label><input type="text" id="arsenal-edit-mod" style="border-color:#ffaa00; text-align:center;"></div>
            </div>
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="arsenal-edit-ammo" style="font-size:9px; color:#6b826a;">Ammo (blank=∞)</label><input type="number" id="arsenal-edit-ammo" min="0" style="border-color:#ffaa00; text-align:center;"></div>
                <div style="flex:1;"><label for="arsenal-edit-maxammo" style="font-size:9px; color:#6b826a;">Max Ammo</label><input type="number" id="arsenal-edit-maxammo" min="0" style="border-color:#ffaa00; text-align:center;"></div>
            </div>
            <label for="arsenal-edit-dmgtype" style="font-size:9px; color:#6b826a;">Damage Type (optional)</label>
            <select id="arsenal-edit-dmgtype" style="border-color:#ffaa00;"><option value="">None</option></select>
            <label for="arsenal-edit-explodes" style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:8px;">
                <input type="checkbox" id="arsenal-edit-explodes" style="margin:0;"> Exploding Dice
            </label>
            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="arsenal-edit-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="arsenal-edit-save-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#ffaa00; color:#ffaa00;">SAVE CHANGES</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('arsenal-edit-dmgtype').insertAdjacentHTML('beforeend', window.buildDamageTypeOptionsHtml(''));
        document.getElementById('arsenal-edit-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('arsenal-edit-save-btn').addEventListener('click', async () => {
            let mod = document.getElementById('arsenal-edit-mod').value.trim();
            if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
            const ammoStr = document.getElementById('arsenal-edit-ammo').value.trim();
            const maxAmmoStr = document.getElementById('arsenal-edit-maxammo').value.trim();
            const updates = {
                name: document.getElementById('arsenal-edit-name').value.trim() || 'Unnamed Item',
                dice: document.getElementById('arsenal-edit-dice').value.trim() || '1d20',
                modifier: mod || '+0',
                explodes: document.getElementById('arsenal-edit-explodes').checked,
                damage_type: document.getElementById('arsenal-edit-dmgtype').value || null,
                ammo: ammoStr === '' ? null : Math.max(0, parseInt(ammoStr) || 0),
                max_ammo: maxAmmoStr === '' ? (ammoStr === '' ? null : Math.max(0, parseInt(ammoStr) || 0)) : Math.max(0, parseInt(maxAmmoStr) || 0)
            };
            const { error } = await db.from('character_arsenal').update(updates).eq('id', currentId);
            if (error) { alert("Failed to save changes: " + error.message); return; }
            overlay.style.display = 'none';
            if (typeof window.loadAllProfiles === 'function') window.loadAllProfiles();
        });
    }
    window.openEditArsenalModal = function(id) {
        const myProf = allProfiles.find(p => p.id === currentUserId);
        const wpn = myProf ? (myProf.arsenal || []).find(w => w.id === id) : null;
        if (!wpn) return;
        ensureModal();
        currentId = id;
        document.getElementById('arsenal-edit-name').value = wpn.name || '';
        document.getElementById('arsenal-edit-dice').value = wpn.dice || '';
        document.getElementById('arsenal-edit-mod').value = wpn.modifier || '+0';
        document.getElementById('arsenal-edit-ammo').value = (wpn.ammo === null || wpn.ammo === undefined) ? '' : wpn.ammo;
        document.getElementById('arsenal-edit-maxammo').value = (wpn.max_ammo === null || wpn.max_ammo === undefined) ? '' : wpn.max_ammo;
        document.getElementById('arsenal-edit-dmgtype').value = wpn.damage_type || '';
        document.getElementById('arsenal-edit-explodes').checked = !!wpn.explodes;
        overlay.style.display = 'flex';
    };
})();

window.rollArsenalWeapon = async function(id) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    // Looked up by stable weapon id, not array position — position shifts
    // once personal reorder arrows are in play (see window.applySavedOrder).
    let wpn = (myProf.arsenal || []).find(w => w.id === id);
    if (!wpn) return;

    if (wpn.ammo !== null && wpn.ammo !== undefined && wpn.ammo <= 0) {
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`${wpn.name} is out of ammo! Reload or edit it to restock before firing again.`);
        return;
    }

    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = wpn.dice.trim().match(diceRegex);
    if (!match) { alert("Invalid dice format."); return; }

    let numDice = parseInt(match[1]) || 1;
    let diceFaces = parseInt(match[2]);
    let modVal = parseInt(wpn.modifier) || 0;
    let canExplode = wpn.explodes && diceFaces >= 2;

    let total = 0;
    let breakdown = [];

    for (let i = 0; i < numDice; i++) {
        let rollTotal = 0;
        let subRolls = [];
        let currentRoll;
        do {
            currentRoll = Math.floor(Math.random() * diceFaces) + 1;
            rollTotal += currentRoll;
            subRolls.push(currentRoll);
        } while (currentRoll === diceFaces && canExplode);
        total += rollTotal;
        breakdown.push(`(d${diceFaces}: ${subRolls.join('💥')})`);
    }
    
    total += modVal;
    if (modVal !== 0) breakdown.push(`[Mod: ${modVal >= 0 ? '+' : ''}${modVal}]`);

    let breakdownString = `
        <div style="margin-top:4px; padding:4px; border-left:2px solid #ffaa00; background:rgba(255,170,0,0.1);">
            <strong>Arsenal Weapon:</strong> ${wpn.name}<br>
            <strong>Base Output:</strong> ${breakdown.join(' + ')} = <strong style="color:#ff3333;">${total} Dmg</strong>
        </div>
    `;
    
    if (window.AudioEngine) window.AudioEngine.playShoot();

    if (wpn.ammo !== null && wpn.ammo !== undefined) {
        wpn.ammo = Math.max(0, wpn.ammo - 1);
        await db.from('character_arsenal').update({ ammo: wpn.ammo }).eq('id', wpn.id);
        if (typeof window.renderArsenal === 'function') window.renderArsenal();
    }

    if(typeof window.broadcastRoll === 'function') {
        await window.broadcastRoll(`[${myProf.username || 'Commander'}] FIRES ${wpn.name}`, breakdownString, total);
    }
};

/* --- GROUND COMBAT TO-HIT SYSTEM ---
   Confirmed design: attacker rolls d20 + weapon modifier + attacker's
   chosen skill modifier + perk bonuses on that skill; defender rolls ONE
   core stat die — a PC defender's die size comes from their own character
   sheet (whoever resolves the attack picks WHICH stat, fresh each time);
   an NPC defender (no linked character sheet at all) has no stat to pull
   from, so a raw die size is picked manually instead. Higher total wins;
   on a tie the player-controlled side wins. Triggered by a new "⚔" button
   next to each Arsenal weapon's existing ROLL button — the attacker is
   always the current user's own character (their own Arsenal weapon),
   same scope as ROLL already has. A miss blocks the damage roll entirely
   (one integrated action, not a separate advisory step); ammo is
   consumed either way since the shot was still fired. This is a genuine
   prototype like the boarding system — the d20 does NOT explode (flat
   1-20, standard d20-system convention, not stated either way by the
   confirmed design), the defender's die DOES explode (matches every
   other core-stat-die roll elsewhere in this app), and `wpn.modifier` is
   reused as-is for BOTH the to-hit bonus AND the existing damage bonus —
   the schema only has one modifier field per weapon, so a well-modified
   weapon is being treated as both more accurate and harder-hitting
   rather than splitting it into two fields. Flag any of this to revisit
   after it's actually played. */
window.DAMAGE_TYPE_TO_SKILL = {
    'Impact': 'Ballistic Weapons', 'Piercing': 'Ballistic Weapons', 'Flak': 'Ballistic Weapons',
    'Cold': 'Ballistic Weapons', 'Corrosive': 'Ballistic Weapons',
    'Energy': 'Energy Weapons', 'Ion': 'Energy Weapons', 'Heat': 'Energy Weapons',
    'Antimatter': 'Energy Weapons', 'Exotic': 'Energy Weapons',
    'Explosive': 'Explosives', 'Healing': 'Medical'
};

function rollExplodingDie(faces, canExplode) {
    let roll, subRolls = [], rollTotal = 0;
    do {
        roll = Math.floor(Math.random() * faces) + 1;
        rollTotal += roll;
        subRolls.push(roll);
    } while (roll === faces && canExplode);
    return { rollTotal, subRolls };
}

(function() {
    let overlay, currentWeaponId;

    function defenderProfile(combatant) {
        return allProfiles.find(p => p.id === combatant.owner_id) || null;
    }
    function defenderIsPC(combatant) {
        const prof = defenderProfile(combatant);
        // Requires BOTH a linked character sheet AND a non-DM owner. The
        // Initiative Tracker's "+ ADD TO INITIATIVE" form (DM-only, for
        // NPCs) sets owner_id to the DM's own profile id, same field a
        // player's own "+ JOIN INITIATIVE" self-add uses — nothing in the
        // data distinguishes "an NPC the DM added" from "the DM's own PC"
        // by owner_id alone. Excluding role === 'dm' here means every
        // DM-added combatant is treated as an NPC (manual die size), even
        // in the rare case the DM adds their own PC through that same
        // form — a known, flagged edge case, not silently mishandled.
        return !!(prof && prof.role !== 'dm' && prof.character && prof.character.id);
    }

    function renderDefenseGroup() {
        const group = document.getElementById('atk-defense-group');
        const targetSel = document.getElementById('atk-target-select');
        if (!group || !targetSel || !targetSel.value) { if (group) group.innerHTML = ''; return; }
        const target = combatantsList.find(c => c.id === targetSel.value);
        if (!target) { group.innerHTML = ''; return; }
        if (defenderIsPC(target)) {
            group.innerHTML = `
                <label for="atk-defense-stat-select" style="font-size:9px; color:#6b826a;">Defender rolls (their own stat die) — pick which stat:</label>
                <select id="atk-defense-stat-select" style="border-color:#ff3333;">
                    ${window.PERK_STAT_NAMES.map(s => `<option value="${s}">${s}</option>`).join('')}
                </select>`;
        } else {
            group.innerHTML = `
                <label for="atk-defense-die-select" style="font-size:9px; color:#6b826a;">No character sheet linked — DM picks a die size:</label>
                <select id="atk-defense-die-select" style="border-color:#ff3333;">
                    <option value="d4">d4</option><option value="d6">d6</option><option value="d8" selected>d8</option>
                    <option value="d10">d10</option><option value="d12">d12</option><option value="d20">d20</option>
                </select>`;
        }
    }

    function groundCombatTargets() {
        // Strike-craft squadron tokens share the same Initiative Tracker as
        // personal combatants (owner_id set to the squadron's owning
        // player) — excluded here since this is a personal-combat system;
        // a squadron "defending" with its pilot's personal Charisma/
        // Willpower die makes no sense. Ship-to-ship combat already has
        // its own separate weapon-roll system.
        return combatantsList.filter(c => !c.is_strike_craft);
    }

    function populateTargetOptions() {
        const sel = document.getElementById('atk-target-select');
        if (!sel) return;
        const targets = groundCombatTargets();
        sel.innerHTML = targets.length
            ? targets.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
            : '<option value="">No eligible combatants in the Initiative Tracker</option>';
    }

    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'arsenal-attack-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:380px; max-width:92vw; border-color:#ff3333;">
            <h4 style="color:#ff3333; margin-top:0;" id="atk-modal-title">Resolve Attack</h4>
            <label for="atk-target-select" style="font-size:9px; color:#6b826a;">Target (from Initiative Tracker)</label>
            <select id="atk-target-select" style="border-color:#ff3333;"></select>
            <label for="atk-skill-select" style="font-size:9px; color:#6b826a; margin-top:6px; display:block;">Attacker Skill (adds skill mod + perk bonuses to the to-hit roll)</label>
            <select id="atk-skill-select" style="border-color:#ff3333;">
                ${skillList.map(s => `<option value="${s}">${s}</option>`).join('')}
            </select>
            <div id="atk-defense-group" style="margin-top:6px;"></div>
            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="atk-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="atk-resolve-btn" class="btn-deploy" style="flex:1; margin-top:0;">⚔ RESOLVE ATTACK</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('atk-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.getElementById('atk-target-select').addEventListener('change', renderDefenseGroup);
        document.getElementById('atk-resolve-btn').addEventListener('click', () => window.resolveArsenalAttack(currentWeaponId));
    }

    window.openArsenalAttackModal = function(weaponId) {
        const myProf = allProfiles.find(p => p.id === currentUserId);
        const wpn = myProf ? (myProf.arsenal || []).find(w => w.id === weaponId) : null;
        if (!wpn) return;
        if (wpn.ammo !== null && wpn.ammo !== undefined && wpn.ammo <= 0) {
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`${wpn.name} is out of ammo! Reload or edit it to restock before firing again.`);
            return;
        }
        if (groundCombatTargets().length === 0) { alert("No eligible combatants in the Initiative Tracker to target — add one there first (strike-craft squadron tokens can't be targeted here; use ship weapons for those)."); return; }
        ensureModal();
        currentWeaponId = weaponId;
        document.getElementById('atk-modal-title').innerText = `Resolve Attack: ${wpn.name}`;
        populateTargetOptions();
        const dt = wpn.damage_type ? window.normalizeDamageType(wpn.damage_type) : null;
        document.getElementById('atk-skill-select').value = (dt && window.DAMAGE_TYPE_TO_SKILL[dt]) || 'Ballistic Weapons';
        renderDefenseGroup();
        overlay.style.display = 'flex';
    };

    window.closeArsenalAttackModal = function() { if (overlay) overlay.style.display = 'none'; };
})();

window.resolveArsenalAttack = async function(weaponId) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    let wpn = (myProf.arsenal || []).find(w => w.id === weaponId);
    if (!wpn) return;

    // Validated up front, same as window.rollArsenalWeapon's own check — a
    // malformed dice string must not be discovered only after ammo's been
    // spent and a hit already broadcast to chat with no damage number.
    const diceRegex = /^(\d*)d(\d+)$/i;
    if (!wpn.dice || !wpn.dice.trim().match(diceRegex)) { alert("This weapon's dice format is invalid — edit it before attacking."); return; }

    const targetSel = document.getElementById('atk-target-select');
    const target = targetSel ? combatantsList.find(c => c.id === targetSel.value) : null;
    if (!target) { alert("Select a target first."); return; }
    const skillName = document.getElementById('atk-skill-select').value;

    // --- Attacker roll: flat d20 (no explode) + weapon mod + skill mod + perk bonus on that skill ---
    let atkBreakdown = [];
    let atkTotal = Math.floor(Math.random() * 20) + 1;
    atkBreakdown.push(`d20: ${atkTotal}`);

    let modVal = parseInt(wpn.modifier) || 0;
    if (modVal !== 0) { atkTotal += modVal; atkBreakdown.push(`Weapon Mod: ${modVal >= 0 ? '+' : ''}${modVal}`); }

    const safeSkillKey = skillName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const skillMod = (myProf.skills || {})[safeSkillKey] || 0;
    if (skillMod !== 0) { atkTotal += skillMod; atkBreakdown.push(`${skillName}: ${skillMod >= 0 ? '+' : ''}${skillMod}`); }

    const perkBonus = window.getPerkBonusFor(myProf.perks, 'skill', skillName);
    if (perkBonus.total !== 0) { atkTotal += perkBonus.total; atkBreakdown.push(`${skillName} Perks: ${perkBonus.sources.join(', ')}`); }

    // --- Defender roll: one core stat die (PC, explodes) or a manually-picked die size (NPC, also explodes) ---
    const targetProfile = allProfiles.find(p => p.id === target.owner_id);
    // Same "non-DM owner + linked character" rule as the modal's defenderIsPC — see its comment above.
    const isPC = !!(targetProfile && targetProfile.role !== 'dm' && targetProfile.character && targetProfile.character.id);
    let defTotal = 0, defLabel = '';
    if (isPC) {
        const statName = document.getElementById('atk-defense-stat-select').value;
        const statKey = 'stat_' + statName.toLowerCase();
        const faces = parseInt((targetProfile.character[statKey] || 'd4').replace('d', '')) || 4;
        const { rollTotal, subRolls } = rollExplodingDie(faces, faces >= 2);
        defTotal = rollTotal;
        defLabel = `${target.name} defends with ${statName} (d${faces}: ${subRolls.join('💥')})`;
    } else {
        const faces = parseInt((document.getElementById('atk-defense-die-select').value || 'd8').replace('d', '')) || 8;
        const { rollTotal, subRolls } = rollExplodingDie(faces, faces >= 2);
        defTotal = rollTotal;
        defLabel = `${target.name} defends (DM-picked d${faces}: ${subRolls.join('💥')})`;
    }

    // --- Resolution: higher total wins. On a tie, the player-controlled side
    // wins; if that's ambiguous (both sides player-controlled, or neither is —
    // e.g. two DM-run NPCs), the attacker wins the tie as a deliberate
    // default, not something the confirmed design specified either way. ---
    const attackerIsPlayer = currentUserRole !== 'dm';
    const defenderIsPlayer = isPC; // isPC already requires a non-DM owner, see the comment above
    let hit;
    if (atkTotal > defTotal) hit = true;
    else if (atkTotal < defTotal) hit = false;
    else hit = !(defenderIsPlayer && !attackerIsPlayer);

    // Ammo is consumed on any fired shot, hit or miss — the round left the barrel either way.
    if (wpn.ammo !== null && wpn.ammo !== undefined) {
        wpn.ammo = Math.max(0, wpn.ammo - 1);
        await db.from('character_arsenal').update({ ammo: wpn.ammo }).eq('id', wpn.id);
        if (typeof window.renderArsenal === 'function') window.renderArsenal();
    }

    let resultHtml = `
        <div style="margin-top:4px; padding:4px; border-left:2px solid #ff3333; background:rgba(255,51,51,0.1);">
            <strong>To-Hit:</strong> ${atkBreakdown.join(' + ')} = <strong style="color:#ffaa00;">${atkTotal}</strong><br>
            <strong>Defense:</strong> ${defLabel} = <strong style="color:#00e1ff;">${defTotal}</strong><br>
            <strong style="color:${hit ? '#00e5a3' : '#ff3333'};">${hit ? '✅ HIT' : '❌ MISS'}</strong>
        </div>`;

    let finalTotal = atkTotal;

    if (hit) {
        // wpn.dice was already validated against diceRegex before this
        // function did anything else (ammo spend, chat broadcast) — this
        // match is guaranteed to succeed, no silent "hit with no damage" path.
        const match = wpn.dice.trim().match(diceRegex);
        let numDice = parseInt(match[1]) || 1;
        let diceFaces = parseInt(match[2]);
        let canExplode = wpn.explodes && diceFaces >= 2;
        let dmgTotal = 0;
        let dmgBreakdownParts = [];
        for (let i = 0; i < numDice; i++) {
            const { rollTotal, subRolls } = rollExplodingDie(diceFaces, canExplode);
            dmgTotal += rollTotal;
            dmgBreakdownParts.push(`(d${diceFaces}: ${subRolls.join('💥')})`);
        }
        dmgTotal += modVal;
        if (modVal !== 0) dmgBreakdownParts.push(`[Mod: ${modVal >= 0 ? '+' : ''}${modVal}]`);
        finalTotal = dmgTotal;
        resultHtml += `
            <div style="margin-top:4px; padding:4px; border-left:2px solid #ffaa00; background:rgba(255,170,0,0.1);">
                <strong>Damage:</strong> ${dmgBreakdownParts.join(' + ')} = <strong style="color:#ff3333;">${dmgTotal} Dmg</strong>
            </div>`;
    }

    if (window.AudioEngine) window.AudioEngine.playShoot();
    if (typeof window.closeArsenalAttackModal === 'function') window.closeArsenalAttackModal();

    if (typeof window.broadcastRoll === 'function') {
        await window.broadcastRoll(`[${myProf.username || 'Commander'}] ATTACKS ${target.name} with ${wpn.name}`, resultHtml, finalTotal);
    }
};

window.executeDicePoolRoll = async function() {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    const char = myProf.character || {};
    const skills = myProf.skills || {};

    let statCheckboxes = document.querySelectorAll('.roll-stat-cb:checked');
    let skillCheckboxes = document.querySelectorAll('.roll-skill-cb:checked');
    let extraMod = parseInt(document.getElementById('roll-extra-mod').value) || 0;

    if (statCheckboxes.length === 0 && skillCheckboxes.length === 0 && extraMod === 0) {
        alert("Select at least one stat, skill, or extra modifier to roll.");
        return;
    }

    let total = 0;
    let breakdown = [];
    
    statCheckboxes.forEach(cb => {
        let statName = cb.value;
        let statKey = 'stat_' + statName.toLowerCase();
        let diceStr = char[statKey] || 'd4';
        let faces = parseInt(diceStr.replace('d', ''));
        
        let rollTotal = 0;
        let subRolls = [];
        let currentRoll;
        do {
            currentRoll = Math.floor(Math.random() * faces) + 1;
            rollTotal += currentRoll;
            subRolls.push(currentRoll);
        } while (currentRoll === faces && faces >= 2);
        
        total += rollTotal;
        breakdown.push(`${statName} (d${faces}: ${subRolls.join('💥')})`);

        const perkBonus = window.getPerkBonusFor(myProf.perks, 'stat', statName);
        if (perkBonus.total !== 0) {
            total += perkBonus.total;
            breakdown.push(`[${statName} Perks: ${perkBonus.sources.join(', ')}]`);
        }
    });

    skillCheckboxes.forEach(cb => {
        let skillName = cb.value;
        let safeKey = skillName.toLowerCase().replace(/[^a-z0-9]/g, '_');
        let skillMod = skills[safeKey] || 0;
        total += skillMod;
        breakdown.push(`[${skillName} Mod: ${skillMod >= 0 ? '+' : ''}${skillMod}]`);

        const perkBonus = window.getPerkBonusFor(myProf.perks, 'skill', skillName);
        if (perkBonus.total !== 0) {
            total += perkBonus.total;
            breakdown.push(`[${skillName} Perks: ${perkBonus.sources.join(', ')}]`);
        }
    });

    if (extraMod !== 0) {
        total += extraMod;
        breakdown.push(`[Extra Mod: ${extraMod >= 0 ? '+' : ''}${extraMod}]`);
    }

    let breakdownString = `
        <div style="margin-top:4px; padding:4px; border-left:2px solid #00e5a3; background:rgba(0,229,163,0.1);">
            <strong>Roll Pool:</strong><br>
            ${breakdown.join('<br>')}
            <br><strong>Total Result:</strong> <strong style="color:#00e5a3;">${total}</strong>
        </div>
    `;
    
    document.querySelectorAll('.roll-stat-cb').forEach(cb => cb.checked = false);
    document.querySelectorAll('.roll-skill-cb').forEach(cb => cb.checked = false);
    document.getElementById('roll-extra-mod').value = 0;

    if (window.AudioEngine) window.AudioEngine.playShoot();

    if(typeof window.broadcastRoll === 'function') {
        await window.broadcastRoll(`[${myProf.username || 'Commander'}] STAT/SKILL CHECK`, breakdownString, total);
    }
};

/* --- COMBAT INITIATIVE TRACKER & ROUND AUTOMATOR --- */
window.renderCombatTracker = function() {
    const containers = [
        { el: document.getElementById('combat-tracker-body'), suffix: 'panel' },
        { el: document.getElementById('terminal-combat-body'), suffix: 'term' }
    ];

    const myProf = allProfiles.find(p => p.id === currentUserId);
    const myCombatName = (myProf && myProf.character && myProf.character.name) ? myProf.character.name : (myProf ? (myProf.username || 'Commander') : 'Commander');

    containers.forEach(container => {
        if (!container.el) return;
        let html = '';
        if (currentUserRole === 'dm') {
            html += `
                <div style="background:#040605; padding:8px; border:1px solid #3c4e36; margin-bottom:8px;">
                    <label for="comb-name-${container.suffix}" style="display:none;">Name</label>
                    <input type="text" id="comb-name-${container.suffix}" placeholder="Combatant Name..." style="font-size:10px; margin:2px 0;">
                    <div style="display:flex; gap:6px;">
                        <label for="comb-init-${container.suffix}" style="display:none;">Initiative</label>
                        <input type="number" id="comb-init-${container.suffix}" placeholder="Initiative" style="font-size:10px; margin:2px 0;">
                        <label for="comb-hp-${container.suffix}" style="display:none;">HP</label>
                        <input type="text" id="comb-hp-${container.suffix}" placeholder="HP/Vit" value="10/10" style="font-size:10px; margin:2px 0;">
                    </div>
                    <button class="btn-reveal" onclick="window.addCombatant('${container.suffix}')" style="font-size:10px; margin-top:4px;">+ ADD TO INITIATIVE</button>
                    <button class="btn-deploy" onclick="window.advanceCombatRound()" style="font-size:10px; margin-top:6px; width:100%;">⏭️ ADVANCE COMBAT ROUND</button>
                </div>
            `;
        } else {
            html += `
                <div style="background:#040605; padding:8px; border:1px solid #3c4e36; margin-bottom:8px;">
                    <span style="font-size:9px; color:#6b826a;">Joining as: <strong style="color:#00e5a3;">${myCombatName}</strong></span>
                    <label for="comb-init-${container.suffix}" style="display:none;">Initiative</label>
                    <input type="number" id="comb-init-${container.suffix}" placeholder="Your Initiative Roll" style="font-size:10px; margin:4px 0;">
                    <button class="btn-reveal" onclick="window.joinCombatInitiative('${container.suffix}')" style="font-size:10px; width:100%;">+ JOIN INITIATIVE</button>
                </div>
            `;
        }
        html += '<div style="max-height:220px; overflow-y:auto;">';
        combatantsList.forEach(c => {
            const canRemove = currentUserRole === 'dm' || c.owner_id === currentUserId;
            let fuelBadge = '';
            if (c.is_strike_craft) {
                const parent = globalShipMarkersCache.find(m => m.id === c.parent_id);
                const sq = parent ? (parent.ship_deployed || []).find(s => s.id === c.squadron_id) : null;
                const loiter = sq ? sq.loiter : 0;
                const fuelColor = loiter <= 1 ? '#ff3333' : '#ffaa00';
                fuelBadge = ` <span style="color:${fuelColor}; font-weight:bold;">[⛽ ${loiter}/4]</span>`;
            }
            html += `
                <div class="note-card" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; padding:6px;">
                    <div>
                        <strong style="color:#00e5a3; font-size:11px;">[Init: ${c.initiative}] ${c.name}${fuelBadge}</strong>
                        <p style="margin:2px 0 0 0; font-size:10px; color:#6b826a;">HP/Status: ${c.hp}</p>
                    </div>
                    ${canRemove ? `<button class="layer-del" onclick="window.removeCombatant('${c.id}')" style="padding:2px 6px; font-size:9px;">${currentUserRole === 'dm' && c.owner_id !== currentUserId ? 'X' : 'LEAVE'}</button>` : ''}
                </div>
            `;
        });
        html += '</div>';
        container.el.innerHTML = html;
    });
};

window.addCombatant = async function(suffix) {
    const nameInput = document.getElementById(`comb-name-${suffix}`);
    const initInput = document.getElementById(`comb-init-${suffix}`);
    const hpInput = document.getElementById(`comb-hp-${suffix}`);
    
    if (!nameInput || !initInput || !hpInput) return;

    const name = nameInput.value.trim();
    const initiative = parseInt(initInput.value) || 10;
    const hp = hpInput.value.trim();
    
    if (!name) return;
    
    const { error } = await db.from('combat_tracker').insert({ name, initiative, hp, owner_id: currentUserId });
    if (error) { alert("Failed to add combatant: " + error.message); return; }
    nameInput.value = ''; initInput.value = ''; hpInput.value = '10/10';
    if(typeof loadCombatTracker === 'function') loadCombatTracker();
};

window.joinCombatInitiative = async function(suffix) {
    const initInput = document.getElementById(`comb-init-${suffix}`);
    if (!initInput) return;
    const initiative = parseInt(initInput.value) || 10;

    const myProf = allProfiles.find(p => p.id === currentUserId);
    const name = (myProf && myProf.character && myProf.character.name) ? myProf.character.name : (myProf ? (myProf.username || 'Commander') : 'Commander');
    const vitality = (myProf && myProf.character && myProf.character.vitality !== undefined) ? myProf.character.vitality : null;
    const hp = vitality !== null ? `${vitality}/${vitality}` : '10/10';

    const { error } = await db.from('combat_tracker').insert({ name, initiative, hp, owner_id: currentUserId });
    if (error) { alert("Failed to join initiative: " + error.message); return; }
    initInput.value = '';
    if(typeof loadCombatTracker === 'function') loadCombatTracker();
};

window.removeCombatant = async function(id) {
    const c = combatantsList.find(x => x.id === id);
    if (c && currentUserRole !== 'dm' && c.owner_id !== currentUserId) return;
    await db.from('combat_tracker').delete().eq('id', id); 
    if(typeof loadCombatTracker === 'function') loadCombatTracker(); 
};

window.advanceCombatRound = async function() {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Advance combat round? This will process cooldowns, overheat, and force-recall any strike craft that run out of fuel."))) return;

    let anyChanged = false;
    let klaxonTriggered = false;

    for (let vessel of globalShipMarkersCache) {
        let changed = false;
        let weapons = vessel.ship_weapons || [];
        let deployed = vessel.ship_deployed || [];
        let hangar = vessel.ship_hangar || [];
        let flightLog = [];
        let recalledSquadronIds = [];

        weapons.forEach(w => {
            if (w.cooldown > 0) { w.cooldown -= 1; changed = true; }
            if (w.overheat > 0) { w.overheat -= 1; changed = true; }
        });

        // System hazard effects: Pulsar Radiation was pure flavor text on star
        // systems until now — this is what actually makes it "double weapon
        // overheat" and apply minor continuous thermal damage, as originally
        // described in the System Architect tool's own hazard dropdown.
        let hullChanged = false;
        const hazardHits = (typeof window.checkShipHazards === 'function') ? window.checkShipHazards(vessel) : [];
        const pulsarHit = hazardHits.find(h => h.type === 'pulsar');
        if (pulsarHit) {
            const intensity = pulsarHit.intensity || 1;
            weapons.forEach(w => { w.overheat = Math.min(10, (w.overheat || 0) + intensity); });
            const thermalDmg = intensity;
            let curHull = vessel.integrity_hull !== undefined ? vessel.integrity_hull : 300;
            vessel.integrity_hull = Math.max(0, curHull - thermalDmg);
            hullChanged = true;
            changed = true;
            flightLog.push(`☢️ Pulsar radiation cooked weapon systems (+${intensity} overheat) and hull plating (-${thermalDmg} Hull).`);
        }

        let stillDeployed = [];
        deployed.forEach(sq => {
            if (sq.loiter > 0) { sq.loiter -= 1; changed = true; }
            if (sq.loiter <= 0) {
                flightLog.push(`⚠️ ${sq.name} hit BINGO FUEL — forced RTB to hangar!`);
                klaxonTriggered = true;
                sq.loiter = 4; // reset ready for next deployment
                hangar.push(sq);
                recalledSquadronIds.push(sq.id);
                changed = true;
            } else {
                stillDeployed.push(sq);
            }
        });
        deployed = stillDeployed;

        if (changed) {
            anyChanged = true;
            let updatePayload = { ship_weapons: weapons, ship_deployed: deployed, ship_hangar: hangar };
            if (hullChanged) updatePayload.integrity_hull = vessel.integrity_hull;
            await db.from('ship_markers').update(updatePayload).eq('id', vessel.id);
            vessel.ship_deployed = deployed;
            vessel.ship_hangar = hangar;
        }

        for (const sqId of recalledSquadronIds) {
            await despawnSquadronToken(sqId);
        }

        if (flightLog.length > 0) {
            await db.from('chat_logs').insert({
                sender_id: null,
                content: `🚨 [FLIGHT OPS] ${vessel.name}: ${flightLog.join(' ')}`,
                message_type: 'system'
            });
        }
    }

    // Tactical Battle Map movement: refreshes every active-battle token's
    // move_remaining back to its vessel's tactical_speed on this same tick,
    // per confirmed design (see js/battle-map.js file header). No-op outside
    // an active battle.
    if (typeof window.resetBattleMapMovement === 'function') await window.resetBattleMapMovement();

    // Range/Ordnance: ages in-flight ordnance (splits into 6 after turn 1,
    // resolves impact when turns run out) and auto-resolves Point Defense
    // against both inbound payloads and engaged strike craft, on this same
    // tick. See js/battle-map.js's file header for the full confirmed
    // design. No-op outside an active battle.
    if (typeof window.processBattleRoundAutomations === 'function') await window.processBattleRoundAutomations();

    if (anyChanged) {
        if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
        if(typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
    }

    if (klaxonTriggered && window.AudioEngine) {
        window.AudioEngine.playKlaxon();
    }

    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `⏭️ [TACTICAL] Combat round advanced. Cooldowns reduced. Heat dissipated. Strike craft loiter time degraded.`,
        message_type: 'text'
    });
};
