/* ==========================================================================
   js/quartermaster.js - Quartermaster: personal items through the ship hold
   (switch 'item_issue'; the DM catalogue editor works regardless)
   ==========================================================================
   DM decisions (2026-10-11):
     - Personal items go THROUGH THE HOLD: blueprints build them into a ship's
       cargo like anything else; ISSUE moves one from a hold onto a character
       sheet (Arsenal or Gear) and RETURN puts it back.
     - Personal ammo RELOADS FROM THE HOLD: a weapon names the cargo item it
       reloads from (character_arsenal.ammo_item); firing still spends one
       round from the magazine (combat.js); RELOAD fills the magazine from a
       hold the player owns, 1 round = 1 unit.
     - Kits and carried supplies get QUANTITY + USES: character_gear.qty is a
       real number (the old "x12" notes were migrated into it); a consumable
       gear definition's USE spends one; a definition with max_uses gives each
       item charges (uses_left on the row) and the last charge uses up one
       item. A row that reaches 0 is removed, so its bonus stops with it.
     - Names come from the cargo catalogue (cargo_item_catalog). A catalogue
       item marked issue_kind 'weapon' carries weapon_stats {dice, modifier,
       explodes, damage_type, max_ammo, ammo_item, range_short, range_long};
       'gear' links a gear definition (created on first ISSUE if missing).

   Holds: a player may draw from / return to ships they own (owner_ids); the
   DM may use any ship and issue to any character. Colony storage is not a
   source yet (deferred). Issued weapons arrive with an empty magazine.
   Grenades and other thrown items are weapons whose ammo item is themselves,
   so the magazine is simply how many you carry.

   Owners: renderArsenal (combat.js) fires 'arsenal-rendered', renderGearLoadout
   (ui.js) 'gear-rendered', renderTerminalCargoDeck (combat.js)
   'cargo-deck-rendered'; this file only adds buttons to their rows.
   ========================================================================== */
(function () {
const byId = (id) => document.getElementById(id);
const esc = (s) => (typeof window.escapeHtml === 'function' ? window.escapeHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
const myId = () => (typeof currentUserId !== 'undefined' ? currentUserId : null);
const ships = () => (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []) || [];
const profiles = () => (typeof allProfiles !== 'undefined' ? allProfiles : []) || [];
const catalog = () => (typeof window.getCargoCatalog === 'function' ? window.getCargoCatalog() : []) || [];
const catById = (id) => catalog().find(c => c.id === id) || null;
const catByName = (n) => (typeof window.catalogItemByName === 'function' ? window.catalogItemByName(n) : null);
const gearDef = (id) => (id && typeof window.findGearDefinition === 'function' ? window.findGearDefinition(id) : null);
const fmt = (n) => { const x = Number(n) || 0; return Number.isInteger(x) ? x.toLocaleString() : (+x.toFixed(2)).toString(); };

window.quartermasterOn = function () { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('item_issue'); };

/* ---------- holds ----------
   A hold is a ship's cargo or a colony's storage. Keys: 'ship:<id>' /
   'colony:<id>' (a bare id means a ship). Players use ships they own
   (owner_ids) and colonies they own (owner_id); the DM uses any. */
const colonies = () => (typeof coloniesList !== 'undefined' ? coloniesList : []) || [];
const isColony = (h) => !!(h && h.__colony);
function resolveHold(key) {
    const k = String(key || '');
    if (k.startsWith('colony:')) { const c = colonies().find(x => x.id === k.slice(7)); if (c) c.__colony = true; return c || null; }
    const id = k.startsWith('ship:') ? k.slice(5) : k;
    return ships().find(x => x.id === id) || null;
}
const holdKey = (h) => (isColony(h) ? 'colony:' : 'ship:') + h.id;
function canUseHold(v) {
    if (!v) return false;
    if (isDm()) return true;
    if (isColony(v)) return typeof window.canManageColony === 'function' ? window.canManageColony(v) : v.owner_id === myId();
    return typeof window.vesselHasOwner === 'function' && window.vesselHasOwner(v, myId());
}
function myHolds() {
    const cs = colonies().map(c => { c.__colony = true; return c; });
    return ships().concat(cs).filter(canUseHold).sort((a, b) => (isColony(a) - isColony(b)) || String(a.name || '').localeCompare(String(b.name || '')));
}
function cargoOf(v) { return isColony(v) ? window.sanitizeColonyCargo(v.cargo_inventory) : window.sanitizeCargo(v.cargo_inventory); }
function stockOf(v, name) {
    const f = window.findCargoItemAcrossBuckets(cargoOf(v), name);
    return f ? Number(f.item.qty) || 0 : 0;
}
async function saveCargo(v, cargo) {
    const { error } = await db.from(isColony(v) ? 'colonies' : 'ship_markers').update({ cargo_inventory: cargo }).eq('id', v.id);
    if (error) throw new Error('hold update failed: ' + error.message);
    v.cargo_inventory = cargo;
}
// Removes up to qty; returns how much was actually taken.
async function takeFromHold(v, name, qty) {
    const cargo = cargoOf(v);
    const f = window.findCargoItemAcrossBuckets(cargo, name);
    const have = f ? Number(f.item.qty) || 0 : 0;
    const taken = Math.max(0, Math.min(have, qty));
    if (!taken) return 0;
    f.item.qty = +(have - taken).toFixed(4);
    if (f.item.qty <= 0) cargo[f.bucket] = cargo[f.bucket].filter(i => i !== f.item); // no empty rows left behind
    await saveCargo(v, cargo);
    return taken;
}
async function putInHold(v, name, qty, unit, bucket) {
    if (!(qty > 0)) return;
    const cargo = cargoOf(v);
    const c = catByName(name);
    window.addCargoStack(cargo, c ? c.name : name, qty, unit || (c && c.unit) || 'Units', bucket || (c && c.category) || 'expendables');
    await saveCargo(v, cargo);
}
async function log(content) {
    try { await db.from('chat_logs').insert({ sender_id: null, message_type: 'system', content }); } catch (e) {}
}
async function refreshAll() {
    if (typeof loadAllProfiles === 'function') await loadAllProfiles();
    if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
    if (typeof window.renderColoniesPanel === 'function') window.renderColoniesPanel();
    if (typeof window.updateShieldDisplay === 'function') window.updateShieldDisplay();
    if (typeof window.updateInjuryMax === 'function') window.updateInjuryMax();
}
// A thrown / self-fed weapon (grenades, claymores): its ammo is the item
// itself, so ISSUE tops up one Arsenal row's count and RETURN gives back what
// is carried -- no separate "weapon" unit sits on the sheet.
function selfFed(c) {
    const ws = (c && c.weapon_stats) || {};
    if (!c || c.issue_kind !== 'weapon' || ws.max_ammo == null || ws.max_ammo === '') return false;
    return String(ws.ammo_item || c.name).toLowerCase() === String(c.name).toLowerCase();
}
const isSelfFedRow = (w) => !!w && !!w.ammo_item && String(w.ammo_item).toLowerCase() === String(returnName(w) || '').toLowerCase();
function selfFedRow(prof, c) {
    return (prof.arsenal || []).find(w => w.catalog_item_id === c.id) || (prof.arsenal || []).find(w => String(w.ammo_item || '').toLowerCase() === c.name.toLowerCase() && !w.catalog_item_id && String(w.name).toLowerCase().replace(/[^a-z]/g, '') === c.name.toLowerCase().replace(/[^a-z]/g, '')) || null;
}
// Sealed kits that can go back to a hold (a part-used open kit stays with the character).
function returnableQty(g) {
    const have = Number(g.qty == null ? 1 : g.qty);
    const def = gearDef(g.gear_definition_id);
    const opened = def && def.max_uses && g.uses_left != null && Number(g.uses_left) < Number(def.max_uses);
    return Math.max(0, opened ? have - 1 : have);
}
function charName(prof) { return (prof && prof.character && prof.character.name) || (prof && prof.username) || 'a character'; }

/* ---------- modal ---------- */
let QM = window.__qm = window.__qm || { onConfirm: null };
function ensureModal() {
    let o = byId('qm-overlay');
    if (o) return o;
    o = document.createElement('div');
    o.id = 'qm-overlay';
    o.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
    o.innerHTML = `<div class="panel" role="dialog" aria-modal="true" aria-labelledby="qm-title" style="position:relative; width:420px; max-width:94vw; max-height:88vh; overflow-y:auto; border-color:#c9962f;">
        <h4 id="qm-title" style="color:#c9962f; margin-top:0;"></h4>
        <div id="qm-body"></div>
        <div id="qm-err" style="font-size:10px; color:#ff6b6b; min-height:12px; margin-top:6px;"></div>
        <div style="display:flex; gap:10px; margin-top:10px;">
            <button type="button" id="qm-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
            <button type="button" id="qm-ok-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#00e5a3; color:#00e5a3;">CONFIRM</button>
        </div>
    </div>`;
    document.body.appendChild(o);
    o.addEventListener('click', (e) => { if (e.target === o) closeModal(); });
    byId('qm-cancel-btn').addEventListener('click', closeModal);
    byId('qm-ok-btn').addEventListener('click', async () => {
        if (!QM.onConfirm) return;
        const btn = byId('qm-ok-btn');
        btn.disabled = true;
        try {
            const msg = await QM.onConfirm();
            if (msg) { byId('qm-err').textContent = msg; return; }
            closeModal();
        } catch (err) {
            console.error('quartermaster', err);
            byId('qm-err').textContent = String(err && err.message || err);
        } finally { btn.disabled = false; }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && o.style.display === 'flex') closeModal(); });
    return o;
}
function openModal(title, bodyHtml, okLabel, onConfirm) {
    const o = ensureModal();
    byId('qm-title').textContent = title;
    byId('qm-body').innerHTML = bodyHtml;
    byId('qm-err').textContent = '';
    byId('qm-ok-btn').textContent = okLabel || 'CONFIRM';
    QM.onConfirm = onConfirm;
    o.style.display = 'flex';
    const first = o.querySelector('#qm-body select, #qm-body input');
    if (first) first.focus();
}
function closeModal() { const o = byId('qm-overlay'); if (o) o.style.display = 'none'; QM.onConfirm = null; }
window.closeQuartermasterModal = closeModal;
const fieldLbl = (id, text) => `<label for="${id}" style="font-size:9px; color:#6b826a; display:block; margin-top:6px;">${text}</label>`;
function holdSelect(id, itemName, needStock) {
    const list = myHolds().map(v => ({ v, n: itemName ? stockOf(v, itemName) : null })).filter(x => !needStock || x.n > 0);
    list.sort((a, b) => (b.n || 0) - (a.n || 0));
    if (!list.length) return '';
    return `<select id="${id}" style="margin:0;">${list.map(x => `<option value="${holdKey(x.v)}">${isColony(x.v) ? '🏠 ' : ''}${esc(x.v.name)}${x.n != null ? ` — has ${fmt(x.n)}` : ''}</option>`).join('')}</select>`;
}

/* ---------- ISSUE (hold -> sheet) ---------- */
function issueTargets() {
    return profiles().filter(p => p.character && p.character.id && (isDm() || p.id === myId()))
        .sort((a, b) => charName(a).localeCompare(charName(b)));
}
window.openIssueModal = function (vesselId, cargoName) {
    const v = resolveHold(vesselId);
    const c = catByName(cargoName);
    if (!v || !c || !c.issue_kind || !canUseHold(v)) return;
    const have = stockOf(v, c.name);
    const targets = issueTargets();
    if (!targets.length) { alert('Save your Dossier & Stats once before drawing items.'); return; }
    const weapon = c.issue_kind === 'weapon';
    const ws = c.weapon_stats || {};
    const thrown = selfFed(c);
    const me = targets.find(p => p.id === myId()) || targets[0];
    const roomFor = (prof) => { const row = selfFedRow(prof, c); return Math.max(0, (parseInt(ws.max_ammo, 10) || 0) - Number(row ? row.ammo || 0 : 0)); };
    const maxQty = thrown ? Math.min(Math.floor(have), roomFor(me)) : (weapon ? Math.min(10, Math.floor(have)) : have);
    const blurb = weapon
        ? `${esc(ws.dice || '1d6')} ${esc(ws.modifier || '+0')}${ws.damage_type ? ' · ' + esc(ws.damage_type) : ''}${ws.max_ammo != null ? ` · magazine ${ws.max_ammo}${ws.ammo_item ? ' (' + esc(ws.ammo_item) + ')' : ''} — arrives empty, RELOAD from a hold` : ''}`
        : (() => { const d = gearDef(c.gear_definition_id); return d ? esc(d.name) + (d.max_uses ? ` · ${d.max_uses} uses each` : (d.consumable ? ' · consumable' : '')) : 'Gear (a gear entry is created on first issue).'; })();
    openModal(`ISSUE ${c.name}`, `
        <p style="font-size:10px; color:#9fb4bd; margin:0 0 4px 0;">From <b style="color:#d4c5a9;">${esc(v.name)}</b> (has ${fmt(have)} ${esc(c.unit || '')}). ${weapon ? 'Goes to the Arsenal.' : 'Goes to Gear.'}</p>
        <p style="font-size:10px; color:#6b826a; margin:0;">${blurb}</p>
        ${fieldLbl('qm-target', 'Issue to')}
        <select id="qm-target" style="margin:0;">${targets.map(p => `<option value="${p.id}">${esc(charName(p))}</option>`).join('')}</select>
        ${fieldLbl('qm-qty', thrown ? `How many to carry (room for ${roomFor(me)} more, carry limit ${ws.max_ammo})` : (weapon ? 'How many (each is its own Arsenal entry, max 10)' : 'Quantity'))}
        <input type="number" id="qm-qty" min="1" max="${maxQty}" value="1" step="${weapon ? 1 : 'any'}" style="margin:0; text-align:center;">`,
    'ISSUE', async () => {
        const qty = Number(byId('qm-qty').value);
        if (!(qty > 0)) return 'Enter a quantity above 0.';
        if (weapon && !Number.isInteger(qty)) return 'Weapons are issued in whole numbers.';
        if (thrown) { const room = roomFor(targets.find(p => p.id === byId('qm-target').value)); if (qty > room) return `Room for ${room} more (carry limit ${ws.max_ammo}).`; if (qty > have) return `Only ${fmt(have)} in this hold.`; }
        else if (qty > maxQty) return `Only ${fmt(maxQty)} can be issued from this hold.`;
        await window.issueItem(holdKey(v), c.id, byId('qm-target').value, qty);
    });
};
// Core (also used by tests). Takes from the hold first; puts it back if the sheet write fails.
window.issueItem = async function (vesselId, catalogId, profileId, qty) {
    const v = resolveHold(vesselId);
    const c = catById(catalogId);
    const prof = profiles().find(p => p.id === profileId);
    if (!v || !c || !prof || !prof.character) throw new Error('Missing hold, item or character.');
    if (!canUseHold(v)) throw new Error('You can only draw from holds you own.');
    if (!isDm() && profileId !== myId()) throw new Error('Players can only issue to their own character.');
    const thrown = selfFed(c);
    const thrownRow = thrown ? selfFedRow(prof, c) : null;
    if (thrown) {
        const cap = parseInt(c.weapon_stats.max_ammo, 10) || 0;
        const room = Math.max(0, cap - Number(thrownRow ? thrownRow.ammo || 0 : 0));
        if (!Number.isInteger(qty) || qty > room) throw new Error(`Room for ${room} more ${c.name} (carry limit ${cap}).`);
    }
    const taken = await takeFromHold(v, c.name, qty);
    if (taken < qty) { if (taken) await putInHold(v, c.name, taken); throw new Error(`${v.name} doesn't have ${fmt(qty)} ${c.name}.`); }
    try {
        if (thrown && thrownRow) {
            const { error } = await db.from('character_arsenal').update({ ammo: Number(thrownRow.ammo || 0) + qty, ammo_item: c.name, catalog_item_id: c.id }).eq('id', thrownRow.id);
            if (error) throw new Error('Arsenal write failed: ' + error.message);
        } else if (c.issue_kind === 'weapon') {
            const ws = c.weapon_stats || {};
            const hasMag = ws.max_ammo != null && ws.max_ammo !== '';
            const row = {
                profile_id: prof.id, character_id: prof.character.id, name: c.name,
                dice: ws.dice || '1d6', modifier: ws.modifier || '+0', explodes: !!ws.explodes,
                damage_type: ws.damage_type || null,
                ammo: hasMag ? 0 : null, max_ammo: hasMag ? Math.max(0, parseInt(ws.max_ammo, 10) || 0) : null,
                ammo_item: hasMag ? (ws.ammo_item || c.name) : null,
                range_short: ws.range_short != null && ws.range_short !== '' ? parseInt(ws.range_short, 10) : null,
                range_long: ws.range_long != null && ws.range_long !== '' ? parseInt(ws.range_long, 10) : null,
                catalog_item_id: c.id
            };
            const rows = thrown ? [Object.assign({}, row, { ammo: qty })] : Array.from({ length: qty }, () => Object.assign({}, row));
            const { error } = await db.from('character_arsenal').insert(rows);
            if (error) throw new Error('Arsenal write failed: ' + error.message);
        } else {
            let defId = c.gear_definition_id;
            if (!defId || !gearDef(defId)) {
                const { data, error } = await db.from('gear_definitions').insert({ name: c.name, description: c.notes || '', status: 'approved', flavor_only: true, created_by: myId() }).select().single();
                if (error) throw new Error('Could not create the gear entry: ' + error.message);
                defId = data.id;
                await db.from('cargo_item_catalog').update({ gear_definition_id: defId }).eq('id', c.id);
                c.gear_definition_id = defId;
                if (typeof loadGearDefinitions === 'function') await loadGearDefinitions();
            }
            const def = gearDef(defId);
            const existing = (prof.gear || []).find(g => g.gear_definition_id === defId);
            if (existing) {
                const { error } = await db.from('character_gear').update({ qty: +(Number(existing.qty || 0) + qty).toFixed(4), catalog_item_id: existing.catalog_item_id || c.id }).eq('id', existing.id);
                if (error) throw new Error('Gear write failed: ' + error.message);
            } else {
                const { error } = await db.from('character_gear').insert({ character_id: prof.character.id, gear_definition_id: defId, qty, equipped: true, catalog_item_id: c.id, uses_left: def && def.max_uses ? def.max_uses : null });
                if (error) throw new Error('Gear write failed: ' + error.message);
            }
        }
    } catch (err) {
        await putInHold(v, c.name, qty);
        throw err;
    }
    await log(`📦 [QUARTERMASTER] ${fmt(qty)}x ${c.name} issued from ${v.name} to ${charName(prof)}.`);
    await refreshAll();
};

/* ---------- RETURN (sheet -> hold) ---------- */
function myProfileFor(rowOwnerCheck) { return profiles().find(rowOwnerCheck) || null; }
function returnName(row) { const c = catById(row.catalog_item_id); return c ? c.name : null; }
window.openReturnArsenalModal = function (arsenalId) {
    const prof = myProfileFor(p => (p.arsenal || []).some(w => w.id === arsenalId));
    const w = prof && prof.arsenal.find(x => x.id === arsenalId);
    const name = w && returnName(w);
    if (!w || !name) return;
    const sel = holdSelect('qm-hold', name, false);
    if (!sel) { alert('You have no ship hold to return this to.'); return; }
    const rounds = isSelfFedRow(w) ? `<p style="font-size:10px; color:#6b826a; margin:6px 0 0 0;">All ${fmt(w.ammo || 0)} carried go back.</p>`
        : (Number(w.ammo) > 0 && w.ammo_item ? `<p style="font-size:10px; color:#6b826a; margin:6px 0 0 0;">The ${fmt(w.ammo)} loaded round(s) go back as ${esc(w.ammo_item)}.</p>` : '');
    openModal(`RETURN ${w.name}`, `${fieldLbl('qm-hold', 'Return to')}${sel}${rounds}`, 'RETURN', async () => {
        await window.returnArsenalItem(arsenalId, byId('qm-hold').value);
    });
};
window.returnArsenalItem = async function (arsenalId, vesselId) {
    const prof = myProfileFor(p => (p.arsenal || []).some(w => w.id === arsenalId));
    const w = prof && prof.arsenal.find(x => x.id === arsenalId);
    const v = resolveHold(vesselId);
    const name = w && returnName(w);
    if (!w || !v || !name) throw new Error('Missing weapon or hold.');
    if (!canUseHold(v)) throw new Error('You can only return to holds you own.');
    if (!isDm() && prof.id !== myId()) throw new Error('Not your weapon.');
    const { error } = await db.from('character_arsenal').delete().eq('id', w.id);
    if (error) throw new Error('Arsenal update failed: ' + error.message);
    const thrown = isSelfFedRow(w);
    if (!thrown) await putInHold(v, name, 1);
    const rounds = Number(w.ammo) > 0 && w.ammo_item ? Number(w.ammo) : 0;
    if (rounds) await putInHold(v, w.ammo_item, rounds);
    await log(thrown ? `📦 [QUARTERMASTER] ${charName(prof)} returned ${fmt(rounds)}x ${name} to ${v.name}.` : `📦 [QUARTERMASTER] ${charName(prof)} returned ${name}${rounds ? ` (+${fmt(rounds)} ${w.ammo_item})` : ''} to ${v.name}.`);
    await refreshAll();
};
window.openReturnGearModal = function (gearId) {
    const prof = myProfileFor(p => (p.gear || []).some(g => g.id === gearId));
    const g = prof && prof.gear.find(x => x.id === gearId);
    const name = g && returnName(g);
    if (!g || !name) return;
    const sel = holdSelect('qm-hold', name, false);
    if (!sel) { alert('You have no ship hold to return this to.'); return; }
    const have = returnableQty(g);
    if (!(have > 0)) { alert(`Your only ${name} is open (part-used) -- use it up before returning it.`); return; }
    const keepNote = have < Number(g.qty == null ? 1 : g.qty) ? ' — the open, part-used one stays with you' : '';
    openModal(`RETURN ${name}`, `${fieldLbl('qm-hold', 'Return to')}${sel}
        ${fieldLbl('qm-qty', `Quantity (${fmt(have)} can go back${keepNote})`)}
        <input type="number" id="qm-qty" min="0" max="${have}" step="any" value="${have}" style="margin:0; text-align:center;">`, 'RETURN', async () => {
        const n = Number(byId('qm-qty').value);
        if (!(n > 0) || n > have) return `Enter a quantity between 0 and ${fmt(have)}.`;
        await window.returnGearItem(gearId, byId('qm-hold').value, n);
    });
};
window.returnGearItem = async function (gearId, vesselId, qty) {
    const prof = myProfileFor(p => (p.gear || []).some(g => g.id === gearId));
    const g = prof && prof.gear.find(x => x.id === gearId);
    const v = resolveHold(vesselId);
    const name = g && returnName(g);
    if (!g || !v || !name) throw new Error('Missing gear or hold.');
    if (!canUseHold(v)) throw new Error('You can only return to holds you own.');
    if (!isDm() && prof.id !== myId()) throw new Error('Not your gear.');
    const have = Number(g.qty == null ? 1 : g.qty);
    const n = Math.min(returnableQty(g), qty);
    if (!(n > 0)) throw new Error('Only the open, part-used kit is left -- use it up first.');
    const left = +(have - n).toFixed(4);
    const { error } = left > 0
        ? await db.from('character_gear').update({ qty: left }).eq('id', g.id)
        : await db.from('character_gear').delete().eq('id', g.id);
    if (error) throw new Error('Gear update failed: ' + error.message);
    await putInHold(v, name, n);
    await log(`📦 [QUARTERMASTER] ${charName(prof)} returned ${fmt(n)}x ${name} to ${v.name}.`);
    await refreshAll();
};

/* ---------- RELOAD (hold -> magazine) ---------- */
window.openReloadModal = function (arsenalId) {
    const prof = myProfileFor(p => (p.arsenal || []).some(w => w.id === arsenalId));
    const w = prof && prof.arsenal.find(x => x.id === arsenalId);
    if (!w || !w.ammo_item || w.max_ammo == null) return;
    const need = Math.max(0, Number(w.max_ammo) - Number(w.ammo || 0));
    if (!need) { alert(`${w.name} is already full.`); return; }
    const sel = holdSelect('qm-hold', w.ammo_item, true);
    if (!sel) { if (window.AudioEngine) window.AudioEngine.playError(); alert(`[NO SUPPLY] None of your holds has any ${w.ammo_item}.`); return; }
    openModal(`RELOAD ${w.name}`, `<p style="font-size:10px; color:#9fb4bd; margin:0;">Needs ${fmt(need)} ${esc(w.ammo_item)} to fill (${fmt(w.ammo || 0)}/${fmt(w.max_ammo)}).</p>${fieldLbl('qm-hold', 'Draw from')}${sel}`, 'RELOAD', async () => {
        await window.reloadArsenalWeapon(arsenalId, byId('qm-hold').value);
    });
};
window.reloadArsenalWeapon = async function (arsenalId, vesselId) {
    const prof = myProfileFor(p => (p.arsenal || []).some(w => w.id === arsenalId));
    const w = prof && prof.arsenal.find(x => x.id === arsenalId);
    const v = resolveHold(vesselId);
    if (!w || !v || !w.ammo_item || w.max_ammo == null) throw new Error('Missing weapon or hold.');
    if (!canUseHold(v)) throw new Error('You can only draw from holds you own.');
    if (!isDm() && prof.id !== myId()) throw new Error('Not your weapon.');
    const need = Math.max(0, Number(w.max_ammo) - Number(w.ammo || 0));
    const taken = Math.floor(await takeFromHold(v, w.ammo_item, need));
    if (!taken) throw new Error(`${v.name} has no ${w.ammo_item}.`);
    const ammo = Number(w.ammo || 0) + taken;
    const { error } = await db.from('character_arsenal').update({ ammo }).eq('id', w.id);
    if (error) { await putInHold(v, w.ammo_item, taken); throw new Error('Arsenal update failed: ' + error.message); }
    if (window.AudioEngine && window.AudioEngine.playChime) window.AudioEngine.playChime();
    await log(`🔄 [RELOAD] ${charName(prof)} reloads ${w.name} with ${fmt(taken)}x ${w.ammo_item} from ${v.name} (${fmt(ammo)}/${fmt(w.max_ammo)}).`);
    await refreshAll();
};

/* ---------- USE (gear) ---------- */
// Pure step (exported for tests): what a USE does to {qty, uses_left}.
window.quartermasterUseStep = function (row, def) {
    let qty = Number(row.qty == null ? 1 : row.qty);
    let uses = row.uses_left;
    if (def && def.max_uses) {
        uses = (uses == null ? def.max_uses : Number(uses)) - 1;
        if (uses <= 0) { qty = +(qty - 1).toFixed(4); uses = qty > 0 ? def.max_uses : 0; }
    } else {
        qty = +(qty - 1).toFixed(4);
        uses = null;
    }
    return { qty: Math.max(0, qty), uses_left: uses, gone: qty <= 0 };
};
window.useGearItem = async function (gearId) {
    const prof = myProfileFor(p => (p.gear || []).some(g => g.id === gearId));
    const g = prof && prof.gear.find(x => x.id === gearId);
    const def = g && gearDef(g.gear_definition_id);
    if (!g || !def || !(def.consumable || def.max_uses)) return;
    if (!isDm() && prof.id !== myId()) return;
    const next = window.quartermasterUseStep(g, def);
    const { error } = next.gone
        ? await db.from('character_gear').delete().eq('id', g.id)
        : await db.from('character_gear').update({ qty: next.qty, uses_left: next.uses_left }).eq('id', g.id);
    if (error) { alert('Could not use item: ' + error.message); return; }
    const left = next.gone ? 'none left' : (def.max_uses ? `${fmt(next.qty)} left, ${next.uses_left} use(s) in the open one` : `${fmt(next.qty)} left`);
    await log(`🩹 [USE] ${charName(prof)} used ${def.max_uses ? 'a charge of ' : ''}${def.name} (${left}).`);
    await refreshAll();
};

/* ---------- row buttons ---------- */
const btn = (label, onclick, title, color) => `<button type="button" class="qm-btn" onclick="${onclick}" title="${esc(title)}" style="width:auto; margin:0; padding:2px 6px; font-size:9px;${color ? ` border-color:${color}; color:${color};` : ''}">${label}</button>`;
function decorateCargo() {
    document.querySelectorAll('#terminal-cargo-items-container .qm-btn').forEach(b => b.remove());
    if (!window.quartermasterOn()) return;
    const sel = byId('cargo-vessel-select');
    const v = sel && ships().find(s => s.id === sel.value);
    if (!v || !canUseHold(v)) return;
    document.querySelectorAll('#terminal-cargo-items-container .cargo-row').forEach(row => {
        const c = catByName(row.dataset.cargoName);
        if (!c || !c.issue_kind) return;
        const box = row.lastElementChild;
        if (box) box.insertAdjacentHTML('afterbegin', btn('ISSUE', `window.openIssueModal('${v.id}', this.closest('.cargo-row').dataset.cargoName)`, `Issue to a character's ${c.issue_kind === 'weapon' ? 'Arsenal' : 'Gear'}`, '#c9962f'));
    });
}
function decorateArsenal() {
    document.querySelectorAll('#arsenal-list-container .qm-btn').forEach(b => b.remove());
    if (!window.quartermasterOn()) return;
    const prof = profiles().find(p => p.id === myId());
    if (!prof) return;
    document.querySelectorAll('#arsenal-list-container [data-arsenal-id]').forEach(row => {
        const w = (prof.arsenal || []).find(x => x.id === row.dataset.arsenalId);
        const box = row.lastElementChild;
        if (!w || !box) return;
        let html = '';
        if (w.ammo_item && w.max_ammo != null) html += btn('RELOAD', `window.openReloadModal('${w.id}')`, `Refill from ${w.ammo_item} in a hold you own`, '#00e5a3');
        if (returnName(w)) html += btn('RETURN', `window.openReturnArsenalModal('${w.id}')`, 'Put back in a ship hold', '#9fb4bd');
        if (html) box.insertAdjacentHTML('afterbegin', html);
    });
}
function decorateGear() {
    document.querySelectorAll('#gear-loadout-container .qm-btn, #gear-loadout-container .qm-uses').forEach(b => b.remove());
    if (!window.quartermasterOn()) return;
    const prof = profiles().find(p => p.id === myId());
    if (!prof) return;
    document.querySelectorAll('#gear-loadout-container .gear-row[data-gear-id]').forEach(row => {
        const g = (prof.gear || []).find(x => x.id === row.dataset.gearId);
        const box = row.lastElementChild;
        if (!g || !box) return;
        const def = gearDef(g.gear_definition_id);
        let html = '';
        if (def && (def.consumable || def.max_uses)) html += btn('USE', `window.useGearItem('${g.id}')`, def.max_uses ? 'Spend one charge' : 'Use one up', '#00e5a3');
        if (returnName(g)) html += btn('RETURN', `window.openReturnGearModal('${g.id}')`, 'Put back in a ship hold', '#9fb4bd');
        if (html) box.insertAdjacentHTML('afterbegin', html);
        if (def && def.max_uses) {
            const uses = g.uses_left == null ? def.max_uses : g.uses_left;
            const name = row.firstElementChild;
            if (name) name.insertAdjacentHTML('beforeend', `<div class="qm-uses" style="font-size:9px; color:#9fe9f5;">${uses}/${def.max_uses} uses left in the open one</div>`);
        }
    });
}
function decorateColonies() {
    document.querySelectorAll('.colony-cargo-row .qm-btn').forEach(b => b.remove());
    if (!window.quartermasterOn()) return;
    document.querySelectorAll('.colony-cargo-row[data-colony-id]').forEach(row => {
        const col = resolveHold('colony:' + row.dataset.colonyId);
        const c = catByName(row.dataset.cargoName);
        if (!col || !canUseHold(col) || !c || !c.issue_kind) return;
        row.lastElementChild.insertAdjacentHTML('beforebegin', btn('ISSUE', `window.openIssueModal('colony:${col.id}', this.closest('.colony-cargo-row').dataset.cargoName)`, `Issue to a character's ${c.issue_kind === 'weapon' ? 'Arsenal' : 'Gear'}`, '#c9962f'));
    });
}
window.refreshQuartermasterButtons = function () { decorateCargo(); decorateArsenal(); decorateGear(); decorateColonies(); };
window.onHook('colonies-rendered', 'quartermaster', decorateColonies);
window.onHook('cargo-deck-rendered', 'quartermaster', decorateCargo);
window.onHook('arsenal-rendered', 'quartermaster', decorateArsenal);
window.onHook('gear-rendered', 'quartermaster', decorateGear);
document.addEventListener('darkforest:features-changed', () => {
    if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
    if (typeof window.renderArsenal === 'function') window.renderArsenal();
    if (typeof window.renderGearLoadout === 'function') window.renderGearLoadout();
    decorateColonies();
});

/* ---------- DM: how a catalogue item is issued ---------- */
window.openCatalogItemEditor = function (catalogId) {
    if (!isDm()) return;
    const c = catById(catalogId);
    if (!c) return;
    const ws = c.weapon_stats || {};
    const defs = (typeof window.getApprovedGear === 'function' ? window.getApprovedGear() : []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const d = gearDef(c.gear_definition_id);
    const dmg = typeof window.buildDamageTypeOptionsHtml === 'function' ? window.buildDamageTypeOptionsHtml(ws.damage_type || '') : '';
    const inp = (id, label, val, extra) => `<div style="flex:1;">${fieldLbl(id, label)}<input type="text" id="${id}" value="${esc(val == null ? '' : val)}" ${extra || ''} style="margin:0; text-align:center;"></div>`;
    openModal(`ISSUE SETTINGS · ${c.name}`, `
        <p style="font-size:10px; color:#6b826a; margin:0;">How this hold item goes onto a character sheet. Players see ISSUE on it once the Quartermaster switch is on.</p>
        ${fieldLbl('qm-kind', 'Issued as')}
        <select id="qm-kind" style="margin:0;" onchange="document.getElementById('qm-w').style.display=this.value==='weapon'?'':'none'; document.getElementById('qm-g').style.display=this.value==='gear'?'':'none';">
            <option value="">Not issuable (stays cargo)</option>
            <option value="weapon"${c.issue_kind === 'weapon' ? ' selected' : ''}>Weapon → Arsenal</option>
            <option value="gear"${c.issue_kind === 'gear' ? ' selected' : ''}>Gear → Gear loadout</option>
        </select>
        <div id="qm-w" style="${c.issue_kind === 'weapon' ? '' : 'display:none;'}">
            <div style="display:flex; gap:6px;">${inp('qm-dice', 'Dice', ws.dice || '1d6')}${inp('qm-mod', 'Mod', ws.modifier || '+0')}</div>
            ${fieldLbl('qm-dmg', 'Damage type')}<select id="qm-dmg" style="margin:0;"><option value="">None</option>${dmg}</select>
            <div style="display:flex; gap:6px;">${inp('qm-mag', 'Magazine (blank = no ammo)', ws.max_ammo, 'inputmode="numeric"')}${inp('qm-ammo', 'Reloads from (blank = itself)', ws.ammo_item, 'list="cargo-catalog-names"')}</div>
            <div style="display:flex; gap:6px;">${inp('qm-rs', 'Short range (sq)', ws.range_short, 'inputmode="numeric"')}${inp('qm-rl', 'Long range (sq)', ws.range_long, 'inputmode="numeric"')}</div>
            <label for="qm-exp" style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; margin-top:6px;"><input type="checkbox" id="qm-exp" style="margin:0;"${ws.explodes ? ' checked' : ''}> Exploding dice</label>
        </div>
        <div id="qm-g" style="${c.issue_kind === 'gear' ? '' : 'display:none;'}">
            ${fieldLbl('qm-def', 'Gear entry')}
            <select id="qm-def" style="margin:0;"><option value="">Create "${esc(c.name)}" on first issue (flavour only)</option>${defs.map(g => `<option value="${g.id}"${g.id === c.gear_definition_id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
            <div style="display:flex; gap:8px; align-items:flex-end;">
                <label for="qm-cons" style="font-size:10px; color:#d4c5a9; display:flex; align-items:center; gap:4px; margin-top:6px; flex:1;"><input type="checkbox" id="qm-cons" style="margin:0;"${d && d.consumable ? ' checked' : ''}> Consumable (USE spends one)</label>
                ${inp('qm-uses', 'Uses per item', d && d.max_uses, 'inputmode="numeric" placeholder="—"')}
            </div>
            <p style="font-size:9px; color:#6b826a; margin:4px 0 0 0;">Consumable and uses are saved on the gear entry, so they apply to everyone carrying it.</p>
        </div>`, 'SAVE', async () => {
        const kind = byId('qm-kind').value || null;
        const numOrNull = (id) => { const s = byId(id).value.trim(); if (s === '') return null; const n = parseInt(s, 10); return n >= 0 ? n : null; };
        const upd = { issue_kind: kind, weapon_stats: c.weapon_stats || null, gear_definition_id: c.gear_definition_id || null };
        if (kind === 'weapon') {
            let mod = byId('qm-mod').value.trim() || '+0';
            if (!/^[+-]/.test(mod)) mod = '+' + mod;
            const ammoTyped = byId('qm-ammo').value.trim();
            upd.weapon_stats = {
                dice: byId('qm-dice').value.trim().toLowerCase() || '1d6', modifier: mod,
                damage_type: byId('qm-dmg').value || null, explodes: byId('qm-exp').checked,
                max_ammo: numOrNull('qm-mag'),
                ammo_item: ammoTyped ? window.snapToCatalogName(ammoTyped) : null,
                range_short: numOrNull('qm-rs'), range_long: numOrNull('qm-rl')
            };
        } else if (kind === 'gear') {
            upd.gear_definition_id = byId('qm-def').value || null;
            const uses = numOrNull('qm-uses');
            if (upd.gear_definition_id) {
                const { error } = await db.from('gear_definitions').update({ consumable: byId('qm-cons').checked, max_uses: uses > 0 ? uses : null }).eq('id', upd.gear_definition_id);
                if (error) return 'Gear entry update failed: ' + error.message;
            } else if (byId('qm-cons').checked || uses) {
                const { data, error } = await db.from('gear_definitions').insert({ name: c.name, description: c.notes || '', status: 'approved', flavor_only: true, created_by: myId(), consumable: byId('qm-cons').checked, max_uses: uses > 0 ? uses : null }).select().single();
                if (error) return 'Could not create the gear entry: ' + error.message;
                upd.gear_definition_id = data.id;
            }
        }
        const { error } = await db.from('cargo_item_catalog').update(upd).eq('id', c.id);
        if (error) return 'Save failed: ' + error.message;
        if (typeof loadGearDefinitions === 'function') await loadGearDefinitions();
        if (typeof window.loadCargoItemCatalog === 'function') await window.loadCargoItemCatalog();
        if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
    });
};
})();
