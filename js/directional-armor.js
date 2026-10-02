/* ==========================================================================
   js/directional-armor.js - Per-side Hardened armor
   (Command Terminal refactor, Phase 5, 2026-10-02)
   ==========================================================================
   DM-confirmed rules (roadmap §4c, 2026-10-02):
   1. Only HARDENED armor splits into Front / Starboard / Rear / Port.
      Shields stay one ship-wide bubble, Reactive/Ablative charges stay
      ship-wide, hull is shared.
   2. Four 90° quarters: front = within 45° of the nose, rear = within 45°
      of the tail (a hit exactly on a boundary counts as front/rear), the
      flanks are the rest.
   3. Existing ships: the Hardened value is SPLIT with a preference for the
      flanks -- front 10%, rear 10%, starboard 40%, port 40% (100 -> 10/40/
      10/40). Editable per side afterwards (EDIT BASE STATS / template
      editors).
   4. Ordnance hits the side facing where the salvo was LAUNCHED from;
      AOE splash hits the side facing the blast centre.
   5. Squadron attacks: side facing the squadron's token.
   6. No top/bottom (altitude is visual only).
   7. A stripped side lets hits from that side straight through to hull,
      no extra penalty (Cold's brittle bonus counts that side).
   8. DM manual damage: a side picker (Auto from the firing ship's position
      when both are on the grid, else Front).
   9. Strike craft keep one pool; stations get sides.

   Storage: ship_markers.armor_sides / max_armor_sides (jsonb
   {front, starboard, rear, port}); ship_templates.max_armor_sides. null =
   derived from the ship-wide value with the 10/40/10/40 split. The
   ship-wide integrity_hardened / max_hardened always hold the SUM of the
   sides, so everything that doesn't know about sides (switch off, backups,
   older pages) keeps seeing a consistent total. If the stored sides no
   longer add up to integrity_hardened (it changed while the switch was off
   somewhere), they're re-spread in proportion to the max sides.

   Feature switch 'directional_armor' (seeded DM ONLY). While it is off for
   a browser, that browser resolves damage exactly as before. */

const ARMOR_SIDES = ['front', 'starboard', 'rear', 'port'];
const ARMOR_SIDE_LABEL = { front: 'Front', starboard: 'Starboard', rear: 'Rear', port: 'Port' };
const ARMOR_SIDE_SHORT = { front: 'F', starboard: 'S', rear: 'R', port: 'P' };
window.ARMOR_SIDES = ARMOR_SIDES;
window.ARMOR_SIDE_LABEL = ARMOR_SIDE_LABEL;

function dirArmorOn() { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('directional_armor'); }
window.directionalArmorOn = dirArmorOn;
function vesselUsesSides(v) { return !!(v && !v.is_strike_craft && dirArmorOn()); }
window.vesselUsesArmorSides = vesselUsesSides;

// 10 / 40 / 10 / 40 (front / starboard / rear / port). Rounding leftovers go
// to the flanks, starboard first.
window.splitHardenedToSides = function(total) {
    total = Math.max(0, Math.round(Number(total) || 0));
    const front = Math.floor(total * 0.1), rear = Math.floor(total * 0.1);
    const rest = total - front - rear;
    const port = Math.floor(rest / 2);
    return { front, starboard: rest - port, rear, port };
};
function validSides(o) { return o && typeof o === 'object' && ARMOR_SIDES.every(k => Number.isFinite(Number(o[k]))); }
function cleanSides(o) { const r = {}; ARMOR_SIDES.forEach(k => { r[k] = Math.max(0, Math.round(Number(o[k]) || 0)); }); return r; }
function sumSides(o) { return ARMOR_SIDES.reduce((t, k) => t + (Number(o[k]) || 0), 0); }
window.sumArmorSides = sumSides;

// { cur, max } for a vessel (or template: only max is meaningful).
window.getArmorSides = function(v) {
    const max = validSides(v.max_armor_sides) ? cleanSides(v.max_armor_sides) : window.splitHardenedToSides(v.max_hardened || 0);
    const total = v.integrity_hardened !== undefined && v.integrity_hardened !== null ? Math.max(0, Math.round(v.integrity_hardened)) : sumSides(max);
    let cur;
    if (validSides(v.armor_sides) && sumSides(cleanSides(v.armor_sides)) === total) {
        cur = cleanSides(v.armor_sides);
    } else if (sumSides(max) > 0) {
        // Re-spread the ship-wide value in proportion to the max sides.
        const maxTotal = sumSides(max);
        cur = {};
        let given = 0;
        ARMOR_SIDES.forEach(k => { cur[k] = Math.min(max[k], Math.floor(total * max[k] / maxTotal)); given += cur[k]; });
        // hand out the rounding remainder, flanks first
        for (const k of ['starboard', 'port', 'front', 'rear']) { while (given < total && cur[k] < max[k]) { cur[k]++; given++; } }
    } else {
        cur = window.splitHardenedToSides(total);
    }
    ARMOR_SIDES.forEach(k => { if (cur[k] > max[k]) cur[k] = max[k]; });
    return { cur, max };
};

/* --- Which side was hit --- */
function tokenCenterFor(vesselId) {
    const toks = (window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || [];
    const t = toks.find(x => x.ship_marker_id === vesselId);
    if (!t) return null;
    return typeof window.battleTokenCenter === 'function' ? window.battleTokenCenter(t) : { x: t.x + 17, y: t.y + 17 };
}
// Relative bearing (0 = dead ahead, clockwise) -> side. Boundaries inclusive
// toward front/rear.
window.armorSideForRelBearing = function(rel) {
    rel = ((Math.round(rel) % 360) + 360) % 360;
    if (rel >= 315 || rel <= 45) return 'front';
    if (rel >= 135 && rel <= 225) return 'rear';
    return rel < 180 ? 'starboard' : 'port';
};
// Side of targetVesselId facing the given grid point. Front when unknown.
window.armorSideFacingPoint = function(targetVesselId, point) {
    const toks = (window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || [];
    const tt = toks.find(x => x.ship_marker_id === targetVesselId);
    const c = tokenCenterFor(targetVesselId);
    if (!tt || !c || !point || (Math.abs(point.x - c.x) < 0.5 && Math.abs(point.y - c.y) < 0.5)) return 'front';
    const bearing = window.compassBearing ? window.compassBearing(c, point) : ((Math.atan2(point.x - c.x, -(point.y - c.y)) * 180 / Math.PI) + 360) % 360;
    return window.armorSideForRelBearing(bearing - (tt.facing || 0));
};
// The opts object every damage caller passes to resolveShipDamage.
// source: { vesselId } | { point }. Returns {} when sides don't apply.
window.damageSideOpts = function(targetVessel, source) {
    if (!vesselUsesSides(targetVessel) || !source) return {};
    if (source.side && ARMOR_SIDES.includes(source.side)) return { side: source.side };
    let point = source.point || null;
    if (!point && source.vesselId) point = tokenCenterFor(source.vesselId);
    return { side: point ? window.armorSideFacingPoint(targetVessel.id, point) : 'front' };
};
// Launch point snapshotted onto an ordnance salvo (Q4).
window.ordnanceLaunchPoint = function(vesselId) { return tokenCenterFor(vesselId); };

// Used inside resolveShipDamage (js/combat.js): the side pool to use, or null.
window.armorSidesFor = function(targetShip, side) {
    if (!side || !ARMOR_SIDES.includes(side) || !vesselUsesSides(targetShip)) return null;
    const s = window.getArmorSides(targetShip);
    return { side, label: ARMOR_SIDE_LABEL[side], value: s.cur[side], cur: s.cur, max: s.max };
};
// Fields a damage caller writes back (spread into its update/assign).
window.armorSideResultFields = function(result) {
    return (result && result.armor_sides) ? { armor_sides: result.armor_sides } : {};
};

/* --- Health bars: four side bars in place of the single Hardened bar --- */
window.renderArmorSideBarsHtml = function(vessel, editable) {
    if (!vesselUsesSides(vessel)) return null;
    const { cur, max } = window.getArmorSides(vessel);
    // Compact rows (cards can be ~240px wide): label · [-] bar [+] · value.
    // Shift-click a button for ±10.
    const rows = ARMOR_SIDES.map(k => {
        const pct = max[k] > 0 ? Math.max(0, Math.min(100, cur[k] / max[k] * 100)) : 0;
        const btn = (d, t) => `<button onclick="window.modifyArmorSide('${vessel.id}', '${k}', event.shiftKey ? ${d * 10} : ${d})" title="${d < 0 ? 'Damage' : 'Repair'} ${ARMOR_SIDE_LABEL[k]} armor by 1 (Shift-click: 10)" style="width:20px; min-width:20px; padding:0; font-size:10px; line-height:14px; margin:0; background:${d < 0 ? '#3d0c0c' : '#0c3d1c'}; border-color:${d < 0 ? '#ff3333' : '#00e5a3'}; color:${d < 0 ? '#ffaaaa' : '#aaffcc'};">${t}</button>`;
        return `<div style="display:flex; align-items:center; gap:4px; margin-bottom:3px;">
            <span style="width:56px; flex-shrink:0; font-size:9px; color:#c9962f;">${ARMOR_SIDE_LABEL[k]}</span>
            ${editable ? btn(-1, '−') : ''}
            <div style="flex:1 1 auto; min-width:30px; height:8px; background:#030403; border:1px solid #3c4e36; border-radius:2px; overflow:hidden;"><div style="width:${pct}%; height:100%; background:${cur[k] === 0 ? '#ff3333' : '#c9962f'};"></div></div>
            ${editable ? btn(1, '+') : ''}
            <span style="width:58px; flex-shrink:0; text-align:right; font-size:9px; color:${cur[k] === 0 ? '#ff3333' : '#c9962f'};">${cur[k]} / ${max[k]}</span>
        </div>`;
    }).join('');
    return `<div style="margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; font-size:10px; color:#c9962f; margin-bottom:3px;"><strong>HARDENED ARMOR (BY SIDE)</strong><span>${sumSides(cur)} / ${sumSides(max)}</span></div>
        ${rows}</div>`;
};
window.modifyArmorSide = async function(vesselId, side, delta) {
    const v = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!v || !ARMOR_SIDES.includes(side)) return;
    const { cur, max } = window.getArmorSides(v);
    cur[side] = Math.max(0, Math.min(max[side], cur[side] + delta));
    const payload = { armor_sides: cur, max_armor_sides: max, integrity_hardened: sumSides(cur) };
    const { error } = await db.from('ship_markers').update(payload).eq('id', vesselId);
    if (error) { alert('Failed to update armor: ' + error.message); return; }
    Object.assign(v, payload);
    if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
};
// Full repair / reset: every side back to its max.
window.fullArmorSidesPayload = function(v) {
    if (!validSides(v.max_armor_sides) && !validSides(v.armor_sides) && !dirArmorOn()) return {};
    const { max } = window.getArmorSides(v);
    return { armor_sides: { ...max }, max_armor_sides: { ...max }, integrity_hardened: sumSides(max) };
};

/* --- Editors: four per-side max inputs (EDIT BASE STATS, template editors) ---
   Inserted after the row holding the Hardened input; the Hardened input
   itself becomes read-only (it shows the sum). */
window.ensureArmorSideInputs = function(hardenedInputId, prefix, maxSides, enabled) {
    const hdInput = document.getElementById(hardenedInputId);
    const wrapId = prefix + '-armor-sides';
    let wrap = document.getElementById(wrapId);
    if (!dirArmorOn() || !hdInput || enabled === false) {
        if (wrap) wrap.remove();
        if (hdInput) { hdInput.readOnly = false; hdInput.title = ''; }
        return false;
    }
    const sides = validSides(maxSides) ? cleanSides(maxSides) : window.splitHardenedToSides(hdInput.value);
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = wrapId;
        wrap.className = 'armor-side-inputs';
        wrap.style.cssText = 'margin:4px 0 6px 0; padding:4px; border:1px dashed #c9962f;';
        wrap.innerHTML = `<div style="font-size:9px; color:#c9962f; margin-bottom:2px;" title="Directional armor: each side has its own Hardened pool. Hits are taken by the side facing the attacker.">Hardened armor by side (Hardened = the total)</div>
            <div style="display:flex; gap:4px;">${ARMOR_SIDES.map(k => `<div style="flex:1;"><label for="${prefix}-side-${k}" style="font-size:8px; color:#6b826a;">${ARMOR_SIDE_LABEL[k]}</label><input type="number" min="0" id="${prefix}-side-${k}" style="border-color:#c9962f; text-align:center; margin:0;"></div>`).join('')}</div>`;
        let row = hdInput.parentNode;
        // climb to the flex row that holds the Hardened field, insert after it
        while (row && row.parentNode && getComputedStyle(row).display !== 'flex' && row !== document.body) row = row.parentNode;
        (row && row !== document.body ? row : hdInput).insertAdjacentElement('afterend', wrap);
        wrap.addEventListener('input', () => { const s = window.readArmorSideInputs(prefix); if (s) hdInput.value = sumSides(s); });
    }
    ARMOR_SIDES.forEach(k => { const el = document.getElementById(`${prefix}-side-${k}`); if (el) el.value = sides[k]; });
    hdInput.value = sumSides(sides);
    hdInput.readOnly = true;
    hdInput.title = 'Directional armor is on — set the four sides below; this is their total.';
    return true;
};
// undefined = no side inputs on screen (leave sides alone).
window.readArmorSideInputs = function(prefix) {
    if (!document.getElementById(prefix + '-armor-sides')) return undefined;
    const r = {};
    ARMOR_SIDES.forEach(k => { const el = document.getElementById(`${prefix}-side-${k}`); r[k] = Math.max(0, parseInt(el && el.value, 10) || 0); });
    return r;
};

/* --- DM manual damage: side picker --- */
window.ensureManualDamageSidePicker = function() {
    const anchor = document.getElementById('dm-manualdmg-target');
    let wrap = document.getElementById('dm-manualdmg-side-wrap');
    if (!dirArmorOn()) { if (wrap) wrap.remove(); return; }
    if (!anchor || wrap) return;
    wrap = document.createElement('div');
    wrap.id = 'dm-manualdmg-side-wrap';
    wrap.innerHTML = `<label for="dm-manualdmg-side" style="font-size: 10px; color: #c9962f; margin-top:6px; display:block;">Armor side hit:</label>
        <select id="dm-manualdmg-side" style="width:100%; font-size:11px; margin:2px 0;">
            <option value="auto">Auto — side facing the firing ship (Front if either isn't on the grid)</option>
            ${ARMOR_SIDES.map(k => `<option value="${k}">${ARMOR_SIDE_LABEL[k]}</option>`).join('')}
        </select>`;
    anchor.insertAdjacentElement('afterend', wrap);
};
window.manualDamageSideSource = function(firerId) {
    const sel = document.getElementById('dm-manualdmg-side');
    const v = sel ? sel.value : 'auto';
    if (v && v !== 'auto') return { side: v };
    return firerId ? { vesselId: firerId } : { side: 'front' };
};

document.addEventListener('darkforest:features-changed', () => {
    window.ensureManualDamageSidePicker();
    if (typeof window.renderVesselDeck === 'function') { try { window.renderVesselDeck(); } catch (e) {} }
});
