/* ==========================================================================
   js/deck-plans.js - Deck plans + Deck View (Phase 7b, 2026-10-03)
   ==========================================================================
   DM decisions (2026-10-03 design session):
   - Plans are PAINTED SQUARES: floor, wall, door, cover, hazard, airlock
     (unpainted = void / outside the hull). 1 square = 1.5 m.
   - A deck-plan LIBRARY (DM only); a ship's deck can link to a plan
     (ship_decks[i].plan_id), so boarding opens the right one.
   - Walls BLOCK MOVEMENT and there is a LINE-OF-SIGHT check (no fog):
     walls + closed doors block sight; cover blocks movement, not sight;
     void blocks movement, not sight. The Arsenal attack form shows the
     distance and refuses a shot with no line of sight. Range itself is
     shown, not enforced (personal weapons have no range field).
   - Fights reuse what exists: tokens are Initiative Tracker combatants
     (strike craft excluded); attacks go through the Arsenal rolls.
   - Movement per turn from the Dexterity die: d4=4, d6=5, d8=6, d10=7,
     d12=8 squares. NPCs have no Dexterity: default 6 (d8), the DM can set a
     number per token. Diagonal steps cost 1 but can't cut a wall corner.
     Distance is counted around walls (paths), not through them.
   - Its own Deck View screen; can run while a space battle runs; one deck
     fight at a time.
   - Turns follow the tracker order with NEXT TURN; players move only their
     own token on their turn; the allowance refills when their turn starts;
     the DM can move anything any time, for free.
   - Doors: a token next to a door can open/close it on its owner's turn;
     the DM can toggle any door any time.

   Storage: deck_plans (library, DM only); deck_fights (one active; a
   SNAPSHOT of the plan + open-door state + turn pointer; readable by
   everyone); deck_tokens (one row per placed combatant). Feature switch
   'deck_plans' (DM only) gates the DM tools; an active deck fight shows for
   everyone. */
(function () {
const TILES = {
    '.': { name: 'Void', color: null, walk: false, sight: false },
    f: { name: 'Floor', color: '#1b2a30', walk: true, sight: false },
    w: { name: 'Wall', color: '#8fa7b0', walk: false, sight: true },
    d: { name: 'Door', color: '#ffaa00', walk: 'door', sight: 'door' },
    c: { name: 'Cover', color: '#5a6e4a', walk: false, sight: false },
    h: { name: 'Hazard', color: '#7a1f1f', walk: true, sight: false },
    a: { name: 'Airlock', color: '#1f5a7a', walk: true, sight: false }
};
window.DECK_TILES = TILES;
const DEX_MOVE = { 4: 4, 6: 5, 8: 6, 10: 7, 12: 8 };
const NPC_MOVE = 6;
const esc = (v) => window.escapeHtml(v == null ? '' : String(v));
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
window.deckPlansAllowed = function () { return isDm() && typeof window.isFeatureOn === 'function' && window.isFeatureOn('deck_plans'); };

/* --- Plan geometry (pure; tested) --- */
function normTiles(plan) {
    const n = plan.cols * plan.rows;
    let t = String(plan.tiles || '').replace(/[^.fwdcha]/g, '.');
    if (t.length < n) t += '.'.repeat(n - t.length);
    return t.slice(0, n);
}
window.deckNormTiles = normTiles;
function tileAt(plan, x, y) {
    if (x < 0 || y < 0 || x >= plan.cols || y >= plan.rows) return '.';
    return (plan._t || (plan._t = normTiles(plan)))[y * plan.cols + x] || '.';
}
window.deckTileAt = tileAt;
function doorOpen(doors, plan, x, y) { return !!(doors && doors[y * plan.cols + x]); }
function walkable(plan, doors, x, y) {
    const t = TILES[tileAt(plan, x, y)];
    return t.walk === 'door' ? doorOpen(doors, plan, x, y) : !!t.walk;
}
function blocksSight(plan, doors, x, y) {
    const t = TILES[tileAt(plan, x, y)];
    return t.sight === 'door' ? !doorOpen(doors, plan, x, y) : !!t.sight;
}
window.deckWalkable = walkable;
window.deckBlocksSight = blocksSight;
// Squares reachable within `budget` steps (8 directions, diagonal = 1, no
// cutting past a blocked corner, can't end on or pass through another token).
window.deckReachable = function (plan, doors, sx, sy, budget, occupied) {
    const occ = occupied || new Set();
    const key = (x, y) => y * plan.cols + x;
    const dist = new Map([[key(sx, sy), 0]]);
    let frontier = [[sx, sy]];
    for (let step = 1; step <= budget && frontier.length; step++) {
        const next = [];
        frontier.forEach(([x, y]) => {
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy, k = key(nx, ny);
                if (dist.has(k) || !walkable(plan, doors, nx, ny) || occ.has(k)) continue;
                if (dx && dy && (!walkable(plan, doors, x + dx, y) || !walkable(plan, doors, x, y + dy))) continue;
                dist.set(k, step); next.push([nx, ny]);
            }
        });
        frontier = next;
    }
    dist.delete(key(sx, sy));
    return dist; // squareIndex -> steps
};
// Line of sight between two squares' centres; the end squares themselves don't block.
window.deckLineOfSight = function (plan, doors, ax, ay, bx, by) {
    const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 6;
    for (let i = 1; i < n; i++) {
        const t = i / n;
        const cx = ax + 0.5 + (bx - ax) * t, cy = ay + 0.5 + (by - ay) * t;
        // Exactly on a grid line/corner counts as touching both sides; block if
        // every square touched blocks, so a line grazing a corner gets through.
        const xs = Math.abs(cx - Math.round(cx)) < 1e-6 ? [Math.round(cx) - 1, Math.round(cx)] : [Math.floor(cx)];
        const ys = Math.abs(cy - Math.round(cy)) < 1e-6 ? [Math.round(cy) - 1, Math.round(cy)] : [Math.floor(cy)];
        let open = false;
        xs.forEach(x => ys.forEach(y => {
            if ((x === ax && y === ay) || (x === bx && y === by) || !blocksSight(plan, doors, x, y)) open = true;
        }));
        if (!open) return false;
    }
    return true;
};
window.deckDistance = (ax, ay, bx, by) => Math.max(Math.abs(bx - ax), Math.abs(by - ay));

/* --- Library (DM) --- */
window.deckPlansList = [];
window.loadDeckPlans = async function () {
    if (!isDm()) { window.deckPlansList = []; return []; }
    const { data, error } = await db.from('deck_plans').select('*').order('name', { ascending: true });
    if (error) { console.error('loadDeckPlans failed', error); return window.deckPlansList; }
    window.deckPlansList = data || [];
    return window.deckPlansList;
};
window.deckPlanById = (id) => id ? (window.deckPlansList || []).find(p => p.id === id) || null : null;
function snapshotPlan(p) { return { plan_id: p.id || null, name: p.name, cols: p.cols, rows: p.rows, tiles: normTiles(p) }; }

/* --- Movement allowance --- */
function combatantById(id) { return (typeof combatantsList !== 'undefined' ? combatantsList : []).find(c => String(c.id) === String(id)) || null; }
window.deckMoveMax = function (tok) {
    if (tok && tok.move_max != null) return tok.move_max;
    const c = tok && combatantById(tok.combatant_id);
    if (c && c.is_npc === false) {
        const prof = (allProfiles || []).find(p => p.id === c.owner_id);
        const die = prof && prof.character && parseInt(String(prof.character.stat_dexterity || '').replace(/[^0-9]/g, ''), 10);
        if (DEX_MOVE[die]) return DEX_MOVE[die];
    }
    return NPC_MOVE;
};
function controls(tok) {
    if (isDm()) return true;
    const c = combatantById(tok.combatant_id);
    return !!(c && c.owner_id === currentUserId && c.is_npc === false);
}

/* --- Live fight state --- */
const F = window.__deckFight = { fight: null, tokens: [], view: false, placing: null, sel: null, los: null, cell: 24, reach: null };
window.loadDeckFight = async function () {
    const { data, error } = await db.from('deck_fights').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(1);
    if (error) { console.error('loadDeckFight failed', error); return null; }
    const fight = data && data[0] ? data[0] : null;
    if (fight && fight.plan) fight.plan._t = normTiles(fight.plan);
    F.fight = fight;
    if (fight) {
        const { data: toks } = await db.from('deck_tokens').select('*').eq('fight_id', fight.id);
        F.tokens = toks || [];
    } else { F.tokens = []; if (F.view) F.view = false; }
    renderDeckView();
    return fight;
};
let subscribed = false;
function subscribe() {
    if (subscribed || !db.channel) return;
    subscribed = true;
    try {
        db.channel('deck_fights_stream')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'deck_fights' }, () => window.loadDeckFight())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'deck_tokens' }, () => window.loadDeckFight())
            .subscribe();
    } catch (e) { console.warn('deck fights realtime unavailable', e); }
}
// Combatants in turn order that have a token on the board.
function turnOrder() {
    const placed = new Set(F.tokens.map(t => String(t.combatant_id)));
    return (typeof combatantsList !== 'undefined' ? combatantsList : []).filter(c => !c.is_strike_craft && placed.has(String(c.id)))
        .slice().sort((a, b) => (b.initiative || 0) - (a.initiative || 0));
}
window.deckTurnOrder = turnOrder;
function currentTok() { return F.fight ? F.tokens.find(t => String(t.combatant_id) === String(F.fight.current_combatant_id)) || null : null; }
function myTurn(tok) { return !!(F.fight && tok && String(F.fight.current_combatant_id) === String(tok.combatant_id)); }

window.startDeckFight = async function (opts) {
    if (!isDm()) return null;
    const plan = opts.plan || window.deckPlanById(opts.planId);
    if (!plan) { alert('Pick a deck plan first.'); return null; }
    if (F.fight && !(await window.showConfirmModal(`A deck fight ("${F.fight.name}") is running. Starting a new one ends it. Continue?`))) return null;
    if (F.fight) await db.from('deck_fights').update({ is_active: false }).eq('id', F.fight.id);
    const { data, error } = await db.from('deck_fights').insert({ name: opts.name || plan.name, plan: snapshotPlan(plan), ship_marker_id: opts.shipId || null, deck_id: opts.deckId || null, created_by: currentUserId, doors: {}, round: 1, is_active: true }).select().single();
    if (error) { alert('Could not start the deck fight: ' + error.message); return null; }
    await db.from('chat_logs').insert({ sender_id: null, content: `🚪 [DECK FIGHT] Boarding action on "${opts.name || plan.name}".`, message_type: 'system' });
    F.view = true;
    await window.loadDeckFight();
    return data;
};
window.endDeckFight = async function () {
    if (!isDm() || !F.fight) return;
    if (!(await window.showConfirmModal(`End the deck fight "${F.fight.name}"?`))) return;
    await db.from('deck_fights').update({ is_active: false }).eq('id', F.fight.id);
    F.view = false;
    await window.loadDeckFight();
};
window.openDeckView = function () { if (!F.fight) return; F.view = true; renderDeckView(); };
window.closeDeckView = function () { F.view = false; F.placing = null; F.sel = null; F.los = null; renderDeckView(); };

window.deckPlaceArm = function (combatantId) { if (!isDm()) return; F.placing = String(combatantId); F.sel = null; renderDeckView(); };
async function placeToken(combatantId, x, y) {
    const tok = F.tokens.find(t => String(t.combatant_id) === String(combatantId));
    if (tok) { await updateToken(tok, { x, y }); return; }
    const row = { fight_id: F.fight.id, combatant_id: String(combatantId), x, y, move_left: 0 };
    const { data, error } = await db.from('deck_tokens').insert(row).select().single();
    if (error) { alert('Could not place the token: ' + error.message); return; }
    F.tokens.push(data);
    if (!F.fight.current_combatant_id) await setTurn(String(combatantId), F.fight.round || 1);
}
async function updateToken(tok, fields) {
    Object.assign(tok, fields);
    const { error } = await db.from('deck_tokens').update(Object.assign({ updated_at: new Date().toISOString() }, fields)).eq('id', tok.id);
    if (error) console.error('deck token update failed', error);
}
window.deckRemoveToken = async function (tokId) {
    if (!isDm()) return;
    await db.from('deck_tokens').delete().eq('id', tokId);
    F.tokens = F.tokens.filter(t => t.id !== tokId);
    if (F.sel === tokId) F.sel = null;
    renderDeckView();
};
window.deckSetMoveMax = async function (tokId, val) {
    if (!isDm()) return;
    const tok = F.tokens.find(t => t.id === tokId); if (!tok) return;
    const n = parseInt(val, 10);
    await updateToken(tok, { move_max: isFinite(n) && n >= 0 ? Math.min(30, n) : null });
    renderDeckView();
};
async function setTurn(combatantId, round) {
    const tok = F.tokens.find(t => String(t.combatant_id) === String(combatantId));
    if (tok) await updateToken(tok, { move_left: window.deckMoveMax(tok) });
    F.fight.current_combatant_id = combatantId; F.fight.round = round;
    await db.from('deck_fights').update({ current_combatant_id: combatantId, round }).eq('id', F.fight.id);
}
// NEXT TURN (DM) / END TURN (the current token's owner).
window.deckNextTurn = async function () {
    if (!F.fight) return;
    const cur = currentTok();
    if (!isDm() && !(cur && controls(cur))) return;
    const order = turnOrder();
    if (!order.length) return;
    const i = order.findIndex(c => String(c.id) === String(F.fight.current_combatant_id));
    const nextIdx = i < 0 ? 0 : (i + 1) % order.length;
    const round = (F.fight.round || 1) + (i >= 0 && nextIdx === 0 ? 1 : 0);
    await setTurn(String(order[nextIdx].id), round);
    renderDeckView();
};
// Moves a token; returns '' on success or the reason it was refused.
window.deckTryMove = async function (tokId, x, y) {
    const tok = F.tokens.find(t => t.id === tokId);
    if (!tok || !F.fight) return 'no token';
    const plan = F.fight.plan, doors = F.fight.doors || {};
    const occ = new Set(F.tokens.filter(t => t.id !== tokId).map(t => t.y * plan.cols + t.x));
    if (isDm()) {
        if (!walkable(plan, doors, x, y) || occ.has(y * plan.cols + x)) return 'That square is blocked.';
        await updateToken(tok, { x, y });
        return '';
    }
    if (!controls(tok)) return "That isn't your character.";
    if (!myTurn(tok)) return "It isn't your turn.";
    const reach = window.deckReachable(plan, doors, tok.x, tok.y, tok.move_left || 0, occ);
    const cost = reach.get(y * plan.cols + x);
    if (cost == null) return 'Too far, or the way is blocked.';
    await updateToken(tok, { x, y, move_left: Math.max(0, (tok.move_left || 0) - cost) });
    return '';
};
window.deckToggleDoor = async function (x, y) {
    if (!F.fight) return 'no fight';
    const plan = F.fight.plan;
    if (tileAt(plan, x, y) !== 'd') return 'not a door';
    if (!isDm()) {
        const tok = currentTok();
        if (!tok || !controls(tok)) return "It isn't your turn.";
        if (window.deckDistance(tok.x, tok.y, x, y) > 1) return 'Stand next to the door first.';
    }
    const k = y * plan.cols + x;
    const doors = Object.assign({}, F.fight.doors || {});
    if (doors[k] && F.tokens.some(t => t.x === x && t.y === y)) return 'Someone is standing in the doorway.';
    if (doors[k]) delete doors[k]; else doors[k] = true;
    F.fight.doors = doors;
    await db.from('deck_fights').update({ doors }).eq('id', F.fight.id);
    renderDeckView();
    return '';
};
// Distance + sight between two combatants on the active board (null if either isn't on it).
window.deckRelation = function (combatantA, combatantB) {
    if (!F.fight) return null;
    const a = F.tokens.find(t => String(t.combatant_id) === String(combatantA));
    const b = F.tokens.find(t => String(t.combatant_id) === String(combatantB));
    if (!a || !b) return null;
    return { squares: window.deckDistance(a.x, a.y, b.x, b.y), los: window.deckLineOfSight(F.fight.plan, F.fight.doors || {}, a.x, a.y, b.x, b.y) };
};

/* --- Deck View rendering --- */
function ensureView() {
    let v = document.getElementById('deck-view');
    if (!v) { v = document.createElement('div'); v.id = 'deck-view'; v.className = 'dkv'; v.style.display = 'none'; document.body.appendChild(v); }
    let pill = document.getElementById('deck-view-pill');
    if (!pill) { pill = document.createElement('button'); pill.id = 'deck-view-pill'; pill.type = 'button'; pill.className = 'dkv-pill'; pill.onclick = () => window.openDeckView(); pill.style.display = 'none'; document.body.appendChild(pill); }
    return v;
}
function drawTiles(canvas, plan, doors, cell, extra) {
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#03070b'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < plan.rows; y++) for (let x = 0; x < plan.cols; x++) {
        const ch = tileAt(plan, x, y), T = TILES[ch], px = x * cell, py = y * cell;
        if (ch === '.') continue;
        if (ch === 'w') { ctx.fillStyle = '#566a72'; ctx.fillRect(px, py, cell, cell); ctx.fillStyle = '#8fa7b0'; ctx.fillRect(px + 2, py + 2, cell - 4, cell - 4); continue; }
        ctx.fillStyle = TILES.f.color; ctx.fillRect(px, py, cell, cell);
        if (ch === 'd') {
            const open = doorOpen(doors, plan, x, y);
            ctx.fillStyle = open ? 'rgba(255,170,0,0.25)' : '#ffaa00';
            ctx.fillRect(px + cell * 0.12, py + cell * 0.3, cell * 0.76, cell * 0.4);
            if (open) { ctx.strokeStyle = '#ffaa00'; ctx.lineWidth = 1; ctx.strokeRect(px + cell * 0.12 + 0.5, py + cell * 0.3 + 0.5, cell * 0.76 - 1, cell * 0.4 - 1); }
        } else if (ch === 'c') { ctx.fillStyle = '#5a6e4a'; ctx.fillRect(px + cell * 0.15, py + cell * 0.15, cell * 0.7, cell * 0.7); ctx.strokeStyle = '#9fbf7f'; ctx.strokeRect(px + cell * 0.15 + 0.5, py + cell * 0.15 + 0.5, cell * 0.7 - 1, cell * 0.7 - 1); }
        else if (ch === 'h') { ctx.fillStyle = 'rgba(200,40,40,0.45)'; ctx.fillRect(px, py, cell, cell); ctx.strokeStyle = 'rgba(255,90,90,0.7)'; ctx.beginPath(); ctx.moveTo(px, py + cell); ctx.lineTo(px + cell, py); ctx.stroke(); }
        else if (ch === 'a') { ctx.fillStyle = 'rgba(31,140,190,0.45)'; ctx.fillRect(px, py, cell, cell); ctx.strokeStyle = '#4fc3f7'; ctx.strokeRect(px + 2.5, py + 2.5, cell - 5, cell - 5); }
    }
    ctx.strokeStyle = 'rgba(120,200,215,0.12)'; ctx.lineWidth = 1;
    for (let x = 0; x <= plan.cols; x++) { ctx.beginPath(); ctx.moveTo(x * cell + 0.5, 0); ctx.lineTo(x * cell + 0.5, plan.rows * cell); ctx.stroke(); }
    for (let y = 0; y <= plan.rows; y++) { ctx.beginPath(); ctx.moveTo(0, y * cell + 0.5); ctx.lineTo(plan.cols * cell, y * cell + 0.5); ctx.stroke(); }
    if (extra) extra(ctx);
}
window.deckDrawTiles = drawTiles;
function initials(name) { const w = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean); return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase(); }
function renderDeckView() {
    const v = ensureView();
    const pill = document.getElementById('deck-view-pill');
    const fight = F.fight;
    if (!fight) { v.style.display = 'none'; pill.style.display = 'none'; return; }
    pill.textContent = `🚪 DECK FIGHT: ${fight.name.toUpperCase()} — OPEN`;
    pill.style.display = F.view ? 'none' : '';
    if (!F.view) { v.style.display = 'none'; return; }
    v.style.display = 'block';
    const plan = fight.plan, doors = fight.doors || {};
    const dm = isDm();
    const order = turnOrder();
    const cur = currentTok(), curC = cur ? combatantById(cur.combatant_id) : null;
    const availW = Math.max(300, (window.innerWidth || 1200) - (window.innerWidth > 900 ? 340 : 40));
    const availH = Math.max(260, (window.innerHeight || 800) - 150);
    // Phones: keep squares big enough to drag (the board scrolls sideways instead).
    const minCell = (window.innerWidth || 1200) <= 768 ? 20 : 12;
    F.cell = Math.max(minCell, Math.min(36, Math.floor(Math.min(availW / plan.cols, availH / plan.rows))));
    const cell = F.cell;
    const all = (typeof combatantsList !== 'undefined' ? combatantsList : []).filter(c => !c.is_strike_craft);
    const sel = F.tokens.find(t => t.id === F.sel);
    const rosterRows = all.slice().sort((a, b) => (b.initiative || 0) - (a.initiative || 0)).map(c => {
        const tok = F.tokens.find(t => String(t.combatant_id) === String(c.id));
        const isCur = fight.current_combatant_id && String(fight.current_combatant_id) === String(c.id);
        return `<div class="dkv-row${isCur ? ' cur' : ''}${tok && F.sel === tok.id ? ' sel' : ''}">
            <span class="dkv-dot ${c.is_npc === false ? 'pc' : 'npc'}"></span>
            <button type="button" class="dkv-rowname" ${tok ? `onclick="window.deckSelect('${tok.id}')"` : 'disabled'}>${esc(c.name)}<small>INIT ${esc(c.initiative)} · ${esc(c.hp || '')}</small></button>
            ${tok ? `<span class="dkv-mv" title="Squares left this turn / per turn">${isCur ? (tok.move_left || 0) + '/' : ''}${window.deckMoveMax(tok)}</span>` : ''}
            ${dm ? (tok ? `<button type="button" class="dkv-mini" title="Take off the board" onclick="window.deckRemoveToken('${tok.id}')">✕</button>`
                : `<button type="button" class="dkv-mini${F.placing === String(c.id) ? ' on' : ''}" onclick="window.deckPlaceArm('${esc(c.id)}')">PLACE</button>`) : ''}
        </div>`;
    }).join('') || '<div class="dkv-empty">Nobody is in the Initiative Tracker yet.</div>';
    const tokensHtml = F.tokens.map(t => {
        const c = combatantById(t.combatant_id);
        const isCur = cur && cur.id === t.id;
        return `<div class="dkv-tok ${c && c.is_npc === false ? 'pc' : 'npc'}${isCur ? ' cur' : ''}${F.sel === t.id ? ' sel' : ''}${controls(t) ? ' mine' : ''}" data-tok="${t.id}" style="left:${t.x * cell}px; top:${t.y * cell}px; width:${cell}px; height:${cell}px; font-size:${Math.max(8, Math.round(cell * 0.38))}px;" title="${esc(c ? c.name : '?')}">${esc(initials(c ? c.name : '?'))}<span class="dkv-tokname">${esc(c ? c.name : '?')}</span></div>`;
    }).join('');
    const canEnd = cur && (dm || controls(cur));
    const help = F.placing ? 'Click a floor square to place the token.' : F.los ? 'Line of sight: click a second square.' : (dm ? 'Drag any token (free for you). Click a door to open/close it. ' : 'On your turn, drag your token; highlighted squares are in reach. Click a door next to you to open/close it. ') + 'Use 👁 LOS to check sight between two squares.';
    v.innerHTML = `
        <div class="dkv-head">
            <div><span class="dkv-kicker">DECK FIGHT · 1 SQUARE = 1.5 M</span><h3 class="dkv-title">${esc(fight.name.toUpperCase())}</h3></div>
            <span class="dkv-chip">ROUND ${fight.round || 1}</span>
            <span class="dkv-chip dkv-turn">${curC ? '▶ ' + esc(curC.name.toUpperCase()) + "'S TURN" : 'NO TURN YET'}</span>
            ${canEnd ? `<button type="button" class="dkv-btn dkv-gold" onclick="window.deckNextTurn()">${dm ? 'NEXT TURN ⏭' : 'END MY TURN ⏭'}</button>` : ''}
            <span class="dkv-grow"></span>
            <button type="button" class="dkv-btn${F.los ? ' on' : ''}" onclick="window.deckLosArm()">👁 LOS</button>
            ${dm ? '<button type="button" class="dkv-btn dkv-red" onclick="window.endDeckFight()">END FIGHT</button>' : ''}
            <button type="button" class="dkv-btn" onclick="window.closeDeckView()">✕ CLOSE</button>
        </div>
        <div class="dkv-body">
            <aside class="dkv-side">
                <div class="dkv-ttl">INITIATIVE</div>
                <div class="dkv-roster">${rosterRows}</div>
                ${sel && dm ? `<div class="dkv-ttl dkv-ttl2">SELECTED</div><label class="dkv-lab" for="dkv-mm">SQUARES PER TURN (blank = from Dexterity / 6)</label>
                    <input id="dkv-mm" type="number" min="0" max="30" value="${sel.move_max != null ? sel.move_max : ''}" onchange="window.deckSetMoveMax('${sel.id}', this.value)">` : ''}
                <div class="dkv-legend">${['f', 'w', 'd', 'c', 'h', 'a'].map(k => `<span><i class="dkv-sw dkv-sw-${k}"></i>${TILES[k].name}</span>`).join('')}</div>
            </aside>
            <main class="dkv-main">
                <div class="dkv-board" id="dkv-board" style="width:${plan.cols * cell}px; height:${plan.rows * cell}px;">
                    <canvas id="dkv-canvas" width="${plan.cols * cell}" height="${plan.rows * cell}"></canvas>
                    ${tokensHtml}
                </div>
                <div class="dkv-help" id="dkv-help">${help}</div>
            </main>
        </div>`;
    redrawBoard();
    wireBoard();
}
window.renderDeckView = renderDeckView;
function redrawBoard() {
    const fight = F.fight; if (!fight) return;
    const canvas = document.getElementById('dkv-canvas'); if (!canvas) return;
    const cell = F.cell, plan = fight.plan;
    drawTiles(canvas, plan, fight.doors || {}, cell, (ctx) => {
        if (F.reach) {
            ctx.fillStyle = 'rgba(0,225,255,0.18)';
            F.reach.forEach((_, k) => { const x = k % plan.cols, y = Math.floor(k / plan.cols); ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2); });
        }
        if (F.los && F.los.b) {
            const a = F.los.a, b = F.los.b;
            ctx.strokeStyle = F.los.clear ? '#00e5a3' : '#ff4d4d'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
            ctx.beginPath(); ctx.moveTo((a[0] + 0.5) * cell, (a[1] + 0.5) * cell); ctx.lineTo((b[0] + 0.5) * cell, (b[1] + 0.5) * cell); ctx.stroke(); ctx.setLineDash([]);
        }
    });
}
function boardSquare(ev) {
    const board = document.getElementById('dkv-board');
    const r = board.getBoundingClientRect();
    return [Math.floor((ev.clientX - r.left) / F.cell), Math.floor((ev.clientY - r.top) / F.cell)];
}
function say(msg) { const h = document.getElementById('dkv-help'); if (h && msg) { h.textContent = msg; h.classList.add('warn'); } }
window.deckSelect = function (tokId) { F.sel = F.sel === tokId ? null : tokId; renderDeckView(); };
window.deckLosArm = function () { F.los = F.los ? null : { a: null, b: null }; F.placing = null; renderDeckView(); };
// Board pointer handling, exposed for tests as window.__deckBoard.
async function onBoardDown(ev) {
    if (!F.fight) return;
    const [x, y] = boardSquare(ev);
    const plan = F.fight.plan;
    if (x < 0 || y < 0 || x >= plan.cols || y >= plan.rows) return;
    if (F.placing) {
        if (!walkable(plan, F.fight.doors || {}, x, y) || F.tokens.some(t => t.x === x && t.y === y)) { say('Place tokens on an open floor square.'); return; }
        const id = F.placing; F.placing = null;
        await placeToken(id, x, y); renderDeckView(); return;
    }
    if (F.los) {
        if (!F.los.a || F.los.b) F.los = { a: [x, y], b: null };
        else { F.los.b = [x, y]; F.los.clear = window.deckLineOfSight(plan, F.fight.doors || {}, F.los.a[0], F.los.a[1], x, y); }
        renderDeckView();
        if (F.los && F.los.b) say(`${window.deckDistance(F.los.a[0], F.los.a[1], x, y)} squares (${(window.deckDistance(F.los.a[0], F.los.a[1], x, y) * 1.5).toFixed(1)} m) · ${F.los.clear ? 'line of sight CLEAR' : 'NO line of sight'}`);
        return;
    }
    const tokEl = ev.target && ev.target.closest ? ev.target.closest('[data-tok]') : null;
    if (tokEl) {
        const tok = F.tokens.find(t => t.id === tokEl.getAttribute('data-tok'));
        if (!tok) return;
        F.sel = tok.id;
        if (!controls(tok)) { renderDeckView(); return; }
        if (!isDm() && !myTurn(tok)) { renderDeckView(); say("It isn't your turn."); return; }
        const occ = new Set(F.tokens.filter(t => t.id !== tok.id).map(t => t.y * plan.cols + t.x));
        F.reach = isDm() ? null : window.deckReachable(plan, F.fight.doors || {}, tok.x, tok.y, tok.move_left || 0, occ);
        F.drag = { tok, el: tokEl };
        redrawBoard();
        return;
    }
    if (tileAt(plan, x, y) === 'd') { const why = await window.deckToggleDoor(x, y); if (why) say(why); }
}
function onBoardMove(ev) {
    if (!F.drag) return;
    const [x, y] = boardSquare(ev);
    F.drag.el.style.left = (x * F.cell) + 'px'; F.drag.el.style.top = (y * F.cell) + 'px';
    F.drag.to = [x, y];
}
async function onBoardUp() {
    const d = F.drag; F.drag = null; F.reach = null;
    if (!d) return;
    if (!d.to || (d.to[0] === d.tok.x && d.to[1] === d.tok.y)) { renderDeckView(); return; }
    const why = await window.deckTryMove(d.tok.id, d.to[0], d.to[1]);
    renderDeckView();
    if (why) say(why);
}
function wireBoard() {
    const board = document.getElementById('dkv-board');
    if (!board) return;
    board.addEventListener('pointerdown', (ev) => { ev.preventDefault(); onBoardDown(ev); });
    board.addEventListener('pointermove', onBoardMove);
    board.addEventListener('pointerup', onBoardUp);
}
window.__deckBoard = { down: onBoardDown, move: onBoardMove, up: onBoardUp, state: F };
window.addEventListener('resize', () => { if (F.view) renderDeckView(); });

/* --- Library editor (DM) --- */
const P = { plan: null, dirty: false, brush: 'f', tool: 'paint', drag: null };
function blankPlan() { return { id: null, name: 'New Deck', cols: 32, rows: 24, tiles: '.'.repeat(32 * 24), notes: '' }; }
function ensureEditor() {
    let ov = document.getElementById('deck-plan-editor');
    if (!ov) { ov = document.createElement('div'); ov.id = 'deck-plan-editor'; ov.className = 'bme dpe'; ov.style.display = 'none'; document.body.appendChild(ov); }
    return ov;
}
window.openDeckPlanEditor = async function (planId) {
    if (!window.deckPlansAllowed()) return;
    ensureEditor().style.display = 'block';
    await window.loadDeckPlans();
    const p = planId ? window.deckPlanById(planId) : (P.plan ? null : window.deckPlansList[0]);
    if (p) P.plan = JSON.parse(JSON.stringify(p));
    if (!P.plan) P.plan = blankPlan();
    P.plan.tiles = normTiles(P.plan);
    renderEditor();
};
window.closeDeckPlanEditor = async function () {
    if (P.dirty && !(await window.showConfirmModal('You have unsaved changes to this deck plan. Close anyway?'))) return;
    P.dirty = false;
    const ov = document.getElementById('deck-plan-editor'); if (ov) ov.style.display = 'none';
};
function dirty() { P.dirty = true; const d = document.getElementById('dpe-dirty'); if (d) d.textContent = '● UNSAVED'; }
window.dpePick = async function (id) {
    if (P.dirty && !(await window.showConfirmModal('Discard unsaved changes to this deck plan?'))) return;
    const p = id ? window.deckPlanById(id) : null;
    P.plan = p ? JSON.parse(JSON.stringify(p)) : blankPlan();
    P.plan.tiles = normTiles(P.plan); P.dirty = !p;
    renderEditor();
};
window.dpeBrush = function (k) { if (TILES[k]) { P.brush = k; renderEditor(); } };
window.dpeTool = function (t) { P.tool = t; renderEditor(); };
window.dpeField = function (field, value) {
    if (field === 'name') P.plan.name = String(value).slice(0, 80);
    else if (field === 'notes') P.plan.notes = String(value).slice(0, 2000);
    else if (field === 'cols' || field === 'rows') {
        const lim = field === 'cols' ? [6, 64] : [6, 48];
        const n = Math.max(lim[0], Math.min(lim[1], parseInt(value, 10) || P.plan[field]));
        const old = { cols: P.plan.cols, rows: P.plan.rows, t: P.plan.tiles };
        const cols = field === 'cols' ? n : old.cols, rows = field === 'rows' ? n : old.rows;
        let t = '';
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) t += (x < old.cols && y < old.rows) ? old.t[y * old.cols + x] : '.';
        Object.assign(P.plan, { cols, rows, tiles: t });
        dirty(); renderEditor(); return;
    }
    dirty();
};
function setTile(x, y, ch) {
    const p = P.plan;
    if (x < 0 || y < 0 || x >= p.cols || y >= p.rows) return false;
    const i = y * p.cols + x;
    if (p.tiles[i] === ch) return false;
    p.tiles = p.tiles.slice(0, i) + ch + p.tiles.slice(i + 1);
    return true;
}
// ROOM tool: walls on the edge of the dragged rectangle, floor inside (doors kept).
window.dpeRoom = function (x0, y0, x1, y1) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
        const edge = x === ax || x === bx || y === ay || y === by;
        const cur = P.plan.tiles[y * P.plan.cols + x];
        if (edge) { if (cur !== 'd' && cur !== 'a') setTile(x, y, 'w'); } else setTile(x, y, 'f');
    }
    dirty();
};
window.dpeSave = async function () {
    if (!P.plan || !isDm()) return false;
    const n = document.getElementById('dpe-name'); if (n) P.plan.name = n.value.trim() || 'Untitled Deck';
    const payload = { name: P.plan.name, cols: P.plan.cols, rows: P.plan.rows, tiles: normTiles(P.plan), notes: P.plan.notes || null, updated_at: new Date().toISOString() };
    const res = P.plan.id ? await db.from('deck_plans').update(payload).eq('id', P.plan.id).select().single()
        : await db.from('deck_plans').insert(Object.assign({ created_by: currentUserId }, payload)).select().single();
    if (res.error) { alert('Could not save the deck plan: ' + res.error.message); return false; }
    P.plan = JSON.parse(JSON.stringify(res.data)); P.plan.tiles = normTiles(P.plan); P.dirty = false;
    await window.loadDeckPlans();
    if (typeof window.showToast === 'function') window.showToast(`Deck plan "${P.plan.name}" saved.`);
    renderEditor();
    return true;
};
window.dpeDelete = async function () {
    if (!P.plan || !P.plan.id) { P.plan = blankPlan(); P.dirty = false; renderEditor(); return; }
    if (!(await window.showConfirmModal(`Delete the deck plan "${P.plan.name}"? Ship decks linked to it lose the link; a running deck fight keeps its copy.`))) return;
    const { error } = await db.from('deck_plans').delete().eq('id', P.plan.id);
    if (error) { alert('Could not delete: ' + error.message); return; }
    await window.loadDeckPlans();
    P.plan = window.deckPlansList[0] ? JSON.parse(JSON.stringify(window.deckPlansList[0])) : blankPlan();
    P.plan.tiles = normTiles(P.plan); P.dirty = false;
    renderEditor();
};
window.dpeStartFight = async function () {
    if (P.dirty && !(await window.dpeSave())) return;
    await window.closeDeckPlanEditor();
    await window.startDeckFight({ plan: P.plan });
};
function renderEditor() {
    const ov = ensureEditor();
    if (ov.style.display === 'none') return;
    const p = P.plan;
    const cell = Math.max(10, Math.min(26, Math.floor(Math.min(((window.innerWidth || 1400) - 600) / p.cols, ((window.innerHeight || 900) - 200) / p.rows))));
    P.cell = cell;
    const list = (window.deckPlansList || []).map(x => `<button type="button" class="bme-li${x.id === p.id ? ' on' : ''}" onclick="window.dpePick('${esc(x.id)}')"><span>${esc(x.name)}</span><small>${x.cols} × ${x.rows} SQUARES</small></button>`).join('') || '<div class="bme-empty">No deck plans yet.</div>';
    const brushes = ['f', 'w', 'd', 'c', 'h', 'a', '.'].map(k => `<button type="button" class="bme-kind dpe-brush${P.brush === k ? ' on' : ''}" onclick="window.dpeBrush('${k}')"><i class="dkv-sw dkv-sw-${k === '.' ? 'v' : k}"></i>${k === '.' ? 'ERASE' : TILES[k].name.toUpperCase()}</button>`).join('');
    ov.innerHTML = `
        <div class="bme-head"><div><span class="bme-kicker">BOARDING</span><h3 class="bme-title">DECK PLANS</h3></div><span id="dpe-dirty" class="bme-dirty">${P.dirty ? '● UNSAVED' : ''}</span><span class="bme-grow"></span>
            <button type="button" class="bme-btn" onclick="window.closeDeckPlanEditor()">✕ CLOSE</button></div>
        <div class="bme-body">
            <aside class="bme-col bme-left"><div class="bme-ttl">DECK PLANS</div><div class="bme-list">${list}</div>
                <button type="button" class="bme-btn bme-amber" onclick="window.dpePick(null)">+ NEW DECK PLAN</button></aside>
            <main class="bme-col bme-main">
                <div class="bme-tools">
                    <div class="bme-group" role="group" aria-label="Tool">
                        <button type="button" class="bme-tool${P.tool === 'paint' ? ' on' : ''}" onclick="window.dpeTool('paint')">🖌 PAINT</button>
                        <button type="button" class="bme-tool${P.tool === 'room' ? ' on' : ''}" onclick="window.dpeTool('room')">▭ ROOM</button>
                    </div>
                    <div class="bme-group" role="group" aria-label="Tile">${brushes}</div>
                </div>
                <div class="dpe-wrap"><canvas id="dpe-canvas" width="${p.cols * cell}" height="${p.rows * cell}" style="width:${p.cols * cell}px; height:${p.rows * cell}px;"></canvas></div>
                <div class="bme-hint">${P.tool === 'room' ? 'ROOM: drag a rectangle — walls round the edge, floor inside (doors and airlocks on the edge are kept). ' : 'PAINT: click or drag to paint the chosen tile; ERASE clears to void. '}Doors start closed in play; walls and closed doors block sight, cover blocks movement only.</div>
            </main>
            <aside class="bme-col bme-right">
                <label class="bme-lab" for="dpe-name">NAME</label>
                <input type="text" id="dpe-name" value="${esc(p.name)}" oninput="window.dpeField('name', this.value)">
                <div style="display:flex; gap:8px;"><div style="flex:1;"><label class="bme-lab" for="dpe-cols">WIDTH (6–64)</label><input type="number" id="dpe-cols" min="6" max="64" value="${p.cols}" onchange="window.dpeField('cols', this.value)"></div>
                    <div style="flex:1;"><label class="bme-lab" for="dpe-rows">HEIGHT (6–48)</label><input type="number" id="dpe-rows" min="6" max="48" value="${p.rows}" onchange="window.dpeField('rows', this.value)"></div></div>
                <div class="bme-note">1 square = 1.5 m. Movement per turn comes from the Dexterity die (d4 = 4 … d12 = 8 squares; NPCs 6).</div>
                <label class="bme-lab" for="dpe-notes">DM NOTES</label>
                <textarea id="dpe-notes" rows="3" oninput="window.dpeField('notes', this.value)">${esc(p.notes || '')}</textarea>
                <div class="bme-actions"><button type="button" class="bme-btn bme-primary" onclick="window.dpeSave()">SAVE PLAN</button><button type="button" class="bme-btn bme-red" onclick="window.dpeDelete()">${p.id ? 'DELETE' : 'DISCARD'}</button></div>
                <button type="button" class="bme-btn bme-amber" style="width:100%; margin-top:8px;" onclick="window.dpeStartFight()">🚪 START A DECK FIGHT HERE</button>
            </aside>
        </div>`;
    drawEditor();
    const cv = document.getElementById('dpe-canvas');
    if (cv) {
        cv.addEventListener('pointerdown', (ev) => { ev.preventDefault(); dpeDown(ev); });
        cv.addEventListener('pointermove', dpeMove);
        cv.addEventListener('pointerup', dpeUp);
    }
}
function drawEditor() {
    const cv = document.getElementById('dpe-canvas'); if (!cv) return;
    const plan = Object.assign({}, P.plan); plan._t = normTiles(plan);
    drawTiles(cv, plan, {}, P.cell, (ctx) => {
        if (P.drag && P.drag.room && P.drag.to) {
            const a = P.drag.from, b = P.drag.to;
            ctx.strokeStyle = '#ffd700'; ctx.setLineDash([5, 4]); ctx.lineWidth = 2;
            ctx.strokeRect(Math.min(a[0], b[0]) * P.cell + 1, Math.min(a[1], b[1]) * P.cell + 1, (Math.abs(a[0] - b[0]) + 1) * P.cell - 2, (Math.abs(a[1] - b[1]) + 1) * P.cell - 2);
            ctx.setLineDash([]);
        }
    });
}
function editorSquare(ev) { const r = document.getElementById('dpe-canvas').getBoundingClientRect(); return [Math.floor((ev.clientX - r.left) / P.cell), Math.floor((ev.clientY - r.top) / P.cell)]; }
function dpeDown(ev) {
    const s = editorSquare(ev);
    if (P.tool === 'room') { P.drag = { room: true, from: s, to: s }; drawEditor(); return; }
    P.drag = { paint: true };
    if (setTile(s[0], s[1], P.brush)) { dirty(); drawEditor(); }
}
function dpeMove(ev) {
    if (!P.drag) return;
    const s = editorSquare(ev);
    if (P.drag.room) { P.drag.to = s; drawEditor(); }
    else if (setTile(s[0], s[1], P.brush)) { dirty(); drawEditor(); }
}
function dpeUp() {
    const d = P.drag; P.drag = null;
    if (d && d.room) window.dpeRoom(d.from[0], d.from[1], d.to[0], d.to[1]);
    drawEditor();
}
window.__dpe = { state: P, down: dpeDown, move: dpeMove, up: dpeUp };

/* --- Ship decks: link a plan / start a fight (Vessel Deck, DM) --- */
window.deckPlanButtonHtml = function (vessel, deck, idx) {
    if (!window.deckPlansAllowed()) return '';
    const linked = deck && deck.plan_id ? window.deckPlanById(deck.plan_id) : null;
    return `<button type="button" onclick="window.openDeckLinkPicker('${esc(vessel.id)}', ${idx})" title="Deck plan for boarding (DM only)" style="font-size:9px; padding:2px 6px; margin:0; background:#030403; border-color:#00e1ff; color:#00e1ff;">🗺 ${linked ? esc(linked.name.toUpperCase()) : 'DECK PLAN'}</button>`;
};
window.openDeckLinkPicker = async function (vesselId, idx) {
    if (!window.deckPlansAllowed()) return;
    await window.loadDeckPlans();
    const v = (globalShipMarkersCache || []).find(m => m.id === vesselId);
    const deck = v && (v.ship_decks || [])[idx];
    if (!deck) return;
    let box = document.getElementById('deck-link-picker');
    if (!box) { box = document.createElement('div'); box.id = 'deck-link-picker'; box.className = 'dkv-modal'; document.body.appendChild(box); }
    box.innerHTML = `<div class="dkv-modal-card">
        <div class="dkv-ttl">DECK PLAN · ${esc(v.name.toUpperCase())} · ${esc(String(deck.name || '').toUpperCase())}</div>
        <label class="dkv-lab" for="dlp-select">LINKED PLAN</label>
        <select id="dlp-select"><option value="">— none —</option>${window.deckPlansList.map(p => `<option value="${esc(p.id)}" ${p.id === deck.plan_id ? 'selected' : ''}>${esc(p.name)} (${p.cols}×${p.rows})</option>`).join('')}</select>
        <div class="dkv-modal-acts">
            <button type="button" class="dkv-btn" onclick="window.saveDeckLink('${esc(vesselId)}', ${idx})">SAVE LINK</button>
            <button type="button" class="dkv-btn dkv-gold" onclick="window.startDeckFightFromShip('${esc(vesselId)}', ${idx})">🚪 START DECK FIGHT</button>
            <button type="button" class="dkv-btn" onclick="window.openDeckPlanEditor(document.getElementById('dlp-select').value || null); document.getElementById('deck-link-picker').style.display='none';">EDIT PLANS</button>
            <button type="button" class="dkv-btn" onclick="document.getElementById('deck-link-picker').style.display='none'">CLOSE</button>
        </div></div>`;
    box.style.display = 'flex';
};
window.saveDeckLink = async function (vesselId, idx, planIdArg) {
    if (!isDm()) return false;
    const v = (globalShipMarkersCache || []).find(m => m.id === vesselId);
    if (!v) return false;
    const sel = document.getElementById('dlp-select');
    const planId = planIdArg !== undefined ? planIdArg : (sel ? sel.value : '');
    const decks = JSON.parse(JSON.stringify(v.ship_decks || []));
    if (!decks[idx]) return false;
    if (planId) decks[idx].plan_id = planId; else delete decks[idx].plan_id;
    const { error } = await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vesselId);
    if (error) { alert('Could not save the link: ' + error.message); return false; }
    v.ship_decks = decks;
    const box = document.getElementById('deck-link-picker'); if (box) box.style.display = 'none';
    if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
    return true;
};
window.startDeckFightFromShip = async function (vesselId, idx) {
    const v = (globalShipMarkersCache || []).find(m => m.id === vesselId);
    const deck = v && (v.ship_decks || [])[idx];
    const sel = document.getElementById('dlp-select');
    const planId = (sel && sel.value) || (deck && deck.plan_id);
    if (!planId) { alert('Link a deck plan first.'); return; }
    if (deck && deck.plan_id !== planId) await window.saveDeckLink(vesselId, idx, planId);
    const box = document.getElementById('deck-link-picker'); if (box) box.style.display = 'none';
    await window.startDeckFight({ planId, shipId: vesselId, deckId: deck && deck.id, name: `${v.name} — ${deck.name}` });
};

/* --- Arsenal attack form: distance + line of sight --- */
function myCombatantId() {
    const c = (typeof combatantsList !== 'undefined' ? combatantsList : []).find(x => x.owner_id === currentUserId && x.is_npc === false);
    return c ? c.id : null;
}
function updateAttackInfo() {
    const sel = document.getElementById('atk-target-select');
    if (!sel) return;
    let info = document.getElementById('atk-deck-info');
    const rel = F.fight ? window.deckRelation(myCombatantId(), sel.value) : null;
    if (!rel) { if (info) info.style.display = 'none'; return; }
    if (!info) { info = document.createElement('div'); info.id = 'atk-deck-info'; info.className = 'atk-deck-info'; sel.parentNode.insertBefore(info, sel.nextSibling); }
    info.style.display = '';
    info.className = 'atk-deck-info ' + (rel.los ? 'ok' : 'blocked');
    info.textContent = `🚪 Deck: ${rel.squares} squares (${(rel.squares * 1.5).toFixed(1)} m) · ${rel.los ? 'line of sight clear' : 'NO line of sight — the shot will be refused'}`;
}
window.deckAttackInfoRefresh = updateAttackInfo;
const origOpen = window.openArsenalAttackModal;
if (typeof origOpen === 'function') {
    window.openArsenalAttackModal = function () {
        const r = origOpen.apply(this, arguments);
        const sel = document.getElementById('atk-target-select');
        if (sel && !sel.dataset.deckHooked) { sel.dataset.deckHooked = '1'; sel.addEventListener('change', updateAttackInfo); }
        updateAttackInfo();
        return r;
    };
}
const origResolve = window.resolveArsenalAttack;
if (typeof origResolve === 'function') {
    window.resolveArsenalAttack = async function () {
        const sel = document.getElementById('atk-target-select');
        const rel = F.fight && sel ? window.deckRelation(myCombatantId(), sel.value) : null;
        if (rel && !rel.los) { alert('No line of sight to that target on the deck plan — move or open a door first.'); return; }
        return origResolve.apply(this, arguments);
    };
}

/* --- Hooks --- */
// 🚪 DECK PLANS button on the Battle Map (DM), next to the other DM tools.
function ensureBattleButtons() {
    const ok = window.deckPlansAllowed();
    const dmControls = document.getElementById('battle-map-dm-controls');
    let idle = document.getElementById('deck-plans-btn-idle');
    if (dmControls && !idle) {
        idle = document.createElement('button');
        idle.id = 'deck-plans-btn-idle'; idle.type = 'button'; idle.className = 'layer-edit';
        idle.style.cssText = 'width:100%; font-size:10px; margin-top:6px; border-color:#ffaa00; color:#ffaa00;';
        idle.textContent = '🚪 DECK PLANS (boarding)';
        idle.onclick = () => window.openDeckPlanEditor();
        dmControls.appendChild(idle);
    }
    if (idle) idle.style.display = ok && !window.globalBattleEncounterCache ? 'block' : 'none';
    const anchor = document.getElementById('battle-map-end-btn');
    let b = document.getElementById('deck-plans-btn');
    if (anchor && !b) {
        b = document.createElement('button');
        b.id = 'deck-plans-btn'; b.type = 'button'; b.className = 'layer-edit';
        b.style.cssText = 'font-size:9px; padding:3px 8px; display:none;';
        b.textContent = '🚪 DECKS';
        b.onclick = () => window.openDeckPlanEditor();
        anchor.parentNode.insertBefore(b, anchor);
    }
    if (b) b.style.display = ok && window.globalBattleEncounterCache ? 'inline-block' : 'none';
}
const origBattle = window.renderBattleMapPanel;
if (typeof origBattle === 'function') {
    window.renderBattleMapPanel = function () {
        const r = origBattle.apply(this, arguments);
        try { ensureBattleButtons(); } catch (e) {}
        return r;
    };
}
const origTracker = window.renderCombatTracker;
if (typeof origTracker === 'function') {
    window.renderCombatTracker = function () {
        const r = origTracker.apply(this, arguments);
        try { if (F.fight) renderDeckView(); } catch (e) {}
        return r;
    };
}
let started = false;
document.addEventListener('darkforest:features-changed', async () => {
    try {
        if (!started && typeof currentUserId !== 'undefined' && currentUserId) { started = true; subscribe(); await window.loadDeckFight(); }
        if (window.deckPlansAllowed() && !(window.deckPlansList || []).length) await window.loadDeckPlans();
    } catch (e) { console.error('deck plans init', e); }
});
})();
