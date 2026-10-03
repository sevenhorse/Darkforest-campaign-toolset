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

   Phase 9 (boarding loop, DM decisions 2026-10-03):
   - Starting a fight from a ship's deck marks that deck CONTESTED; END FIGHT
     asks SECURE / CAPTURED / LEAVE AS IS. When every deck is CAPTURED, the
     DM is offered the ship transfer (defaults to the boarders' player).
   - Hazard squares: a token ending its turn on one rolls the plan's hazard
     dice (default 1d6) into chat; the DM applies the damage.
   - 💨 VENT (DM): click an airlock; every token within 3 squares that can
     see it rolls the plan's vent dice (default 2d6) into chat, and open
     doors within 3 squares slam shut.
   - Personal weapons get short/long range (squares): past short = -2 to
     hit, past long = no shot.
   - Fog of war (on by default per fight): shared party vision from every
     PC token. ENFORCED ON THE SERVER: deck_tokens rows are only readable
     when df_deck_token_visible() says so; NEXT TURN runs on the server
     (df_deck_advance_turn) because a player's client can't see every
     token; every token write bumps deck_fights.rev so all clients reload.
     Squares seen once stay "explored" (deck_fights.explored, '0'/'1').

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
function snapshotPlan(p) {
    return { plan_id: p.id || null, name: p.name, cols: p.cols, rows: p.rows, tiles: normTiles(p),
        hazard_dice: validDice(p.hazard_dice) || '1d6', vent_dice: validDice(p.vent_dice) || '2d6' };
}

/* --- Dice (hazard / vent) --- */
function validDice(s) {
    const m = String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase().match(/^(\d{1,2})?d(\d{1,3})([+-]\d{1,3})?$/);
    if (!m) return null;
    const n = parseInt(m[1] || '1', 10), f = parseInt(m[2], 10);
    if (n < 1 || f < 2) return null;
    return `${n}d${f}${m[3] || ''}`;
}
window.deckValidDice = validDice;
window.deckRollDice = function (expr) {
    const e = validDice(expr) || '1d6';
    const m = e.match(/^(\d+)d(\d+)([+-]\d+)?$/);
    const rolls = [];
    for (let i = 0; i < parseInt(m[1], 10); i++) rolls.push(Math.floor(Math.random() * parseInt(m[2], 10)) + 1);
    const mod = parseInt(m[3] || '0', 10);
    return { expr: e, rolls, mod, total: rolls.reduce((a, b) => a + b, 0) + mod };
};
function rollText(r) { return `${r.expr} → [${r.rolls.join(', ')}]${r.mod ? (r.mod > 0 ? ' +' : ' ') + r.mod : ''} = ${r.total}`; }
async function postDeckChat(content) {
    try { await db.from('chat_logs').insert({ sender_id: null, content, message_type: 'system' }); } catch (e) { console.warn('deck chat failed', e); }
}
// NPC results while fog is on would give away where a hidden enemy stands,
// so they stay on the DM's screen (DECK LOG in the Deck View side panel)
// instead of going to chat. NPC turns are only ever ended by the DM, so
// the DM's client is the one that rolls them.
const dmLog = [];
function dmNotice(msg) {
    dmLog.unshift(msg); if (dmLog.length > 8) dmLog.length = 8;
    if (typeof window.showToast === 'function') window.showToast(msg);
}
window.__deckDmLog = dmLog;

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
// One move fires a deck_tokens event AND a deck_fights (rev) event: reload once.
let reloadTimer = null;
function queueReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => window.loadDeckFight(), 120); }
function subscribe() {
    if (subscribed || !db.channel) return;
    subscribed = true;
    try {
        db.channel('deck_fights_stream')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'deck_fights' }, queueReload)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'deck_tokens' }, queueReload)
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

/* --- Fog of war (shared party vision) ---
   The server decides which NPC tokens a player receives at all
   (df_deck_token_visible, same LOS rule); this is the client half:
   which SQUARES to draw, and the "explored" memory. */
function fogOn() { return !!(F.fight && F.fight.fog !== false); }
function isPcTok(t) { const c = combatantById(t.combatant_id); return !!(c && c.is_npc === false); }
function visibleSet() {
    const fight = F.fight; if (!fight) return new Set();
    const plan = fight.plan, doors = fight.doors || {};
    const pcs = F.tokens.filter(isPcTok);
    const key = fight.id + '|' + pcs.map(t => t.x + ',' + t.y).sort().join(';') + '|' + Object.keys(doors).sort().join(',');
    if (F._visKey === key && F._vis) return F._vis;
    const vis = new Set();
    pcs.forEach(t => vis.add(t.y * plan.cols + t.x));
    for (let y = 0; y < plan.rows; y++) for (let x = 0; x < plan.cols; x++) {
        const k = y * plan.cols + x;
        if (vis.has(k) || tileAt(plan, x, y) === '.') continue;
        if (pcs.some(t => window.deckLineOfSight(plan, doors, t.x, t.y, x, y))) vis.add(k);
    }
    F._visKey = key; F._vis = vis;
    return vis;
}
window.deckVisibleSet = visibleSet;
// Returns the new explored string, or null when nothing new was seen.
function mergeExplored(vis) {
    const plan = F.fight.plan, n = plan.cols * plan.rows;
    const cur = String(F.fight.explored || '');
    const arr = (cur.length >= n ? cur.slice(0, n) : cur + '0'.repeat(n - cur.length)).split('');
    let changed = false;
    vis.forEach(k => { if (arr[k] !== '1') { arr[k] = '1'; changed = true; } });
    return changed ? arr.join('') : null;
}
// After any write that moves a token or a door: bump rev (so every client,
// including players who can't see the moved token, reloads) and remember
// newly seen squares. `extra` rides along in the same update (doors).
async function afterWrite(extra) {
    if (!F.fight) return;
    const upd = Object.assign({ rev: (F.fight.rev || 0) + 1 }, extra || {});
    Object.assign(F.fight, upd);
    if (fogOn()) { const ex = mergeExplored(visibleSet()); if (ex) { upd.explored = ex; F.fight.explored = ex; } }
    const { error } = await db.from('deck_fights').update(upd).eq('id', F.fight.id);
    if (error) console.error('deck fight update failed', error);
}

window.startDeckFight = async function (opts) {
    if (!isDm()) return null;
    const plan = opts.plan || window.deckPlanById(opts.planId);
    if (!plan) { alert('Pick a deck plan first.'); return null; }
    if (F.fight && !(await window.showConfirmModal(`A deck fight ("${F.fight.name}") is running. Starting a new one ends it. Continue?`))) return null;
    if (F.fight) await db.from('deck_fights').update({ is_active: false }).eq('id', F.fight.id);
    const fog = opts.fog !== false;
    const { data, error } = await db.from('deck_fights').insert({ name: opts.name || plan.name, plan: snapshotPlan(plan), ship_marker_id: opts.shipId || null, deck_id: opts.deckId || null, created_by: currentUserId, doors: {}, round: 1, is_active: true, fog, explored: '', rev: 0 }).select().single();
    if (error) { alert('Could not start the deck fight: ' + error.message); return null; }
    if (opts.shipId && opts.deckId) await setShipDeckStatus(opts.shipId, opts.deckId, 'contested');
    await postDeckChat(`🚪 [DECK FIGHT] Boarding action on "${opts.name || plan.name}".`);
    F.view = true;
    await window.loadDeckFight();
    return data;
};
// Writes one deck's boarding_status on a ship token (same field the Vessel
// Deck's SECURE/CONTESTED/CAPTURED badge cycles).
async function setShipDeckStatus(vesselId, deckId, status) {
    const v = (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).find(m => m.id === vesselId);
    if (!v) return false;
    const decks = JSON.parse(JSON.stringify(v.ship_decks || []));
    const d = decks.find(x => x.id === deckId);
    if (!d) return false;
    d.boarding_status = status;
    const { error } = await db.from('ship_markers').update({ ship_decks: decks }).eq('id', vesselId);
    if (error) { console.error('deck status update failed', error); return false; }
    v.ship_decks = decks;
    if (typeof window.renderVesselDeck === 'function') { try { window.renderVesselDeck(); } catch (e) {} }
    return true;
}
window.deckSetShipDeckStatus = setShipDeckStatus;
// Small choice modal; resolves with the chosen value (null = cancel).
function choiceModal(title, bodyHtml, buttons) {
    return new Promise(resolve => {
        let box = document.getElementById('deck-choice-modal');
        if (!box) { box = document.createElement('div'); box.id = 'deck-choice-modal'; box.className = 'dkv-modal'; document.body.appendChild(box); }
        box.innerHTML = `<div class="dkv-modal-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
            <div class="dkv-ttl">${esc(title)}</div>${bodyHtml || ''}
            <div class="dkv-modal-acts">${buttons.map((b, i) => `<button type="button" class="dkv-btn${b.cls ? ' ' + b.cls : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
        box.style.display = 'flex';
        box.querySelectorAll('button[data-i]').forEach(btn => btn.onclick = () => {
            const b = buttons[+btn.getAttribute('data-i')];
            const val = typeof b.value === 'function' ? b.value(box) : b.value;
            box.style.display = 'none';
            resolve(val);
        });
    });
}
window.__deckChoiceModal = choiceModal;
// Who boarded: owners of PC tokens on the board who don't already own the ship.
function boarderIds(vessel) {
    const owners = typeof window.vesselOwnerIds === 'function' ? window.vesselOwnerIds(vessel) : (vessel.owner_ids || []);
    const ids = [];
    F.tokens.forEach(t => {
        const c = combatantById(t.combatant_id);
        if (c && c.is_npc === false && c.owner_id && !owners.includes(c.owner_id) && !ids.includes(c.owner_id)) ids.push(c.owner_id);
    });
    return ids;
}
async function offerTransfer(vessel, boarders) {
    const players = (typeof allProfiles !== 'undefined' ? allProfiles : []).filter(p => p.role !== 'dm');
    if (!players.length) return false;
    const def = boarders[0] || players[0].id;
    const body = `<p class="dkv-modal-p">Every deck of "${esc(vessel.name)}" is CAPTURED. Transfer the ship? This replaces ALL current owners.</p>
        <label class="dkv-lab" for="dcm-owner">NEW OWNER</label>
        <select id="dcm-owner">${players.map(p => `<option value="${esc(p.id)}" ${p.id === def ? 'selected' : ''}>${esc(p.username || 'Commander')}${boarders.includes(p.id) ? ' (boarder)' : ''}</option>`).join('')}</select>`;
    const pick = await choiceModal('SHIP CAPTURED', body, [
        { label: 'TRANSFER', cls: 'dkv-gold', value: (box) => box.querySelector('#dcm-owner').value },
        { label: 'NOT NOW', value: null }]);
    if (!pick) return false;
    const { error } = await db.from('ship_markers').update({ owner_ids: [pick] }).eq('id', vessel.id);
    if (error) { alert('Could not transfer the ship: ' + error.message); return false; }
    vessel.owner_ids = [pick];
    const name = (players.find(p => p.id === pick) || {}).username || 'Commander';
    await postDeckChat(`⚔️ BOARDING RESOLVED: "${vessel.name}" has been captured — ownership transferred to ${name}.`);
    if (typeof window.renderVesselDeck === 'function') { try { window.renderVesselDeck(); } catch (e) {} }
    if (typeof window.showToast === 'function') window.showToast(`Ownership of ${vessel.name} transferred.`);
    return true;
}
window.endDeckFight = async function () {
    if (!isDm() || !F.fight) return;
    const fight = F.fight;
    const vessel = fight.ship_marker_id ? (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).find(m => m.id === fight.ship_marker_id) : null;
    const deck = vessel && fight.deck_id ? (vessel.ship_decks || []).find(d => d.id === fight.deck_id) : null;
    let outcome = 'keep';
    if (deck) {
        outcome = await choiceModal(`END DECK FIGHT · ${String(fight.name).toUpperCase()}`,
            `<p class="dkv-modal-p">How did the fight for ${esc(deck.name)} end?</p>`, [
            { label: 'SECURE (defenders held)', cls: 'dkv-green', value: 'secure' },
            { label: 'CAPTURED (boarders took it)', cls: 'dkv-red', value: 'captured' },
            { label: 'LEAVE AS IS', value: 'keep' },
            { label: 'CANCEL', value: null }]);
        if (!outcome) return;
    } else if (!(await window.showConfirmModal(`End the deck fight "${fight.name}"?`))) return;
    const boarders = vessel ? boarderIds(vessel) : [];
    await db.from('deck_fights').update({ is_active: false }).eq('id', fight.id);
    if (deck && outcome !== 'keep') {
        await setShipDeckStatus(vessel.id, deck.id, outcome);
        await postDeckChat(`🚪 [DECK FIGHT] ${vessel.name} — ${deck.name}: ${outcome === 'captured' ? 'CAPTURED by the boarders' : 'SECURED by the defenders'}.`);
    }
    F.view = false;
    await window.loadDeckFight();
    if (deck && outcome === 'captured' && (vessel.ship_decks || []).length && vessel.ship_decks.every(d => (d.boarding_status || 'secure') === 'captured')) {
        await offerTransfer(vessel, boarders);
    }
};
window.openDeckView = function () { if (!F.fight) return; F.view = true; renderDeckView(); };
window.closeDeckView = function () { F.view = false; F.placing = null; F.sel = null; F.los = null; renderDeckView(); };

window.deckPlaceArm = function (combatantId) { if (!isDm()) return; F.placing = String(combatantId); F.sel = null; renderDeckView(); };
async function placeToken(combatantId, x, y) {
    const tok = F.tokens.find(t => String(t.combatant_id) === String(combatantId));
    if (tok) { await updateToken(tok, { x, y }); await afterWrite(); return; }
    const row = { fight_id: F.fight.id, combatant_id: String(combatantId), x, y, move_left: 0 };
    const { data, error } = await db.from('deck_tokens').insert(row).select().single();
    if (error) { alert('Could not place the token: ' + error.message); return; }
    F.tokens.push(data);
    if (!F.fight.current_combatant_id) await setTurn(String(combatantId), F.fight.round || 1);
    await afterWrite();
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
    await afterWrite();
    renderDeckView();
};
window.deckSetMoveMax = async function (tokId, val) {
    if (!isDm()) return;
    const tok = F.tokens.find(t => t.id === tokId); if (!tok) return;
    const n = parseInt(val, 10);
    await updateToken(tok, { move_max: isFinite(n) && n >= 0 ? Math.min(30, n) : null });
    await afterWrite();
    renderDeckView();
};
async function setTurn(combatantId, round) {
    const tok = F.tokens.find(t => String(t.combatant_id) === String(combatantId));
    if (tok) await updateToken(tok, { move_left: window.deckMoveMax(tok) });
    F.fight.current_combatant_id = combatantId; F.fight.round = round;
    await db.from('deck_fights').update({ current_combatant_id: combatantId, round }).eq('id', F.fight.id);
}
// NEXT TURN (DM) / END TURN (the current token's owner). Runs on the
// server (df_deck_advance_turn): with fog on, a player's client can't see
// every token, so it can't work out the order itself. The local version is
// only a fallback for when the function answers with nothing at all (the
// offline test harness).
function localNextTurn() {
    const order = turnOrder();
    if (!order.length) return null;
    const i = order.findIndex(c => String(c.id) === String(F.fight.current_combatant_id));
    const nextIdx = i < 0 ? 0 : (i + 1) % order.length;
    return { id: String(order[nextIdx].id), round: (F.fight.round || 1) + (i >= 0 && nextIdx === 0 ? 1 : 0) };
}
window.deckNextTurn = async function () {
    if (!F.fight) return;
    const cur = currentTok();
    if (!isDm() && !(cur && controls(cur))) return;
    if (!F.tokens.length) return;
    const ended = cur ? { tok: Object.assign({}, cur), plan: F.fight.plan } : null;
    const { data, error } = await db.rpc('df_deck_advance_turn', { p_fight: F.fight.id });
    if (error) { alert('Could not advance the turn: ' + error.message); return; }
    if (data) {
        await hazardCheck(ended);
        await window.loadDeckFight();
        return;
    }
    const nxt = localNextTurn();
    if (!nxt) return;
    await setTurn(nxt.id, nxt.round);
    await hazardCheck(ended);
    await afterWrite();
    renderDeckView();
};
// A token that ENDS its turn on a hazard square rolls the plan's hazard
// dice; the DM applies the damage.
async function hazardCheck(ended) {
    if (!ended || !ended.tok) return null;
    const t = ended.tok, plan = ended.plan;
    if (tileAt(plan, t.x, t.y) !== 'h') return null;
    const c = combatantById(t.combatant_id);
    const r = window.deckRollDice(plan.hazard_dice || '1d6');
    const msg = `☣️ [DECK HAZARD] ${c ? c.name : 'A combatant'} ended the turn on a hazard square: ${rollText(r)} damage (DM applies).`;
    if (fogOn() && !(c && c.is_npc === false)) dmNotice(msg); else await postDeckChat(msg);
    return r;
}
window.__deckHazardCheck = hazardCheck;
// Moves a token; returns '' on success or the reason it was refused.
window.deckTryMove = async function (tokId, x, y) {
    const tok = F.tokens.find(t => t.id === tokId);
    if (!tok || !F.fight) return 'no token';
    const plan = F.fight.plan, doors = F.fight.doors || {};
    const occ = new Set(F.tokens.filter(t => t.id !== tokId).map(t => t.y * plan.cols + t.x));
    if (isDm()) {
        if (!walkable(plan, doors, x, y) || occ.has(y * plan.cols + x)) return 'That square is blocked.';
        await updateToken(tok, { x, y });
        await afterWrite();
        return '';
    }
    if (!controls(tok)) return "That isn't your character.";
    if (!myTurn(tok)) return "It isn't your turn.";
    const reach = window.deckReachable(plan, doors, tok.x, tok.y, tok.move_left || 0, occ);
    const cost = reach.get(y * plan.cols + x);
    if (cost == null) return 'Too far, or the way is blocked.';
    await updateToken(tok, { x, y, move_left: Math.max(0, (tok.move_left || 0) - cost) });
    await afterWrite();
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
    await afterWrite({ doors });
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

// 💨 VENT (DM): blow an airlock. Tokens within 3 squares that can see the
// airlock roll the plan's vent dice; open doors within 3 squares slam shut
// (unless someone is standing in the doorway).
const VENT_RADIUS = 3;
window.deckVentArm = function () { if (!isDm()) return; F.vent = !F.vent; F.los = null; F.placing = null; renderDeckView(); };
window.deckVent = async function (x, y) {
    if (!isDm() || !F.fight) return null;
    const plan = F.fight.plan, doors = F.fight.doors || {};
    if (tileAt(plan, x, y) !== 'a') return null;
    const hit = F.tokens.filter(t => window.deckDistance(t.x, t.y, x, y) <= VENT_RADIUS && window.deckLineOfSight(plan, doors, x, y, t.x, t.y));
    const results = hit.map(t => ({ tok: t, c: combatantById(t.combatant_id), r: window.deckRollDice(plan.vent_dice || '2d6') }));
    const nd = Object.assign({}, doors);
    let closed = 0;
    Object.keys(nd).forEach(k => {
        const dx = k % plan.cols, dy = Math.floor(k / plan.cols);
        if (window.deckDistance(dx, dy, x, y) <= VENT_RADIUS && !F.tokens.some(t => t.x === dx && t.y === dy)) { delete nd[k]; closed++; }
    });
    F.vent = false;
    await afterWrite({ doors: nd });
    const hidden = fogOn() ? results.filter(o => !(o.c && o.c.is_npc === false)) : [];
    const shown = results.filter(o => !hidden.includes(o));
    const line = (o) => `${o.c ? o.c.name : '?'} ${rollText(o.r)}`;
    await postDeckChat(`💨 [AIRLOCK VENT] ${F.fight.name}: ${shown.length ? shown.map(line).join(' · ') : 'no one caught in the blast'}${closed ? ` · ${closed} door${closed > 1 ? 's' : ''} slammed shut` : ''}. (DM applies damage.)`);
    if (hidden.length) dmNotice(`💨 VENT (hidden from players): ${hidden.map(line).join(' · ')}`);
    renderDeckView();
    return results;
};
// Arsenal attack hook (combat.js resolveArsenalAttack): range bands and
// fog. Returns null (no deck fight / not both on the board), {refuse} or
// {mod, label}.
window.deckRangeCheck = function (wpn, targetId) {
    if (!F.fight) return null;
    const meTok = F.tokens.find(t => String(t.combatant_id) === String(myCombatantId()));
    if (!meTok) return null;
    const tc = combatantById(targetId);
    if (!tc || tc.is_strike_craft) return null;
    const tTok = F.tokens.find(t => String(t.combatant_id) === String(targetId));
    if (!tTok) return (fogOn() && !isDm() && tc.is_npc !== false) ? { refuse: "You can't see that target on the deck plan." } : null;
    const d = window.deckDistance(meTok.x, meTok.y, tTok.x, tTok.y);
    const rs = wpn && wpn.range_short != null ? +wpn.range_short : null;
    const rl = wpn && wpn.range_long != null ? +wpn.range_long : null;
    if (rl != null && d > rl) return { refuse: `Out of range: ${d} squares, ${wpn.name} reaches ${rl}.` };
    if (rs != null && d > rs) return { mod: -2, label: `Long range (${d} squares): -2` };
    return { mod: 0, squares: d };
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
    const cur = currentTok(), curC = fight.current_combatant_id ? combatantById(fight.current_combatant_id) : null;
    const fog = fogOn(), vis = fog ? visibleSet() : null;
    // Players never draw an NPC on a square their party can't see (the
    // server normally withholds those rows already; this covers the moment
    // before the reload lands).
    const shownToks = (!dm && fog) ? F.tokens.filter(t => isPcTok(t) || vis.has(t.y * plan.cols + t.x)) : F.tokens;
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
    const tokensHtml = shownToks.map(t => {
        const c = combatantById(t.combatant_id);
        const isCur = cur && cur.id === t.id;
        return `<div class="dkv-tok ${c && c.is_npc === false ? 'pc' : 'npc'}${isCur ? ' cur' : ''}${F.sel === t.id ? ' sel' : ''}${controls(t) ? ' mine' : ''}" data-tok="${t.id}" style="left:${t.x * cell}px; top:${t.y * cell}px; width:${cell}px; height:${cell}px; font-size:${Math.max(8, Math.round(cell * 0.38))}px;" title="${esc(c ? c.name : '?')}">${esc(initials(c ? c.name : '?'))}<span class="dkv-tokname">${esc(c ? c.name : '?')}</span></div>`;
    }).join('');
    const canEnd = dm ? F.tokens.length > 0 : !!(cur && controls(cur));
    const help = F.placing ? 'Click a floor square to place the token.' : F.vent ? 'VENT: click an airlock square. Everyone within 3 squares who can see it rolls ' + esc(plan.vent_dice || '2d6') + '; open doors nearby slam shut.' : F.los ? 'Line of sight: click a second square.' : (dm ? 'Drag any token (free for you). Click a door to open/close it. ' : 'On your turn, drag your token; highlighted squares are in reach. Click a door next to you to open/close it. ') + 'Use 👁 LOS to check sight between two squares.';
    v.innerHTML = `
        <div class="dkv-head">
            <div><span class="dkv-kicker">DECK FIGHT · 1 SQUARE = 1.5 M</span><h3 class="dkv-title">${esc(fight.name.toUpperCase())}</h3></div>
            <span class="dkv-chip">ROUND ${fight.round || 1}</span>
            <span class="dkv-chip dkv-turn">${curC ? '▶ ' + esc(curC.name.toUpperCase()) + "'S TURN" : 'NO TURN YET'}</span>
            ${canEnd ? `<button type="button" class="dkv-btn dkv-gold" onclick="window.deckNextTurn()">${dm ? 'NEXT TURN ⏭' : 'END MY TURN ⏭'}</button>` : ''}
            <span class="dkv-grow"></span>
            ${fog ? '<span class="dkv-chip dkv-fogchip" title="Fog of war: you only see what your party can see">🌫 FOG</span>' : ''}
            <button type="button" class="dkv-btn${F.los ? ' on' : ''}" onclick="window.deckLosArm()">👁 LOS</button>
            ${dm ? `<button type="button" class="dkv-btn${F.vent ? ' on' : ''}" onclick="window.deckVentArm()" title="Blow an airlock">💨 VENT</button>
                <button type="button" class="dkv-btn" onclick="window.deckToggleFog()" title="Fog of war for the players">${fog ? 'FOG: ON' : 'FOG: OFF'}</button>
                <button type="button" class="dkv-btn dkv-red" onclick="window.endDeckFight()">END FIGHT</button>` : ''}
            <button type="button" class="dkv-btn" onclick="window.closeDeckView()">✕ CLOSE</button>
        </div>
        <div class="dkv-body">
            <aside class="dkv-side">
                <div class="dkv-ttl">INITIATIVE</div>
                <div class="dkv-roster">${rosterRows}</div>
                ${sel && dm ? `<div class="dkv-ttl dkv-ttl2">SELECTED</div><label class="dkv-lab" for="dkv-mm">SQUARES PER TURN (blank = from Dexterity / 6)</label>
                    <input id="dkv-mm" type="number" min="0" max="30" value="${sel.move_max != null ? sel.move_max : ''}" onchange="window.deckSetMoveMax('${sel.id}', this.value)">` : ''}
                <div class="dkv-legend">${['f', 'w', 'd', 'c', 'h', 'a'].map(k => `<span><i class="dkv-sw dkv-sw-${k}"></i>${TILES[k].name}</span>`).join('')}</div>
                <div class="dkv-dice">HAZARD ${esc(plan.hazard_dice || '1d6')} · VENT ${esc(plan.vent_dice || '2d6')}</div>
                ${dm && dmLog.length ? `<div class="dkv-ttl dkv-ttl2">DECK LOG (DM ONLY)</div><div class="dkv-log">${dmLog.map(m => `<div>${esc(m)}</div>`).join('')}</div>` : ''}
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
        if (fogOn()) {
            const vis = visibleSet(), ex = String(fight.explored || ''), dm = isDm();
            for (let y = 0; y < plan.rows; y++) for (let x = 0; x < plan.cols; x++) {
                const k = y * plan.cols + x;
                if (vis.has(k)) continue;
                // DM: a light veil shows what the players can't see.
                // Players: never seen = black; seen before = dimmed.
                ctx.fillStyle = dm ? 'rgba(0,0,0,0.28)' : (ex[k] === '1' ? 'rgba(2,5,8,0.62)' : '#020406');
                ctx.fillRect(x * cell, y * cell, cell, cell);
            }
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
window.deckLosArm = function () { F.los = F.los ? null : { a: null, b: null }; F.placing = null; F.vent = false; renderDeckView(); };
window.deckToggleFog = async function () {
    if (!isDm() || !F.fight) return;
    await afterWrite({ fog: !fogOn() });
    renderDeckView();
};
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
    if (F.vent) {
        if (tileAt(plan, x, y) !== 'a') { say('VENT: click an airlock square.'); return; }
        await window.deckVent(x, y); return;
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
function blankPlan() { return { id: null, name: 'New Deck', cols: 32, rows: 24, tiles: '.'.repeat(32 * 24), notes: '', hazard_dice: '1d6', vent_dice: '2d6' }; }
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
    else if (field === 'hazard_dice' || field === 'vent_dice') {
        const ok = validDice(value);
        const el = document.getElementById(field === 'hazard_dice' ? 'dpe-hazard' : 'dpe-vent');
        if (el) el.classList.toggle('bad', !ok);
        if (!ok) return;
        P.plan[field] = ok;
    }
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
    const payload = { name: P.plan.name, cols: P.plan.cols, rows: P.plan.rows, tiles: normTiles(P.plan), notes: P.plan.notes || null,
        hazard_dice: validDice(P.plan.hazard_dice) || '1d6', vent_dice: validDice(P.plan.vent_dice) || '2d6', updated_at: new Date().toISOString() };
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
    const fogEl = document.getElementById('dpe-fog');
    const fog = fogEl ? fogEl.checked : true;
    await window.closeDeckPlanEditor();
    await window.startDeckFight({ plan: P.plan, fog });
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
                <div style="display:flex; gap:8px;"><div style="flex:1;"><label class="bme-lab" for="dpe-hazard" title="Rolled when a token ends its turn on a hazard square">HAZARD DICE</label><input type="text" id="dpe-hazard" value="${esc(p.hazard_dice || '1d6')}" placeholder="1d6" oninput="window.dpeField('hazard_dice', this.value)"></div>
                    <div style="flex:1;"><label class="bme-lab" for="dpe-vent" title="Rolled for each token caught by an airlock VENT">VENT DICE</label><input type="text" id="dpe-vent" value="${esc(p.vent_dice || '2d6')}" placeholder="2d6" oninput="window.dpeField('vent_dice', this.value)"></div></div>
                <label class="bme-lab" for="dpe-notes">DM NOTES</label>
                <textarea id="dpe-notes" rows="3" oninput="window.dpeField('notes', this.value)">${esc(p.notes || '')}</textarea>
                <div class="bme-actions"><button type="button" class="bme-btn bme-primary" onclick="window.dpeSave()">SAVE PLAN</button><button type="button" class="bme-btn bme-red" onclick="window.dpeDelete()">${p.id ? 'DELETE' : 'DISCARD'}</button></div>
                <label class="dkv-check"><input type="checkbox" id="dpe-fog" checked> FOG OF WAR (players see only what their party sees)</label>
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
        <label class="dkv-check"><input type="checkbox" id="dlp-fog" checked> FOG OF WAR</label>
        <p class="dkv-modal-p">Starting marks this deck CONTESTED; END FIGHT asks how it ended.</p>
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
    const fogEl = document.getElementById('dlp-fog');
    const fog = fogEl ? fogEl.checked : true;
    const box = document.getElementById('deck-link-picker'); if (box) box.style.display = 'none';
    await window.startDeckFight({ planId, shipId: vesselId, deckId: deck && deck.id, name: `${v.name} — ${deck.name}`, fog });
};

/* --- Ship templates: a template's deck can carry a plan link; Deploy
   deep-copies ship_decks, so the deployed ship arrives already linked. --- */
window.templateDeckPlanHtml = function (t, d, idx) {
    if (!window.deckPlansAllowed() || !t || !d) return '';
    const plans = window.deckPlansList || [];
    const known = !d.plan_id || plans.some(p => p.id === d.plan_id);
    return `<select class="dkv-tplsel" aria-label="Deck plan for ${esc(d.name)}" title="Deck plan used when this deck is boarded (DM only)" onchange="window.setTemplateDeckPlan('${esc(t.id)}', ${idx}, this.value)">
        <option value="">🗺 no plan</option>${known ? '' : `<option value="${esc(d.plan_id)}" selected>🗺 (linked plan)</option>`}
        ${plans.map(p => `<option value="${esc(p.id)}" ${p.id === d.plan_id ? 'selected' : ''}>🗺 ${esc(p.name)}</option>`).join('')}</select>`;
};
window.setTemplateDeckPlan = async function (templateId, idx, planId) {
    if (!isDm()) return false;
    const t = typeof findAnyTemplateById === 'function' ? findAnyTemplateById(templateId) : null;
    if (!t) return false;
    const decks = JSON.parse(JSON.stringify(t.ship_decks || []));
    if (!decks[idx]) return false;
    if (planId) decks[idx].plan_id = planId; else delete decks[idx].plan_id;
    const { error } = await db.from('ship_templates').update({ ship_decks: decks }).eq('id', templateId);
    if (error) { alert('Could not save the deck plan link: ' + error.message); return false; }
    t.ship_decks = decks;
    return true;
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
    const prof = (typeof allProfiles !== 'undefined' ? allProfiles : []).find(p => p.id === currentUserId);
    const wpn = prof && F.atkWeapon ? (prof.arsenal || []).find(w => w.id === F.atkWeapon) : null;
    const rc = F.fight ? window.deckRangeCheck(wpn, sel.value) : null;
    if (!rel && !(rc && rc.refuse)) { if (info) info.style.display = 'none'; return; }
    if (!info) { info = document.createElement('div'); info.id = 'atk-deck-info'; info.className = 'atk-deck-info'; sel.parentNode.insertBefore(info, sel.nextSibling); }
    info.style.display = '';
    if (!rel) { info.className = 'atk-deck-info blocked'; info.textContent = `🚪 Deck: ${rc.refuse} The shot will be refused.`; return; }
    const blocked = !rel.los || (rc && rc.refuse);
    info.className = 'atk-deck-info ' + (blocked ? 'blocked' : (rc && rc.mod ? 'warn' : 'ok'));
    info.textContent = `🚪 Deck: ${rel.squares} squares (${(rel.squares * 1.5).toFixed(1)} m) · ` + (!rel.los ? 'NO line of sight — the shot will be refused'
        : rc && rc.refuse ? rc.refuse + ' — the shot will be refused' : rc && rc.mod ? 'line of sight clear · past short range: -2 to hit' : 'line of sight clear');
}
window.deckAttackInfoRefresh = updateAttackInfo;
const origOpen = window.openArsenalAttackModal;
if (typeof origOpen === 'function') {
    window.openArsenalAttackModal = function (weaponId) {
        F.atkWeapon = weaponId;
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
