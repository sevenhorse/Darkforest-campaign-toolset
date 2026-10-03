/* ==========================================================================
   js/battle-3d.js - Battle Map "Command view" (3D), Phase 6a, 2026-10-03
   ==========================================================================
   DM decisions (2026-10-03):
   - The 2D grid stays as the flat "Classic" view, with every tool intact.
     This 3D view is a second view of the same battle, not a replacement.
   - Default per device: Command (3D) on desktop, Classic on phones. Anyone
     can switch; the choice is remembered per device (localStorage).
   - Altitude is VISUAL ONLY: auto by class (strike craft low, ships
     staggered, stations level) plus a per-token nudge stored in
     battle_tokens.z. It never touches range, movement or arcs.
   - Ships show the low-poly hull for their class, swapped for the ship's
     converted .glb model when it has one (Phase 6c, js/ship-models.js).

   How it fits:
   - Loads Three.js (pinned r170) from jsDelivr ONLY when someone opens
     this view. No WebGL, or the download fails -> Classic, automatically.
   - Hooks renderBattleMapPanel (after the tactical HUD's hook). The DOM
     grid keeps rendering underneath (hidden), so switching back is instant
     and every DOM-based tool keeps its state.
   - Moving uses the SAME rules as the 2D drag (battleMoveRule /
     battleConstrainMove / battleCommitMove in js/battle-map.js), placing
     uses placeArmedTokenAt, a tap uses battleTokenTapped.
   - Renders on demand only: 0 FPS while nothing changes or moves.
   - Behind the 'battle_3d' feature switch.
   Phase 6b (2026-10-03, DM defaults): ships glide to new positions/headings
   with a fading engine trail (moves only -- no constant animation); weapon
   effects per damage family; shields-up hits flash a blue bubble, shields-
   down hits throw hull sparks; bigger explosions; measuring tape in 3D
   (shared tapes both ways with the 2D view); quality HIGH/LOW (auto by
   device, ⚙ toggle remembered per device); on a phone in 3D the HUD bottom
   sheet starts as a slim bar (tap the name to open).

   Coordinates: grid (gx, gy) -> 3D (gx - W/2, altitude, gy - H/2). Y is up.
   Facing 0 (top of grid) = -Z; a hull's rotation.y = -facing.
   Loaded after js/tactical-hud.js. */
(function () {
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
const VIEW_KEY = 'darkforest_battle_view';
const B3 = {
    THREE: null, loading: null, failed: false,
    importer: null,        // test hook: (url) => Promise<module>
    createRenderer: null,  // test hook: (THREE, canvasHost) => renderer
    forceWebGL: null,      // test hook: true/false
    el: null, renderer: null, scene: null, camera: null,
    groups: {}, objs: {}, geo: {}, mats: {},
    cam: { tx: 0, tz: 0, yaw: 0, pitch: 55, dist: 1000 },
    pending: false, drag: null, pointers: {}, fx: [], lastEncId: null,
    selectedLocal: null, frames: 0, hintShown: false,
    tool: null, tape: null, sheetMini: true
};
window.__b3d = B3;

/* --- Availability / view choice --- */
function featureOn() { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('battle_3d'); }
let webglOk = null;
function hasWebGL() {
    if (B3.forceWebGL !== null) return !!B3.forceWebGL;
    if (webglOk !== null) return webglOk;
    try {
        const c = document.createElement('canvas');
        webglOk = !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { webglOk = false; }
    return webglOk;
}
function isPhone() {
    try { return window.matchMedia('(max-width: 768px)').matches || window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
}
window.battle3dPreferredView = function () {
    let v = null;
    try { v = localStorage.getItem(VIEW_KEY); } catch (e) {}
    if (v === 'command' || v === 'classic') return v;
    return isPhone() ? 'classic' : 'command';
};
window.battle3dAvailable = function () { return featureOn() && hasWebGL() && !B3.failed; };
window.battle3dActive = function () {
    return window.battle3dAvailable() && !!window.globalBattleEncounterCache && window.battle3dPreferredView() === 'command';
};
window.setBattleView = function (v) {
    try { localStorage.setItem(VIEW_KEY, v === 'command' ? 'command' : 'classic'); } catch (e) {}
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
};
window.toggleBattleView = function () {
    window.setBattleView(window.battle3dActive() ? 'classic' : 'command');
};

/* --- Quality (Phase 6b) --- */
const QUALITY_KEY = 'darkforest_battle_quality';
window.battle3dQuality = function () {
    let q = null;
    try { q = localStorage.getItem(QUALITY_KEY); } catch (e) {}
    if (q === 'high' || q === 'low') return q;
    return isPhone() ? 'low' : 'high';
};
function lowQ() { return window.battle3dQuality() === 'low'; }
function applyQuality() {
    if (!B3.renderer) return;
    B3.renderer.setPixelRatio(lowQ() ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    B3._w = null; resize();
    requestRender();
}
window.setBattle3dQuality = function (q) {
    try { localStorage.setItem(QUALITY_KEY, q === 'low' ? 'low' : 'high'); } catch (e) {}
    applyQuality(); updateToolbar();
};

/* --- Small helpers --- */
const esc = (s) => window.escapeHtml ? window.escapeHtml(s == null ? '' : String(s)) : String(s == null ? '' : s);
function encTokens() { return (window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || []; }
function vesselById(id) { return globalShipMarkersCache.find(m => m.id === id) || null; }
function visibleToMe(v) { return !v || typeof window.isVesselVisibleToMe !== 'function' || window.isVesselVisibleToMe(v); }
function tokSize(v) { return (v && v.is_strike_craft) ? BATTLE_STRIKE_CRAFT_TOKEN_SIZE : BATTLE_TOKEN_SIZE; }
function tokCenter(tok) {
    if (typeof window.battleTokenCenter === 'function') return window.battleTokenCenter(tok);
    const s = tokSize(vesselById(tok.ship_marker_id));
    return { x: tok.x + s / 2, y: tok.y + s / 2 };
}
function hash(str) { let h = 0; str = String(str || ''); for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h); }
function factionColor(v) {
    try { if (typeof battleTokenFactionColor === 'function') return battleTokenFactionColor(v); } catch (e) {}
    return '#00e1ff';
}
function canControl(v) { return !!v && (currentUserRole === 'dm' || window.vesselHasOwner(v, currentUserId)); }
// Phase 11 (DM 2026-10-03): the header's 📏 MEASURE / ⬚ SELECT
// (js/grid-tools.js) drive the 3D view too. The 3D toolbar's own TAPE /
// SHARE buttons only show when the grid_tools switch is off.
function gtOn3() { return typeof window.gridToolsOn === 'function' && window.gridToolsOn() && !!window.__gridTools; }
function tool3d() {
    if (gtOn3()) { const t = window.__gridTools.tool; return t === 'measure' ? 'tape' : t === 'select' ? 'select' : null; }
    return B3.tool === 'tape' ? 'tape' : null;
}
function groupSel() { return gtOn3() ? window.__gridTools.selected : new Set(); }
window.battle3dTool = tool3d; // for tests
function selectedVesselId() {
    if (typeof window.tv2Active === 'function' && window.tv2Active() && window.__tv2) return window.__tv2.selected;
    return B3.selectedLocal;
}
function shipKind(v) {
    if (!v) return 'capital';
    if (v.is_station) return 'station';
    if (v.is_strike_craft) return 'craft';
    return /escort|frigate|corvette|destroyer/i.test(String(v.vessel_class || '')) ? 'escort' : 'capital';
}

/* --- Altitude (visual only) --- */
window.battle3dAutoAltitude = function (v, tok) {
    if (!v) return 30;
    if (v.is_station) return 8;
    if (v.is_strike_craft) return 16;
    const base = shipKind(v) === 'escort' ? 26 : 38;
    return base + (hash(tok && tok.token_id) % 3) * 12; // stagger so stacked ships don't merge
};
window.battle3dAltitude = function (v, tok) {
    return Math.max(2, window.battle3dAutoAltitude(v, tok) + (Number(tok && tok.z) || 0));
};
const HULL_SCALE = 1.7; // hulls read too small at the default zoom at 1:1
const ALT_STEP = 15, ALT_MIN = -40, ALT_MAX = 120;
window.nudgeBattleAltitude = async function (tokenId, delta) {
    const enc = window.globalBattleEncounterCache;
    if (!enc) return false;
    const tok = (enc.tokens || []).find(t => t.token_id === tokenId);
    const v = tok && vesselById(tok.ship_marker_id);
    if (!tok || !canControl(v) || v.is_station) return false;
    const z = Math.max(ALT_MIN, Math.min(ALT_MAX, (Number(tok.z) || 0) + delta));
    if (z === (Number(tok.z) || 0)) return true;
    const tokens = (enc.tokens || []).map(t => t.token_id === tokenId ? { ...t, z } : t);
    const save = () => saveBattleTokens(tokens);
    if (typeof window.recordBattleAction === 'function') await window.recordBattleAction('Altitude', save);
    else await save();
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return true;
};

/* --- Grid <-> 3D --- */
function V(gx, gy, alt) { return new B3.THREE.Vector3(gx - BATTLE_GRID_W / 2, alt || 0, gy - BATTLE_GRID_H / 2); }
function toGrid(p) { return { x: p.x + BATTLE_GRID_W / 2, y: p.z + BATTLE_GRID_H / 2 }; }

/* --- Three.js loading --- */
function loadThree() {
    if (B3.THREE) return Promise.resolve(B3.THREE);
    if (!B3.loading) {
        const imp = B3.importer || ((u) => import(u));
        B3.loading = imp(THREE_URL).then(m => { B3.THREE = m; return m; }).catch(err => {
            console.error('3D view: could not load Three.js -- falling back to the 2D grid', err);
            B3.failed = true; B3.loading = null;
            throw err;
        });
    }
    return B3.loading;
}

/* --- DOM shell --- */
function ensureEls() {
    const stage = document.getElementById('battle-map-stage');
    if (!stage) return null;
    let el = document.getElementById('battle-3d-view');
    if (!el) {
        el = document.createElement('div');
        el.id = 'battle-3d-view';
        el.className = 'b3d-view';
        el.innerHTML = `<div class="b3d-canvas-host"></div>
            <div class="b3d-labels"></div>
            <div class="b3d-status">Loading 3D view…</div>
            <div class="b3d-toolbar">
                <button type="button" class="layer-edit" data-act="reset" title="Reset the camera">⟲ VIEW</button>
                <button type="button" class="layer-edit" data-act="top" title="Look straight down">⊤ TOP</button>
                <button type="button" class="layer-edit" data-act="tape" title="Measuring tape: drag on the plane (starts at a ship's centre if you start on one). Tap to clear. Right-drag still pans.">📏 TAPE</button>
                <button type="button" class="layer-edit" data-act="share" title="Show my tape on everyone's map">📡 SHARE</button>
                <button type="button" class="layer-edit" data-act="quality" title="Graphics quality (remembered on this device)">⚙ HIGH</button>
                <span class="b3d-sel-tools">
                    <button type="button" class="layer-edit" data-act="turnL" title="Turn the selected ship 15° left">⟲ 15°</button>
                    <button type="button" class="layer-edit" data-act="turnR" title="Turn the selected ship 15° right">⟳ 15°</button>
                    <button type="button" class="layer-edit" data-act="altU" title="Raise the selected ship (looks only -- no effect on range or movement)">ALT ▲</button>
                    <button type="button" class="layer-edit" data-act="altD" title="Lower the selected ship (looks only)">ALT ▼</button>
                </span>
            </div>
            <div class="b3d-hint">Drag empty space to orbit · right-drag or Shift-drag to pan · wheel / pinch to zoom · drag your ship to move it · tap a ship to select it · header 📏 / ⬚ tools work here</div>`;
        const wrap = document.getElementById('battle-map-grid-wrap');
        stage.insertBefore(el, wrap ? wrap.nextSibling : null);
        el.querySelector('.b3d-toolbar').addEventListener('click', onToolbar);
        wireInput(el);
    }
    B3.el = el;
    return el;
}
function ensureHeaderButton() {
    let btn = document.getElementById('battle-map-view-btn');
    if (!btn) {
        const anchor = document.getElementById('battle-map-log-btn') || document.getElementById('battle-map-end-btn');
        if (!anchor || !anchor.parentNode) return;
        btn = document.createElement('button');
        btn.id = 'battle-map-view-btn';
        btn.type = 'button';
        btn.className = 'layer-edit';
        btn.style.cssText = 'font-size:9px; padding:3px 8px;';
        btn.onclick = () => window.toggleBattleView();
        anchor.parentNode.insertBefore(btn, anchor);
    }
    const avail = window.battle3dAvailable() && !!window.globalBattleEncounterCache;
    btn.style.display = avail ? 'inline-block' : 'none';
    const on = window.battle3dActive();
    btn.textContent = on ? '▦ 2D VIEW' : '🛰 3D VIEW';
    btn.title = on ? 'Switch to the flat grid (all grid tools)' : 'Switch to the 3D Command view';
}

/* --- Scene --- */
function initScene() {
    const T = B3.THREE;
    const host = B3.el.querySelector('.b3d-canvas-host');
    const renderer = B3.createRenderer ? B3.createRenderer(T, host)
        : new T.WebGLRenderer({ antialias: window.battle3dQuality() === 'high', powerPreference: 'low-power' });
    renderer.setPixelRatio(window.battle3dQuality() === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    if (renderer.domElement && !renderer.domElement.parentNode) host.appendChild(renderer.domElement);
    const scene = new T.Scene();
    scene.background = new T.Color(0x03070b);
    scene.fog = new T.Fog(0x03070b, 1500, 3200);
    const camera = new T.PerspectiveCamera(45, 1, 5, 6000);
    scene.add(new T.HemisphereLight(0xa8e6ff, 0x081018, 1.0));
    const sun = new T.DirectionalLight(0xffffff, 1.4);
    sun.position.set(300, 700, 250);
    scene.add(sun);

    // The tactical plane + grid (rebuilt when the battle's map size/picture changes -- Phase 7)
    ['floor', 'terrain', 'tokens', 'overlay', 'fx', 'preview', 'tape'].forEach(k => { B3.groups[k] = new T.Group(); scene.add(B3.groups[k]); });
    Object.assign(B3, { renderer, scene, camera });
    buildFloor(null);
    resetCamera();
    try { window.addEventListener('resize', () => { resize(); requestRender(); }); } catch (e) {}
}
/* --- Floor + map terrain (Phase 7, js/battle-maps.js) --- */
function own(obj) { obj.traverse(o => { o.userData.ownGeo = true; o.userData.ownMat = true; }); return obj; }
function buildFloor(map) {
    const T = B3.THREE, g = B3.groups.floor;
    if (B3.plane && B3.plane.userData.tex) { B3.plane.userData.tex.dispose(); B3.plane.userData.tex = null; }
    clearGroup(g);
    const W = BATTLE_GRID_W, H = BATTLE_GRID_H;
    const hasPic = !!(map && map.background_url);
    const plane = new T.Mesh(new T.PlaneGeometry(W, H), new T.MeshBasicMaterial({ color: hasPic ? 0x9aa6aa : 0x061318, transparent: true, opacity: hasPic ? 1 : 0.92 }));
    plane.rotation.x = -Math.PI / 2;
    g.add(own(plane));
    B3.plane = plane;
    const minor = [], major = [];
    for (let x = 0; x <= W; x += 40) (x % 200 === 0 ? major : minor).push(x - W / 2, 0.2, -H / 2, x - W / 2, 0.2, H / 2);
    for (let y = 0; y <= H; y += 40) (y % 200 === 0 ? major : minor).push(-W / 2, 0.2, y - H / 2, W / 2, 0.2, y - H / 2);
    const lines = (arr, color, opacity) => {
        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.Float32BufferAttribute(arr, 3));
        return own(new T.LineSegments(geo, new T.LineBasicMaterial({ color, transparent: true, opacity })));
    };
    g.add(lines(minor, 0x1a4652, hasPic ? 0.3 : 0.45));
    g.add(lines(major, 0x2a7f8f, hasPic ? 0.5 : 0.7));
    g.add(lines([-W / 2, 0.3, -H / 2, W / 2, 0.3, -H / 2, W / 2, 0.3, -H / 2, W / 2, 0.3, H / 2, W / 2, 0.3, H / 2, -W / 2, 0.3, H / 2, -W / 2, 0.3, H / 2, -W / 2, 0.3, -H / 2], 0x3fc6d8, 0.9));
    if (hasPic) {
        // The picture is the battlefield floor (DM decision). Loaded async; the plain floor shows until then.
        const ref = map.background_url;
        Promise.resolve(/^https:/i.test(ref) ? ref : (window.resolveMediaUrl ? window.resolveMediaUrl(ref) : null)).then(url => {
            if (!url || B3.plane !== plane) return;
            const loader = B3.textureLoader || new T.TextureLoader();
            loader.setCrossOrigin && loader.setCrossOrigin('anonymous');
            loader.load(url, tex => {
                if (B3.plane !== plane) { tex.dispose(); return; }
                if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
                plane.material.map = tex; plane.material.color.set(0xb8c4c8); plane.material.needsUpdate = true;
                plane.userData.tex = tex;
                requestRender();
            }, undefined, () => {});
        });
    }
}
let nebulaTex = null;
function nebulaTexture() {
    if (nebulaTex !== null) return nebulaTex;
    const T = B3.THREE;
    try {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const ctx = c.getContext && c.getContext('2d');
        if (!ctx) { nebulaTex = false; return false; }
        const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
        nebulaTex = new T.CanvasTexture(c);
    } catch (e) { nebulaTex = false; }
    return nebulaTex;
}
function buildTerrain(map) {
    const T = B3.THREE, g = B3.groups.terrain;
    clearGroup(g);
    const list = map && window.sanitizeBattleTerrain ? window.sanitizeBattleTerrain(map.terrain) : [];
    const low = lowQ();
    const rockGeo = own(new T.Mesh(new T.DodecahedronGeometry(1, 0))).geometry;
    const shardGeo = own(new T.Mesh(new T.TetrahedronGeometry(1, 0))).geometry;
    B3.terrainLabels = [];
    list.forEach(t => {
        const holder = new T.Group();
        holder.userData.terrainKey = t.key;
        const rnd = window.battleTerrainRng(t.key + ':3d');
        const area = window.battleTerrainArea(t);
        const c = window.battleTerrainCentroid(t);
        if (t.kind === 'asteroid' || t.kind === 'debris') {
            const rock = t.kind === 'asteroid';
            let n = Math.round(area / (rock ? 900 : 1100));
            n = Math.max(6, Math.min(low ? 40 : 90, n));
            const mat = new T.MeshStandardMaterial({ color: rock ? 0x7a6a55 : 0x6e5a4a, roughness: 0.95, metalness: rock ? 0.05 : 0.5, flatShading: true });
            const mesh = new T.InstancedMesh(rock ? rockGeo : shardGeo, mat, n);
            const m4 = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), sc = new T.Vector3(), pos = new T.Vector3();
            window.battleTerrainScatter(t, n).forEach((p, i) => {
                const size = rock ? 3 + p.s * 10 : 1.5 + p.s * 4;
                e.set(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3); q.setFromEuler(e);
                sc.set(size, size * (0.6 + rnd() * 0.5), size * (0.7 + rnd() * 0.5));
                pos.copy(V(p.x, p.y, 4 + rnd() * (rock ? 46 : 36)));
                m4.compose(pos, q, sc); mesh.setMatrixAt(i, m4);
            });
            const placed = window.battleTerrainScatter(t, n).length;
            mesh.count = Math.min(n, placed);
            mesh.userData.ownMat = true; mesh.userData.ownGeo = true; // (shared rock geometry: disposing it twice is harmless)
            holder.add(mesh);
        } else if (t.kind === 'nebula') {
            const tex = nebulaTexture();
            const n = Math.max(4, Math.min(low ? 10 : 22, Math.round(area / 7000)));
            window.battleTerrainScatter(t, n).forEach(p => {
                const size = 70 + p.s * 110;
                const mat = tex ? new T.SpriteMaterial({ map: tex, color: rnd() < 0.5 ? 0xb47cff : 0x6a8cff, transparent: true, opacity: 0.28, depthWrite: false, blending: T.AdditiveBlending })
                    : new T.SpriteMaterial({ color: 0xb47cff, transparent: true, opacity: 0.12, depthWrite: false });
                const sp = new T.Sprite(mat);
                sp.scale.set(size, size * 0.7, 1);
                sp.position.copy(V(p.x, p.y, 12 + rnd() * 40));
                sp.userData.ownMat = true;
                holder.add(sp);
            });
        } else if (t.kind === 'planet' && t.shape.type === 'circle') {
            const r = t.shape.r;
            const sphere = own(new T.Mesh(new T.SphereGeometry(r, low ? 20 : 40, low ? 12 : 24), new T.MeshStandardMaterial({ color: 0x2f6f8f, emissive: 0x0c2433, emissiveIntensity: 0.6, roughness: 0.85 })));
            sphere.position.copy(V(t.shape.x, t.shape.y, -r * 0.55));
            holder.add(sphere);
        } else if (t.kind === 'station' && t.shape.type === 'circle') {
            const r = t.shape.r;
            const body = own(new T.Mesh(new T.BoxGeometry(r * 0.8, Math.max(8, r * 0.3), r * 0.8), new T.MeshStandardMaterial({ color: 0x5a7680, metalness: 0.6, roughness: 0.5, flatShading: true })));
            body.position.copy(V(t.shape.x, t.shape.y, Math.max(8, r * 0.3) / 2 + 2));
            const ring = own(new T.Mesh(new T.TorusGeometry(r * 0.72, Math.max(1.2, r * 0.04), 8, low ? 32 : 64), new T.MeshStandardMaterial({ color: 0x00e1ff, emissive: 0x00b8d4, emissiveIntensity: 0.5 })));
            ring.rotation.x = Math.PI / 2;
            ring.position.copy(V(t.shape.x, t.shape.y, 10));
            holder.add(body, ring);
        }
        g.add(holder);
        // Phase 11 (DM 2026-10-03): float the name over NAMED terrain only.
        if (t.label) {
            const r = t.shape.type === 'circle' ? t.shape.r : 0;
            const h = t.kind === 'planet' ? r * 0.45 + 14 : t.kind === 'station' ? Math.max(8, r * 0.3) + 22 : 62;
            B3.terrainLabels.push({ pos: V(c.x, c.y, h), html: esc(t.label.toUpperCase()), cls: `b3d-terr-label b3d-terr-${t.kind}` });
        }
    });
    B3.terrainCount = list.length;
}
// Called from syncScene: rebuilds floor / terrain only when the battle's map changes.
function syncMap(enc) {
    const map = enc && enc.map ? enc.map : null;
    const floorSig = JSON.stringify([BATTLE_GRID_W, BATTLE_GRID_H, map && map.background_url]);
    if (B3.floorSig !== floorSig) {
        const sizeChanged = B3.floorSize && (B3.floorSize[0] !== BATTLE_GRID_W || B3.floorSize[1] !== BATTLE_GRID_H);
        buildFloor(map);
        B3.floorSig = floorSig; B3.floorSize = [BATTLE_GRID_W, BATTLE_GRID_H];
        if (sizeChanged) resetCamera();
    }
    const terrSig = JSON.stringify([map && map.terrain, lowQ()]);
    if (B3.terrainSig !== terrSig) { buildTerrain(map); B3.terrainSig = terrSig; }
}
window.__b3dMap = { buildFloor, buildTerrain };
function resize() {
    if (!B3.renderer || !B3.el) return;
    const w = Math.max(50, B3.el.clientWidth || 720), h = Math.max(50, B3.el.clientHeight || 600);
    if (B3._w === w && B3._h === h) return;
    B3._w = w; B3._h = h;
    B3.renderer.setSize(w, h, true);
    B3.camera.aspect = w / h;
    B3.camera.updateProjectionMatrix();
}
function fitDist(pitchDeg) {
    const aspect = (B3._w || 720) / (B3._h || 600);
    const vfov = 45 * Math.PI / 180;
    const needH = BATTLE_GRID_H * 0.55 + 40, needW = BATTLE_GRID_W * 0.55 + 40;
    const dH = needH / Math.tan(vfov / 2);
    const dW = needW / (Math.tan(vfov / 2) * aspect);
    const flat = pitchDeg > 80 ? 1 : 0.92;
    return Math.max(dH, dW) * flat;
}
function resetCamera() { resize(); Object.assign(B3.cam, { tx: 0, tz: 40, yaw: 0, pitch: 52 }); B3.cam.dist = fitDist(52); requestRender(); }
function topCamera() { resize(); Object.assign(B3.cam, { tx: 0, tz: 0, yaw: 0, pitch: 89.5 }); B3.cam.dist = fitDist(89.5); requestRender(); }
window.battle3dResetCamera = resetCamera;
window.battle3dTopCamera = topCamera;
function applyCamera() {
    const c = B3.cam, p = c.pitch * Math.PI / 180, y = c.yaw * Math.PI / 180;
    B3.camera.position.set(c.tx + c.dist * Math.cos(p) * Math.sin(y), c.dist * Math.sin(p), c.tz + c.dist * Math.cos(p) * Math.cos(y));
    B3.camera.lookAt(c.tx, 0, c.tz);
    B3.camera.updateMatrixWorld();
}

/* --- Shared geometry / materials --- */
function geo(key) {
    if (B3.geo[key]) return B3.geo[key];
    const T = B3.THREE;
    let g;
    if (key === 'capital') { g = new T.ConeGeometry(10, 36, 4); g.rotateX(-Math.PI / 2); g.scale(1, 0.42, 1); }
    else if (key === 'escort') { g = new T.ConeGeometry(7.5, 27, 4); g.rotateX(-Math.PI / 2); g.scale(1, 0.42, 1); }
    else if (key === 'bridge') { g = new T.BoxGeometry(5, 4, 9); }
    else if (key === 'craft') { g = new T.ConeGeometry(5, 14, 3); g.rotateX(-Math.PI / 2); g.scale(1, 0.35, 1); }
    else if (key === 'station') { g = new T.TorusGeometry(13, 2.6, 6, 18); g.rotateX(Math.PI / 2); }
    else if (key === 'stationCore') { g = new T.CylinderGeometry(4.5, 4.5, 11, 8); }
    else if (key === 'glow') { g = new T.SphereGeometry(2.2, 10, 8); }
    else if (key === 'unitLine') { g = new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, 1, 0)]); }
    else if (key.startsWith('ring:')) { const [, a, b] = key.split(':').map(Number); g = new T.RingGeometry(a, b, 40); g.rotateX(-Math.PI / 2); }
    else if (key.startsWith('disc:')) { const r = Number(key.split(':')[1]); g = new T.CircleGeometry(r, 40); g.rotateX(-Math.PI / 2); }
    B3.geo[key] = g;
    return g;
}
function mat(kind, color, opacity) {
    const key = `${kind}|${color}|${opacity == null ? 1 : opacity}`;
    if (B3.mats[key]) return B3.mats[key];
    const T = B3.THREE;
    const transparent = opacity != null && opacity < 1;
    let m;
    if (kind === 'hull') m = new T.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22, metalness: 0.35, roughness: 0.55, flatShading: true, transparent, opacity: opacity == null ? 1 : opacity });
    else if (kind === 'line') m = new T.LineBasicMaterial({ color, transparent: true, opacity: opacity == null ? 1 : opacity });
    else if (kind === 'glow') m = new T.MeshBasicMaterial({ color, transparent: true, opacity: opacity == null ? 1 : opacity, blending: T.AdditiveBlending, depthWrite: false });
    else if (kind === 'dash') m = new T.LineDashedMaterial({ color, transparent: true, opacity: opacity == null ? 1 : opacity, dashSize: 8, gapSize: 6 });
    else m = new T.MeshBasicMaterial({ color, transparent: true, opacity: opacity == null ? 1 : opacity, side: T.DoubleSide, depthWrite: false });
    B3.mats[key] = m;
    return m;
}
function lineObj(points, color, opacity, dashed) {
    const T = B3.THREE;
    const g = new T.BufferGeometry().setFromPoints(points);
    const l = new T.Line(g, mat(dashed ? 'dash' : 'line', color, opacity));
    if (dashed) l.computeLineDistances();
    l.userData.ownGeo = true;
    return l;
}
function disposeTree(obj) {
    obj.traverse(o => {
        if (o.userData && o.userData.ownGeo && o.geometry) o.geometry.dispose();
        if (o.userData && o.userData.ownMat && o.material) [].concat(o.material).forEach(m => m.dispose());
    });
}

/* --- Tokens --- */
function buildHull(kind, color, ghost) {
    const T = B3.THREE;
    const g = new T.Group();
    const m = mat('hull', color, ghost ? 0.45 : null);
    if (kind === 'station') {
        g.add(new T.Mesh(geo('station'), m));
        g.add(new T.Mesh(geo('stationCore'), m));
    } else {
        g.add(new T.Mesh(geo(kind), m));
        // Engine glow at the stern (Phase 6b); brightens while the ship moves.
        const glow = new T.Mesh(geo('glow'), mat('glow', '#9ff3ff', ghost ? 0.35 : 0.85));
        glow.position.set(0, 0, kind === 'craft' ? 7.5 : kind === 'escort' ? 13.5 : 18);
        glow.userData.isGlow = true;
        g.add(glow);
        g.userData.glow = glow;
        if (kind !== 'craft') {
            const br = new T.Mesh(geo('bridge'), m);
            br.position.set(0, 3.2, kind === 'escort' ? 4 : 6);
            g.add(br);
        }
    }
    return g;
}

/* --- Ship models (Phase 6c) ---
   A ship (or its template, copied at deploy) can carry a converted .glb
   (js/ship-models.js). The low-poly hull shows at once; the model swaps in
   when it has loaded and the hull stays if it fails. Models are scaled to a
   fixed length per class (x model_scale) so a 675 m carrier doesn't swallow
   the grid -- the grid is tactical, not to scale. */
const MODEL_LEN = { craft: 24, escort: 46, capital: 61, station: 44 }; // world units, after HULL_SCALE
B3.models = B3.models || {};     // ref -> { scene, length, center } once loaded, or 'failed'
// A launched squadron token has no model of its own; it uses its chassis's
// (Strike Craft Designer), found through the carrier's deployed squadron.
function modelSource(v) {
    if (v.model_url || v.model_lite_url || !v.is_strike_craft) return v;
    try {
        const rec = typeof getSquadronRecordForToken === 'function' ? getSquadronRecordForToken(v) : null;
        const ch = rec && typeof STRIKE_CRAFT_DB !== 'undefined' ? STRIKE_CRAFT_DB[rec.sq.type] : null;
        return ch || v;
    } catch (e) { return v; }
}
function modelSpec(vessel) {
    if (!vessel || typeof window.loadShipModel !== 'function') return null;
    const v = modelSource(vessel);
    const ref = lowQ() ? (v.model_lite_url || v.model_url) : (v.model_url || v.model_lite_url);
    if (!ref || !(window.isModelRef && window.isModelRef(ref))) return null;
    const yaw = [0, 90, 180, 270].includes(Number(v.model_yaw_offset)) ? Number(v.model_yaw_offset) : 0;
    const scale = Number(v.model_scale) > 0 ? Math.max(0.25, Math.min(4, Number(v.model_scale))) : 1;
    return { ref, yaw, scale };
}
function specKey(spec) { return spec ? `${spec.ref}|${spec.yaw}|${spec.scale}` : ''; }
// Builds the model hull (same contract as buildHull: a group drawn at
// HULL_SCALE with userData.glow), or null if the model isn't loaded yet.
function buildModelHull(kind, spec, ghost) {
    const data = spec && B3.models[spec.ref];
    if (!data || data === 'failed') return null;
    const T = B3.THREE;
    const g = new T.Group();
    const len = (MODEL_LEN[kind] || MODEL_LEN.capital) * spec.scale;
    const pivot = new T.Group();
    pivot.scale.setScalar(len / (data.length * HULL_SCALE));
    // File nose is +Z, the app's nose is -Z: turn 180 deg, plus the DM's offset.
    pivot.rotation.y = Math.PI + spec.yaw * Math.PI / 180;
    const inner = data.scene.clone(true);
    inner.position.set(-data.center.x, -data.center.y, -data.center.z);
    if (ghost) inner.traverse(c => {
        if (!c.isMesh || !c.material) return;
        c.material = (Array.isArray(c.material) ? c.material : [c.material]).map(m => {
            const gm = m.clone(); gm.transparent = true; gm.opacity = 0.45; gm.depthWrite = false; return gm;
        });
        if (c.material.length === 1) c.material = c.material[0];
        c.userData.ownMat = true;
    });
    pivot.add(inner);
    g.add(pivot);
    g.userData.isModel = true;
    if (kind !== 'station') {
        const glow = new T.Mesh(geo('glow'), mat('glow', '#9ff3ff', ghost ? 0.35 : 0.85));
        glow.position.set(0, 0, (len / 2) / HULL_SCALE);
        glow.userData.isGlow = true;
        g.add(glow);
        g.userData.glow = glow;
    }
    return g;
}
// Starts loading a model; re-syncs the scene when it lands.
function requestModel(spec) {
    if (!spec || B3.models[spec.ref]) return;
    B3.models[spec.ref] = 'loading';
    window.loadShipModel(spec.ref).then(data => {
        B3.models[spec.ref] = data;
        try { if (window.battle3dActive() && B3.renderer) syncScene(); } catch (e) {}
    }, () => { B3.models[spec.ref] = 'failed'; });
}
function hullFor(kind, color, ghost, spec) {
    const st = spec && B3.models[spec.ref];
    if (spec && !st) requestModel(spec);
    return (st && st !== 'loading' && buildModelHull(kind, spec, ghost)) || buildHull(kind, color, ghost);
}
function upsertToken(tok, v, enc, currentTurnId, selId) {
    const T = B3.THREE;
    const id = tok.token_id;
    const kind = shipKind(v);
    const color = factionColor(v);
    const ghost = !!(v && v.is_hidden && currentUserRole === 'dm');
    const spec = modelSpec(v);
    const st = spec && B3.models[spec.ref];
    const modelState = !spec ? '' : (st && st !== 'loading' && st !== 'failed') ? 'model' : 'hull';
    const sig = `${kind}|${color}|${ghost}|${specKey(spec)}|${modelState}`;
    let o = B3.objs[id];
    if (!o || o.sig !== sig) {
        const prev = o; // a model landing mid-glide keeps the glide going
        if (o) { B3.groups.tokens.remove(o.group); disposeTree(o.group); if (o.label) o.label.remove(); }
        const group = new T.Group();
        const hull = hullFor(kind, color, ghost, spec);
        hull.scale.setScalar(HULL_SCALE);
        const r = kind === 'craft' ? 11 : kind === 'station' ? 20 : 19;
        const disc = new T.Mesh(geo(`disc:${r}`), mat('flat', color, 0.13)); disc.position.y = 0.4;
        const rim = new T.Mesh(geo(`ring:${r - 1.6}:${r}`), mat('flat', color, 0.85)); rim.position.y = 0.5;
        const turn = new T.Mesh(geo(`ring:${r + 3}:${r + 5.5}`), mat('flat', '#ffd24a', 0.95)); turn.position.y = 0.6;
        const sel = new T.Mesh(geo(`ring:${r + 7}:${r + 8.5}`), mat('flat', '#ffffff', 0.9)); sel.position.y = 0.7;
        const nose = lineObj([new T.Vector3(0, 0.8, 0), new T.Vector3(0, 0.8, -(r + 10))], color, 0.8);
        const noseHolder = new T.Group(); noseHolder.add(nose);
        group.add(hull, disc, rim, turn, sel, noseHolder);
        [hull, disc, rim].forEach(obj => obj.traverse(c => { c.userData.tokenId = id; c.userData.vesselId = tok.ship_marker_id; }));
        const label = document.createElement('div');
        label.className = 'b3d-label';
        B3.el.querySelector('.b3d-labels').appendChild(label);
        const drop = new T.Line(geo('unitLine'), mat('line', color, 0.55));
        group.add(drop);
        o = { group, hull, disc, rim, turn, sel, noseHolder, drop, label, sig, spec, kind, ghost, cur: prev ? prev.cur : null, shown: prev ? prev.shown : null, anim: prev ? prev.anim : null };
        B3.objs[id] = o;
        B3.groups.tokens.add(group);
        if (o.shown) applyShown(o, o.shown);
    }
    const c = tokCenter(tok);
    const dragging = B3.drag && B3.drag.kind === 'ship' && B3.drag.tokenId === id && B3.drag.moved;
    const target = { x: c.x - BATTLE_GRID_W / 2, z: c.y - BATTLE_GRID_H / 2, y: window.battle3dAltitude(v, tok), rot: -((Number(tok.facing) || 0) * Math.PI / 180) };
    if (!o.cur) { o.cur = target; o.shown = Object.assign({}, target); }
    else if (!dragging && stateDiffers(o.cur, target)) startTween(o, target, color);
    if (!dragging && !o.anim) applyShown(o, o.cur);
    o.noseHolder.visible = !!(v && !v.is_strike_craft && !v.is_station && window.firingArcsOn && window.firingArcsOn());
    o.turn.visible = !!(currentTurnId && currentTurnId === id);
    o.sel.visible = !!(selId && v && selId === v.id) || groupSel().has(id);
    o.vesselId = tok.ship_marker_id;
    // Label: name + hull/shield bars
    const name = v ? v.name : '???';
    const hullPct = v && v.max_hull > 0 ? Math.max(0, Math.min(100, (v.integrity_hull || 0) / v.max_hull * 100)) : 0;
    const shPct = v && v.max_shields > 0 ? Math.max(0, Math.min(100, (v.integrity_shields || 0) / v.max_shields * 100)) : 0;
    const hullCol = hullPct > 66 ? '#00e5a3' : hullPct > 33 ? '#ffaa00' : '#ff4d4d';
    const html = `<div class="b3d-name" style="color:${esc(color)}">${o.turn.visible ? '▶ ' : ''}${esc(name)}</div>`
        + (v && !v.is_strike_craft ? `<div class="b3d-bar"><i style="width:${hullPct.toFixed(0)}%; background:${hullCol}"></i></div>`
        + (v.max_shields > 0 ? `<div class="b3d-bar b3d-bar-sh"><i style="width:${shPct.toFixed(0)}%"></i></div>` : '') : '');
    if (o.labelHtml !== html) { o.label.innerHTML = html; o.labelHtml = html; }
    o.label.classList.toggle('b3d-label-sel', o.sel.visible);
    o.label.classList.toggle('b3d-label-craft', kind === 'craft');
}
/* --- Movement tweens + trails (Phase 6b) --- */
function angDiff(a, b) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
function stateDiffers(a, b) { return Math.hypot(a.x - b.x, a.z - b.z) > 0.5 || Math.abs(a.y - b.y) > 0.1 || Math.abs(angDiff(a.rot, b.rot)) > 0.002; }
function applyShown(o, st) {
    o.shown = Object.assign({}, st);
    o.group.position.set(st.x, 0, st.z);
    o.hull.position.y = st.y;
    o.hull.rotation.y = st.rot;
    o.noseHolder.rotation.y = st.rot;
    o.drop.scale.y = Math.max(0.5, st.y);
}
function startTween(o, target, color) {
    const from = Object.assign({}, o.shown || o.cur);
    const dist = Math.hypot(target.x - from.x, target.z - from.z);
    o.cur = target;
    o.anim = { from, to: target, t0: nowMs(), dur: dist > 1 ? Math.min(900, 350 + dist * 2.5) : 320 };
    if (dist > 3) addTrail({ x: from.x, y: from.y, z: from.z }, { x: target.x, y: target.y, z: target.z }, color);
    requestRender();
}
function stepAnims(now) {
    let busy = false;
    Object.values(B3.objs).forEach(o => {
        const glow = o.hull.userData.glow;
        if (!o.anim) { if (glow) glow.scale.setScalar(1); return; }
        const k = Math.min(1, (now - o.anim.t0) / o.anim.dur);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // ease in-out
        const f = o.anim.from, t = o.anim.to;
        applyShown(o, { x: f.x + (t.x - f.x) * e, z: f.z + (t.z - f.z) * e, y: f.y + (t.y - f.y) * e, rot: f.rot + angDiff(f.rot, t.rot) * e });
        if (glow) glow.scale.setScalar(1 + 0.9 * Math.sin(Math.PI * k));
        if (k >= 1) { o.anim = null; applyShown(o, o.cur); B3.overlayDirty = true; } else busy = true;
    });
    return busy;
}
function addTrail(a, b, color) {
    const T = B3.THREE;
    const ya = a.y, yb = b.y;
    const pa = new T.Vector3(a.x, ya, a.z), pb = new T.Vector3(b.x, yb, b.z);
    const ribbon = rod(pa, pb, lowQ() ? 1.2 : 1.8, fxMat(color, 0.5));
    addFx(ribbon, lowQ() ? 1000 : 1800, (k, f) => { f.obj.material.opacity = 0.5 * (1 - k); }, null, 'trail');
}

function removeToken(id) {
    const o = B3.objs[id];
    if (!o) return;
    B3.groups.tokens.remove(o.group);
    disposeTree(o.group);
    if (o.label && o.label.parentNode) o.label.parentNode.removeChild(o.label);
    delete B3.objs[id];
}
function clearAll() { B3.tape = null; clearGroup(B3.groups.tape); Object.keys(B3.objs).forEach(removeToken); clearGroup(B3.groups.overlay); clearGroup(B3.groups.preview); B3.overlayLabels = []; }
function clearGroup(g) { if (!g) return; while (g.children.length) { const c = g.children[0]; g.remove(c); disposeTree(c); } }

/* --- Overlay: arcs, range rings, ordnance, lock lines --- */
function addAnchorLabel(pos3, html, cls) { B3.overlayLabels.push({ pos: pos3, html, cls }); }
function sectorMesh(c, r, from, to, color, opacity) {
    const T = B3.THREE;
    const pts = [V(c.x, c.y, 1)];
    let span = ((to - from) % 360 + 360) % 360; if (span === 0) span = 360;
    const steps = Math.max(6, Math.ceil(span / 5));
    for (let i = 0; i <= steps; i++) {
        const a = (from + span * i / steps) * Math.PI / 180;
        pts.push(V(c.x + r * Math.sin(a), c.y - r * Math.cos(a), 1));
    }
    const pos = [], idx = [];
    pts.forEach(p => pos.push(p.x, p.y, p.z));
    for (let i = 1; i < pts.length - 1; i++) idx.push(0, i, i + 1);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const m = new T.Mesh(g, mat('flat', color, opacity));
    m.userData.ownGeo = true;
    const grp = new T.Group();
    grp.add(m);
    grp.add(lineObj(span >= 360 ? pts.slice(1) : pts.concat([pts[0]]), color, 0.55));
    return grp;
}
function circleLine(c, r, color, opacity, dashed) {
    const pts = [];
    for (let i = 0; i <= 72; i++) { const a = i / 72 * Math.PI * 2; pts.push(V(c.x + r * Math.sin(a), c.y - r * Math.cos(a), 1.2)); }
    return lineObj(pts, color, opacity, dashed);
}
function rebuildOverlay(enc, visibleToks) {
    clearGroup(B3.groups.overlay);
    B3.overlayLabels = [];
    const T = B3.THREE;
    const ov = B3.groups.overlay;
    const byVessel = {};
    visibleToks.forEach(t => { byVessel[t.ship_marker_id] = t; });
    const selId = selectedVesselId();
    const selTok = selId && byVessel[selId];
    const selV = selTok && vesselById(selId);
    const tiers = window.BATTLE_RANGE_TIERS || { LONG: 400, MEDIUM: 200, SHORT: 100 };
    // Selected ship: arc wedges (firing arcs on) + faint range rings.
    // Hidden while that ship is still gliding; redrawn when it arrives.
    const selGliding = !!(selTok && B3.objs[selTok.token_id] && B3.objs[selTok.token_id].anim);
    if (selTok && selV && !selGliding) {
        const c = tokCenter(selTok);
        if (!selV.is_strike_craft && window.firingArcsOn && window.firingArcsOn() && window.ARC_PRESETS) {
            const byArc = {};
            (selV.ship_weapons || []).filter(w => w && !w.is_point_defense).forEach(w => {
                const arc = window.weaponArc(w, selV);
                const r = Math.max(60, Math.min(w.range || 160, 420));
                byArc[arc] = Math.max(byArc[arc] || 0, r);
            });
            const facing = Number(selTok.facing) || 0;
            Object.keys(byArc).forEach(arc => {
                const p = window.ARC_PRESETS[arc];
                if (!p) return;
                (p.windows || [[0, 360]]).forEach(([from, to]) => {
                    ov.add(sectorMesh(c, byArc[arc], from + facing, p.windows ? to + facing : from + facing + 360, '#00e1ff', p.windows ? 0.13 : 0.05));
                });
            });
        }
        [['SHORT', tiers.SHORT, 0.5], ['MEDIUM', tiers.MEDIUM, 0.35], ['LONG', tiers.LONG, 0.25]].forEach(([n, r, op]) => {
            ov.add(circleLine(c, r, '#8fd8e4', op, true));
            addAnchorLabel(V(c.x, c.y - r, 2), `${n} ${r}`, 'b3d-ring-label');
        });
    }
    // Rings toggled with the 2D measuring tool (shared state, js/grid-tools.js)
    const gt = window.__gridTools;
    if (gt && gt.rings) gt.rings.forEach(id => {
        const t = byVessel[id];
        if (!t || id === selId) return;
        const c = tokCenter(t);
        [tiers.SHORT, tiers.MEDIUM, tiers.LONG].forEach((r, i) => ov.add(circleLine(c, r, '#8fd8e4', 0.45 - i * 0.1, true)));
    });
    // Missiles / torpedoes in flight (everyone)
    (enc.in_flight_ordnance || []).forEach(s => {
        const tt = byVessel[s.target_vessel_id];
        if (!tt) return;
        const src = byVessel[s.source_vessel_id];
        const a = src ? tokCenter(src) : (typeof s.launch_x === 'number' ? { x: s.launch_x, y: s.launch_y } : null);
        if (!a) return;
        const b = tokCenter(tt);
        const ta = window.battle3dAltitude(vesselById(s.target_vessel_id), tt);
        const sa = src ? window.battle3dAltitude(vesselById(s.source_vessel_id), src) : 20;
        const mid = V((a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(sa, ta) + 40);
        const curve = new T.QuadraticBezierCurve3(V(a.x, a.y, sa), mid, V(b.x, b.y, ta));
        ov.add(lineObj(curve.getPoints(24), '#ff8a3d', 0.9, true));
        addAnchorLabel(mid, `⚠ ${esc(String(s.source_weapon_name || 'ORDNANCE').toUpperCase())} · IMPACT IN ${esc(s.turns_remaining)}`, 'b3d-ord-label');
    });
    // Target locks (tactical HUD) -- owner / DM only, same as the 2D lines
    const tv = window.__tv2;
    if (tv && tv.locks && typeof window.tv2Active === 'function' && window.tv2Active()) {
        Object.keys(tv.locks).forEach(vid => {
            const v = vesselById(vid), from = byVessel[vid];
            if (!from || !canControl(v)) return;
            const targets = new Set(Object.values(tv.locks[vid] || {}).filter(Boolean));
            targets.forEach(tid => {
                const to = byVessel[tid];
                if (!to) return;
                const a = tokCenter(from), b = tokCenter(to);
                ov.add(lineObj([V(a.x, a.y, window.battle3dAltitude(v, from)), V(b.x, b.y, window.battle3dAltitude(vesselById(tid), to))], '#00e1ff', 0.7, true));
            });
        });
    }
}

/* --- Sync (called on every Battle Map render while active) --- */
function syncScene() {
    const enc = window.globalBattleEncounterCache;
    if (!enc || !B3.renderer) return;
    if (enc.id !== B3.lastEncId) { clearAll(); B3.lastEncId = enc.id; B3.selectedLocal = null; syncMap(enc); resetCamera(); }
    resize();
    syncMap(enc);
    const currentTurnId = (enc.initiative_rolled && (enc.turn_order || []).length) ? enc.turn_order[enc.current_turn_index] : null;
    const selId = selectedVesselId();
    const seen = new Set();
    const visibleToks = [];
    (enc.tokens || []).forEach(tok => {
        const v = vesselById(tok.ship_marker_id);
        if (v && !visibleToMe(v)) return;
        seen.add(tok.token_id);
        visibleToks.push(tok);
        upsertToken(tok, v, enc, currentTurnId, selId);
    });
    Object.keys(B3.objs).forEach(id => { if (!seen.has(id)) removeToken(id); });
    rebuildOverlay(enc, visibleToks);
    try { ordnanceArrivals(enc); } catch (e) { console.error('3D view: ordnance effect failed', e); }
    drawTape();
    updateToolbar();
    const st = B3.el && B3.el.querySelector('.b3d-status');
    if (st) {
        st.style.display = window.battleMapArmedToken ? '' : 'none';
        if (window.battleMapArmedToken) st.textContent = 'Click the plane to place the ship · Esc / CANCEL in the palette to stop';
    }
    requestRender();
}
window.battle3dSync = syncScene;
function updateToolbar() {
    if (!B3.el) return;
    const selId = selectedVesselId();
    const tok = selId && encTokens().find(t => t.ship_marker_id === selId);
    const v = selId && vesselById(selId);
    const canTurn = !!(tok && typeof window.canTurnBattleToken === 'function' && window.canTurnBattleToken(tok).ok);
    const canAlt = !!(tok && v && canControl(v) && !v.is_station);
    const show = (act, on) => { const b = B3.el.querySelector(`[data-act="${act}"]`); if (b) b.style.display = on ? '' : 'none'; };
    show('turnL', canTurn); show('turnR', canTurn); show('altU', canAlt); show('altD', canAlt);
    const tapeBtn = B3.el.querySelector('[data-act="tape"]');
    if (tapeBtn) tapeBtn.classList.toggle('b3d-on', B3.tool === 'tape');
    const gt = window.__gridTools;
    show('tape', !gtOn3());
    show('share', !gtOn3() && B3.tool === 'tape');
    const shareBtn = B3.el.querySelector('[data-act="share"]');
    if (shareBtn) shareBtn.classList.toggle('b3d-on', !!(gt && gt.share));
    const qBtn = B3.el.querySelector('[data-act="quality"]');
    if (qBtn) qBtn.textContent = lowQ() ? '⚙ LOW' : '⚙ HIGH';
}
function onToolbar(e) {
    const btn = e.target.closest && e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'reset') return resetCamera();
    if (act === 'top') return topCamera();
    if (act === 'tape') { B3.tool = B3.tool === 'tape' ? null : 'tape'; if (!B3.tool) clearTape(); updateToolbar(); return; }
    if (act === 'share') { if (typeof window.toggleTapeShare === 'function') window.toggleTapeShare(); updateToolbar(); return; }
    if (act === 'quality') return window.setBattle3dQuality(lowQ() ? 'high' : 'low');
    const selId = selectedVesselId();
    const tok = selId && encTokens().find(t => t.ship_marker_id === selId);
    if (!tok) return;
    if (act === 'turnL') window.rotateBattleToken(tok.token_id, -15);
    if (act === 'turnR') window.rotateBattleToken(tok.token_id, 15);
    if (act === 'altU') window.nudgeBattleAltitude(tok.token_id, ALT_STEP);
    if (act === 'altD') window.nudgeBattleAltitude(tok.token_id, -ALT_STEP);
}

/* --- Rendering (on demand) --- */
const raf = (fn) => (window.requestAnimationFrame ? window.requestAnimationFrame(fn) : setTimeout(fn, 16));
function requestRender() {
    if (B3.pending || !B3.renderer) return;
    B3.pending = true;
    raf(() => { B3.pending = false; draw(); });
}
window.battle3dRequestRender = requestRender;
function projectToScreen(p) {
    const v = p.clone().project(B3.camera);
    return { x: (v.x + 1) / 2 * (B3._w || 0), y: (1 - v.y) / 2 * (B3._h || 0), behind: v.z > 1 };
}
function draw() {
    if (!B3.renderer || !B3.el || B3.el.style.display === 'none') return;
    applyCamera();
    const now = nowMs();
    const animating = stepAnims(now);
    if (B3.overlayDirty) {
        B3.overlayDirty = false;
        const enc = window.globalBattleEncounterCache;
        if (enc) rebuildOverlay(enc, (enc.tokens || []).filter(t => visibleToMe(vesselById(t.ship_marker_id))));
    }
    stepFx(now);
    B3.renderer.render(B3.scene, B3.camera);
    B3.frames++;
    // Labels follow their 3D anchors
    Object.values(B3.objs).forEach(o => {
        const p = o.group.position.clone(); p.y = o.hull.position.y + (o.sig.startsWith('craft') ? 14 : 22);
        const s = projectToScreen(p);
        o.label.style.display = s.behind ? 'none' : '';
        o.label.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
    });
    const host = B3.el.querySelector('.b3d-labels');
    host.querySelectorAll('.b3d-anchor').forEach(n => n.remove());
    (B3.terrainLabels || []).concat(B3.overlayLabels || [], B3.previewLabels || [], B3.tapeLabels || []).forEach(a => {
        const s = projectToScreen(a.pos);
        if (s.behind) return;
        const n = document.createElement('div');
        n.className = `b3d-anchor ${a.cls || ''}`;
        n.innerHTML = a.html;
        n.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
        host.appendChild(n);
    });
    if (B3.fx.length || animating) requestRender();
}

/* --- Effects (Phase 6b) ---
   Every effect is a short-lived object in the fx group, stepped by draw()
   while any is alive (render on demand otherwise). LOW quality draws fewer
   particles and skips the outer glows. */
function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
function addFx(obj, life, update, onEnd, kind, delay) {
    if (!B3.renderer) return null;
    const f = { obj, life, update, onEnd, kind: kind || 'fx', t0: nowMs() + (delay || 0) };
    if (delay) obj.visible = false;
    B3.groups.fx.add(obj);
    B3.fx.push(f);
    requestRender();
    return f;
}
function stepFx(now) {
    const ended = [];
    B3.fx = B3.fx.filter(f => {
        if (now < f.t0) return true;
        f.obj.visible = true;
        const k = (now - f.t0) / f.life;
        if (k >= 1) { ended.push(f); return false; }
        try { if (f.update) f.update(k, f); } catch (e) {}
        return true;
    });
    ended.forEach(f => {
        B3.groups.fx.remove(f.obj);
        disposeFx(f.obj);
        if (f.onEnd) { try { f.onEnd(); } catch (e) {} }
    });
}
function disposeFx(obj) {
    obj.traverse(o => {
        if (o.geometry && (o.userData.ownGeo || o.userData.fxGeo)) o.geometry.dispose();
        if (o.material && (o.userData.ownMat || o.userData.fxMat)) o.material.dispose();
    });
}
function fxMat(color, opacity, additive) {
    const T = B3.THREE;
    return new T.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: additive === false ? T.NormalBlending : T.AdditiveBlending, side: T.DoubleSide });
}
function fxMesh(geometry, material) { const m = new B3.THREE.Mesh(geometry, material); m.userData.fxGeo = true; m.userData.fxMat = true; return m; }
function altNear(gx, gy) {
    const t = tokenNear(gx, gy);
    return t ? window.battle3dAltitude(vesselById(t.ship_marker_id), t) : 30;
}
function tokenNear(gx, gy) {
    let best = null, bd = 30;
    encTokens().forEach(t => { const c = tokCenter(t); const d = Math.hypot(c.x - gx, c.y - gy); if (d < bd) { bd = d; best = t; } });
    return best;
}
function P3(g) { return V(g.x, g.y, altNear(g.x, g.y)); }
// A cylinder between two 3D points (beams, tracer bolts).
function rod(a, b, radius, material) {
    const T = B3.THREE;
    const len = a.distanceTo(b) || 0.01;
    const m = fxMesh(new T.CylinderGeometry(radius, radius, len, 6, 1, true), material);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    return m;
}
function flash(pos, r, color, life, grow, opacity, delay) {
    const T = B3.THREE;
    const m = fxMesh(new T.SphereGeometry(r, 14, 10), fxMat(color, opacity == null ? 0.9 : opacity));
    m.position.copy(pos);
    const op0 = m.material.opacity;
    addFx(m, life, (k) => { m.material.opacity = op0 * (1 - k); m.scale.setScalar(1 + k * (grow == null ? 1.5 : grow)); }, null, 'flash', delay);
    return m;
}
function sparks(pos, color, n, speed, life, delay) {
    const T = B3.THREE;
    const pts = new Float32Array(n * 3), vel = [];
    for (let i = 0; i < n; i++) {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), sp = speed * (0.5 + Math.random() * 0.7);
        vel.push([Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp * 0.6, Math.sin(ph) * Math.sin(th) * sp]);
        pts[i * 3] = pos.x; pts[i * 3 + 1] = pos.y; pts[i * 3 + 2] = pos.z;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pts, 3));
    const m = new T.Points(g, new T.PointsMaterial({ color, size: 6, transparent: true, opacity: 1, depthWrite: false, blending: T.AdditiveBlending }));
    m.userData.fxGeo = true; m.userData.fxMat = true;
    addFx(m, life, (k) => {
        const arr = g.attributes.position.array, t = k * life / 1000;
        for (let i = 0; i < n; i++) { arr[i * 3] = pos.x + vel[i][0] * t; arr[i * 3 + 1] = pos.y + vel[i][1] * t; arr[i * 3 + 2] = pos.z + vel[i][2] * t; }
        g.attributes.position.needsUpdate = true;
        m.material.opacity = 1 - k;
    }, null, 'sparks', delay);
    return m;
}
function planeRing(pos, r0, r1, color, life, delay) {
    const T = B3.THREE;
    const m = fxMesh(new T.RingGeometry(0.85, 1, 48), fxMat(color, 0.8));
    m.rotation.x = -Math.PI / 2;
    m.position.set(pos.x, Math.max(1, pos.y), pos.z);
    addFx(m, life, (k) => { m.scale.setScalar(r0 + (r1 - r0) * k); m.material.opacity = 0.8 * (1 - k); }, null, 'ring', delay);
    return m;
}
// Where a shot lands: shields up -> blue bubble; shields down -> hull sparks.
function impactAt(gpt, delay) {
    const pos = P3(gpt);
    const tok = tokenNear(gpt.x, gpt.y);
    const v = tok && vesselById(tok.ship_marker_id);
    const shieldsUp = !!(v && (v.integrity_shields || 0) > 0);
    const low = lowQ();
    if (shieldsUp) {
        const T = B3.THREE;
        const r = (v.is_strike_craft ? 14 : v.is_station ? 34 : 30);
        const bub = fxMesh(new T.SphereGeometry(r, low ? 16 : 28, low ? 12 : 20), fxMat('#4db8ff', 0.42));
        bub.position.copy(pos);
        addFx(bub, 600, (k) => { bub.material.opacity = 0.42 * (1 - k); bub.scale.setScalar(0.88 + 0.22 * k); }, null, 'shield', delay);
        if (!low) flash(pos, 6, '#cfeeff', 280, 2, 0.9, delay);
        return 'shield';
    }
    flash(pos, 9, '#ffb066', 380, 2.2, 0.95, delay);
    sparks(pos, '#ff9a3d', low ? 7 : 18, 90, 700, delay);
    return 'hull';
}
window.battle3dImpactAt = impactAt; // for tests
function fireFx(family, s, t, color) {
    if (!window.battle3dActive() || !B3.renderer) return;
    const a = P3(s), b = P3(t);
    const low = lowQ();
    if (family === 'pulse') {                                   // healing
        planeRing(b, 10, 55, '#5dff9d', 1000);
        flash(b, 12, '#5dff9d', 800, 1.2, 0.5);
        if (!low) sparks(b, '#9dffbf', 10, 25, 900);
        return;
    }
    if (family === 'tracer') {                                  // kinetic: bolts that travel
        const n = low ? 2 : 4, flight = 300, gap = 80;
        const dir = b.clone().sub(a), len = dir.length() || 1;
        for (let i = 0; i < n; i++) {
            const bolt = rod(new B3.THREE.Vector3(0, 0, 0), dir.clone().normalize().multiplyScalar(Math.min(22, len * 0.3)), 1.7, fxMat(color, 1));
            const off = bolt.position.clone();
            addFx(bolt, flight, (k) => { bolt.position.copy(a).addScaledVector(dir, k).add(off); bolt.material.opacity = 1; }, i === n - 1 ? () => impactAt(t) : null, 'tracer', i * gap);
        }
        return;
    }
    if (family === 'burst') {                                   // explosive: a shell, then a cloud
        const shell = fxMesh(new B3.THREE.SphereGeometry(4.5, 10, 8), fxMat(color, 1));
        shell.position.copy(a);
        addFx(shell, 330, (k) => { shell.position.copy(a).lerp(b, k); }, () => {
            flash(b, 16, color, 700, 2.4, 0.7);
            sparks(b, color, low ? 10 : 26, 70, 850);
            impactAt(t);
        }, 'shell');
        return;
    }
    // beam (default): an instant glowing line that fades
    const core = rod(a, b, 1.6, fxMat('#ffffff', 0.95));
    addFx(core, 520, (k) => { core.material.opacity = 0.95 * (1 - k); }, null, 'beam');
    const glowRod = rod(a, b, low ? 3 : 5, fxMat(color, 0.5));
    addFx(glowRod, 650, (k) => { glowRod.material.opacity = 0.5 * (1 - k); }, null, 'beamglow');
    if (!low) flash(a, 6, color, 300, 1.5, 0.8);
    impactAt(t);
}
window.battle3dFireFx = fireFx; // for tests
function destructionFx(c) {
    if (!window.battle3dActive() || !B3.renderer) return;
    const pos = V(c.x, c.y, altNear(c.x, c.y));
    const low = lowQ();
    flash(pos, 16, '#ffffff', 350, 2, 1);
    flash(pos, 26, '#ff9a3d', 1100, 3, 0.85);
    if (!low) flash(pos, 20, '#ff4d1a', 1400, 4, 0.5, 120);
    planeRing(pos, 14, 170, '#ffb066', 1300);
    sparks(pos, '#ffb066', low ? 16 : 44, 130, 1500);
    if (!low) sparks(pos, '#ffffff', 14, 190, 800);
}
window.battle3dDestructionFx = destructionFx; // for tests
/* Phase 11: missiles / torpedoes arriving (DM 2026-10-03: hit = blast on the
   target, miss = small puff). Ordnance never rolls to hit: a payload that
   leaves in_flight_ordnance either IMPACTED, was SHOT DOWN (point defense /
   squadron intercept) or FIZZLED (target left the grid). The round-advance
   code saves which, per payload, in battle_encounters.ordnance_outcomes in
   the same update, so every client sees the same thing. A payload that
   vanished because it split into six (its children carry parent_salvo_id)
   plays nothing; one with no saved outcome (an undo, an older client)
   counts as a hit, like the 2D flash. */
function ordnanceArrivals(enc) {
    const list = enc.in_flight_ordnance || [];
    if (B3.ordEnc !== enc.id) { B3.ordEnc = enc.id; B3.ordPrev = null; }
    const toks = encTokens();
    const center = (vid) => { const t = toks.find(x => x.ship_marker_id === vid); return t ? tokCenter(t) : null; };
    const prev = B3.ordPrev;
    const now = new Map();
    list.forEach(s => {
        const b = center(s.target_vessel_id);
        const a = center(s.source_vessel_id) || (typeof s.launch_x === 'number' ? { x: s.launch_x, y: s.launch_y } : null);
        now.set(s.salvo_id, { a, b, dmg: s.damage_type, parent: s.parent_salvo_id || null });
    });
    B3.ordPrev = now;
    if (!prev) return [];                       // first look at this battle: nothing "arrived"
    const parents = new Set(list.map(s => s.parent_salvo_id).filter(Boolean));
    const outcomes = enc.ordnance_outcomes || {};
    const played = [];
    prev.forEach((p, id) => {
        if (now.has(id) || parents.has(id) || !p.b) return;
        const o = (outcomes[id] && outcomes[id].o) || 'hit';
        played.push({ id, o: ordnanceFx(o, p) });
    });
    return played;
}
window.battle3dOrdnanceArrivals = ordnanceArrivals; // for tests
function ordnanceFx(o, p) {
    if (!window.battle3dActive() || !B3.renderer) return o;
    const low = lowQ();
    const dmgType = typeof window.normalizeDamageType === 'function' ? window.normalizeDamageType(p.dmg || 'Impact') : 'Impact';
    const color = (window.DAMAGE_TYPES && window.DAMAGE_TYPES[dmgType] && window.DAMAGE_TYPES[dmgType].color) || '#ff8a3d';
    if (o === 'hit') {
        const pos = V(p.b.x, p.b.y, altNear(p.b.x, p.b.y));
        flash(pos, 14, '#ffffff', 260, 1.8, 1);
        flash(pos, 22, color, 900, 2.8, 0.8);
        planeRing(pos, 10, 90, color, 900);
        sparks(pos, color, low ? 12 : 30, 110, 1000);
        impactAt(p.b, 80);
        return 'hit';
    }
    // shot down: a puff short of the target; fizzled: where the target was
    const a = p.a || p.b;
    const k = o === 'intercept' ? 0.82 : 1;
    const pt = { x: a.x + (p.b.x - a.x) * k, y: a.y + (p.b.y - a.y) * k };
    const pos = V(pt.x, pt.y, altNear(pt.x, pt.y) + 10);
    flash(pos, 7, '#c9d6db', 520, 1.8, 0.55);
    if (!low) sparks(pos, '#9fb4bc', 8, 40, 600);
    return o;
}
(function hookEffects() {
    const dom = window.DomBattleRenderer;
    if (dom && !dom.__b3dHooked) {
        const origFire = dom.fireEffect;
        dom.fireEffect = function (sx, sy, tx, ty, color, family) {
            const r = origFire.apply(this, arguments);
            try { fireFx(family || 'beam', { x: sx, y: sy }, { x: tx, y: ty }, color || '#ff3333'); } catch (e) { console.error('3D view: effect failed', e); }
            return r;
        };
        dom.__b3dHooked = true;
    }
    if (typeof window.spawnDestructionEffect === 'function' && !window.spawnDestructionEffect.__b3d) {
        const origBoom = window.spawnDestructionEffect;
        const wrapped = function (grid, x, y) {
            const r = origBoom.apply(this, arguments);
            try { destructionFx({ x: x + BATTLE_TOKEN_SIZE / 2, y: y + BATTLE_TOKEN_SIZE / 2 }); } catch (e) {}
            return r;
        };
        wrapped.__b3d = true;
        window.spawnDestructionEffect = wrapped;
    }
})();

/* --- Measuring tape (Phase 6b) --- same range bands as the 2D tape; shares
   through the same broadcast, and shows tapes shared from the 2D view. */
function tapeObjects(a, b, color, labelHtml, cls) {
    const T = B3.THREE;
    const g = new T.Group();
    const pa = V(a.x, a.y, 2), pb = V(b.x, b.y, 2);
    g.add(lineObj([pa, pb], color, 0.95));
    g.add(circleLine(a, 4, color, 0.9));
    g.add(circleLine(b, 4, color, 0.9));
    return { g, label: { pos: pa.clone().add(pb).multiplyScalar(0.5).setY(6), html: labelHtml, cls } };
}
function drawTape() {
    clearGroup(B3.groups.tape);
    B3.tapeLabels = [];
    if (B3.tape) {
        const t = tapeObjects(B3.tape.a, B3.tape.b, '#ffe066', esc(window.tapeLabel ? window.tapeLabel(B3.tape.a, B3.tape.b) : ''), 'b3d-tape-label');
        B3.groups.tape.add(t.g); B3.tapeLabels.push(t.label);
    }
    const gt = window.__gridTools;
    const now = Date.now();
    ((gt && gt.remoteTapes) || []).filter(r => r.until > now).forEach(r => {
        const t = tapeObjects(r.a, r.b, '#c9a6ff', `${esc(r.who || '')} · ${esc(window.tapeLabel ? window.tapeLabel(r.a, r.b) : '')}`, 'b3d-tape-label b3d-tape-remote');
        B3.groups.tape.add(t.g); B3.tapeLabels.push(t.label);
    });
    requestRender();
}
function clearTape() { B3.tape = null; drawTape(); }
function shareTape3d() {
    const gt = window.__gridTools;
    if (!gt || !gt.share || !B3.tape || typeof window.sendBattleBroadcast !== 'function') return;
    const profs = (typeof allProfiles !== 'undefined' && Array.isArray(allProfiles)) ? allProfiles : [];
    const me = profs.find(p => p.id === currentUserId);
    const who = currentUserRole === 'dm' ? 'DM' : ((me && me.username) || 'player');
    window.sendBattleBroadcast('fx', { k: 'tape', a: B3.tape.a, b: B3.tape.b, who });
}
// Grid-tool state lives in js/grid-tools.js; refresh the 3D view whenever
// the tool or the selection changes there (buttons, Esc, taps).
(function hookGridTools() {
    ['setGridTool', 'clearGridTools', 'toggleBattleTokenSelected', 'selectBattleTokensInBox', 'clearBattleSelection', 'toggleTapeShare'].forEach(name => {
        const orig = window[name];
        if (typeof orig !== 'function' || orig.__b3d) return;
        const wrapped = function () {
            const r = orig.apply(this, arguments);
            try {
                if (window.battle3dActive() && B3.renderer) {
                    if (tool3d() !== 'tape' && B3.tape) clearTape();
                    syncScene();
                }
            } catch (e) {}
            return r;
        };
        wrapped.__b3d = true;
        window[name] = wrapped;
    });
})();
(function hookRemoteTape() {
    const orig = window.showRemoteTape;
    if (typeof orig !== 'function' || orig.__b3d) return;
    const wrapped = function () {
        const r = orig.apply(this, arguments);
        try { if (window.battle3dActive() && B3.renderer) { drawTape(); setTimeout(drawTape, 6100); } } catch (e) {}
        return r;
    };
    wrapped.__b3d = true;
    window.showRemoteTape = wrapped;
})();

/* --- Picking --- */
function rayAt(clientX, clientY) {
    const T = B3.THREE;
    const rect = B3.renderer.domElement.getBoundingClientRect ? B3.renderer.domElement.getBoundingClientRect() : { left: 0, top: 0, width: B3._w, height: B3._h };
    const w = rect.width || B3._w || 1, h = rect.height || B3._h || 1;
    const ndc = new T.Vector2(((clientX - rect.left) / w) * 2 - 1, -((clientY - rect.top) / h) * 2 + 1);
    applyCamera();
    B3.scene.updateMatrixWorld(); // positions may have changed since the last frame
    const rc = new T.Raycaster();
    rc.setFromCamera(ndc, B3.camera);
    return rc;
}
function planeHit(clientX, clientY) {
    const T = B3.THREE;
    const rc = rayAt(clientX, clientY);
    const out = new T.Vector3();
    const hit = rc.ray.intersectPlane(new T.Plane(new T.Vector3(0, 1, 0), 0), out);
    return hit ? toGrid(out) : null;
}
window.battle3dScreenToWorld = function (clientX, clientY) { return B3.renderer ? planeHit(clientX, clientY) : null; };
window.battle3dPickToken = function (clientX, clientY) {
    if (!B3.renderer) return null;
    const rc = rayAt(clientX, clientY);
    const targets = [];
    Object.values(B3.objs).forEach(o => { targets.push(o.hull, o.disc); });
    const hits = rc.intersectObjects(targets, true);
    const h = hits.find(x => x.object.userData && x.object.userData.tokenId);
    return h ? { tokenId: h.object.userData.tokenId, vesselId: h.object.userData.vesselId } : null;
};
// Where the projected screen point of a token's centre is (used by tests / tooltips).
window.battle3dTokenScreenPos = function (tokenId) {
    const o = B3.objs[tokenId];
    if (!o || !B3.renderer) return null;
    applyCamera();
    const rect = B3.renderer.domElement.getBoundingClientRect ? B3.renderer.domElement.getBoundingClientRect() : { left: 0, top: 0 };
    const p = o.group.position.clone(); p.y = o.hull.position.y;
    const s = projectToScreen(p);
    return { x: rect.left + s.x, y: rect.top + s.y };
};

/* --- Input: orbit / pan / zoom / select / move / place --- */
function wireInput(el) {
    const host = el.querySelector('.b3d-canvas-host');
    host.addEventListener('contextmenu', e => e.preventDefault());
    host.addEventListener('wheel', e => {
        if (!B3.renderer) return;
        e.preventDefault();
        B3.cam.dist = Math.max(220, Math.min(2600, B3.cam.dist * Math.exp((e.deltaY || 0) * 0.0012)));
        requestRender();
    }, { passive: false });
    host.addEventListener('pointerdown', e => onDown(e));
    window.addEventListener('pointermove', e => onMove(e));
    window.addEventListener('pointerup', e => onUp(e));
    window.addEventListener('pointercancel', e => { delete B3.pointers[e.pointerId]; cancelDrag(); });
}
window.battle3dPointer = { down: (e) => onDown(e), move: (e) => onMove(e), up: (e) => onUp(e) }; // for tests
function ptrList() { return Object.values(B3.pointers); }
function onDown(e) {
    if (!B3.renderer || !window.battle3dActive()) return;
    B3.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (e.target && e.target.setPointerCapture && e.pointerId !== undefined) { try { e.target.setPointerCapture(e.pointerId); } catch (err) {} }
    const ps = ptrList();
    if (ps.length === 2) {
        cancelDrag();
        const [a, b] = ps;
        B3.drag = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, dist0: B3.cam.dist, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx0: B3.cam.tx, tz0: B3.cam.tz };
        return;
    }
    if (ps.length > 2) return;
    const base = { sx: e.clientX, sy: e.clientY, moved: false, button: e.button || 0 };
    const tool = tool3d();
    if (tool === 'tape' && base.button === 0 && !e.shiftKey) {
        const pk = window.battle3dPickToken(e.clientX, e.clientY);
        const tk = pk && encTokens().find(t => t.token_id === pk.tokenId);
        const a = tk ? tokCenter(tk) : planeHit(e.clientX, e.clientY);
        B3.drag = Object.assign(base, { kind: 'tape', a, vesselId: pk ? pk.vesselId : null });
        return;
    }
    const pick = (base.button === 0 && !e.shiftKey) ? window.battle3dPickToken(e.clientX, e.clientY) : null;
    const sel = groupSel();
    // SELECT: tap a ship to add/remove it, drag empty space for a box;
    // dragging a selected ship (any tool) moves the whole group.
    if (pick && sel.has(pick.tokenId) && sel.size > 1) {
        B3.drag = Object.assign(base, { kind: 'group', tokenId: pick.tokenId, a: planeHit(e.clientX, e.clientY), selTap: tool === 'select' });
        return;
    }
    if (tool === 'select' && base.button === 0 && !e.shiftKey) {
        if (pick) B3.drag = Object.assign(base, { kind: 'selTap', tokenId: pick.tokenId });
        else B3.drag = Object.assign(base, { kind: 'box', a: planeHit(e.clientX, e.clientY) });
        return;
    }
    if (pick) {
        const tok = encTokens().find(t => t.token_id === pick.tokenId);
        const rule = window.battleMoveRule(pick.tokenId, pick.vesselId);
        const v = vesselById(pick.vesselId);
        const size = tokSize(v);
        const c = tok ? tokCenter(tok) : { x: 0, y: 0 };
        const hit = planeHit(e.clientX, e.clientY) || c;
        B3.drag = Object.assign(base, { kind: 'ship', tokenId: pick.tokenId, vesselId: pick.vesselId, rule, size, grab: { x: c.x - hit.x, y: c.y - hit.y } });
    } else if (base.button === 2 || base.button === 1 || e.shiftKey) {
        B3.drag = Object.assign(base, { kind: 'pan', tx0: B3.cam.tx, tz0: B3.cam.tz });
    } else {
        B3.drag = Object.assign(base, { kind: window.battleMapArmedToken ? 'place' : 'orbit', yaw0: B3.cam.yaw, pitch0: B3.cam.pitch });
    }
}
function panBy(dx, dy, tx0, tz0) {
    const c = B3.cam, y = c.yaw * Math.PI / 180, p = Math.max(0.25, Math.sin(c.pitch * Math.PI / 180));
    const s = c.dist * 2 * Math.tan(22.5 * Math.PI / 180) / (B3._h || 600);
    const rx = Math.cos(y), rz = -Math.sin(y);      // screen right on the plane
    const fx = -Math.sin(y), fz = -Math.cos(y);     // screen up on the plane
    c.tx = Math.max(-BATTLE_GRID_W, Math.min(BATTLE_GRID_W, tx0 - rx * dx * s + fx * dy * s / p));
    c.tz = Math.max(-BATTLE_GRID_H, Math.min(BATTLE_GRID_H, tz0 - rz * dx * s + fz * dy * s / p));
}
function onMove(e) {
    if (!B3.drag) return;
    if (B3.pointers[e.pointerId]) B3.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    const d = B3.drag;
    if (d.kind === 'pinch') {
        const ps = ptrList(); if (ps.length < 2) return;
        const [a, b] = ps;
        const dd = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        B3.cam.dist = Math.max(220, Math.min(2600, d.dist0 * d.d0 / dd));
        panBy((a.x + b.x) / 2 - d.mx, (a.y + b.y) / 2 - d.my, d.tx0, d.tz0);
        requestRender();
        return;
    }
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) d.moved = true;
    if (!d.moved) return;
    if (d.kind === 'orbit') {
        B3.cam.yaw = d.yaw0 - dx * 0.35;
        B3.cam.pitch = Math.max(12, Math.min(89.5, d.pitch0 + dy * 0.3));
        requestRender();
    } else if (d.kind === 'pan') {
        panBy(dx, dy, d.tx0, d.tz0);
        requestRender();
    } else if (d.kind === 'box' && d.a) {
        const hit = planeHit(e.clientX, e.clientY);
        if (!hit) return;
        d.b = hit;
        showBoxPreview(d.a, d.b);
    } else if (d.kind === 'group' && d.a) {
        const hit = planeHit(e.clientX, e.clientY);
        if (!hit) return;
        d.dx = hit.x - d.a.x; d.dy = hit.y - d.a.y;
        showGroupPreview(d.dx, d.dy);
    } else if (d.kind === 'tape' && d.a) {
        const hit = planeHit(e.clientX, e.clientY);
        if (!hit) return;
        B3.tape = { a: d.a, b: hit };
        drawTape();
    } else if (d.kind === 'ship' && d.rule.mode !== 'tap') {
        const hit = planeHit(e.clientX, e.clientY);
        if (!hit) return;
        const cx = hit.x + d.grab.x, cy = hit.y + d.grab.y;
        d.pos = window.battleConstrainMove(d.rule, cx - d.size / 2, cy - d.size / 2);
        showMovePreview(d);
    }
}
function showMovePreview(d) {
    const o = B3.objs[d.tokenId];
    clearGroup(B3.groups.preview);
    B3.previewLabels = [];
    if (!o || !d.pos) return;
    const c = { x: d.pos.x + d.size / 2, y: d.pos.y + d.size / 2 };
    const s = { x: d.rule.x0 + d.size / 2, y: d.rule.y0 + d.size / 2 };
    // Move order: a see-through ghost marks the destination; the real ship
    // stays put and glides there once the move is saved (DM request 2026-10-03).
    const [kind, color] = o.sig.split('|');
    const ghost = hullFor(kind, color, true, o.spec);
    ghost.scale.setScalar(HULL_SCALE);
    ghost.position.copy(V(c.x, c.y, o.cur ? o.cur.y : 30));
    ghost.rotation.y = o.cur ? o.cur.rot : 0;
    B3.groups.preview.add(ghost);
    const ring = new B3.THREE.Mesh(geo(`ring:${kind === 'craft' ? 9 : 17}:${kind === 'craft' ? 11 : 19}`), mat('flat', color, 0.5));
    ring.position.copy(V(c.x, c.y, 0.6));
    B3.groups.preview.add(ring);
    B3.groups.preview.add(lineObj([V(s.x, s.y, 1.5), V(c.x, c.y, 1.5)], '#ffffff', 0.8, true));
    // Phase 10: with terrain rules on, the label shows the move's COST (asteroids count extra).
    const dist = typeof window.battleMoveCost === 'function' ? window.battleMoveCost(d.rule, d.pos) : Math.hypot(d.pos.x - d.rule.x0, d.pos.y - d.rule.y0);
    const cap = d.rule.mode === 'capped' ? ` / ${Math.round(d.rule.maxReach)}` : '';
    B3.previewLabels.push({ pos: V((s.x + c.x) / 2, (s.y + c.y) / 2, 4), html: `${Math.round(dist)}${cap} px`, cls: 'b3d-move-label' });
    requestRender();
}
function showBoxPreview(a, b) {
    clearGroup(B3.groups.preview);
    B3.previewLabels = [];
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    B3.groups.preview.add(lineObj([V(x0, y0, 1.5), V(x1, y0, 1.5), V(x1, y1, 1.5), V(x0, y1, 1.5), V(x0, y0, 1.5)], '#ffd700', 0.9, true));
    requestRender();
}
// Where each selected ship would end up (same plan the group move uses:
// the whole group stops when the first ship runs out of movement).
function showGroupPreview(dx, dy) {
    clearGroup(B3.groups.preview);
    B3.previewLabels = [];
    const plan = typeof window.planGroupMove === 'function' ? window.planGroupMove(dx, dy) : null;
    if (!plan) return;
    Object.keys(plan.moves).forEach(id => {
        const tok = encTokens().find(t => t.token_id === id); if (!tok) return;
        const v = vesselById(tok.ship_marker_id);
        const size = tokSize(v), from = tokCenter(tok), to = { x: plan.moves[id].pos.x + size / 2, y: plan.moves[id].pos.y + size / 2 };
        B3.groups.preview.add(lineObj([V(from.x, from.y, 1.5), V(to.x, to.y, 1.5)], '#ffd700', 0.8, true));
        B3.groups.preview.add(circleLine(to, size / 2 + 3, '#ffd700', 0.9));
    });
    if (plan.blocked.length) {
        const tok = encTokens().find(t => groupSel().has(t.token_id));
        if (tok) { const c = tokCenter(tok); B3.previewLabels.push({ pos: V(c.x, c.y, 8), html: esc('Stays put: ' + plan.blocked.join('; ')), cls: 'b3d-move-label' }); }
    }
    requestRender();
}
function cancelDrag() {
    const d = B3.drag;
    B3.drag = null;
    clearGroup(B3.groups.preview);
    B3.previewLabels = [];
    if (d && d.kind === 'ship') syncScene();
}
function onUp(e) {
    delete B3.pointers[e.pointerId];
    const d = B3.drag;
    if (!d) return;
    if (d.kind === 'pinch') { if (ptrList().length < 2) B3.drag = null; return; }
    B3.drag = null;
    clearGroup(B3.groups.preview);
    B3.previewLabels = [];
    if (d.kind === 'ship') {
        if (!d.moved) {
            B3.selectedLocal = d.vesselId;
            window.battleTokenTapped(d.vesselId);
            syncScene();
            return;
        }
        if (d.rule.mode === 'tap') {
            if (d.rule.blockReason) alert(d.rule.blockReason);
            syncScene();
            return;
        }
        if (d.pos) window.battleCommitMove(d.rule, d.pos); // the ship then glides there (startTween on the next sync)
        else syncScene();
        return;
    }
    if (d.kind === 'tape') {
        if (!d.moved) {
            clearTape();
            // Same as 2D MEASURE: tapping a ship toggles its range rings.
            if (d.vesselId && typeof window.toggleRangeRings === 'function') { window.toggleRangeRings(d.vesselId); syncScene(); }
        } else shareTape3d();
        return;
    }
    if (d.kind === 'selTap') { if (!d.moved) window.toggleBattleTokenSelected(d.tokenId); return; }
    if (d.kind === 'box') {
        if (d.moved && d.a && d.b) window.selectBattleTokensInBox(d.a.x, d.a.y, d.b.x, d.b.y);
        else window.clearBattleSelection();
        return;
    }
    if (d.kind === 'group') {
        if (!d.moved) { if (d.selTap) window.toggleBattleTokenSelected(d.tokenId); return; }
        if (Math.hypot(d.dx || 0, d.dy || 0) > 5) window.groupMoveSelected(d.dx, d.dy);
        else syncScene();
        return;
    }
    if (d.kind === 'place' && !d.moved) {
        const hit = planeHit(e.clientX, e.clientY);
        if (hit && hit.x >= 0 && hit.y >= 0 && hit.x <= BATTLE_GRID_W && hit.y <= BATTLE_GRID_H) window.placeArmedTokenAt(hit);
        return;
    }
    if (d.kind === 'orbit' && !d.moved && groupSel().size && typeof window.clearBattleSelection === 'function') window.clearBattleSelection(); // plain tap on empty space, like 2D
    if (d.kind === 'orbit' && !d.moved && B3.selectedLocal) { B3.selectedLocal = null; syncScene(); }
    requestRender();
}

/* --- Show / hide with the Battle Map --- */
function syncView() {
    ensureHeaderButton();
    const wrap = document.getElementById('battle-map-grid-wrap');
    if (!window.battle3dActive()) {
        if (B3.el) B3.el.style.display = 'none';
        if (wrap) wrap.style.display = '';
        if (B3.drag) B3.drag = null;
        B3.ordPrev = null; // don't replay what landed while the 3D view was off
        return;
    }
    if (!ensureEls()) return;
    B3.el.style.display = '';
    if (wrap) wrap.style.display = 'none';
    if (!B3.hintShown) { B3.hintShown = true; setTimeout(() => { const h = B3.el && B3.el.querySelector('.b3d-hint'); if (h) h.classList.add('b3d-hint-fade'); }, 9000); }
    if (!B3.THREE) {
        const st = B3.el.querySelector('.b3d-status');
        if (st) { st.style.display = ''; st.textContent = 'Loading 3D view…'; }
        loadThree().then(() => {
            if (!B3.renderer) initScene();
            syncScene();
        }).catch(() => {
            if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel(); // falls back to the 2D grid
        });
        return;
    }
    if (!B3.renderer) {
        try { initScene(); }
        catch (err) {
            console.error('3D view: WebGL start-up failed -- falling back to the 2D grid', err);
            B3.failed = true;
            syncView();
            return;
        }
    }
    syncScene();
}
window.battle3dSyncView = syncView;
// Phone + 3D: the tactical HUD's bottom sheet starts as a slim bar (name,
// tags, buttons). Tapping the name toggles it; WEAPONS ▸ still opens fully.
function narrowScreen() { try { return window.matchMedia('(max-width: 768px)').matches; } catch (e) { return false; } }
function applyMiniSheet() {
    const box = document.getElementById('tv2-hud');
    if (!box) return;
    const on = narrowScreen() && window.battle3dActive();
    box.classList.toggle('b3d-mini', on && B3.sheetMini);
    box.classList.toggle('b3d-mini-able', on);
    if (!box.__b3dMini) {
        box.__b3dMini = true;
        box.addEventListener('click', e => {
            if (!box.classList.contains('b3d-mini-able') || box.classList.contains('tv2-open')) return;
            if (!(e.target.closest && e.target.closest('.tv2-hero'))) return;
            B3.sheetMini = !B3.sheetMini;
            applyMiniSheet();
        });
    }
}
window.battle3dApplyMiniSheet = applyMiniSheet;
(function hookRender() {
    const orig = window.renderBattleMapPanel;
    if (typeof orig !== 'function' || orig.__b3dHooked) return;
    const hooked = function (...args) {
        const r = orig.apply(this, args);
        try { syncView(); applyMiniSheet(); } catch (err) { console.error('3D view: render failed', err); }
        return r;
    };
    hooked.__b3dHooked = true;
    hooked.__tv2Hooked = orig.__tv2Hooked;
    window.renderBattleMapPanel = hooked;
})();
(function hookSelect() {
    const orig = window.tv2Select;
    if (typeof orig !== 'function' || orig.__b3d) return;
    const wrapped = function () {
        const r = orig.apply(this, arguments);
        try { if (window.battle3dActive() && B3.renderer) syncScene(); } catch (e) {}
        return r;
    };
    wrapped.__b3d = true;
    window.tv2Select = wrapped;
})();
try {
    document.addEventListener('darkforest:features-changed', () => { if (window.globalBattleEncounterCache) { try { syncView(); } catch (e) {} } });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || !window.battle3dActive()) return;
        if (B3.drag) cancelDrag();
        else if (B3.tape) clearTape();
    });
} catch (e) {}
})();
