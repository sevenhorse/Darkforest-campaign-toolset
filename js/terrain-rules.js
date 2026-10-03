/* ==========================================================================
   js/terrain-rules.js - Space terrain rules (Phase 10, 2026-10-03)
   ==========================================================================
   DM decisions (2026-10-03 design session; numbers are a starting point to
   tune after play):
   - ASTEROID FIELD: moving inside costs x2; a ship inside takes 25% less
     DIRECT-FIRE damage (ship weapons + squadron guns; ordnance unaffected).
   - NEBULA (sensor shroud): a ship inside can only be targeted from SHORT
     range (100) or closer -- guns AND missile/torpedo launches. Its own
     weapons work normally.
   - DEBRIS / WRECKAGE: a move that passes through it rolls 1d6 hull damage
     per 50 px travelled inside (rounded up; grazes under 5 px ignored),
     straight to hull, posted to chat, applied automatically (UNDO undoes it
     with the move). Strike craft too.
   - PLANET / MOON and STATION / STRUCTURE: block line of fire (direct fire
     and launches) and movement -- a move stops where it would enter one.
     A body that already contains the firer, the target or the mover's
     start point is ignored for that check (e.g. a station token parked on
     a drawn station).
   - Per-battle toggle: battle_encounters.map.rules (no new column). Default
     ON at START BATTLE / preset launch when the map has terrain; the DM can
     flip it mid-battle from the header chip. Every client enforces the same
     thing because it's stored on the battle.
   - Applies to players and AI-controlled ships. DM drag-repositioning
     ignores terrain (no cost, no debris); DM-fired weapons still need line
     of fire and respect the nebula.
   - Numbers live in app_settings 'terrain_rules_config' (JSON in `value`),
     edited from the TERRAIN RULES panel (DM). Feature switch 'terrain_rules'
     (DM only) hides the DM tools until the DM is ready; enforcement depends
     only on the battle's own toggle.
   Not covered (deliberately, flagged): ordnance already in flight isn't
   re-checked against planets/nebulae; point defense and squadron intercepts
   ignore terrain; the 2D drag preview doesn't draw the path, it just stops
   at the allowed point. */
(function () {
const DEFAULTS = {
    asteroid_move_mult: 2,
    asteroid_cover_pct: 25,
    nebula_lock_range: 100,
    debris_dice: '1d6',
    debris_per_px: 50,
    rules: { asteroid: true, nebula: true, debris: true, planet: true, station: true }
};
window.TERRAIN_RULE_DEFAULTS = DEFAULTS;
const SOLID = { planet: true, station: true };
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
const esc = (v) => window.escapeHtml(v == null ? '' : String(v));

/* --- Config --- */
function num(v, d, lo, hi) { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; }
window.terrainRulesConfig = function () {
    const row = window.appSettingsCache && window.appSettingsCache.terrain_rules_config;
    let raw = {};
    try { raw = row && row.value ? JSON.parse(row.value) : {}; } catch (e) { raw = {}; }
    const rules = Object.assign({}, DEFAULTS.rules, raw.rules || {});
    const dice = /^\d{0,2}d\d{1,3}([+-]\d{1,3})?$/i.test(String(raw.debris_dice || '').trim()) ? String(raw.debris_dice).trim().toLowerCase() : DEFAULTS.debris_dice;
    return {
        asteroid_move_mult: num(raw.asteroid_move_mult, DEFAULTS.asteroid_move_mult, 1, 10),
        asteroid_cover_pct: num(raw.asteroid_cover_pct, DEFAULTS.asteroid_cover_pct, 0, 90),
        nebula_lock_range: num(raw.nebula_lock_range, DEFAULTS.nebula_lock_range, 0, 2000),
        debris_dice: dice,
        debris_per_px: num(raw.debris_per_px, DEFAULTS.debris_per_px, 5, 1000),
        rules
    };
};
window.terrainRulesAllowed = function () { return isDm() && typeof window.isFeatureOn === 'function' && window.isFeatureOn('terrain_rules'); };

/* --- Is anything on? --- */
function enc() { return window.globalBattleEncounterCache || null; }
function terrainOf(e) {
    const m = e && e.map;
    if (!m || !m.rules || typeof window.sanitizeBattleTerrain !== 'function') return [];
    return window.sanitizeBattleTerrain(m.terrain);
}
window.terrainRulesActive = function (e) { return terrainOf(e || enc()).length > 0; };
function activeList(kind) {
    const cfg = window.terrainRulesConfig();
    return terrainOf(enc()).filter(t => cfg.rules[t.kind] !== false && (!kind || (Array.isArray(kind) ? kind.includes(t.kind) : t.kind === kind)));
}

/* --- Geometry (grid px) --- */
const inside = (t, x, y) => typeof window.battleTerrainContains === 'function' && !!t && !!t.shape && window.battleTerrainContains(t.shape, x, y);
// Length of the segment a->b that lies inside terrain piece t (sampled every ~2 px).
function insideLen(t, a, b) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.01) return 0;
    const n = Math.max(1, Math.ceil(len / 2));
    let hits = 0;
    for (let i = 0; i < n; i++) {
        const k = (i + 0.5) / n;
        if (inside(t, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k)) hits++;
    }
    return len * hits / n;
}
window.terrainInsideLength = insideLen;
function segCircleHit(a, b, c, r) {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    let k = L2 ? ((c.x - a.x) * dx + (c.y - a.y) * dy) / L2 : 0;
    k = Math.max(0, Math.min(1, k));
    return Math.hypot(a.x + dx * k - c.x, a.y + dy * k - c.y) < r;
}
window.terrainAt = function (x, y) { return activeList().filter(t => inside(t, x, y)); };
function sizeOf(v) { return v && v.is_strike_craft ? (typeof BATTLE_STRIKE_CRAFT_TOKEN_SIZE !== 'undefined' ? BATTLE_STRIKE_CRAFT_TOKEN_SIZE : 24) : (typeof BATTLE_TOKEN_SIZE !== 'undefined' ? BATTLE_TOKEN_SIZE : 34); }
function centerOfVessel(vesselId) {
    const t = ((enc() && enc().tokens) || []).find(x => x.ship_marker_id === vesselId);
    if (!t) return null;
    return typeof window.battleTokenCenter === 'function' ? window.battleTokenCenter(t) : { x: t.x + 17, y: t.y + 17 };
}

/* --- Fire: line of fire (planets / stations) + nebula shroud --- */
// Returns '' when the shot is allowed, else the reason (shown to the player).
window.terrainFireCheck = function (firerId, targetId) {
    if (!window.terrainRulesActive() || !firerId || !targetId) return '';
    const a = centerOfVessel(firerId), b = centerOfVessel(targetId);
    if (!a || !b) return '';
    const cfg = window.terrainRulesConfig();
    for (const t of activeList(['planet', 'station'])) {
        if (t.shape.type !== 'circle') continue;
        if (inside(t, a.x, a.y) || inside(t, b.x, b.y)) continue;
        if (segCircleHit(a, b, { x: t.shape.x, y: t.shape.y }, t.shape.r)) return `line of fire blocked by ${t.label || (t.kind === 'planet' ? 'a planet' : 'a station')}`;
    }
    const neb = activeList('nebula').find(t => inside(t, b.x, b.y));
    if (neb && Math.hypot(b.x - a.x, b.y - a.y) > cfg.nebula_lock_range) return `hidden in ${neb.label || 'a nebula'} — close to ${cfg.nebula_lock_range} px to lock on`;
    return '';
};
// Direct-fire damage multiplier for a target sitting in an asteroid field.
window.terrainCover = function (targetId) {
    if (!window.terrainRulesActive() || !targetId) return null;
    const b = centerOfVessel(targetId); if (!b) return null;
    const field = activeList('asteroid').find(t => inside(t, b.x, b.y));
    if (!field) return null;
    const pct = window.terrainRulesConfig().asteroid_cover_pct;
    if (!pct) return null;
    return { mult: 1 - pct / 100, label: `[${field.label || 'Asteroid'} cover: -${pct}% Dmg] ` };
};

/* --- Movement --- */
// Walks a straight move from top-left `from` toward top-left `to` and
// returns how far the ship actually gets: { pos, cost, debrisLen, stopped }.
// cost = distance with asteroid stretches multiplied; the walk stops when
// the budget runs out or when it would enter a planet / station.
window.terrainWalk = function (vessel, from, to, budget) {
    const size = sizeOf(vessel), h = size / 2;
    const a = { x: from.x + h, y: from.y + h }, b = { x: to.x + h, y: to.y + h };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const out = { pos: { x: from.x, y: from.y }, cost: 0, debrisLen: 0, stopped: '' };
    if (len < 0.01) return out;
    const cfg = window.terrainRulesConfig();
    const ast = activeList('asteroid'), deb = activeList('debris');
    const solids = activeList(['planet', 'station']).filter(t => !inside(t, a.x, a.y));
    const step = 2, n = Math.max(1, Math.ceil(len / step)), seg = len / n;
    let cost = 0, debris = 0, kOk = 0;
    for (let i = 1; i <= n; i++) {
        const k = i / n, km = (i - 0.5) / n;
        const px = a.x + (b.x - a.x) * k, py = a.y + (b.y - a.y) * k;
        const mx = a.x + (b.x - a.x) * km, my = a.y + (b.y - a.y) * km;
        const solid = solids.find(t => inside(t, px, py));
        if (solid) { out.stopped = solid.label || (solid.kind === 'planet' ? 'a planet' : 'a station'); break; }
        const c = seg * (ast.some(t => inside(t, mx, my)) ? cfg.asteroid_move_mult : 1);
        if (budget != null && cost + c > budget + 1e-6) { out.stopped = out.stopped || 'movement'; break; }
        cost += c;
        if (deb.some(t => inside(t, mx, my))) debris += seg;
        kOk = k;
    }
    out.pos = { x: from.x + (to.x - from.x) * kOk, y: from.y + (to.y - from.y) * kOk };
    out.cost = Math.round(cost * 10) / 10;
    out.debrisLen = debris;
    return out;
};

/* --- Debris damage --- */
function rollDice(expr) {
    const m = String(expr).match(/^(\d*)d(\d+)([+-]\d+)?$/i);
    if (!m) return { total: 0, rolls: [] };
    const n = parseInt(m[1] || '1', 10), f = parseInt(m[2], 10), mod = parseInt(m[3] || '0', 10);
    const rolls = []; for (let i = 0; i < n; i++) rolls.push(Math.floor(Math.random() * f) + 1);
    return { total: Math.max(0, rolls.reduce((s, r) => s + r, 0) + mod), rolls };
}
window.terrainDebrisRoll = function (debrisLen) {
    if (!debrisLen || debrisLen < 5) return null;
    const cfg = window.terrainRulesConfig();
    const times = Math.ceil(debrisLen / cfg.debris_per_px);
    let total = 0; const parts = [];
    for (let i = 0; i < times; i++) { const r = rollDice(cfg.debris_dice); total += r.total; parts.push(r.rolls.join('+')); }
    return { total, times, dice: cfg.debris_dice, text: `${times}× ${cfg.debris_dice} [${parts.join(', ')}] = ${total}` };
};
// Rolls and applies debris damage for one ship (players / AI). Returns the roll.
window.terrainApplyDebris = async function (vessel, debrisLen) {
    if (!vessel || !window.terrainRulesActive()) return null;
    const roll = window.terrainDebrisRoll(debrisLen);
    if (!roll || !roll.total) return roll;
    if (typeof window.applyTerrainHullDamage === 'function') await window.applyTerrainHullDamage(vessel, roll.total);
    try { await db.from('chat_logs').insert({ sender_id: null, content: `🪨 [DEBRIS] ${vessel.name} ploughs through wreckage (${Math.round(debrisLen)} px): ${roll.text} hull damage.`, message_type: 'system' }); } catch (e) {}
    return roll;
};
// AI moves (moveTokenToward is synchronous) queue their debris here; the
// round-resolution code flushes the queue after saving the move.
const pendingDebris = [];
window.terrainQueueDebris = function (vesselId, len) { if (len >= 5) pendingDebris.push({ vesselId, len }); };
window.terrainFlushDebris = async function () {
    while (pendingDebris.length) {
        const p = pendingDebris.shift();
        const v = (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).find(m => m.id === p.vesselId);
        if (v) await window.terrainApplyDebris(v, p.len);
    }
};

/* --- Per-battle toggle (DM) --- */
window.setBattleTerrainRules = async function (on) {
    const e = enc();
    if (!isDm() || !e || !e.map) return false;
    const map = Object.assign({}, e.map, { rules: !!on });
    const { error } = await db.from('battle_encounters').update({ map }).eq('id', e.id);
    if (error) { alert('Could not change terrain rules: ' + error.message); return false; }
    e.map = map;
    try { await db.from('chat_logs').insert({ sender_id: null, content: `🪐 [TERRAIN] Terrain rules are now ${on ? 'ON' : 'OFF'} for "${e.name}".`, message_type: 'system' }); } catch (err) {}
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return true;
};
// Start-of-battle default: on when the picked map has terrain and the DM has the tools.
window.terrainRulesDefaultFor = function (map) {
    if (!map || !Array.isArray(map.terrain) || !map.terrain.length) return false;
    const box = document.getElementById('battle-map-terrain-rules');
    if (box && box.closest && box.closest('[data-tr-wrap]') && box.closest('[data-tr-wrap]').style.display !== 'none') return !!box.checked;
    return true;
};

/* --- Numbers panel (DM) --- */
window.openTerrainRulesPanel = function () {
    if (!window.terrainRulesAllowed()) return;
    const c = window.terrainRulesConfig();
    let box = document.getElementById('terrain-rules-panel');
    if (!box) { box = document.createElement('div'); box.id = 'terrain-rules-panel'; box.className = 'dkv-modal'; document.body.appendChild(box); }
    const kinds = window.BATTLE_TERRAIN_KINDS || {};
    const row = (id, label, val, hint, attrs) => `<label class="tr-row" for="${id}"><span>${label}<small>${hint}</small></span><input id="${id}" ${attrs || 'type="number"'} value="${esc(val)}"></label>`;
    box.innerHTML = `<div class="dkv-modal-card tr-card" role="dialog" aria-modal="true" aria-label="Terrain rules">
        <div class="dkv-ttl">TERRAIN RULES · NUMBERS (ALL BATTLES)</div>
        <div class="tr-grid">
            ${row('tr-mult', 'Asteroid move cost ×', c.asteroid_move_mult, 'each px inside costs this many px', 'type="number" min="1" max="10" step="0.25"')}
            ${row('tr-cover', 'Asteroid cover %', c.asteroid_cover_pct, 'less direct-fire damage inside', 'type="number" min="0" max="90" step="5"')}
            ${row('tr-neb', 'Nebula lock range', c.nebula_lock_range, 'px; farther = can\'t target a ship inside (SHORT = 100)', 'type="number" min="0" max="2000" step="10"')}
            ${row('tr-dice', 'Debris dice', c.debris_dice, 'rolled per chunk of debris crossed', 'type="text" maxlength="12"')}
            ${row('tr-per', 'Debris chunk (px)', c.debris_per_px, 'one roll per this many px inside', 'type="number" min="5" max="1000" step="5"')}
        </div>
        <div class="dkv-lab" style="margin-top:10px;">RULES ON FOR</div>
        <div class="tr-kinds">${Object.keys(DEFAULTS.rules).map(k => `<label><input type="checkbox" data-kind="${k}" ${c.rules[k] !== false ? 'checked' : ''}> ${esc((kinds[k] && kinds[k].label) || k)}</label>`).join('')}</div>
        <p class="dkv-modal-p">Changes apply to every battle right away, for everyone. Turn rules on or off for one battle with the 🪐 chip in the battle header.</p>
        <div class="dkv-modal-acts">
            <button type="button" class="dkv-btn dkv-gold" onclick="window.saveTerrainRulesPanel()">SAVE</button>
            <button type="button" class="dkv-btn" onclick="window.resetTerrainRulesPanel()">DEFAULTS</button>
            <button type="button" class="dkv-btn" onclick="document.getElementById('terrain-rules-panel').style.display='none'">CLOSE</button>
        </div></div>`;
    box.style.display = 'flex';
};
window.resetTerrainRulesPanel = function () {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('tr-mult', DEFAULTS.asteroid_move_mult); set('tr-cover', DEFAULTS.asteroid_cover_pct); set('tr-neb', DEFAULTS.nebula_lock_range); set('tr-dice', DEFAULTS.debris_dice); set('tr-per', DEFAULTS.debris_per_px);
    document.querySelectorAll('#terrain-rules-panel [data-kind]').forEach(cb => { cb.checked = true; });
};
window.saveTerrainRulesPanel = async function () {
    if (!isDm()) return false;
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const dice = String(v('tr-dice')).trim().toLowerCase();
    if (!/^\d{0,2}d\d{1,3}([+-]\d{1,3})?$/.test(dice)) { alert('Debris dice must look like 1d6, 2d4 or 1d8+2.'); return false; }
    const rules = {};
    document.querySelectorAll('#terrain-rules-panel [data-kind]').forEach(cb => { rules[cb.getAttribute('data-kind')] = cb.checked; });
    const cfg = { asteroid_move_mult: num(v('tr-mult'), 2, 1, 10), asteroid_cover_pct: num(v('tr-cover'), 25, 0, 90), nebula_lock_range: num(v('tr-neb'), 100, 0, 2000), debris_dice: dice, debris_per_px: num(v('tr-per'), 50, 5, 1000), rules };
    const value = JSON.stringify(cfg);
    const { error } = await db.from('app_settings').update({ value, updated_at: new Date().toISOString() }).eq('feature_key', 'terrain_rules_config');
    if (error) { alert('Could not save: ' + error.message); return false; }
    if (window.appSettingsCache.terrain_rules_config) window.appSettingsCache.terrain_rules_config.value = value;
    const box = document.getElementById('terrain-rules-panel'); if (box) box.style.display = 'none';
    if (typeof window.showToast === 'function') window.showToast('Terrain rule numbers saved.');
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return true;
};

/* --- Battle header chip + START BATTLE checkbox --- */
function ensureUi() {
    const e = enc();
    // Header chip: shows for everyone when the battle's map has terrain; the DM can click it.
    const anchor = document.getElementById('battle-map-end-btn');
    let chip = document.getElementById('battle-terrain-chip');
    if (anchor && !chip) {
        chip = document.createElement('button');
        chip.id = 'battle-terrain-chip'; chip.type = 'button'; chip.className = 'layer-edit';
        chip.style.cssText = 'font-size:9px; padding:3px 8px; display:none;';
        chip.onclick = () => { if (window.terrainRulesAllowed() && enc()) window.setBattleTerrainRules(!(enc().map && enc().map.rules)); };
        anchor.parentNode.insertBefore(chip, anchor);
    }
    if (chip) {
        const hasTerrain = !!(e && e.map && Array.isArray(e.map.terrain) && e.map.terrain.length);
        const on = window.terrainRulesActive(e);
        chip.style.display = hasTerrain && (on || window.terrainRulesAllowed()) ? 'inline-block' : 'none';
        chip.textContent = on ? '🪐 TERRAIN RULES: ON' : '🪐 TERRAIN RULES: OFF';
        chip.classList.toggle('tr-on', on);
        chip.title = window.terrainRulesAllowed() ? 'Click to turn terrain rules on/off for this battle' : 'Asteroids slow + cover, nebulae hide past short range, debris damages, planets/stations block fire and movement';
        chip.disabled = !window.terrainRulesAllowed();
    }
    // ⚙ next to the chip: the numbers panel mid-battle (DM).
    let gear = document.getElementById('battle-terrain-gear');
    if (chip && !gear) {
        gear = document.createElement('button');
        gear.id = 'battle-terrain-gear'; gear.type = 'button'; gear.className = 'layer-edit';
        gear.style.cssText = 'font-size:9px; padding:3px 6px; display:none;';
        gear.textContent = '⚙'; gear.title = 'Terrain rule numbers (all battles)';
        gear.setAttribute('aria-label', 'Terrain rule numbers');
        gear.onclick = () => window.openTerrainRulesPanel();
        chip.parentNode.insertBefore(gear, chip.nextSibling);
    }
    if (gear) gear.style.display = chip && chip.style.display !== 'none' && window.terrainRulesAllowed() ? 'inline-block' : 'none';
    // START BATTLE: a checkbox next to the map picker + the numbers button.
    const pick = document.getElementById('battle-map-map-select');
    let wrap = document.getElementById('battle-map-terrain-rules-wrap');
    if (pick && !wrap) {
        wrap = document.createElement('div');
        wrap.id = 'battle-map-terrain-rules-wrap'; wrap.setAttribute('data-tr-wrap', '1');
        wrap.style.cssText = 'display:none; font-size:9px; color:#9fb4bd; margin:4px 0; align-items:center; gap:6px; flex-wrap:wrap;';
        wrap.innerHTML = `<label style="display:inline-flex; gap:4px; align-items:center;"><input type="checkbox" id="battle-map-terrain-rules" checked style="width:auto; margin:0;"> TERRAIN RULES (if the map has terrain)</label>
            <button type="button" class="layer-edit" style="font-size:9px; padding:2px 6px;" onclick="window.openTerrainRulesPanel()">⚙ NUMBERS</button>`;
        pick.parentNode.insertBefore(wrap, pick.nextSibling);
    }
    if (wrap) wrap.style.display = window.terrainRulesAllowed() && !e ? 'flex' : 'none';
}
window.terrainRulesUi = ensureUi;
const origRender = window.renderBattleMapPanel;
if (typeof origRender === 'function') {
    const wrapped = function () {
        const r = origRender.apply(this, arguments);
        try { ensureUi(); } catch (err) { console.error('terrain rules ui', err); }
        return r;
    };
    Object.keys(origRender).forEach(k => { if (!(k in wrapped)) wrapped[k] = origRender[k]; });
    window.renderBattleMapPanel = wrapped;
}
document.addEventListener('darkforest:features-changed', () => { try { ensureUi(); } catch (e) {} });
})();
