/* ==========================================================================
   js/combat.js - Tactical Engine, Arsenal & Diagnostics
   ========================================================================== */


// STRIKE_CRAFT_DB and SQUADRON_TACTICAL_SPEED live in js/squadrons.js.


/* --- PERKS & SPECIALIZATIONS ---
   Perks are a DB-backed catalog (perk_definitions); see js/perk-designer.js
   for perkDefinitionsList and window.getPerkBonusFor. */


/* --- CARGO ITEM CATALOG ---
   DB-backed catalog (cargo_item_catalog) of named cargo items. Feeds the
   pick-lists in the Cargo Deck form here and the Secret Repository cargo
   editor (js/ship-designer.js); custom free-text items are still allowed.
   Anyone can read; only the DM sees the add/remove editor (gated in
   js/db.js handleLogin). */
let cargoItemCatalogList = [];

window.loadCargoItemCatalog = async function() {
    const { data, error } = await db.from('cargo_item_catalog').select('*').order('manifest_section', { ascending: true }).order('name', { ascending: true });
    if (error) { console.error('Failed to load cargo item catalog:', error.message); return; }
    cargoItemCatalogList = data || [];
    if (typeof window.renderCargoCatalogPickers === 'function') window.renderCargoCatalogPickers();
    if (typeof window.renderCargoCatalogDmList === 'function') window.renderCargoCatalogDmList();
};

// <optgroup>-by-manifest-section option list. Used by the Cargo Deck's static
// picker (renderCargoCatalogPickers) and by the Secret Repository cargo editor,
// which rebuilds its picker inline every render.
window.renderCargoCatalogOptionsHtml = function() {
    const bySection = {};
    cargoItemCatalogList.forEach(item => {
        const sec = item.manifest_section || 'Other';
        if (!bySection[sec]) bySection[sec] = [];
        bySection[sec].push(item);
    });
    return Object.keys(bySection).sort().map(sec => {
        const opts = bySection[sec].map(item => `<option value="${item.id}">${item.name}${item.unit ? ' (' + item.unit + ')' : ''}</option>`).join('');
        return `<optgroup label="${sec}">${opts}</optgroup>`;
    }).join('');
};

// Repopulates the static pickers (currently just #new-cargo-catalog-pick).
// The Secret Repository picker rebuilds itself each render (ship-designer.js).
window.renderCargoCatalogPickers = function() {
    const sel = document.getElementById('new-cargo-catalog-pick');
    if (sel) sel.innerHTML = '<option value="">-- Custom / Free-Text Item --</option>' + window.renderCargoCatalogOptionsHtml();
};

// idPrefix is 'new' (Cargo Deck form, #new-cargo-*) or 'repo' (Secret
// Repository form, #repo-cargo-*).
window.applyCargoCatalogPick = function(idPrefix, catalogId) {
    if (!catalogId) return;
    const item = cargoItemCatalogList.find(c => c.id === catalogId);
    if (!item) return;
    const nameEl = document.getElementById(idPrefix + '-cargo-name');
    const unitEl = document.getElementById(idPrefix + '-cargo-unit');
    const catEl = document.getElementById(idPrefix + '-cargo-category');
    if (nameEl) nameEl.value = item.name;
    if (unitEl) unitEl.value = item.unit || '';
    if (catEl) catEl.value = item.category;
    // Quantity is deliberately left for the DM/player to fill in -- the
    // catalog doesn't have an opinion on how much of something you're adding.
};

window.addCargoCatalogItem = async function() {
    if (currentUserRole !== 'dm') return;
    const nameInput = document.getElementById('catalog-new-name');
    const name = nameInput.value.trim();
    if (!name) { alert("Enter an item name."); return; }
    const code = document.getElementById('catalog-new-code').value.trim() || null;
    const unit = document.getElementById('catalog-new-unit').value.trim() || null;
    const category = document.getElementById('catalog-new-category').value;
    const manifest_section = document.getElementById('catalog-new-section').value.trim() || null;
    const notes = document.getElementById('catalog-new-notes').value.trim() || null;
    const { error } = await db.from('cargo_item_catalog').insert({ code, name, unit, category, manifest_section, notes });
    if (error) { alert("Failed to add catalog item: " + error.message); return; }
    document.getElementById('catalog-new-code').value = '';
    nameInput.value = '';
    document.getElementById('catalog-new-unit').value = '';
    document.getElementById('catalog-new-section').value = '';
    document.getElementById('catalog-new-notes').value = '';
    window.loadCargoItemCatalog();
};

window.deleteCargoCatalogItem = async function(id) {
    if (currentUserRole !== 'dm') return;
    if (!confirm("Remove this item from the catalog? This does not affect cargo already stored on any ship.")) return;
    const { error } = await db.from('cargo_item_catalog').delete().eq('id', id);
    if (error) { alert("Failed to remove catalog item: " + error.message); return; }
    window.loadCargoItemCatalog();
};

window.renderCargoCatalogDmList = function() {
    const container = document.getElementById('cargo-catalog-dm-list');
    if (!container) return;
    if (!cargoItemCatalogList.length) { container.innerHTML = '<div style="font-size:9px; color:#6b826a;">No catalog items yet.</div>'; return; }
    container.innerHTML = cargoItemCatalogList.map(c => `<div style="display:flex; justify-content:space-between; align-items:center; font-size:9px; padding:3px 0; border-bottom:1px solid #1c261a;"><span>${c.name} <span style="color:#6b826a;">(${c.category}${c.unit ? ', ' + c.unit : ''})</span></span><button onclick="window.deleteCargoCatalogItem('${c.id}')" style="font-size:8px; padding:1px 5px;">✕</button></div>`).join('');
};

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
    // Guarantee all three arrays exist even on a partial object (hand-edited or
    // legacy cargo). Callers (deliverColonyResources, fleet-group production tick,
    // cargo UI) push into these without their own null-guard.
    if (!Array.isArray(inv.perishables)) inv.perishables = [];
    if (!Array.isArray(inv.expendables)) inv.expendables = [];
    if (!Array.isArray(inv.misc)) inv.misc = [];
    if (inv.synth_capacity === undefined) inv.synth_capacity = 10;
    return inv;
};

// Cargo Deck access uses the Vessel Deck rule, window.canAccessVesselDeck (DM
// sees everything; a player sees own, IFF-friendly and other players' ships,
// never hidden ones). Every cargo mutation re-checks it (canEditCargo) because a
// stale dropdown or hand-typed onclick could bypass the list filter.
// Keeps the current selection when the list is rebuilt.
function canEditCargo(vessel) {
    if (typeof window.canAccessVesselDeck === 'function' && !window.canAccessVesselDeck(vessel)) {
        if (window.AudioEngine) window.AudioEngine.playError();
        alert("🔒 You don't have access to this vessel's cargo.");
        return false;
    }
    return true;
}
window.populateCargoVesselSelect = function() {
    const select = document.getElementById('cargo-vessel-select');
    if (!select) return;
    const prev = select.value;
    let html = '';
    globalShipMarkersCache.forEach(m => {
        if (typeof window.canAccessVesselDeck === 'function' && !window.canAccessVesselDeck(m)) return;
        html += `<option value="${m.id}">${m.name} (X: ${Math.round(m.x)}, Y: ${Math.round(m.y)})</option>`;
    });
    select.innerHTML = html || '<option value="">No accessible vessels found</option>';
    if (prev && Array.from(select.options).some(o => o.value === prev)) select.value = prev;
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
    if (typeof window.canAccessVesselDeck === 'function' && !window.canAccessVesselDeck(vessel)) {
        container.innerHTML = '<span style="font-size:10px; color:#ff3333;">🔒 DM ONLY — this vessel\'s cargo is not accessible to you.</span>';
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
    // Food supply in crew-days for this ship's crew.
    if (typeof window.foodValueOf === 'function') {
        const crew = window.vesselCrew(vessel);
        let crewDays = 0, shipDays = 0;
        (cargo.perishables || []).forEach(i => { const v = window.foodValueOf(i); if (v === 'ship') shipDays += Number(i.qty) || 0; else if (v) crewDays += (Number(i.qty) || 0) * v; });
        const days = crew > 0 ? shipDays + crewDays / crew : Infinity;
        html += `<div style="font-size:10px; color:${days < 7 ? '#ff6b6b' : '#8fa7b0'}; margin:0 0 8px 0;" title="Food is counted in crew-days. Crew is set in EDIT BASE STATS (blank = ${window.defaultCrew()}).">🍽 Food: ${isFinite(days) ? `${days >= 1000 ? Math.round(days).toLocaleString() : days.toFixed(1)} days` : '—'} for a crew of ${crew}${vessel.crew == null ? ' (default)' : ''}</div>`;
    }
    
    if (currentCategoryItems.length === 0) {
        html += `<span style="font-size:11px; color:#6b826a;">No cargo items recorded in this section. Use the form on the right to store items.</span>`;
    } else {
        currentCategoryItems.forEach((item, index) => {
            // Cargo items have no stable id, so reordering swaps array entries and
            // saves; the array order is the persisted data.
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
    if (!canEditCargo(vessel)) return;
    
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
    if (!canEditCargo(vessel)) return;
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    cargo.synth_capacity = Math.max(0, Math.min(10, cargo.synth_capacity + delta));
    await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
    vessel.cargo_inventory = cargo;
    window.renderTerminalCargoDeck();
};

window.modifyCargoQty = async function(vesselId, itemIndex, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    if (!canEditCargo(vessel)) return;
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
    if (!canEditCargo(vessel)) return;
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
    if (!canEditCargo(vessel)) return;
    if (!(await window.showConfirmModal("Decommission this cargo item from vessel hold?"))) return;
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    if (cargo[activeCargoSubtab]) {
        cargo[activeCargoSubtab].splice(itemIndex, 1);
        await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
        vessel.cargo_inventory = cargo;
        window.renderTerminalCargoDeck();
    }
};

// Cargo items have no stable id: reorder is a direct array-index swap saved
// to the DB, not the localStorage reorder helper used elsewhere.
window.moveCargoItem = async function(vesselId, index, direction) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    if (!canEditCargo(vessel)) return;
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
    if (!canEditCargo(vessel)) return;

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
    if (!canEditCargo(vessel)) return;

    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `📦 [FULL CARGO MANIFEST] Vessel '${vessel.name}' synchronized manifest to fleet telemetry.`,
        message_type: 'text'
    });
    alert("Full cargo manifest broadcasted to Secure Comms!");
};

/* --- VESSEL DECK LOGIC --- */
// Non-DM players only see vessels that pass window.canAccessVesselDeck.
// Others are absent from the list (not just read-only), so a player can't
// tell they exist. DM sees everything.
window.populateVesselDeckSelect = function() {
    const select = document.getElementById('vessel-deck-select');
    if (!select) return;
    let html = '';
    globalShipMarkersCache.forEach(m => {
        if (!window.canAccessVesselDeck(m)) return;
        html += `<option value="${m.id}">${m.name}</option>`;
    });
    select.innerHTML = html || '<option value="">No accessible vessels found</option>';
};

// window.canAccessVesselDeck (below getIffColor): "friendly" mirrors the
// Battle Map ship cards (js/battle-map.js) - any player-owned ship counts, plus
// DM/NPC ships with iff 'friendly'. DM bypasses all of it.
// Fog of War is checked first: a vessel hidden from this viewer is
// inaccessible whatever its IFF, except to its own player-owner (same
// exception as window.isVesselVisibleToMe).
/* Shared IFF -> token color. Delegates to window.IFF_COLORS
   (js/ship-designer.js, loads before this file); null/unset falls back to
   cyan '#00e1ff'. Templates get their color from this on deploy; editing a
   live vessel's IFF later does not recolor it, so a deliberately chosen
   color is not overwritten. */
window.getIffColor = function(iff) {
    return (window.IFF_COLORS && window.IFF_COLORS[iff]) || '#00e1ff';
};

window.canAccessVesselDeck = function(vessel) {
    if (!vessel) return false;
    if (currentUserRole === 'dm') return true;
    if (typeof window.isVesselVisibleToMe === 'function' && !window.isVesselVisibleToMe(vessel)) return false;
    if (window.vesselHasOwner(vessel, currentUserId)) return true;
    if (vessel.iff === 'friendly') return true;
    const ownerProfs = window.vesselOwnerIds(vessel).map(id => (typeof allProfiles !== 'undefined' ? allProfiles : []).find(p => p.id === id)).filter(Boolean);
    return ownerProfs.some(p => p.role !== 'dm');
};

// Shared Fog of War visibility check, used wherever a vessel could leak to a
// non-DM client (Battle Map grid/cards, getBattleScopedTargets, target
// dropdown fallbacks, canAccessVesselDeck). Hidden means invisible to everyone
// except the DM and the vessel's own player-owner, regardless of IFF or battle.
// Fails open (visible) if the vessel record is missing.
window.isVesselVisibleToMe = function(vessel) {
    if (!vessel) return true;
    if (!vessel.is_hidden) return true;
    if (currentUserRole === 'dm') return true;
    return window.vesselHasOwner(vessel, currentUserId);
};

// A hidden vessel un-hides as soon as it fires anything: manual fire, ordnance,
// squadron fire (manual or AI stance), ship/squadron Point Defense. Called
// best-effort from each path; call sites wrap it in try/catch so a failure
// here never loses the shot.
window.revealVesselIfHidden = async function(vessel) {
    if (!vessel || !vessel.is_hidden) return;
    vessel.is_hidden = false;
    await db.from('ship_markers').update({ is_hidden: false }).eq('id', vessel.id);
    await db.from('chat_logs').insert({ sender_id: null, content: `💥 [FOG OF WAR] ${vessel.name} reveals its position by opening fire!`, message_type: 'system' });
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
   Used by both the Vessel Deck and the Battle Map ship-status cards
   (js/battle-map.js). Stance and health markup pass values straight to their
   handlers, so no id prefixing is needed - unlike the weapon-row renderer
   below, where two callers can render the same weapon at once. */
window.renderShipStanceHtml = function(vessel) {
    let currentStance = vessel.ship_stance || 'Balanced';
    // Read-only vessel_class badge ('Capital'/'Escort'), shown only when set.
    // Edited via EDIT BASE STATS; read only by squadron AI target filtering
    // (Attack Capital Ships / Attack Escorts) in processBattleRoundAutomations.
    const classBadge = vessel.vessel_class
        ? `<span style="font-size:8px; color:#c9962f; border:1px solid #c9962f; border-radius:2px; padding:1px 5px;" title="Vessel classification -- used by squadron AI Stances to tell Capital Ships apart from Escorts. Set via EDIT BASE STATS.">${vessel.vessel_class === 'Capital' ? '⬢ CAPITAL' : '◆ ESCORT'}</span>`
        : window.unclassifiedBadgeHtml(vessel);
    return `
        <div style="margin-top:10px; margin-bottom:10px; padding:6px; background:#0a1410; border:1px solid #00e5a3; border-radius:2px; display:flex; justify-content:space-between; align-items:center; gap:6px;">
            ${window.mediaThumbHtml(vessel.image_url, { size: 36, caption: vessel.name })}
            <label for="vessel-stance-${vessel.id}" style="font-size:10px; color:#00e5a3; font-weight:bold; white-space:nowrap;">TACTICAL STANCE:</label>
            <select id="vessel-stance-${vessel.id}" onchange="window.updateShipStance('${vessel.id}', this.value)" style="width:160px; margin:0; padding:4px; font-size:10px; background:#040605; color:#00e5a3; border:1px solid #3c4e36;">
                <option value="Balanced" ${currentStance === 'Balanced' ? 'selected' : ''}>Balanced (Standard)</option>
                <option value="Aggressive" ${currentStance === 'Aggressive' ? 'selected' : ''}>Aggressive (+Dmg, -Def)</option>
                <option value="Defensive" ${currentStance === 'Defensive' ? 'selected' : ''}>Defensive (+Def, -Dmg)</option>
                <option value="Evasive" ${currentStance === 'Evasive' ? 'selected' : ''}>Evasive (½ Dmg dealt &amp; taken)</option>
            </select>
            ${classBadge}
        </div>
    `;
};

// editable=false omits the +/- buttons (enemy/NPC cards on the Battle Map).
window.renderShipHealthBarsHtml = function(vessel, editable) {
    // Use `!== undefined`, not `|| default`: an explicit 0 max (e.g. a derelict
    // with no shields) must display as "0 / 0", not the default max.
    const s_int = vessel.integrity_shields !== undefined ? vessel.integrity_shields : 400;
    const s_max = vessel.max_shields !== undefined ? vessel.max_shields : 400;
    const h_int = vessel.integrity_hull !== undefined ? vessel.integrity_hull : 300;
    const h_max = vessel.max_hull !== undefined ? vessel.max_hull : 300;
    const r_int = vessel.integrity_reactive !== undefined ? vessel.integrity_reactive : 10;
    const r_max = vessel.max_reactive !== undefined ? vessel.max_reactive : 10;
    const a_int = vessel.integrity_ablative !== undefined ? vessel.integrity_ablative : 10;
    const a_max = vessel.max_ablative !== undefined ? vessel.max_ablative : 10;
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

    // Directional armor: four side bars replace the Hardened bar while the switch is on.
    const sideBars = typeof window.renderArmorSideBarsHtml === 'function' ? window.renderArmorSideBarsHtml(vessel, editable) : null;
    return makeBar('DEFLECTOR SHIELDS', s_int, s_max, '#00e1ff', 'shields') + makeBar('REACTIVE ARMOR (IMPACT/EXPLOSIVE)', r_int, r_max, '#ffaa00', 'reactive') + makeBar('ABLATIVE ARMOR (HEAT/ENERGY)', a_int, a_max, '#ffaa00', 'ablative') + (sideBars || makeBar('HARDENED ARMOR', hd_int, Math.max(1, hd_max), '#c9962f', 'hardened')) + makeBar('HULL INTEGRITY', h_int, h_max, '#ff3333', 'hull');
};

// idPrefix keeps target/volley element ids unique when the same weapon is
// rendered twice (Vessel Deck uses '', Battle Map cards 'bm-').
// showManageButtons:false hides the edit/delete weapon buttons (Battle Map
// cards); weapons are only edited from the Vessel Deck.
window.renderShipWeaponsHtml = function(vessel, opts) {
    opts = opts || {};
    const idPrefix = opts.idPrefix || '';
    const showManageButtons = opts.showManageButtons !== false;
    const weapons = vessel.ship_weapons || [];
    if (weapons.length === 0) return '<span style="font-size:10px; color:#6b826a;">No weapon hardpoints installed.</span>';
    let wHtml = '';
    weapons.forEach((w, idx) => {
        const battleScoped = (typeof window.getBattleScopedTargets === 'function') ? window.getBattleScopedTargets(vessel.id, w.range, { firerVessel: vessel, wpn: w, includeOutOfArc: true }) : null;
        // Fallback when there's no battle/token: getBattleScopedTargets already
        // filters hidden vessels, so apply the same filter here.
        const targetCandidates = battleScoped || globalShipMarkersCache.filter(m => m.id !== vessel.id && (typeof window.isVesselVisibleToMe !== 'function' || window.isVesselVisibleToMe(m)));
        let targetOptions = '<option value="">-- No Target --</option>';
        // Out-of-arc and terrain-blocked targets stay listed but greyed + unselectable.
        targetCandidates.forEach(m => { targetOptions += (m.out_of_arc || m.terrain_block)
            ? `<option value="${m.id}" disabled style="color:#5a5a5a;">${m.is_strike_craft ? '🛩️ ' : ''}${m.name} (${m.out_of_arc ? 'out of arc' : (/nebula/i.test(m.terrain_block) ? 'in nebula' : 'blocked')})</option>`
            : `<option value="${m.id}">${m.is_strike_craft ? '🛩️ ' : ''}${m.name}</option>`; });

        let wDmgType = window.normalizeDamageType(w.damage_type || window.inferLegacyDamageType(w.name));
        let wDmgInfo = window.DAMAGE_TYPES[wDmgType];
        let wClass = w.weapon_class === 'ordnance' ? 'ordnance' : 'direct_fire';
        let classBadge = wClass === 'ordnance' ? `<span style="font-size:8px; color:#c778dd; border:1px solid #c778dd; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Ordnance — multi-turn flight, counter-fireable by Point Defense">☠ ORDNANCE</span>` : '';
        let pdBadge = w.is_point_defense ? `<span style="font-size:8px; color:#66d9ff; border:1px solid #66d9ff; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Point Defense — auto-fires at inbound ordnance and engaged strike craft on Advance Round">🛡 PD</span>` : '';
        let rangeBadge = w.range ? `<span style="font-size:8px; color:#6b826a; border:1px solid #3c4e36; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Battle Map targeting range">📏 ${w.range}</span>` : '';
        let cooldownPeriodBadge = w.cooldown_period ? `<span style="font-size:8px; color:#ff9d4d; border:1px solid #ff9d4d; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Firing auto-sets Cooldown to this many turns">⏱ ${w.cooldown_period}</span>` : '';
        // Badge for ordnance that opted into a single warhead instead of the default
        // 6-payload split (mechanic: scaleOrdnanceDice / SINGLE_WARHEAD_DICE_MULT and
        // processBattleRoundAutomations in js/battle-map.js).
        let singlePatternBadge = (wClass === 'ordnance' && w.ordnance_pattern === 'single') ? `<span style="font-size:8px; color:#ff3333; border:1px solid #ff3333; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Single Warhead — does not split into 6 payloads; heavier per-hit damage, no redundancy against interception">⊕ SINGLE</span>` : '';

        // A weapon assigned to a deck is disabled once that deck's HP hits 0.
        // Fails open (no badge, fires normally) if the assigned deck was deleted.
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
                    <strong style="color:#ff6b6b; font-size:12px;">[${w.loc || 'Unmounted'}] ${w.name}</strong>${classBadge}${pdBadge}${rangeBadge}${typeof window.weaponArcBadgeHtml === 'function' ? window.weaponArcBadgeHtml(w, vessel) : ''}${cooldownPeriodBadge}${singlePatternBadge}${deckBadge}
                    <div style="font-size:10px; color:#d4c5a9;">${w.dice} ${w.modifier} ${w.explodes ? '💥' : ''} · ${w.gun_count || 1}x Guns · <span class="dmg-tooltip" style="color:${wDmgInfo.color}; cursor:help;" title="${window.getDamageTypeTooltip(wDmgType)}">${wDmgType} ⓘ</span></div>
                </div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <label for="${idPrefix}wpn-target-${vessel.id}-${idx}" style="display:none;">Target</label>
                    <select id="${idPrefix}wpn-target-${vessel.id}-${idx}"
                        onfocus="window.showWeaponRangeRing && window.showWeaponRangeRing('${vessel.id}', ${w.range || 0}); window.showWeaponArcWedge && window.showWeaponArcWedge('${vessel.id}', ${idx})"
                        onmouseenter="window.showWeaponRangeRing && window.showWeaponRangeRing('${vessel.id}', ${w.range || 0}); window.showWeaponArcWedge && window.showWeaponArcWedge('${vessel.id}', ${idx})"
                        onblur="window.hideWeaponRangeRing && window.hideWeaponRangeRing(); window.hideArcWedges && window.hideArcWedges()"
                        onmouseleave="window.hideWeaponRangeRing && window.hideWeaponRangeRing(); window.hideArcWedges && window.hideArcWedges()"
                        onchange="window.flashBattleTargetHighlight && window.flashBattleTargetHighlight(this.value)"
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
                    <div style="font-size:9px; color:#6b826a; margin-bottom:4px;">COOLDOWN: ${w.cooldown || 0}${w.cooldown_period ? ` / ${w.cooldown_period}` : ''}</div>
                    <div style="display:flex; justify-content:center; gap:4px;"><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'cooldown', -1)" style="width:20px; padding:2px; margin:0; font-size:10px;">-</button><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'cooldown', 1)" style="width:20px; padding:2px; margin:0; font-size:10px;">+</button></div>
                </div>
                <div style="flex:1; text-align:center; background:#0a1410; border:1px solid #3c4e36; border-radius:2px; padding:4px;">
                    <div style="font-size:9px; color:#ffaa00; margin-bottom:4px;">OVERHEAT: ${w.overheat || 0}/10</div>
                    <div style="display:flex; justify-content:center; gap:4px;"><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'overheat', -1)" style="width:20px; padding:2px; margin:0; font-size:10px;">-</button><button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'overheat', 1)" style="width:20px; padding:2px; margin:0; font-size:10px;">+</button></div>
                </div>
                ${(w.max_standby_ammo > 0 && w.ammo >= 0) ? `
                <div style="flex:1; text-align:center; background:#0a1410; border:1px solid #3c4e36; border-radius:2px; padding:4px;">
                    <div style="font-size:9px; color:#6b826a; margin-bottom:4px;" title="Deep Reserves cargo item this weapon draws from: ${w.ammo_type || 'Kinetic Rounds'}">STANDBY: ${w.standby_ammo || 0}/${w.max_standby_ammo}</div>
                    <div style="display:flex; justify-content:center; gap:3px; flex-wrap:wrap;">
                        <button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'standby', -1)" style="width:18px; padding:2px; margin:0; font-size:9px;">-</button>
                        <button onclick="window.modifyShipWeaponStat('${vessel.id}', ${idx}, 'standby', 1)" style="width:18px; padding:2px; margin:0; font-size:9px;">+</button>
                        <button onclick="window.resupplyShipWeaponStandby('${vessel.id}', ${idx})" style="padding:2px 5px; margin:0; font-size:8px;" title="Transfer ${w.ammo_type || 'Kinetic Rounds'} from ship cargo (Deep Reserves) into Standby">RESUPPLY</button>
                        <button onclick="window.reloadShipWeaponReady('${vessel.id}', ${idx})" style="padding:2px 5px; margin:0; font-size:8px; border-color:#ff9d4d; color:#ff9d4d;" title="Move Standby ammo into the ready magazine — costs a Cooldown, same as firing">RELOAD</button>
                    </div>
                </div>` : ''}
            </div>
        </div>`;
    });
    return wHtml;
};

window.renderVesselDeck = function() {
    // Firing arcs: Arc dropdown in the "Mount New Weapon System" form (kept across re-renders).
    if (typeof window.ensureArcSelect === 'function') { const cur = document.getElementById('new-ship-wpn-arc'); window.ensureArcSelect('new-ship-wpn-loc', 'new-ship-wpn-arc', cur ? cur.value : ''); }
    const select = document.getElementById('vessel-deck-select');
    if (!select || !select.value) return;

    const vesselId = select.value;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    // Defense in depth: the dropdown is only rebuilt on tab switch, but this
    // re-renders on every ship_markers realtime update. If the DM makes the
    // selected vessel non-friendly or Hidden, lock every panel and bail out here.
    if (!window.canAccessVesselDeck(vessel)) {
        const lockMsg = '<span style="font-size:10px; color:#ff3333;">🔒 DM ONLY — this vessel is not accessible from your Vessel Deck.</span>';
        ['vessel-health-container', 'vessel-decks-container', 'vessel-weapons-container', 'vessel-ownership-container', 'vessel-salvage-container', 'vessel-manufacturing-container', 'vessel-embarked-container', 'vessel-deployed-container'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = (id === 'vessel-health-container') ? lockMsg : '';
        });
        return;
    }

    // Self-heal legacy decks that lack a stable id (see genDeckId/ensureDeckIds).
    // Persists once, silently.
    vessel.ship_decks = vessel.ship_decks || [];
    if (window.ensureDeckIds(vessel.ship_decks)) {
        db.from('ship_markers').update({ ship_decks: vessel.ship_decks }).eq('id', vessel.id);
    }

    const healthContainer = document.getElementById('vessel-health-container');
    const decksContainer = document.getElementById('vessel-decks-container');
    const weaponsContainer = document.getElementById('vessel-weapons-container');

    // One-time populate of the "new weapon" damage-type select; options come
    // from DAMAGE_TYPES in JS, not index.html.
    const newWpnDmgTypeSelect = document.getElementById('new-ship-wpn-dmgtype');
    if (newWpnDmgTypeSelect && newWpnDmgTypeSelect.options.length === 0) {
        newWpnDmgTypeSelect.innerHTML = window.buildDamageTypeOptionsHtml('Impact');
    }

    // Re-populated every render, since the set of decks varies by vessel.
    const newWpnDeckSelect = document.getElementById('new-ship-wpn-deck');
    if (newWpnDeckSelect) {
        const decks = vessel.ship_decks || [];
        newWpnDeckSelect.innerHTML = '<option value="">-- Not deck-gated --</option>' + decks.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
    }

    if (healthContainer) {
        let resetBtn = `<div style="display:flex; gap:6px; margin-bottom:10px;"><button class="btn-reveal" onclick="window.resetShipStats('${vessel.id}')" style="flex:1; font-size:10px; margin:0; border-color:#00e5a3;">↺ RESET COMBAT STATS</button><button class="layer-edit" onclick="window.openEditMaxStatsModal('${vessel.id}')" style="flex:1; font-size:10px; margin:0; border-color:#c9962f; color:#c9962f;">✎ EDIT BASE STATS</button></div>`;

        // Stance selector and health bars are shared with the Battle Map cards
        // (renderShipStanceHtml / renderShipHealthBarsHtml). Reset/Edit Base Stats are
        // Vessel Deck only.
        healthContainer.innerHTML = window.renderShipStanceHtml(vessel) + resetBtn + window.renderShipHealthBarsHtml(vessel, true);
    }

    if (decksContainer) {
        let dHtml = '';
        const decks = vessel.ship_decks || [];
        if (decks.length === 0) dHtml = '<span style="font-size:10px; color:#6b826a;">No internal decks designated.</span>';
        else {
            const DECK_TYPE_LABELS = { bridge: 'BRIDGE / CIC', engineering: 'ENGINEERING', manufacturing: 'MANUFACTURING', life_support: 'LIFE SUPPORT', hangar: 'HANGAR', weapons: 'WEAPONS', medical: 'MEDICAL', quarters: 'QUARTERS', cargo: 'CARGO', other: 'UNCLASSIFIED' };
            decks.forEach((d, idx) => {
                // Decks have no stable per-item id (like cargo), so reorder swaps array
                // entries and saves instead of using the localStorage reorder helper.
                const upDisabled = idx === 0 ? 'disabled' : '';
                const downDisabled = idx === decks.length - 1 ? 'disabled' : '';
                const deckType = d.type || 'other';
                // Edit a deck's type in place (keeps its HP, boarding_status and any
                // weapon's assigned_deck_id). Same permissions as the other deck actions here
                // (anyone who can reach this panel); no confirm since nothing is destroyed.
                const typeOptionsHtml = Object.keys(DECK_TYPE_LABELS).map(k => `<option value="${k}" ${deckType === k ? 'selected' : ''}>${DECK_TYPE_LABELS[k]}</option>`).join('');
                const typeLabel = `<select onchange="window.updateShipDeckType('${vessel.id}', ${idx}, this.value)" title="Deck type (mechanical) — Manufacturing-type decks are what Manufacturing Bay/Salvage Processing HP-scaling look for" style="font-size:8px; padding:1px 2px; margin:0; background:#030403; color:#6b826a; border:1px solid #3c4e36; vertical-align:middle;">${typeOptionsHtml}</select>`;
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
                        <strong>${d.name} ${typeLabel}</strong><span>${d.hp} / ${d.max_hp}</span>
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
                    <div style="display:flex; justify-content:flex-end; gap:6px;">${typeof window.deckPlanButtonHtml === 'function' ? window.deckPlanButtonHtml(vessel, d, idx) : ''}${boardingControl}</div>
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
                // Checkboxes add/remove individual co-owners without touching other owners.
                // Boarding Capture below (single-select + TRANSFER) replaces all owners with
                // one, for an actual capture.
                const currentOwnerIds = window.vesselOwnerIds(vessel);
                let ownerCheckboxesHtml = '';
                allProfiles.forEach(p => {
                    const checked = currentOwnerIds.includes(p.id) ? 'checked' : '';
                    ownerCheckboxesHtml += `
                        <label style="display:flex; align-items:center; gap:5px; font-size:10px; color:#d4c5a9; cursor:pointer; padding:2px 0;">
                            <input type="checkbox" ${checked} onchange="window.toggleVesselOwner('${vessel.id}', '${p.id}', this.checked)">
                            ${p.username || 'Commander'}${p.role === 'dm' ? ' [DM]' : ''}
                        </label>`;
                });
                let ownerOptions = '';
                allProfiles.forEach(p => {
                    const isCurrent = currentOwnerIds.includes(p.id);
                    ownerOptions += `<option value="${p.id}" ${isCurrent && currentOwnerIds[0] === p.id ? 'selected' : ''}>${p.username || 'Commander'}${isCurrent ? ' (current owner)' : ''}</option>`;
                });
                ownershipContainer.innerHTML = `
                <div style="background:#030403; padding:8px; border:1px solid #ff6b6b; border-radius:2px; margin-top:10px;">
                    <label style="font-size: 9px; color: #ff6b6b;">⚔ CREW OWNERSHIP (DM only) — check everyone who controls this vessel:</label>
                    <div style="margin-top:4px;">${ownerCheckboxesHtml}</div>
                    <label for="vessel-ownership-select-${vessel.id}" style="font-size: 9px; color: #ff6b6b; display:block; margin-top:10px; padding-top:8px; border-top:1px solid #3c4e36;">⚔ BOARDING CAPTURE — Transfer Sole Ownership (replaces ALL current owners with one):</label>
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <select id="vessel-ownership-select-${vessel.id}" style="flex:1; margin:0; border-color:#ff6b6b;">${ownerOptions}</select>
                        <button class="layer-del" onclick="window.reassignVesselOwnership('${vessel.id}')" style="flex:0 0 auto; font-size:10px; margin:0;">TRANSFER</button>
                    </div>
                </div>`;
            } else {
                ownershipContainer.innerHTML = '';
            }
        }

        // Battlefield Salvage: Manufacturing-deck post-processing config. Same fields
        // and convention as fleet_groups production (null output / zero rate = not
        // configured), scoped to this ship. DM or the vessel's owner only.
        const salvageContainer = document.getElementById('vessel-salvage-container');
        if (salvageContainer) {
            if (currentUserRole === 'dm' || window.vesselHasOwner(vessel, currentUserId)) {
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

        // Manufacturing Bay: build orders from this vessel's own cargo. A
        // Manufacturing-type deck is required (no deck, no builds). DM or the
        // vessel's owner only. See js/manufacturing.js.
        const mfgContainer = document.getElementById('vessel-manufacturing-container');
        if (mfgContainer) {
            if (currentUserRole === 'dm' || window.vesselHasOwner(vessel, currentUserId)) {
                const mfgDeck = (vessel.ship_decks || []).find(d => d.type === 'manufacturing');
                if (!mfgDeck) {
                    mfgContainer.innerHTML = `<div style="background:#030403; padding:8px; border:1px solid #3c4e36; border-radius:2px; margin-top:10px;">
                        <p style="font-size:9px; color:#6b826a; margin:0;">🏭 No Manufacturing-type deck installed — this vessel cannot run build orders.</p>
                    </div>`;
                } else {
                    const myProf = (typeof allProfiles !== 'undefined') ? allProfiles.find(p => p.id === currentUserId) : null;
                    const discountPct = (myProf && typeof window.getManufacturingDiscountPct === 'function') ? window.getManufacturingDiscountPct(myProf.perks) : 0;
                    // Approved blueprints only (pending proposals aren't buildable). Excludes
                    // colony_infrastructure blueprints: vessels have no Infrastructure Level
                    // (startVesselManufacturingOrder also rejects them).
                    const blueprints = (typeof manufacturingBlueprintsList !== 'undefined') ? manufacturingBlueprintsList.filter(b => b.status !== 'draft' && b.output_type !== 'colony_infrastructure') : [];
                    const inProgress = (window.globalManufacturingOrdersCache || []).filter(o => o.source_type === 'vessel' && o.vessel_id === vessel.id);
                    let progressHtml = '';
                    inProgress.forEach(o => {
                        const remaining = Math.max(0, (o.started_at_hours || 0) + (o.duration_hours || 0) - (window.universeTimeHours || 0));
                        // Box is already gated to DM/vessel owner, so anyone seeing it may cancel
                        // (same window.cancelManufacturingOrder as the Manufacturing tab).
                        progressHtml += `<div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;"><p style="margin:0; font-size:8px; color:#6b826a;">"${o.blueprint_name}" — ${typeof window.manufacturingOrderStatus === 'function' ? window.manufacturingOrderStatus(o).replace(/^\S+ /, '') : `ready in ~${remaining.toFixed(1)}h`}</p><button class="layer-del" onclick="window.cancelManufacturingOrder('${o.id}')" style="flex:0 0 auto; padding:1px 5px; font-size:8px; margin-left:6px;" title="Cancel this build and refund any deducted resources">✕</button></div>`;
                    });
                    // Production lines: one per Manufacturing deck.
                    if (typeof window.manufacturingLineUsage === 'function') { const u = window.manufacturingLineUsage('vessel', vessel.id); progressHtml = `<p style="margin:2px 0 0 0; font-size:8px; color:#8fa7b0;">Production lines: ${u.busy}/${u.lines} busy${u.queued ? ` · ${u.queued} queued` : ''} (one per Manufacturing deck)</p>` + progressHtml; }
                    // Deck-damage time note, same display convention as Fleet Group Production
                    // in js/colonies.js. Floored at 10% efficiency to match the scaling
                    // window.startVesselManufacturingOrder applies.
                    const deckScale = mfgDeck.max_hp > 0 ? Math.max(0.1, mfgDeck.hp / mfgDeck.max_hp) : 1;
                    const deckNote = deckScale < 1 ? ` — <span style="color:#ff9b6b;">Manufacturing deck at ${Math.round(deckScale * 100)}% (builds take ${(1 / deckScale).toFixed(1)}x longer)</span>` : '';
                    // Opens a modal listing every buildable blueprint with cost/time/tier and a
                    // live check against this vessel's cargo and decks (openVesselBuildModal /
                    // computeManufacturingPreview in js/manufacturing.js).
                    mfgContainer.innerHTML = `
                    <div style="background:#030403; padding:8px; border:1px solid #c9962f; border-radius:2px; margin-top:10px;">
                        <label style="font-size: 9px; color: #c9962f;">🏭 Manufacturing Bay (Manufacturing deck installed)${discountPct ? ` — ${discountPct}% perk discount applies` : ''}${deckNote}:</label>
                        <div style="margin-top:4px;">
                            ${blueprints.length
                                ? `<button class="btn-deploy" onclick="window.openVesselBuildModal('${vessel.id}')" style="width:100%; font-size:9px; padding:5px 8px; margin:0;">🔍 SELECT BLUEPRINT TO BUILD</button>`
                                : `<p style="margin:0; font-size:9px; color:#6b826a;">No approved blueprints buildable from a vessel yet.</p>`}
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
        // Shared with the Battle Map cards (renderShipWeaponsHtml); the Vessel Deck
        // uses unprefixed ids and shows the manage buttons. This re-renders on every
        // realtime ship update, so preserveFormState (js/db.js) keeps in-progress
        // target/volley picks.
        window.preserveFormState(weaponsContainer, () => {
            weaponsContainer.innerHTML = window.renderShipWeaponsHtml(vessel, { idPrefix: '', showManageButtons: true });
        }, 'select[id^="wpn-target-"], input[id^="wpn-volley-"]');
    }

    const embarkedContainer = document.getElementById('vessel-embarked-container');
    const deployedContainer = document.getElementById('vessel-deployed-container');

    if (embarkedContainer) {
        let eHtml = '';
        const hangar = vessel.ship_hangar || [];
        if (hangar.length === 0) eHtml = '<span style="font-size:10px; color:#6b826a;">No squadrons currently embarked.</span>';
        else {
            hangar.forEach((sq, idx) => {
                let dbStats = window.getStrikeCraftStats(sq.type); // guarded lookup: a deleted chassis must not crash the Vessel Deck
                eHtml += `
                <div class="note-card" style="padding:6px; margin-bottom:4px; background:#030403; border-color:#00e1ff; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <strong style="color:#00e1ff; font-size:11px;">${sq.name}</strong>
                        <div style="font-size:9px; color:#6b826a;">${dbStats.label} | Units: ${window.squadronCountLabel(sq)} | HP: ${sq.hp} / ${sq.max_hp}</div>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <!-- Overworld-visibility fix (live-session feature request,
                             2026-09-13): this button used to launch with
                             hideFromOverworld=false while the Battle Map's own
                             compact hangar launch (js/squadrons.js) already passed
                             true -- the inconsistency, not a missing feature, was
                             why strike craft launched from here still showed up on
                             the galaxy map. Now matches that button unconditionally
                             (DM-confirmed: always hide, not just during a battle). -->
                        <button class="layer-edit" onclick="window.launchSquadron('${vessel.id}', ${idx}, true)" style="padding:4px 10px; font-size:9px; border-color:#00e1ff; color:#00e1ff;">🚀 LAUNCH WING</button>
                        <button class="layer-del" onclick="window.deleteSquadron('${vessel.id}', ${idx}, false)" style="padding:4px 8px; font-size:9px;">✕</button>
                    </div>
                </div>`;
            });
        }
        embarkedContainer.innerHTML = eHtml;
    }

    if (deployedContainer) {
        let dHtml = '';
        const deployed = vessel.ship_deployed || [];
        if (deployed.length === 0) dHtml = '<span style="font-size:10px; color:#6b826a;">No active flights in sector.</span>';
        else {
            deployed.forEach((sq, idx) => {
                let dbStats = window.getStrikeCraftStats(sq.type); // see hangar loop above
                let wpnOptions = '';
                dbStats.weapons.forEach((w, wIdx) => { wpnOptions += `<option value="${wIdx}">${w.weapon_class === 'ordnance' ? '☠ ' : ''}${w.name} (${w.dice})${w.range ? ` [📏${w.range}]` : ''}${w.cooldown_period ? ` [⏱${w.cooldown_period}]` : ''}</option>`; });

                // Range is measured from the squadron's own battle-map token (sqShipSelf),
                // not the carrier's. The weapon and target selects are siblings, so the
                // target list is scoped to the currently selected weapon (index 0 on first
                // render) and window.updateSquadronTargetOptions re-scopes it on change.
                const sqShipSelfForRange = globalShipMarkersCache.find(m => m.squadron_id === sq.id && m.is_strike_craft);
                const firstWpn = dbStats.weapons[0];
                const initialScoped = (sqShipSelfForRange && typeof window.getBattleScopedTargets === 'function') ? window.getBattleScopedTargets(sqShipSelfForRange.id, firstWpn ? firstWpn.range : 0, { firerVessel: sqShipSelfForRange, wpn: firstWpn }) : null;
                // Same no-battle fallback filter for hidden vessels as renderShipWeaponsHtml.
                const initialCandidates = initialScoped || globalShipMarkersCache.filter(m => m.id !== vessel.id && (typeof window.isVesselVisibleToMe !== 'function' || window.isVesselVisibleToMe(m)));
                let targetOptions = '<option value="">-- Target --</option>';
                initialCandidates.forEach(m => { targetOptions += `<option value="${m.id}">${m.is_strike_craft ? '🛩️ ' : ''}${m.name}</option>`; });

                // An AI stance takes over this squadron's fire entirely: the manual
                // weapon/target/FIRE row is replaced by a status readout, so a squadron
                // can't fire twice in one round (manual + automated on Advance Round).
                // 'auto' is the launch default; an explicit 'manual' persists across
                // recall/relaunch.
                const aiStance = (sq.ai_stance === 'manual') ? '' : (sq.ai_stance || '');
                const AI_STANCE_LABELS = {
                    '': 'Manual (player-controlled)',
                    'auto': '🤖 Auto (AI picks stance)',
                    'attack_strike_craft': '🤖 Attack Strike Craft',
                    'intercept_munitions': '🤖 Intercept Munitions',
                    'attack_capitals': '🤖 Attack Capital Ships',
                    'attack_escorts': '🤖 Attack Escorts'
                };
                const stanceOptions = Object.keys(AI_STANCE_LABELS).map(k => `<option value="${k || 'manual'}" ${aiStance === k ? 'selected' : ''}>${AI_STANCE_LABELS[k]}</option>`).join('');
                const autoNow = aiStance === 'auto' && sq.ai_auto_pick ? ` — currently ${(AI_STANCE_LABELS[sq.ai_auto_pick] || sq.ai_auto_pick).replace('🤖 ', '')}` : '';
                const manualControlsOrStatus = aiStance
                    ? `<div style="margin-top:8px; padding-top:6px; border-top:1px dashed #3c4e36; font-size:9px; color:#6b826a;">
                           🤖 AI-controlled (${(AI_STANCE_LABELS[aiStance] || aiStance).replace('🤖 ', '')}${autoNow}) — picks its own target (nearest eligible) and weapon, resolves automatically on Advance Round. Manual fire is disabled while a stance is set — switch back to Manual above to fire it yourself.
                       </div>`
                    : (() => {
                        // One FIRE/LAUNCH control for whichever weapon is selected. Both buttons are
                        // rendered; window.updateSquadronTargetOptions (the weapon select's onchange)
                        // toggles which is visible, so no re-render is needed.
                        const isOrdnanceInit = firstWpn && firstWpn.weapon_class === 'ordnance';
                        // Remaining cooldown of the selected weapon for THIS squadron
                        // (sq.weapon_cooldowns, not the catalog). Kept live by
                        // window.updateSquadronTargetOptions.
                        const initCd = (sq.weapon_cooldowns && sq.weapon_cooldowns[0]) || 0;
                        return `<div style="margin-top:8px; padding-top:6px; border-top:1px dashed #3c4e36; display:flex; gap:6px; align-items:center;">
                           <label for="sq-wpn-select-${vessel.id}-${idx}" style="display:none;">Weapon</label>
                           <select id="sq-wpn-select-${vessel.id}-${idx}" onchange="window.updateSquadronTargetOptions('${vessel.id}', ${idx})" style="flex:2; height:22px; font-size:9px; margin:0; padding:2px; background:#0a1410; color:#ffaa00; border:1px solid #3c4e36;">${wpnOptions}</select>
                           <span id="sq-cooldown-badge-${vessel.id}-${idx}" style="font-size:8px; color:#ff9d4d; white-space:nowrap;${initCd > 0 ? '' : ' display:none;'}">CD:${initCd}</span>
                           <label for="sq-target-${vessel.id}-${idx}" style="display:none;">Target</label>
                           <select id="sq-target-${vessel.id}-${idx}" style="flex:1.5; height:22px; font-size:9px; margin:0; padding:2px; background:#0a1410; color:#00e5a3; border:1px solid #3c4e36;">${targetOptions}</select>
                           <button class="layer-edit" id="sq-fire-btn-${vessel.id}-${idx}" onclick="window.rollSquadronWeapon('${vessel.id}', ${idx})" style="flex:1; padding:4px; font-size:9px; border-color:#ffaa00; color:#ffaa00; margin:0;${isOrdnanceInit ? ' display:none;' : ''}">FIRE</button>
                           <button class="layer-edit" id="sq-launch-btn-${vessel.id}-${idx}" onclick="window.launchSquadronOrdnanceFromUI('${vessel.id}', ${idx})" style="flex:1; padding:4px; font-size:9px; border-color:#c778dd; color:#c778dd; margin:0;${isOrdnanceInit ? '' : ' display:none;'}" title="Launches a multi-turn payload if this squadron is a token in an active battle; resolves instantly otherwise">☠ LAUNCH</button>
                       </div>`;
                    })();

                dHtml += `
                <div class="note-card" style="padding:8px; margin-bottom:6px; background:#030403; border-color:#ffaa00;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <strong style="color:#ffaa00; font-size:12px;">🛫 ${sq.name}</strong>
                            <div style="font-size:9px; color:#d4c5a9;">${dbStats.label} | Units: ${window.squadronCountLabel(sq)} | HP: ${sq.hp} / ${sq.max_hp}</div>
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

                    <div style="margin-top:8px; padding-top:6px; border-top:1px dashed #3c4e36; display:flex; align-items:center; gap:6px;">
                        <label for="sq-ai-stance-${vessel.id}-${idx}" style="font-size:9px; color:#c778dd; white-space:nowrap;">AI STANCE:</label>
                        <select id="sq-ai-stance-${vessel.id}-${idx}" onchange="window.setSquadronAIStance('${vessel.id}', ${idx}, this.value)" style="flex:1; height:22px; font-size:9px; margin:0; padding:2px; background:#0a1410; color:#c778dd; border:1px solid #3c4e36;">${stanceOptions}</select>
                    </div>
                    ${manualControlsOrStatus}
                </div>`;
            });
        }
        window.preserveFormState(deployedContainer, () => { deployedContainer.innerHTML = dHtml; }, 'select[id^="sq-wpn-select-"], select[id^="sq-target-"]'); // keep squadron weapon/target picks across realtime re-renders
    }

    // Keep the Battle Map ship-status cards in sync: every mutating function in
    // this file calls renderVesselDeck, so hooking here covers them all.
    // No-op if the Battle Map isn't open or there's no active encounter.
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};

window.modifyShipHealth = async function(vesselId, key, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let dbKey = 'integrity_' + key;
    let maxKey = 'max_' + key;
    let current = vessel[dbKey] !== undefined ? vessel[dbKey] : 100;
    // Not `|| 100`: max_hardened is legitimately 0 for most ships.
    let max = vessel[maxKey] !== undefined ? vessel[maxKey] : 100;

    // ECONOMY: Hull repair consumes Titanium Hull Plates (1 per 10 Hull, rounded
    // up). The amount is clamped to max before pricing, so you only pay for what
    // is actually restored.
    if (key === 'hull' && delta > 0) {
        let actualDelta = Math.max(0, Math.min(delta, max - current));
        if (actualDelta > 0) {
            let cargo = vessel.cargo_inventory || window.sanitizeCargo({});
            let expendables = cargo.expendables || [];
            let platesIdx = expendables.findIndex(i => (i.name || '').toLowerCase().includes('hull plate'));
            let cost = Math.ceil(actualDelta / 10);

            if (platesIdx >= 0 && expendables[platesIdx].qty >= cost) {
                expendables[platesIdx].qty -= cost;
                cargo.expendables = expendables;
                await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
                vessel.cargo_inventory = cargo;

                db.from('chat_logs').insert({
                    sender_id: currentUserId,
                    content: `🔧 [REPAIR LOG] ${vessel.name} consumed ${cost}x Hull Plate(s) to restore ${actualDelta} Hull Integrity.`,
                    message_type: 'text'
                });
                if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
            } else {
                if (window.AudioEngine) window.AudioEngine.playError();
                alert(`Cannot repair hull! Requires at least ${cost} Titanium Armor Hull Plate(s) in Expendables cargo.`);
                return;
            }
        }
        // actualDelta <= 0 means the ship is already at/above max hull --
        // no plates consumed, fall through to the no-op clamp below.
    }

    current = Math.max(0, Math.min(max, current + delta));
    let payload = {}; payload[dbKey] = current;

    await db.from('ship_markers').update(payload).eq('id', vesselId);
    vessel[dbKey] = current;
    window.renderVesselDeck();
};


// Squadron commission/launch/recall/deploy functions live in js/squadrons.js.


window.modifyShipWeaponStat = async function(vesselId, idx, statKey, delta) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel || !vessel.ship_weapons || !vessel.ship_weapons[idx]) return;
    let wpn = vessel.ship_weapons[idx];
    
    if (statKey === 'ammo' && wpn.ammo >= 0) wpn.ammo = Math.max(0, Math.min(wpn.max_ammo, wpn.ammo + delta));
    // Legacy weapons may lack cooldown/overheat; `|| 0` prevents NaN being
    // written to the DB.
    if (statKey === 'cooldown') wpn.cooldown = Math.max(0, (wpn.cooldown || 0) + delta);
    if (statKey === 'overheat') wpn.overheat = Math.max(0, Math.min(10, (wpn.overheat || 0) + delta));
    // Manual override for the Standby reserve. Only meaningful once a weapon
    // has opted in via max_standby_ammo.
    if (statKey === 'standby') wpn.standby_ammo = Math.max(0, Math.min(wpn.max_standby_ammo || 0, (wpn.standby_ammo || 0) + delta));

    const { error } = await db.from('ship_markers').update({ ship_weapons: vessel.ship_weapons }).eq('id', vesselId);
    if (error) console.error("Weapon stat sync failed:", error);
    window.renderVesselDeck();
};

/* Tiered ammo: Ready (ammo/max_ammo) -> Standby (per-weapon spare mag) ->
   Deep Reserves (ship cargo, not per-weapon).
     - RESUPPLY (this function): Standby <- Deep Reserves. Instant, not
       round-gated. Transfers 1:1 from the cargo expendable named by
       wpn.ammo_type (default "Kinetic Rounds"), capped at max_standby_ammo.
       The 1:1 ratio is a placeholder, DM-tunable.
     - RELOAD (window.reloadShipWeaponReady, below): Ready <- Standby. Costs a
       round by setting wpn.cooldown.
   Neither applies to infinite-ammo weapons (wpn.ammo < 0) or weapons without
   Standby (max_standby_ammo <= 0). The UI hides both buttons then; this is
   the backstop. */
window.resupplyShipWeaponStandby = async function(vesselId, idx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel || !vessel.ship_weapons || !vessel.ship_weapons[idx]) return;
    let wpn = vessel.ship_weapons[idx];
    if (!(wpn.max_standby_ammo > 0) || wpn.ammo < 0) return;

    let deficit = wpn.max_standby_ammo - (wpn.standby_ammo || 0);
    if (deficit <= 0) { alert(`${wpn.name}'s Standby reserve is already full.`); return; }

    const ammoType = wpn.ammo_type || 'Kinetic Rounds';
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    let bucketName = null, itemRef = null;
    for (const bucket of ['expendables', 'perishables', 'misc']) {
        const found = (cargo[bucket] || []).find(i => i.name.toLowerCase() === ammoType.toLowerCase());
        if (found) { bucketName = bucket; itemRef = found; break; }
    }
    if (!itemRef || itemRef.qty <= 0) {
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[NO SUPPLY] No "${ammoType}" in cargo to resupply ${wpn.name}'s Standby reserve.`);
        return;
    }

    let transferQty = Math.min(deficit, itemRef.qty);
    itemRef.qty -= transferQty;
    if (itemRef.qty <= 0) cargo[bucketName] = cargo[bucketName].filter(i => i !== itemRef);
    wpn.standby_ammo = (wpn.standby_ammo || 0) + transferQty;

    const { error } = await db.from('ship_markers').update({ cargo_inventory: cargo, ship_weapons: vessel.ship_weapons }).eq('id', vessel.id);
    if (error) { console.error('resupplyShipWeaponStandby: save failed', error); return; }
    vessel.cargo_inventory = cargo;

    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `🔧 [RESUPPLY] ${vessel.name} transfers ${transferQty}x ${ammoType} from Deep Reserves to ${wpn.name}'s Standby magazine (${wpn.standby_ammo}/${wpn.max_standby_ammo}).`,
        message_type: 'text'
    });
    if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
    window.renderVesselDeck();
};

window.reloadShipWeaponReady = async function(vesselId, idx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel || !vessel.ship_weapons || !vessel.ship_weapons[idx]) return;
    let wpn = vessel.ship_weapons[idx];
    if (!(wpn.max_standby_ammo > 0) || wpn.ammo < 0) return;

    if ((wpn.standby_ammo || 0) <= 0) {
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[NO RESERVE] ${wpn.name}'s Standby magazine is empty — RESUPPLY from cargo first.`);
        return;
    }
    let deficit = wpn.max_ammo - wpn.ammo;
    if (deficit <= 0) { alert(`${wpn.name} is already fully loaded.`); return; }

    if (wpn.cooldown > 0) {
        if (!(await window.showConfirmModal(`[WARNING] ${wpn.name} is already on cooldown! Reloading now will OVERRIDE and restart its timer. Proceed?`))) return;
    }

    let transferQty = Math.min(deficit, wpn.standby_ammo);
    wpn.ammo += transferQty;
    wpn.standby_ammo -= transferQty;
    // Replaces rather than stacks, like firing's cooldown_period auto-set.
    wpn.cooldown = wpn.reload_cooldown_period > 0 ? wpn.reload_cooldown_period : 1;

    const { error } = await db.from('ship_markers').update({ ship_weapons: vessel.ship_weapons }).eq('id', vessel.id);
    if (error) { console.error('reloadShipWeaponReady: save failed', error); return; }

    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `🔄 [RELOAD] ${vessel.name} reloads ${wpn.name} from Standby (+${transferQty} — now ${wpn.ammo}/${wpn.max_ammo}). Cooldown: ${wpn.cooldown} round(s).`,
        message_type: 'text'
    });
    window.renderVesselDeck();
};

window.resetShipStats = async function(vesselId) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    if (!(await window.showConfirmModal("Restore maximum health profiles and resupply all ammunition banks for this vessel?"))) return;
    
    // `!== undefined`, not `|| default`: a genuine 0 max must reset to 0.
    let payload = {
        integrity_shields: vessel.max_shields !== undefined ? vessel.max_shields : 400,
        integrity_hull: vessel.max_hull !== undefined ? vessel.max_hull : 300,
        integrity_reactive: vessel.max_reactive !== undefined ? vessel.max_reactive : 10,
        integrity_ablative: vessel.max_ablative !== undefined ? vessel.max_ablative : 10,
        integrity_hardened: vessel.max_hardened || 0,
        ...(typeof window.fullArmorSidesPayload === 'function' ? window.fullArmorSidesPayload(vessel) : {}) // every armor side back to max
    };
    Object.assign(vessel, payload);
    
    if (vessel.ship_weapons) {
        vessel.ship_weapons.forEach(w => {
            if(w.ammo >= 0) w.ammo = w.max_ammo;
            w.cooldown = 0;
            w.overheat = 0;
            // Also refills Standby. Deep Reserves (ship cargo) are not touched, just as
            // Hull Plate cargo isn't.
            if (w.max_standby_ammo > 0) w.standby_ammo = w.max_standby_ammo;
        });
        payload.ship_weapons = vessel.ship_weapons;
    }
    
    await db.from('ship_markers').update(payload).eq('id', vesselId);
    window.renderVesselDeck();
    if (typeof window.showToast === 'function') window.showToast("Vessel combat stats reset to maximums.");
    else alert("Vessel combat stats reset to maximums.");
};

/* --- EDIT VESSEL BASE STATS ---
   Sets a deployed ship's MAX stats (the +/- buttons only change current
   values, clamped to max), e.g. to give a ship Hardened Armor capacity. */
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
            <div><label for="maxstats-crew" style="font-size:9px; color:#c9962f;" title="People aboard -- they eat this many crew-days of food a day. Blank = the default crew.">Crew aboard (blank = default)</label><input type="number" id="maxstats-crew" min="0" style="border-color:#c9962f; text-align:center;"></div>
            <div>
                <label for="maxstats-vesselclass" style="font-size:9px; color:#c9962f;" title="Used by squadron AI Stances (Attack Capital Ships / Attack Escorts) to tell targets apart -- otherwise cosmetic.">Vessel Classification</label>
                <select id="maxstats-vesselclass" style="border-color:#c9962f;">
                    <option value="">-- Unclassified --</option>
                    <option value="Capital">Capital Ship</option>
                    <option value="Escort">Escort</option>
                </select>
            </div>
            ${window.renderMediaPickerHtml('maxstats', '', 'Ship image (optional) — upload or paste a link')}
            <div id="maxstats-dm-wrap" style="display:none; margin-top:6px; padding-top:8px; border-top:1px dashed #3c4e36;">
                <label for="maxstats-iff" style="font-size:9px; color:#ff6b6b;" title="IFF (Identify Friend/Foe) -- controls whether players can see/edit this vessel in their own Vessel Deck. Friendly is visible alongside a player's own ships; Neutral/Hostile/unset stay DM-only. DM-only field.">IFF Designation (DM only)</label>
                <select id="maxstats-iff" style="border-color:#ff6b6b;">
                    <option value="">-- Unset (DM-only) --</option>
                    <option value="hostile">⚠ Hostile</option>
                    <option value="neutral">◌ Neutral</option>
                    <option value="friendly">✓ Friendly</option>
                </select>
                <label for="maxstats-hidden" style="font-size:10px; color:#c778dd; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:8px;" title="Fog of War: removes this vessel entirely from every non-DM surface (Battle Map grid/cards, weapon target dropdowns, Vessel Deck selector) for everyone except the DM and this vessel's own player-owner. Auto-reveals the instant it fires a weapon.">
                    <input type="checkbox" id="maxstats-hidden" style="margin:0;"> 🫥 Hidden (Fog of War) — DM only
                </label>
                <label for="maxstats-ai-controlled" style="font-size:10px; color:#ff6b6b; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:8px;" title="DM-AI-for-NPCs: when ON, this deployed vessel fights on its own during Advance Round -- attacks the closest enemy in range, closes distance if needed, and re-prioritizes onto whoever hit it hardest this round. DM-only field.">
                    <input type="checkbox" id="maxstats-ai-controlled" style="margin:0;"> 🤖 AI Controlled — DM only
                </label>
                <label for="maxstats-galaxy-visible" style="font-size:10px; color:#00e1ff; display:flex; align-items:center; gap:4px; cursor:pointer; margin-top:8px;" title="Ships deployed from the Battle Map (and encounter presets / hangar-launched strike craft) are Battle-Map-only. Tick this to put the ship on the galaxy map too -- e.g. a captured NPC you want to keep. It appears at its last galaxy position. DM-only field.">
                    <input type="checkbox" id="maxstats-galaxy-visible" style="margin:0;"> 🌌 Show on galaxy map — DM only
                </label>
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
                max_hardened: parseInt(document.getElementById('maxstats-hardened').value) || 0,
                vessel_class: document.getElementById('maxstats-vesselclass').value || null,
                crew: (v => v === '' ? null : Math.max(0, parseInt(v, 10) || 0))(document.getElementById('maxstats-crew').value.trim()), // balance pass 2026-10-03: food
                // Read regardless of DM-only visibility: openEditMaxStatsModal pre-fills
                // these from the vessel, so a non-DM save writes them back unchanged.
                iff: document.getElementById('maxstats-iff').value || null,
                is_hidden: document.getElementById('maxstats-hidden').checked,
                ai_controlled: document.getElementById('maxstats-ai-controlled').checked,
                // Same read-back-unchanged rule as the fields above.
                hide_from_galaxy_map: !document.getElementById('maxstats-galaxy-visible').checked,
                image_url: window.getMediaPickerValue('maxstats')
            };
            const clamped = {
                integrity_shields: Math.min(vessel.integrity_shields !== undefined ? vessel.integrity_shields : newMax.max_shields, newMax.max_shields),
                integrity_hull: Math.min(vessel.integrity_hull !== undefined ? vessel.integrity_hull : newMax.max_hull, newMax.max_hull),
                integrity_reactive: Math.min(vessel.integrity_reactive !== undefined ? vessel.integrity_reactive : newMax.max_reactive, newMax.max_reactive),
                integrity_ablative: Math.min(vessel.integrity_ablative !== undefined ? vessel.integrity_ablative : newMax.max_ablative, newMax.max_ablative),
                integrity_hardened: Math.min(vessel.integrity_hardened !== undefined ? vessel.integrity_hardened : newMax.max_hardened, newMax.max_hardened)
            };
            // Directional armor: per-side max from the four side inputs (undefined when
            // the switch is off -> sides untouched).
            const sideMax = typeof window.readArmorSideInputs === 'function' ? window.readArmorSideInputs('maxstats') : undefined;
            // Per-ship 3D model override (DM only; undefined = untouched).
            if (typeof window.readModelPicker === 'function') Object.assign(newMax, window.readModelPicker('maxstats') || {});
            if (sideMax) {
                const before = window.getArmorSides(vessel);
                const cur = {};
                window.ARMOR_SIDES.forEach(k => {
                    // current is clamped to the new max, same as every stat on this sheet
                    cur[k] = Math.max(0, Math.min(sideMax[k], before.cur[k]));
                });
                newMax.max_hardened = window.sumArmorSides(sideMax);
                newMax.max_armor_sides = sideMax;
                clamped.armor_sides = cur;
                clamped.integrity_hardened = window.sumArmorSides(cur);
            }
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
        if (typeof window.ensureArmorSideInputs === 'function') { const usesSides = window.vesselUsesArmorSides(vessel); window.ensureArmorSideInputs('maxstats-hardened', 'maxstats', usesSides ? window.getArmorSides(vessel).max : null, usesSides); }
        document.getElementById('maxstats-vesselclass').value = vessel.vessel_class || '';
        document.getElementById('maxstats-crew').value = (vessel.crew === null || vessel.crew === undefined) ? '' : vessel.crew;
        document.getElementById('maxstats-iff').value = vessel.iff || '';
        document.getElementById('maxstats-hidden').checked = !!vessel.is_hidden;
        document.getElementById('maxstats-ai-controlled').checked = !!vessel.ai_controlled;
        document.getElementById('maxstats-galaxy-visible').checked = !vessel.hide_from_galaxy_map;
        window.setMediaPickerValue('maxstats', vessel.image_url || '');
        if (typeof window.ensureModelPicker === 'function') window.ensureModelPicker('maxstats', vessel);
        const dmWrap = document.getElementById('maxstats-dm-wrap');
        if (dmWrap) dmWrap.style.display = (currentUserRole === 'dm') ? 'block' : 'none';
        overlay.style.display = 'flex';
    };
})();


// Squadron target-scoping/AI-stance/weapon-fire/ordnance functions live in js/squadrons.js.


/* System Lockdown: opt-in per-weapon effect (`wpn.system_lockdown =
   {checkDC: N}`, e.g. the Jupiter-class Spinal EMP Cannon in js/map.js),
   triggered whenever that weapon damages a target (no to-hit roll exists
   for direct-fire ship weapons). DM rules:
   - Strike craft and Escort-class targets are PERMANENTLY disabled, no check.
   - Other targets roll a flat d20 vs checkDC (no stat bonus). On a fail, one
     of Weapons/Sensors/Engines is disabled at random for 1d4 rounds.
   Stored as disabled_{weapons,sensors,engines}_until (rounds remaining);
   PERMANENT_DISABLE_ROUNDS is never decremented by advanceCombatRound.
   Weapons blocks firing (ship and squadron paths); Sensors removes the
   vessel from automated PD/intercept pools (js/battle-map.js); Engines zeroes
   move_remaining on the next movement reset. */
window.PERMANENT_DISABLE_ROUNDS = 9999;
// DM rule: an armed ship or design with no Capital/Escort tag gets an amber
// UNCLASSIFIED badge (DM only), because the squadron 'Attack Capital Ships' /
// 'Attack Escorts' stances never pick untagged ships. Strike craft and
// unarmed hulls (fleet markers) are exempt.
window.unclassifiedBadgeHtml = function(v) {
    if (!v || v.vessel_class || v.is_strike_craft || currentUserRole !== 'dm') return '';
    if (!(v.ship_weapons || []).length) return '';
    return '<span style="font-size:8px; color:#ffaa00; border:1px dashed #ffaa00; border-radius:2px; padding:1px 5px; margin-left:6px;" title="No Capital/Escort tag: squadron stances that pick Capital Ships or Escorts will ignore this ship. Set it in EDIT BASE STATS or the design editor.">⚠ UNCLASSIFIED</span>';
};
/* DM rule: every ship and strike craft weapon roll (direct fire, ordnance
   impact, PD and squadron intercepts) gets a HIDDEN flat bonus of
   damage_bonus_pct % of the dice average (1d10 avg 5.5 -> +5 at 100%).
   Computed from the dice string at roll time; stacks with the visible
   modifier; never shown in breakdowns. Not applied to personal (character)
   weapons or Healing. Tuned in app_settings 'combat_balance_config'
   {damage_bonus_pct} (DM Tools -> MAINT -> Feature Switches); missing row = 100. */
window.combatBalanceConfig = function() {
    try {
        const row = window.appSettingsCache && window.appSettingsCache.combat_balance_config;
        const v = row && row.value ? JSON.parse(row.value) : {};
        const pct = Number(v.damage_bonus_pct);
        return { damage_bonus_pct: Number.isFinite(pct) && pct >= 0 ? pct : 100 };
    } catch (e) { return { damage_bonus_pct: 100 }; }
};
window.hiddenDamageBonus = function(numDice, faces) {
    const n = parseInt(numDice, 10) || 0, f = parseInt(faces, 10) || 0;
    if (n <= 0 || f <= 0) return 0;
    return Math.floor(n * (f + 1) / 2 * window.combatBalanceConfig().damage_bonus_pct / 100);
};
/* Stance damage multipliers, the one place they live. who = 'firer' (damage
   dealt; ship direct fire and manual damage only) or 'target' (damage taken;
   every attack). DM rule: Healing is never scaled by stance. Returns the new
   total and a log tag ('' when nothing applied). */
window.STANCE_DAMAGE_MULT = { Aggressive: 1.25, Defensive: 0.75, Evasive: 0.5 };
window.applyStanceToDamage = function(total, stance, dmgType, who) {
    const mult = window.STANCE_DAMAGE_MULT[stance];
    if (!mult || dmgType === 'Healing') return { total, tag: '' };
    const pct = Math.round((mult - 1) * 100);
    const sign = pct > 0 ? '+' : '';
    const tag = who === 'target' ? `[Target ${stance}: ${sign}${pct}% Dmg] ` : `[${stance}: ${sign}${pct}%]`;
    return { total: Math.floor(total * mult), tag };
};
// Engines knocked out (System Lockdown): the unit can't move this round, AI included.
window.enginesDisabled = function(vessel) { return !!vessel && (vessel.disabled_engines_until || 0) > 0; };
window.hiddenDamageBonusForDice = function(diceStr) {
    const m = String(diceStr || '').trim().match(/^(\d*)d(\d+)$/i);
    return m ? window.hiddenDamageBonus(parseInt(m[1], 10) || 1, m[2]) : 0;
};
async function applySystemLockdown(targetShip, wpn) {
    if (!wpn.system_lockdown || !targetShip) return '';
    const PERM = window.PERMANENT_DISABLE_ROUNDS;
    let log = '';
    if (targetShip.is_strike_craft || targetShip.vessel_class === 'Escort') {
        targetShip.disabled_weapons_until = PERM;
        targetShip.disabled_sensors_until = PERM;
        targetShip.disabled_engines_until = PERM;
        log = ` [SYSTEM LOCKDOWN] ${targetShip.name} is PERMANENTLY DISABLED (${targetShip.is_strike_craft ? 'strike craft' : 'Escort-class'}, no check).`;
    } else {
        const dc = wpn.system_lockdown.checkDC || 16;
        const checkRoll = Math.floor(Math.random() * 20) + 1;
        if (checkRoll < dc) {
            const systems = ['disabled_weapons_until', 'disabled_sensors_until', 'disabled_engines_until'];
            const pickedField = systems[Math.floor(Math.random() * systems.length)];
            const duration = Math.floor(Math.random() * 4) + 1; // 1d4 rounds
            targetShip[pickedField] = Math.max(targetShip[pickedField] || 0, duration);
            const label = pickedField === 'disabled_weapons_until' ? 'WEAPONS' : (pickedField === 'disabled_sensors_until' ? 'SENSORS' : 'ENGINES');
            log = ` [SYSTEM LOCKDOWN] ${targetShip.name} fails a DC${dc} check (rolled ${checkRoll}) — ${label} disabled for ${duration} round(s)!`;
        } else {
            log = ` [SYSTEM LOCKDOWN] ${targetShip.name} resists (rolled ${checkRoll} vs DC${dc}).`;
        }
    }
    try {
        await db.from('ship_markers').update({
            disabled_weapons_until: targetShip.disabled_weapons_until || 0,
            disabled_sensors_until: targetShip.disabled_sensors_until || 0,
            disabled_engines_until: targetShip.disabled_engines_until || 0
        }).eq('id', targetShip.id);
    } catch (err) { console.error('applySystemLockdown: failed to persist disabled state', err); }
    return log;
}

// Thin DOM-reading wrapper for the manual FIRE button; the logic is in
// window.resolveShipWeaponFire (same split as the squadron fire functions).
window.rollShipWeapon = async function(vesselId, idx, idPrefix) {
    idPrefix = idPrefix || '';
    let volleyInput = document.getElementById(`${idPrefix}wpn-volley-${vesselId}-${idx}`);
    let volleys = volleyInput ? (parseInt(volleyInput.value) || 1) : 1;
    let targetSelect = document.getElementById(`${idPrefix}wpn-target-${vesselId}-${idx}`);
    let targetId = targetSelect ? targetSelect.value : null;
    return window.resolveShipWeaponFire(vesselId, idx, targetId, volleys, {});
};

/* DOM-independent core of rollShipWeapon, also called by the AI ship
   auto-fire loop (processBattleRoundAutomations, js/battle-map.js) with an
   explicit targetId/volleys. opts.auto skips every alert()/confirm() gate
   and silently doesn't fire instead (e.g. weapon on cooldown), same as
   resolveSquadronWeaponFire. */
window.resolveShipWeaponFire = async function(vesselId, idx, targetId, volleys, opts) {
    opts = opts || {};
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let wpn = (vessel.ship_weapons || [])[idx];
    if (!wpn) return;

    // A manual shot spends 1 AP from the firer's own turn slot; AI fire
    // (opts.auto) is exempt, since AI ships fire as one batch at the round
    // boundary. window.spendTokenAp fails open when no initiative is rolled.
    // The spend happens after all refusal gates (see "AP spend" below), so a
    // refused or cancelled shot costs nothing. Dice format is validated up front
    // so a bad dice string can't burn ammo or alert() mid-Advance-Round.
    const diceRegex = /^(\d*)d(\d+)$/i;
    const match = (wpn.dice || '').trim().match(diceRegex);
    if (!match) { if (!opts.auto) alert(`Invalid dice format on ${wpn.name} ("${wpn.dice || ''}") -- edit the weapon to fix it.`); return; }

    // Weapons-disabled gate, checked on the FIRER: a disabled vessel can't shoot.
    if (vessel.disabled_weapons_until > 0) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[WEAPONS DISABLED] ${vessel.name}'s weapons are offline for ${vessel.disabled_weapons_until} more round(s).`);
        return;
    }

    // A weapon tied to a deck can't fire once that deck's HP hits 0. The badge
    // and disabled button are visual only (a stale render can bypass them); this
    // is the authoritative check. Fails open if the assigned deck no longer exists.
    if (wpn.assigned_deck_id) {
        const assignedDeck = (vessel.ship_decks || []).find(d => d.id === wpn.assigned_deck_id);
        if (assignedDeck && assignedDeck.hp <= 0) {
            if (opts.auto) return;
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`[DECK DESTROYED] ${wpn.name} is mounted on the ${assignedDeck.name} deck, which has been destroyed and can no longer fire.`);
            return;
        }
    }

    volleys = volleys || 1;
    let gunCount = wpn.gun_count || 1;
    if (volleys > gunCount) {
        if (opts.auto) { volleys = gunCount; } // AI always requests 1 anyway; clamp rather than refuse if ever called otherwise
        else {
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`[MOUNT LIMIT] ${wpn.name} has ${gunCount} gun(s) installed — cannot fire a volley of ${volleys}.`);
            return;
        }
    }

    if (wpn.ammo === 0) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[EMPTY] ${wpn.name} is out of ammunition!`);
        return;
    }
    if (wpn.ammo > 0 && wpn.ammo < volleys) {
        if (opts.auto) { volleys = wpn.ammo; }
        else {
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`[INSUFFICIENT AMMO] ${wpn.name} only has ${wpn.ammo} uses left!`);
            return;
        }
    }

    // Firing arcs: authoritative check (the dropdown greys out-of-arc targets,
    // but a stale render could still submit one).
    if (targetId && typeof window.isTargetInArc === 'function' && !window.isTargetInArc(vesselId, targetId, wpn)) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        const tgt = globalShipMarkersCache.find(m => m.id === targetId);
        alert(`[OUT OF ARC] ${tgt ? tgt.name : 'That target'} is outside ${wpn.name}'s firing arc — turn the ship first.`);
        return;
    }
    // Terrain rules (js/terrain-rules.js): planet/station in the line of fire,
    // or the target hidden in a nebula past lock range.
    const terrainBlock = (targetId && typeof window.terrainFireCheck === 'function') ? window.terrainFireCheck(vesselId, targetId) : '';
    if (terrainBlock) {
        if (opts.auto) return;
        if (window.AudioEngine) window.AudioEngine.playError();
        const tgt = globalShipMarkersCache.find(m => m.id === targetId);
        alert(`[NO SHOT] ${tgt ? tgt.name : 'That target'}: ${terrainBlock}.`);
        return;
    }

    let overridingCooldown = false;
    if (wpn.cooldown > 0) {
        if (opts.auto) return; // hard-skip: no one to confirm an override mid-tick (same as squadron AI fire)
        if (!(await window.showConfirmModal(`[WARNING] ${wpn.name} is on cooldown! Firing will OVERRIDE and generate OVERHEAT. Proceed?`))) return;
        overridingCooldown = true;
    }

    // AP spend: every refusal gate has passed and any override is confirmed.
    if (!opts.auto && typeof window.spendTokenAp === 'function' && !window.spendTokenAp(vesselId, 1)) return;

    if (overridingCooldown) wpn.overheat = Math.min(10, (wpn.overheat || 0) + 1);
    if (wpn.ammo > 0) wpn.ammo -= volleys;

    // Shot is committed: start this weapon's reload clock. cooldown_period
    // undefined/0 is a no-op. Replaces the current cooldown rather than adding to
    // it, even on an overridden shot fired while already cooling down.
    if (wpn.cooldown_period > 0) wpn.cooldown = wpn.cooldown_period;

    // Self-damage on consecutive fire (opt-in, e.g. Spinal EMP Cannon via
    // `self_damage_on_consecutive_fire`): only marks "fired this round" here;
    // detection and damage happen in window.advanceCombatRound.
    if (wpn.self_damage_on_consecutive_fire) wpn.fired_this_round = true;

    // First point where the shot is committed, so reveal here. Best-effort: a
    // failure must never lose the shot.
    try { if (typeof window.revealVesselIfHidden === 'function') await window.revealVesselIfHidden(vessel); } catch (err) { console.error('rollShipWeapon: reveal-on-fire failed', err); }

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
    // Hidden calibration bonus on top of the visible modifier. DM decision: not
    // shown in the breakdown.
    if (window.normalizeDamageType(wpn.damage_type || window.inferLegacyDamageType(wpn.name)) !== 'Healing') total +=window.hiddenDamageBonus(numDice, diceFaces);

    let dmgType = window.normalizeDamageType(wpn.damage_type || window.inferLegacyDamageType(wpn.name));
    // Firer stance (DM rule: Evasive halves damage dealt as well as taken).
    const firerSt = window.applyStanceToDamage(total, vessel.ship_stance || 'Balanced', dmgType, 'firer');
    total = firerSt.total;
    if (firerSt.tag) breakdown.push(firerSt.tag);

    if (modVal !== 0) breakdown.push(`[Mod: ${modVal >= 0 ? '+' : ''}${modVal}]`);
    const breakdownText = breakdown.join(' + ');

    let targetShip = null;
    let combatLog = ``;

    if (targetId) {
        targetShip = globalShipMarkersCache.find(m => m.id === targetId);
        if (targetShip) {
            const tSt = window.applyStanceToDamage(total, targetShip.ship_stance || 'Balanced', dmgType, 'target');
            total = tSt.total; combatLog += tSt.tag;
            // Asteroid cover (direct fire only).
            const cover = (dmgType !== 'Healing' && typeof window.terrainCover === 'function') ? window.terrainCover(targetId) : null;
            if (cover) { total = Math.floor(total * cover.mult); combatLog += cover.label; }

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

            const result = window.resolveShipDamage(targetShip, dmgType, total, typeof window.damageSideOpts === 'function' ? window.damageSideOpts(targetShip, { vesselId }) : undefined);
            combatLog += result.log;
            const sideFields = typeof window.armorSideResultFields === 'function' ? window.armorSideResultFields(result) : {};

            // Threat tracking: the biggest single hit this round and who dealt it (not a
            // cumulative total), stored on the TARGET's row. Every damage path writes
            // these fields (also resolveSquadronWeaponFire and the ordnance impact loop in
            // processBattleRoundAutomations) so the AI ship loop can read them next Advance
            // Round, whichever client fired.
            const newRoundBiggestHit = total > (targetShip.round_biggest_hit_amount || 0);
            const roundBiggestHitAmount = newRoundBiggestHit ? total : (targetShip.round_biggest_hit_amount || 0);
            const roundBiggestHitBy = newRoundBiggestHit ? vesselId : (targetShip.round_biggest_hit_by || null);

            await db.from('ship_markers').update({
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened, ...sideFields,
                round_biggest_hit_amount: roundBiggestHitAmount, round_biggest_hit_by: roundBiggestHitBy
            }).eq('id', targetShip.id);
            Object.assign(targetShip, {
                integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
                integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
                integrity_hardened: result.integrity_hardened, ...sideFields,
                round_biggest_hit_amount: roundBiggestHitAmount, round_biggest_hit_by: roundBiggestHitBy
            });
            await syncSquadronHpToParent(targetShip);

            // Tactical Battle Map: if this target is a token in the active
            // battle and just hit 0 hull, auto-withdraw its token (does not
            // touch this ship_markers row itself). No-op outside a battle.
            if (typeof window.checkBattleTokenDestroyed === 'function') await window.checkBattleTokenDestroyed(targetShip);

            // System Lockdown (opt-in per weapon; no-op when wpn.system_lockdown is
            // undefined). Runs even if this hit destroyed the target; harmless.
            combatLog += await applySystemLockdown(targetShip, wpn);

            // Brief beam flash on the Battle Map between firer and target, colored by
            // damage type. playWeaponFireEffect no-ops if the Battle Map isn't open or
            // either vessel isn't a battle token. Local only: not synced to other viewers
            // (unlike the in-flight ordnance animation).
            if (typeof window.playWeaponFireEffect === 'function') {
                const beamColor = (window.DAMAGE_TYPES[dmgType] && window.DAMAGE_TYPES[dmgType].color) || '#ff3333';
                window.playWeaponFireEffect(vesselId, targetShip.id, beamColor, dmgType);
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
        const autoTag = opts.auto ? '🤖 [AI CONTROLLED] ' : '';
        await window.broadcastRoll(`${autoTag}[${vessel.name}] FIRES [${wpn.loc || 'Mount'}]${volleyTag}${targetString}`, breakdownString, total);
    }
};

/* Weapons can be tied to a deck (assigned_deck_id on the ship_weapons entry);
   a destroyed deck (HP 0) disables its weapons. This needs a STABLE id per
   deck, since array index changes when moveShipDeckOrder reorders entries.
   genDeckId/ensureDeckIds add an id to legacy decks the first time they are
   touched (render here or ship-designer.js's loadout modal) and persist it. */
// Debris damage (js/terrain-rules.js): straight to hull, with the same
// persist + strike-craft sync + destroyed check as a weapon hit. Called inside
// the move's undo step, so UNDO restores the hull along with the move.
window.applyTerrainHullDamage = async function(vessel, amount) {
    if (!vessel || !(amount > 0)) return;
    const hull = Math.max(0, (vessel.integrity_hull || 0) - amount);
    await db.from('ship_markers').update({ integrity_hull: hull }).eq('id', vessel.id);
    vessel.integrity_hull = hull;
    try { await syncSquadronHpToParent(vessel); } catch (e) { console.warn('debris: squadron sync failed', e); }
    if (typeof window.checkBattleTokenDestroyed === 'function') await window.checkBattleTokenDestroyed(vessel);
};
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

// Edit a deck's type in place: mutate, persist, update cache, re-render.
// Leaves hp/max_hp/boarding_status/id alone, so weapon assigned_deck_id links
// survive a retype.
window.updateShipDeckType = async function(vesselId, idx, newType) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    let decks = vessel.ship_decks || [];
    if (!decks[idx]) return;
    decks[idx].type = newType || 'other';
    await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vesselId);
    vessel.ship_decks = decks;
    window.renderVesselDeck();
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
    const currentOwnerIds = window.vesselOwnerIds(vessel);
    if (currentOwnerIds.length === 1 && currentOwnerIds[0] === newOwnerId) return;

    const newOwnerName = allProfiles.find(p => p.id === newOwnerId)?.username || 'Commander';

    // TRANSFER is a full wipe-and-replace: the owner list becomes exactly
    // [newOwnerId] (completed boarding capture). Use the checkbox list
    // (window.toggleVesselOwner) to add/remove individual owners.
    if (!(await window.showConfirmModal(`Transfer sole ownership of "${vessel.name}" to ${newOwnerName}? This replaces ALL current owners and represents a completed boarding capture.`))) return;

    await db.from('ship_markers').update({ owner_ids: [newOwnerId] }).eq('id', vesselId);
    vessel.owner_ids = [newOwnerId];

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

// Adds/removes ONE co-owner without disturbing the others (counterpart to
// reassignVesselOwnership's wipe-and-replace).
window.toggleVesselOwner = async function(vesselId, profileId, checked) {
    if (currentUserRole !== 'dm') return;
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    const current = window.vesselOwnerIds(vessel);
    const next = checked
        ? (current.includes(profileId) ? current : [...current, profileId])
        : current.filter(id => id !== profileId);

    const { error } = await db.from('ship_markers').update({ owner_ids: next }).eq('id', vesselId);
    if (error) { alert("Failed to update ownership: " + error.message); return; }
    vessel.owner_ids = next;
    if (typeof window.showToast === 'function') window.showToast(`${vessel.name}'s ownership updated.`);
    window.renderVesselDeck();
};

/* Inject Ammo / Gun Count / Damage Type fields into the "Mount New Weapon
   System" form (they are not in index.html). Anchored off the exploding-dice
   checkbox, which always exists. */

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
    'Cold':      { color: '#66d9ff', blockedBy: [], bypassesLayers: [], hullMult: 1, shieldMode: 'normal',
        desc: 'Cryogenic disruptors that embrittle plating rather than melting it outright.', shreds: 'Exposed Hull once armor is stripped — brittle-fracture bonus', mitigatedBy: 'Nothing specific; weak vs intact armor' },
    'Corrosive': { color: '#7cbf3f', blockedBy: ['reactive', 'ablative'], bypassesLayers: ['hardened'], hullMult: 1, shieldMode: 'normal',
        desc: 'Acidic or nanite-based agents that eat through even hardened plating.', shreds: 'Hardened Armor specifically — ignores it entirely', mitigatedBy: 'Reactive Armor, Ablative Armor' },
    'Healing':   { color: '#00e5a3', blockedBy: [], bypassesLayers: [], hullMult: 1, shieldMode: 'normal',
        desc: 'Repair-drone swarms, nanite weaves, or damage-control beams — restores rather than harms.', shreds: 'Nothing — restores Shields first, then Hull', mitigatedBy: 'N/A' }
};

/* --- DAMAGE TYPE -> VISUAL EFFECT FAMILY ---
   Groups the 12 damage types into 4 battle-map fire effects: Beam
   (Energy/Ion/Exotic/Antimatter/Heat), Tracer (Impact/Piercing/Cold), Burst
   (Explosive/Flak/Corrosive), Pulse (Healing). Heat's placement in Beam is a
   judgment call ("thermal lances"), not part of the approved grouping; easy
   to move. Used by window.playWeaponFireEffect (js/battle-map.js). */
window.DAMAGE_TYPE_FAMILY = {
    'Energy': 'beam', 'Ion': 'beam', 'Exotic': 'beam', 'Antimatter': 'beam', 'Heat': 'beam',
    'Impact': 'tracer', 'Piercing': 'tracer', 'Cold': 'tracer',
    'Explosive': 'burst', 'Flak': 'burst', 'Corrosive': 'burst',
    'Healing': 'pulse'
};

window.buildDamageTypeOptionsHtml = function(selected) {
    return Object.keys(window.DAMAGE_TYPES).map(k => `<option value="${k}" ${k === selected ? 'selected' : ''}>${k}</option>`).join('');
};

/* --- WEAPON CLASSIFICATION ---
   weapon_class: 'direct_fire' (default/legacy, resolves the same turn) or
   'ordnance' (missiles/torpedoes: multi-turn flight that Point Defense can
   counter-fire). is_point_defense flags a weapon (PDC/PDL/PDG-style) as a
   counter-fire system. Missing weapon_class falls back to 'direct_fire'. */
window.WEAPON_CLASS_LABELS = { direct_fire: 'Direct Fire', ordnance: 'Ordnance' };

// Native title tooltips (reliable, no extra markup) built from the shared table.
window.getDamageTypeTooltip = function(dmgType, context) {
    const info = window.DAMAGE_TYPES[dmgType];
    if (!info) {
        console.warn(`getDamageTypeTooltip: no entry for damage type "${dmgType}" — falling back to generic text instead of a blank tooltip.`);
        return `${dmgType || 'Unknown'}\nNo tactical data on file for this damage type.`;
    }
    if (context === 'arsenal') {
        // Personal Arsenal weapons don't use the ship armor cascade, so the tooltip
        // stays flavor-only (no "shreds/mitigated by" breakdown).
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

/* Legacy weapons may lack damage_type: guess it from keywords in the name, and
   map the old combined "Impact/Ion" label. New/edited weapons always use the
   explicit field. */
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
   Each damage type's behaviour is data-driven from DAMAGE_TYPES; this is the
   single place it executes, so NPC and player ships resolve identically. */
// opts.side: 'front'|'starboard'|'rear'|'port'. When directional_armor is on
// and the target isn't a strike craft, only that side's Hardened pool is used,
// and the result also carries armor_sides (+ integrity_hardened = their sum).
// Callers get opts from window.damageSideOpts (js/directional-armor.js).
window.resolveShipDamage = function(targetShip, dmgType, totalDamage, opts) {
    let s = targetShip.integrity_shields !== undefined ? targetShip.integrity_shields : 400;
    let r = targetShip.integrity_reactive !== undefined ? targetShip.integrity_reactive : 10;
    let a = targetShip.integrity_ablative !== undefined ? targetShip.integrity_ablative : 10;
    const sideInfo = (opts && opts.side && typeof window.armorSidesFor === 'function') ? window.armorSidesFor(targetShip, opts.side) : null;
    let hd = sideInfo ? sideInfo.value : (targetShip.integrity_hardened !== undefined ? targetShip.integrity_hardened : 0);
    const hdLabel = sideInfo ? `${sideInfo.label} Armor` : 'Hardened Armor';
    let h = targetShip.integrity_hull !== undefined ? targetShip.integrity_hull : 300;
    let log = '';
    const info = window.DAMAGE_TYPES[dmgType] || window.DAMAGE_TYPES['Impact'];
    // Builds the return value; with a side, hd is that side's pool.
    const finish = () => {
        if (!sideInfo) return { integrity_shields: s, integrity_reactive: r, integrity_ablative: a, integrity_hardened: hd, integrity_hull: h, log };
        const sides = Object.assign({}, sideInfo.cur, { [sideInfo.side]: hd });
        return { integrity_shields: s, integrity_reactive: r, integrity_ablative: a, integrity_hardened: window.sumArmorSides(sides), armor_sides: sides, hit_side: sideInfo.side, integrity_hull: h, log };
    };

    if (dmgType === 'Healing') {
        // `!== undefined`, not `|| default`: Healing must respect a genuine 0 max.
        let sMax = targetShip.max_shields !== undefined ? targetShip.max_shields : 400; let hMax = targetShip.max_hull !== undefined ? targetShip.max_hull : 300;
        let toShields = Math.min(totalDamage, Math.max(0, sMax - s)); s += toShields;
        let toHull = Math.min(totalDamage - toShields, Math.max(0, hMax - h)); h += toHull;
        log += `Repair systems restored ${toShields} Shields`; if (toHull > 0) log += ` and ${toHull} Hull`; log += `. `;
        return finish();
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
        // No hull reduction here: DAMAGE_TYPES.Ion.hullMult (0.25) is applied once at
        // the Hull step (doing it here too would give 1/16).
        remainingDmg = Math.max(0, remainingDmg - Math.ceil(ionShieldDmg / 2));
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
                if (hd > 0) log += `[${dmgType.toUpperCase()}] bypasses ${hdLabel} entirely! `;
            } else if (hd > 0) {
                let hdAbsorb = Math.min(hd, remainingDmg);
                hd -= hdAbsorb; remainingDmg -= hdAbsorb;
                if (hdAbsorb > 0) log += `${hdLabel} absorbed ${hdAbsorb}. `;
            }

            if (remainingDmg > 0) {
                if (sideInfo && hd <= 0 && !bypassesHardened) log += `[${hdLabel.toUpperCase()} BREACHED] `;
                let hullMult = info.hullMult;
                if (dmgType === 'Cold' && hd <= 0) hullMult = 1.25; // brittle-fracture bonus once armor's stripped
                let hullDmg = Math.min(h, Math.ceil(remainingDmg * hullMult));
                h -= hullDmg; remainingDmg -= hullDmg;
                log += `Hull suffered ${hullDmg} damage! `;
                if (h <= 0) log += `**CRITICAL HULL BREACH!** `;
            }
        }
    }

    return finish();
};

/* --- MANUAL DAMAGE APPLICATION (DM Tools -> MANUAL DMG subtab) ---
   Lets the DM push a physically rolled damage total through the normal
   shield/armor/hull cascade. DM rules:
   1. Stance/category multipliers (attacker and target stance, strike-craft /
      Flak effectiveness) still apply on top of the typed total; only the dice
      roll is manual.
   2. Selecting a weapon makes it a REAL shot: consumes ammo, starts cooldown,
      respects weapons-disabled/deck-destroyed gates, triggers special effects
      (System Lockdown, beam flash). "-- Unlisted / no specific weapon --"
      skips all of that and just applies the cascade.
   Limitation: the FIRER must be a regular ship/station with a ship_weapons
   array; strike craft are excluded (their weapons live in STRIKE_CRAFT_DB
   and would need a squadron-instance path like resolveSquadronWeaponFire).
   Any ship or strike craft in the active battle can be the TARGET.
   Reuses rollShipWeapon's gates, effects and multiplier math. */

window.renderManualDamagePanel = function() {
    const firerSel = document.getElementById('dm-manualdmg-firer');
    const targetSel = document.getElementById('dm-manualdmg-target');
    const dmgTypeSel = document.getElementById('dm-manualdmg-dmgtype');
    if (!firerSel || !targetSel) return;

    if (dmgTypeSel && dmgTypeSel.options.length === 0) dmgTypeSel.innerHTML = window.buildDamageTypeOptionsHtml('Impact');

    const tokens = (window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || [];
    const prevFirer = firerSel.value;
    const prevTarget = targetSel.value;

    const firerCandidates = tokens
        .map(t => globalShipMarkersCache.find(m => m.id === t.ship_marker_id))
        .filter(m => m && !m.is_strike_craft);
    const targetCandidates = tokens
        .map(t => globalShipMarkersCache.find(m => m.id === t.ship_marker_id))
        .filter(Boolean);

    firerSel.innerHTML = '<option value="">-- Select firing ship --</option>' +
        firerCandidates.map(m => `<option value="${m.id}">${m.name}${(m.ship_weapons || []).length === 0 ? ' (no weapons installed)' : ''}</option>`).join('');
    targetSel.innerHTML = '<option value="">-- Select target ship --</option>' +
        targetCandidates.map(m => `<option value="${m.id}">${m.is_strike_craft ? '🛩 ' : ''}${m.name}</option>`).join('');

    if (prevFirer && firerCandidates.some(m => m.id === prevFirer)) firerSel.value = prevFirer;
    if (prevTarget && targetCandidates.some(m => m.id === prevTarget)) targetSel.value = prevTarget;

    window.populateManualDamageWeapons();
};

window.populateManualDamageWeapons = function() {
    const firerSel = document.getElementById('dm-manualdmg-firer');
    const wpnSel = document.getElementById('dm-manualdmg-weapon');
    if (!firerSel || !wpnSel) return;
    const vessel = globalShipMarkersCache.find(m => m.id === firerSel.value);
    const weapons = (vessel && vessel.ship_weapons) || [];
    wpnSel.innerHTML = '<option value="">-- Unlisted / no specific weapon --</option>' +
        weapons.map((w, idx) => `<option value="${idx}">${w.name} (${w.dice}${w.ammo === 0 ? ' — EMPTY' : ''}${w.cooldown > 0 ? ' — ON COOLDOWN' : ''})</option>`).join('');
    window.onManualDamageWeaponChange();
};

// Pre-fills Damage Type from the selected weapon; always left editable for
// combo weapons (e.g. "Impact/Heat") or overrides.
window.onManualDamageWeaponChange = function() {
    const firerSel = document.getElementById('dm-manualdmg-firer');
    const wpnSel = document.getElementById('dm-manualdmg-weapon');
    const dmgTypeSel = document.getElementById('dm-manualdmg-dmgtype');
    if (!wpnSel || !dmgTypeSel) return;
    const vessel = globalShipMarkersCache.find(m => m.id === firerSel.value);
    const wpn = (vessel && wpnSel.value !== '') ? (vessel.ship_weapons || [])[parseInt(wpnSel.value)] : null;
    const dmgType = wpn ? window.normalizeDamageType(wpn.damage_type || window.inferLegacyDamageType(wpn.name)) : 'Impact';
    if (dmgTypeSel.querySelector(`option[value="${dmgType}"]`)) dmgTypeSel.value = dmgType;
};

window.applyManualDamage = async function() {
    if (currentUserRole !== 'dm') return;

    const firerId = document.getElementById('dm-manualdmg-firer').value;
    const targetId = document.getElementById('dm-manualdmg-target').value;
    const wpnIdxRaw = document.getElementById('dm-manualdmg-weapon').value;
    const dmgType = document.getElementById('dm-manualdmg-dmgtype').value || 'Impact';
    const totalInput = document.getElementById('dm-manualdmg-total').value;

    if (!firerId || !targetId) { alert("Select both a firing ship and a target."); return; }
    if (firerId === targetId) { alert("A ship can't fire on itself."); return; }

    let total = parseInt(totalInput);
    if (isNaN(total) || total < 0) { alert("Enter a valid, non-negative damage total."); return; }

    let vessel = globalShipMarkersCache.find(m => m.id === firerId);
    let targetShip = globalShipMarkersCache.find(m => m.id === targetId);
    if (!vessel || !targetShip) { alert("Firing ship or target could not be found -- try re-opening this panel."); return; }

    // A manual-damage shot spends 1 AP from the firer's turn slot like a normal
    // FIRE (fails open with no initiative). The spend happens after the refusal
    // gates and cooldown confirm.
    const wpnIdx = wpnIdxRaw !== '' ? parseInt(wpnIdxRaw) : null;
    let wpn = (wpnIdx !== null) ? (vessel.ship_weapons || [])[wpnIdx] : null;

    // Same gates as window.rollShipWeapon, minus the dice roll.
    if (vessel.disabled_weapons_until > 0) {
        if (window.AudioEngine) window.AudioEngine.playError();
        alert(`[WEAPONS DISABLED] ${vessel.name}'s weapons are offline for ${vessel.disabled_weapons_until} more round(s).`);
        return;
    }
    if (wpn && wpn.assigned_deck_id) {
        const assignedDeck = (vessel.ship_decks || []).find(d => d.id === wpn.assigned_deck_id);
        if (assignedDeck && assignedDeck.hp <= 0) {
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`[DECK DESTROYED] ${wpn.name} is mounted on the ${assignedDeck.name} deck, which has been destroyed and can no longer fire.`);
            return;
        }
    }
    if (wpn) {
        if (wpn.ammo === 0) {
            if (window.AudioEngine) window.AudioEngine.playError();
            alert(`[EMPTY] ${wpn.name} is out of ammunition!`);
            return;
        }
        let overridingCooldown = false;
        if (wpn.cooldown > 0) {
            if (!(await window.showConfirmModal(`[WARNING] ${wpn.name} is on cooldown! Applying this shot will OVERRIDE and generate OVERHEAT. Proceed?`))) return;
            overridingCooldown = true;
        }
        if (typeof window.spendTokenAp === 'function' && !window.spendTokenAp(firerId, 1)) return;
        if (overridingCooldown) wpn.overheat = Math.min(10, (wpn.overheat || 0) + 1);
        if (wpn.ammo > 0) wpn.ammo -= 1;
        if (wpn.cooldown_period > 0) wpn.cooldown = wpn.cooldown_period;
        if (wpn.self_damage_on_consecutive_fire) wpn.fired_this_round = true;
    } else if (typeof window.spendTokenAp === 'function' && !window.spendTokenAp(firerId, 1)) {
        return; // unlisted weapon: no weapon gates, spend the AP here
    }

    try { if (typeof window.revealVesselIfHidden === 'function') await window.revealVesselIfHidden(vessel); } catch (err) { console.error('applyManualDamage: reveal-on-fire failed', err); }

    let combatLog = '';

    // Stance/category multipliers on top of the manual total; same math as rollShipWeapon.
    total = window.applyStanceToDamage(total, vessel.ship_stance || 'Balanced', dmgType, 'firer').total;
    const tSt = window.applyStanceToDamage(total, targetShip.ship_stance || 'Balanced', dmgType, 'target');
    total = tSt.total; combatLog += tSt.tag;

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

    // Directional armor: side from the DM's picker (Auto = facing the firing ship).
    const manualSideOpts = (typeof window.damageSideOpts === 'function' && typeof window.manualDamageSideSource === 'function') ? window.damageSideOpts(targetShip, window.manualDamageSideSource(vessel.id)) : undefined;
    const result = window.resolveShipDamage(targetShip, dmgType, total, manualSideOpts);
    combatLog += result.log;
    const sideFields = typeof window.armorSideResultFields === 'function' ? window.armorSideResultFields(result) : {};

    await db.from('ship_markers').update({
        integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
        integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
        integrity_hardened: result.integrity_hardened, ...sideFields
    }).eq('id', targetShip.id);
    Object.assign(targetShip, {
        integrity_shields: result.integrity_shields, integrity_hull: result.integrity_hull,
        integrity_reactive: result.integrity_reactive, integrity_ablative: result.integrity_ablative,
        integrity_hardened: result.integrity_hardened, ...sideFields
    });
    if (typeof syncSquadronHpToParent === 'function') await syncSquadronHpToParent(targetShip);
    if (typeof window.checkBattleTokenDestroyed === 'function') await window.checkBattleTokenDestroyed(targetShip);
    if (wpn && typeof applySystemLockdown === 'function') combatLog += await applySystemLockdown(targetShip, wpn);

    if (typeof window.playWeaponFireEffect === 'function') {
        const beamColor = (window.DAMAGE_TYPES[dmgType] && window.DAMAGE_TYPES[dmgType].color) || '#ff9d4d';
        window.playWeaponFireEffect(vessel.id, targetShip.id, beamColor, dmgType);
    }

    if (wpn) await db.from('ship_markers').update({ ship_weapons: vessel.ship_weapons }).eq('id', vessel.id);

    window.renderVesselDeck();
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    window.renderManualDamagePanel();
    document.getElementById('dm-manualdmg-total').value = '';

    if (window.AudioEngine) window.AudioEngine.playShoot();

    if (typeof window.broadcastRoll === 'function') {
        const breakdownString = `
            <div style="margin-top:4px; padding:4px; border-left:2px solid #ff9d4d; background:rgba(255,157,77,0.1);">
                <strong>Damage Type:</strong> ${dmgType}<br>
                <strong>Manual Roll Total:</strong> <strong style="color:#ff3333;">${total} Dmg</strong> (adjusted for stance/target-category)<br>
                <strong>Target Report:</strong> ${combatLog}
            </div>
        `;
        await window.broadcastRoll(`🎲 [MANUAL DICE] ${vessel.name} FIRES ${wpn ? wpn.name : 'an unlisted weapon'} at ${targetShip.name}`, breakdownString, total);
    }
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
    // 0 = unlimited (no Battle Map targeting restriction); the default for new
    // and legacy weapons.
    let weaponRange = rangeInput ? Math.max(0, parseInt(rangeInput.value) || 0) : 0;
    // 0/blank = no auto-cooldown (opt-in per weapon, like range 0 = unlimited).
    let cooldownInput = document.getElementById('new-ship-wpn-cooldown');
    let weaponCooldownPeriod = cooldownInput ? Math.max(0, parseInt(cooldownInput.value) || 0) : 0;
    let deckSelect = document.getElementById('new-ship-wpn-deck');
    let assignedDeckId = (deckSelect && deckSelect.value) ? deckSelect.value : null;

    // Standby: opt-in per-weapon spare-mag tier, independent of Ready
    // (ammo/max_ammo). 0/blank = not using tiered ammo (RESUPPLY/RELOAD hidden).
    let standbyMaxInput = document.getElementById('new-ship-wpn-standby-max');
    let standbyMax = (standbyMaxInput && parseInt(standbyMaxInput.value) > 0) ? parseInt(standbyMaxInput.value) : 0;
    let ammoTypeInput = document.getElementById('new-ship-wpn-ammotype');
    let ammoType = (ammoTypeInput && ammoTypeInput.value.trim()) ? ammoTypeInput.value.trim() : 'Kinetic Rounds';
    // RELOAD (Standby -> Ready) costs a round by setting the weapon's cooldown.
    // Default 1 round is a placeholder, DM-tunable.
    let reloadCdInput = document.getElementById('new-ship-wpn-reloadcd');
    let reloadCooldownPeriod = reloadCdInput && reloadCdInput.value.trim() !== '' ? Math.max(0, parseInt(reloadCdInput.value) || 0) : 1;
    // Only meaningful for weapon_class 'ordnance' (see window.scaleOrdnanceDice,
    // js/battle-map.js). Default 'multi' = 6-payload split.
    let ordPatternSelect = document.getElementById('new-ship-wpn-ordpattern');
    let ordnancePattern = (ordPatternSelect && ordPatternSelect.value === 'single') ? 'single' : 'multi';

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
        ammo: ammoVal, max_ammo: ammoVal, cooldown: 0, overheat: 0, cooldown_period: weaponCooldownPeriod,
        gun_count: gunCount, damage_type: damageType,
        weapon_class: weaponClass, is_point_defense: isPointDefense, range: weaponRange,
        assigned_deck_id: assignedDeckId,
        standby_ammo: 0, max_standby_ammo: standbyMax, ammo_type: ammoType,
        reload_cooldown_period: reloadCooldownPeriod, ordnance_pattern: ordnancePattern
    });
    if (typeof window.applyArcToWeapon === 'function') window.applyArcToWeapon(weapons[weapons.length - 1], window.readArcSelect('new-ship-wpn-arc'));

    await db.from('ship_markers').update({ ship_weapons: weapons }).eq('id', vessel.id);
    vessel.ship_weapons = weapons;

    document.getElementById('new-ship-wpn-loc').value = '';
    if (document.getElementById('new-ship-wpn-arc')) document.getElementById('new-ship-wpn-arc').value = '';
    document.getElementById('new-ship-wpn-name').value = '';
    document.getElementById('new-ship-wpn-dice').value = '';
    document.getElementById('new-ship-wpn-mod').value = '';
    if (ammoInput) ammoInput.value = '';
    if (gunsInput) gunsInput.value = '1';
    if (classSelect) classSelect.value = 'direct_fire';
    if (pdCheckbox) pdCheckbox.checked = false;
    if (rangeInput) rangeInput.value = '0';
    if (cooldownInput) cooldownInput.value = '0';
    if (deckSelect) deckSelect.value = '';
    if (standbyMaxInput) standbyMaxInput.value = '';
    if (ammoTypeInput) ammoTypeInput.value = '';
    if (reloadCdInput) reloadCdInput.value = '1';
    if (ordPatternSelect) ordPatternSelect.value = 'multi';
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
   Edit any field of an installed weapon in place, keeping its
   ammo/cooldown/overheat state. */
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
            <label for="wpn-edit-cooldown" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;" title="Turns this weapon needs to recharge after firing. Auto-applied to Cooldown the moment it's fired. 0 = no cooldown.">Cooldown Period (turns, 0 = none)</label>
            <input type="number" id="wpn-edit-cooldown" min="0" style="border-color:#ff3333; text-align:center;">
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
            <label style="font-size:9px; color:#ff9d4d; margin-top:10px; display:block; border-top:1px dashed #3c4e36; padding-top:6px;">Tiered Ammo — Standby Reserve (0 = not used, hides RESUPPLY/RELOAD)</label>
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="wpn-edit-standby" style="font-size:9px; color:#ffaaaa;">Standby (current)</label><input type="number" id="wpn-edit-standby" min="0" style="border-color:#ff9d4d; text-align:center;"></div>
                <div style="flex:1;"><label for="wpn-edit-standbymax" style="font-size:9px; color:#ffaaaa;">Standby Max</label><input type="number" id="wpn-edit-standbymax" min="0" style="border-color:#ff9d4d; text-align:center;"></div>
            </div>
            <label for="wpn-edit-ammotype" style="font-size:9px; color:#ffaaaa;" title="Which cargo expendable RESUPPLY draws from (Deep Reserves).">Ammo Type (Deep Reserves cargo item name)</label>
            <input type="text" id="wpn-edit-ammotype" placeholder="Kinetic Rounds" style="border-color:#ff9d4d;">
            <label for="wpn-edit-reloadcd" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;" title="RELOAD (Standby -> Ready) sets this weapon's Cooldown to this many rounds, same field firing uses.">Reload Cooldown (rounds)</label>
            <input type="number" id="wpn-edit-reloadcd" min="0" style="border-color:#ff9d4d; text-align:center;">
            <label for="wpn-edit-ordpattern" style="font-size:9px; color:#ffaaaa; margin-top:8px; display:block;" title="Only relevant for Ordnance-class weapons.">Ordnance Pattern (Ordnance weapons only)</label>
            <select id="wpn-edit-ordpattern" style="border-color:#ff9d4d;">
                <option value="multi">Multi-Hit (splits into 6 payloads, current default)</option>
                <option value="single">Single Warhead (no split, heavier per-hit damage)</option>
            </select>
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
            if (typeof window.applyArcToWeapon === 'function') window.applyArcToWeapon(wpn, window.readArcSelect('wpn-edit-arc'));
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
            wpn.cooldown_period = Math.max(0, parseInt(document.getElementById('wpn-edit-cooldown').value) || 0);
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

            // Clamp current Standby down to a lowered Standby Max (same as Edit Vessel
            // Base Stats).
            wpn.max_standby_ammo = Math.max(0, parseInt(document.getElementById('wpn-edit-standbymax').value) || 0);
            wpn.standby_ammo = Math.max(0, Math.min(wpn.max_standby_ammo, parseInt(document.getElementById('wpn-edit-standby').value) || 0));
            wpn.ammo_type = document.getElementById('wpn-edit-ammotype').value.trim() || 'Kinetic Rounds';
            wpn.reload_cooldown_period = Math.max(0, parseInt(document.getElementById('wpn-edit-reloadcd').value) || 0);
            wpn.ordnance_pattern = document.getElementById('wpn-edit-ordpattern').value === 'single' ? 'single' : 'multi';

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
        if (typeof window.ensureArcSelect === 'function') window.ensureArcSelect('wpn-edit-loc', 'wpn-edit-arc', wpn.arc);
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
        document.getElementById('wpn-edit-cooldown').value = wpn.cooldown_period || 0;
        document.getElementById('wpn-edit-standby').value = wpn.standby_ammo || 0;
        document.getElementById('wpn-edit-standbymax').value = wpn.max_standby_ammo || 0;
        document.getElementById('wpn-edit-ammotype').value = wpn.ammo_type || 'Kinetic Rounds';
        document.getElementById('wpn-edit-reloadcd').value = (wpn.reload_cooldown_period !== undefined && wpn.reload_cooldown_period !== null) ? wpn.reload_cooldown_period : 1;
        document.getElementById('wpn-edit-ordpattern').value = wpn.ordnance_pattern === 'single' ? 'single' : 'multi';

        // Deck dropdown rebuilt on every open (decks can change); self-heals missing
        // deck ids like renderVesselDeck does.
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
            if ((w.range_short !== null && w.range_short !== undefined) || (w.range_long !== null && w.range_long !== undefined)) {
                const rs = (w.range_short === null || w.range_short === undefined) ? '∞' : w.range_short;
                const rl = (w.range_long === null || w.range_long === undefined) ? '∞' : w.range_long;
                ammoLabel += `<div style="font-size:9px; color:#6b826a;" title="Deck fights: past short = -2 to hit, past long = no shot">Range: ${rs}/${rl} sq</div>`;
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

// Reuses the lazy-loaded window.diceLogsList from the Comms "Dice Streamer"
// tab, so recent rolls show here without a separate query.
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
            <div style="display:flex; gap:6px;">
                <div style="flex:1;"><label for="arsenal-edit-rshort" style="font-size:9px; color:#6b826a;" title="Deck plans only: past this many squares = -2 to hit">Short range (squares, blank=∞)</label><input type="number" id="arsenal-edit-rshort" min="0" style="border-color:#ffaa00; text-align:center;"></div>
                <div style="flex:1;"><label for="arsenal-edit-rlong" style="font-size:9px; color:#6b826a;" title="Deck plans only: past this many squares the shot is refused">Long range (squares, blank=∞)</label><input type="number" id="arsenal-edit-rlong" min="0" style="border-color:#ffaa00; text-align:center;"></div>
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
                max_ammo: maxAmmoStr === '' ? (ammoStr === '' ? null : Math.max(0, parseInt(ammoStr) || 0)) : Math.max(0, parseInt(maxAmmoStr) || 0),
                range_short: (v => v === '' ? null : Math.max(0, parseInt(v) || 0))(document.getElementById('arsenal-edit-rshort').value.trim()),
                range_long: (v => v === '' ? null : Math.max(0, parseInt(v) || 0))(document.getElementById('arsenal-edit-rlong').value.trim())
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
        document.getElementById('arsenal-edit-rshort').value = (wpn.range_short === null || wpn.range_short === undefined) ? '' : wpn.range_short;
        document.getElementById('arsenal-edit-rlong').value = (wpn.range_long === null || wpn.range_long === undefined) ? '' : wpn.range_long;
        overlay.style.display = 'flex';
    };
})();

window.rollArsenalWeapon = async function(id) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    // Looked up by stable weapon id, not array position (personal reorder can
    // shift positions; see window.applySavedOrder).
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

/* --- GROUND COMBAT TO-HIT SYSTEM (prototype) ---
   Attacker: flat d20 (does NOT explode) + chosen skill modifier +
   perk/augment/gear bonuses on that skill. wpn.modifier applies to DAMAGE
   only, not to-hit (DM decision).
   Defender: ONE core stat die, which explodes. A PC uses their own sheet
   (the resolver picks which stat each time) plus perk/augment/gear bonuses on
   that stat and any augment explode_threshold. An NPC (no sheet) uses a
   manually picked die size plus a DM-entered NPC Defense Mod. Any defender
   can also get a Situational Mod (cover, prone, etc.) from the attack popup.
   Higher total wins; on a tie the player-controlled side wins. Triggered by
   the "⚔" button next to an Arsenal weapon's ROLL; the attacker is always the
   current user's own character. A miss blocks the damage roll; ammo is
   consumed either way. */
window.DAMAGE_TYPE_TO_SKILL = {
    'Impact': 'Ballistic Weapons', 'Piercing': 'Ballistic Weapons', 'Flak': 'Ballistic Weapons',
    'Cold': 'Ballistic Weapons', 'Corrosive': 'Ballistic Weapons',
    'Energy': 'Energy Weapons', 'Ion': 'Energy Weapons', 'Heat': 'Energy Weapons',
    'Antimatter': 'Energy Weapons', 'Exotic': 'Energy Weapons',
    'Explosive': 'Explosives', 'Healing': 'Medical'
};

function rollExplodingDie(faces, canExplode, explodeThreshold) {
    // Optional explodeThreshold (defaults to faces, i.e. explode on max face).
    // Augments can lower it (e.g. a d8 exploding on 6+). Values above faces are
    // clamped to faces.
    let threshold = (explodeThreshold != null && explodeThreshold < faces) ? explodeThreshold : faces;
    // Clamp to 2+: a threshold of 1 or less (or a non-number) would explode
    // forever and freeze the tab.
    threshold = Number(threshold);
    if (!(threshold >= 2)) threshold = Math.max(2, faces);
    let roll, subRolls = [], rollTotal = 0;
    do {
        roll = Math.floor(Math.random() * faces) + 1;
        rollTotal += roll;
        subRolls.push(roll);
    } while (roll >= threshold && canExplode);
    return { rollTotal, subRolls };
}

(function() {
    let overlay, currentWeaponId;

    // Reads combat_tracker.is_npc, set explicitly by every insert site
    // (addCombatant, joinCombatInitiative, spawnSquadronToken,
    // deployTemplateToInitiative). `!== false` treats a missing value as NPC
    // (the manual-die branch), matching the column's DB default.
    function defenderIsPC(combatant) {
        return !!(combatant && combatant.is_npc === false);
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
                </select>
                <label for="atk-npc-def-mod" style="font-size:9px; color:#6b826a; margin-top:6px; display:block;">NPC Defense Mod (flat +/-)</label>
                <input type="number" id="atk-npc-def-mod" value="0" step="1" style="border-color:#ff3333;">`;
        }
    }

    function groundCombatTargets() {
        // Squadron tokens share the Initiative Tracker but are excluded here: this is
        // personal combat, and ship-to-ship combat has its own weapon-roll system.
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
            <label for="atk-situational-mod" style="font-size:9px; color:#6b826a; margin-top:6px; display:block;">Situational Defense Mod (cover, prone, etc. — any defender)</label>
            <input type="number" id="atk-situational-mod" value="0" step="1" style="border-color:#ff3333;">
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
        const sitEl = document.getElementById('atk-situational-mod'); if (sitEl) sitEl.value = 0;
        overlay.style.display = 'flex';
    };

    window.closeArsenalAttackModal = function() { if (overlay) overlay.style.display = 'none'; };
})();

window.resolveArsenalAttack = async function(weaponId) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    let wpn = (myProf.arsenal || []).find(w => w.id === weaponId);
    if (!wpn) return;

    // Validated up front (as in window.rollArsenalWeapon) so a malformed dice
    // string fails before ammo is spent or a hit is broadcast to chat.
    const diceRegex = /^(\d*)d(\d+)$/i;
    if (!wpn.dice || !wpn.dice.trim().match(diceRegex)) { alert("This weapon's dice format is invalid — edit it before attacking."); return; }

    const targetSel = document.getElementById('atk-target-select');
    const target = targetSel ? combatantsList.find(c => c.id === targetSel.value) : null;
    if (!target) { alert("Select a target first."); return; }
    // On a deck plan, the weapon's optional Short/Long range applies
    // (js/deck-plans.js): past Long = refused (nothing spent), past Short = -2 to
    // hit. Off the board, range isn't used.
    const deckRange = typeof window.deckRangeCheck === 'function' ? window.deckRangeCheck(wpn, target.id) : null;
    if (deckRange && deckRange.refuse) { alert(deckRange.refuse); return; }
    const skillName = document.getElementById('atk-skill-select').value;

    // --- Attacker roll: flat d20 (no explode) + skill mod + perk/augment/gear bonus on that skill ---
    // (DM decision: weapon modifier is damage-only, NOT added to to-hit.)
    let atkBreakdown = [];
    let atkTotal = Math.floor(Math.random() * 20) + 1;
    atkBreakdown.push(`d20: ${atkTotal}`);

    const modVal = parseInt(wpn.modifier) || 0; // used for the damage roll below only

    const safeSkillKey = skillName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const skillMod = (myProf.skills || {})[safeSkillKey] || 0;
    if (skillMod !== 0) { atkTotal += skillMod; atkBreakdown.push(`${skillName}: ${skillMod >= 0 ? '+' : ''}${skillMod}`); }
    if (deckRange && deckRange.mod) { atkTotal += deckRange.mod; atkBreakdown.push(deckRange.label); }

    const perkBonus = window.getPerkBonusFor(myProf.perks, 'skill', skillName);
    if (perkBonus.total !== 0) { atkTotal += perkBonus.total; atkBreakdown.push(`${skillName} Perks: ${perkBonus.sources.join(', ')}`); }

    const augBonus = typeof window.getAugmentBonusFor === 'function' ? window.getAugmentBonusFor(myProf.augments, 'skill', skillName) : { total: 0, sources: [] };
    if (augBonus.total !== 0) { atkTotal += augBonus.total; atkBreakdown.push(`${skillName} Augments: ${augBonus.sources.join(', ')}`); }

    const gearBonus = typeof window.getGearBonusFor === 'function' ? window.getGearBonusFor(myProf.gear, 'skill', skillName) : { total: 0, sources: [] };
    if (gearBonus.total !== 0) { atkTotal += gearBonus.total; atkBreakdown.push(`${skillName} Gear: ${gearBonus.sources.join(', ')}`); }

    // --- Defender roll: one core stat die (PC, explodes) or a manually-picked die size (NPC, also explodes) ---
    // PC/NPC comes from combat_tracker.is_npc; targetProfile is only needed for
    // the PC branch's stat block.
    const targetProfile = allProfiles.find(p => p.id === target.owner_id);
    const isPC = !!(target && target.is_npc === false);
    let defTotal = 0, defLabel = '';
    if (isPC && targetProfile && targetProfile.character) {
        const statName = document.getElementById('atk-defense-stat-select').value;
        const statKey = 'stat_' + statName.toLowerCase();
        const faces = parseInt((targetProfile.character[statKey] || 'd4').replace('d', '')) || 4;
        // Defense modifiers (DM decision): same stat bonuses as the self-service
        // dice-pool roller - perk/augment/gear on this stat, plus any augment
        // explode_threshold.
        const defThreshold = typeof window.getAugmentExplodeThreshold === 'function' ? window.getAugmentExplodeThreshold(targetProfile.augments, statName) : null;
        const { rollTotal, subRolls } = rollExplodingDie(faces, faces >= 2, defThreshold);
        defTotal = rollTotal;
        const thrNote = (defThreshold != null && defThreshold < faces) ? `, explodes ${defThreshold}+` : '';
        defLabel = `${target.name} defends with ${statName} (d${faces}${thrNote}: ${subRolls.join('💥')})`;
        const dPerk = window.getPerkBonusFor(targetProfile.perks, 'stat', statName);
        if (dPerk.total !== 0) { defTotal += dPerk.total; defLabel += ` + [Perks: ${dPerk.sources.join(', ')}]`; }
        const dAug = typeof window.getAugmentBonusFor === 'function' ? window.getAugmentBonusFor(targetProfile.augments, 'stat', statName) : { total: 0, sources: [] };
        if (dAug.total !== 0) { defTotal += dAug.total; defLabel += ` + [Augments: ${dAug.sources.join(', ')}]`; }
        const dGear = typeof window.getGearBonusFor === 'function' ? window.getGearBonusFor(targetProfile.gear, 'stat', statName) : { total: 0, sources: [] };
        if (dGear.total !== 0) { defTotal += dGear.total; defLabel += ` + [Gear: ${dGear.sources.join(', ')}]`; }
    } else {
        // A PC combatant (is_npc false) may have no character sheet yet; fall back to
        // the manual die-size path used for NPCs instead of crashing.
        const faces = parseInt((document.getElementById('atk-defense-die-select').value || 'd8').replace('d', '')) || 8;
        const { rollTotal, subRolls } = rollExplodingDie(faces, faces >= 2);
        defTotal = rollTotal;
        defLabel = `${target.name} defends (DM-picked d${faces}: ${subRolls.join('💥')})`;
        const npcModEl = document.getElementById('atk-npc-def-mod');
        const npcMod = npcModEl ? (parseInt(npcModEl.value) || 0) : 0;
        if (npcMod !== 0) { defTotal += npcMod; defLabel += ` + [NPC Mod: ${npcMod >= 0 ? '+' : ''}${npcMod}]`; }
    }
    const sitModEl = document.getElementById('atk-situational-mod');
    const sitMod = sitModEl ? (parseInt(sitModEl.value) || 0) : 0;
    if (sitMod !== 0) { defTotal += sitMod; defLabel += ` + [Situational: ${sitMod >= 0 ? '+' : ''}${sitMod}]`; }

    // --- Resolution: higher total wins. On a tie the player-controlled side
    // wins; if that's ambiguous (both or neither player-controlled), the
    // attacker wins the tie. ---
    const attackerIsPlayer = currentUserRole !== 'dm';
    const defenderIsPlayer = isPC; // isPC already requires a non-DM owner, see the comment above
    let hit;
    if (atkTotal > defTotal) hit = true;
    else if (atkTotal < defTotal) hit = false;
    else hit = !(defenderIsPlayer && !attackerIsPlayer);

    // Ammo is consumed on any fired shot, hit or miss.
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
        // wpn.dice was validated before anything else ran, so this match always succeeds.
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

// idPrefix: the "Multi-Stat & Skill Pool Roller" exists twice - in the Combat
// Arsenal tab ('') and in the Battle Map's Comms & Dice dock. Both copies use
// the same .roll-stat-cb/.roll-skill-cb classes, so every query is scoped to
// idPrefix + 'dice-roller-stats'/'dice-roller-skills' to avoid counting the
// other copy's checkboxes. #roll-extra-mod/#roll-advantage-cb get prefixed
// ids. Always rolls the current user's own character.
window.executeDicePoolRoll = async function(idPrefix) {
    idPrefix = idPrefix || '';
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    const char = myProf.character || {};
    const skills = myProf.skills || {};

    let statCheckboxes = document.querySelectorAll(`#${idPrefix}dice-roller-stats .roll-stat-cb:checked`);
    let skillCheckboxes = document.querySelectorAll(`#${idPrefix}dice-roller-skills .roll-skill-cb:checked`);
    const extraModEl = document.getElementById(`${idPrefix}roll-extra-mod`);
    let extraMod = parseInt(extraModEl && extraModEl.value) || 0;
    const advCb = document.getElementById(`${idPrefix}roll-advantage-cb`);
    const advantageOn = !!(advCb && advCb.checked);

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
        const canExplode = faces >= 2;

        // Advantage: each selected stat's die is rolled TWICE (each exploding
        // normally) and the higher total kept; both rolls appear in the breakdown.
        // Skills are flat modifiers, so they aren't re-rolled.
        // Custom explode threshold: an augment effect {target:'stat',
        // name:<StatName>, explode_threshold:N} lowers the stat die's explode point.
        // Looked up fresh each roll. Applies only to this self-service roller.
        const customThreshold = typeof window.getAugmentExplodeThreshold === 'function' ? window.getAugmentExplodeThreshold(myProf.augments, statName) : null;
        const thresholdNote = (customThreshold != null && customThreshold < faces) ? `, explodes ${customThreshold}+` : '';

        let rollTotal, diceBreakdownText;
        const rollA = rollExplodingDie(faces, canExplode, customThreshold);
        if (advantageOn) {
            const rollB = rollExplodingDie(faces, canExplode, customThreshold);
            rollTotal = Math.max(rollA.rollTotal, rollB.rollTotal);
            diceBreakdownText = `${statName} (d${faces}${thresholdNote}, ⭐ADV: [${rollA.subRolls.join('💥')}]=${rollA.rollTotal} vs [${rollB.subRolls.join('💥')}]=${rollB.rollTotal} → kept ${rollTotal})`;
        } else {
            rollTotal = rollA.rollTotal;
            diceBreakdownText = `${statName} (d${faces}${thresholdNote}: ${rollA.subRolls.join('💥')})`;
        }

        total += rollTotal;
        breakdown.push(diceBreakdownText);

        const perkBonus = window.getPerkBonusFor(myProf.perks, 'stat', statName);
        if (perkBonus.total !== 0) {
            total += perkBonus.total;
            breakdown.push(`[${statName} Perks: ${perkBonus.sources.join(', ')}]`);
        }

        const augBonus = typeof window.getAugmentBonusFor === 'function' ? window.getAugmentBonusFor(myProf.augments, 'stat', statName) : { total: 0, sources: [] };
        if (augBonus.total !== 0) {
            total += augBonus.total;
            breakdown.push(`[${statName} Augments: ${augBonus.sources.join(', ')}]`);
        }

        const gearBonus = typeof window.getGearBonusFor === 'function' ? window.getGearBonusFor(myProf.gear, 'stat', statName) : { total: 0, sources: [] };
        if (gearBonus.total !== 0) {
            total += gearBonus.total;
            breakdown.push(`[${statName} Gear: ${gearBonus.sources.join(', ')}]`);
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

        const augBonus = typeof window.getAugmentBonusFor === 'function' ? window.getAugmentBonusFor(myProf.augments, 'skill', skillName) : { total: 0, sources: [] };
        if (augBonus.total !== 0) {
            total += augBonus.total;
            breakdown.push(`[${skillName} Augments: ${augBonus.sources.join(', ')}]`);
        }

        const gearBonus = typeof window.getGearBonusFor === 'function' ? window.getGearBonusFor(myProf.gear, 'skill', skillName) : { total: 0, sources: [] };
        if (gearBonus.total !== 0) {
            total += gearBonus.total;
            breakdown.push(`[${skillName} Gear: ${gearBonus.sources.join(', ')}]`);
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
    
    document.querySelectorAll(`#${idPrefix}dice-roller-stats .roll-stat-cb`).forEach(cb => cb.checked = false);
    document.querySelectorAll(`#${idPrefix}dice-roller-skills .roll-skill-cb`).forEach(cb => cb.checked = false);
    if (extraModEl) extraModEl.value = 0;
    if (advCb) advCb.checked = false;

    if (window.AudioEngine) window.AudioEngine.playShoot();

    if(typeof window.broadcastRoll === 'function') {
        await window.broadcastRoll(`[${myProf.username || 'Commander'}] STAT/SKILL CHECK${advantageOn ? ' ⭐ADV' : ''}`, breakdownString, total);
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
    
    // is_npc set explicitly: "+ ADD TO INITIATIVE" is the DM-only NPC-add tool.
    const { error } = await db.from('combat_tracker').insert({ name, initiative, hp, owner_id: currentUserId, is_npc: true });
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

    // is_npc: false - "+ JOIN INITIATIVE" is always the player's own character.
    const { error } = await db.from('combat_tracker').insert({ name, initiative, hp, owner_id: currentUserId, is_npc: false });
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

/* DOM/confirm-free core of window.advanceCombatRound, so the per-turn engine
   (window.endCurrentTurn, js/battle-map.js) can run the same global tick when
   initiative wraps, with no confirm dialog and no DM-only gate (a player may
   end the last turn of a round). Same core/wrapper split as
   resolveShipWeaponFire vs rollShipWeapon. */
window.resolveRoundTick = async function() {
    let anyChanged = false;
    let klaxonTriggered = false;

    for (let vessel of globalShipMarkersCache) {
        let changed = false;
        let weapons = vessel.ship_weapons || [];
        let deployed = vessel.ship_deployed || [];
        let hangar = vessel.ship_hangar || [];
        let flightLog = [];
        let recalledSquadronIds = [];

        // Declared before weapons.forEach so the consecutive-fire self-damage check
        // inside the loop can set it.
        let hullChanged = false;

        weapons.forEach(w => {
            if (w.cooldown > 0) { w.cooldown -= 1; changed = true; }
            if (w.overheat > 0) { w.overheat -= 1; changed = true; }
            // Consecutive-fire self-damage: rollShipWeapon sets `fired_this_round`; this
            // round-boundary tick detects two rounds in a row and applies the damage.
            // Only weapons with `self_damage_on_consecutive_fire` (e.g. the Spinal EMP
            // Cannon) are affected.
            if (w.self_damage_on_consecutive_fire) {
                if (w.fired_this_round) {
                    if (w.fired_prev_round) {
                        const dmgSpec = w.self_damage_on_consecutive_fire;
                        const selfRoll = rollDamageDice(dmgSpec.dice || '1d4', '+0', false, true);
                        let curHull = vessel.integrity_hull !== undefined ? vessel.integrity_hull : 300;
                        vessel.integrity_hull = Math.max(0, curHull - selfRoll.total);
                        hullChanged = true;
                        flightLog.push(`⚡ ${w.name} overloads from consecutive firing — ${selfRoll.total} ${dmgSpec.damage_type || 'Heat'} dmg to own Hull.`);
                    }
                    w.fired_prev_round = true;
                } else {
                    w.fired_prev_round = false;
                }
                w.fired_this_round = false;
                changed = true;
            }
        });

        // Decrement the three per-vessel disable timers. PERMANENT_DISABLE_ROUNDS
        // (9999) is never decremented, so a permanently disabled vessel stays disabled.
        let disabledChanged = false;
        ['disabled_weapons_until', 'disabled_sensors_until', 'disabled_engines_until'].forEach(field => {
            const val = vessel[field] || 0;
            if (val > 0 && val < window.PERMANENT_DISABLE_ROUNDS) {
                vessel[field] = val - 1;
                changed = true;
                disabledChanged = true;
            }
        });

        // System hazard: Pulsar Radiation doubles weapon overheat and applies minor
        // continuous thermal damage (as described in the System Architect hazard
        // dropdown).
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
            // Decrement this squadron's per-weapon cooldowns on the same tick as ship weapons.
            if (sq.weapon_cooldowns) {
                Object.keys(sq.weapon_cooldowns).forEach(k => {
                    if (sq.weapon_cooldowns[k] > 0) { sq.weapon_cooldowns[k] -= 1; changed = true; }
                });
            }
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
            if (disabledChanged) {
                updatePayload.disabled_weapons_until = vessel.disabled_weapons_until || 0;
                updatePayload.disabled_sensors_until = vessel.disabled_sensors_until || 0;
                updatePayload.disabled_engines_until = vessel.disabled_engines_until || 0;
            }
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

    // Battle Map movement: reset every active-battle token's move_remaining to
    // its vessel's tactical_speed. No-op outside an active battle.
    if (typeof window.resetBattleMapMovement === 'function') await window.resetBattleMapMovement();

    // Range/Ordnance: ages in-flight ordnance (splits into 6 after turn 1,
    // resolves impact when turns run out) and auto-resolves Point Defense against
    // inbound payloads and engaged strike craft. See js/battle-map.js's header.
    // No-op outside an active battle.
    if (typeof window.processBattleRoundAutomations === 'function') await window.processBattleRoundAutomations();

    if (anyChanged) {
        if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
        if(typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
    }

    if (klaxonTriggered && window.AudioEngine) {
        window.AudioEngine.playKlaxon();
    }

    // Announced as a system line, since this tick can fire automatically (a
    // player ending the last turn via window.endCurrentTurn), not only from the
    // DM's ADVANCE ROUND click.
    await db.from('chat_logs').insert({
        sender_id: null,
        content: `⏭️ [TACTICAL] Combat round advanced. Cooldowns reduced. Heat dissipated. Strike craft loiter time degraded.`,
        message_type: 'system'
    });
};

/* Human-facing wrapper around window.resolveRoundTick: adds the DM-only gate
   and confirm dialog. The per-turn engine (js/battle-map.js) calls
   resolveRoundTick() directly. */
window.advanceCombatRound = async function() {
    if (currentUserRole !== 'dm') return;
    if (!(await window.showConfirmModal("Advance combat round? This will process cooldowns, overheat, and force-recall any strike craft that run out of fuel."))) return;
    await window.resolveRoundTick();
};
