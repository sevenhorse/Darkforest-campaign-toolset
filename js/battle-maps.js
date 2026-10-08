/* ==========================================================================
   js/battle-maps.js - Map library (Phase 7, 2026-10-03)
   ==========================================================================
   DM decisions (2026-10-03 design session):
   - Map library first; interior deck plans get their own design pass later.
   - Terrain is VISUAL ONLY for now (rules may come later). Kinds: asteroid
     field, nebula, debris, planet/moon, station/structure.
   - A map = name + one of 3 fixed sizes (Standard 920x760, Large x1.5,
     Huge x2) + an optional background picture (shown under the grid in 2D,
     as the floor in 3D) + drawn terrain shapes (circles / polygons).
   - Weapon ranges and speeds stay the same distances on every size.
   - Maps reach the table through an encounter preset (its map slot) or the
     optional map picker on START BATTLE. No mid-battle map swap.

   Storage: `battle_maps` (RLS: DM only -- players never see the library).
   A battle stores a SNAPSHOT of its map in battle_encounters.map
   ({ map_id, name, size, background_url, terrain }), readable by everyone in
   the battle; editing a library map later doesn't change a running battle.

   Terrain item: { key, kind, shape: {type:'circle',x,y,r} |
   {type:'poly',pts:[[x,y],...]}, label }. Planets and stations are circles.

   Feature switch 'battle_maps' (DM only) gates the DM tools (library,
   editor, pickers). Drawing a battle's map is NOT gated: if the DM started
   a battle on a map, everyone in it sees the map. */
(function () {
const KINDS = {
    asteroid: { label: 'Asteroid field', color: '#b39b78', poly: true },
    nebula: { label: 'Nebula', color: '#b47cff', poly: true },
    debris: { label: 'Debris / wreckage', color: '#d08a5a', poly: true },
    planet: { label: 'Planet / moon', color: '#6fb4d8', poly: false },
    station: { label: 'Station / structure', color: '#00e1ff', poly: false }
};
window.BATTLE_TERRAIN_KINDS = KINDS;
const SIZE_LABELS = { standard: 'Standard (920 × 760)', large: 'Large (1380 × 1140)', huge: 'Huge (1840 × 1520)' };
const esc = (v) => window.escapeHtml(v == null ? '' : String(v));
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
window.battleMapsAllowed = function () { return isDm() && typeof window.isFeatureOn === 'function' && window.isFeatureOn('battle_maps'); };

/* --- Library (DM) --- */
window.battleMapsList = [];
window.loadBattleMaps = async function () {
    if (!isDm()) { window.battleMapsList = []; return []; }
    const { data, error } = await db.from('battle_maps').select('*').order('name', { ascending: true });
    if (error) { console.error('loadBattleMaps failed', error); return window.battleMapsList; }
    window.battleMapsList = data || [];
    return window.battleMapsList;
};
window.battleMapById = function (id) { return id ? (window.battleMapsList || []).find(m => m.id === id) || null : null; };
window.battleMapSnapshot = function (m) {
    if (!m) return null;
    return { map_id: m.id || null, name: m.name || 'Map', size: window.BATTLE_MAP_SIZES[m.size] ? m.size : 'standard', background_url: window.isMediaRef(m.background_url) ? m.background_url : null, terrain: sanitizeTerrain(m.terrain) };
};
window.battleMapSnapshotById = function (id) { return window.battleMapSnapshot(window.battleMapById(id)); };
function sizeOf(m) { return window.BATTLE_MAP_SIZES[(m && m.size) || 'standard'] || window.BATTLE_MAP_SIZES.standard; }
window.battleMapDims = function (m) { const s = sizeOf(m); return { w: s[0], h: s[1] }; };

/* --- Geometry --- */
function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
function sanitizeTerrain(list) {
    return (Array.isArray(list) ? list : []).map(t => {
        if (!t || !KINDS[t.kind] || !t.shape) return null;
        const out = { key: String(t.key || ('t' + Math.random().toString(36).slice(2, 8))).slice(0, 40), kind: t.kind, label: String(t.label || '').slice(0, 60) };
        if (t.shape.type === 'poly' && KINDS[t.kind].poly && Array.isArray(t.shape.pts) && t.shape.pts.length >= 3) {
            out.shape = { type: 'poly', pts: t.shape.pts.slice(0, 64).map(p => [Math.round(num(p[0], 0)), Math.round(num(p[1], 0))]) };
        } else if (t.shape.type === 'circle') {
            out.shape = { type: 'circle', x: Math.round(num(t.shape.x, 0)), y: Math.round(num(t.shape.y, 0)), r: Math.max(6, Math.round(num(t.shape.r, 40))) };
        } else return null;
        return out;
    }).filter(Boolean).slice(0, 200);
}
window.sanitizeBattleTerrain = sanitizeTerrain;
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
window.battleTerrainRng = function (key) { return rng(hashStr(String(key))); };
function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
    }
    return inside;
}
function bounds(shape) {
    if (shape.type === 'circle') return { x0: shape.x - shape.r, y0: shape.y - shape.r, x1: shape.x + shape.r, y1: shape.y + shape.r };
    const xs = shape.pts.map(p => p[0]), ys = shape.pts.map(p => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
function inside(shape, x, y) {
    if (shape.type === 'circle') return Math.hypot(x - shape.x, y - shape.y) <= shape.r;
    return pointInPoly(x, y, shape.pts);
}
window.battleTerrainContains = inside;
function area(shape) {
    if (shape.type === 'circle') return Math.PI * shape.r * shape.r;
    let a = 0; const p = shape.pts;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
    return Math.abs(a / 2);
}
function centroid(shape) {
    if (shape.type === 'circle') return { x: shape.x, y: shape.y };
    const n = shape.pts.length;
    return { x: shape.pts.reduce((s, p) => s + p[0], 0) / n, y: shape.pts.reduce((s, p) => s + p[1], 0) / n };
}
// Deterministic points inside a shape (same map -> same rocks everywhere).
window.battleTerrainScatter = function (t, count) {
    const r = rng(hashStr(t.key + t.kind)), b = bounds(t.shape), out = [];
    let guard = count * 30;
    while (out.length < count && guard-- > 0) {
        const x = b.x0 + r() * (b.x1 - b.x0), y = b.y0 + r() * (b.y1 - b.y0);
        if (inside(t.shape, x, y)) out.push({ x, y, s: r(), a: r() });
    }
    return out;
};
window.battleTerrainCentroid = (t) => centroid(t.shape);
window.battleTerrainArea = (t) => area(t.shape);
window.battleTerrainBounds = (t) => bounds(t.shape);

/* --- 2D drawing (shared by the Battle Map and the editor) --- */
function shapeMarkup(shape, attrs) {
    if (shape.type === 'circle') return `<circle cx="${shape.x}" cy="${shape.y}" r="${shape.r}" ${attrs}></circle>`;
    return `<polygon points="${shape.pts.map(p => p.join(',')).join(' ')}" ${attrs}></polygon>`;
}
function terrainItemSvg(t, opts) {
    const c = centroid(t.shape);
    const sel = opts && opts.selectedKey === t.key;
    const hit = opts && opts.editor ? `data-key="${esc(t.key)}" style="cursor:move"` : '';
    let body = '';
    if (t.kind === 'nebula') {
        body = shapeMarkup(t.shape, `fill="url(#bt-neb)" filter="url(#bt-blur)" opacity="0.7" ${hit}`);
    } else if (t.kind === 'planet') {
        body = shapeMarkup(t.shape, `fill="url(#bt-planet)" stroke="#6fb4d8" stroke-width="1.5" ${hit}`)
            + (t.shape.type === 'circle' ? `<ellipse cx="${t.shape.x}" cy="${t.shape.y}" rx="${t.shape.r * 1.35}" ry="${t.shape.r * 0.28}" fill="none" stroke="rgba(160,210,235,0.25)" stroke-width="2" pointer-events="none"></ellipse>` : '');
    } else if (t.kind === 'station') {
        const s = t.shape;
        body = shapeMarkup(s, `fill="rgba(0,225,255,0.06)" stroke="#00e1ff" stroke-width="1.5" stroke-dasharray="6 4" ${hit}`)
            + (s.type === 'circle' ? `<rect x="${s.x - s.r * 0.4}" y="${s.y - s.r * 0.4}" width="${s.r * 0.8}" height="${s.r * 0.8}" fill="rgba(0,225,255,0.12)" stroke="#7ff0ff" stroke-width="1.2" pointer-events="none"></rect><circle cx="${s.x}" cy="${s.y}" r="${s.r * 0.72}" fill="none" stroke="rgba(0,225,255,0.45)" stroke-width="1" pointer-events="none"></circle>` : '');
    } else {
        const rock = t.kind === 'asteroid';
        body = shapeMarkup(t.shape, `fill="${rock ? 'rgba(179,155,120,0.10)' : 'rgba(208,138,90,0.07)'}" stroke="${rock ? 'rgba(179,155,120,0.55)' : 'rgba(208,138,90,0.5)'}" stroke-width="1.2" stroke-dasharray="${rock ? '4 5' : '2 6'}" ${hit}`);
        const n = Math.max(6, Math.min(70, Math.round(area(t.shape) / (rock ? 700 : 900))));
        body += '<g pointer-events="none">' + window.battleTerrainScatter(t, n).map(p => rock
            ? `<ellipse cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" rx="${(2 + p.s * 6).toFixed(1)}" ry="${(1.6 + p.s * 4.5).toFixed(1)}" transform="rotate(${Math.round(p.a * 180)} ${p.x.toFixed(1)} ${p.y.toFixed(1)})" fill="#6f6250" stroke="#a8936f" stroke-width="0.6"></ellipse>`
            : `<path d="M${(p.x - 4 - p.s * 4).toFixed(1)} ${p.y.toFixed(1)} l${(6 + p.s * 6).toFixed(1)} ${(-2 + p.a * 4).toFixed(1)} l${(-2 - p.a * 3).toFixed(1)} ${(3 + p.s * 2).toFixed(1)}z" fill="#7a5a44" stroke="#d08a5a" stroke-width="0.6"></path>`).join('') + '</g>';
    }
    const ly = t.kind === 'planet' && t.shape.type === 'circle' ? t.shape.y + t.shape.r + 14 : c.y + 4;
    const label = t.label ? `<text x="${c.x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" class="bt-label" fill="${KINDS[t.kind].color}">${esc(t.label.toUpperCase())}</text>` : '';
    const ring = sel ? shapeMarkup(t.shape, 'fill="none" stroke="#ffd700" stroke-width="2" stroke-dasharray="5 4" pointer-events="none"') : '';
    return `<g class="bt-item bt-${t.kind}">${body}${label}${ring}</g>`;
}
// Inner markup of a terrain <svg>: defs, optional picture + grid lines, terrain.
window.renderBattleTerrainSvg = function (m, w, h, opts) {
    const bg = m && window.isMediaRef(m.background_url) ? m.background_url : null;
    const defs = `<defs>
        <radialGradient id="bt-neb"><stop offset="0" stop-color="#c38cff" stop-opacity="0.75"></stop><stop offset="0.6" stop-color="#6f3fb5" stop-opacity="0.35"></stop><stop offset="1" stop-color="#3a1f6a" stop-opacity="0"></stop></radialGradient>
        <radialGradient id="bt-planet" cx="0.35" cy="0.35" r="0.75"><stop offset="0" stop-color="#9fd3ee"></stop><stop offset="0.55" stop-color="#2f6f8f"></stop><stop offset="1" stop-color="#0c2433"></stop></radialGradient>
        <filter id="bt-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"></feGaussianBlur></filter>
        <pattern id="bt-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="rgba(120,200,215,0.18)" stroke-width="1"></path></pattern>
    </defs>`;
    const picture = bg ? `<image class="bt-bg" data-bg-ref="${esc(bg)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" opacity="0.85"></image><rect x="0" y="0" width="${w}" height="${h}" fill="url(#bt-grid)"></rect>` : '';
    const items = (m && m.terrain ? sanitizeTerrain(m.terrain) : []).map(t => terrainItemSvg(t, opts)).join('');
    return defs + picture + items;
};
const bgUrlCache = {};
async function hydrateBg(svg) {
    const img = svg && svg.querySelector('image.bt-bg');
    if (!img) return;
    const ref = img.getAttribute('data-bg-ref');
    let url = bgUrlCache[ref];
    if (!url) {
        url = /^https:/i.test(ref) ? ref : (typeof window.resolveMediaUrl === 'function' ? await window.resolveMediaUrl(ref) : null);
        if (url && !/^https:/i.test(ref)) bgUrlCache[ref] = url;
    }
    if (url && img.isConnected !== false) img.setAttribute('href', url);
}
window.hydrateBattleTerrainBackground = hydrateBg;

// Draws the active battle's map under the tokens (everyone).
let lastSig = null;
window.syncBattleTerrain = function () {
    const grid = document.getElementById('battle-map-grid');
    if (!grid) return;
    const enc = window.globalBattleEncounterCache;
    const m = enc && enc.map ? enc.map : null;
    let svg = document.getElementById('battle-terrain-layer');
    const hasMap = !!(m && ((m.terrain && m.terrain.length) || m.background_url));
    grid.classList.toggle('bm-has-bg', !!(m && m.background_url));
    if (!hasMap) { if (svg) svg.remove(); lastSig = null; return; }
    const { w, h } = window.battleGridSize();
    const sig = JSON.stringify([m.background_url, m.terrain, w, h]);
    if (svg && svg.parentNode === grid && sig === lastSig) {
        if (grid.firstChild !== svg) grid.insertBefore(svg, grid.firstChild);
        return;
    }
    if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'battle-terrain-layer';
        svg.setAttribute('class', 'battle-terrain-layer');
        svg.setAttribute('aria-hidden', 'true');
    }
    svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h)); svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = window.renderBattleTerrainSvg(m, w, h);
    grid.insertBefore(svg, grid.firstChild);
    lastSig = sig;
    hydrateBg(svg);
};

/* --- START BATTLE map picker + MAPS buttons (DM) --- */
function mapOptions(selected) {
    return '<option value="">— plain grid —</option>' + (window.battleMapsList || []).map(m => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)} · ${esc((m.size || 'standard').toUpperCase())}</option>`).join('');
}
window.battleMapOptionsHtml = mapOptions;
function ensureDmControls() {
    const dmControls = document.getElementById('battle-map-dm-controls');
    const ok = window.battleMapsAllowed();
    let wrap = document.getElementById('battle-map-map-pick');
    if (dmControls && !wrap) {
        wrap = document.createElement('div');
        wrap.id = 'battle-map-map-pick';
        wrap.innerHTML = `<label for="battle-map-map-select" style="font-size:9px; color:#6b826a;">Map (optional):</label>
            <div style="display:flex; gap:4px; align-items:center;"><select id="battle-map-map-select" style="font-size:11px; margin:2px 0; flex:1;"></select>
            <button type="button" class="layer-edit" onclick="window.openBattleMapEditor()" style="width:auto; font-size:9px; padding:3px 8px; margin:0;">🗺 MAPS</button></div>`;
        const start = dmControls.querySelector('button.btn-deploy');
        dmControls.insertBefore(wrap, start || null);
    }
    if (wrap) {
        wrap.style.display = ok ? '' : 'none';
        const sel = document.getElementById('battle-map-map-select');
        if (sel && ok) { const cur = sel.value; sel.innerHTML = mapOptions(cur); }
    }
    const anchor = document.getElementById('battle-map-end-btn');
    let b = document.getElementById('battle-map-maps-btn');
    if (anchor && !b) {
        b = document.createElement('button');
        b.id = 'battle-map-maps-btn';
        b.className = 'layer-edit';
        b.style.cssText = 'font-size:9px; padding:3px 8px; display:none;';
        b.textContent = '🗺 MAPS';
        b.onclick = () => window.openBattleMapEditor();
        anchor.parentNode.insertBefore(b, anchor);
    }
    if (b) b.style.display = ok && window.globalBattleEncounterCache ? 'inline-block' : 'none';
}
// Called by startBattleEncounter (battle-map.js): the picked map's snapshot.
window.pickedStartMap = function () {
    if (!window.battleMapsAllowed()) return null;
    const sel = document.getElementById('battle-map-map-select');
    const snap = sel && sel.value ? window.battleMapSnapshotById(sel.value) : null;
    if (sel) sel.value = '';
    return snap;
};

/* --- Editor (DM, full screen) --- */
const E = { map: null, dirty: false, tool: 'select', kind: 'asteroid', sel: null, draft: null, drag: null };
function blankMap() { return { id: null, name: 'New Map', size: 'standard', background_url: null, terrain: [], notes: '' }; }
function ensureOverlay() {
    let ov = document.getElementById('battle-map-editor');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'battle-map-editor';
    ov.className = 'bme';
    ov.style.display = 'none';
    document.body.appendChild(ov);
    document.addEventListener('keydown', (e) => {
        if (ov.style.display === 'none') return;
        const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
        if (e.key === 'Escape' && E.draft) { E.draft = null; drawCanvas(); }
        else if (e.key === 'Enter' && E.draft && E.draft.type === 'poly' && !typing) finishPoly();
        else if ((e.key === 'Delete' || e.key === 'Backspace') && E.sel && !typing) { e.preventDefault(); window.bmeDeleteSelected(); }
    });
    return ov;
}
window.openBattleMapEditor = async function () {
    if (!window.battleMapsAllowed()) return;
    ensureOverlay().style.display = 'block';
    await window.loadBattleMaps();
    if (!E.map) E.map = window.battleMapsList[0] ? JSON.parse(JSON.stringify(window.battleMapsList[0])) : blankMap();
    renderEditor();
};
window.closeBattleMapEditor = async function () {
    if (E.dirty && !(await window.showConfirmModal('You have unsaved changes to this map. Close anyway?'))) return;
    E.dirty = false; E.draft = null;
    const ov = document.getElementById('battle-map-editor'); if (ov) ov.style.display = 'none';
    ensureDmControls();
    if (typeof window.renderStagerIfOpen === 'function') window.renderStagerIfOpen();
};
function markDirty() { E.dirty = true; const d = document.getElementById('bme-dirty'); if (d) d.textContent = '● UNSAVED'; }
window.bmeMarkDirty = markDirty;
window.bmePick = async function (id) {
    if (E.dirty && !(await window.showConfirmModal('Discard unsaved changes to this map?'))) return;
    const m = id ? window.battleMapById(id) : null;
    E.map = m ? JSON.parse(JSON.stringify(m)) : blankMap();
    E.dirty = !m; E.sel = null; E.draft = null;
    renderEditor();
};
window.bmeTool = function (tool) { E.tool = tool; E.draft = null; renderEditor(); };
window.bmeKind = function (kind) {
    if (!KINDS[kind]) return;
    E.kind = kind;
    if (!KINDS[kind].poly && E.tool === 'poly') E.tool = 'circle';
    if (E.tool === 'select') E.tool = 'circle';
    renderEditor();
};
window.bmeSetField = function (field, value) {
    if (!E.map) return;
    if (field === 'size') {
        E.map.size = window.BATTLE_MAP_SIZES[value] ? value : 'standard';
        const { w, h } = window.battleMapDims(E.map);
        E.map.terrain = (E.map.terrain || []).filter(t => { const c = centroid(t.shape); return c.x <= w && c.y <= h; });
    } else if (field === 'name') E.map.name = String(value).slice(0, 80);
    else if (field === 'notes') E.map.notes = String(value).slice(0, 2000);
    markDirty();
    if (field === 'size') renderEditor();
};
window.bmeSetItem = function (field, value) {
    const t = (E.map.terrain || []).find(x => x.key === E.sel); if (!t) return;
    if (field === 'label') t.label = String(value).slice(0, 60);
    if (field === 'kind' && KINDS[value]) {
        if (!KINDS[value].poly && t.shape.type === 'poly') { const b = bounds(t.shape); t.shape = { type: 'circle', x: Math.round((b.x0 + b.x1) / 2), y: Math.round((b.y0 + b.y1) / 2), r: Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2) }; }
        t.kind = value;
    }
    markDirty();
    if (field === 'kind') renderEditor(); else drawCanvas();
};
window.bmeDeleteSelected = function () {
    if (!E.sel) return;
    E.map.terrain = (E.map.terrain || []).filter(t => t.key !== E.sel);
    E.sel = null; markDirty(); renderEditor();
};
window.bmeRefreshPicture = function () { if (!E.map) return; E.map.background_url = window.getMediaPickerValue('bmap'); markDirty(); drawCanvas(); };
window.bmeSave = async function () {
    if (!E.map || !isDm()) return false;
    const nameEl = document.getElementById('bme-name'); if (nameEl) E.map.name = nameEl.value.trim() || 'Untitled Map';
    const notesEl = document.getElementById('bme-notes'); if (notesEl) E.map.notes = notesEl.value;
    E.map.background_url = window.getMediaPickerValue('bmap');
    const payload = { name: E.map.name, size: E.map.size || 'standard', background_url: E.map.background_url || null, terrain: sanitizeTerrain(E.map.terrain), notes: E.map.notes || null, updated_at: new Date().toISOString() };
    let res;
    if (E.map.id) res = await db.from('battle_maps').update(payload).eq('id', E.map.id).select().single();
    else res = await db.from('battle_maps').insert(Object.assign({ created_by: currentUserId }, payload)).select().single();
    if (res.error) { alert('Could not save the map: ' + res.error.message); return false; }
    E.map = JSON.parse(JSON.stringify(res.data));
    E.dirty = false;
    await window.loadBattleMaps();
    if (typeof window.showToast === 'function') window.showToast(`Map "${E.map.name}" saved.`);
    renderEditor();
    return true;
};
window.bmeDelete = async function () {
    if (!E.map || !E.map.id) { E.map = blankMap(); E.dirty = false; renderEditor(); return; }
    if (!(await window.showConfirmModal(`Delete the map "${E.map.name}"? Battles already running on it keep their copy; presets using it fall back to the plain grid.`))) return;
    const { error } = await db.from('battle_maps').delete().eq('id', E.map.id);
    if (error) { alert('Could not delete the map: ' + error.message); return; }
    await window.loadBattleMaps();
    E.map = window.battleMapsList[0] ? JSON.parse(JSON.stringify(window.battleMapsList[0])) : blankMap();
    E.dirty = false; E.sel = null;
    renderEditor();
};

function renderEditor() {
    const ov = ensureOverlay();
    if (ov.style.display === 'none') return;
    const m = E.map || blankMap();
    const { w, h } = window.battleMapDims(m);
    const sel = (m.terrain || []).find(t => t.key === E.sel);
    const list = (window.battleMapsList || []).map(x => `<button type="button" class="bme-li${E.map && x.id === E.map.id ? ' on' : ''}" onclick="window.bmePick('${esc(x.id)}')"><span>${esc(x.name)}</span><small>${esc((x.size || 'standard').toUpperCase())} · ${(x.terrain || []).length} PIECES${x.background_url ? ' · PICTURE' : ''}</small></button>`).join('') || '<div class="bme-empty">No maps yet.</div>';
    const kindBtns = Object.keys(KINDS).map(k => `<button type="button" class="bme-kind${E.kind === k ? ' on' : ''}" style="--k:${KINDS[k].color}" onclick="window.bmeKind('${k}')">${KINDS[k].label.toUpperCase()}</button>`).join('');
    const polyOk = KINDS[E.kind].poly;
    const hint = E.tool === 'circle' ? 'CIRCLE: press and drag on the grid to draw. ' : E.tool === 'poly' ? 'POLYGON: click to add corners; click the first corner, double-click or press Enter to finish; Esc cancels. ' : 'SELECT: click a piece to select it, drag to move it, Delete to remove it. ';
    ov.innerHTML = `
        <div class="bme-head">
            <div><span class="bme-kicker">BATTLE MAP</span><h3 class="bme-title">MAP LIBRARY</h3></div>
            <span id="bme-dirty" class="bme-dirty">${E.dirty ? '● UNSAVED' : ''}</span>
            <span class="bme-grow"></span>
            <button type="button" class="bme-btn" onclick="window.closeBattleMapEditor()">✕ CLOSE</button>
        </div>
        <div class="bme-body">
            <aside class="bme-col bme-left">
                <div class="bme-ttl">MAPS</div>
                <div class="bme-list">${list}</div>
                <button type="button" class="bme-btn bme-amber" onclick="window.bmePick(null)">+ NEW MAP</button>
            </aside>
            <main class="bme-col bme-main">
                <div class="bme-tools">
                    <div class="bme-group" role="group" aria-label="Tool">
                        <button type="button" class="bme-tool${E.tool === 'select' ? ' on' : ''}" onclick="window.bmeTool('select')">SELECT</button>
                        <button type="button" class="bme-tool${E.tool === 'circle' ? ' on' : ''}" onclick="window.bmeTool('circle')">◯ CIRCLE</button>
                        <button type="button" class="bme-tool${E.tool === 'poly' ? ' on' : ''}" ${polyOk ? '' : 'disabled title="Planets and stations are circles"'} onclick="window.bmeTool('poly')">⬠ POLYGON</button>
                    </div>
                    <div class="bme-group bme-kinds" role="group" aria-label="Terrain kind">${kindBtns}</div>
                </div>
                <div id="bme-wrap" class="bme-wrap"><div id="bme-canvas" class="bme-canvas" style="width:${w}px; height:${h}px;">
                    <svg id="bme-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg></div></div>
                <div class="bme-hint">${hint}Terrain is visual only for now.</div>
            </main>
            <aside class="bme-col bme-right">
                <label class="bme-lab" for="bme-name">NAME</label>
                <input type="text" id="bme-name" value="${esc(m.name)}" oninput="window.bmeSetField('name', this.value)">
                <label class="bme-lab" for="bme-size">SIZE</label>
                <select id="bme-size" onchange="window.bmeSetField('size', this.value)">${Object.keys(SIZE_LABELS).map(k => `<option value="${k}" ${(m.size || 'standard') === k ? 'selected' : ''}>${SIZE_LABELS[k]}</option>`).join('')}</select>
                <div class="bme-note">Weapon ranges and ship speeds stay the same on every size — bigger maps just give more room.</div>
                <div id="bme-pic-slot">${window.renderMediaPickerHtml('bmap', m.background_url || '', 'BACKGROUND PICTURE (under the grid; the floor in 3D)')}</div>
                <button type="button" class="bme-btn bme-soft" onclick="window.bmeRefreshPicture()">↻ SHOW PICTURE ON THE MAP</button>
                <div class="bme-ttl bme-ttl2">SELECTED PIECE</div>
                ${sel ? `<label class="bme-lab" for="bme-kind">KIND</label>
                    <select id="bme-kind" onchange="window.bmeSetItem('kind', this.value)">${Object.keys(KINDS).map(k => `<option value="${k}" ${sel.kind === k ? 'selected' : ''}>${KINDS[k].label}</option>`).join('')}</select>
                    <label class="bme-lab" for="bme-label">LABEL (OPTIONAL)</label>
                    <input type="text" id="bme-label" value="${esc(sel.label || '')}" placeholder="e.g. Kessel Belt" oninput="window.bmeSetItem('label', this.value)">
                    <button type="button" class="bme-btn bme-red" onclick="window.bmeDeleteSelected()">✕ DELETE PIECE</button>`
                : '<div class="bme-note">Pick SELECT and click a piece to edit or delete it.</div>'}
                <label class="bme-lab" for="bme-notes">DM NOTES</label>
                <textarea id="bme-notes" rows="3" oninput="window.bmeSetField('notes', this.value)">${esc(m.notes || '')}</textarea>
                <div class="bme-actions">
                    <button type="button" class="bme-btn bme-primary" onclick="window.bmeSave()">SAVE MAP</button>
                    <button type="button" class="bme-btn bme-red" onclick="window.bmeDelete()">${m.id ? 'DELETE' : 'DISCARD'}</button>
                </div>
            </aside>
        </div>`;
    drawCanvas();
    fitCanvas();
    wireCanvas();
}
function drawCanvas() {
    const svg = document.getElementById('bme-svg');
    if (!svg || !E.map) return;
    const { w, h } = window.battleMapDims(E.map);
    const view = Object.assign({}, E.map, { background_url: E.map.background_url });
    let html = window.renderBattleTerrainSvg(view, w, h, { editor: true, selectedKey: E.sel });
    const d = E.draft;
    if (d && d.type === 'circle' && d.r > 0) html += `<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="rgba(255,215,0,0.08)" stroke="#ffd700" stroke-dasharray="5 4" pointer-events="none"></circle>`;
    if (d && d.type === 'poly' && d.pts.length) {
        const pts = d.pts.concat(d.hover ? [d.hover] : []);
        html += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="rgba(255,215,0,0.06)" stroke="#ffd700" stroke-dasharray="5 4" pointer-events="none"></polyline>`
            + d.pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="${i === 0 ? 6 : 3}" fill="${i === 0 ? 'rgba(255,215,0,0.35)' : '#ffd700'}" pointer-events="none"></circle>`).join('');
    }
    svg.innerHTML = html;
    hydrateBg(svg);
}
function fitCanvas() {
    const wrap = document.getElementById('bme-wrap'), c = document.getElementById('bme-canvas');
    if (!wrap || !c || !E.map) return;
    const { w, h } = window.battleMapDims(E.map);
    const scale = Math.min(1, (wrap.clientWidth || w) / w, ((window.innerHeight || 900) - 190) / h);
    E.scale = scale > 0.05 ? scale : 1;
    c.style.transform = `scale(${E.scale})`;
    wrap.style.height = Math.ceil(h * E.scale) + 'px';
}
window.addEventListener('resize', () => { const ov = document.getElementById('battle-map-editor'); if (ov && ov.style.display !== 'none') fitCanvas(); });
function toLocal(ev) {
    const c = document.getElementById('bme-canvas');
    const r = c.getBoundingClientRect();
    const s = E.scale || 1;
    const { w, h } = window.battleMapDims(E.map);
    return [Math.max(0, Math.min(w, Math.round((ev.clientX - r.left) / s))), Math.max(0, Math.min(h, Math.round((ev.clientY - r.top) / s)))];
}
function newKey() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
function finishPoly() {
    const d = E.draft;
    if (!d || d.type !== 'poly' || d.pts.length < 3) return;
    const t = { key: newKey(), kind: E.kind, label: '', shape: { type: 'poly', pts: d.pts } };
    E.map.terrain = (E.map.terrain || []).concat([t]);
    E.draft = null; E.sel = t.key; markDirty(); renderEditor();
}
// The editor's pointer handling, exposed for tests as window.__bme.
function onDown(ev) {
    const p = toLocal(ev);
    if (E.tool === 'circle') { E.draft = { type: 'circle', x: p[0], y: p[1], r: 0 }; return; }
    if (E.tool === 'poly') {
        const d = E.draft && E.draft.type === 'poly' ? E.draft : (E.draft = { type: 'poly', pts: [] });
        if (d.pts.length >= 3 && Math.hypot(p[0] - d.pts[0][0], p[1] - d.pts[0][1]) < 12) { finishPoly(); return; }
        d.pts.push(p); drawCanvas(); return;
    }
    const keyEl = ev.target && ev.target.closest ? ev.target.closest('[data-key]') : null;
    const key = keyEl ? keyEl.getAttribute('data-key') : null;
    E.selChanged = key !== E.sel;
    E.sel = key;
    if (key) {
        const t = E.map.terrain.find(x => x.key === key);
        E.drag = { t, start: p, orig: JSON.parse(JSON.stringify(t.shape)) };
    }
    drawCanvas(); // the side panel catches up on release (re-rendering now would drop the drag)
}
function onMove(ev) {
    const p = toLocal(ev);
    if (E.draft && E.draft.type === 'circle') { E.draft.r = Math.round(Math.hypot(p[0] - E.draft.x, p[1] - E.draft.y)); drawCanvas(); }
    else if (E.draft && E.draft.type === 'poly') { E.draft.hover = p; drawCanvas(); }
    else if (E.drag) {
        const dx = p[0] - E.drag.start[0], dy = p[1] - E.drag.start[1], o = E.drag.orig, t = E.drag.t;
        if (o.type === 'circle') t.shape = { type: 'circle', x: o.x + dx, y: o.y + dy, r: o.r };
        else t.shape = { type: 'poly', pts: o.pts.map(q => [q[0] + dx, q[1] + dy]) };
        E.drag.moved = E.drag.moved || Math.abs(dx) + Math.abs(dy) > 2;
        drawCanvas();
    }
}
function onUp() {
    if (E.draft && E.draft.type === 'circle') {
        const d = E.draft; E.draft = null;
        if (d.r >= 8) { const t = { key: newKey(), kind: E.kind, label: '', shape: { type: 'circle', x: d.x, y: d.y, r: d.r } }; E.map.terrain = (E.map.terrain || []).concat([t]); E.sel = t.key; markDirty(); renderEditor(); }
        else drawCanvas();
    } else if (E.drag) { if (E.drag.moved) markDirty(); E.drag = null; }
    if (E.selChanged) { E.selChanged = false; renderEditor(); }
}
function wireCanvas() {
    const svg = document.getElementById('bme-svg');
    if (!svg) return;
    svg.addEventListener('pointerdown', (ev) => { ev.preventDefault(); onDown(ev); });
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointerleave', () => { if (E.draft && E.draft.type === 'poly') { E.draft.hover = null; drawCanvas(); } });
    svg.addEventListener('dblclick', () => finishPoly());
}
window.__bme = { state: E, down: onDown, move: onMove, up: onUp, finishPoly, render: renderEditor };

/* --- Hooks --- */
window.onBattleMapRender('battle-maps', () => { window.syncBattleTerrain(); ensureDmControls(); }, 60);
document.addEventListener('darkforest:features-changed', async () => {
    try { if (window.battleMapsAllowed() && !(window.battleMapsList || []).length) await window.loadBattleMaps(); ensureDmControls(); } catch (e) {}
});
})();
