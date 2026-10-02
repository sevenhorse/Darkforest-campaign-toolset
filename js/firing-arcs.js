/* ==========================================================================
   js/firing-arcs.js - Ship facing + weapon firing arcs
   (Command Terminal refactor, Phase 3, 2026-10-02)
   ==========================================================================
   DM-confirmed rules (2026-09-30 / 2026-10-02):
   - Every Battle Map token has a facing (battle_tokens.facing, integer
     degrees). 0 = toward the TOP of the grid, increasing clockwise
     (compass style). Relative bearing of a target = bearing - facing:
     0 dead ahead, 90 starboard, 180 astern, 270 port.
   - Weapons carry an optional `arc` (presets below). No `arc` = the
     auto-guess (guessWeaponArc) is used live, so nothing breaks before the
     DM runs the Weapon Arc Review.
   - Turning: free (no AP / no movement), as often as wanted during the
     ship's own turn, locked otherwise once initiative is rolled. Before
     initiative it's unrestricted. The DM can always turn any ship.
     Strike craft have no facing. Snaps to 15 degrees (Shift = free).
   - Point Defense ignores arcs; strike craft ignore arcs; ordnance checks
     its arc at LAUNCH only.
   - AI ships turn to bring their biggest arc-limited weapon to bear, then
     fire whatever is in arc.
   - Everything here is behind the 'firing_arcs' feature switch. While it
     is off for a browser, that browser shows no facing UI and checks no
     arcs (so with the switch on DM ONLY, only the DM's own actions and the
     AI -- which runs on the DM's browser -- are arc-checked).

   Loaded right after js/battle-map.js (uses its token constants,
   saveBattleTokens, recordBattleAction, battleRenderer). */

const ARC_PRESETS = {
    // windows: [from, to] relative-bearing ranges, inclusive, clockwise;
    // from > to wraps through 0. null = all round.
    turret:         { label: 'Turret (360°)',          short: '360',     windows: null,                   center: 0 },
    fixed_forward:  { label: 'Forward Fixed (60°)',    short: 'FWD 60',  windows: [[330, 30]],            center: 0 },
    forward:        { label: 'Forward (180°)',         short: 'FWD 180', windows: [[270, 90]],            center: 0 },
    port:           { label: 'Port (180°)',            short: 'PORT',    windows: [[180, 0]],             center: 270 },
    starboard:      { label: 'Starboard (180°)',       short: 'STBD',    windows: [[0, 180]],             center: 90 },
    rear:           { label: 'Rear (180°)',            short: 'REAR',    windows: [[90, 270]],            center: 180 },
    broadside_both: { label: 'Both Broadsides (2×150°)', short: 'BROADSIDE', windows: [[195, 345], [15, 165]], center: 90 }
};
window.ARC_PRESETS = ARC_PRESETS;
const ARC_ORDER = ['turret', 'fixed_forward', 'forward', 'port', 'starboard', 'rear', 'broadside_both'];
const HEADING_STEP = 15;

function arcsOn() { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('firing_arcs'); }
window.firingArcsOn = arcsOn;

function normDeg(d) { d = Math.round(Number(d) || 0) % 360; return d < 0 ? d + 360 : d; }
function inWindow(rel, w) {
    const a = w[0], b = w[1];
    return a <= b ? (rel >= a && rel <= b) : (rel >= a || rel <= b);
}
window.arcContainsRelBearing = function(arcKey, rel) {
    const p = ARC_PRESETS[arcKey] || ARC_PRESETS.turret;
    if (!p.windows) return true;
    rel = normDeg(rel);
    return p.windows.some(w => inWindow(rel, w));
};
// Compass bearing (0 = up, clockwise) from point a to point b, in grid px.
window.compassBearing = function(a, b) {
    const deg = Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI;
    return (deg + 360) % 360;
};

/* --- Auto-guess (DM-confirmed mapping, 2026-10-02) ---
   Name first, then mount:
   - Point Defense flag / PD* names -> turret
   - lance / beam / spinal / annihilator / enforcer -> fixed_forward
   - tube / torpedo / missile / MIRV names, ordnance-class weapons, and any
     mount containing "tube" -> turret (they track their target)
   - mount spinal / fixed forward / forward fixed -> fixed_forward
   - mount port / starboard / rear / aft / forward -> that arc
   - everything else (Hardpoint, Primary, Turrets, Grid, dorsal, top,
     dispersed, ...) -> turret
   Stations and strike craft -> turret. */
window.guessWeaponArc = function(wpn, vessel) {
    if (!wpn) return 'turret';
    if (vessel && (vessel.is_station || vessel.is_strike_craft)) return 'turret';
    const name = String(wpn.name || '').toLowerCase();
    const loc = String(wpn.loc || '').toLowerCase().trim();
    if (wpn.is_point_defense || /^pd/.test(name) || /\bpd[cgl]?\b/.test(name)) return 'turret';
    if (/lance|beam|spinal|annihilator|enforcer/.test(name)) return 'fixed_forward';
    if (/tube|torpedo|missile|mirv/.test(name) || wpn.weapon_class === 'ordnance') return 'turret';
    if (/tube/.test(loc)) return 'turret';
    if (/spinal|fixed forward|forward fixed/.test(loc)) return 'fixed_forward';
    if (/\bport\b/.test(loc)) return 'port';
    if (/starboard/.test(loc)) return 'starboard';
    if (/\brear\b|\baft\b/.test(loc)) return 'rear';
    if (/forward|\bfore\b|\bbow\b/.test(loc)) return 'forward';
    return 'turret';
};
window.weaponArc = function(wpn, vessel) {
    return (wpn && wpn.arc && ARC_PRESETS[wpn.arc]) ? wpn.arc : window.guessWeaponArc(wpn, vessel);
};
function weaponIgnoresArc(wpn, vessel) {
    return !wpn || !vessel || vessel.is_strike_craft || !!wpn.is_point_defense;
}

function battleTokens() { return (window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || []; }
function tokenForVessel(vesselId) { return battleTokens().find(t => t.ship_marker_id === vesselId) || null; }
function tokenCenter(tok) {
    const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
    const size = (v && v.is_strike_craft) ? BATTLE_STRIKE_CRAFT_TOKEN_SIZE : BATTLE_TOKEN_SIZE;
    return { x: tok.x + size / 2, y: tok.y + size / 2 };
}
window.battleTokenCenter = tokenCenter;

// The one arc check. Fails OPEN (true) when arcs are off, either ship isn't
// on the grid, or the weapon/vessel is exempt -- same "never block a shot
// on missing data" convention as the range checks.
window.isTargetInArc = function(firerVesselId, targetVesselId, wpn, opts) {
    if (!arcsOn()) return true;
    const firer = globalShipMarkersCache.find(m => m.id === firerVesselId);
    if (weaponIgnoresArc(wpn, firer)) return true;
    const ft = tokenForVessel(firerVesselId), tt = tokenForVessel(targetVesselId);
    if (!ft || !tt) return true;
    const a = tokenCenter(ft), b = tokenCenter(tt);
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1) return true;
    const facing = (opts && opts.facing !== undefined) ? opts.facing : (ft.facing || 0);
    const rel = (window.compassBearing(a, b) - facing + 360) % 360;
    return window.arcContainsRelBearing(window.weaponArc(wpn, firer), Math.round(rel) % 360);
};

/* --- Turning --- */
// Returns { ok, reason }.
window.canTurnBattleToken = function(tok) {
    if (!arcsOn() || !tok) return { ok: false, reason: '' };
    const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
    if (!v || v.is_strike_craft) return { ok: false, reason: '' };
    if (currentUserRole === 'dm') return { ok: true, reason: '' };
    if (!window.vesselHasOwner(v, currentUserId)) return { ok: false, reason: '' };
    const enc = window.globalBattleEncounterCache;
    if (enc && enc.initiative_rolled) {
        if (enc.pending_round_tick) return { ok: false, reason: 'This round is waiting for the DM to resolve it.' };
        const order = enc.turn_order || [];
        if (order.includes(tok.token_id) && order[enc.current_turn_index] !== tok.token_id) {
            return { ok: false, reason: "It's not this ship's turn — it can only turn on its own turn." };
        }
    }
    return { ok: true, reason: '' };
};

let lastHeadingTokenId = null;
window.setBattleTokenFacing = async function(tokenId, deg) {
    const enc = window.globalBattleEncounterCache;
    if (!enc) return false;
    const tok = (enc.tokens || []).find(t => t.token_id === tokenId);
    const can = window.canTurnBattleToken(tok);
    if (!can.ok) { if (can.reason) alert(can.reason); return false; }
    const facing = normDeg(deg);
    lastHeadingTokenId = tokenId;
    if ((tok.facing || 0) === facing) return true;
    const tokens = (enc.tokens || []).map(t => t.token_id === tokenId ? { ...t, facing, turned_round: enc.round_number || null } : t);
    const save = () => saveBattleTokens(tokens);
    if (typeof window.recordBattleAction === 'function') await window.recordBattleAction('Turn', save);
    else await save();
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return true;
};
window.rotateBattleToken = function(tokenId, delta) {
    const tok = battleTokens().find(t => t.token_id === tokenId);
    if (!tok) return;
    const cur = tok.facing || 0;
    // Step to the next multiple of 15 in that direction (so a free-rotated
    // 37° goes to 45° / 30°, not 52° / 22°).
    const next = delta > 0 ? (Math.floor(cur / HEADING_STEP) + 1) * HEADING_STEP : (Math.ceil(cur / HEADING_STEP) - 1) * HEADING_STEP;
    window.showShipArcWedges(tok.ship_marker_id, { facing: normDeg(next), linger: 2500 });
    return window.setBattleTokenFacing(tokenId, next);
};

// Ship-card heading readout + ⟲ ⟳ buttons (Battle Map card header).
window.renderHeadingControlsHtml = function(tok, vessel) {
    if (!arcsOn() || !tok || !vessel || vessel.is_strike_craft) return '';
    const deg = normDeg(tok.facing || 0);
    const can = window.canTurnBattleToken(tok);
    const btn = (d, txt, t) => `<button class="layer-edit" onclick="event.stopPropagation(); window.rotateBattleToken('${tok.token_id}', ${d})" title="${t}" style="font-size:9px; padding:1px 5px; margin:0;">${txt}</button>`;
    return `<span style="display:inline-flex; align-items:center; gap:3px; font-size:9px; color:#00e1ff;" title="Heading: 0° = top of the grid, clockwise${can.ok ? '' : (can.reason ? ' — ' + can.reason : '')}">
        ${can.ok ? btn(-HEADING_STEP, '⟲', 'Turn 15° to port (Shift+R)') : ''}🧭 ${String(deg).padStart(3, '0')}°${can.ok ? btn(HEADING_STEP, '⟳', 'Turn 15° to starboard (R)') : ''}</span>`;
};

/* --- Token decoration: nose chevron (everyone) + rotate knob (if allowed) ---
   Called by DomBattleRenderer.sync for every token on every render (the
   token's innerHTML is rebuilt each render, so this is rebuilt too). */
window.decorateBattleTokenHeading = function(tokenEl, tok, vessel) {
    if (!arcsOn() || !vessel || vessel.is_strike_craft) return;
    const deg = normDeg(tok.facing || 0);
    const wrap = document.createElement('div');
    wrap.className = 'battle-token-heading';
    wrap.style.transform = `rotate(${deg}deg)`;
    const nose = document.createElement('div');
    nose.className = 'battle-token-nose';
    wrap.appendChild(nose);
    const can = window.canTurnBattleToken(tok);
    if (can.ok) {
        const knob = document.createElement('div');
        knob.className = 'battle-token-rotate-knob';
        knob.title = 'Drag to turn (snaps to 15°, hold Shift for free). R / Shift+R also turn.';
        wireRotateKnob(knob, wrap, tok.token_id, tok.ship_marker_id);
        wrap.appendChild(knob);
    }
    tokenEl.appendChild(wrap);
};

function wireRotateKnob(knob, wrap, tokenId, vesselId) {
    const stop = (e) => e.stopPropagation();
    knob.addEventListener('mousedown', stop);
    knob.addEventListener('touchstart', stop, { passive: true });
    knob.addEventListener('click', stop);
    knob.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        const tok = battleTokens().find(t => t.token_id === tokenId);
        if (!tok || !window.battleRenderer) return;
        const c = tokenCenter(tok);
        const cs = window.battleRenderer.worldToScreen(c.x, c.y);
        if (!cs) return;
        let current = normDeg(tok.facing || 0);
        lastHeadingTokenId = tokenId;
        const angleAt = (ev) => {
            let d = Math.atan2(ev.clientX - cs.x, -(ev.clientY - cs.y)) * 180 / Math.PI;
            d = (d + 360) % 360;
            return ev.shiftKey ? normDeg(d) : normDeg(Math.round(d / HEADING_STEP) * HEADING_STEP);
        };
        const onMove = (ev) => {
            current = angleAt(ev);
            wrap.style.transform = `rotate(${current}deg)`;
            window.showShipArcWedges(vesselId, { facing: current });
        };
        const onUp = (ev) => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            window.showShipArcWedges(vesselId, { facing: current, linger: 1500 });
            window.setBattleTokenFacing(tokenId, current);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        window.showShipArcWedges(vesselId, { facing: current });
    });
}

// R / Shift+R: turns the ship whose heading you last touched, else the
// ship whose turn it is (if you may turn it), else your only ship on the grid.
function pickKeyboardHeadingToken() {
    const toks = battleTokens();
    const okTok = (t) => t && window.canTurnBattleToken(t).ok;
    const last = toks.find(t => t.token_id === lastHeadingTokenId);
    if (okTok(last)) return last;
    const enc = window.globalBattleEncounterCache;
    if (enc && enc.initiative_rolled) {
        const cur = toks.find(t => t.token_id === (enc.turn_order || [])[enc.current_turn_index]);
        if (okTok(cur)) return cur;
    }
    const mine = toks.filter(t => { const v = globalShipMarkersCache.find(m => m.id === t.ship_marker_id); return v && !v.is_strike_craft && window.vesselHasOwner(v, currentUserId) && okTok(t); });
    return mine.length === 1 ? mine[0] : null;
}
document.addEventListener('keydown', (e) => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
    const panel = document.getElementById('battle-map-panel');
    if (!panel || panel.style.display !== 'block' || !arcsOn()) return;
    const tok = pickKeyboardHeadingToken();
    if (!tok) return;
    e.preventDefault();
    window.rotateBattleToken(tok.token_id, e.shiftKey ? -HEADING_STEP : HEADING_STEP);
});

/* --- Arc wedges (SVG overlay on the grid) --- */
let wedgeHideTimer = null;
function ensureArcOverlay() {
    const grid = document.getElementById('battle-map-grid');
    if (!grid) return null;
    let svg = document.getElementById('battle-arc-overlay');
    if (!svg || svg.parentNode !== grid) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'battle-arc-overlay';
        svg.setAttribute('class', 'battle-arc-overlay');
        svg.setAttribute('width', String(BATTLE_GRID_W));
        svg.setAttribute('height', String(BATTLE_GRID_H));
        svg.setAttribute('viewBox', `0 0 ${BATTLE_GRID_W} ${BATTLE_GRID_H}`);
        grid.appendChild(svg);
    }
    return svg;
}
function pt(c, r, deg) { const a = deg * Math.PI / 180; return { x: c.x + r * Math.sin(a), y: c.y - r * Math.cos(a) }; }
function wedgePath(c, r, from, to) {
    const span = ((to - from) + 360) % 360 || 360;
    if (span >= 360) return `M ${c.x - r} ${c.y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
    const p1 = pt(c, r, from), p2 = pt(c, r, from + span);
    return `M ${c.x} ${c.y} L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} Z`;
}
window.arcWedgePath = wedgePath;
// opts: { facing (override, e.g. mid-drag), weaponIdx (just that weapon,
// highlighted), linger (ms to keep showing, else until hideArcWedges) }
window.showShipArcWedges = function(vesselId, opts) {
    opts = opts || {};
    if (!arcsOn()) return;
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    const tok = tokenForVessel(vesselId);
    if (!vessel || !tok || vessel.is_strike_craft) return;
    const svg = ensureArcOverlay();
    if (!svg) return;
    const facing = opts.facing !== undefined ? opts.facing : (tok.facing || 0);
    const c = tokenCenter(tok);
    const weapons = (vessel.ship_weapons || []).map((w, i) => ({ w, i })).filter(x => x.w && !x.w.is_point_defense)
        .filter(x => opts.weaponIdx === undefined || x.i === opts.weaponIdx);
    const byArc = {};
    weapons.forEach(({ w }) => {
        const arc = window.weaponArc(w, vessel);
        const r = Math.max(60, Math.min(w.range || 160, 420));
        byArc[arc] = Math.max(byArc[arc] || 0, r);
    });
    const highlight = opts.weaponIdx !== undefined;
    let html = '';
    Object.keys(byArc).forEach(arc => {
        const p = ARC_PRESETS[arc];
        const r = byArc[arc];
        const cls = `battle-arc-wedge${highlight ? ' battle-arc-wedge-hl' : ''}${p.windows ? '' : ' battle-arc-wedge-turret'}`;
        (p.windows || [[0, 0]]).forEach(([from, to]) => {
            const d = p.windows ? wedgePath(c, r, from + facing, to + facing) : wedgePath(c, r, 0, 0);
            html += `<path class="${cls}" d="${d}"><title>${p.label}</title></path>`;
        });
    });
    // Nose line so the heading reads even when only turret weapons exist.
    const nose = pt(c, 26, facing);
    html += `<line class="battle-arc-heading" x1="${c.x}" y1="${c.y}" x2="${nose.x.toFixed(1)}" y2="${nose.y.toFixed(1)}"></line>`;
    svg.innerHTML = html;
    svg.style.display = 'block';
    clearTimeout(wedgeHideTimer);
    if (opts.linger) wedgeHideTimer = setTimeout(window.hideArcWedges, opts.linger);
};
window.hideArcWedges = function() {
    clearTimeout(wedgeHideTimer);
    const svg = document.getElementById('battle-arc-overlay');
    if (svg) { svg.style.display = 'none'; svg.innerHTML = ''; }
};
// Weapon target dropdown hover/focus (renderShipWeaponsHtml, js/combat.js).
window.showWeaponArcWedge = function(vesselId, idx) { window.showShipArcWedges(vesselId, { weaponIdx: idx }); };

/* --- AI facing --- */
function avgDamage(w) {
    const m = String(w.dice || '').trim().match(/^(\d*)d(\d+)$/i);
    const per = m ? (parseInt(m[1]) || 1) * (parseInt(m[2]) + 1) / 2 : 0;
    return per * (w.gun_count || 1);
}
// The heading an AI ship should take to bring its biggest arc-limited
// (non-turret, non-PD) weapon to bear on targetPos (grid px, token top-left
// like getBattleTokenPosition). null = nothing to turn for.
window.aiDesiredFacing = function(vessel, tok, targetVessel) {
    if (!arcsOn() || !vessel || !tok || vessel.is_strike_craft) return null;
    let best = null, bestScore = -1;
    (vessel.ship_weapons || []).forEach(w => {
        if (!w || w.is_point_defense) return;
        if ((w.cooldown || 0) > 0 || w.ammo === 0) return;
        const arc = window.weaponArc(w, vessel);
        if (!ARC_PRESETS[arc].windows) return;
        const s = avgDamage(w);
        if (s > bestScore) { bestScore = s; best = arc; }
    });
    if (!best) return null;
    const tt = tokenForVessel(targetVessel.id);
    if (!tt) return null;
    const bearing = window.compassBearing(tokenCenter(tok), tokenCenter(tt));
    return normDeg(bearing - ARC_PRESETS[best].center);
};
// Turns an AI ship (no undo record -- the round tick is a hard stop anyway).
window.aiTurnToward = async function(vessel, targetVessel) {
    const enc = window.globalBattleEncounterCache;
    if (!enc) return null;
    const tok = (enc.tokens || []).find(t => t.ship_marker_id === vessel.id);
    const want = window.aiDesiredFacing(vessel, tok, targetVessel);
    if (want === null || normDeg(tok.facing || 0) === want) return null;
    const tokens = (enc.tokens || []).map(t => t.token_id === tok.token_id ? { ...t, facing: want, turned_round: enc.round_number || null } : t);
    await saveBattleTokens(tokens);
    return want;
};

/* --- Weapon list badge + editor dropdowns --- */
window.weaponArcBadgeHtml = function(w, vessel) {
    if (!arcsOn() || !w) return '';
    if (vessel && vessel.is_strike_craft) return '';
    if (w.is_point_defense) return `<span style="font-size:8px; color:#00e1ff; border:1px solid #2a5a6a; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Point Defense ignores firing arcs">🎯 360</span>`;
    const arc = window.weaponArc(w, vessel);
    const auto = !(w.arc && ARC_PRESETS[w.arc]);
    return `<span style="font-size:8px; color:#00e1ff; border:1px ${auto ? 'dashed' : 'solid'} #00e1ff; border-radius:2px; padding:1px 4px; margin-left:4px;" title="Firing arc: ${ARC_PRESETS[arc].label}${auto ? ' — auto-guessed from the name/mount (set it in the weapon editor or the DM\'s Weapon Arc Review)' : ''}">🎯 ${ARC_PRESETS[arc].short}${auto ? '?' : ''}</span>`;
};
function arcOptionsHtml(selected, autoLabel) {
    return `<option value="" ${!selected ? 'selected' : ''}>${autoLabel || 'Auto (guess from name / mount)'}</option>` +
        ARC_ORDER.map(k => `<option value="${k}" ${selected === k ? 'selected' : ''}>${ARC_PRESETS[k].label}</option>`).join('');
}
window.arcOptionsHtml = arcOptionsHtml;
// Puts an "Arc" dropdown right after an editor's Mount field (or removes it
// when the switch is off). currentArc = the weapon's stored arc ('' / undefined = auto).
window.ensureArcSelect = function(afterInputId, selectId, currentArc) {
    const anchor = document.getElementById(afterInputId);
    let sel = document.getElementById(selectId);
    if (!arcsOn()) { if (sel) { const w = sel.closest('.arc-select-wrap'); (w || sel).remove(); } return null; }
    if (!anchor) return null;
    if (!sel) {
        const wrap = document.createElement('div');
        wrap.className = 'arc-select-wrap';
        wrap.style.cssText = 'margin:4px 0;';
        wrap.innerHTML = `<label for="${selectId}" style="font-size:9px; color:#00e1ff;" title="Which side of the ship this weapon can fire to. Turret = all round. Point Defense always ignores arcs.">🎯 Firing Arc</label>
            <select id="${selectId}" style="font-size:10px; border-color:#00e1ff; margin:0;"></select>`;
        // In a flex row, put it after the row instead of inside it.
        const row = anchor.parentNode && getComputedStyle(anchor.parentNode).display === 'flex' ? anchor.parentNode : anchor;
        row.insertAdjacentElement('afterend', wrap);
        sel = wrap.querySelector('select');
    }
    sel.innerHTML = arcOptionsHtml(currentArc && ARC_PRESETS[currentArc] ? currentArc : '');
    return sel;
};
// undefined = no dropdown on screen (leave the weapon's arc alone);
// null = Auto (remove any stored arc); else a preset key.
window.readArcSelect = function(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return undefined;
    return ARC_PRESETS[sel.value] ? sel.value : null;
};
window.applyArcToWeapon = function(wpn, val) {
    if (!wpn || val === undefined) return wpn;
    if (val === null) delete wpn.arc; else wpn.arc = val;
    return wpn;
};

/* --- DM: Weapon Arc Review (DM Tools -> MAINT) --- */
function reviewRows() {
    const rows = [];
    const add = (kind, owner, list) => (owner.ship_weapons || []).forEach((w, idx) => {
        if (!w) return;
        rows.push({ kind, id: owner.id, ownerName: owner.name, idx, w, vessel: owner, guess: window.guessWeaponArc(w, owner) });
    });
    globalShipMarkersCache.filter(m => !m.is_strike_craft).forEach(m => add('ship', m));
    const tmpls = (typeof shipTemplatesList !== 'undefined' ? shipTemplatesList : []).concat(window.secretShipTemplatesList || []);
    const seen = new Set();
    tmpls.forEach(t => { if (seen.has(t.id)) return; seen.add(t.id); add('template', t); });
    return rows;
}
window.openWeaponArcReview = function() {
    if (currentUserRole !== 'dm') return;
    let ov = document.getElementById('weapon-arc-review');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'weapon-arc-review';
        ov.style.cssText = 'position:fixed; inset:0; z-index:5000; background:rgba(3,4,6,0.9); display:flex; align-items:center; justify-content:center;';
        document.body.appendChild(ov);
    }
    const rows = reviewRows();
    const onlyUnset = !!window.__arcReviewOnlyUnset;
    const shown = rows.filter(r => !onlyUnset || !(r.w.arc && ARC_PRESETS[r.w.arc]));
    const esc = window.escapeHtml;
    const body = shown.map(r => {
        const stored = r.w.arc && ARC_PRESETS[r.w.arc] ? r.w.arc : '';
        const pre = stored || r.guess;
        const sel = `<select class="arc-review-sel" data-kind="${r.kind}" data-id="${r.id}" data-idx="${r.idx}" data-stored="${stored}" style="font-size:9px; margin:0; width:auto;" ${r.w.is_point_defense ? 'title="Point Defense ignores arcs either way"' : ''}>${ARC_ORDER.map(k => `<option value="${k}" ${pre === k ? 'selected' : ''}>${ARC_PRESETS[k].label}</option>`).join('')}</select>`;
        return `<tr><td>${r.kind === 'ship' ? '🚀' : '📐'} ${esc(r.ownerName || '')}</td><td>${esc(r.w.name || '')}${r.w.is_point_defense ? ' <span style="color:#66d9ff;">PD</span>' : ''}</td><td style="color:#6b826a;">${esc(r.w.loc || '')}</td><td style="color:${stored ? '#00e5a3' : '#ffaa00'};">${stored ? 'set' : 'auto'}</td><td>${sel}</td></tr>`;
    }).join('');
    ov.innerHTML = `<div class="panel" style="position:relative; width:820px; max-width:96vw; max-height:90vh; overflow:auto; border-color:#00e1ff;">
        <h4 style="margin-top:0; color:#00e1ff;">🎯 Weapon Arc Review</h4>
        <p style="font-size:9px; color:#6b826a; margin:0 0 6px 0;">Every weapon on every ship (🚀) and template (📐). "auto" rows are using the guess from their name/mount right now. Change any row, then APPLY to save. Ships already deployed keep their own copy — fixing a template only affects ships deployed from it later.</p>
        <label style="font-size:10px; display:inline-flex; gap:4px; align-items:center; cursor:pointer;"><input type="checkbox" ${onlyUnset ? 'checked' : ''} onchange="window.__arcReviewOnlyUnset=this.checked; window.openWeaponArcReview();" style="margin:0; width:auto;"> Only show weapons still on auto</label>
        <table class="arc-review-table" style="width:100%; font-size:10px; border-collapse:collapse; margin-top:6px;"><thead><tr style="color:#00e1ff; text-align:left;"><th>Ship / template</th><th>Weapon</th><th>Mount</th><th>Now</th><th>Arc</th></tr></thead><tbody>${body || '<tr><td colspan="5" style="color:#6b826a;">Nothing to review.</td></tr>'}</tbody></table>
        <div style="display:flex; gap:8px; margin-top:10px;">
            <button onclick="document.getElementById('weapon-arc-review').remove()" style="flex:1; margin:0;">CLOSE</button>
            <button class="btn-reveal" onclick="window.applyWeaponArcReview()" style="flex:2; margin:0; border-color:#00e1ff; color:#00e1ff;">✔ APPLY (save every row shown)</button>
        </div></div>`;
};
window.applyWeaponArcReview = async function() {
    if (currentUserRole !== 'dm') return;
    const sels = Array.from(document.querySelectorAll('#weapon-arc-review .arc-review-sel'));
    const changes = {}; // "kind|id" -> { idx: arc }
    sels.forEach(s => {
        const val = s.value;
        if (val === s.getAttribute('data-stored')) return;
        const key = s.getAttribute('data-kind') + '|' + s.getAttribute('data-id');
        (changes[key] = changes[key] || {})[s.getAttribute('data-idx')] = val;
    });
    const keys = Object.keys(changes);
    let saved = 0, failed = 0;
    for (const key of keys) {
        const [kind, id] = key.split('|');
        const owner = kind === 'ship'
            ? globalShipMarkersCache.find(m => m.id === id)
            : (typeof findAnyTemplateById === 'function' ? findAnyTemplateById(id) : null);
        if (!owner) { failed++; continue; }
        const weapons = JSON.parse(JSON.stringify(owner.ship_weapons || []));
        Object.keys(changes[key]).forEach(i => { if (weapons[i]) weapons[i].arc = changes[key][i]; });
        const { error } = await db.from(kind === 'ship' ? 'ship_markers' : 'ship_templates').update({ ship_weapons: weapons }).eq('id', id);
        if (error) { failed++; continue; }
        owner.ship_weapons = weapons;
        saved++;
    }
    const ov = document.getElementById('weapon-arc-review');
    if (ov) ov.remove();
    const msg = failed ? `Saved arcs on ${saved} ship(s)/template(s); ${failed} failed — try again.` : `Saved arcs on ${saved} ship(s)/template(s).`;
    if (typeof window.showToast === 'function') window.showToast(msg); else alert(msg);
    if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return { saved, failed };
};
function updateArcReviewButton() {
    const b = document.getElementById('weapon-arc-review-btn');
    if (b) b.style.display = (currentUserRole === 'dm' && arcsOn()) ? 'block' : 'none';
}
document.addEventListener('darkforest:features-changed', () => {
    updateArcReviewButton();
    if (!arcsOn()) window.hideArcWedges();
    // (battle-map.js re-renders the Battle Map on this same event.)
    if (typeof window.renderVesselDeck === 'function') { try { window.renderVesselDeck(); } catch (e) {} }
});
window.updateArcReviewButton = updateArcReviewButton;
