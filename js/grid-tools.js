/* ==========================================================================
   js/grid-tools.js - Battle Map grid tools
   (Command Terminal refactor, Phase 4b, 2026-10-02)
   ==========================================================================
   DM-confirmed design (2026-10-02, all defaults):
   - 📏 MEASURE: drag a tape (snaps to a ship's centre when started on one);
     readout "236 px · MEDIUM" (SHORT ≤100, MEDIUM ≤200, LONG ≤400, beyond).
     Only the person measuring sees it; 📡 SHARE flashes it on everyone's
     screen for a few seconds.
   - ◎ Range rings: in measure mode, tapping a ship toggles its SHORT /
     MEDIUM / LONG rings (stay until tapped again; local only).
   - Multi-select: Shift+click ships, Shift+drag a box on empty grid; phones
     use ⬚ SELECT. Players can only select their own ships; the DM any.
     Esc or tapping empty grid clears it.
   - Group move: drag any selected ship and the group moves together; every
     ship keeps its own rules (movement left, whose turn, stations can't
     move). The whole group stops when the first ship runs out of movement
     (formation holds). Ships not allowed to move stay put (with a note).
   - Group turn: R / Shift+R or ⟲ ⟳ turns each ship in place by 15°
     (firing_arcs must be on; each ship's own turn rule applies).
   - A group move / turn is ONE undo step.
   Feature switch 'grid_tools' (seeded DM ONLY). */

const GT = {
    tool: null,          // null | 'measure' | 'select'
    tape: null,          // { a:{x,y}, b:{x,y} } in grid px
    share: false,
    rings: new Set(),    // vessel ids with range rings shown
    selected: new Set(), // token ids
    box: null,           // { x1,y1,x2,y2 } while box-selecting
    remoteTapes: [],     // [{ a, b, label, who, until }]
    preview: null        // { dx, dy } during a group drag
};
window.__gridTools = GT; // for tests / debugging

function gtOn() { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('grid_tools'); }
window.gridToolsOn = gtOn;
function gtTokens() { return (window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || []; }
function gtVessel(tok) { return tok ? globalShipMarkersCache.find(m => m.id === tok.ship_marker_id) : null; }
function gtCenter(tok) { return typeof window.battleTokenCenter === 'function' ? window.battleTokenCenter(tok) : { x: tok.x + 17, y: tok.y + 17 }; }

window.rangeTierForDistance = function(d) {
    const T = window.BATTLE_RANGE_TIERS || { LONG: 400, MEDIUM: 200, SHORT: 100 };
    if (d <= T.SHORT) return 'SHORT';
    if (d <= T.MEDIUM) return 'MEDIUM';
    if (d <= T.LONG) return 'LONG';
    return 'beyond LONG';
};
window.tapeLabel = function(a, b) {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return `${Math.round(d)} px · ${window.rangeTierForDistance(d)}`;
};

/* --- Tool modes --- */
window.setGridTool = function(mode) {
    GT.tool = (GT.tool === mode) ? null : mode;
    if (GT.tool !== 'measure') GT.tape = null;
    GT.box = null;
    updateGridToolbar();
    drawGridTools();
};
window.toggleTapeShare = function() { GT.share = !GT.share; updateGridToolbar(); };
window.clearGridTools = function() {
    GT.tool = null; GT.tape = null; GT.box = null; GT.selected.clear(); GT.preview = null;
    updateGridToolbar(); drawGridTools(); applySelectionClasses();
};

/* --- Range rings --- */
window.toggleRangeRings = function(vesselId) {
    if (GT.rings.has(vesselId)) GT.rings.delete(vesselId); else GT.rings.add(vesselId);
    drawGridTools();
};

/* --- Selection --- */
window.canSelectBattleToken = function(tok) {
    const v = gtVessel(tok);
    if (!tok || !v) return false;
    if (currentUserRole === 'dm') return true;
    return typeof window.vesselHasOwner === 'function' && window.vesselHasOwner(v, currentUserId);
};
window.toggleBattleTokenSelected = function(tokenId) {
    const tok = gtTokens().find(t => t.token_id === tokenId);
    if (!window.canSelectBattleToken(tok)) return false;
    if (GT.selected.has(tokenId)) GT.selected.delete(tokenId); else GT.selected.add(tokenId);
    updateGridToolbar(); applySelectionClasses();
    return true;
};
window.selectBattleTokensInBox = function(x1, y1, x2, y2) {
    const lx = Math.min(x1, x2), hx = Math.max(x1, x2), ly = Math.min(y1, y2), hy = Math.max(y1, y2);
    gtTokens().forEach(t => {
        const c = gtCenter(t);
        if (c.x >= lx && c.x <= hx && c.y >= ly && c.y <= hy && window.canSelectBattleToken(t)) GT.selected.add(t.token_id);
    });
    updateGridToolbar(); applySelectionClasses();
};
window.clearBattleSelection = function() { GT.selected.clear(); updateGridToolbar(); applySelectionClasses(); };
function pruneSelection() {
    const ids = new Set(gtTokens().map(t => t.token_id));
    Array.from(GT.selected).forEach(id => { if (!ids.has(id)) GT.selected.delete(id); });
}

/* --- Group move (same rules as a single drag in wireTokenDrag) --- */
// { mode: 'free'|'capped'|'blocked', reach, reason }
window.groupMoveRule = function(tok) {
    const v = gtVessel(tok);
    if (!v) return { mode: 'blocked', reason: 'ship not found' };
    if (v.is_station) return { mode: 'blocked', reason: `${v.name} is a station (can't move)` };
    if (currentUserRole === 'dm') return { mode: 'free' };
    if (!window.vesselHasOwner(v, currentUserId)) return { mode: 'blocked', reason: `${v.name} isn't yours` };
    const enc = window.globalBattleEncounterCache;
    if (enc && enc.initiative_rolled) {
        if (enc.pending_round_tick) return { mode: 'blocked', reason: 'the round is waiting for the DM' };
        const order = enc.turn_order || [];
        if (order.includes(tok.token_id) && order[enc.current_turn_index] !== tok.token_id) return { mode: 'blocked', reason: `${v.name}: not its turn` };
    }
    const rem = tok.move_remaining !== undefined ? tok.move_remaining : (v.tactical_speed ?? 160);
    if (rem <= 0) return { mode: 'blocked', reason: `${v.name}: no movement left` };
    return { mode: 'capped', reach: rem };
};
// Works out the offset the group can actually travel and each ship's new spot.
function planGroupMove(dx, dy) {
    const sel = gtTokens().filter(t => GT.selected.has(t.token_id));
    const rules = sel.map(t => ({ t, r: window.groupMoveRule(t) }));
    const dist = Math.hypot(dx, dy);
    // Phase 10: with terrain rules on, each capped ship walks its own line
    // (asteroids cost more, planets/stations stop it); the group still stops
    // together at the shortest ship's reach so the formation holds.
    const terrain = typeof window.terrainRulesActive === 'function' && window.terrainRulesActive();
    const vOf = (t) => gtVessel(t);
    let k = 1;
    rules.forEach(({ t, r }) => {
        if (r.mode !== 'capped' || dist <= 0) return;
        if (terrain) {
            const to = clampToGrid(t.x + dx, t.y + dy);
            const full = Math.hypot(to.x - t.x, to.y - t.y);
            const w = window.terrainWalk(vOf(t), { x: t.x, y: t.y }, to, r.reach);
            k = Math.min(k, full > 0 ? Math.hypot(w.pos.x - t.x, w.pos.y - t.y) / full : 1);
        } else k = Math.min(k, r.reach / dist);
    });
    const moves = {}, blocked = [];
    rules.forEach(({ t, r }) => {
        if (r.mode === 'blocked') { blocked.push(r.reason); return; }
        const pos = clampToGrid(t.x + dx * k, t.y + dy * k);
        if (terrain && r.mode === 'capped') {
            const w = window.terrainWalk(vOf(t), { x: t.x, y: t.y }, pos, null);
            moves[t.token_id] = { pos, spend: w.cost, debrisLen: w.debrisLen };
        } else moves[t.token_id] = { pos, spend: r.mode === 'capped' ? dist * k : 0 };
    });
    return { moves, blocked, k };
}
window.planGroupMove = planGroupMove; // the 3D view previews group moves with it
window.groupMoveSelected = async function(dx, dy) {
    if (!gtOn() || GT.selected.size === 0) return null;
    const plan = planGroupMove(dx, dy);
    if (Object.keys(plan.moves).length === 0) { if (plan.blocked.length) alert(`Nothing could move: ${plan.blocked.join('; ')}.`); return plan; }
    const tokens = gtTokens().map(t => {
        const m = plan.moves[t.token_id];
        if (!m) return t;
        const out = { ...t, x: m.pos.x, y: m.pos.y };
        if (m.spend > 0) {
            const v = gtVessel(t);
            const prev = t.move_remaining !== undefined ? t.move_remaining : (v ? (v.tactical_speed ?? 160) : 160);
            out.move_remaining = Math.max(0, Math.round((prev - m.spend) * 10) / 10);
        }
        return out;
    });
    await window.recordBattleAction('Group move', async () => {
        await saveBattleTokens(tokens);
        // Phase 10: debris crossed by each ship (players / capped moves only)
        for (const id of Object.keys(plan.moves)) {
            const m = plan.moves[id];
            if (!(m.debrisLen >= 5)) continue;
            const v = gtVessel(gtTokens().find(t => t.token_id === id) || { ship_marker_id: null });
            if (v && typeof window.terrainApplyDebris === 'function') await window.terrainApplyDebris(v, m.debrisLen);
        }
    });
    if (plan.blocked.length && typeof window.showToast === 'function') window.showToast(`Stayed put: ${plan.blocked.join('; ')}`);
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return plan;
};
window.groupRotateSelected = async function(delta) {
    if (!gtOn() || GT.selected.size === 0 || !(window.firingArcsOn && window.firingArcsOn())) return null;
    const enc = window.globalBattleEncounterCache;
    const stayed = [];
    const tokens = gtTokens().map(t => {
        if (!GT.selected.has(t.token_id)) return t;
        const v = gtVessel(t);
        if (!v || v.is_strike_craft) return t;
        const can = window.canTurnBattleToken(t);
        if (!can.ok) { stayed.push(`${v.name}${can.reason ? ': ' + can.reason : ''}`); return t; }
        const cur = t.facing || 0;
        let next = delta > 0 ? (Math.floor(cur / 15) + 1) * 15 : (Math.ceil(cur / 15) - 1) * 15;
        next = ((next % 360) + 360) % 360;
        return { ...t, facing: next, turned_round: enc ? (enc.round_number || null) : null };
    });
    await window.recordBattleAction('Group turn', () => saveBattleTokens(tokens));
    if (stayed.length && typeof window.showToast === 'function') window.showToast(`Didn't turn: ${stayed.join('; ')}`);
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return { stayed };
};

/* --- Drawing (one SVG overlay above the tokens) --- */
function gtOverlay() {
    const grid = document.getElementById('battle-map-grid');
    if (!grid) return null;
    let svg = document.getElementById('battle-tools-overlay');
    if (!svg || svg.parentNode !== grid) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'battle-tools-overlay';
        svg.setAttribute('class', 'battle-tools-overlay');
        svg.setAttribute('width', String(BATTLE_GRID_W));
        svg.setAttribute('height', String(BATTLE_GRID_H));
        svg.setAttribute('viewBox', `0 0 ${BATTLE_GRID_W} ${BATTLE_GRID_H}`);
        grid.appendChild(svg);
    }
    return svg;
}
function esc(s) { return window.escapeHtml ? window.escapeHtml(String(s)) : String(s); }
function tapeSvg(a, b, cls, extra) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const label = window.tapeLabel(a, b) + (extra ? ` — ${extra}` : '');
    return `<line class="${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"></line>
        <circle class="${cls}-end" cx="${a.x}" cy="${a.y}" r="3"></circle><circle class="${cls}-end" cx="${b.x}" cy="${b.y}" r="3"></circle>
        <text class="battle-tape-label" x="${mx}" y="${my - 6}" text-anchor="middle">${esc(label)}</text>`;
}
function drawGridTools() {
    const svg = gtOverlay();
    if (!svg) return;
    let html = '';
    const T = window.BATTLE_RANGE_TIERS || { LONG: 400, MEDIUM: 200, SHORT: 100 };
    GT.rings.forEach(id => {
        const tok = gtTokens().find(t => t.ship_marker_id === id);
        if (!tok) return;
        const c = gtCenter(tok);
        [['SHORT', T.SHORT], ['MEDIUM', T.MEDIUM], ['LONG', T.LONG]].forEach(([n, r]) => {
            html += `<circle class="battle-ring battle-ring-${n.toLowerCase()}" cx="${c.x}" cy="${c.y}" r="${r}"></circle>
                <text class="battle-ring-label" x="${c.x}" y="${c.y - r + 10}" text-anchor="middle">${n} ${r}</text>`;
        });
    });
    if (GT.tape) html += tapeSvg(GT.tape.a, GT.tape.b, 'battle-tape');
    const now = Date.now();
    GT.remoteTapes = GT.remoteTapes.filter(t => t.until > now);
    GT.remoteTapes.forEach(t => { html += tapeSvg(t.a, t.b, 'battle-tape-remote', t.who); });
    if (GT.box) {
        const x = Math.min(GT.box.x1, GT.box.x2), y = Math.min(GT.box.y1, GT.box.y2);
        html += `<rect class="battle-select-box" x="${x}" y="${y}" width="${Math.abs(GT.box.x2 - GT.box.x1)}" height="${Math.abs(GT.box.y2 - GT.box.y1)}"></rect>`;
    }
    svg.innerHTML = html;
    svg.style.display = html ? 'block' : 'none';
}
window.drawGridTools = drawGridTools;
function applySelectionClasses() {
    document.querySelectorAll('#battle-map-grid .battle-token-el').forEach(el => {
        el.classList.toggle('battle-token-selected', GT.selected.has(el.dataset.tokenId));
        if (GT.preview && GT.selected.has(el.dataset.tokenId)) el.style.transform = `translate(${GT.preview.dx}px, ${GT.preview.dy}px)`;
        else if (el.style.transform) el.style.transform = '';
    });
}

/* --- Shared tape --- */
window.showRemoteTape = function(p) {
    if (!p || !p.a || !p.b || typeof p.a.x !== 'number') return;
    GT.remoteTapes.push({ a: p.a, b: p.b, who: p.who || '', until: Date.now() + 6000 });
    drawGridTools();
    setTimeout(drawGridTools, 6100);
};
function shareTape() {
    if (!GT.share || !GT.tape || typeof window.sendBattleBroadcast !== 'function') return;
    const profs = (typeof allProfiles !== 'undefined' && Array.isArray(allProfiles)) ? allProfiles : [];
    const me = profs.find(p => p.id === currentUserId);
    const who = currentUserRole === 'dm' ? 'DM' : ((me && me.username) || 'player');
    window.sendBattleBroadcast('fx', { k: 'tape', a: GT.tape.a, b: GT.tape.b, who });
}

/* --- Toolbar (Battle Map header) --- */
function ensureGridToolbar() {
    const anchor = document.getElementById('battle-map-roll-initiative-btn');
    if (!anchor || document.getElementById('battle-tools-bar')) return;
    const bar = document.createElement('span');
    bar.id = 'battle-tools-bar';
    bar.style.cssText = 'display:none; gap:4px; align-items:center;';
    bar.innerHTML = `<button id="battle-tools-measure" class="layer-edit" onclick="window.setGridTool('measure')" title="Measure: drag on the grid (starts at a ship's centre if you start on one). Tap a ship to toggle its SHORT/MEDIUM/LONG rings. Esc clears." style="font-size:9px; padding:3px 8px;">📏 MEASURE</button>
        <button id="battle-tools-share" class="layer-edit" onclick="window.toggleTapeShare()" title="Share: flash your tape on everyone's screen for a few seconds" style="font-size:9px; padding:3px 6px; display:none;">📡</button>
        <button id="battle-tools-select" class="layer-edit" onclick="window.setGridTool('select')" title="Select: tap ships or drag a box (desktop: Shift+click / Shift+drag works any time). Drag a selected ship to move the group." style="font-size:9px; padding:3px 8px;">⬚ SELECT</button>
        <span id="battle-tools-selinfo" style="display:none; font-size:9px; color:#ffd700; align-items:center; gap:3px;"></span>`;
    anchor.parentNode.insertBefore(bar, anchor);
}
function updateGridToolbar() {
    ensureGridToolbar();
    const bar = document.getElementById('battle-tools-bar');
    if (!bar) return;
    const on = gtOn() && !!window.globalBattleEncounterCache;
    bar.style.display = on ? 'inline-flex' : 'none';
    if (!on) return;
    const mb = document.getElementById('battle-tools-measure'), sb = document.getElementById('battle-tools-select'), sh = document.getElementById('battle-tools-share');
    const act = (b, a) => { if (b) { b.style.borderColor = a ? '#ffd700' : ''; b.style.color = a ? '#ffd700' : ''; } };
    act(mb, GT.tool === 'measure'); act(sb, GT.tool === 'select'); act(sh, GT.share);
    if (sh) sh.style.display = GT.tool === 'measure' ? 'inline-block' : 'none';
    const info = document.getElementById('battle-tools-selinfo');
    if (info) {
        const n = GT.selected.size;
        const arcs = window.firingArcsOn && window.firingArcsOn();
        info.style.display = n ? 'inline-flex' : 'none';
        info.innerHTML = n ? `${n} selected${arcs ? ` <button class="layer-edit" onclick="window.groupRotateSelected(-15)" title="Turn the group 15° to port (Shift+R)" style="font-size:9px; padding:1px 5px; margin:0;">⟲</button><button class="layer-edit" onclick="window.groupRotateSelected(15)" title="Turn the group 15° to starboard (R)" style="font-size:9px; padding:1px 5px; margin:0;">⟳</button>` : ''}<button class="layer-del" onclick="window.clearBattleSelection()" title="Clear selection (Esc)" style="font-size:9px; padding:1px 5px; margin:0;">✕</button>` : '';
    }
    const grid = document.getElementById('battle-map-grid');
    if (grid) grid.style.cursor = GT.tool ? 'crosshair' : '';
}
window.updateGridToolbar = updateGridToolbar;

/* --- Pointer handling on the grid (capture phase, before token drags) --- */
function worldAt(clientX, clientY) { return window.battleRenderer ? window.battleRenderer.screenToWorld(clientX, clientY) : null; }
function tokenFromTarget(target) {
    const el = target && target.closest ? target.closest('.battle-token-el') : null;
    if (!el) return null;
    return gtTokens().find(t => t.token_id === el.dataset.tokenId) || null;
}
// Generic drag tracker (mouse + touch), calling back with grid points.
function trackDrag(isTouch, onMove, onEnd) {
    const mv = (ev) => {
        const pt = isTouch ? (ev.touches && ev.touches[0]) : ev;
        if (!pt) return;
        if (isTouch && ev.cancelable) ev.preventDefault();
        const w = worldAt(pt.clientX, pt.clientY);
        if (w) onMove(w, ev);
    };
    const up = (ev) => {
        window.removeEventListener(isTouch ? 'touchmove' : 'mousemove', mv);
        window.removeEventListener(isTouch ? 'touchend' : 'mouseup', up);
        if (isTouch) window.removeEventListener('touchcancel', up);
        onEnd(ev);
    };
    window.addEventListener(isTouch ? 'touchmove' : 'mousemove', mv, { passive: false });
    window.addEventListener(isTouch ? 'touchend' : 'mouseup', up);
    if (isTouch) window.addEventListener('touchcancel', up);
}
function onGridPress(e, isTouch) {
    if (!gtOn() || !window.globalBattleEncounterCache) return;
    if (isTouch && e.touches && e.touches.length !== 1) return;
    const pt = isTouch ? e.touches[0] : e;
    const start = worldAt(pt.clientX, pt.clientY);
    if (!start) return;
    const tok = tokenFromTarget(e.target);
    const onKnob = e.target && e.target.classList && e.target.classList.contains('battle-token-rotate-knob');
    const stop = () => { e.stopPropagation(); if (!isTouch) e.preventDefault(); };

    if (GT.tool === 'measure') {
        stop();
        const a = tok ? gtCenter(tok) : { x: start.x, y: start.y };
        GT.tape = { a, b: a };
        let moved = false;
        trackDrag(isTouch, (w) => { GT.tape.b = { x: w.x, y: w.y }; if (Math.hypot(w.x - a.x, w.y - a.y) > 4) moved = true; drawGridTools(); }, () => {
            if (!moved) {
                GT.tape = null;
                if (tok) window.toggleRangeRings(tok.ship_marker_id); else drawGridTools();
                return;
            }
            drawGridTools(); shareTape();
        });
        drawGridTools();
        return;
    }
    if (GT.tool === 'select' || (!isTouch && e.shiftKey)) {
        stop();
        if (tok) { window.toggleBattleTokenSelected(tok.token_id); return; }
        GT.box = { x1: start.x, y1: start.y, x2: start.x, y2: start.y };
        trackDrag(isTouch, (w) => { GT.box.x2 = w.x; GT.box.y2 = w.y; drawGridTools(); }, () => {
            const b = GT.box; GT.box = null;
            if (b && (Math.abs(b.x2 - b.x1) > 4 || Math.abs(b.y2 - b.y1) > 4)) window.selectBattleTokensInBox(b.x1, b.y1, b.x2, b.y2);
            else if (GT.tool === 'select') window.clearBattleSelection();
            drawGridTools();
        });
        return;
    }
    if (isTouch && typeof window.battleMapTouchLocked === 'function' && window.battleMapTouchLocked()) return; // phones: locked map, swipes scroll the page
    if (tok && !onKnob && GT.selected.has(tok.token_id) && GT.selected.size > 1) {
        stop();
        let dx = 0, dy = 0;
        trackDrag(isTouch, (w) => { dx = w.x - start.x; dy = w.y - start.y; const p = planGroupMove(dx, dy); GT.preview = { dx: dx * p.k, dy: dy * p.k }; applySelectionClasses(); }, () => {
            GT.preview = null; applySelectionClasses();
            if (Math.hypot(dx, dy) > 5) window.groupMoveSelected(dx, dy);
        });
        return;
    }
    if (!tok && GT.selected.size) window.clearBattleSelection(); // plain tap on empty grid
}
function wireGrid() {
    const grid = document.getElementById('battle-map-grid');
    if (!grid || grid.__gridToolsWired) return;
    grid.__gridToolsWired = true;
    grid.addEventListener('mousedown', (e) => onGridPress(e, false), true);
    grid.addEventListener('touchstart', (e) => onGridPress(e, true), { capture: true, passive: false });
}

/* --- Keyboard: Esc clears; R / Shift+R turns the selected group --- */
document.addEventListener('keydown', (e) => {
    if (!gtOn()) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
    const panel = document.getElementById('battle-map-panel');
    if (!panel || panel.style.display !== 'block') return;
    if (e.key === 'Escape') { if (GT.tool || GT.tape || GT.selected.size) { window.clearGridTools(); e.preventDefault(); } return; }
    if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && GT.selected.size > 0 && window.firingArcsOn && window.firingArcsOn()) {
        e.preventDefault();
        e.stopImmediatePropagation(); // the single-ship R handler (firing-arcs.js) must not also fire
        window.groupRotateSelected(e.shiftKey ? -15 : 15);
    }
}, true);

/* --- Keep everything in step with Battle Map renders and switch changes --- */
window.onBattleMapRender('grid-tools', () => {
    if (!gtOn() || !window.globalBattleEncounterCache) {
        if (GT.tool || GT.selected.size || GT.tape) { GT.tool = null; GT.tape = null; GT.selected.clear(); }
    } else { wireGrid(); pruneSelection(); }
    updateGridToolbar(); drawGridTools(); applySelectionClasses();
}, 20);
document.addEventListener('darkforest:features-changed', () => { updateGridToolbar(); drawGridTools(); });
