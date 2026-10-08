/* ==========================================================================
   js/battle-undo.js - Battle undo / redo log (battle_events), combat log export, and the list of actions recorded for undo. Loads after every file whose actions it wraps.
   Split out of js/battle-map.js (consolidation pass 2, 2026-10-08), code
   unchanged. Classic script sharing the global scope: loads right after
   battle-map.js (see index.html for the order).
   ========================================================================== */
/* ==========================================================================
   UNDO LOG (Command Terminal refactor: Phase 0 skeleton 2026-10-01,
   Phase 4a full undo 2026-10-02)
   ==========================================================================
   Every recorded Battle Map action writes one row to `battle_events`:
   what changed, as before/after values. The DM can then step back (UNDO)
   and forward again (REDO) through that list.

   Captured per step (Phase 4a):
   - battle_tokens: only the fields that changed (or the whole token for a
     placement / withdrawal / destruction)
   - battle_encounters: turn fields + in_flight_ordnance
   - ship_markers: combat fields that changed (UNDO_SHIP_FIELDS: hull,
     shields, armor layers + sides, weapons/ammo/cooldowns, squadrons,
     disabled systems, hidden, AI memory, cargo) for ANY ship, plus whole
     rows for ships the step created (reinforcement waves, launched strike
     craft) or deleted (recalled / destroyed strike craft)
   - battlefield_salvage and combat_tracker rows the step created / changed
     / deleted; battle_reinforcements (DM only: wave claimed / counters)

   Recorded: moves, turns (facing), placing / withdrawing, initiative, end
   turn (incl. the round it resolves), ADVANCE ROUND, weapon fire, ordnance
   and squadron launches/fire, DM Apply Damage, the health/armor/weapon
   +/- buttons, reset stats, hide/unhide, wave deploys.

   DM-confirmed rules (2026-10-02):
   - DM only, while the 'battle_undo' switch is on for them. Players' own
     actions are recorded so the DM can undo them.
   - A resolved round is ONE step and is undoable. REDO replays the exact
     results (nothing is re-rolled); to re-roll, undo it and resolve again.
   - Undoing a killing shot brings the ship back (token + hull) and removes
     the wreckage it spawned.
   - If something changed since the step, the DM is shown what and asked.
   - Whole battle, no limit. Chat is never rewritten ("⏪ DM undid ...").
   - Callsign renames are not undone.
   Known gap: if another player's change lands in this browser in the middle
   of one of our own actions, it can get folded into our step. */
const BATTLE_EVENT_ENC_FIELDS = ['turn_order', 'current_turn_index', 'round_number', 'initiative_rolled', 'pending_round_tick', 'in_flight_ordnance'];
const UNDO_SHIP_FIELDS = ['integrity_shields', 'integrity_hull', 'integrity_reactive', 'integrity_ablative', 'integrity_hardened', 'armor_sides',
    'ship_weapons', 'ship_deployed', 'ship_hangar', 'disabled_weapons_until', 'disabled_sensors_until', 'disabled_engines_until',
    'is_hidden', 'round_biggest_hit_amount', 'round_biggest_hit_by', 'ai_current_target_id', 'cargo_inventory'];
const UNDO_ROW_TABLES = ['battlefield_salvage', 'combat_tracker'];
const battleEventClone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const undoEq = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

function pickUndoShipFields(v) { const o = {}; UNDO_SHIP_FIELDS.forEach(f => { o[f] = battleEventClone(v[f]); }); return o; }

function snapshotBattleState() {
    const enc = window.globalBattleEncounterCache;
    if (!enc) return null;
    const toks = {};
    (enc.tokens || []).forEach(t => { toks[t.token_id] = battleEventClone(battleTokenObjToFields(t)); });
    const ef = {};
    BATTLE_EVENT_ENC_FIELDS.forEach(f => { ef[f] = battleEventClone(enc[f]); });
    return { encId: enc.id, toks, ef };
}
async function undoFetch(table, build) {
    try {
        let q = db.from(table).select('*');
        if (build) q = build(q);
        const { data, error } = await q;
        if (error) return null;
        return data || [];
    } catch (e) { return null; }
}
// The fuller snapshot used by recorded steps: tokens/turn fields (above) +
// ships (from this browser's cache, plus the ship ids that exist in the
// database so creates/deletes are caught) + the small row tables.
// withRows: also read the database for ship rows created/deleted and the
// small row tables -- only for steps that can do that (fire, launches,
// rounds, waves...), not for every token drag.
async function snapshotBattleStateFull(withRows) {
    const base = snapshotBattleState();
    if (!base) return null;
    base.ships = {};
    globalShipMarkersCache.forEach(v => { base.ships[v.id] = pickUndoShipFields(v); });
    if (!withRows) return base;
    const idRows = await undoFetch('ship_markers', q => q);
    base.shipIds = idRows ? new Set(idRows.map(r => r.id)) : null;
    // Whole rows that a step might delete (strike craft get removed on recall/destruction).
    base.shipRows = {};
    (idRows || []).forEach(r => { base.shipRows[r.id] = r; });
    base.tables = {};
    for (const t of UNDO_ROW_TABLES) {
        const rows = await undoFetch(t);
        base.tables[t] = rows ? Object.fromEntries(rows.map(r => [r.id, r])) : null;
    }
    if (currentUserRole === 'dm') {
        const rows = await undoFetch('battle_reinforcements', q => q.eq('encounter_id', base.encId));
        base.tables.battle_reinforcements = rows ? Object.fromEntries(rows.map(r => [r.id, r])) : null;
    }
    return base;
}

function diffRowTable(A, B) {
    if (!A || !B) return [];
    const out = [];
    new Set(Object.keys(A).concat(Object.keys(B))).forEach(id => {
        const a = A[id], b = B[id];
        if (!a && b) out.push({ id, op: 'create', after: battleEventClone(b) });
        else if (a && !b) out.push({ id, op: 'delete', before: battleEventClone(a) });
        else {
            const before = {}, after = {};
            Object.keys(Object.assign({}, a, b)).forEach(k => { if (!undoEq(a[k], b[k])) { before[k] = battleEventClone(a[k]); after[k] = battleEventClone(b[k]); } });
            if (Object.keys(after).length) out.push({ id, op: 'update', before, after });
        }
    });
    return out;
}

function diffBattleState(a, b) {
    const tokenChanges = [];
    const ids = new Set(Object.keys(a.toks).concat(Object.keys(b.toks)));
    ids.forEach(id => {
        const A = a.toks[id], B = b.toks[id];
        if (!A && B) tokenChanges.push({ id, op: 'create', after: B });
        else if (A && !B) tokenChanges.push({ id, op: 'delete', before: A });
        else {
            const before = {}, after = {};
            Object.keys(Object.assign({}, A, B)).forEach(k => {
                if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) { before[k] = A[k] === undefined ? null : A[k]; after[k] = B[k] === undefined ? null : B[k]; }
            });
            if (Object.keys(after).length > 0) tokenChanges.push({ id, op: 'update', before, after });
        }
    });
    const encBefore = {}, encAfter = {};
    BATTLE_EVENT_ENC_FIELDS.forEach(f => {
        if (JSON.stringify(a.ef[f]) !== JSON.stringify(b.ef[f])) { encBefore[f] = a.ef[f]; encAfter[f] = b.ef[f]; }
    });
    const encChanges = Object.keys(encAfter).length > 0 ? [{ id: b.encId, before: encBefore, after: encAfter }] : [];
    const out = { battle_tokens: tokenChanges, battle_encounters: encChanges };
    if (a.ships && b.ships) {
        const shipChanges = [];
        Object.keys(b.ships).forEach(id => {
            if (!a.ships[id]) return; // new ship: handled as a create below
            const before = {}, after = {};
            UNDO_SHIP_FIELDS.forEach(f => { if (!undoEq(a.ships[id][f], b.ships[id][f])) { before[f] = a.ships[id][f]; after[f] = b.ships[id][f]; } });
            if (Object.keys(after).length) shipChanges.push({ id, op: 'update', before, after });
        });
        if (a.shipIds && b.shipIds) {
            b.shipIds.forEach(id => { if (!a.shipIds.has(id) && b.shipRows[id]) shipChanges.push({ id, op: 'create', after: battleEventClone(b.shipRows[id]) }); });
            a.shipIds.forEach(id => { if (!b.shipIds.has(id) && a.shipRows[id]) shipChanges.push({ id, op: 'delete', before: battleEventClone(a.shipRows[id]) }); });
        }
        if (shipChanges.length) out.ship_markers = shipChanges;
        Object.keys(b.tables || {}).forEach(t => {
            const d = diffRowTable((a.tables || {})[t], b.tables[t]);
            if (d.length) out[t] = d;
        });
    }
    return out;
}
function battleChangesEmpty(ch) { return Object.keys(ch).every(k => !ch[k] || ch[k].length === 0); }

function battleTokenVesselName(tokenId, fieldsHint) {
    const enc = window.globalBattleEncounterCache;
    const tok = enc && (enc.tokens || []).find(t => t.token_id === tokenId);
    const markerId = (tok && tok.ship_marker_id) || (fieldsHint && fieldsHint.ship_marker_id);
    const v = markerId ? globalShipMarkersCache.find(m => m.id === markerId) : null;
    return v ? v.name : 'unit';
}
function battleShipName(id, rowHint) {
    const v = globalShipMarkersCache.find(m => m.id === id);
    return v ? v.name : ((rowHint && rowHint.name) || 'ship');
}
function describeBattleChange(base, changes) {
    const names = [];
    (changes.battle_tokens || []).forEach(c => {
        const n = battleTokenVesselName(c.id, c.after || c.before);
        if (!names.includes(n)) names.push(n);
    });
    (changes.ship_markers || []).forEach(c => {
        const n = battleShipName(c.id, c.after || c.before);
        if (!names.includes(n)) names.push(n);
    });
    if (names.length === 0) return base;
    return `${base}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`;
}

// Log writes run one at a time, in order, without making the caller wait.
const writeBattleEvent = window.serializeAsync(async function(row) {
    // A brand-new step discards whatever had been undone (the redo list).
    const { error: delErr } = await db.from('battle_events').delete().eq('encounter_id', row.encounter_id).eq('undone', true);
    if (delErr) console.error('undo log: could not clear the redo list', delErr);
    const { error } = await db.from('battle_events').insert(row);
    if (error) console.error('undo log: could not record a step', error);
}, 'battle undo log');

// Nested recorded actions (e.g. AI fire inside a round) fold into the outer step.
let battleRecordDepth = 0;
window.recordBattleAction = async function(label, fn, opts) {
    opts = opts || {};
    if (battleRecordDepth > 0) return fn();
    battleRecordDepth++;
    try {
        const withRows = opts.rows !== false && opts.rows !== undefined ? true : false;
        const before = await snapshotBattleStateFull(withRows);
        const result = await fn();
        if (!before) return result;
        // Ships created by this step only reach the cache after a reload; the
        // full rows come straight from the database below, so no reload here.
        const after = await snapshotBattleStateFull(withRows);
        if (!after || before.encId !== after.encId) return result;
        const changes = diffBattleState(before, after);
        if (battleChangesEmpty(changes)) return result;
        const roundResolved = (before.ef.round_number || 1) !== (after.ef.round_number || 1) && !!after.ef.initiative_rolled && !!before.ef.initiative_rolled;
        const isRound = roundResolved || opts.kind === 'round';
        const finalLabel = roundResolved
            ? `Round ${before.ef.round_number || 1} resolved`
            : (typeof label === 'function' ? label(changes) : describeBattleChange(label, changes));
        window.__lastBattleEventWrite = writeBattleEvent({
            encounter_id: after.encId, actor_id: currentUserId, label: finalLabel,
            kind: isRound ? 'round' : (opts.kind || 'action'), changes, undoable: opts.undoable !== false
        });
        return result;
    } finally { battleRecordDepth--; }
};

async function fetchBattleEvents(encounterId) {
    const { data, error } = await db.from('battle_events').select('*').eq('encounter_id', encounterId);
    if (error) { console.error('undo log: fetch failed', error); return null; }
    return (data || []).slice().sort((x, y) => (x.seq || 0) - (y.seq || 0));
}

function battleFieldsToToken(id, fields) {
    return battleTokenRowToObj(Object.assign({ id, x: 0, y: 0 }, fields));
}

async function applyBattleEvent(ev, direction) {
    const enc = window.globalBattleEncounterCache;
    if (!enc || enc.id !== ev.encounter_id) return false;
    const useKey = direction === 'undo' ? 'before' : 'after';
    const expectKey = direction === 'undo' ? 'after' : 'before';
    // On undo a 'create' is removed and a 'delete' comes back; redo the reverse.
    const shouldExistAfter = (c) => (c.op === 'create') === (direction === 'redo');
    const ch = ev.changes || {};
    const cur = {};
    (enc.tokens || []).forEach(t => { cur[t.token_id] = battleTokenObjToFields(t); });

    // Current rows of the other tables (for the "changed since?" check).
    const curRows = {};
    for (const t of Object.keys(ch)) {
        if (t === 'battle_tokens' || t === 'battle_encounters' || !(ch[t] || []).length) continue;
        const ids = ch[t].map(c => c.id);
        const rows = await undoFetch(t, q => q.in('id', ids));
        curRows[t] = rows ? Object.fromEntries(rows.map(r => [r.id, r])) : {};
    }

    // 1. Has anything moved on since this step? Ask before overwriting it.
    const conflicts = [];
    (ch.battle_tokens || []).forEach(c => {
        const name = battleTokenVesselName(c.id, c.after || c.before);
        const exists = !!cur[c.id];
        if (c.op === 'update') {
            if (!exists) { conflicts.push(`${name} is no longer on the grid`); return; }
            Object.keys(c[expectKey] || {}).forEach(k => {
                if (JSON.stringify(cur[c.id][k]) !== JSON.stringify(c[expectKey][k])) conflicts.push(`${name}: ${k} has changed since`);
            });
        } else {
            const shouldExist = (c.op === 'create') === (direction === 'undo');
            if (exists !== shouldExist) conflicts.push(`${name} ${exists ? 'is already' : 'is no longer'} on the grid`);
        }
    });
    (ch.battle_encounters || []).forEach(c => {
        Object.keys(c[expectKey] || {}).forEach(k => {
            if (JSON.stringify(battleEventClone(enc[k])) !== JSON.stringify(c[expectKey][k])) conflicts.push(`turn order: ${k} has changed since`);
        });
    });
    Object.keys(curRows).forEach(t => {
        (ch[t] || []).forEach(c => {
            const row = curRows[t][c.id];
            const name = t === 'ship_markers' ? battleShipName(c.id, c.after || c.before) : t.replace(/_/g, ' ');
            if (c.op === 'update') {
                if (!row) { conflicts.push(`${name} no longer exists`); return; }
                Object.keys(c[expectKey] || {}).forEach(k => { if (!undoEq(row[k], c[expectKey][k])) conflicts.push(`${name}: ${k.replace(/_/g, ' ')} has changed since`); });
            } else {
                const existsNow = !!row, shouldExistNow = !shouldExistAfter(c);
                if (existsNow !== shouldExistNow) conflicts.push(`${name} ${existsNow ? 'already exists' : 'no longer exists'}`);
            }
        });
    });
    if (conflicts.length > 0) {
        const list = Array.from(new Set(conflicts)).slice(0, 8).join('\n• ');
        if (!(await window.showConfirmModal(`Some of this has changed since "${ev.label}":\n• ${list}\n\n${direction === 'undo' ? 'Undo' : 'Redo'} anyway and overwrite those changes?`))) return false;
    }

    // 2. Rows that need to exist again (ships first, so their tokens find them).
    const rowTables = ['ship_markers'].concat(UNDO_ROW_TABLES, ['battle_reinforcements']);
    for (const t of rowTables) {
        for (const c of (ch[t] || [])) {
            if (c.op === 'update' || !shouldExistAfter(c)) continue;
            const row = c.op === 'create' ? c.after : c.before;
            if (curRows[t] && curRows[t][c.id]) continue; // already there
            const { error } = await db.from(t).insert(row);
            if (error) console.error(`undo: could not restore a ${t} row`, error);
        }
    }

    // 3. Tokens.
    let list = (enc.tokens || []).slice();
    (ch.battle_tokens || []).forEach(c => {
        const idx = list.findIndex(t => t.token_id === c.id);
        if (c.op === 'update') {
            if (idx < 0) return;
            const merged = Object.assign({}, battleTokenObjToFields(list[idx]), c[useKey]);
            list[idx] = battleFieldsToToken(c.id, merged);
        } else {
            const add = (c.op === 'create') ? (direction === 'redo') : (direction === 'undo');
            if (add) { if (idx < 0) list.push(battleFieldsToToken(c.id, c.op === 'create' ? c.after : c.before)); }
            else if (idx >= 0) list.splice(idx, 1);
        }
    });
    await saveBattleTokens(list);

    // 4. Updates to existing rows, then rows that must go away.
    for (const t of rowTables) {
        for (const c of (ch[t] || [])) {
            if (c.op !== 'update') continue;
            const patch = c[useKey] || {};
            if (!Object.keys(patch).length) continue;
            const { error } = await db.from(t).update(patch).eq('id', c.id);
            if (error) { console.error(`undo: could not restore ${t} ${c.id}`, error); continue; }
            if (t === 'ship_markers') { const v = globalShipMarkersCache.find(m => m.id === c.id); if (v) Object.assign(v, battleEventClone(patch)); }
        }
        for (const c of (ch[t] || [])) {
            if (c.op === 'update' || shouldExistAfter(c)) continue;
            // Only ever a row this same step created (undo) or removed (redo).
            const { error } = await db.from(t).delete().eq('id', c.id);
            if (error) console.error(`undo: could not remove a ${t} row`, error);
        }
    }

    // 5. Encounter fields (turn order, missiles in flight).
    for (const c of (ch.battle_encounters || [])) {
        const patch = c[useKey] || {};
        if (Object.keys(patch).length === 0) continue;
        const { error } = await db.from('battle_encounters').update(patch).eq('id', enc.id);
        if (error) { alert('Undo could not restore the turn order: ' + error.message); return false; }
        Object.assign(enc, battleEventClone(patch));
    }

    // 6. Refresh what other modules cache, mark the step, tell the table.
    if ((ch.ship_markers || []).some(c => c.op !== 'update') && typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
    if ((ch.battlefield_salvage || []).length && typeof window.loadBattlefieldSalvage === 'function') await window.loadBattlefieldSalvage();
    if ((ch.combat_tracker || []).length && typeof loadCombatTracker === 'function') { try { await loadCombatTracker(); } catch (e) {} }
    if ((ch.battle_reinforcements || []).length && typeof window.refreshPendingReinforcements === 'function') await window.refreshPendingReinforcements(true);
    const { error: markErr } = await db.from('battle_events').update({ undone: direction === 'undo' }).eq('id', ev.id);
    if (markErr) console.error('undo log: could not mark the step', markErr);
    await db.from('chat_logs').insert({ sender_id: null, content: `${direction === 'undo' ? '⏪ [BATTLE] DM undid' : '⏩ [BATTLE] DM redid'}: ${ev.label}`, message_type: 'system' });
    if (typeof window.renderVesselDeck === 'function') { try { window.renderVesselDeck(); } catch (e) {} }
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return true;
}

let battleUndoInFlight = false;
window.undoLastBattleAction = async function() {
    if (currentUserRole !== 'dm' || battleUndoInFlight) return;
    const enc = window.globalBattleEncounterCache;
    if (!enc) return;
    battleUndoInFlight = true;
    try {
        if (window.__lastBattleEventWrite) await window.__lastBattleEventWrite;
        const events = await fetchBattleEvents(enc.id);
        if (!events) return;
        const live = events.filter(e => !e.undone);
        const ev = live[live.length - 1];
        if (!ev) { window.showToast ? window.showToast('Nothing to undo.') : alert('Nothing to undo.'); return; }
        if (!ev.undoable) {
            // Only rounds recorded before full undo (2026-10-02) are like this.
            alert(`The last step was "${ev.label}" -- recorded before full undo existed, so it can't be undone, and nothing before it can be either.`);
            return;
        }
        await applyBattleEvent(ev, 'undo');
    } finally { battleUndoInFlight = false; }
};
window.redoBattleAction = async function() {
    if (currentUserRole !== 'dm' || battleUndoInFlight) return;
    const enc = window.globalBattleEncounterCache;
    if (!enc) return;
    battleUndoInFlight = true;
    try {
        const events = await fetchBattleEvents(enc.id);
        if (!events) return;
        const ev = events.filter(e => e.undone)[0];
        if (!ev) { window.showToast ? window.showToast('Nothing to redo.') : alert('Nothing to redo.'); return; }
        await applyBattleEvent(ev, 'redo');
    } finally { battleUndoInFlight = false; }
};

/* --- Combat log export (Phase 4a, DM) ---
   A .txt of the battle: every recorded step (time, who, what, undone or
   not) and the chat lines since the battle started (dice results included). */
window.buildBattleCombatLogText = async function() {
    const enc = window.globalBattleEncounterCache;
    if (!enc) return null;
    const events = (await fetchBattleEvents(enc.id)) || [];
    const profs = (typeof allProfiles !== 'undefined' && Array.isArray(allProfiles)) ? allProfiles : [];
    const who = (id) => {
        const p = profs.find(x => x.id === id);
        if (p) return p.role === 'dm' ? 'DM' : (p.username || 'player');
        if (id && id === currentUserId) return currentUserRole === 'dm' ? 'DM' : 'you';
        return id ? 'player' : 'system';
    };
    const when = (t) => { try { return t ? new Date(t).toLocaleString() : ''; } catch (e) { return String(t || ''); } };
    let chats = [];
    if (enc.created_at) chats = (await undoFetch('chat_logs', q => q.gte('created_at', enc.created_at))) || [];
    chats = chats.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const lines = [];
    lines.push(`DARKFOREST — COMBAT LOG`);
    lines.push(`Battle: ${enc.name || 'Untitled'}   Started: ${when(enc.created_at)}   Exported: ${new Date().toLocaleString()}`);
    lines.push('');
    lines.push(`== STEPS (${events.length}) ==`);
    events.forEach((e, i) => lines.push(`${String(i + 1).padStart(3, ' ')}. [${when(e.created_at)}] ${who(e.actor_id)} — ${e.label}${e.undone ? '  (UNDONE)' : ''}${e.kind === 'round' ? '  [ROUND]' : ''}`));
    lines.push('');
    lines.push(`== CHAT & DICE (${chats.length}) ==`);
    chats.forEach(c => {
        const text = String(c.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        lines.push(`[${when(c.created_at)}] ${c.sender_id ? who(c.sender_id) : 'SYSTEM'}: ${text}`);
    });
    return lines.join('\n');
};
window.exportBattleCombatLog = async function() {
    if (currentUserRole !== 'dm') return;
    const text = await window.buildBattleCombatLogText();
    if (!text) { alert('No active battle.'); return; }
    const enc = window.globalBattleEncounterCache;
    const safe = String(enc.name || 'battle').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'battle';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `combat-log-${safe}-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

// Record the remaining Battle Map actions by wrapping them in place. Each
// original stays reachable as fn.__unrecorded (handy for tests/debugging).
// Later scripts call window.wrapBattleActionForUndo for their own actions.
window.wrapBattleActionForUndo = function(name, label, opts) {
    const orig = window[name];
    if (typeof orig !== 'function' || orig.__unrecorded) return;
    const wrapped = function(...args) { return window.recordBattleAction(label, () => orig.apply(this, args), opts); };
    wrapped.__unrecorded = orig;
    window[name] = wrapped;
};
(function wrapRecordedBattleActions() {
    const wrap = window.wrapBattleActionForUndo;
    wrap('handleBattleGridClick', 'Place on grid');
    wrap('removeBattleToken', 'Withdraw from grid');
    wrap('rollBattleInitiative', 'Roll initiative');
    // End turn can resolve a whole round (AI fire, waves, recalls), so it reads rows too.
    wrap('endCurrentTurn', (changes) => {
        const next = (changes.battle_tokens || []).find(c => c.op === 'update' && c.after && 'ap_current' in c.after);
        return next ? `End turn → ${battleTokenVesselName(next.id)}'s turn` : 'End turn';
    }, { rows: true });
    // Phase 4a: everything that changes ships.
    const R = { rows: true };
    wrap('advanceCombatRound', 'Advance round', { kind: 'round', rows: true });
    wrap('rollShipWeapon', 'Fire', R);
    wrap('launchOrdnance', 'Launch ordnance', R);
    wrap('rollSquadronWeapon', 'Squadron fire', R);
    wrap('launchSquadronOrdnance', 'Squadron launch', R);
    wrap('launchSquadron', 'Launch squadron', R);
    wrap('recallSquadron', 'Recall squadron', R);
    wrap('applyManualDamage', 'DM damage', R);
    wrap('modifyShipHealth', 'Adjust health');
    wrap('modifyShipWeaponStat', 'Adjust weapon');
    wrap('resetShipStats', 'Reset combat stats');
    wrap('toggleVesselHidden', 'Hide / unhide');
})();

// UNDO / REDO buttons follow the DM + feature switch; re-check when switches change.
document.addEventListener('darkforest:features-changed', () => { if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel(); });
