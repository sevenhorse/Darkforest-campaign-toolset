/* ==========================================================================
   js/battle-map.js - Tactical Battle Map core
   ==========================================================================
   Encounter loading/realtime, per-row token storage, deploy actions, range
   rules, the DOM renderer, and the panel render + render-hook registry.
   A battle token is a placement record pointing at a real ship_markers row
   (deploys go through window.deployShipTemplate), never a separate entity.
   Only one battle is active at a time; starting a new one marks the old
   row inactive instead of deleting it.
   Movement: move_remaining (per token, per battle) refreshes on the global
   round tick; allowance is ship_markers.tactical_speed (grid px/round), not
   the galaxy-scale FTL speed. Overspending is allowed but shown in red with
   a "!" badge -- enforcement is DM-trusted. */

window.globalBattleEncounterCache = null;
window.battleMapArmedToken = null; // { ship_marker_id } while a palette entry is armed for click-to-place, else null

function genBattleTokenId() { return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ('tok-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)); }

// Logical grid size in px (Standard map). index.html's #battle-map-grid
// inline width/height must match; applyBattleGridSize changes both.
let BATTLE_GRID_W = 920;
let BATTLE_GRID_H = 760;
/* DM decision: a saved map picks one of 3 fixed sizes. Range bands and
   tactical_speed stay the same distances on every size -- a bigger map just
   means more room. Size comes from battle_encounters.map.size; no map or an
   unknown size = Standard. */
window.BATTLE_MAP_SIZES = { standard: [920, 760], large: [1380, 1140], huge: [1840, 1520] };
window.battleGridSize = function () { return { w: BATTLE_GRID_W, h: BATTLE_GRID_H }; };
window.applyBattleGridSize = function (sizeKey) {
    const s = window.BATTLE_MAP_SIZES[sizeKey] || window.BATTLE_MAP_SIZES.standard;
    if (s[0] === BATTLE_GRID_W && s[1] === BATTLE_GRID_H) return false;
    BATTLE_GRID_W = s[0]; BATTLE_GRID_H = s[1];
    const grid = document.getElementById('battle-map-grid');
    if (grid) { grid.style.width = BATTLE_GRID_W + 'px'; grid.style.height = BATTLE_GRID_H + 'px'; }
    // Overlays drawn by other modules size themselves on creation; resize them.
    ['battle-arc-overlay', 'battle-tools-overlay', 'tv2-overlay', 'battle-terrain-layer'].forEach(id => {
        const svg = document.getElementById(id);
        if (!svg) return;
        svg.setAttribute('width', String(BATTLE_GRID_W));
        svg.setAttribute('height', String(BATTLE_GRID_H));
        svg.setAttribute('viewBox', `0 0 ${BATTLE_GRID_W} ${BATTLE_GRID_H}`);
    });
    document.dispatchEvent(new CustomEvent('darkforest:grid-size', { detail: { w: BATTLE_GRID_W, h: BATTLE_GRID_H } }));
    return true;
};
const BATTLE_TOKEN_SIZE = 34;
// Strike craft tokens are drawn smaller than ships/stations (DM-tunable).
const BATTLE_STRIKE_CRAFT_TOKEN_SIZE = 20;

// Visual-only zoom: the grid is scaled up by a CSS transform in index.html.
// Logical coordinates (token x/y, ranges, tactical_speed) are unaffected, so
// raw mouse-pixel deltas must be divided by this factor. Keep it in sync with
// index.html's transform:scale() and wrapper size.
const BATTLE_GRID_SCALE = 1.5;

/* DM rule: weapon range bands in grid px, roughly 33% / 16.5% / 8.25% of the
   Standard grid's diagonal (~1193 px). Ship-mounted ordnance uses range 0
   (unlimited) because it travels over several rounds; strike craft close
   distance by moving. getEffectiveWeaponRange applies the strike craft caps
   and the Messenger uplink exception on top of these. */
window.BATTLE_RANGE_TIERS = { LONG: 400, MEDIUM: 200, SHORT: 100 };
// DM rule: strike craft reach (px). See getEffectiveWeaponRange.
window.STRIKE_CRAFT_RANGES = { GUN: 90, ORDNANCE: 200 };
window.strikeCraftRangeCap = function(wpn) {
    return (wpn && wpn.weapon_class === 'ordnance') ? window.STRIKE_CRAFT_RANGES.ORDNANCE : window.STRIKE_CRAFT_RANGES.GUN;
};

/* Target uplink: an enemy ship within SHORT range of a Messenger-type
   squadron owned by forOwnerIds' side is "uplinked" for that side.
   Recomputed on every call; nothing persists. Passive effect, so it ignores
   the Messenger's ai_stance. Returns a Set of enemy ship_marker ids.
   (The exact trigger was an interpretation, not a confirmed DM spec.) */
function getUplinkedEnemyIds(forOwnerIds) {
    if (!window.globalBattleEncounterCache) return new Set();
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const messengerPositions = [];
    tokens.forEach(t => {
        const marker = globalShipMarkersCache.find(m => m.id === t.ship_marker_id);
        if (!marker || !marker.is_strike_craft || !window.ownerIdsShareOwner(window.vesselOwnerIds(marker), forOwnerIds)) return;
        const carrier = globalShipMarkersCache.find(c => c.id === marker.parent_id);
        const sq = carrier && (carrier.ship_deployed || []).find(s => s.id === marker.squadron_id);
        if (sq && sq.type === 'messenger') messengerPositions.push({ x: t.x, y: t.y });
    });
    const uplinked = new Set();
    if (messengerPositions.length === 0) return uplinked;
    tokens.forEach(t => {
        const target = globalShipMarkersCache.find(m => m.id === t.ship_marker_id);
        if (!target || window.ownerIdsShareOwner(window.vesselOwnerIds(target), forOwnerIds)) return; // only enemy ships get uplinked
        const isClose = messengerPositions.some(mp => Math.hypot(mp.x - t.x, mp.y - t.y) <= window.BATTLE_RANGE_TIERS.SHORT);
        if (isClose) uplinked.add(target.id);
    });
    return uplinked;
}
window.getUplinkedEnemyIds = getUplinkedEnemyIds;

/* Effective max range (px) for `wpn` fired by `firerVessel` at
   `targetVessel` this round; 0 = unlimited. Used by manual fire and AI
   auto-fire. Rules, in order:
     1. Uplink: if the target is uplinked for the firer's side and the
        weapon's own range is MEDIUM or more, range is unlimited this round
        (applies to strike craft too). Short-range or unlimited weapons gain
        nothing.
     2. DM rule: every strike craft weapon is capped against any target --
        guns/rockets/PD at 90, ordnance at 200 -- whatever the chassis lists.
     3. Otherwise the weapon's own range. */
function getEffectiveWeaponRange(wpn, firerVessel, targetVessel) {
    const tiers = window.BATTLE_RANGE_TIERS || { LONG: 400, MEDIUM: 200, SHORT: 100 };
    const baseRange = (wpn && wpn.range) || 0; // 0 = unlimited

    if (firerVessel && targetVessel && baseRange >= tiers.MEDIUM) {
        const uplinked = getUplinkedEnemyIds(window.vesselOwnerIds(firerVessel));
        if (uplinked.has(targetVessel.id)) return 0; // unlimited this round
    }

    if (firerVessel && firerVessel.is_strike_craft) {
        const cap = window.strikeCraftRangeCap(wpn);
        return baseRange > 0 ? Math.min(baseRange, cap) : cap;
    }

    return baseRange;
}
window.getEffectiveWeaponRange = getEffectiveWeaponRange;

/* Rendering state. Token and ordnance elements persist across renders (the
   grid is diffed, not rebuilt), so CSS transitions can animate moves.
   Strike craft tokens use the same path. */
let battleMapTokenEls = {};        // token_id -> token DOM element (reused across renders)
let battleMapTokenMarkerIds = {};  // token_id -> ship_marker_id, kept after the token leaves `tokens` (for the destruction effect)
let battleMapPendingExplosions = []; // [{token_id, x, y}] staged by checkBattleTokenDestroyed just before a destroyed token is removed
let battleMapOrdnanceEls = {};     // salvo_id -> ordnance marker DOM element
let battleMapPrevOrdnanceIds = new Set(); // salvo_ids seen on the previous render, to detect resolved/removed payloads
let battleMapLastEncounterId = null; // when the active battle changes, all of the above are reset

/* --- PER-ROW TOKEN STORAGE ---
   Tokens live in the `battle_tokens` table, one row per token (id = token_id),
   so concurrent moves don't overwrite each other. In memory,
   window.globalBattleEncounterCache.tokens stays an array of
   { token_id, ship_marker_id, x, y, move_remaining, initiative?, ap_current?, ... }.
   saveBattleTokens(newArray) diffs against the last saved snapshot and writes
   only inserts / changed columns / deletes. Other clients apply per-row
   realtime deltas (battle_tokens_stream). Fields not in BATTLE_TOKEN_COLUMNS
   go into the row's `extra` jsonb.
   Legacy battles: on load, tokens still in the old battle_encounters.tokens
   jsonb column are copied into battle_tokens (duplicate-safe), the column is
   emptied and tokens_migrated is set. */
const BATTLE_TOKEN_COLUMNS = ['ship_marker_id', 'x', 'y', 'z', 'facing', 'move_remaining', 'initiative', 'ap_current', 'turned_round', 'callsign_base', 'callsign_index'];
let battleTokenSnapshot = {};           // token_id -> row fields as last saved/received (diff baseline)
let battleTokenSnapshotEncounterId = null;
let battleTokenLocalWriteAt = {};       // token_id -> ISO time of this client's newest write (ignores older echoes)
let battleTokenSortSeq = 0;

function battleTokenRowToObj(r) {
    const t = { token_id: r.id, ship_marker_id: r.ship_marker_id, x: r.x, y: r.y };
    BATTLE_TOKEN_COLUMNS.forEach(c => {
        if (c === 'ship_marker_id' || c === 'x' || c === 'y') return;
        if (r[c] !== null && r[c] !== undefined) t[c] = r[c];
    });
    if (r.extra && typeof r.extra === 'object') Object.keys(r.extra).forEach(k => { if (!(k in t)) t[k] = r.extra[k]; });
    return t;
}
function battleTokenObjToFields(t) {
    const f = {};
    BATTLE_TOKEN_COLUMNS.forEach(c => { f[c] = (t[c] === undefined) ? null : t[c]; });
    if (f.x === null) f.x = 0;
    if (f.y === null) f.y = 0;
    if (f.z === null) f.z = 0;
    if (f.facing === null) f.facing = 0;
    const extra = {};
    Object.keys(t).forEach(k => { if (k !== 'token_id' && !BATTLE_TOKEN_COLUMNS.includes(k)) extra[k] = t[k]; });
    f.extra = extra;
    return f;
}
function resetBattleTokenSnapshot(encounterId, tokens) {
    battleTokenSnapshotEncounterId = encounterId;
    battleTokenSnapshot = {};
    (tokens || []).forEach(t => { battleTokenSnapshot[t.token_id] = battleTokenObjToFields(t); });
}
function nextBattleTokenSortOrder() {
    battleTokenSortSeq = (battleTokenSortSeq + 1) % 1000;
    return Date.now() + battleTokenSortSeq / 1000;
}

async function importLegacyBattleTokens(encounter, existingRows) {
    const legacy = Array.isArray(encounter.tokens) ? encounter.tokens : [];
    const have = new Set((existingRows || []).map(r => r.id));
    const base = Date.now();
    const rows = legacy.filter(t => t && t.token_id && !have.has(t.token_id)).map((t, i) => ({
        id: t.token_id, encounter_id: encounter.id, ...battleTokenObjToFields(t), sort_order: base + i / 1000
    }));
    if (rows.length > 0) {
        const { error } = await db.from('battle_tokens').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
        if (error) { console.error('importLegacyBattleTokens: copy failed', error); return false; }
    }
    // Empty the legacy column after copying, so anything written there later
    // (a browser still running old cached code) is imported on the next load
    // instead of being invisible to everyone else.
    const { error: flagErr } = await db.from('battle_encounters').update({ tokens_migrated: true, tokens: [] }).eq('id', encounter.id);
    if (flagErr) console.error('importLegacyBattleTokens: could not set tokens_migrated', flagErr);
    return true;
}

async function fetchBattleTokenRows(encounterId) {
    const { data, error } = await db.from('battle_tokens').select('*').eq('encounter_id', encounterId).order('sort_order', { ascending: true });
    if (error) { console.error('fetchBattleTokenRows failed', error); return null; }
    return (data || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

async function loadBattleEncountersInner() {
    // Runs on every client (via battle_encounters_stream), so the
    // active-state edge below starts/stops battle music for the whole table.
    const wasActive = !!window.globalBattleEncounterCache;
    const prevCache = window.globalBattleEncounterCache;
    const { data, error } = await db.from('battle_encounters').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(1);
    if (error) { console.error('loadBattleEncounters failed', error); return; }
    const encounter = (data && data.length > 0) ? data[0] : null;
    if (encounter) {
        let rows = await fetchBattleTokenRows(encounter.id);
        if (rows === null) {
            // Token fetch failed -- keep whatever tokens we already had for this
            // same battle rather than blanking the grid on a network blip.
            encounter.tokens = (prevCache && prevCache.id === encounter.id) ? (prevCache.tokens || []) : [];
        } else {
            const legacyTokens = Array.isArray(encounter.tokens) ? encounter.tokens : [];
            if (!encounter.tokens_migrated || legacyTokens.length > 0) {
                if (encounter.tokens_migrated && legacyTokens.length > 0) console.warn('Battle Map: tokens found in the legacy column -- a browser is still running the old build. Importing them.');
                await importLegacyBattleTokens(encounter, rows);
                const again = await fetchBattleTokenRows(encounter.id);
                if (again !== null) rows = again;
            }
            // A token this client wrote more recently than the row we just
            // read keeps its local (newer) value -- avoids a load that raced a
            // local save from snapping a token back for a moment.
            const prevById = {};
            if (prevCache && prevCache.id === encounter.id) (prevCache.tokens || []).forEach(t => { prevById[t.token_id] = t; });
            encounter.tokens = rows.map(r => {
                const localAt = battleTokenLocalWriteAt[r.id];
                if (localAt && prevById[r.id] && (!r.updated_at || localAt > r.updated_at)) return prevById[r.id];
                return battleTokenRowToObj(r);
            });
        }
        resetBattleTokenSnapshot(encounter.id, encounter.tokens);
    }
    window.globalBattleEncounterCache = encounter;
    window.applyBattleGridSize(encounter && encounter.map && encounter.map.size);
    const isActive = !!window.globalBattleEncounterCache;
    if (window.AudioEngine) {
        if (isActive && !wasActive) window.AudioEngine.startBattleMusic();
        else if (!isActive && wasActive) window.AudioEngine.stopBattleMusic();
    }
    if (typeof window.syncBattleBroadcastChannel === 'function') window.syncBattleBroadcastChannel();
    if (typeof window.maybeResolvePendingRoundTick === 'function') window.maybeResolvePendingRoundTick();
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
}
// Coalesced: many realtime events in a burst collapse into one reload, and
// an await-er always gets a load that started after its own call.
const loadBattleEncounters = window.coalesceAsync(loadBattleEncountersInner);

// Coalesce many per-row token events (e.g. a whole fleet deploy) into one render.
let battleMapRenderScheduled = false;
function scheduleBattleMapRender() {
    if (battleMapRenderScheduled) return;
    battleMapRenderScheduled = true;
    setTimeout(() => {
        battleMapRenderScheduled = false;
        if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    }, 16);
}

function applyBattleTokenRealtime(payload) {
    const enc = window.globalBattleEncounterCache;
    if (!enc || !payload) return;
    const type = payload.eventType;
    if (type === 'DELETE') {
        const id = payload.old && payload.old.id;
        if (!id) return;
        if (!(enc.tokens || []).some(t => t.token_id === id)) { delete battleTokenSnapshot[id]; return; }
        enc.tokens = (enc.tokens || []).filter(t => t.token_id !== id);
        delete battleTokenSnapshot[id];
        scheduleBattleMapRender();
        return;
    }
    const r = payload.new;
    if (!r || r.encounter_id !== enc.id) return;
    const localAt = battleTokenLocalWriteAt[r.id];
    if (localAt && r.updated_at && r.updated_at < localAt) return; // stale echo of an older write of ours
    const obj = battleTokenRowToObj(r);
    const list = (enc.tokens || []).slice();
    const idx = list.findIndex(t => t.token_id === r.id);
    if (idx >= 0) {
        if (JSON.stringify(battleTokenObjToFields(list[idx])) === JSON.stringify(battleTokenObjToFields(obj))) { battleTokenSnapshot[r.id] = battleTokenObjToFields(obj); return; }
        list[idx] = obj;
    } else {
        list.push(obj);
    }
    enc.tokens = list;
    battleTokenSnapshot[r.id] = battleTokenObjToFields(obj);
    scheduleBattleMapRender();
}

let battleEncountersRealtimeChannel = null;
let battleTokensRealtimeChannel = null;
function initBattleEncountersRealtimeChannel() {
    battleEncountersRealtimeChannel = db.channel('battle_encounters_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'battle_encounters' }, () => {
            loadBattleEncounters();
        })
        .subscribe();
    battleTokensRealtimeChannel = db.channel('battle_tokens_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'battle_tokens' }, (payload) => {
            applyBattleTokenRealtime(payload);
        })
        .subscribe();
}
/* Server-side fog of war: battle_tokens' read rule (public.df_battle_token_visible)
   hides tokens of hidden ships from everyone but the DM and the ship's owners.
   Realtime never re-sends a row that just BECAME visible, so when a ship this
   player couldn't see turns visible we re-fetch the battle's tokens.
   Called from the ship_markers realtime handler (js/db.js) after the vessel
   cache refreshes. The first call only seeds the set; no-op for the DM.
   Returns true if a reload was triggered. */
let battleFogHiddenFromMe = null;
window.battleFogCheckReveal = function() {
    if (typeof currentUserRole !== 'undefined' && currentUserRole === 'dm') return false;
    const ships = (typeof globalShipMarkersCache !== 'undefined' && Array.isArray(globalShipMarkersCache)) ? globalShipMarkersCache : [];
    const visible = (typeof window.isVesselVisibleToMe === 'function') ? window.isVesselVisibleToMe : (v => !v || !v.is_hidden);
    const now = new Set(ships.filter(s => s && !visible(s)).map(s => String(s.id)));
    const prev = battleFogHiddenFromMe;
    battleFogHiddenFromMe = now;
    if (!prev) return false;
    let revealed = false;
    prev.forEach(id => { if (!now.has(id)) revealed = true; });
    if (revealed && window.globalBattleEncounterCache) { loadBattleEncounters(); return true; }
    return false;
};
window.initBattleEncountersRealtimeChannel = initBattleEncountersRealtimeChannel;
window.loadBattleEncounters = loadBattleEncounters;
window.applyBattleTokenRealtime = applyBattleTokenRealtime;

/* --- BATTLE BROADCAST CHANNEL ---
   An ephemeral Supabase Realtime broadcast channel per battle
   ('battle:<encounter id>') for things everyone should see but nothing
   stores: weapon-fire effects, destruction explosions, the shared measuring
   tape. self:false -- a sender never receives its own message, so nothing
   plays twice. Receivers skip effects involving vessels they can't see. */
let battleBroadcastChannel = null;
let battleBroadcastEncounterId = null;
window.syncBattleBroadcastChannel = function() {
    const enc = window.globalBattleEncounterCache;
    const id = enc ? enc.id : null;
    if (id === battleBroadcastEncounterId) return;
    if (battleBroadcastChannel) {
        try { if (typeof db.removeChannel === 'function') db.removeChannel(battleBroadcastChannel); } catch (e) { console.warn('battle broadcast: removeChannel failed', e); }
        battleBroadcastChannel = null;
    }
    battleBroadcastEncounterId = id;
    if (!id) return;
    battleBroadcastChannel = db.channel('battle:' + id, { config: { broadcast: { self: false } } })
        .on('broadcast', { event: 'fx' }, (msg) => { handleRemoteBattleFx(msg && msg.payload); })
        .subscribe();
};
window.sendBattleBroadcast = function(event, payload) {
    if (!battleBroadcastChannel || typeof battleBroadcastChannel.send !== 'function') return;
    try {
        const p = battleBroadcastChannel.send({ type: 'broadcast', event, payload: Object.assign({ v: 1, u: currentUserId }, payload) });
        if (p && typeof p.then === 'function') p.then(null, err => console.warn('battle broadcast: send failed', err));
    } catch (e) { console.warn('battle broadcast: send failed', e); }
};
function handleRemoteBattleFx(p) {
    if (!p || p.v !== 1 || !window.globalBattleEncounterCache) return;
    const visible = (id) => {
        const v = globalShipMarkersCache.find(m => m.id === id);
        if (!v) return true; // already gone (e.g. destroyed) -- nothing left to hide
        return (typeof window.isVesselVisibleToMe === 'function') ? window.isVesselVisibleToMe(v) : true;
    };
    if (p.k === 'fire') {
        if (!visible(p.src) || !visible(p.dst)) return;
        // Receivers hear the shot too; the impact sound follows it.
        if (window.AudioEngine && window.AudioEngine.playShoot) { try { window.AudioEngine.playShoot(); } catch (e) {} }
        window.playWeaponFireEffect(p.src, p.dst, p.col || undefined, p.dmg || undefined, true);
    } else if (p.k === 'boom') {
        if (p.marker && !visible(p.marker)) return;
        if (typeof p.x !== 'number' || typeof p.y !== 'number') return;
        window.battleRenderer.destruction(p.x, p.y);
    } else if (p.k === 'tape' && typeof window.showRemoteTape === 'function') {
        window.showRemoteTape(p); // shared measuring tape (js/grid-tools.js)
    }
}
window.handleRemoteBattleFx = handleRemoteBattleFx;

window.toggleBattleMap = function() {
    const panel = document.getElementById('battle-map-panel');
    if (!panel) return;
    const opening = panel.style.display !== 'block';
    panel.style.display = opening ? 'block' : 'none';
    if (opening) { loadBattleEncounters(); }
};

window.startBattleEncounter = async function() {
    if (currentUserRole !== 'dm') return;
    const nameInput = document.getElementById('battle-map-name-input');
    const name = (nameInput && nameInput.value.trim()) || 'Untitled Engagement';

    if (window.globalBattleEncounterCache) {
        if (!(await window.showConfirmModal(`An engagement ("${window.globalBattleEncounterCache.name}") is already active. Starting a new one will end it (its record is kept, just marked inactive). Proceed?`))) return;
        await db.from('battle_encounters').update({ is_active: false }).eq('id', window.globalBattleEncounterCache.id);
    }

    // Optional map from the library (js/battle-maps.js), stored as a snapshot.
    const map = typeof window.pickedStartMap === 'function' ? window.pickedStartMap() : null;
    // Terrain rules are per battle, stored on the map snapshot.
    if (map) map.rules = typeof window.terrainRulesAllowed === 'function' && window.terrainRulesAllowed() && typeof window.terrainRulesDefaultFor === 'function' && window.terrainRulesDefaultFor(map);
    const { error } = await db.from('battle_encounters').insert({ name, is_active: true, created_by: currentUserId, tokens: [], tokens_migrated: true, map });
    if (error) { alert('Failed to start battle: ' + error.message); return; }
    if (nameInput) nameInput.value = '';
    await db.from('chat_logs').insert({ sender_id: null, content: `⚔️ [TACTICAL BATTLE MAP] Engagement started: "${name}".`, message_type: 'system' });
    if (window.AudioEngine) window.AudioEngine.playKlaxon();
    loadBattleEncounters();
};

window.endBattleEncounter = async function() {
    if (currentUserRole !== 'dm' || !window.globalBattleEncounterCache) return;
    if (!(await window.showConfirmModal(`End engagement "${window.globalBattleEncounterCache.name}"? The record is kept (marked inactive), tokens' underlying vessels are untouched.`))) return;
    await db.from('battle_encounters').update({ is_active: false }).eq('id', window.globalBattleEncounterCache.id);
    await db.from('chat_logs').insert({ sender_id: null, content: `⚔️ [TACTICAL BATTLE MAP] Engagement ended: "${window.globalBattleEncounterCache.name}".`, message_type: 'system' });
    loadBattleEncounters();
};

/* Pass the complete new token array. Updates the local cache immediately
   (after separateBattleTokens), then writes only the differences to
   battle_tokens (see PER-ROW TOKEN STORAGE). Resolves once every write has
   settled; on any failed write it reloads the encounter from the database. */
async function saveBattleTokens(tokens) {
    const enc = window.globalBattleEncounterCache;
    if (!enc) return;
    if (battleTokenSnapshotEncounterId === enc.id) { try { tokens = separateBattleTokens(tokens); } catch (e) { console.error('separateBattleTokens failed', e); } }
    enc.tokens = tokens;
    await persistBattleTokenDiff(enc, tokens);
}
async function persistBattleTokenDiff(enc, tokens) {
    if (battleTokenSnapshotEncounterId !== enc.id) resetBattleTokenSnapshot(enc.id, []);
    const nowIso = new Date().toISOString();
    const seen = new Set();
    const inserts = [];
    const updates = [];
    (tokens || []).forEach(t => {
        if (!t || !t.token_id) return;
        seen.add(t.token_id);
        const fields = battleTokenObjToFields(t);
        const prev = battleTokenSnapshot[t.token_id];
        if (!prev) {
            inserts.push({ id: t.token_id, encounter_id: enc.id, ...fields, sort_order: nextBattleTokenSortOrder(), updated_at: nowIso });
        } else {
            const changed = {};
            Object.keys(fields).forEach(k => { if (JSON.stringify(fields[k]) !== JSON.stringify(prev[k])) changed[k] = fields[k]; });
            if (Object.keys(changed).length > 0) updates.push({ id: t.token_id, changed: { ...changed, updated_at: nowIso } });
        }
        battleTokenSnapshot[t.token_id] = fields;
    });
    const deletes = Object.keys(battleTokenSnapshot).filter(id => !seen.has(id));
    deletes.forEach(id => { delete battleTokenSnapshot[id]; });
    inserts.forEach(r => { battleTokenLocalWriteAt[r.id] = nowIso; });
    updates.forEach(u => { battleTokenLocalWriteAt[u.id] = nowIso; });

    const ops = [];
    if (inserts.length > 0) ops.push(db.from('battle_tokens').insert(inserts));
    updates.forEach(u => ops.push(db.from('battle_tokens').update(u.changed).eq('id', u.id)));
    if (deletes.length > 0) ops.push(db.from('battle_tokens').delete().in('id', deletes));
    if (ops.length === 0) return;
    const results = await Promise.all(ops.map(q => Promise.resolve(q).then(r => r, err => ({ error: err }))));
    const failed = results.filter(r => r && r.error);
    if (failed.length > 0) {
        console.error('saveBattleTokens: some token writes failed -- resyncing from the database', failed.map(f => f.error));
        loadBattleEncounters();
        return;
    }
    // When this browser adds ships, give same-named NPC copies callsigns.
    if (inserts.length > 0 && typeof window.assignBattleCallsigns === 'function') window.assignBattleCallsigns();
}
window.saveBattleTokens = saveBattleTokens;

function clampToGrid(x, y) {
    return {
        x: Math.max(0, Math.min(BATTLE_GRID_W - BATTLE_TOKEN_SIZE, x)),
        y: Math.max(0, Math.min(BATTLE_GRID_H - BATTLE_TOKEN_SIZE, y))
    };
}

// {x, y} of a ship_marker's token in the active battle, or null if there's
// no active battle or the vessel isn't in it.
window.getBattleTokenPosition = function(vesselId) {
    if (!window.globalBattleEncounterCache) return null;
    const tok = (window.globalBattleEncounterCache.tokens || []).find(t => t.ship_marker_id === vesselId);
    return tok ? { x: tok.x, y: tok.y } : null;
};

/* Target list for the weapon dropdowns in js/combat.js (ship and squadron
   weapons). Returns null when no restriction applies (no active battle, or
   the vessel isn't a token in it) so the caller uses its full target list.
   Otherwise returns [{ id, name, is_strike_craft, out_of_arc, terrain_block }]
   for other tokens that are in range and visible to this viewer.
   opts = { firerVessel, wpn, includeOutOfArc }: with `wpn`, range is computed
   per candidate via getEffectiveWeaponRange; without it, `range` (grid px,
   0/undefined = unlimited) is a flat distance filter. */
window.getBattleScopedTargets = function(vesselId, range, opts) {
    if (!window.globalBattleEncounterCache) return null;
    const tokens = window.globalBattleEncounterCache.tokens || [];
    const selfToken = tokens.find(t => t.ship_marker_id === vesselId);
    if (!selfToken) return null;
    const firerVessel = (opts && opts.firerVessel) || globalShipMarkersCache.find(m => m.id === vesselId);
    const wpn = opts && opts.wpn;
    return tokens.filter(t => t.ship_marker_id !== vesselId).filter(t => {
        const targetVessel = globalShipMarkersCache.find(sm => sm.id === t.ship_marker_id);
        const effRange = (wpn && typeof getEffectiveWeaponRange === 'function')
            ? getEffectiveWeaponRange(wpn, firerVessel, targetVessel)
            : range;
        if (!effRange) return true;
        return Math.hypot(t.x - selfToken.x, t.y - selfToken.y) <= effRange;
    }).map(t => globalShipMarkersCache.find(sm => sm.id === t.ship_marker_id))
      .filter(Boolean)
      .filter(m => (typeof window.isVesselVisibleToMe === 'function') ? window.isVesselVisibleToMe(m) : true)
      // Out-of-arc / terrain-blocked targets are dropped unless the caller
      // passes includeOutOfArc (the dropdowns then show them greyed out).
      .map(m => ({ id: m.id, name: m.name, is_strike_craft: m.is_strike_craft, out_of_arc: !!(wpn && typeof window.isTargetInArc === 'function' && !window.isTargetInArc(vesselId, m.id, wpn)),
          // terrain: planet/station in the way, or hidden in a nebula past lock range
          terrain_block: (typeof window.terrainFireCheck === 'function' ? window.terrainFireCheck(vesselId, m.id) : '') }))
      .filter(m => (!m.out_of_arc && !m.terrain_block) || (opts && opts.includeOutOfArc));
};

// Default placement for newly deployed tokens: staggered rows from the
// top-left. tokenCount = tokens already placed, including earlier ones in
// the same batch deploy.
function staggeredTokenPos(tokenCount) {
    const stagger = tokenCount * 24;
    return clampToGrid(20 + (stagger % (BATTLE_GRID_W - 60)), 20 + Math.floor(stagger / (BATTLE_GRID_W - 60)) * 40);
}

window.deployTemplateToBattle = async function() {
    if (currentUserRole !== 'dm' || !window.globalBattleEncounterCache) return;
    const select = document.getElementById('battle-map-template-select');
    if (!select || !select.value) { alert('Select a template first.'); return; }
    // Ships deployed here are Battle-Map-only (hide_from_galaxy_map), like
    // preset NPCs and launched strike craft. silent: skip the "deployed to
    // your DRADIS position" toast, since it isn't there.
    const newId = await window.deployShipTemplate(select.value, { silent: true, overrides: { hide_from_galaxy_map: true } });
    if (!newId) return; // deployShipTemplate already alerted on failure
    if (window.AudioEngine) window.AudioEngine.playPing();
    // deployShipTemplate doesn't await its own loadGalaxyData(), so reload
    // here or the new token briefly renders as "(vessel not found)".
    if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
    const tokens = (window.globalBattleEncounterCache.tokens || []).slice();
    const pos = staggeredTokenPos(tokens.length);
    const newVessel = globalShipMarkersCache.find(m => m.id === newId);
    tokens.push({ token_id: genBattleTokenId(), ship_marker_id: newId, x: pos.x, y: pos.y, move_remaining: newVessel?.tactical_speed ?? 160 });
    await saveBattleTokens(tokens);
    window.renderBattleMapPanel();
};

// Deploys every unit of a saved fleet (quantity per member), each through
// window.deployShipTemplate, so every vessel is a brand-new ship_markers row.
// Members whose template no longer exists are counted up front, named in
// the confirm prompt and chat log, and skipped (deployShipTemplate itself
// only alerts on DB errors, not missing templates).
window.deployFleetToBattle = async function() {
    if (currentUserRole !== 'dm' || !window.globalBattleEncounterCache) return;
    const select = document.getElementById('battle-map-fleet-select');
    if (!select || !select.value) { alert('Select a saved fleet first.'); return; }
    const fleet = (window.globalSavedFleetsCache || []).find(f => f.id === select.value);
    if (!fleet) return;
    const members = fleet.members || [];
    if (members.length === 0) { alert(`"${fleet.name}" has no vessels in it yet — add some from the Secret Repository first.`); return; }

    const missingMembers = members.filter(m => !findAnyTemplateById(m.template_id));
    const deployableUnitCount = members.reduce((sum, m) => sum + (findAnyTemplateById(m.template_id) ? (m.quantity || 1) : 0), 0);

    let confirmMsg = `Deploy "${fleet.name}" (${deployableUnitCount} vessel${deployableUnitCount === 1 ? '' : 's'}) to the battle grid?`;
    if (missingMembers.length > 0) {
        confirmMsg += `\n\n[WARNING] ${missingMembers.length} member${missingMembers.length === 1 ? '' : 's'} of this fleet reference${missingMembers.length === 1 ? 's' : ''} a template that no longer exists in the repository and will be SKIPPED.`;
    }
    if (!(await window.showConfirmModal(confirmMsg))) return;

    let tokens = (window.globalBattleEncounterCache.tokens || []).slice();
    let placedCount = 0;
    for (const member of members) {
        if (!findAnyTemplateById(member.template_id)) continue; // already warned above
        for (let i = 0; i < (member.quantity || 1); i++) {
            const newId = await window.deployShipTemplate(member.template_id, { silent: true, overrides: { hide_from_galaxy_map: true } }); // Battle-Map-only, see deployTemplateToBattle
            if (!newId) continue; // already alerted; skip this unit, keep deploying the rest
            if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
            const pos = staggeredTokenPos(tokens.length);
            const newVessel = globalShipMarkersCache.find(m => m.id === newId);
            tokens.push({ token_id: genBattleTokenId(), ship_marker_id: newId, x: pos.x, y: pos.y, move_remaining: newVessel?.tactical_speed ?? 160 });
            placedCount++;
        }
    }
    await saveBattleTokens(tokens);
    let logMsg = `⚔️ [TACTICAL BATTLE MAP] ${fleet.name} deployed — ${placedCount} vessel${placedCount === 1 ? '' : 's'} placed.`;
    if (missingMembers.length > 0) logMsg += ` (${missingMembers.length} member${missingMembers.length === 1 ? '' : 's'} skipped — deleted template.)`;
    await db.from('chat_logs').insert({ sender_id: null, content: logMsg, message_type: 'system' });
    window.renderBattleMapPanel();
};

/* DAMAGE RINGS around each token:
   - inner ring = HULL, filled clockwise from 12 o'clock in the hull color
     (green > 66%, amber > 33%, red below); the lost part is grey.
   - outer ring = SHIELDS (cyan), only for ships with shields, never for
     strike craft (too small for two rings).
   Pure CSS (conic-gradient + mask), so no per-frame cost. Exact numbers are
   in the token tooltip. Anyone who can see a token sees its rings. */
function battleTokenFraction(cur, max) {
    if (!(max > 0)) return null;
    const c = (cur === undefined || cur === null) ? max : cur;
    return Math.max(0, Math.min(1, c / max));
}
function battleTokenDamageRingsHtml(vessel, isStrikeCraft, isStation) {
    if (!vessel) return '';
    const radius = isStation ? '7px' : '50%';
    const ring = (insetPx, thickPx, frac, fill, empty, cls) => {
        const deg = Math.round(frac * 360);
        return `<div class="battle-token-ring ${cls}" style="inset:-${insetPx}px; padding:${thickPx}px; border-radius:${radius}; background:conic-gradient(${fill} 0deg ${deg}deg, ${empty} ${deg}deg 360deg);"></div>`;
    };
    let html = '';
    const hull = battleTokenFraction(vessel.integrity_hull, vessel.max_hull || 100);
    if (hull !== null) html += ring(isStrikeCraft ? 5 : 6, isStrikeCraft ? 2 : 3, hull, battleTokenHpColor(vessel), 'rgba(70,74,72,0.85)', 'battle-token-ring-hull');
    const shields = isStrikeCraft ? null : battleTokenFraction(vessel.integrity_shields, vessel.max_shields || 0);
    if (shields !== null) html += ring(10, 2, shields, '#00e1ff', 'rgba(0,60,80,0.7)', 'battle-token-ring-shields');
    return html;
}
function battleTokenIntegrityText(vessel) {
    const parts = [];
    const hullMax = vessel.max_hull || 100;
    parts.push(`Hull ${vessel.integrity_hull !== undefined && vessel.integrity_hull !== null ? vessel.integrity_hull : hullMax}/${hullMax}`);
    if ((vessel.max_shields || 0) > 0) parts.push(`Shields ${vessel.integrity_shields !== undefined && vessel.integrity_shields !== null ? vessel.integrity_shields : vessel.max_shields}/${vessel.max_shields}`);
    return ' — ' + parts.join(' · ');
}
window.battleTokenDamageRingsHtml = battleTokenDamageRingsHtml;

function battleTokenHpColor(vessel) {
    if (!vessel) return '#6b826a';
    const max = vessel.max_hull || 100;
    const cur = vessel.integrity_hull !== undefined ? vessel.integrity_hull : max;
    const pct = max > 0 ? cur / max : 1;
    if (pct > 0.66) return '#00e5a3';
    if (pct > 0.33) return '#ffaa00';
    return '#ff3333';
}

/* Token border color by faction, from the viewer's point of view: own ship
   cyan, another player's green, DM/NPC red. "Player-owned" = any owner
   profile with role !== 'dm' (the same test used app-wide). The DM sees
   only green/red. */
function battleTokenFactionColor(vessel) {
    if (!vessel) return '#6b826a';
    const ownerProfs = window.vesselOwnerIds(vessel).map(id => (typeof allProfiles !== 'undefined' ? allProfiles : []).find(p => p.id === id)).filter(Boolean);
    const isPlayerOwned = ownerProfs.some(p => p.role !== 'dm');
    if (!isPlayerOwned) return '#ff3333';           // DM/NPC-owned (or unowned) — hostile/neutral
    if (window.vesselHasOwner(vessel, currentUserId)) return '#00e1ff'; // I'm one of its owners
    return '#00e5a3';                                // another player's vessel (I'm not a co-owner) — ally
}

/* ==========================================================================
   BATTLE RENDERER
   ==========================================================================
   All drawing of the battle grid goes through window.battleRenderer. Rules
   code never touches the grid DOM; it converts screen points via
   screenToWorld / screenDeltaToWorld and hands tokens to sync(). Another
   renderer can be swapped in by implementing the same methods.
   "World" = logical grid px (BATTLE_GRID_W x BATTLE_GRID_H, origin top-left,
   +y down), the space of stored token x/y, ranges and move_remaining.
   "Screen" = browser clientX/Y.
   DomBattleRenderer: persistent token divs diffed each render (CSS
   transitions animate moves), the ordnance overlay, and four weapon-fire
   effect families. */
const DomBattleRenderer = {
    name: 'dom',
    grid() { return document.getElementById('battle-map-grid'); },
    // Screen point -> grid point (null if the grid isn't on screen).
    screenToWorld(clientX, clientY) {
        const grid = this.grid();
        if (!grid) return null;
        const rect = grid.getBoundingClientRect();
        return { x: (clientX - rect.left) / BATTLE_GRID_SCALE, y: (clientY - rect.top) / BATTLE_GRID_SCALE };
    },
    // A screen-space drag distance -> the same distance in grid px.
    screenDeltaToWorld(dx, dy) {
        return { x: dx / BATTLE_GRID_SCALE, y: dy / BATTLE_GRID_SCALE };
    },
    // Grid point -> screen point (e.g. to anchor HUD panels over a token).
    worldToScreen(x, y) {
        const grid = this.grid();
        if (!grid) return null;
        const rect = grid.getBoundingClientRect();
        return { x: rect.left + x * BATTLE_GRID_SCALE, y: rect.top + y * BATTLE_GRID_SCALE };
    },
    // Draw/refresh every visible token + in-flight ordnance for this encounter.
    sync(encounter, tokens) {
        // Diffs against existing DOM elements instead of rebuilding, so the
        // .battle-token-el CSS transition (style.css) animates position changes.
        const grid = document.getElementById('battle-map-grid');
        if (grid) {
            grid.onclick = window.handleBattleGridClick;

            // A different battle: drop every cached element so nothing from the
            // previous encounter leaks in.
            if (encounter.id !== battleMapLastEncounterId) {
                grid.innerHTML = '';
                battleMapTokenEls = {};
                battleMapTokenMarkerIds = {};
                battleMapPendingExplosions = [];
                battleMapOrdnanceEls = {};
                battleMapPrevOrdnanceIds = new Set();
                battleMapLastEncounterId = encounter.id;
            }

            const seenTokenIds = new Set();
            // Whose turn it is, for the glow below (null before initiative is rolled).
            const currentTurnTokenId = (encounter.initiative_rolled && (encounter.turn_order || []).length > 0)
                ? encounter.turn_order[encounter.current_turn_index]
                : null;
            tokens.forEach(tok => {
                const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
                // Fog of war: a token this viewer can't see is left out of
                // seenTokenIds, so the cleanup pass below removes its element.
                if (vessel && typeof window.isVesselVisibleToMe === 'function' && !window.isVesselVisibleToMe(vessel)) return;
                seenTokenIds.add(tok.token_id);
                const isStationTok = !!(vessel && vessel.is_station);
                const isStrikeCraftTok = !!(vessel && vessel.is_strike_craft);
                const moveRemaining = tok.move_remaining !== undefined ? tok.move_remaining : ((vessel?.tactical_speed ?? 160));

                let tokenEl = battleMapTokenEls[tok.token_id];
                if (!tokenEl) {
                    tokenEl = document.createElement('div');
                    tokenEl.className = 'battle-token-el';
                    tokenEl.dataset.tokenId = tok.token_id; // lets grid tools find a token's element
                    tokenEl.style.position = 'absolute';
                    tokenEl.style.left = tok.x + 'px';
                    tokenEl.style.top = tok.y + 'px';
                    grid.appendChild(tokenEl);
                    battleMapTokenEls[tok.token_id] = tokenEl;
                    wireTokenDrag(tokenEl, tok.token_id, tok.ship_marker_id);
                }
                // Kept after the token leaves `tokens`, so the removal pass can
                // still tell which vessel a vanished token belonged to.
                battleMapTokenMarkerIds[tok.token_id] = tok.ship_marker_id;

                tokenEl.title = isStationTok
                    ? `${vessel.name} — stationary platform, immobile`
                    : isStrikeCraftTok
                    ? `${vessel.name} — strike craft, Move: ${moveRemaining}/${vessel.tactical_speed ?? 160} px remaining. Fire from the Hangar Bay panel, not this token.`
                    : `${vessel ? vessel.name : '(vessel not found)'} — Move: ${moveRemaining}${vessel ? '/' + (vessel.tactical_speed ?? 160) : ''} px remaining this round`;
                if (vessel) tokenEl.title += battleTokenIntegrityText(vessel);
                // Re-applying an unchanged left/top doesn't re-trigger the CSS
                // transition; only an actual change animates.
                tokenEl.style.left = tok.x + 'px';
                tokenEl.style.top = tok.y + 'px';
                const tokenSize = isStrikeCraftTok ? BATTLE_STRIKE_CRAFT_TOKEN_SIZE : BATTLE_TOKEN_SIZE;
                tokenEl.style.width = tokenSize + 'px';
                tokenEl.style.height = tokenSize + 'px';
                tokenEl.style.borderRadius = isStationTok ? '4px' : '50%';
                tokenEl.style.background = '#0a1410';
                // Border = faction color (dashed for strike craft); hull/shields
                // are shown by the damage rings.
                tokenEl.style.border = `2px ${isStrikeCraftTok ? 'dashed' : 'solid'} ${battleTokenFactionColor(vessel)}`;
                const isCurrentTurnTok = !!(currentTurnTokenId && tok.token_id === currentTurnTokenId);
                tokenEl.style.display = 'flex';
                tokenEl.style.alignItems = 'center';
                tokenEl.style.justifyContent = 'center';
                // Strike craft show a single emoji (larger font) instead of a
                // name; the full name is in the tooltip.
                tokenEl.style.fontSize = isStrikeCraftTok ? '11px' : '8px';
                tokenEl.style.color = vessel ? (vessel.color || '#00e5a3') : '#ff3333';
                tokenEl.style.cursor = isStationTok ? 'pointer' : 'grab';
                tokenEl.style.userSelect = 'none';
                // The DM sees hidden ships dimmed; players never get them at all.
                tokenEl.style.opacity = (vessel && vessel.is_hidden && currentUserRole === 'dm') ? '0.55' : '1';
                tokenEl.style.boxShadow = '0 0 6px rgba(0,0,0,0.6)';
                // Current-turn glow is a pulsing CSS ring
                // (.battle-token-current-turn::after in style.css).
                tokenEl.classList.toggle('battle-token-current-turn', isCurrentTurnTok);
                tokenEl.style.textAlign = 'center';
                tokenEl.style.overflow = 'visible'; // rings sit outside the token; the name text clips itself below
                tokenEl.style.padding = '1px';
                tokenEl.style.zIndex = '2';

                tokenEl.innerHTML = battleTokenDamageRingsHtml(vessel, isStrikeCraftTok, isStationTok);
                const label = document.createElement('span');
                label.style.cssText = 'position:relative; z-index:1; max-width:100%; overflow:hidden; white-space:nowrap; pointer-events:none;';
                label.textContent = !vessel ? '???' : isStrikeCraftTok ? '🛩️' : vessel.name.slice(0, 6);
                tokenEl.appendChild(label);
                // Nose chevron + rotate knob (js/firing-arcs.js; no-op while the firing_arcs switch is off).
                if (typeof window.decorateBattleTokenHeading === 'function') window.decorateBattleTokenHeading(tokenEl, tok, vessel);
                if (!isStationTok && moveRemaining < 0) {
                    const moveBadge = document.createElement('div');
                    moveBadge.style.cssText = 'position:absolute; top:-8px; right:-4px; background:#ff3333; color:#030403; font-size:7px; font-weight:bold; border-radius:6px; padding:0 3px; pointer-events:none;';
                    moveBadge.innerText = '!';
                    tokenEl.appendChild(moveBadge);
                }
            });

            // Remove elements for tokens no longer shown. A destroyed token has a
            // battleMapPendingExplosions entry (from checkBattleTokenDestroyed)
            // and explodes first; withdrawn/recalled ones just vanish.
            Object.keys(battleMapTokenEls).forEach(id => {
                if (!seenTokenIds.has(id)) {
                    const pendingIdx = battleMapPendingExplosions.findIndex(p => p.token_id === id);
                    if (pendingIdx >= 0) {
                        const exp = battleMapPendingExplosions.splice(pendingIdx, 1)[0];
                        spawnDestructionEffect(grid, exp.x, exp.y);
                    }
                    battleMapTokenEls[id].remove();
                    delete battleMapTokenEls[id];
                    delete battleMapTokenMarkerIds[id];
                }
            });

            renderOrdnanceOverlay(grid, tokens, encounter.in_flight_ordnance || []);
        }


    },
    // Weapon-fire effect between two grid points, by effect family.
    fireEffect(sx, sy, tx, ty, color, family) {
        const grid = this.grid();
        if (!grid) return;
        if (family === 'pulse') spawnHealPulseEffect(grid, tx, ty, color);
        else if (family === 'burst') spawnBurstEffect(grid, tx, ty, color);
        else if (family === 'tracer') spawnTracerEffect(grid, sx, sy, tx, ty, color);
        else spawnBeamEffect(grid, sx, sy, tx, ty, color);
    },
    // Destruction explosion at a token's grid position.
    destruction(x, y) {
        const grid = this.grid();
        if (grid) spawnDestructionEffect(grid, x, y);
    }
};
window.DomBattleRenderer = DomBattleRenderer;
window.battleRenderer = DomBattleRenderer;

let lastAnnouncedTurnKey = null;
/* Battle Map render hooks. Other files must not wrap
   window.renderBattleMapPanel; they register here instead:
     window.onBattleMapRender(name, fn, order)
   Every hook runs after each render, lowest `order` first (default 500); a
   hook that throws is logged and the rest still run. Registering the same
   name again replaces it. */
const battleRenderHooks = [];
window.onBattleMapRender = function(name, fn, order) {
    if (typeof fn !== 'function') return;
    const i = battleRenderHooks.findIndex(h => h.name === name);
    if (i >= 0) battleRenderHooks.splice(i, 1);
    battleRenderHooks.push({ name, fn, order: Number.isFinite(order) ? order : 500 });
    battleRenderHooks.sort((a, b) => a.order - b.order);
};
window.battleMapRenderHookNames = () => battleRenderHooks.map(h => h.name); // tests
window.renderBattleMapPanel = function() {
    const r = renderBattleMapPanelCore.apply(this, arguments);
    for (const h of battleRenderHooks) {
        try { h.fn(); } catch (err) { console.error(`Battle Map render hook "${h.name}" failed`, err); }
    }
    return r;
};
const renderBattleMapPanelCore = function() {
    const dmControls = document.getElementById('battle-map-dm-controls');
    const inactiveMsg = document.getElementById('battle-map-inactive-msg');
    const activeContainer = document.getElementById('battle-map-active-container');
    if (!dmControls || !inactiveMsg || !activeContainer) return; // panel not in DOM yet

    const encounter = window.globalBattleEncounterCache;
    const isDm = currentUserRole === 'dm';

    dmControls.style.display = (isDm && !encounter) ? 'block' : 'none';
    inactiveMsg.style.display = encounter ? 'none' : 'block';
    // 'flex', not 'block': .battle-map-layout is a two-column flex box.
    activeContainer.style.display = encounter ? 'flex' : 'none';
    if (!encounter) return;

    document.getElementById('battle-map-encounter-name').innerText = encounter.name;
    const endBtn = document.getElementById('battle-map-end-btn');
    if (endBtn) endBtn.style.display = isDm ? 'inline-block' : 'none';
    // ADVANCE ROUND and ROLL INITIATIVE are DM-only and shown only before
    // initiative is rolled. After that, ending the last turn
    // (window.endCurrentTurn) fires the round tick, and a manual advance
    // would desync it.
    const advanceBtn = document.getElementById('battle-map-advance-btn');
    if (advanceBtn) advanceBtn.style.display = (isDm && !encounter.initiative_rolled) ? 'inline-block' : 'none';
    const rollInitBtn = document.getElementById('battle-map-roll-initiative-btn');
    if (rollInitBtn) rollInitBtn.style.display = (isDm && !encounter.initiative_rolled) ? 'inline-block' : 'none';
    const dmDeploy = document.getElementById('battle-map-dm-deploy');
    if (dmDeploy) dmDeploy.style.display = isDm ? 'block' : 'none';
    // Undo log: DM-only, behind the 'battle_undo' feature switch.
    const showUndo = isDm && typeof window.isFeatureOn === 'function' && window.isFeatureOn('battle_undo');
    ['battle-map-undo-btn', 'battle-map-redo-btn', 'battle-map-log-btn'].forEach(id => { const b = document.getElementById(id); if (b) b.style.display = showUndo ? 'inline-block' : 'none'; });

    const tokens = encounter.tokens || [];

    // --- Turn bar ---
    const turnBar = document.getElementById('battle-map-turn-bar');
    if (turnBar) {
        if (encounter.initiative_rolled && (encounter.turn_order || []).length > 0) {
            turnBar.style.display = 'flex';
            const turnOrder = encounter.turn_order || [];
            const curTokId = turnOrder[encounter.current_turn_index];
            const curTok = tokens.find(t => t.token_id === curTokId);
            const curVessel = curTok ? globalShipMarkersCache.find(m => m.id === curTok.ship_marker_id) : null;
            const turnInfo = document.getElementById('battle-map-turn-info');
            // "Your turn" chime on the owning player's device, once per turn
            // (re-renders don't repeat it). Not played for the DM.
            const turnKey = `${encounter.id}:${encounter.round_number || 1}:${encounter.current_turn_index}`;
            if (!isDm && !encounter.pending_round_tick && curVessel && window.vesselHasOwner(curVessel, currentUserId) && lastAnnouncedTurnKey !== turnKey) {
                lastAnnouncedTurnKey = turnKey;
                if (window.AudioEngine && window.AudioEngine.playTurnStart) { try { window.AudioEngine.playTurnStart(); } catch (e) {} }
            }
            if (turnInfo && encounter.pending_round_tick) {
                turnInfo.innerText = `Round ${encounter.round_number || 1} complete — ⏳ awaiting DM to resolve the round`;
            } else if (turnInfo) {
                turnInfo.innerText = curVessel
                    ? `Round ${encounter.round_number || 1} — ${curVessel.name}'s turn (AP ${curTok.ap_current || 0}/${window.getTokenApMax(curVessel)})`
                    : `Round ${encounter.round_number || 1} — (current unit not found)`;
            }
            const endTurnBtn = document.getElementById('battle-map-endturn-btn');
            if (endTurnBtn) {
                const canEndTurn = isDm || (!encounter.pending_round_tick && curVessel && window.vesselHasOwner(curVessel, currentUserId));
                endTurnBtn.style.display = canEndTurn ? 'inline-block' : 'none';
            }
            // Idempotent: adds tokens placed after initiative was rolled.
            if (typeof window.ensureNewTokensInTurnOrder === 'function') window.ensureNewTokensInTurnOrder();
        } else {
            turnBar.style.display = 'none';
        }
    }

    // --- Grid / placed tokens --- drawn by the active renderer (BATTLE RENDERER above).
    window.battleRenderer.sync(encounter, tokens);

    // --- Palette (undeployed candidates) ---
    const placedIds = new Set(tokens.map(t => t.ship_marker_id));
    const palette = document.getElementById('battle-map-palette');
    if (palette) {
        // The DM can place any vessel (including players' ships); a player
        // only their own. Strike craft and already-placed vessels are excluded.
        const candidates = globalShipMarkersCache.filter(m => !m.is_strike_craft && !placedIds.has(m.id) && (isDm || window.vesselHasOwner(m, currentUserId)));
        if (candidates.length === 0) {
            palette.innerHTML = '<span style="font-size:9px; color:#6b826a;">No available vessels to place.</span>';
        } else {
            palette.innerHTML = candidates.map(m => {
                const armed = window.battleMapArmedToken && window.battleMapArmedToken.ship_marker_id === m.id;
                // DM view: suffix another player's vessel with the owner's
                // username. Names come from live presence, so offline owners
                // get no suffix.
                const otherOwnerIds = (isDm && !window.vesselHasOwner(m, currentUserId)) ? window.vesselOwnerIds(m) : [];
                const otherOwnerNames = otherOwnerIds.map(id => (onlineUsersMap[id] || [])[0]).filter(Boolean).map(p => p.username);
                const ownerSuffix = otherOwnerNames.length ? ` <span style="color:#6b826a;">— ${otherOwnerNames.join('/')}</span>` : '';
                return `<div style="display:flex; justify-content:space-between; align-items:center; padding:4px 6px; background:#030403; border:1px solid ${armed ? '#00e5a3' : '#3c4e36'}; border-radius:2px;">
                    <span style="font-size:9px; color:#d4c5a9;">${m.name}${ownerSuffix}</span>
                    ${armed
                        ? `<button class="layer-edit" onclick="window.cancelTokenPlacement()" style="font-size:8px; padding:2px 6px;">CANCEL</button>`
                        : `<button class="btn-deploy" onclick="window.armTokenForPlacement('${m.id}')" style="font-size:8px; padding:2px 6px;">+ PLACE</button>`}
                </div>`;
            }).join('');
        }
        if (window.battleMapArmedToken) {
            palette.innerHTML = `<div style="font-size:9px; color:#00e5a3; margin-bottom:4px;">ARMED — click the grid to place, or Cancel above.</div>` + palette.innerHTML;
        }
    }

    // --- DM template deploy select ---
    const tmplSelect = document.getElementById('battle-map-template-select');
    if (tmplSelect && isDm) {
        const allTemplates = (typeof shipTemplatesList !== 'undefined' ? shipTemplatesList : []).concat(window.secretShipTemplatesList || []);
        tmplSelect.innerHTML = allTemplates.length === 0
            ? '<option value="">-- No templates designed --</option>'
            : allTemplates.map(t => `<option value="${t.id}">${t.name}${t.is_secret ? ' 🔒' : ''}</option>`).join('');
    }

    // --- DM saved-fleet deploy select ---
    const fleetSelect = document.getElementById('battle-map-fleet-select');
    if (fleetSelect && isDm) {
        const fleets = window.globalSavedFleetsCache || [];
        fleetSelect.innerHTML = fleets.length === 0
            ? '<option value="">-- No saved fleets --</option>'
            : fleets.map(f => `<option value="${f.id}">${f.name} (${(f.members || []).reduce((n, m) => n + (m.quantity || 1), 0)} vessels)</option>`).join('');
    }

    // --- Ship-status cards (weapons + health); see window.renderBattleShipCards
    // for what each viewer may see.
    window.renderBattleShipCards(tokens);

    // --- Incoming Ordnance (informational — PD is fully automatic, see
    // window.processBattleRoundAutomations; nothing here is clickable) ---
    const ordnanceContainer = document.getElementById('battle-map-ordnance-list');
    if (ordnanceContainer) {
        const inFlight = encounter.in_flight_ordnance || [];
        if (inFlight.length === 0) {
            ordnanceContainer.innerHTML = 'No ordnance currently in flight.';
        } else {
            // Group split payloads (shared parent_salvo_id) into one line so
            // 6 individual entries don't clutter the panel.
            const groups = {};
            inFlight.forEach(salvo => {
                const key = salvo.parent_salvo_id || salvo.salvo_id;
                if (!groups[key]) groups[key] = { ...salvo, count: 0 };
                groups[key].count += 1;
            });
            ordnanceContainer.innerHTML = Object.values(groups).map(g => {
                const countLabel = g.split ? ` (${g.count}/6 payloads)` : '';
                return `<div style="padding:2px 0;">${g.source_weapon_name} from ${g.source_vessel_name} → ${g.target_vessel_name}${countLabel} — impact in ${g.turns_remaining} round${g.turns_remaining === 1 ? '' : 's'}</div>`;
            }).join('');
        }
    }

    // Keep the DM Tools "MANUAL DMG" Firer/Target dropdowns in sync with the
    // deployed tokens (cheap, idempotent).
    if (typeof window.renderManualDamagePanel === 'function') window.renderManualDamagePanel();
};
