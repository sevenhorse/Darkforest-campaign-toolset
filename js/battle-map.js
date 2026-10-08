/* ==========================================================================
   js/battle-map.js - Tactical Battle Map (Phase 1)
   ==========================================================================
   New this session. Confirmed design (see darkforest-architecture-reference.md
   checkpoints): a simple fixed-size arena, no pan/zoom/starfield — click to
   place, click to target. Full mutual visibility once in a battle (no FOW).
   Dragging a Secret Repository template onto the map creates a REAL
   ship_markers row via the existing window.deployShipTemplate flow — a
   battle token is a placement record pointing at a real vessel, never a
   parallel lightweight entity. Free drag-to-reposition (no movement rules/
   stats — that's an explicitly separate, not-yet-designed thread).

   Data shape: battle_encounters row = { id, name, is_active, created_by,
   created_at, tokens: [{ token_id, ship_marker_id, x, y }] }. Only one
   active battle at a time (Phase 1 scope) — starting a new one deactivates
   any currently-active row rather than deleting it (keeps history).

   Deliberately NOT in Phase 1 (see architecture doc): range rules, draw-tool
   AOE targeting, hex/grid overlay, multiple simultaneous battles, and the
   MLRS multi-turn ordnance/counter-fire engine itself (weapon classification
   groundwork for that exists in combat.js, but the actual resolution loop is
   a later build).

   --- MOVEMENT (built same session as a follow-up to Phase 1, confirmed
   design) --- No dedicated turn/initiative tracker: move_remaining refreshes
   on the SAME global tick every other per-round mechanic in this app already
   uses (js/combat.js's advanceCombatRound, via window.resetBattleMapMovement
   below) rather than inventing a separate turn concept. Allowance comes from
   a new ship_templates/ship_markers.tactical_speed stat (grid px/round,
   default 80), copied onto ship_markers at deploy time exactly like
   integrity_hull/max_hull already are — deliberately NOT derived from
   drive_type/speed, which is the galaxy-scale FTL travel stat and the wrong
   scale for this 460x380 grid. Enforcement is DM-trusted, not code-blocked:
   dragging a token past its move_remaining is never prevented, it just goes
   negative and renders red (roster line + a small "!" badge on the token)
   so the DM can see at a glance who overspent. move_remaining lives on the
   battle_encounters.tokens record itself (per-battle, per-round state —
   not on ship_markers, which persists across battles).

   --- BATTLEFIELD SALVAGE (built same session, layered on the destroyed-
   token hook below) --- Confirmed design: destroying a token spawns a
   battlefield_salvage row at a player-owned vessel's position (any player
   ship still in the battle, not necessarily the killing blow — no player
   ship present means no salvage). A manual "Gather" action (ship must be
   within SALVAGE_GATHER_RANGE) starts a DM/player-set duration timer
   against the existing universeTimeHours clock; completion is automatic
   once that clock passes the deadline (checked every time advancement, not
   just daily ticks, since a duration can be sub-day) and delivers the raw
   resource into the gathering vessel's cargo misc array. Separately, any
   vessel with BOTH the raw resource in cargo AND a configured
   salvage_processing_output/rate (new ship_markers columns, same
   nullable/zero-means-off convention as fleet_groups' production fields)
   converts some per day, scaled by its Manufacturing deck's HP% exactly
   like fleet-group production already does — see
   window.processSalvageConversion. Deliberately NOT built: any UI rendering
   of salvage markers on the galaxy canvas itself (map.js's render loop
   wasn't touched) — salvage is presented as a DOM list panel only, same
   pattern as Territory Control, not a clickable map token. */

window.globalBattleEncounterCache = null;
window.battleMapArmedToken = null; // { ship_marker_id } while a palette entry is armed for click-to-place, else null

function genBattleTokenId() { return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ('tok-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)); }

// Battle Map Grid Expansion build (this session): doubled from 460x380 to
// 920x760 (DM's confirmed choice, among 3 options presented) -- growing the
// actual LOGICAL battlespace, not just the visual zoom (see
// BATTLE_GRID_SCALE's own comment below for that distinction; this is the
// "actually growing the battlespace" lever it warns changing SCALE alone
// doesn't do). Raised at the DM's own request after Squadron AI Stances
// shipped: the grid hadn't grown since the very first Battle Map build,
// while token count and simultaneous visual effects had grown a lot since.
// Existing weapon `range` values are mostly 0/unset (this app's "unlimited"
// convention) so this is lower-risk than resizing usually would be -- see
// the Grid Expansion checkpoint notes for what WAS touched to keep relative
// mobility consistent (SQUADRON_TACTICAL_SPEED and the tactical_speed
// defaults for NEW ships, both doubled) and what deliberately WASN'T
// (existing ships' already-stored tactical_speed values -- not bulk-
// migrated; flagged, not silently left inconsistent). The index.html
// #battle-map-grid element's inline width/height must match these two
// constants exactly (same requirement as before this build -- see that
// element's own comment), and #battle-map-grid-wrap switched from a fixed
// clipped viewport to a scrollable one since the fully-scaled grid
// (920*1.5 x 760*1.5 = 1380x1140 CSS px) no longer fits most screens at
// once -- see that element's comment for the reasoning.
let BATTLE_GRID_W = 920;
let BATTLE_GRID_H = 760;
/* Phase 7 (2026-10-03, DM decision): a saved map picks one of 3 fixed sizes.
   Weapon range bands (BATTLE_RANGE_TIERS) and tactical_speed stay the SAME
   distances on every size -- a bigger map just means more room. The size
   comes from the active battle's map snapshot (battle_encounters.map.size);
   no map / unknown size = Standard, today's grid. */
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
// Polish pass (this session, DM-reported): strike craft tokens were
// rendering at the exact same size as capital ships/stations (both used
// BATTLE_TOKEN_SIZE) -- the DM's "emblem needs to be much smaller" note.
// FLAGGED FIRST-PASS SIZE, DM-tunable, same as every other placeholder
// constant in this app.
const BATTLE_STRIKE_CRAFT_TOKEN_SIZE = 20;

// Visual-only zoom (tester feedback: "make the map bigger" -- see
// darkforest-architecture-reference.md's Battle Map layout addendum). The
// grid's LOGICAL coordinate space (BATTLE_GRID_W/H above, every stored
// token x/y, every weapon range and tactical_speed check via Math.hypot)
// is completely unchanged by this -- those are all still defined in the
// same 460x380 units they always were. Only the on-screen rendering is
// scaled up via CSS transform (index.html's #battle-map-grid), so a click
// or drag's raw mouse-pixel delta has to be divided by this factor before
// it means anything in logical grid units. Change this one constant (and
// the matching transform:scale()/wrapper size in index.html) to retune
// the visual size -- it deliberately does NOT touch tactical_speed or any
// weapon's range value, unlike actually growing the battlespace would.
const BATTLE_GRID_SCALE = 1.5;

/* Weapon Range Tiers build (this session, DM-confirmed design): four range
   bands, replacing the old ad hoc per-weapon placeholder numbers (300/450/
   650/700) with values derived from the grid's own size. LONG/MEDIUM/SHORT
   are 33% / 16.5% / 8.25% of the battle grid's DIAGONAL (sqrt(920^2+760^2)
   ~= 1193px), rounded to clean numbers -- the DM's own explicit pick of
   "diagonal" as what counts as the map's overall size, out of diagonal/
   width/average offered. The 4th tier (missiles/torpedoes, and a strike
   craft's own effective reach) isn't a number here at all: ship-mounted
   ordnance tubes get range 0 (unlimited launch distance, DM-confirmed)
   since they already travel over multiple turns via the existing
   ordnance-aging mechanic rather than hitting instantly, and a strike
   craft closes distance every round via moveTokenToward instead of
   needing a long weapon range to begin with. See getEffectiveWeaponRange
   and getUplinkedEnemyIds below for the two new rules built on top of
   these tiers (strike-craft-vs-capital short-range requirement, and the
   Messenger squadron's target-uplink exception to it). */
window.BATTLE_RANGE_TIERS = { LONG: 400, MEDIUM: 200, SHORT: 100 };
// Playtest rebalance (2026-10-03, DM): strike craft reach. See getEffectiveWeaponRange.
window.STRIKE_CRAFT_RANGES = { GUN: 90, ORDNANCE: 200 };
window.strikeCraftRangeCap = function(wpn) {
    return (wpn && wpn.weapon_class === 'ordnance') ? window.STRIKE_CRAFT_RANGES.ORDNANCE : window.STRIKE_CRAFT_RANGES.GUN;
};

/* Squadron Target Uplink build (this session, DM-described mechanic, exact
   trigger/scope/duration NOT explicitly spec'd beyond "gets close enough" --
   my own concrete reading, flagged plainly per standing instruction 5:
   a Messenger-type squadron (STRIKE_CRAFT_DB's `messenger` entry) within
   SHORT range of an enemy ship "uplinks" that ship for its OWN side (same
   owner_id as the Messenger) for the rest of THIS round only -- recomputed
   fresh every time this is called, nothing persists across rounds. Returns
   a Set of ship_marker ids (enemy ships currently uplinked for forOwnerId).
   Deliberately does not care about the Messenger's own ai_stance -- this is
   read as a passive sensor/spotter effect of just being close, not an
   attack action, so a Manual-stance Messenger still projects it. */
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

/* Weapon Range Tiers + Squadron Target Uplink builds (this session):
   computes the ACTUAL max range (px) for `wpn` fired by `firerVessel` at
   `targetVessel` this round, folding in both new rules on top of whatever
   `wpn.range` already says (0 = unlimited, existing convention unchanged):
     1. (DM-confirmed, applies to BOTH manual fire and AI-stance auto-fire)
        A strike craft (`firerVessel.is_strike_craft`) attacking anything
        that ISN'T itself a strike craft is hard-capped at SHORT range,
        regardless of its own weapon's listed range and regardless of the
        squadron's own type/size -- "must close to within short range to
        hit," full stop, unless rule 2 below already granted an exception.
        Deliberately keyed on `!targetVessel.is_strike_craft` rather than
        `vessel_class === 'Capital'/'Escort'` -- most live ships don't have
        `vessel_class` set yet (see Pending list), and gating on it here
        would let an untagged capital ship get sniped at full weapon range
        by accident, which reads as a worse bug than being slightly broader
        than "escort/capital" than asked.
     2. (My own reading of "the messenger... allows medium and long range
        weapons to hit regardless of distance" -- not explicitly scoped to
        ship guns vs. squadron weapons in what was described, so applied to
        both here; flagging this as a judgment call, not a confirmed spec)
        If `targetVessel` is currently uplinked for `firerVessel`'s side
        (see getUplinkedEnemyIds above) AND `wpn`'s own range already
        qualifies as medium-or-long tier (>= MEDIUM), that weapon ignores
        range entirely against this target this round -- checked BEFORE
        rule 1, so it also lets a strike craft's medium/long weapon skip
        the short-range-vs-capital requirement once uplinked. A weapon
        that's short-tier or already unlimited gets no benefit from an
        uplink -- there's nothing for it to extend. */
function getEffectiveWeaponRange(wpn, firerVessel, targetVessel) {
    const tiers = window.BATTLE_RANGE_TIERS || { LONG: 400, MEDIUM: 200, SHORT: 100 };
    const baseRange = (wpn && wpn.range) || 0; // 0 = unlimited, existing convention

    if (firerVessel && targetVessel && baseRange >= tiers.MEDIUM) {
        const uplinked = getUplinkedEnemyIds(window.vesselOwnerIds(firerVessel));
        if (uplinked.has(targetVessel.id)) return 0; // unlimited this round
    }

    // Playtest rebalance (2026-10-03, DM): every strike craft weapon is
    // capped -- guns/rockets/PD at just under SHORT (90), ordnance (missiles,
    // bombs) at MEDIUM (200) -- against ANY target, whatever range the
    // chassis lists (so a newly designed chassis gets it too). This replaces
    // the old "SHORT vs non-strike-craft" cap, which it's stricter than.
    if (firerVessel && firerVessel.is_strike_craft) {
        const cap = window.strikeCraftRangeCap(wpn);
        return baseRange > 0 ? Math.min(baseRange, cap) : cap;
    }

    return baseRange;
}
window.getEffectiveWeaponRange = getEffectiveWeaponRange;

/* --- ANIMATION ENGINE (built a prior session, confirmed scope: in-flight
   ordnance visualization, smooth token movement, direct-fire shot flashes, a
   decorative starfield backdrop — CSS/SVG-transform-driven per the DM's own
   choice, NOT a canvas/sprite pipeline, staying consistent with the rest of
   this file's plain-DOM approach. Strike-craft animation was explicitly out
   of scope at the time — squadrons had no real grid position (the
   "target-lock proxy" thread) and animating movement needs a real position
   to animate between. RESOLVED this session (see the Strike Craft Grid
   Position checkpoint below and window.addSquadronToBattleMap) — a
   squadron's token is a normal entry in battle_encounters.tokens now, so it
   flows through the exact same diff/reuse render loop and gets smooth
   movement + fire-beam flashes automatically, no separate animation path
   needed.

   Smooth token movement required a real architecture change: the grid used
   to be torn down (innerHTML = '') and rebuilt from scratch on every single
   render, which meant a token's DOM element never survived between renders
   — nothing for a CSS transition to animate FROM. The three maps below let
   the grid render function diff against what's already on screen and reuse
   existing elements (so style.left/top changes actually transition) instead
   of destroying and recreating everything every time. */
let battleMapTokenEls = {};        // token_id -> token DOM element (reused across renders)
let battleMapTokenMarkerIds = {};  // token_id -> ship_marker_id, kept even after a token is removed from `tokens` (see the destruction-effect pass below)
let battleMapPendingExplosions = []; // [{token_id, x, y}] staged by checkBattleTokenDestroyed just before a destroyed token is removed — see Visual Polish checkpoint
let battleMapOrdnanceEls = {};     // salvo_id -> ordnance marker DOM element
let battleMapPrevOrdnanceIds = new Set(); // salvo_ids seen on the previous render, to detect resolved/removed payloads
let battleMapLastEncounterId = null; // hard-resets the three maps above when the active battle itself changes

/* --- PER-ROW TOKEN STORAGE (Command Terminal refactor, Phase 0, 2026-09-30) ---
   Battle Map tokens used to live in ONE jsonb array on the battle_encounters
   row, and every move rewrote the whole array -- two people dragging at the
   same moment could silently undo each other (last writer wins), and every
   single move made every client reload the whole encounter. Tokens now live
   in the `battle_tokens` table, one row per token (id = the old token_id).

   The IN-MEMORY shape is deliberately unchanged:
   window.globalBattleEncounterCache.tokens is still an array of
   { token_id, ship_marker_id, x, y, move_remaining, initiative?, ap_current?, ... }
   so every one of the ~30 places that READS tokens keeps working untouched.
   Only the write path changed: saveBattleTokens(newArray) now diffs the new
   array against the last-known saved state and writes just what changed --
   an insert for a new token, a column-level update for a changed one, a
   delete for a removed one. Other clients get per-row realtime deltas
   (battle_tokens_stream below) instead of a full encounter reload.

   Legacy battles: the first time any client loads an encounter whose
   `tokens_migrated` flag is false, its old jsonb tokens are copied into
   battle_tokens (duplicate-safe) and the flag is set. The old
   battle_encounters.tokens column is left in place as dead schema, never
   written again (same precedent as ship_markers.owner_id). */
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
    // Empty the legacy column once its contents are copied, so anything that
    // shows up in it LATER can only have come from a browser still running
    // the pre-2026-09-30 code (a stale cache) -- and gets picked up by the
    // next load instead of silently vanishing (live bug, 2026-09-30: the DM's
    // browser was on the old build, placed two ships into this column, and
    // nobody on the new build could see them).
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
    // Battle music hook (2026-08 audio polish): this function already runs
    // on EVERY connected client via battle_encounters_stream below, whoever
    // started/ended the fight -- so comparing the active-state edge here
    // fires the music bed for the whole table, not just the DM's browser.
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
/* Phase 4d (2026-10-02): server-side fog of war. battle_tokens' read rule now
   withholds tokens of hidden ships from everyone except the DM and the ship's
   owner(s) (public.df_battle_token_visible). Realtime never re-sends a row
   that just BECAME visible, so when a ship this player couldn't see turns
   visible (un-hidden, or handed to them) we re-fetch the battle's tokens.
   Called from the ship_markers realtime handler (js/db.js) after the vessel
   cache refreshes. First call only seeds the set. DM sees everything: no-op. */
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

/* --- BATTLE BROADCAST CHANNEL (Command Terminal refactor, Phase 0, 2026-09-30) ---
   An ephemeral Supabase Realtime *broadcast* channel per battle
   ('battle:<encounter id>'), for things that should be SEEN by everyone but
   never STORED: weapon-fire effects and destruction explosions today;
   drag previews, rulers and pings in later phases. Nothing here touches
   the database. Before this, fire/explosion effects only ever played on
   the firing player's own screen (see the old note on
   window.playWeaponFireEffect). Same broadcast mechanism db.js already
   uses for tactical pings. self:false -- a sender never receives its own
   message, so nothing plays twice. Receivers skip any effect involving a
   vessel they aren't allowed to see (hidden ships). */
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
        // Everyone at the table now hears the shot too (it used to play only
        // on the shooter's own device); the impact sound follows it.
        if (window.AudioEngine && window.AudioEngine.playShoot) { try { window.AudioEngine.playShoot(); } catch (e) {} }
        window.playWeaponFireEffect(p.src, p.dst, p.col || undefined, p.dmg || undefined, true);
    } else if (p.k === 'boom') {
        if (p.marker && !visible(p.marker)) return;
        if (typeof p.x !== 'number' || typeof p.y !== 'number') return;
        window.battleRenderer.destruction(p.x, p.y);
    } else if (p.k === 'tape' && typeof window.showRemoteTape === 'function') {
        window.showRemoteTape(p); // shared measuring tape (Phase 4b, js/grid-tools.js)
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

    // Phase 7: optional map from the library (js/battle-maps.js), stored as a snapshot.
    const map = typeof window.pickedStartMap === 'function' ? window.pickedStartMap() : null;
    // Phase 10: terrain rules per battle (stored on the map snapshot).
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

/* Same signature every caller already used: hand it the complete new token
   array. It updates the local cache immediately, then writes ONLY the
   differences to battle_tokens (see the PER-ROW TOKEN STORAGE comment near
   the top of this file). Returns once every write has settled. */
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
    // Auto-callsigns (Phase 1, 2026-10-01): whenever this browser adds
    // ships to the battle, give same-named NPC copies clean callsigns.
    if (inserts.length > 0 && typeof window.assignBattleCallsigns === 'function') window.assignBattleCallsigns();
}
window.saveBattleTokens = saveBattleTokens;

function clampToGrid(x, y) {
    return {
        x: Math.max(0, Math.min(BATTLE_GRID_W - BATTLE_TOKEN_SIZE, x)),
        y: Math.max(0, Math.min(BATTLE_GRID_H - BATTLE_TOKEN_SIZE, y))
    };
}

/* Called from js/combat.js's renderVesselDeck weapon-target dropdown. Returns
   null when there's no restriction to apply (no active battle, or this
   vessel isn't currently a token in it) so the caller falls back to its
   existing full-galaxy target list unchanged. Returns an array of
   {id, name} (battle tokens other than the vessel itself) otherwise. */
// Small shared lookup used across Movement, Range, and the ordnance/PD
// automation below — returns the {x,y} of a ship_marker's current token in
// the active battle, or null if there's no active battle or it isn't in it.
window.getBattleTokenPosition = function(vesselId) {
    if (!window.globalBattleEncounterCache) return null;
    const tok = (window.globalBattleEncounterCache.tokens || []).find(t => t.ship_marker_id === vesselId);
    return tok ? { x: tok.x, y: tok.y } : null;
};

// `range` (optional, grid px) added this session for the Range/Ordnance
// build: when provided and > 0, candidates further than `range` from the
// firing vessel's own token are filtered out. 0/undefined preserves the
// original "no restriction" behavior — legacy callers that don't pass a
// range are completely unaffected.
// Fog of War build (this session): a hidden vessel is also excluded here --
// this is the single choke point behind BOTH ship_weapons' and squadron
// weapons' target dropdowns (js/combat.js), so filtering here covers both
// surfaces at once instead of duplicating the check at each call site. Uses
// window.isVesselVisibleToMe so the vessel's own player-owner (if any) still
// sees it in their own dropdown even while it's hidden from everyone else.
// Weapon Range Tiers build (this session): now takes an optional `opts`
// ({ firerVessel, wpn }) so the per-CANDIDATE effective range (short-range-
// vs-capital cap, target-uplink exception -- see getEffectiveWeaponRange
// above) can be applied instead of one flat `range` for every candidate.
// Every existing caller was updated to pass it; `range` alone still works
// as a plain flat-distance filter for any caller that doesn't (none left,
// kept for safety/back-compat rather than assuming every call site here
// and in every other file got updated).
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
      // Firing arcs (Phase 3, 2026-10-02): out-of-arc targets are dropped,
      // unless the caller asks to keep them flagged (the weapon dropdowns
      // show them greyed with "out of arc" so they don't silently vanish).
      .map(m => ({ id: m.id, name: m.name, is_strike_craft: m.is_strike_craft, out_of_arc: !!(wpn && typeof window.isTargetInArc === 'function' && !window.isTargetInArc(vesselId, m.id, wpn)),
          // Phase 10: terrain (planet/station in the way, or hidden in a nebula past lock range)
          terrain_block: (typeof window.terrainFireCheck === 'function' ? window.terrainFireCheck(vesselId, m.id) : '') }))
      .filter(m => (!m.out_of_arc && !m.terrain_block) || (opts && opts.includeOutOfArc));
};

/* Ordnance LAUNCH (Range/Ordnance build, this session). An ordnance-classified
   weapon's button calls this instead of window.rollShipWeapon. If the firer
   isn't currently a token in an active battle, there's no grid to track a
   multi-turn flight against, so this just delegates straight to the old
   instant-resolve behavior — same fallback pattern as every other
   battle-scoped feature in this file. Inside an active battle, this
   validates + consumes ammo/cooldown exactly like a normal shot (mirroring
   rollShipWeapon's own checks, since this replaces that call for ordnance
   weapons specifically) but does NOT roll damage — it snapshots the
   weapon's profile into a new battle_encounters.in_flight_ordnance entry
   instead. Aging, the turn-1 split into 6, PD auto-fire, and impact
   resolution all happen in window.processBattleRoundAutomations, called
   from combat.js's advanceCombatRound. */
// Shared by deployTemplateToBattle and deployFleetToBattle (Saved Fleets
// follow-on, this session) — same stagger formula both used to duplicate.
// tokenCount is however many tokens are already placed (plus however many
// this same batch-deploy has already placed before this call).
function staggeredTokenPos(tokenCount) {
    const stagger = tokenCount * 24;
    return clampToGrid(20 + (stagger % (BATTLE_GRID_W - 60)), 20 + Math.floor(stagger / (BATTLE_GRID_W - 60)) * 40);
}

window.deployTemplateToBattle = async function() {
    if (currentUserRole !== 'dm' || !window.globalBattleEncounterCache) return;
    const select = document.getElementById('battle-map-template-select');
    if (!select || !select.value) { alert('Select a template first.'); return; }
    // 2026-10-01 (DM report): ships deployed from the Battle Map used to
    // appear on the galaxy map too. They're Battle-Map-only now, same as
    // preset NPCs and hangar-launched strike craft (hide_from_galaxy_map).
    // silent: no "deployed to your DRADIS position" toast -- it isn't there.
    const newId = await window.deployShipTemplate(select.value, { silent: true, overrides: { hide_from_galaxy_map: true } });
    if (!newId) return; // deployShipTemplate already alerted on failure
    if (window.AudioEngine) window.AudioEngine.playPing();
    // deployShipTemplate fires its own loadGalaxyData() without awaiting it,
    // so globalShipMarkersCache may not have the new marker yet — await our
    // own call here so the token we're about to place doesn't briefly render
    // as "(vessel not found)" on the DM's own client.
    if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
    const tokens = (window.globalBattleEncounterCache.tokens || []).slice();
    const pos = staggeredTokenPos(tokens.length);
    const newVessel = globalShipMarkersCache.find(m => m.id === newId);
    tokens.push({ token_id: genBattleTokenId(), ship_marker_id: newId, x: pos.x, y: pos.y, move_remaining: newVessel?.tactical_speed ?? 160 });
    await saveBattleTokens(tokens);
    window.renderBattleMapPanel();
};

// Saved Fleets follow-on (this session) — deploys every member of a saved
// fleet composition in one click instead of one deployTemplateToBattle
// click per vessel. Loops window.deployShipTemplate once per unit (quantity
// times per member) — each call is the SAME real deploy path a single
// template deploy already uses, so a fleet vessel is exactly as fresh/
// fully-stocked as if placed individually; there's no separate "fleet
// vessel" data model and nothing carries over from a prior battle, since
// each deploy creates a brand-new ship_markers row.
//
// Pending-list follow-up (this session): originally had no confirmation
// prompt at all (an asymmetry with every other DM action in this panel,
// flagged in the checkpoint notes) and silently skipped any member whose
// saved template_id no longer resolved to a real template — deployShipTemplate
// only alerts on a genuine DB insert error, not on "template not found", so
// a deleted-template member used to just vanish from the placed count with
// nothing surfaced anywhere. Both closed out: missing-template members are
// now detected up front and named in the confirm prompt (and in the
// resulting chat log line) instead of silently disappearing mid-loop.
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
        if (!findAnyTemplateById(member.template_id)) continue; // already warned above — skip entirely, don't attempt
        for (let i = 0; i < (member.quantity || 1); i++) {
            const newId = await window.deployShipTemplate(member.template_id, { silent: true, overrides: { hide_from_galaxy_map: true } }); // Battle-Map-only, see deployTemplateToBattle
            if (!newId) continue; // deployShipTemplate already alerted on a real DB error — skip this unit, keep going with the rest of the fleet
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

/* DAMAGE RING (Command Terminal refactor, Phase 1, 2026-10-01) ---
   Every Battle Map token gets rings showing how much it has left:
   - inner ring = HULL: filled clockwise from 12 o'clock in the existing
     hull color (green > 66%, amber > 33%, red below), the lost part grey.
   - outer ring = SHIELDS (cyan), only for ships that have shields at all
     and never for strike craft (their tokens are too small for two rings).
   Pure CSS (conic-gradient + a mask that hollows it into a ring), so it
   costs nothing per frame on phones. Numbers are in the token's tooltip.
   Visibility follows the token itself -- anyone who can see a token sees
   its rings (same as the side card's health bars for visible ships). */
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

/* Visual Polish build (this session, confirmed design): "player-owned" (an
   owner profile with role !== 'dm') is the same heuristic already used
   throughout this app (renderBattleShipCards' fullDetail check, Battlefield
   Salvage's spawn condition, Ground Combat's PC-vs-NPC filter) rather than a
   new one invented for this. For the DM's own view this naturally collapses
   to a clean 2-tier result (every player ship reads as "ally" green, every
   DM/NPC ship reads red) since no player id ever equals the DM's own
   currentUserId. For a player's view it's a real 3-tier read: their own
   ship (cyan), another player's (green), DM/NPC (red). */
function battleTokenFactionColor(vessel) {
    if (!vessel) return '#6b826a';
    const ownerProfs = window.vesselOwnerIds(vessel).map(id => (typeof allProfiles !== 'undefined' ? allProfiles : []).find(p => p.id === id)).filter(Boolean);
    const isPlayerOwned = ownerProfs.some(p => p.role !== 'dm');
    if (!isPlayerOwned) return '#ff3333';           // DM/NPC-owned (or unowned) — hostile/neutral
    if (window.vesselHasOwner(vessel, currentUserId)) return '#00e1ff'; // I'm one of its owners
    return '#00e5a3';                                // another player's vessel (I'm not a co-owner) — ally
}

/* ==========================================================================
   BATTLE RENDERER (Command Terminal refactor, Phase 0, 2026-10-01)
   ==========================================================================
   Everything that DRAWS the battle grid now goes through one object,
   window.battleRenderer, instead of being spread through this file. The
   rules (movement limits, turns, AP, firing) never touch the DOM grid
   directly any more -- they ask the renderer to convert a screen point into
   grid coordinates (screenToWorld / screenDeltaToWorld) and hand it the
   current tokens to draw (sync). That's the seam a future Three.js renderer
   (roadmap Phase 6) plugs into: implement the same five methods and swap
   window.battleRenderer -- no rules code changes.

   Coordinates: "world" = the grid's own logical px space (BATTLE_GRID_W x
   BATTLE_GRID_H, origin top-left, +y down), the space every stored token
   x/y, range and move_remaining already uses. "Screen" = browser clientX/Y.

   DomBattleRenderer is the existing plain-DOM grid, moved here unchanged:
   persistent token divs diffed every render (CSS transitions animate moves),
   the ordnance overlay, and the four weapon-fire effect families. */
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
    // Grid point -> screen point (for anchoring HUD panels over a token later).
    worldToScreen(x, y) {
        const grid = this.grid();
        if (!grid) return null;
        const rect = grid.getBoundingClientRect();
        return { x: rect.left + x * BATTLE_GRID_SCALE, y: rect.top + y * BATTLE_GRID_SCALE };
    },
    // Draw/refresh every visible token + in-flight ordnance for this encounter.
    sync(encounter, tokens) {
        // Animation Engine build (this session): diff against existing DOM
        // elements instead of the old innerHTML='' + full rebuild every render.
        // A token's element now persists across renders, which is what lets the
        // .battle-token-el CSS transition (style.css) actually animate a
        // position change instead of teleporting -- e.g. another player's drag
        // syncing in through realtime, a fresh deploy landing via
        // staggeredTokenPos, or resetBattleMapMovement's round tick.
        const grid = document.getElementById('battle-map-grid');
        if (grid) {
            grid.onclick = window.handleBattleGridClick;

            // Switching to a different active battle (or to none) invalidates
            // every cached element outright -- stale token/ordnance divs from a
            // PRIOR encounter must never leak into this one.
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
            // Initiative + Action Economy build (this session): whose turn it is,
            // for the glow highlight below -- undefined/harmless when initiative
            // hasn't been rolled for this battle.
            const currentTurnTokenId = (encounter.initiative_rolled && (encounter.turn_order || []).length > 0)
                ? encounter.turn_order[encounter.current_turn_index]
                : null;
            tokens.forEach(tok => {
                const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
                // Fog of War build (this session): a hidden token is simply
                // never added to seenTokenIds -- the cleanup pass below (which
                // removes any tokenEl NOT in that set) then deletes its DOM
                // element on this render if it had one, or the token just never
                // gets created in the first place. The DM and the vessel's own
                // player-owner still see it normally.
                if (vessel && typeof window.isVesselVisibleToMe === 'function' && !window.isVesselVisibleToMe(vessel)) return;
                seenTokenIds.add(tok.token_id);
                const isStationTok = !!(vessel && vessel.is_station);
                const isStrikeCraftTok = !!(vessel && vessel.is_strike_craft);
                const moveRemaining = tok.move_remaining !== undefined ? tok.move_remaining : ((vessel?.tactical_speed ?? 160));

                let tokenEl = battleMapTokenEls[tok.token_id];
                if (!tokenEl) {
                    tokenEl = document.createElement('div');
                    tokenEl.className = 'battle-token-el';
                    tokenEl.dataset.tokenId = tok.token_id; // Phase 4b: lets grid tools find a token's element
                    tokenEl.style.position = 'absolute';
                    tokenEl.style.left = tok.x + 'px';
                    tokenEl.style.top = tok.y + 'px';
                    grid.appendChild(tokenEl);
                    battleMapTokenEls[tok.token_id] = tokenEl;
                    wireTokenDrag(tokenEl, tok.token_id, tok.ship_marker_id);
                }
                // Visual Polish build: kept even after the token leaves `tokens`
                // (updated every render while the token is present) so the
                // removal pass below can still look up which vessel a just-
                // vanished token belonged to, for the destruction-effect check.
                battleMapTokenMarkerIds[tok.token_id] = tok.ship_marker_id;

                tokenEl.title = isStationTok
                    ? `${vessel.name} — stationary platform, immobile`
                    : isStrikeCraftTok
                    ? `${vessel.name} — strike craft, Move: ${moveRemaining}/${vessel.tactical_speed ?? 160} px remaining. Fire from the Hangar Bay panel, not this token.`
                    : `${vessel ? vessel.name : '(vessel not found)'} — Move: ${moveRemaining}${vessel ? '/' + (vessel.tactical_speed ?? 160) : ''} px remaining this round`;
                if (vessel) tokenEl.title += battleTokenIntegrityText(vessel);
                // left/top set separately from the rest so re-applying the same
                // value every render (nothing moved) never re-triggers the CSS
                // transition -- only an ACTUAL change animates.
                tokenEl.style.left = tok.x + 'px';
                tokenEl.style.top = tok.y + 'px';
                const tokenSize = isStrikeCraftTok ? BATTLE_STRIKE_CRAFT_TOKEN_SIZE : BATTLE_TOKEN_SIZE;
                tokenEl.style.width = tokenSize + 'px';
                tokenEl.style.height = tokenSize + 'px';
                tokenEl.style.borderRadius = isStationTok ? '4px' : '50%';
                tokenEl.style.background = '#0a1410';
                // Strike Craft Grid Position build: a dashed border is the only
                // visual differentiator (kept intentionally light — squadrons
                // don't get their own ship-status card, see the checkpoint notes
                // for why the data model doesn't fit renderBattleShipCards).
                // Damage ring build (Phase 1, 2026-10-01): the token's own
                // border now carries the FACTION color (whose ship it is),
                // and hull/shields are shown by the rings drawn around it
                // (battleTokenDamageRingsHtml below) -- the old HP-colored
                // border is superseded by the hull ring, which shows the
                // same color AND how much is left.
                tokenEl.style.border = `2px ${isStrikeCraftTok ? 'dashed' : 'solid'} ${battleTokenFactionColor(vessel)}`;
                // Initiative + Action Economy build (this session): a bright
                // glow on whichever token currently has the turn -- purely
                // additive to the existing HP-color border above, cleared for
                // every other token by re-setting boxShadow unconditionally
                // every render (same "re-apply every render" pattern the rest
                // of this loop already uses).
                const isCurrentTurnTok = !!(currentTurnTokenId && tok.token_id === currentTurnTokenId);
                tokenEl.style.display = 'flex';
                tokenEl.style.alignItems = 'center';
                tokenEl.style.justifyContent = 'center';
                // Polish pass (this session): strike craft tokens are now much
                // smaller (BATTLE_STRIKE_CRAFT_TOKEN_SIZE above) -- a bit bigger
                // relative font so the single emoji glyph doesn't look lost, and
                // the name text drops entirely below (an emblem, not a label;
                // the full name still shows in the hover title set above).
                tokenEl.style.fontSize = isStrikeCraftTok ? '11px' : '8px';
                tokenEl.style.color = vessel ? (vessel.color || '#00e5a3') : '#ff3333';
                tokenEl.style.cursor = isStationTok ? 'pointer' : 'grab';
                tokenEl.style.userSelect = 'none';
                // Fog of War build (this session): the token is only ever built
                // for a viewer who's allowed to see it at all (see the
                // isVesselVisibleToMe skip above) -- for the DM specifically,
                // dim it slightly so a hidden-from-players token is still
                // visually distinguishable on their own grid, without changing
                // anything a player (who never gets this token built) would see.
                tokenEl.style.opacity = (vessel && vessel.is_hidden && currentUserRole === 'dm') ? '0.55' : '1';
                // Visual Polish build (this session): an outer ring in the
                // viewer's own faction color (mine/ally/DM-NPC), layered outside
                // the existing HP-color border via a second box-shadow ring
                // rather than replacing that border -- HP state stays visible,
                // ownership becomes ALSO visible at a glance without a click
                // into the side card.
                // Bug fix (2026-10-01): this line used to overwrite the gold
                // "current turn" glow set a few lines above on every render,
                // so the glow never actually showed. The faction color is on
                // the border now; the shadow only carries the turn glow.
                tokenEl.style.boxShadow = '0 0 6px rgba(0,0,0,0.6)';
                // The current-turn glow is a pulsing ring drawn by CSS
                // (.battle-token-current-turn::after in style.css), so it
                // survives re-renders and animates without per-frame repaints.
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
                // Phase 3 (2026-10-02): nose chevron + rotate knob (js/firing-arcs.js; no-op while the firing_arcs switch is off).
                if (typeof window.decorateBattleTokenHeading === 'function') window.decorateBattleTokenHeading(tokenEl, tok, vessel);
                if (!isStationTok && moveRemaining < 0) {
                    const moveBadge = document.createElement('div');
                    moveBadge.style.cssText = 'position:absolute; top:-8px; right:-4px; background:#ff3333; color:#030403; font-size:7px; font-weight:bold; border-radius:6px; padding:0 3px; pointer-events:none;';
                    moveBadge.innerText = '!';
                    tokenEl.appendChild(moveBadge);
                }
            });

            // Remove elements for tokens no longer present (withdrawn/destroyed).
            // Visual Polish build: if the removed token has a matching entry in
            // battleMapPendingExplosions (staged by checkBattleTokenDestroyed
            // just before this render ran), play a destruction effect at its
            // last known position first. A plain withdraw/recall never stages
            // an entry, so those vanish silently exactly as before.
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
/* Battle Map render hooks (consolidation pass, 2026-10-08). Other files used
   to wrap window.renderBattleMapPanel one inside another, so what ran when
   depended on script order. Now they register here instead:
     window.onBattleMapRender(name, fn, order)
   Every hook runs after each render, lowest `order` first; a hook that
   throws is logged and the rest still run. Registering the same name again
   replaces it. */
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
    // activeContainer is now the two-column .battle-map-layout flex box
    // (full-screen build, this session) — 'flex', not 'block', or the grid
    // + ship-cards columns collapse back to a single stacked column.
    activeContainer.style.display = encounter ? 'flex' : 'none';
    if (!encounter) return;

    document.getElementById('battle-map-encounter-name').innerText = encounter.name;
    const endBtn = document.getElementById('battle-map-end-btn');
    if (endBtn) endBtn.style.display = isDm ? 'inline-block' : 'none';
    // Initiative + Action Economy build (this session): ADVANCE ROUND is now
    // only the pre-initiative free-for-all's round tick -- once a battle has
    // real initiative rolled, ending the last turn in the order fires the
    // exact same tick automatically (window.endCurrentTurn), so a DM
    // manually clicking ADVANCE ROUND mid-turn-order would desync the two.
    // ROLL INITIATIVE is the mirror image: only useful before that's
    // happened for this battle.
    const advanceBtn = document.getElementById('battle-map-advance-btn');
    // ADVANCE ROUND was already functionally DM-only (advanceCombatRound
    // itself returns immediately for a non-DM caller) but the button had no
    // visibility check of its own, so a player saw a clickable button that
    // silently did nothing -- tester feedback asked for it hidden outright.
    // Same toggle pattern as endBtn above.
    if (advanceBtn) advanceBtn.style.display = (isDm && !encounter.initiative_rolled) ? 'inline-block' : 'none';
    const rollInitBtn = document.getElementById('battle-map-roll-initiative-btn');
    if (rollInitBtn) rollInitBtn.style.display = (isDm && !encounter.initiative_rolled) ? 'inline-block' : 'none';
    const dmDeploy = document.getElementById('battle-map-dm-deploy');
    if (dmDeploy) dmDeploy.style.display = isDm ? 'block' : 'none';
    // Undo log (2026-10-01): DM-only, behind the 'battle_undo' feature switch.
    const showUndo = isDm && typeof window.isFeatureOn === 'function' && window.isFeatureOn('battle_undo');
    ['battle-map-undo-btn', 'battle-map-redo-btn', 'battle-map-log-btn'].forEach(id => { const b = document.getElementById(id); if (b) b.style.display = showUndo ? 'inline-block' : 'none'; });

    const tokens = encounter.tokens || [];

    // --- Turn bar (Initiative + Action Economy build, this session) ---
    const turnBar = document.getElementById('battle-map-turn-bar');
    if (turnBar) {
        if (encounter.initiative_rolled && (encounter.turn_order || []).length > 0) {
            turnBar.style.display = 'flex';
            const turnOrder = encounter.turn_order || [];
            const curTokId = turnOrder[encounter.current_turn_index];
            const curTok = tokens.find(t => t.token_id === curTokId);
            const curVessel = curTok ? globalShipMarkersCache.find(m => m.id === curTok.ship_marker_id) : null;
            const turnInfo = document.getElementById('battle-map-turn-info');
            // "Your turn" alert (2026-10-01): a chime on the owning player's
            // own device the moment their ship's turn comes up -- once per
            // turn, so re-renders don't repeat it. The DM doesn't get it.
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
            // Cheap, idempotent tail check (own in-flight guard) -- picks up
            // any token placed/launched onto the grid after initiative was
            // first rolled for this battle.
            if (typeof window.ensureNewTokensInTurnOrder === 'function') window.ensureNewTokensInTurnOrder();
        } else {
            turnBar.style.display = 'none';
        }
    }

    // --- Grid / placed tokens --- drawn by the active renderer (see
    // BATTLE RENDERER below). Today that's always the DOM renderer, which is
    // exactly the code that used to live inline here.
    window.battleRenderer.sync(encounter, tokens);

    // --- Palette (undeployed candidates) ---
    const placedIds = new Set(tokens.map(t => t.ship_marker_id));
    const palette = document.getElementById('battle-map-palette');
    if (palette) {
        // Bug fix (2026-08-29, DM report): a DM prepping an encounter needs
        // to place a PLAYER's vessel (e.g. their primary combat ship), not
        // just their own NPC markers -- but every NPC in this app is ALSO
        // owned by the DM's own account, so the old "your own vessels only"
        // rule (still correct for a player's own self-service placement)
        // silently hid every PC ship from the DM's palette with no error,
        // just an empty/wrong-looking list. globalShipMarkersCache already
        // holds every vessel regardless of owner (js/map.js's
        // loadGalaxyData does an unfiltered `.select('*')`), so this is a
        // pure display-filter fix, no new query needed. A non-DM player
        // keeps the old own-vessels-only behavior unchanged.
        const candidates = globalShipMarkersCache.filter(m => !m.is_strike_craft && !placedIds.has(m.id) && (isDm || window.vesselHasOwner(m, currentUserId)));
        if (candidates.length === 0) {
            palette.innerHTML = '<span style="font-size:9px; color:#6b826a;">No available vessels to place.</span>';
        } else {
            palette.innerHTML = candidates.map(m => {
                const armed = window.battleMapArmedToken && window.battleMapArmedToken.ship_marker_id === m.id;
                // DM view only: label another player's vessel with their
                // username (from live presence, the only owner->name lookup
                // already loaded in this app -- offline owners just show no
                // suffix rather than a stale/guessed name) so a DM looking
                // at a mixed NPC+PC list can tell them apart at a glance.
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

    // --- DM saved-fleet deploy select (Saved Fleets follow-on, this session) ---
    const fleetSelect = document.getElementById('battle-map-fleet-select');
    if (fleetSelect && isDm) {
        const fleets = window.globalSavedFleetsCache || [];
        fleetSelect.innerHTML = fleets.length === 0
            ? '<option value="">-- No saved fleets --</option>'
            : fleets.map(f => `<option value="${f.id}">${f.name} (${(f.members || []).reduce((n, m) => n + (m.quantity || 1), 0)} vessels)</option>`).join('');
    }

    // --- Ship-status cards (weapons + health) — replaces the old plain
    // "Engaged Roster" list this session; see window.renderBattleShipCards
    // below for the permission rule (own/allied vs. DM/NPC vessels).
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

    // Manual Damage Application build (this session): keep the DM Tools
    // "MANUAL DMG" subtab's Firer/Target dropdowns in sync with whatever's
    // actually deployed right now -- cheap, idempotent, called unconditionally
    // same as every other tail-of-render refresh in this codebase (e.g. the
    // Custom Star Tracker refresh in window.loadGalaxyData).
    if (typeof window.renderManualDamagePanel === 'function') window.renderManualDamagePanel();
};
