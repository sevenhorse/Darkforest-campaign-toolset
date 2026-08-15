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
            { name: "Ship Killer Missiles", dice: "2d12", dmgType: "Impact/Heat" }
        ]
    },
    hawk: {
        label: "Hawk Medium Bomber", base_hp: 350,
        weapons: [
            { name: "Dual 120mm Autocannons", dice: "2d10", dmgType: "Impact" },
            { name: "Micro Railgun", dice: "1d12", dmgType: "Piercing" },
            { name: "Capitol Killer Missiles", dice: "1d20", dmgType: "Piercing" }
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

/* --- CARGO HUB & LOGISTICS LOOP --- */
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
    // Economy feature: initialize synth capacity if missing
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

    // Economy UI: Elder E-M Synthesizer interface
    let synthHtml = `
        <div style="background:#0a1410; border:1px solid #00e5a3; padding:8px; margin-bottom:12px; border-radius:2px; display:flex; justify-content:space-between; align-items:center;">
            <div>
                <strong style="color:#00e5a3; font-size:12px;">✨ Elder E-M Synthesizer</strong>
                <div style="font-size:9px; color:#6b826a;">Daily Mass Conversion Capacity (Recharges @ 24h)</div>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <button onclick="window.modifySynthCapacity('${vessel.id}', -1)" style="padding:2px 8px; font-size:10px;">-1 Ton</button>
                <strong style="color:#00e5a3; font-size:14px; margin:0 10px;">${cargo.synth_capacity} / 10</strong>
                <button onclick="window.modifySynthCapacity('${vessel.id}', 1)" style="padding:2px 8px; font-size:10px;">+1 Ton</button>
            </div>
        </div>
    `;

    let html = synthHtml;
    
    if (currentCategoryItems.length === 0) {
        html += `<span style="font-size:11px; color:#6b826a;">No cargo items recorded in this section. Use the form on the right to store items.</span>`;
    } else {
        currentCategoryItems.forEach((item, index) => {
            html += `
                <div class="note-card" style="display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:#030403;">
                    <div style="flex:2;">
                        <strong style="color:#00e5a3; font-size:12px;">${item.name}</strong>
                        <div style="font-size:10px; color:#6b826a;">Unit Type: ${item.unit || 'units'}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
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
    if (!confirm("Decommission this cargo item from vessel hold?")) return;
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    if (cargo[activeCargoSubtab]) {
        cargo[activeCargoSubtab].splice(itemIndex, 1);
        await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
        vessel.cargo_inventory = cargo;
        window.renderTerminalCargoDeck();
    }
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
};

window.renderVesselDeck = function() {
    const select = document.getElementById('vessel-deck-select');
    if (!select || !select.value) return;

    const vesselId = select.value;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    const healthContainer = document.getElementById('vessel-health-container');
    const decksContainer = document.getElementById('vessel-decks-container');
    const weaponsContainer = document.getElementById('vessel-weapons-container');

    if (healthContainer) {
        const s_int = vessel.integrity_shields !== undefined ? vessel.integrity_shields : 400;
        const s_max = vessel.max_shields || 400;
        const h_int = vessel.integrity_hull !== undefined ? vessel.integrity_hull : 300;
        const h_max = vessel.max_hull || 300;
        const r_int = vessel.integrity_reactive !== undefined ? vessel.integrity_reactive : 10;
        const r_max = vessel.max_reactive || 10;
        const a_int = vessel.integrity_ablative !== undefined ? vessel.integrity_ablative : 10;
        const a_max = vessel.max_ablative || 10;

        let currentStance = vessel.ship_stance || 'Balanced';
        let stanceHtml = `
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

        const makeBar = (label, current, max, color, key) => `
            <div style="margin-bottom: 8px;">
                <div style="display:flex; justify-content:space-between; font-size:10px; color:${color}; margin-bottom:2px;">
                    <strong>${label}</strong>
                    <span>${current} / ${max}</span>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    <button onclick="window.modifyShipHealth('${vessel.id}', '${key}', -10)" style="width:24px; padding:2px; font-size:10px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-10</button>
                    <button onclick="window.modifyShipHealth('${vessel.id}', '${key}', -1)" style="width:24px; padding:2px; font-size:12px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-</button>
                    <div style="flex-grow:1; height:12px; background:#030403; border:1px solid #3c4e36; border-radius:2px; overflow:hidden;">
                        <div style="width:${Math.max(0, Math.min(100, (current/max)*100))}%; height:100%; background:${current === 0 ? '#ff3333' : color}; transition:width 0.3s;"></div>
                    </div>
                    <button onclick="window.modifyShipHealth('${vessel.id}', '${key}', 1)" style="width:24px; padding:2px; font-size:12px; margin:0;">+</button>
                    <button onclick="window.modifyShipHealth('${vessel.id}', '${key}', 10)" style="width:24px; padding:2px; font-size:10px; margin:0;">+10</button>
                </div>
            </div>
        `;
        
        let resetBtn = `<button class="btn-reveal" onclick="window.resetShipStats('${vessel.id}')" style="width:100%; font-size:10px; margin-bottom:10px; border-color:#00e5a3;">↺ RESET COMBAT STATS</button>`;

        healthContainer.innerHTML = stanceHtml + resetBtn + makeBar('DEFLECTOR SHIELDS', s_int, s_max, '#00e1ff', 'shields') + makeBar('HULL INTEGRITY', h_int, h_max, '#ff3333', 'hull') + makeBar('REACTIVE ARMOR (PIERCE)', r_int, r_max, '#ffaa00', 'reactive') + makeBar('ABLATIVE ARMOR (HEAT)', a_int, a_max, '#ffaa00', 'ablative');
    }

    if (decksContainer) {
        let dHtml = '';
        const decks = vessel.ship_decks || [];
        if (decks.length === 0) dHtml = '<span style="font-size:10px; color:#6b826a;">No internal decks designated.</span>';
        else {
            decks.forEach((d, idx) => {
                dHtml += `
                <div style="margin-bottom: 8px; background: #030403; padding: 6px; border: 1px solid #00e1ff; border-radius: 2px;">
                    <div style="display:flex; justify-content:space-between; font-size:10px; color:#00e1ff; margin-bottom:2px;">
                        <strong>${d.name}</strong><span>${d.hp} / ${d.max_hp}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, -5)" style="width:24px; padding:2px; font-size:10px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-5</button>
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, -1)" style="width:24px; padding:2px; font-size:12px; margin:0; background:#3d0c0c; border-color:#ff3333; color:#ffaaaa;">-</button>
                        <div style="flex-grow:1; height:8px; background:#040605; border:1px solid #3c4e36; border-radius:2px; overflow:hidden;">
                            <div style="width:${Math.max(0, Math.min(100, (d.hp/d.max_hp)*100))}%; height:100%; background:${d.hp === 0 ? '#ff3333' : '#00e1ff'}; transition:width 0.3s;"></div>
                        </div>
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, 1)" style="width:24px; padding:2px; font-size:12px; margin:0;">+</button>
                        <button onclick="window.modifyShipDeckHealth('${vessel.id}', ${idx}, 5)" style="width:24px; padding:2px; font-size:10px; margin:0;">+5</button>
                        <button class="layer-del" onclick="window.deleteShipDeck('${vessel.id}', ${idx})" style="padding:2px 6px; font-size:10px; margin:0; margin-left:4px;">✕</button>
                    </div>
                </div>`;
            });
        }
        decksContainer.innerHTML = dHtml;
    }

    if (weaponsContainer) {
        let targetOptions = '<option value="">-- No Target --</option>';
        globalShipMarkersCache.forEach(m => { if(m.id !== vessel.id) targetOptions += `<option value="${m.id}">${m.name}</option>`; });

        const weapons = vessel.ship_weapons || [];
        let wHtml = '';
        if (weapons.length === 0) wHtml = '<span style="font-size:10px; color:#6b826a;">No weapon hardpoints installed.</span>';
        else {
            weapons.forEach((w, idx) => {
                wHtml += `
                <div class="note-card" style="padding:8px; margin-bottom:6px; background:#030403; border-color:#ff3333;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <strong style="color:#ff6b6b; font-size:12px;">[${w.loc || 'Unmounted'}] ${w.name}</strong>
                            <div style="font-size:10px; color:#d4c5a9;">${w.dice} ${w.modifier} ${w.explodes ? '💥' : ''}</div>
                        </div>
                        <div style="display:flex; gap:6px; align-items:center;">
                            <label for="wpn-target-${vessel.id}-${idx}" style="display:none;">Target</label>
                            <select id="wpn-target-${vessel.id}-${idx}" style="width:120px; height:20px; font-size:9px; margin:0; padding:0; background:#0a1410; color:#00e5a3; border:1px solid #3c4e36; border-radius:2px;">${targetOptions}</select>
                            <label for="wpn-volley-${vessel.id}-${idx}" style="display:none;">Volley</label>
                            <input type="number" id="wpn-volley-${vessel.id}-${idx}" value="1" min="1" title="Volley Count" style="width:35px; height:20px; font-size:10px; margin:0; padding:0; text-align:center; border:1px solid #ff6b6b; background:#0a1410; color:#ff6b6b; border-radius:2px;">
                            <button class="layer-edit" onclick="window.rollShipWeapon('${vessel.id}', ${idx})" style="padding:4px 10px; font-size:10px; border-color:#ff6b6b; color:#ff6b6b;">FIRE</button>
                            <button class="layer-del" onclick="window.deleteShipWeapon('${vessel.id}', ${idx})" style="padding:4px 8px; font-size:10px;">✕</button>
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
        }
        weaponsContainer.innerHTML = wHtml;
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
                        <button class="layer-edit" onclick="window.launchSquadron('${vessel.id}', ${idx})" style="padding:4px 10px; font-size:9px; border-color:#00e1ff; color:#00e1ff;">LAUNCH</button>
                        <button class="layer-del" onclick="window.deleteSquadron('${vessel.id}', ${idx}, false)" style="padding:4px 8px; font-size:9px;">✕</button>
                    </div>
                </div>`;
            });
        }
        embarkedContainer.innerHTML = eHtml;
    }

    if (deployedContainer) {
        let targetOptions = '<option value="">-- Target --</option>';
        globalShipMarkersCache.forEach(m => { if(m.id !== vessel.id) targetOptions += `<option value="${m.id}">${m.name}</option>`; });

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
            alert(`Cannot repair hull! Requires at least ${cost} Titanium Armor Hull Plate(s) in Expendables cargo.`);
            return;
        }
    }

    let dbKey = 'integrity_' + key;
    let maxKey = 'max_' + key;
    let current = vessel[dbKey] !== undefined ? vessel[dbKey] : 100;
    let max = vessel[maxKey] || 100;

    current = Math.max(0, Math.min(max, current + delta));
    let payload = {}; payload[dbKey] = current;
    
    await db.from('ship_markers').update(payload).eq('id', vesselId);
    vessel[dbKey] = current;
    window.renderVesselDeck();
};

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

        await db.from('chat_logs').insert({
            sender_id: currentUserId,
            content: `🛬 [FLIGHT OPS] ${sq.name} recovered to ${vessel.name} hangar bay.`,
            message_type: 'text'
        });
    }
};

window.deleteSquadron = async function(vesselId, idx, isDeployed) {
    if (!confirm(isDeployed ? "Record this squadron as destroyed in combat?" : "Decommission this squadron from the hangar?")) return;
    
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let targetArray = isDeployed ? (vessel.ship_deployed || []) : (vessel.ship_hangar || []);
    let sq = targetArray.splice(idx, 1)[0];

    let updatePayload = isDeployed ? { ship_deployed: targetArray } : { ship_hangar: targetArray };
    await db.from('ship_markers').update(updatePayload).eq('id', vesselId);
    
    if (isDeployed) vessel.ship_deployed = targetArray;
    else vessel.ship_hangar = targetArray;

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
    if (!confirm("Restore maximum health profiles and resupply all ammunition banks for this vessel?")) return;
    
    let payload = {
        integrity_shields: vessel.max_shields || 400,
        integrity_hull: vessel.max_hull || 300,
        integrity_reactive: vessel.max_reactive || 10,
        integrity_ablative: vessel.max_ablative || 10
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
    alert("Vessel combat stats reset to maximums.");
};

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
    let dmgType = wpn.dmgType || "Impact";
    let isPiercing = dmgType === "Piercing";
    let isHeat = dmgType === "Heat";

    if (targetId) {
        targetShip = globalShipMarkersCache.find(m => m.id === targetId);
        if (targetShip) {
            let tStance = targetShip.ship_stance || 'Balanced';
            if (tStance === 'Defensive') { total = Math.floor(total * 0.75); combatLog += `[Target Defensive: -25% Dmg] `; }
            if (tStance === 'Evasive') { total = Math.floor(total * 0.50); combatLog += `[Target Evasive: -50% Dmg] `; }
            if (tStance === 'Aggressive') { total = Math.floor(total * 1.25); combatLog += `[Target Aggressive: +25% Dmg] `; }

            let s_int = targetShip.integrity_shields !== undefined ? targetShip.integrity_shields : 400;
            let h_int = targetShip.integrity_hull !== undefined ? targetShip.integrity_hull : 300;
            let r_int = targetShip.integrity_reactive !== undefined ? targetShip.integrity_reactive : 10;
            let a_int = targetShip.integrity_ablative !== undefined ? targetShip.integrity_ablative : 10;
            
            let remainingDmg = total;

            let shieldDmg = Math.min(s_int, remainingDmg);
            s_int -= shieldDmg;
            remainingDmg -= shieldDmg;
            if (shieldDmg > 0) combatLog += `Shields absorbed: ${shieldDmg}. `;

            if (remainingDmg > 0) {
                if (isPiercing && r_int > 0) {
                    r_int -= 1;
                    combatLog += `[REACTIVE ARMOR] charge expended. Hull breach negated! `;
                    remainingDmg = 0;
                } else if (isHeat && a_int > 0) {
                    a_int -= 1;
                    combatLog += `[ABLATIVE ARMOR] charge expended. Hull damage negated! `;
                    remainingDmg = 0;
                } else {
                    let hullDmg = Math.min(h_int, remainingDmg);
                    h_int -= hullDmg;
                    remainingDmg -= hullDmg;
                    combatLog += `Hull suffered: ${hullDmg} damage! `;
                    if (h_int <= 0) combatLog += `**CRITICAL HULL BREACH!** `;
                }
            }

            await db.from('ship_markers').update({
                integrity_shields: s_int,
                integrity_hull: h_int,
                integrity_reactive: r_int,
                integrity_ablative: a_int
            }).eq('id', targetShip.id);

            targetShip.integrity_shields = s_int;
            targetShip.integrity_hull = h_int;
            targetShip.integrity_reactive = r_int;
            targetShip.integrity_ablative = a_int;
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

    if(typeof window.broadcastRoll === 'function') {
        await window.broadcastRoll(`[${sq.name}] FIRES ${wpn.name} (x${volleys})${targetString}`, breakdownString, total);
    }
};

window.rollShipWeapon = async function(vesselId, idx) {
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    
    let wpn = (vessel.ship_weapons || [])[idx];
    if (!wpn) return;

    let volleyInput = document.getElementById(`wpn-volley-${vesselId}-${idx}`);
    let volleys = volleyInput ? (parseInt(volleyInput.value) || 1) : 1;
    let targetSelect = document.getElementById(`wpn-target-${vesselId}-${idx}`);
    let targetId = targetSelect ? targetSelect.value : null;

    if (wpn.cooldown > 0) {
        if (!confirm(`[WARNING] ${wpn.name} is on cooldown! Firing will OVERRIDE and generate OVERHEAT. Proceed?`)) return;
        wpn.overheat = Math.min(10, (wpn.overheat || 0) + 1);
    } 
    
    if (wpn.ammo === 0) {
        alert(`[EMPTY] ${wpn.name} is out of ammunition!`); 
        return;
    }

    if (wpn.ammo > 0) {
        if (wpn.ammo < volleys) {
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
    let wpnLower = wpn.name.toLowerCase();
    let isPiercing = wpnLower.includes('pierce') || wpnLower.includes('piercing') || wpnLower.includes('rail') || wpnLower.includes('gauss');
    let isHeat = wpnLower.includes('heat') || wpnLower.includes('plasma') || wpnLower.includes('laser') || wpnLower.includes('gamma');
    let dmgType = isPiercing ? 'Piercing' : (isHeat ? 'Heat' : 'Impact/Ion');

    if (targetId) {
        targetShip = globalShipMarkersCache.find(m => m.id === targetId);
        if (targetShip) {
            let tStance = targetShip.ship_stance || 'Balanced';
            if (tStance === 'Defensive') { total = Math.floor(total * 0.75); combatLog += `[Target Defensive: -25% Dmg] `; }
            if (tStance === 'Evasive') { total = Math.floor(total * 0.50); combatLog += `[Target Evasive: -50% Dmg] `; }
            if (tStance === 'Aggressive') { total = Math.floor(total * 1.25); combatLog += `[Target Aggressive: +25% Dmg] `; }

            let s_int = targetShip.integrity_shields !== undefined ? targetShip.integrity_shields : 400;
            let h_int = targetShip.integrity_hull !== undefined ? targetShip.integrity_hull : 300;
            let r_int = targetShip.integrity_reactive !== undefined ? targetShip.integrity_reactive : 10;
            let a_int = targetShip.integrity_ablative !== undefined ? targetShip.integrity_ablative : 10;
            
            let remainingDmg = total;

            let shieldDmg = Math.min(s_int, remainingDmg);
            s_int -= shieldDmg;
            remainingDmg -= shieldDmg;
            if (shieldDmg > 0) combatLog += `Shields absorbed: ${shieldDmg}. `;

            if (remainingDmg > 0) {
                if (isPiercing && r_int > 0) {
                    r_int -= 1; combatLog += `[REACTIVE ARMOR] charge expended. Hull breach negated! `; remainingDmg = 0;
                } else if (isHeat && a_int > 0) {
                    a_int -= 1; combatLog += `[ABLATIVE ARMOR] charge expended. Hull damage negated! `; remainingDmg = 0;
                } else {
                    let hullDmg = Math.min(h_int, remainingDmg);
                    h_int -= hullDmg; remainingDmg -= hullDmg;
                    combatLog += `Hull suffered: ${hullDmg} damage! `;
                    if (h_int <= 0) combatLog += `**CRITICAL HULL BREACH!** `;
                }
            }

            await db.from('ship_markers').update({ integrity_shields: s_int, integrity_hull: h_int, integrity_reactive: r_int, integrity_ablative: a_int }).eq('id', targetShip.id);
            targetShip.integrity_shields = s_int; targetShip.integrity_hull = h_int; targetShip.integrity_reactive = r_int; targetShip.integrity_ablative = a_int;
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
        
    if(typeof window.broadcastRoll === 'function') {
        await window.broadcastRoll(`[${vessel.name}] FIRES [${wpn.loc || 'Mount'}]${volleyTag}${targetString}`, breakdownString, total);
    }
};

window.addShipDeck = async function() {
    const select = document.getElementById('vessel-deck-select');
    const name = document.getElementById('new-deck-name').value.trim();
    let maxHp = parseInt(document.getElementById('new-deck-hp').value) || 50;

    if (!select || !select.value) { alert("Select a diagnostic target vessel first."); return; }
    if (!name) { alert("Please enter a deck or system name."); return; }
    
    let vessel = globalShipMarkersCache.find(m => m.id === select.value);
    if (!vessel) return;

    let decks = vessel.ship_decks || [];
    decks.push({ name: name, hp: maxHp, max_hp: maxHp });

    await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vessel.id);
    vessel.ship_decks = decks;

    document.getElementById('new-deck-name').value = '';
    document.getElementById('new-deck-hp').value = '50';
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
    if (!confirm("Scrap this internal deck?")) return;
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let decks = vessel.ship_decks || [];
    decks.splice(idx, 1);

    await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vesselId);
    vessel.ship_decks = decks;
    window.renderVesselDeck();
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
        ammoVal = parseInt(ammoInput.value);
    }

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
        ammo: ammoVal, max_ammo: ammoVal, cooldown: 0, overheat: 0 
    });

    await db.from('ship_markers').update({ ship_weapons: weapons }).eq('id', vessel.id);
    vessel.ship_weapons = weapons;

    document.getElementById('new-ship-wpn-loc').value = '';
    document.getElementById('new-ship-wpn-name').value = '';
    document.getElementById('new-ship-wpn-dice').value = '';
    document.getElementById('new-ship-wpn-mod').value = '';
    if (ammoInput) ammoInput.value = '';
    window.renderVesselDeck();
};

window.deleteShipWeapon = async function(vesselId, idx) {
    if (!confirm("Uninstall this weapon system?")) return;
    let vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    let weapons = vessel.ship_weapons || [];
    weapons.splice(idx, 1);

    await db.from('ship_markers').update({ ship_weapons: weapons }).eq('id', vesselId);
    vessel.ship_weapons = weapons;
    window.renderVesselDeck();
};

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
        arsenal.forEach((w, idx) => {
            html += `
                <div class="arsenal-row">
                    <strong style="color:#ffaa00; font-size:11px;">${w.name}</strong>
                    <span style="font-size:10px; color:#d4c5a9; text-align:center;">${w.dice}</span>
                    <span style="font-size:10px; color:#d4c5a9; text-align:center;">${w.modifier}</span>
                    <span style="font-size:10px; text-align:center;" title="Explodes">${w.explodes ? '💥' : ''}</span>
                    <div style="display:flex; gap:4px;">
                        <button class="layer-edit" onclick="window.rollArsenalWeapon(${idx})" style="padding:2px 8px; font-size:9px; border-color:#ffaa00; color:#ffaa00;">ROLL</button>
                        <button class="layer-del" onclick="window.deleteArsenalItem('${w.id}')" style="padding:2px 6px; font-size:9px;">✕</button>
                    </div>
                </div>
            `;
        });
    }
    container.innerHTML = html;
    
    const badgeCombat = document.getElementById('badge-combat');
    if (badgeCombat) badgeCombat.innerText = arsenal.length;
};

window.addArsenalItem = async function() {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character) { alert("Please save your Dossier & Stats first before adding weapons."); return; }
    
    const name = document.getElementById('new-wpn-name').value.trim();
    let dice = document.getElementById('new-wpn-dice').value.trim().toLowerCase();
    let mod = document.getElementById('new-wpn-mod').value.trim();
    const explodes = document.getElementById('new-wpn-explodes').checked;

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
        explodes: explodes
    };

    const { error } = await db.from('character_arsenal').insert(payload);
    if (error) { alert("Failed to add weapon: " + error.message); return; }
    
    document.getElementById('new-wpn-name').value = '';
    document.getElementById('new-wpn-dice').value = '';
    document.getElementById('new-wpn-mod').value = '';
    if(typeof window.loadAllProfiles === 'function') window.loadAllProfiles();
};

window.deleteArsenalItem = async function(id) {
    if (!confirm("Remove this item from your arsenal?")) return;
    await db.from('character_arsenal').delete().eq('id', id);
    if(typeof window.loadAllProfiles === 'function') window.loadAllProfiles();
};

window.rollArsenalWeapon = async function(idx) {
    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf) return;
    let wpn = (myProf.arsenal || [])[idx];
    if (!wpn) return;

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
    
    if(typeof window.broadcastRoll === 'function') {
        await window.broadcastRoll(`[${myProf.username || 'Commander'}] FIRES ${wpn.name}`, breakdownString, total);
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
    });

    skillCheckboxes.forEach(cb => {
        let skillName = cb.value;
        let safeKey = skillName.toLowerCase().replace(/[^a-z0-9]/g, '_');
        let skillMod = skills[safeKey] || 0;
        total += skillMod;
        breakdown.push(`[${skillName} Mod: ${skillMod >= 0 ? '+' : ''}${skillMod}]`);
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
        }
        html += '<div style="max-height:220px; overflow-y:auto;">';
        combatantsList.forEach(c => {
            html += `
                <div class="note-card" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; padding:6px;">
                    <div>
                        <strong style="color:#00e5a3; font-size:11px;">[Init: ${c.initiative}] ${c.name}</strong>
                        <p style="margin:2px 0 0 0; font-size:10px; color:#6b826a;">HP/Status: ${c.hp}</p>
                    </div>
                    ${currentUserRole === 'dm' ? `<button class="layer-del" onclick="window.removeCombatant('${c.id}')" style="padding:2px 6px; font-size:9px;">X</button>` : ''}
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
    
    await db.from('combat_tracker').insert({ name, initiative, hp }); 
    if(typeof loadCombatTracker === 'function') loadCombatTracker();
};

window.removeCombatant = async function(id) { 
    await db.from('combat_tracker').delete().eq('id', id); 
    if(typeof loadCombatTracker === 'function') loadCombatTracker(); 
};

window.advanceCombatRound = async function() {
    if (currentUserRole !== 'dm') return;
    if (!confirm("Advance combat round? This will process cooldowns, overheat, and strike craft fuel globally.")) return;

    let anyChanged = false;

    for (let vessel of globalShipMarkersCache) {
        let changed = false;
        let weapons = vessel.ship_weapons || [];
        let deployed = vessel.ship_deployed || [];
        let flightLog = [];

        weapons.forEach(w => {
            if (w.cooldown > 0) { w.cooldown -= 1; changed = true; }
            if (w.overheat > 0) { w.overheat -= 1; changed = true; }
        });

        deployed.forEach(sq => {
            if (sq.loiter > 0) { 
                sq.loiter -= 1; 
                changed = true; 
                if (sq.loiter === 0) {
                    flightLog.push(`⚠️ ${sq.name} is BINGO FUEL! Must return to hangar!`);
                }
            }
        });

        if (changed) {
            anyChanged = true;
            await db.from('ship_markers').update({ 
                ship_weapons: weapons, 
                ship_deployed: deployed 
            }).eq('id', vessel.id);
        }
        
        if (flightLog.length > 0) {
            await db.from('chat_logs').insert({
                sender_id: 'system',
                content: `🚨 [FLIGHT OPS] ${vessel.name}: ${flightLog.join(' ')}`,
                message_type: 'text'
            });
        }
    }

    if (anyChanged) {
        if(typeof window.loadGalaxyData === 'function') window.loadGalaxyData();
        if(typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
    }

    await db.from('chat_logs').insert({
        sender_id: currentUserId,
        content: `⏭️ [TACTICAL] Combat round advanced. Cooldowns reduced. Heat dissipated. Strike craft loiter time degraded.`,
        message_type: 'text'
    });
};
