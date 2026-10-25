/* ==========================================================================
   js/scene-maps.js - Scene Map (non-combat scene view)
   ==========================================================================
   DM decisions:
   - A SEPARATE light 2D view (not a Battle Map mode): background colour,
     optional grid (lines / dots), labelled AREAS and free TEXT labels.
   - Freeform placement (no snapping, no measured distances, no turns).
   - Players drag their OWN token; the DM moves everything.
   - The DM preps any number of scenes; ONE is live at a time and shows for
     everyone (a pill to reopen it; it opens by itself for players when the
     DM puts a new scene live).
   - HIDDEN tokens (dashed for the DM) never reach players: the server only
     returns shown tokens of the live scene (RLS scene_tokens_read), and a
     player's move goes through df_scene_move_token (own shown token on the
     live scene only, kept inside the map). REVEAL makes a token appear for
     everyone with a short glow.

   Storage: scene_maps (one row per scene; marks jsonb = areas + labels;
   readable by everyone so "scene ended" reaches players; DM writes) and
   scene_tokens (one row per token; DM writes). Every DM write bumps
   scene_maps.rev so players reload even when the changed token is one they
   are no longer allowed to read (a token that was just hidden).
   Feature switch 'scene_maps' gates the DM tools; a live scene shows for
   everyone. */
(function () {
const esc = (v) => window.escapeHtml(v == null ? '' : String(v));
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
const me = () => (typeof currentUserId !== 'undefined' ? currentUserId : null);
const isPhone = () => (window.innerWidth || 1200) <= 768;
window.sceneMapsAllowed = function () { return isDm() && typeof window.isFeatureOn === 'function' && window.isFeatureOn('scene_maps'); };

const KIND_COLOR = { pc: '#00e1ff', npc: '#ff6b6b', object: '#c9962f' };
const TOKEN_BASE = 44; // token diameter in map units at size 1
const S = window.__scene = {
    list: [], tokens: [], viewId: null, view: false, sel: null, drag: null,
    scale: 1, lastLive: undefined, known: {}, appear: new Set(), pending: false, loaded: false,
    presets: [], presetsLoaded: false
};

/* --- Pure helpers (tested) --- */
// Board scale: fit the map in the space left (phones: the whole room in view; past
// the minimum the board scrolls). Tokens keep a tappable size either way (sceneTokenPx).
window.sceneFitScale = function (w, h, availW, availH, phone) {
    const fit = Math.min(availW / Math.max(1, w), availH / Math.max(1, h));
    return Math.max(phone ? 0.25 : 0.3, Math.min(2, fit));
};
// Token diameter on screen: grows with the board but stays tappable on phones.
window.sceneTokenPx = function (scale, size) {
    return Math.round(Math.max(28, Math.min(60, TOKEN_BASE * scale)) * Math.max(0.4, Math.min(4, Number(size) || 1)));
};
window.sceneClamp = function (scene, x, y) {
    const w = (scene && scene.width) || 1200, h = (scene && scene.height) || 800;
    return [Math.max(0, Math.min(w, Math.round(Number(x) || 0))), Math.max(0, Math.min(h, Math.round(Number(y) || 0)))];
};
// Who may drag a token: the DM always; a player only their own shown token on the live scene.
window.sceneCanDrag = function (tok, scene) {
    if (!tok || !scene) return false;
    if (isDm()) return true;
    return !!(scene.is_active && !tok.is_hidden && tok.profile_id && tok.profile_id === me());
};
/* --- Object library ---
   Built-in starter presets (DM decision: real shapes, plus the DM's own saved
   presets in scene_object_presets). Sizes are map units; a person token is 44
   across, so roughly 40 units = 1 m. Objects are rectangles centred on x/y,
   turned in 90 degree steps, resized by the corner handle. */
const OBJECT_LIBRARY = [
    ['Furniture', [['Table', 80, 80, '#7f8c99'], ['Long table', 200, 70, '#7f8c99'], ['Bar counter', 240, 50, '#8a7a66'], ['Chair', 30, 30, '#6b7f8a'], ['Bench', 120, 30, '#6b7f8a'], ['Bed / med cot', 50, 100, '#9fd3e0']]],
    ['Tech', [['Console', 80, 40, '#00e1ff'], ['Wall screen', 160, 14, '#7fe8ff'], ['Holotable', 160, 120, '#ffd700'], ['Terminal', 40, 30, '#00e5a3'], ['Server rack', 50, 90, '#4fc3f7']]],
    ['Storage', [['Crate', 40, 40, '#c9962f'], ['Cargo container', 240, 100, '#d98c3a'], ['Locker', 40, 60, '#9fb4bd'], ['Weapons rack', 120, 30, '#ff6b6b']]],
    ['Structure', [['Door', 80, 14, '#ffaa00'], ['Airlock', 100, 100, '#1f8cbe'], ['Wall segment', 240, 20, '#566a72'], ['Barricade / cover', 120, 30, '#5a6e4a'], ['Lift / ladder', 80, 80, '#9fb4bd'], ['Pillar', 50, 50, '#8fa7b0']]]
].map(([category, items]) => ({ category, items: items.map(([name, w, h, color]) => ({ id: 'b:' + name, builtin: true, name, category, kind: 'object', shape: 'rect', w, h, size: 1, color, note: '' })) }));
window.SCENE_OBJECT_LIBRARY = OBJECT_LIBRARY;
const isRect = (t) => !!(t && t.shape === 'rect');
const normRot = (r) => ((Math.round((Number(r) || 0) / 90) * 90) % 360 + 360) % 360;
window.sceneNormRot = normRot;
// Screen box of a rectangle object (unrotated box; CSS `rotate` turns it about its centre).
window.sceneRectBox = function (t, s) {
    const w = Math.max(4, (Number(t.w) || 40) * s), h = Math.max(4, (Number(t.h) || 40) * s);
    return { left: t.x * s - w / 2, top: t.y * s - h / 2, width: w, height: h };
};
// Corner-handle resize of a turned rectangle: the drag (map units) is read in the
// object's own frame, the opposite corner stays put, so the centre shifts by half the growth.
window.sceneResizeRect = function (t, dx, dy) {
    const r = normRot(t.rot) * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
    const lx = dx * c + dy * sn, ly = -dx * sn + dy * c;
    const ow = Number(t.w) || 40, oh = Number(t.h) || 40;
    const w = Math.max(10, Math.round(ow + lx)), h = Math.max(10, Math.round(oh + ly));
    const hx = (w - ow) / 2, hy = (h - oh) / 2;
    return { w, h, x: Math.round(t.x + hx * c - hy * sn), y: Math.round(t.y + hx * sn + hy * c) };
};
function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return `rgba(120,140,150,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function initials(name) {
    const w = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
}
const newId = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function playerProfiles() {
    return (typeof allProfiles !== 'undefined' ? allProfiles : []).filter(p => p.role !== 'dm');
}
function profileName(id) {
    const p = playerProfiles().find(x => x.id === id);
    return p ? ((p.character && p.character.name) || p.username || 'Player') : '';
}

/* --- Loading --- */
const liveScene = () => S.list.find(s => s.is_active) || null;
const viewedScene = () => S.list.find(s => s.id === S.viewId) || null;
window.sceneLive = liveScene;
window.loadSceneMaps = async function () {
    const dm = isDm();
    let q = db.from('scene_maps').select('*');
    q = dm ? q.order('created_at', { ascending: true }) : q.eq('is_active', true);
    const { data, error } = await q;
    if (error) { console.error('loadSceneMaps failed', error); return; }
    S.list = data || [];
    const live = liveScene();
    if (!dm) S.viewId = live ? live.id : null;
    else if (!viewedScene()) S.viewId = live ? live.id : (S.list[0] ? S.list[0].id : null);
    // Players: a NEW live scene during the session opens by itself.
    const liveId = live ? live.id : null;
    if (S.loaded && !dm && liveId && liveId !== S.lastLive) S.view = true;
    if (!liveId && !dm) S.view = false;
    S.lastLive = liveId; S.loaded = true;
    if (dm && !S.presetsLoaded) {
        const pr = await db.from('scene_object_presets').select('*').order('created_at', { ascending: true });
        if (!pr.error) { S.presets = pr.data || []; S.presetsLoaded = true; }
    }
    await loadTokens();
    renderFromRemote();
};
async function loadTokens() {
    const sc = viewedScene();
    if (!sc) { S.tokens = []; return; }
    const { data, error } = await db.from('scene_tokens').select('*').eq('scene_id', sc.id);
    if (error) { console.error('scene tokens load failed', error); return; }
    // Players never draw a hidden token, even before the server copy lands.
    const rows = (data || []).filter(t => isDm() || !t.is_hidden).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    // Tokens that weren't there a moment ago (same scene) get the reveal glow.
    const before = S.known[sc.id];
    S.appear = new Set(before ? rows.filter(t => !before.has(t.id)).map(t => t.id) : []);
    S.known[sc.id] = new Set(rows.map(t => t.id));
    S.tokens = rows;
}
let reloadTimer = null, subscribed = false;
function queueReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => window.loadSceneMaps(), 150); }
function subscribe() {
    if (subscribed || !db.channel) return;
    subscribed = true;
    try {
        db.channel('scene_maps_stream')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'scene_maps' }, queueReload)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'scene_tokens' }, queueReload)
            .subscribe();
    } catch (e) { console.warn('scene maps realtime unavailable', e); }
}

/* --- DM writes --- */
async function touchScene(sc, extra) {
    if (!sc) return;
    const upd = Object.assign({ rev: (sc.rev || 0) + 1, updated_at: new Date().toISOString() }, extra || {});
    Object.assign(sc, upd);
    const { error } = await db.from('scene_maps').update(upd).eq('id', sc.id);
    if (error) { console.error('scene update failed', error); toast('Could not save the scene: ' + error.message); }
}
function toast(msg) { if (typeof window.showToast === 'function') window.showToast(msg); else console.log(msg); }
window.sceneNew = async function () {
    if (!isDm()) return;
    const { data, error } = await db.from('scene_maps').insert({ name: 'New Scene', width: 1200, height: 800, bg_color: '#0b1418', grid: 'lines', grid_size: 50, marks: [], is_active: false, rev: 0, created_by: me() }).select().single();
    if (error) { toast('Could not make a scene: ' + error.message); return; }
    S.list.push(data); S.viewId = data.id; S.view = true; S.sel = null;
    await loadTokens(); renderScene();
};
window.scenePick = async function (id) {
    if (!isDm()) return;
    S.viewId = id || null; S.sel = null;
    await loadTokens(); renderScene();
};
window.sceneSetField = async function (field, value) {
    const sc = viewedScene(); if (!isDm() || !sc) return;
    const num = (v, lo, hi, d) => { const n = parseInt(v, 10); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    const upd = {};
    if (field === 'name') upd.name = String(value || '').trim().slice(0, 80) || 'Untitled Scene';
    else if (field === 'width') upd.width = num(value, 300, 4000, sc.width);
    else if (field === 'height') upd.height = num(value, 300, 4000, sc.height);
    else if (field === 'bg_color') upd.bg_color = /^#[0-9a-f]{6}$/i.test(value) ? value : sc.bg_color;
    else if (field === 'grid') upd.grid = ['none', 'lines', 'dots'].includes(value) ? value : 'lines';
    else if (field === 'grid_size') upd.grid_size = num(value, 10, 400, sc.grid_size);
    else return;
    await touchScene(sc, upd);
    renderScene();
};
window.sceneGoLive = async function () {
    const sc = viewedScene(); if (!isDm() || !sc) return;
    const cur = liveScene();
    if (cur && cur.id !== sc.id) {
        if (!(await window.showConfirmModal(`"${cur.name}" is live. Replace it with "${sc.name}"?`))) return;
        await touchScene(cur, { is_active: false });
    }
    await touchScene(sc, { is_active: true });
    try { await db.from('chat_logs').insert({ sender_id: null, content: `🎭 [SCENE] On screen now: ${sc.name}.`, message_type: 'system' }); } catch (e) {}
    renderScene();
};
window.sceneEnd = async function () {
    const sc = liveScene(); if (!isDm() || !sc) return;
    await touchScene(sc, { is_active: false });
    renderScene();
};
window.sceneDelete = async function () {
    const sc = viewedScene(); if (!isDm() || !sc) return;
    if (!(await window.showConfirmModal(`Delete the scene "${sc.name}" and its tokens? This can't be undone.`))) return;
    const { error } = await db.from('scene_maps').delete().eq('id', sc.id);
    if (error) { toast('Could not delete: ' + error.message); return; }
    S.list = S.list.filter(s => s.id !== sc.id);
    S.viewId = S.list[0] ? S.list[0].id : null; S.sel = null;
    await loadTokens(); renderScene();
};

// New things land near the middle, nudged so they don't stack exactly.
function spawnPoint(sc, i) {
    const a = (S.tokens.length + (sc.marks || []).length + (i || 0)) * 2.39996;
    const r = 30 + 18 * ((S.tokens.length + (i || 0)) % 6);
    return window.sceneClamp(sc, sc.width / 2 + Math.cos(a) * r, sc.height / 2 + Math.sin(a) * r);
}
async function insertTokens(rows) {
    const sc = viewedScene(); if (!sc || !rows.length) return;
    const base = S.tokens.reduce((m, t) => Math.max(m, t.sort_order || 0), 0);
    const payload = rows.map((r, i) => {
        const [x, y] = spawnPoint(sc, i);
        return Object.assign({ scene_id: sc.id, x, y, sort_order: base + i + 1 }, r);
    });
    const { data, error } = await db.from('scene_tokens').insert(payload).select();
    if (error) { toast('Could not add: ' + error.message); return; }
    (data || []).forEach(t => { S.tokens.push(t); (S.known[sc.id] = S.known[sc.id] || new Set()).add(t.id); });
    if (data && data.length === 1) S.sel = { type: 'tok', id: data[0].id };
    await touchScene(sc);
    renderScene();
}
window.sceneAddParty = async function () {
    if (!isDm()) return;
    const onBoard = new Set(S.tokens.map(t => t.profile_id).filter(Boolean));
    const rows = playerProfiles().filter(p => !onBoard.has(p.id) && p.character && p.character.name)
        .map(p => ({ name: p.character.name, kind: 'pc', profile_id: p.id }));
    if (!rows.length) { toast('Every player character is already on this scene.'); return; }
    await insertTokens(rows);
};
window.sceneAddPc = async function (profileId) {
    if (!isDm() || !profileId) return;
    const p = playerProfiles().find(x => x.id === profileId); if (!p) return;
    await insertTokens([{ name: (p.character && p.character.name) || p.username || 'Player', kind: 'pc', profile_id: p.id }]);
};
window.sceneAddToken = async function (kind) {
    if (!isDm()) return;
    const inp = document.getElementById('scv-add-name');
    const name = (inp && inp.value.trim()) || (kind === 'object' ? 'Object' : 'NPC');
    if (inp) inp.value = '';
    const hidden = !!(document.getElementById('scv-add-hidden') || {}).checked;
    await insertTokens([{ name: name.slice(0, 60), kind: kind === 'object' ? 'object' : 'npc', is_hidden: hidden }]);
};
window.sceneTokenField = async function (id, field, value) {
    const sc = viewedScene(), tok = S.tokens.find(t => t.id === id); if (!isDm() || !sc || !tok) return;
    const upd = {};
    if (field === 'name') upd.name = String(value || '').trim().slice(0, 60) || tok.name;
    else if (field === 'note') upd.note = String(value || '').slice(0, 600);
    else if (field === 'color') upd.color = /^#[0-9a-f]{6}$/i.test(value) ? value : null;
    else if (field === 'size') { const n = parseFloat(value); upd.size = isFinite(n) ? Math.max(0.4, Math.min(4, n)) : 1; }
    else if (field === 'kind') upd.kind = ['pc', 'npc', 'object'].includes(value) ? value : tok.kind;
    else if (field === 'profile_id') upd.profile_id = value || null;
    else if (field === 'is_hidden') upd.is_hidden = !!value;
    else if (field === 'w' || field === 'h') { const n = parseFloat(value); upd[field] = isFinite(n) ? Math.max(10, Math.min(field === 'w' ? sc.width : sc.height, Math.round(n))) : tok[field]; }
    else if (field === 'rot') upd.rot = normRot(value);
    else return;
    Object.assign(tok, upd);
    const { error } = await db.from('scene_tokens').update(Object.assign({ updated_at: new Date().toISOString() }, upd)).eq('id', id);
    if (error) { toast('Could not save the token: ' + error.message); return; }
    await touchScene(sc);
    renderScene();
};
// Object library: built-in starter (id 'b:<name>') or one of the DM's saved presets.
function findPreset(id) {
    for (const g of OBJECT_LIBRARY) { const it = g.items.find(i => i.id === id); if (it) return it; }
    return (S.presets || []).find(p => p.id === id) || null;
}
window.sceneAddPreset = async function (id) {
    const sc = viewedScene(), p = findPreset(id); if (!isDm() || !sc || !p) return;
    const hidden = !!(document.getElementById('scv-add-hidden') || {}).checked;
    const row = { name: p.name, kind: p.kind || 'object', shape: p.shape || 'rect', color: p.color || null, note: p.note || '', size: p.size || 1, is_hidden: hidden };
    if (row.shape === 'rect') { row.w = Math.min(sc.width, Number(p.w) || 40); row.h = Math.min(sc.height, Number(p.h) || 40); row.rot = 0; }
    await insertTokens([row]);
};
window.sceneRotate = (id) => { const t = S.tokens.find(x => x.id === id); if (t) return window.sceneTokenField(id, 'rot', (t.rot || 0) + 90); };
async function commitGeometry(tok, fields) {
    const sc = viewedScene(); if (!isDm() || !sc || !tok) return;
    Object.assign(tok, fields);
    const { error } = await db.from('scene_tokens').update(Object.assign({ updated_at: new Date().toISOString() }, fields)).eq('id', tok.id);
    if (error) { toast('Could not resize: ' + error.message); return; }
    await touchScene(sc);
}
window.sceneSaveAsPreset = async function (id) {
    const t = S.tokens.find(x => x.id === id); if (!isDm() || !t) return;
    const row = { name: t.name, category: 'My presets', kind: t.kind, shape: isRect(t) ? 'rect' : 'circle', w: isRect(t) ? t.w : null, h: isRect(t) ? t.h : null, size: t.size || 1, color: t.color || null, note: t.note || '', created_by: me() };
    const { data, error } = await db.from('scene_object_presets').insert(row).select().single();
    if (error) { toast('Could not save the preset: ' + error.message); return; }
    S.presets.push(data);
    toast(`Saved "${t.name}" to the library (MY PRESETS).`);
    renderScene();
};
window.sceneDeletePreset = async function (id) {
    const p = (S.presets || []).find(x => x.id === id); if (!isDm() || !p) return;
    if (!(await window.showConfirmModal(`Remove "${p.name}" from your presets? Objects already placed stay.`))) return;
    const { error } = await db.from('scene_object_presets').delete().eq('id', id);
    if (error) { toast('Could not remove: ' + error.message); return; }
    S.presets = S.presets.filter(x => x.id !== id);
    renderScene();
};
// Notes save as you type (the app-wide textarea popup sends 'input', not 'change').
const noteTimers = {};
window.sceneNoteInput = function (id, value) {
    const tok = S.tokens.find(t => t.id === id); if (!isDm() || !tok) return;
    tok.note = String(value || '').slice(0, 600);
    clearTimeout(noteTimers[id]);
    noteTimers[id] = setTimeout(async () => {
        const sc = viewedScene();
        const { error } = await db.from('scene_tokens').update({ note: tok.note, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) { toast('Could not save the note: ' + error.message); return; }
        await touchScene(sc);
    }, 500);
};
window.sceneToggleHidden = (id) => { const t = S.tokens.find(x => x.id === id); if (t) return window.sceneTokenField(id, 'is_hidden', !t.is_hidden); };
window.sceneRemoveToken = async function (id) {
    const sc = viewedScene(); if (!isDm() || !sc) return;
    const { error } = await db.from('scene_tokens').delete().eq('id', id);
    if (error) { toast('Could not remove: ' + error.message); return; }
    S.tokens = S.tokens.filter(t => t.id !== id);
    if (S.sel && S.sel.id === id) S.sel = null;
    await touchScene(sc);
    renderScene();
};
// Areas (labelled boxes) and text labels live in scene_maps.marks.
window.sceneAddMark = async function (kind) {
    const sc = viewedScene(); if (!isDm() || !sc) return;
    const marks = (sc.marks || []).slice();
    const m = kind === 'area'
        ? { id: newId(), kind: 'area', x: Math.round(sc.width / 2 - 120), y: Math.round(sc.height / 2 - 80), w: 240, h: 160, text: 'AREA', color: '#00e1ff' }
        : { id: newId(), kind: 'text', x: Math.round(sc.width / 2), y: Math.round(sc.height / 2), text: 'LABEL', color: '#d4e4ea', size: 22 };
    marks.push(m);
    S.sel = { type: 'mark', id: m.id };
    await touchScene(sc, { marks });
    renderScene();
};
window.sceneMarkField = async function (id, field, value) {
    const sc = viewedScene(); if (!isDm() || !sc) return;
    const marks = (sc.marks || []).map(m => Object.assign({}, m));
    const m = marks.find(x => x.id === id); if (!m) return;
    const num = (v, lo, hi, d) => { const n = parseInt(v, 10); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    if (field === 'text') m.text = String(value || '').slice(0, 80);
    else if (field === 'color') m.color = /^#[0-9a-f]{6}$/i.test(value) ? value : m.color;
    else if (field === 'w') m.w = num(value, 20, sc.width, m.w);
    else if (field === 'h') m.h = num(value, 20, sc.height, m.h);
    else if (field === 'size') m.size = num(value, 8, 160, m.size || 22);
    else return;
    await touchScene(sc, { marks });
    renderScene();
};
window.sceneRemoveMark = async function (id) {
    const sc = viewedScene(); if (!isDm() || !sc) return;
    if (S.sel && S.sel.id === id) S.sel = null;
    await touchScene(sc, { marks: (sc.marks || []).filter(m => m.id !== id) });
    renderScene();
};

/* --- Moving things (shared by DM and players) --- */
async function commitTokenMove(tok, x, y) {
    const sc = viewedScene(); if (!sc) return;
    [x, y] = window.sceneClamp(sc, x, y);
    const old = [tok.x, tok.y];
    tok.x = x; tok.y = y;
    if (isDm()) {
        const { error } = await db.from('scene_tokens').update({ x, y, updated_at: new Date().toISOString() }).eq('id', tok.id);
        if (error) { tok.x = old[0]; tok.y = old[1]; toast('Could not move: ' + error.message); }
        else await touchScene(sc);
    } else {
        const { error } = await db.rpc('df_scene_move_token', { p_token: tok.id, p_x: x, p_y: y });
        if (error) { tok.x = old[0]; tok.y = old[1]; toast('Could not move: ' + error.message); }
    }
}
window.sceneMoveToken = async function (id, x, y) {
    const tok = S.tokens.find(t => t.id === id), sc = viewedScene();
    if (!window.sceneCanDrag(tok, sc)) return false;
    await commitTokenMove(tok, x, y); renderScene(); return true;
};
async function commitMark(id, fields) {
    const sc = viewedScene(); if (!sc) return;
    const marks = (sc.marks || []).map(m => m.id === id ? Object.assign({}, m, fields) : m);
    await touchScene(sc, { marks });
}

/* --- Rendering --- */
function ensureView() {
    let v = document.getElementById('scene-view');
    if (!v) { v = document.createElement('div'); v.id = 'scene-view'; v.className = 'scv'; v.style.display = 'none'; document.body.appendChild(v); }
    let pill = document.getElementById('scene-view-pill');
    if (!pill) {
        // The reopen button lives in a small box with a header (js/panel-controls.js adds
        // drag / collapse / hide there while 'panel_controls' is on; otherwise only the button shows).
        const box = document.createElement('div'); box.id = 'scv-box'; box.className = 'scv-box'; box.style.display = 'none';
        box.innerHTML = '<div id="scv-box-head" class="scv-box-head panel-header-drag"><h4>🎭 SCENE LIVE</h4><span class="scv-box-drag">DRAG</span></div>';
        pill = document.createElement('button'); pill.id = 'scene-view-pill'; pill.type = 'button'; pill.className = 'scv-pill';
        pill.onclick = () => window.openSceneView(); pill.style.display = 'none';
        box.appendChild(pill); document.body.appendChild(box);
        if (typeof makePanelDraggable === 'function') makePanelDraggable('scv-box', 'scv-box-head', 'odyssey_scenebox_pos'); if (box.style.top) box.style.bottom = 'auto';
        if (typeof window.panelControlsRegister === 'function') window.panelControlsRegister('scenebox');
    }
    return v;
}
window.openSceneView = function () { S.view = true; if (!isDm()) S.viewId = liveScene() ? liveScene().id : null; renderScene(); };
window.closeSceneView = function () { S.view = false; S.sel = null; S.drag = null; renderScene(); };
// Don't rebuild under the DM's fingers: wait for a drag to end or a field to lose focus.
function busy() {
    if (S.drag) return true;
    const a = document.activeElement, v = document.getElementById('scene-view');
    return !!(a && v && v.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'button' && a.type !== 'checkbox');
}
// Remote updates (realtime reloads) wait while the DM is mid-drag or typing;
// the user's own actions redraw at once (renderScene).
function renderFromRemote() { if (busy()) { S.pending = true; return; } renderScene(); }
function renderScene() {
    if (S.drag) { S.pending = true; return; }
    S.pending = false;
    const v = ensureView();
    const pill = document.getElementById('scene-view-pill');
    const live = liveScene(), dm = isDm();
    pill.textContent = live ? `🎭 SCENE: ${String(live.name).toUpperCase()} — OPEN` : '';
    pill.style.display = live && !S.view ? '' : 'none';
    const box = document.getElementById('scv-box'); if (box) { box.style.display = pill.style.display; box.dataset.scene = live ? live.id : ''; }
    renderBarButton();
    if (!S.view) { v.style.display = 'none'; return; }
    if (!dm && !live) { v.style.display = 'none'; S.view = false; return; }
    v.style.display = 'block';
    const sc = viewedScene();
    const phone = isPhone();
    const head = `
        <div class="scv-head">
            <div class="scv-titlebox"><span class="scv-kicker">SCENE MAP${sc && sc.is_active ? '' : (sc ? ' · PREP (PLAYERS CAN\'T SEE THIS)' : '')}</span>
                <h3 class="scv-title">${sc ? esc(String(sc.name).toUpperCase()) : 'NO SCENE'}</h3></div>
            ${sc && sc.is_active ? '<span class="scv-chip scv-live">● LIVE</span>' : ''}
            <span class="scv-grow"></span>
            ${dm ? `<select id="scv-pick" class="scv-select" onchange="window.scenePick(this.value)" aria-label="Scene">
                    ${S.list.length ? '' : '<option value="">— no scenes yet —</option>'}
                    ${S.list.map(s => `<option value="${esc(s.id)}"${s.id === S.viewId ? ' selected' : ''}>${s.is_active ? '● ' : ''}${esc(s.name)}</option>`).join('')}
                </select>
                <button type="button" class="scv-btn" onclick="window.sceneNew()">+ NEW</button>
                ${sc ? (sc.is_active ? `<button type="button" class="scv-btn scv-red" onclick="window.sceneEnd()">■ END SCENE</button>`
                    : `<button type="button" class="scv-btn scv-green" onclick="window.sceneGoLive()">▶ GO LIVE</button>`) : ''}` : ''}
            <button type="button" class="scv-btn" onclick="window.closeSceneView()">✕ CLOSE</button>
        </div>`;
    if (!sc) {
        v.innerHTML = head + `<div class="scv-empty">No scenes yet. <b>+ NEW</b> makes one: pick a colour and grid, drop in areas, labels and tokens, then <b>GO LIVE</b> to put it on everyone's screen.</div>`;
        return;
    }
    const W = sc.width || 1200, H = sc.height || 800;
    const availW = phone ? (window.innerWidth || 360) - 26 : Math.max(320, (window.innerWidth || 1200) - 360);
    const availH = phone ? Math.max(260, (window.innerHeight || 700) * 0.6) : Math.max(300, (window.innerHeight || 800) - 130 - (window.ssBandPx ? window.ssBandPx() : 0));
    const s = S.scale = window.sceneFitScale(W, H, availW, availH, phone);
    const marksHtml = (sc.marks || []).map(m => {
        const sel = S.sel && S.sel.type === 'mark' && S.sel.id === m.id;
        if (m.kind === 'area') {
            return `<div class="scv-area${sel ? ' sel' : ''}${dm ? ' dm' : ''}" data-mark="${esc(m.id)}" style="left:${m.x * s}px; top:${m.y * s}px; width:${(m.w || 100) * s}px; height:${(m.h || 100) * s}px; border-color:${esc(m.color)}; background:${hexToRgba(m.color, 0.1)};">
                <span class="scv-area-lab" style="color:${esc(m.color)}; font-size:${Math.max(9, Math.round(15 * s))}px;">${esc(m.text)}</span>
                ${dm && sel ? `<span class="scv-handle" data-handle="${esc(m.id)}"></span>` : ''}</div>`;
        }
        return `<div class="scv-text${sel ? ' sel' : ''}${dm ? ' dm' : ''}" data-mark="${esc(m.id)}" style="left:${m.x * s}px; top:${m.y * s}px; color:${esc(m.color)}; font-size:${Math.max(9, Math.round((m.size || 22) * s))}px;">${esc(m.text)}</div>`;
    }).join('');
    // Objects (rectangles) sit under people.
    const drawOrder = S.tokens.filter(isRect).concat(S.tokens.filter(t => !isRect(t)));
    const tokHtml = drawOrder.map(t => {
        const d = window.sceneTokenPx(s, t.size), col = t.color || KIND_COLOR[t.kind] || KIND_COLOR.npc;
        const sel = S.sel && S.sel.type === 'tok' && S.sel.id === t.id;
        const mine = !dm && t.profile_id && t.profile_id === me();
        const cls = ['scv-tok', t.kind, isRect(t) ? 'scv-obj' : '', sel ? 'sel' : '', mine ? 'mine' : '', t.is_hidden ? 'hid' : '', S.appear.has(t.id) ? 'appear' : '', window.sceneCanDrag(t, sc) ? 'drag' : ''].filter(Boolean).join(' ');
        if (isRect(t)) {
            const b = window.sceneRectBox(t, s), inside = b.width >= 44 && b.height >= 14;
            const label = `${esc(t.name)}${t.is_hidden ? ' · HIDDEN' : ''}`;
            return `<div class="${cls}" data-tok="${esc(t.id)}" title="${esc(t.name)}${t.note ? ' — ' + esc(t.note) : ''}" style="left:${b.left}px; top:${b.top}px; width:${b.width}px; height:${b.height}px; rotate:${normRot(t.rot)}deg; border-color:${esc(col)}; background:${hexToRgba(col, 0.3)};">${inside ? `<span class="scv-objname" style="font-size:${Math.max(8, Math.min(13, Math.round(b.height * 0.42)))}px;">${label}</span>` : (sel ? `<span class="scv-tokname">${label}</span>` : '')}${dm && sel ? `<span class="scv-handle" data-rhandle="${esc(t.id)}"></span>` : ''}</div>`;
        }
        return `<div class="${cls}" data-tok="${esc(t.id)}" title="${esc(t.name)}${t.note ? ' — ' + esc(t.note) : ''}" style="left:${t.x * s - d / 2}px; top:${t.y * s - d / 2}px; width:${d}px; height:${d}px; border-color:${esc(col)}; background:${hexToRgba(col, 0.32)}; font-size:${Math.max(9, Math.round(d * 0.36))}px;">${esc(initials(t.name))}<span class="scv-tokname">${esc(t.name)}${t.is_hidden ? ' · HIDDEN' : ''}</span></div>`;
    }).join('');
    v.innerHTML = head + `
        <div class="scv-body">
            <main class="scv-main">
                <div class="scv-board" id="scv-board" style="width:${W * s}px; height:${H * s}px;">
                    <canvas id="scv-canvas"></canvas>${marksHtml}${tokHtml}
                </div>
                <div class="scv-help">${dm ? 'Drag tokens, areas and labels. Dashed tokens are HIDDEN: players can\'t see them until you REVEAL them. Players can drag only their own token.' : 'Drag your own token (gold ring) to move it. Tap anyone to read their note.'}</div>
            </main>
            <aside class="scv-side">${sidePanel(sc, dm)}</aside>
        </div>`;
    drawBoard(sc, s);
    wireBoard();
    S.appear = new Set(); // the glow plays once
}
window.renderSceneView = renderScene;

function sidePanel(sc, dm) {
    const selTok = S.sel && S.sel.type === 'tok' ? S.tokens.find(t => t.id === S.sel.id) : null;
    const selMark = S.sel && S.sel.type === 'mark' ? (sc.marks || []).find(m => m.id === S.sel.id) : null;
    const order = { pc: 0, npc: 1, object: 2 };
    const rows = S.tokens.filter(t => dm || t.kind !== 'object' || t.note).sort((a, b) => (order[a.kind] - order[b.kind]) || String(a.name).localeCompare(String(b.name))).map(t => {
        const col = t.color || KIND_COLOR[t.kind] || KIND_COLOR.npc;
        const sel = selTok && selTok.id === t.id;
        return `<div class="scv-row${sel ? ' sel' : ''}${t.is_hidden ? ' hid' : ''}">
            <span class="scv-dot" style="background:${esc(col)}"></span>
            <button type="button" class="scv-rowname" onclick="window.sceneSelect('tok','${esc(t.id)}')">${esc(t.name)}${t.note ? `<small>${esc(t.note.length > 60 ? t.note.slice(0, 60) + '…' : t.note)}</small>` : ''}</button>
            ${dm ? `<button type="button" class="scv-mini${t.is_hidden ? ' gold' : ''}" onclick="window.sceneToggleHidden('${esc(t.id)}')" title="${t.is_hidden ? 'Show to players' : 'Hide from players'}">${t.is_hidden ? 'REVEAL' : 'HIDE'}</button>` : ''}
        </div>`;
    }).join('') || '<div class="scv-none">Nobody on this scene yet.</div>';
    if (!dm) {
        return `<div class="scv-ttl">ON SCENE</div><div class="scv-roster">${rows}</div>
            ${selTok ? `<div class="scv-ttl scv-ttl2">${esc(String(selTok.name).toUpperCase())}</div><div class="scv-note">${selTok.note ? esc(selTok.note) : '<span class="scv-none">No notes.</span>'}</div>` : ''}`;
    }
    const missing = playerProfiles().filter(p => p.character && p.character.name && !S.tokens.some(t => t.profile_id === p.id));
    const players = playerProfiles();
    let sel = '';
    if (selTok) {
        sel = `<div class="scv-ttl scv-ttl2">SELECTED TOKEN</div>
            <label class="scv-lab">NAME</label><input class="scv-in" value="${esc(selTok.name)}" onchange="window.sceneTokenField('${selTok.id}','name',this.value)">
            <label class="scv-lab">NOTE (players see this)</label><textarea class="scv-in" rows="3" oninput="window.sceneNoteInput('${selTok.id}',this.value)">${esc(selTok.note || '')}</textarea>
            <div class="scv-grid2">
                <div><label class="scv-lab">COLOUR</label><input type="color" class="scv-in scv-color" value="${esc(selTok.color || KIND_COLOR[selTok.kind] || '#ff6b6b')}" onchange="window.sceneTokenField('${selTok.id}','color',this.value)"></div>
                ${isRect(selTok)
                    ? `<div><label class="scv-lab">WIDTH</label><input type="number" class="scv-in" min="10" step="10" value="${esc(selTok.w)}" onchange="window.sceneTokenField('${selTok.id}','w',this.value)"></div>
                       <div><label class="scv-lab">HEIGHT</label><input type="number" class="scv-in" min="10" step="10" value="${esc(selTok.h)}" onchange="window.sceneTokenField('${selTok.id}','h',this.value)"></div>`
                    : `<div><label class="scv-lab">SIZE</label><input type="number" class="scv-in" min="0.4" max="4" step="0.1" value="${esc(selTok.size || 1)}" onchange="window.sceneTokenField('${selTok.id}','size',this.value)"></div>`}
                <div><label class="scv-lab">TYPE</label><select class="scv-in" onchange="window.sceneTokenField('${selTok.id}','kind',this.value)">${['pc', 'npc', 'object'].map(k => `<option value="${k}"${selTok.kind === k ? ' selected' : ''}>${k.toUpperCase()}</option>`).join('')}</select></div>
                <div><label class="scv-lab">MOVED BY</label><select class="scv-in" onchange="window.sceneTokenField('${selTok.id}','profile_id',this.value)"><option value="">DM only</option>${players.map(p => `<option value="${esc(p.id)}"${selTok.profile_id === p.id ? ' selected' : ''}>${esc(profileName(p.id))}</option>`).join('')}</select></div>
            </div>
            <div class="scv-acts">
                <button type="button" class="scv-btn${selTok.is_hidden ? ' scv-gold' : ''}" onclick="window.sceneToggleHidden('${selTok.id}')">${selTok.is_hidden ? '👁 REVEAL' : 'HIDE'}</button>
                ${isRect(selTok) ? `<button type="button" class="scv-btn" onclick="window.sceneRotate('${selTok.id}')" title="Turn 90°">⟳ ROTATE</button>` : ''}
                <button type="button" class="scv-btn" onclick="window.sceneSaveAsPreset('${selTok.id}')" title="Keep this (name, colour, size, note) in the library for any scene">SAVE AS PRESET</button>
                <button type="button" class="scv-btn scv-red" onclick="window.sceneRemoveToken('${selTok.id}')">REMOVE</button>
            </div>`;
    } else if (selMark) {
        sel = `<div class="scv-ttl scv-ttl2">SELECTED ${selMark.kind === 'area' ? 'AREA' : 'LABEL'}</div>
            <label class="scv-lab">TEXT</label><input class="scv-in" value="${esc(selMark.text)}" onchange="window.sceneMarkField('${selMark.id}','text',this.value)">
            <div class="scv-grid2">
                <div><label class="scv-lab">COLOUR</label><input type="color" class="scv-in scv-color" value="${esc(selMark.color)}" onchange="window.sceneMarkField('${selMark.id}','color',this.value)"></div>
                ${selMark.kind === 'area'
                    ? `<div><label class="scv-lab">WIDTH</label><input type="number" class="scv-in" value="${esc(selMark.w)}" onchange="window.sceneMarkField('${selMark.id}','w',this.value)"></div>
                       <div><label class="scv-lab">HEIGHT</label><input type="number" class="scv-in" value="${esc(selMark.h)}" onchange="window.sceneMarkField('${selMark.id}','h',this.value)"></div>`
                    : `<div><label class="scv-lab">TEXT SIZE</label><input type="number" class="scv-in" value="${esc(selMark.size || 22)}" onchange="window.sceneMarkField('${selMark.id}','size',this.value)"></div>`}
            </div>
            <div class="scv-acts"><button type="button" class="scv-btn scv-red" onclick="window.sceneRemoveMark('${selMark.id}')">REMOVE</button></div>`;
    }
    return `<div class="scv-ttl">ADD</div>
        <div class="scv-acts">
            <button type="button" class="scv-btn" onclick="window.sceneAddParty()"${missing.length ? '' : ' disabled'}>+ PARTY${missing.length ? ' (' + missing.length + ')' : ''}</button>
            <button type="button" class="scv-btn" onclick="window.sceneAddMark('area')">+ AREA</button>
            <button type="button" class="scv-btn" onclick="window.sceneAddMark('text')">+ LABEL</button>
        </div>
        ${missing.length ? `<select class="scv-in scv-addpc" onchange="window.sceneAddPc(this.value)"><option value="">+ one player's character…</option>${missing.map(p => `<option value="${esc(p.id)}">${esc(p.character.name)}</option>`).join('')}</select>` : ''}
        <div class="scv-addrow"><input id="scv-add-name" class="scv-in" placeholder="NPC or object name" maxlength="60">
            <button type="button" class="scv-btn" onclick="window.sceneAddToken('npc')">+ NPC</button>
            <button type="button" class="scv-btn" onclick="window.sceneAddToken('object')">+ OBJECT</button></div>
        <select class="scv-in scv-lib" aria-label="Object library" onchange="const v=this.value; this.value=''; window.sceneAddPreset(v);">
            <option value="">+ OBJECT LIBRARY…</option>
            ${(S.presets || []).length ? `<optgroup label="MY PRESETS">${S.presets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>` : ''}
            ${OBJECT_LIBRARY.map(g => `<optgroup label="${esc(g.category.toUpperCase())}">${g.items.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('')}</optgroup>`).join('')}
        </select>
        <label class="scv-check"><input type="checkbox" id="scv-add-hidden"> add it HIDDEN (reveal later)</label>
        ${(S.presets || []).length ? `<details class="scv-presets"><summary>MY PRESETS (${S.presets.length})</summary>${S.presets.map(p => `<div class="scv-row"><span class="scv-dot" style="background:${esc(p.color || KIND_COLOR[p.kind] || '#c9962f')}"></span><span class="scv-rowname">${esc(p.name)}</span><button type="button" class="scv-mini" onclick="window.sceneDeletePreset('${esc(p.id)}')" title="Remove from your presets">✕</button></div>`).join('')}</details>` : ''}
        <div class="scv-ttl scv-ttl2">ON SCENE</div><div class="scv-roster">${rows}</div>
        ${sel}
        <div class="scv-ttl scv-ttl2">SCENE</div>
        <label class="scv-lab">NAME</label><input class="scv-in" value="${esc(sc.name)}" onchange="window.sceneSetField('name',this.value)">
        <div class="scv-grid2">
            <div><label class="scv-lab">WIDTH</label><input type="number" class="scv-in" min="300" max="4000" step="50" value="${esc(sc.width)}" onchange="window.sceneSetField('width',this.value)"></div>
            <div><label class="scv-lab">HEIGHT</label><input type="number" class="scv-in" min="300" max="4000" step="50" value="${esc(sc.height)}" onchange="window.sceneSetField('height',this.value)"></div>
            <div><label class="scv-lab">BACKGROUND</label><input type="color" class="scv-in scv-color" value="${esc(sc.bg_color)}" onchange="window.sceneSetField('bg_color',this.value)"></div>
            <div><label class="scv-lab">GRID</label><select class="scv-in" onchange="window.sceneSetField('grid',this.value)">${['lines', 'dots', 'none'].map(g => `<option value="${g}"${sc.grid === g ? ' selected' : ''}>${g.toUpperCase()}</option>`).join('')}</select></div>
            <div><label class="scv-lab">GRID SIZE</label><input type="number" class="scv-in" min="10" max="400" step="5" value="${esc(sc.grid_size)}" onchange="window.sceneSetField('grid_size',this.value)"></div>
        </div>
        <div class="scv-acts"><button type="button" class="scv-btn scv-red" onclick="window.sceneDelete()">DELETE SCENE</button></div>`;
}
function drawBoard(sc, s) {
    const c = document.getElementById('scv-canvas'); if (!c) return;
    const W = (sc.width || 1200) * s, H = (sc.height || 800) * s;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    c.style.width = W + 'px'; c.style.height = H + 'px';
    const ctx = c.getContext && c.getContext('2d'); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = sc.bg_color || '#0b1418'; ctx.fillRect(0, 0, W, H);
    const g = (sc.grid_size || 50) * s;
    if (sc.grid !== 'none' && g >= 4) {
        if (sc.grid === 'dots') {
            ctx.fillStyle = 'rgba(160,220,235,0.28)';
            for (let x = 0; x <= W + 0.5; x += g) for (let y = 0; y <= H + 0.5; y += g) ctx.fillRect(x - 1, y - 1, 2, 2);
        } else {
            ctx.strokeStyle = 'rgba(120,200,215,0.12)'; ctx.lineWidth = 1; ctx.beginPath();
            for (let x = 0; x <= W + 0.5; x += g) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); }
            for (let y = 0; y <= H + 0.5; y += g) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); }
            ctx.stroke();
        }
    }
}
window.sceneSelect = function (type, id) {
    S.sel = S.sel && S.sel.type === type && S.sel.id === id ? null : { type, id };
    renderScene();
};

/* --- Board pointer handling (exposed for tests as window.__sceneBoard) --- */
function onDown(ev) {
    const sc = viewedScene(); if (!sc) return;
    const t = ev.target && ev.target.closest ? ev.target : null;
    const handle = t && t.closest('[data-handle]');
    const rhandle = t && t.closest('[data-rhandle]');
    const tokEl = t && t.closest('[data-tok]');
    const markEl = t && t.closest('[data-mark]');
    if (rhandle && isDm()) {
        const tok = S.tokens.find(x => x.id === rhandle.getAttribute('data-rhandle')); if (!tok) return;
        S.drag = { kind: 'rresize', id: tok.id, el: rhandle.parentNode, sx: ev.clientX, sy: ev.clientY, base: { x: tok.x, y: tok.y, w: tok.w, h: tok.h, rot: tok.rot }, moved: false };
    } else if (handle && isDm()) {
        const m = (sc.marks || []).find(x => x.id === handle.getAttribute('data-handle')); if (!m) return;
        S.drag = { kind: 'resize', id: m.id, el: handle.parentNode, sx: ev.clientX, sy: ev.clientY, ow: m.w, oh: m.h, moved: false };
    } else if (tokEl) {
        const tok = S.tokens.find(x => x.id === tokEl.getAttribute('data-tok')); if (!tok) return;
        if (!window.sceneCanDrag(tok, sc)) { window.sceneSelect('tok', tok.id); return; }
        S.drag = { kind: 'tok', id: tok.id, el: tokEl, sx: ev.clientX, sy: ev.clientY, ox: tok.x, oy: tok.y, moved: false };
    } else if (markEl) {
        const m = (sc.marks || []).find(x => x.id === markEl.getAttribute('data-mark')); if (!m) return;
        if (!isDm()) return;
        S.drag = { kind: 'mark', id: m.id, el: markEl, sx: ev.clientX, sy: ev.clientY, ox: m.x, oy: m.y, moved: false };
    } else {
        if (S.sel) { S.sel = null; renderScene(); }
        return;
    }
    if (ev.preventDefault) ev.preventDefault();
    try { if (S.drag.el.setPointerCapture && ev.pointerId != null) S.drag.el.setPointerCapture(ev.pointerId); } catch (e) {}
}
function onMove(ev) {
    const d = S.drag; if (!d) return;
    const s = S.scale || 1, dx = (ev.clientX - d.sx) / s, dy = (ev.clientY - d.sy) / s;
    if (!d.moved && Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) < 4) return;
    d.moved = true;
    const sc = viewedScene(); if (!sc) return;
    if (d.kind === 'rresize') {
        d.geo = window.sceneResizeRect(d.base, dx, dy);
        const b = window.sceneRectBox(Object.assign({}, d.base, d.geo), s);
        Object.assign(d.el.style, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px' });
        return;
    }
    if (d.kind === 'resize') {
        d.w = Math.max(20, Math.round(d.ow + dx)); d.h = Math.max(20, Math.round(d.oh + dy));
        d.el.style.width = d.w * s + 'px'; d.el.style.height = d.h * s + 'px';
        return;
    }
    const [x, y] = window.sceneClamp(sc, d.ox + dx, d.oy + dy);
    d.x = x; d.y = y;
    if (d.kind === 'tok') { d.el.style.left = (x * s - (d.el.offsetWidth / 2 || 0)) + 'px'; d.el.style.top = (y * s - (d.el.offsetHeight / 2 || 0)) + 'px'; }
    else { d.el.style.left = x * s + 'px'; d.el.style.top = y * s + 'px'; }
}
async function onUp() {
    const d = S.drag; S.drag = null;
    if (!d) return;
    if (!d.moved) {
        if (d.kind === 'tok') window.sceneSelect('tok', d.id);
        else if (d.kind === 'rresize') { S.sel = { type: 'tok', id: d.id }; renderScene(); }
        else if (d.kind === 'mark') window.sceneSelect('mark', d.id);
        else renderScene();
        return;
    }
    if (d.kind === 'tok') {
        const tok = S.tokens.find(x => x.id === d.id);
        if (tok) { S.sel = { type: 'tok', id: tok.id }; await commitTokenMove(tok, d.x, d.y); }
    } else if (d.kind === 'mark') { S.sel = { type: 'mark', id: d.id }; await commitMark(d.id, { x: d.x, y: d.y }); }
    else if (d.kind === 'resize') await commitMark(d.id, { w: d.w, h: d.h });
    else if (d.kind === 'rresize' && d.geo) { S.sel = { type: 'tok', id: d.id }; await commitGeometry(S.tokens.find(x => x.id === d.id), d.geo); }
    renderScene();
}
function wireBoard() {
    const board = document.getElementById('scv-board'); if (!board) return;
    board.addEventListener('pointerdown', onDown);
    board.addEventListener('pointermove', onMove);
    board.addEventListener('pointerup', onUp);
    board.addEventListener('pointercancel', onUp);
}
window.__sceneBoard = { down: onDown, move: onMove, up: onUp, state: S };

/* --- Bottom-bar button (DM) --- */
function renderBarButton() {
    const bar = document.getElementById('bottom-toggle-bar'); if (!bar) return;
    let b = document.getElementById('scv-bar-btn');
    if (!window.sceneMapsAllowed()) { if (b) b.remove(); return; }
    if (!b) {
        b = document.createElement('button'); b.id = 'scv-bar-btn'; b.type = 'button'; b.className = 'scv-bar-btn';
        b.title = 'Scene Map: non-combat scenes with tokens (DM tools)';
        b.onclick = () => (S.view ? window.closeSceneView() : window.openSceneView());
        const reset = bar.querySelector('button[onclick^="window.resetUiLayout"]');
        bar.insertBefore(b, reset || null);
    }
    const live = liveScene();
    b.textContent = live ? 'SCENES ●' : 'SCENES';
    b.classList.toggle('live', !!live);
}

document.addEventListener('focusout', () => { if (S.pending) setTimeout(() => { if (S.pending) renderScene(); }, 0); });
window.addEventListener('resize', () => { if (S.view) renderScene(); });
let started = false;
document.addEventListener('darkforest:features-changed', async () => {
    try {
        if (!started && typeof currentUserId !== 'undefined' && currentUserId) { started = true; subscribe(); await window.loadSceneMaps(); }
        else renderFromRemote();
    } catch (e) { console.error('scene maps init', e); }
});
})();
