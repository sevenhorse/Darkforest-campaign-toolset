/* ==========================================================================
   js/bridge-walk.js - First-person 3D bridge (2026-10-18)
   ==========================================================================
   DM decisions (2026-10-17/18):
   - The bridge is the DM's own Space Engineers build, exported through
     Blender with named markers (empties). Names are case-insensitive:
       SPAWN_player, HOLOTABLE, STATION_<role>, CHAIR_<n>, SEAT_<n>, NPC_<n>,
       LIFT_<id>_A / _B, DOOR_<n>, HOLOSCREEN_<n> (objects that glow).
     A marker "faces" along its local -Y in Blender (= +Z here).
   - Walkable floor is generated offline (dev/tools/bridge-nav.mjs) as a grid
     of 0.25 m cells with heights; hidden geometry is trimmed offline
     (dev/tools/cull). The .glb is split into parts (<= 20 MB) because the
     free Supabase tier caps single files at 50 MB.
   - Files live in the PRIVATE bucket 'bridge-models' (logged-in read, DM
     write). The DM uploads them from the bridge's own setup screen; the
     manifest is app_settings 'bridge_model_config'.value (JSON).
   - PC only: phones never get the 3D bridge. Behind switch 'bridge_3d', and
     every person also turns it on for themselves (per browser) with the
     "3D BRIDGE" toggle in the bottom bar. Off by default (~60 MB download,
     cached in the browser after the first time).
   - Stations open the panels that already exist (no rebuilt UIs): helm =
     galaxy map + jump plotter on the bridge's ship, sensors = galaxy map +
     DRADIS sweep, comms = comms panel, quartermaster = cargo terminal.
     The pit table is HOLOTABLE and tactical: galaxy map normally, Battle
     Map while a battle is running. It shows that map live, and clicking it
     leans you over, then hands over to the full map with a "Back to bridge"
     button.
   - Not in this version (planned next): other players as avatars, NPC
     figures, lifts, doors, a playable 3D table.
   ========================================================================== */
(function () {
'use strict';
const BUCKET = 'bridge-models';
const CONFIG_KEY = 'bridge_model_config';
const USER_KEY = 'darkforest_bridge3d';
const CACHE_NAME = 'darkforest-bridge';
const EYE = 1.62, SEAT_EYE = 1.2, WALK = 3.2, STEP = 0.45;

const BW = {
    THREE: null, open: false, away: false, el: null, renderer: null, scene: null, camera: null,
    loaded: null, loading: null, model: null, nav: null, markers: [], zones: [],
    pos: null, yaw: 0, pitch: 0, path: null, onArrive: null, seated: null, tween: null,
    keys: {}, holo: null, holoTex: null, lastHoloDraw: 0, raf: 0, lastT: 0,
    test: null   // test hooks: { importer, fetchPart, config }
};
window.__bridge = BW;

/* ---------- small helpers ---------- */
const esc = (s) => (window.escapeHtml ? window.escapeHtml(s == null ? '' : String(s)) : String(s == null ? '' : s));
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
function isPhone() {
    try { return window.matchMedia('(max-width: 900px)').matches || (window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches); } catch (e) { return false; }
}
let webgl = null;
function hasWebGL() {
    if (webgl !== null) return webgl;
    try { const c = document.createElement('canvas'); webgl = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { webgl = false; }
    return webgl;
}
function featureOn() { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('bridge_3d'); }
window.bridgeConfig = function () {
    if (BW.test && BW.test.config) return BW.test.config;
    const row = window.appSettingsCache && window.appSettingsCache[CONFIG_KEY];
    if (!row || !row.value) return null;
    try { const c = JSON.parse(row.value); return c && Array.isArray(c.parts) && c.parts.length && c.nav ? c : null; } catch (e) { return null; }
};
window.bridgeUserOn = function () { try { return localStorage.getItem(USER_KEY) === 'on'; } catch (e) { return false; } };
window.setBridgeUserOn = function (on) {
    try { localStorage.setItem(USER_KEY, on ? 'on' : 'off'); } catch (e) {}
    if (!on && BW.open) window.closeBridge();
    renderBottomButtons();
};
// Can this person see the bridge controls at all? (switch on, not a phone, WebGL)
window.bridgeAvailable = function () { return featureOn() && !isPhone() && hasWebGL(); };

/* ---------- markers ---------- */
// Marker name -> role. Case-insensitive; Blender's ".001" endings are ignored.
window.bridgeMarkerRole = function (name) {
    const n = String(name || '').trim().replace(/\.\d+$/, '');
    let m;
    if (/^spawn_player$/i.test(n)) return { kind: 'spawn' };
    if (/^holotable$/i.test(n)) return { kind: 'holo' };
    if ((m = n.match(/^station_(.+)$/i))) {
        const r = m[1].toLowerCase();
        const role = /^helm/.test(r) ? 'helm' : /^tactical/.test(r) ? 'tactical' : /^sensors?/.test(r) ? 'sensors' : /^comms?/.test(r) ? 'comms' : /^quartermaster|^qm\b/.test(r) ? 'quartermaster' : 'other';
        return { kind: 'station', role, label: m[1] };
    }
    if ((m = n.match(/^chair_(.+)$/i))) return { kind: 'chair', key: m[1].toLowerCase() };
    if ((m = n.match(/^seat_(.+)$/i))) return { kind: 'seat', key: m[1].toLowerCase() };
    if ((m = n.match(/^npc_(.+)$/i))) return { kind: 'npc', key: m[1] };
    if ((m = n.match(/^lift_(.+)_([ab])$/i))) return { kind: 'lift', key: m[1].toLowerCase(), end: m[2].toLowerCase() };
    if ((m = n.match(/^door_(.+)$/i))) return { kind: 'door', key: m[1] };
    if (/^holoscreen/i.test(n)) return { kind: 'holoscreen' };
    if (/^nav$/i.test(n)) return { kind: 'nav' };
    return null;
};
const STATION_INFO = {
    helm: { label: 'HELM', opens: 'Jump plotter' },
    tactical: { label: 'TACTICAL', opens: 'Galaxy map / Battle Map' },
    sensors: { label: 'SENSORS', opens: 'DRADIS sweep' },
    comms: { label: 'COMMS', opens: 'Comms panel' },
    quartermaster: { label: 'QUARTERMASTER', opens: 'Ship hold' },
    other: { label: 'CONSOLE', opens: null }
};

/* ---------- walkable grid ---------- */
// nav = { res, x0, z0, nx, nz, step, cells:[ix,iz,ycm,...] }
window.bridgeBuildNav = function (nav) {
    const cells = new Map();
    for (let i = 0; i < nav.cells.length; i += 3) {
        const k = nav.cells[i] + ',' + nav.cells[i + 1];
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(nav.cells[i + 2] / 100);
    }
    const N = { res: nav.res, x0: nav.x0, z0: nav.z0, nx: nav.nx, nz: nav.nz, step: nav.step || STEP, cells };
    N.cellOf = (x, z) => [Math.floor((x - N.x0) / N.res), Math.floor((z - N.z0) / N.res)];
    N.center = (ix, iz) => [N.x0 + (ix + 0.5) * N.res, N.z0 + (iz + 0.5) * N.res];
    // floor height under (x,z) closest to y (within a step), or null
    N.heightAt = (x, z, y) => {
        const [ix, iz] = N.cellOf(x, z); const hs = cells.get(ix + ',' + iz); if (!hs) return null;
        let best = null; for (const h of hs) if (Math.abs(h - y) <= N.step && (best === null || Math.abs(h - y) < Math.abs(best - y))) best = h;
        return best;
    };
    // nearest walkable cell to a point (searching outwards), preferring heights near y
    N.nearest = (x, z, y, maxR, maxDy) => {
        const [cx, cz] = N.cellOf(x, z); const R = maxR || 12; const DY = maxDy || Infinity; // maxDy skips floors on other decks
        let best = null;
        for (let r = 0; r <= R && !best; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const hs = cells.get((cx + dx) + ',' + (cz + dz)); if (!hs) continue;
            for (const h of hs) { if (Math.abs(h - y) > DY) continue; const score = Math.hypot(dx, dz) * N.res + Math.abs(h - y) * 2; if (!best || score < best.score) best = { ix: cx + dx, iz: cz + dz, y: h, score }; }
        }
        return best;
    };
    return N;
};
// A* over walkable cells (8-way, no corner cutting). Nodes are "ix,iz,y".
window.bridgeFindPath = function (N, from, to, limit) {
    const key = (n) => n.ix + ',' + n.iz + ',' + n.y;
    const h = (n) => Math.hypot(n.ix - to.ix, n.iz - to.iz);
    const open = [{ n: from, g: 0, f: h(from) }]; const came = new Map(); const g = new Map([[key(from), 0]]);
    const LIM = limit || 60000; let it = 0;
    while (open.length && it++ < LIM) {
        let bi = 0; for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
        const cur = open.splice(bi, 1)[0].n;
        if (cur.ix === to.ix && cur.iz === to.iz && Math.abs(cur.y - to.y) <= N.step) {
            const out = [cur]; let k = key(cur); while (came.has(k)) { const p = came.get(k); out.unshift(p); k = key(p); } return out;
        }
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const hs = N.cells.get((cur.ix + dx) + ',' + (cur.iz + dz)); if (!hs) continue;
            for (const y of hs) {
                if (Math.abs(y - cur.y) > N.step) continue;
                if (dx && dz) { // no cutting corners past walls
                    const a = N.cells.get((cur.ix + dx) + ',' + cur.iz), b = N.cells.get(cur.ix + ',' + (cur.iz + dz));
                    if (!a || !b || !a.some(v => Math.abs(v - cur.y) <= N.step) || !b.some(v => Math.abs(v - cur.y) <= N.step)) continue;
                }
                const nb = { ix: cur.ix + dx, iz: cur.iz + dz, y };
                const ng = g.get(key(cur)) + (dx && dz ? 1.414 : 1) + Math.abs(y - cur.y);
                if (ng < (g.has(key(nb)) ? g.get(key(nb)) : Infinity)) { g.set(key(nb), ng); came.set(key(nb), cur); open.push({ n: nb, g: ng, f: ng + h(nb) }); }
            }
        }
    }
    return null;
};
// Which way to face at a spot: the direction with the longest open walk (used when
// the spawn marker was never rotated).
window.bridgeOpenYaw = function (N, x, z, y) {
    let best = 0, bestLen = -1;
    for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2, dx = -Math.sin(a), dz = -Math.cos(a);
        let len = 0, cy = y;
        for (let d = N.res; d < 40; d += N.res) { const h = N.heightAt(x + dx * d, z + dz * d, cy); if (h === null) break; cy = h; len = d; }
        if (len > bestLen) { bestLen = len; best = a; }
    }
    return best;
};

/* ---------- loading ---------- */
function importer(u) { return (BW.test && BW.test.importer) ? BW.test.importer(u) : import(u); }
async function loadThree() {
    if (BW.THREE) return BW.THREE;
    if (window.__b3d && window.__b3d.THREE) { BW.THREE = window.__b3d.THREE; return BW.THREE; }
    BW.THREE = await importer('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js');
    return BW.THREE;
}
async function signedUrl(path) {
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
    if (error || !data) throw new Error('Could not get a link for ' + path + (error ? ': ' + error.message : ''));
    return data.signedUrl;
}
// Download one stored file, keeping a copy in the browser (Cache Storage) keyed by
// the manifest version, so the ~60 MB only comes down once.
async function fetchPart(cfg, path, onBytes) {
    if (BW.test && BW.test.fetchPart) return BW.test.fetchPart(path, onBytes);
    const cacheKey = `https://bridge.cache/${cfg.version}/${path}`;
    let cache = null;
    try { cache = await caches.open(CACHE_NAME); const hit = await cache.match(cacheKey); if (hit) { const b = await hit.arrayBuffer(); onBytes && onBytes(b.byteLength); return b; } } catch (e) { cache = null; }
    const res = await fetch(await signedUrl(path));
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${path}`);
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    let buf;
    if (reader) {
        const chunks = []; let got = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.byteLength; onBytes && onBytes(value.byteLength); }
        buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.byteLength; } buf = buf.buffer;
    } else { buf = await res.arrayBuffer(); onBytes && onBytes(buf.byteLength); }
    if (cache) { try { await cache.put(cacheKey, new Response(buf.slice(0))); } catch (e) { /* storage full: still works, just downloads again next time */ } }
    return buf;
}
async function clearOldCaches(cfg) {
    try { const cache = await caches.open(CACHE_NAME); for (const req of await cache.keys()) if (!req.url.includes('/' + cfg.version + '/')) await cache.delete(req); } catch (e) {}
}
function load(cfg) {
    if (BW.loaded && BW.loaded.version === cfg.version) return Promise.resolve(BW.loaded);
    if (BW.loading) return BW.loading;
    BW.loading = (async () => {
        const THREE = await loadThree();
        const [{ GLTFLoader }, { MeshoptDecoder }, bvh] = await Promise.all([
            importer('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/GLTFLoader.js'),
            importer('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/meshopt_decoder.module.js'),
            importer('https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.8.3/build/index.module.js')]);
        BW.bvh = bvh;
        const total = cfg.bytes || 0; let got = 0;
        const tick = (n) => { got += n; setProgress(total ? Math.min(99, Math.round(100 * got / total)) : null, `Downloading the bridge… ${(got / 1e6).toFixed(0)} MB`); };
        const bufs = [];
        for (const p of cfg.parts) bufs.push(await fetchPart(cfg, p, tick));
        const navBuf = await fetchPart(cfg, cfg.nav, null);
        setProgress(100, 'Building the bridge…');
        let size = 0; bufs.forEach(b => size += b.byteLength);
        const glb = new Uint8Array(size); let o = 0; bufs.forEach(b => { glb.set(new Uint8Array(b), o); o += b.byteLength; });
        const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await new Promise((res, rej) => loader.parse(glb.buffer, '', res, rej));
        const nav = JSON.parse(new TextDecoder().decode(navBuf));
        clearOldCaches(cfg);
        BW.loaded = { version: cfg.version, gltf, nav };
        return BW.loaded;
    })();
    BW.loading.finally(() => { BW.loading = null; });
    return BW.loading;
}

/* ---------- overlay ---------- */
function setProgress(pct, text) {
    const bar = document.getElementById('bw-progress-bar'), t = document.getElementById('bw-progress-text');
    if (bar) bar.style.width = (pct === null ? 30 : pct) + '%';
    if (t) t.textContent = text || '';
}
function ensureOverlay() {
    if (BW.el) return BW.el;
    const el = document.createElement('div');
    el.id = 'bridge-walk';
    el.innerHTML = `
        <div id="bw-canvas-host"></div>
        <div class="bw-top">
            <div class="bw-title"><b>BRIDGE</b><span id="bw-sub">First-person view</span></div>
            <div class="bw-actions">
                <button id="bw-stand" class="bw-btn" hidden>STAND UP</button>
                <button id="bw-setup-btn" class="bw-btn" hidden>SETUP</button>
                <button id="bw-help-btn" class="bw-btn">HELP</button>
                <button id="bw-exit" class="bw-btn bw-gold">EXIT BRIDGE</button>
            </div>
        </div>
        <div id="bw-hint" class="bw-hint">WASD walk · drag to look · click the floor to walk there · click a station, the table or a chair to use it · Esc to leave</div>
        <div id="bw-tip" class="bw-tip" hidden></div>
        <div id="bw-toast" class="bw-toast" hidden></div>
        <div id="bw-loading" class="bw-loading">
            <div class="bw-load-card">
                <b>BRIDGE</b>
                <div class="bw-load-track"><div id="bw-progress-bar"></div></div>
                <div id="bw-progress-text">Starting…</div>
            </div>
        </div>
        <div id="bw-setup" class="bw-loading" hidden></div>`;
    document.body.appendChild(el);
    BW.el = el;
    el.querySelector('#bw-exit').onclick = () => window.closeBridge();
    el.querySelector('#bw-stand').onclick = () => standUp();
    el.querySelector('#bw-setup-btn').onclick = () => { stopLoop(); showSetup(); };
    el.querySelector('#bw-help-btn').onclick = () => { const h = el.querySelector('#bw-hint'); h.hidden = !h.hidden; };
    const host = el.querySelector('#bw-canvas-host');
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointercancel', onUp);
    host.addEventListener('contextmenu', e => e.preventDefault());
    return el;
}
let toastTimer = 0;
function toast(msg) { const t = document.getElementById('bw-toast'); if (!t) return; t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600); }

window.openBridge = async function () {
    if (!window.bridgeAvailable()) { if (typeof window.showToast === 'function') window.showToast(isPhone() ? 'The 3D bridge is PC only.' : 'The 3D bridge is not available.', 'warn'); return; }
    if (!window.bridgeUserOn()) { window.setBridgeUserOn(true); }
    ensureOverlay();
    BW.el.style.display = 'block'; BW.open = true; BW.away = false;
    document.body.classList.add('bw-open');
    BW.el.querySelector('#bw-setup-btn').hidden = !isDm();
    hideBackButton();
    const cfg = window.bridgeConfig();
    if (!cfg) { showSetup(); return; }
    if (BW.scene && BW.loaded && BW.loaded.version === cfg.version) { BW.el.querySelector('#bw-loading').hidden = true; startLoop(); return; }
    BW.el.querySelector('#bw-loading').hidden = false; BW.el.querySelector('#bw-setup').hidden = true;
    try {
        const L = await load(cfg);
        if (!BW.open) return;
        buildScene(L, cfg);
        BW.el.querySelector('#bw-loading').hidden = true;
        startLoop();
    } catch (e) {
        console.error('[bridge] load failed', e);
        setProgress(0, 'Could not load the bridge: ' + (e && e.message ? e.message : e) + (isDm() ? ' (check the files in Setup)' : ''));
        if (isDm()) showSetup('Loading failed: ' + (e && e.message ? e.message : e));
    }
};
window.closeBridge = function () {
    BW.open = false; BW.away = false; stopLoop();
    if (BW.el) BW.el.style.display = 'none';
    document.body.classList.remove('bw-open');
    hideBackButton();
};

/* ---------- scene ---------- */
function buildScene(L, cfg) {
    const THREE = BW.THREE;
    if (!BW.renderer) {
        BW.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        BW.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        BW.renderer.outputColorSpace = THREE.SRGBColorSpace;
        BW.renderer.toneMapping = THREE.ACESFilmicToneMapping; BW.renderer.toneMappingExposure = 1.05;
        BW.el.querySelector('#bw-canvas-host').appendChild(BW.renderer.domElement);
        window.addEventListener('resize', resize);
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02050a);
    // stars beyond the windows
    const sv = []; for (let i = 0; i < 3000; i++) { const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u); sv.push(Math.cos(a) * r * 400, u * 400, Math.sin(a) * r * 400); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sv, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xd8f2ff, size: 1.6, sizeAttenuation: false })));
    scene.add(new THREE.HemisphereLight(0xdfefff, 0x2a2622, 1.25));
    const dl = new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(5, 20, 8); scene.add(dl);
    const root = L.gltf.scene;
    scene.add(root);
    root.updateMatrixWorld(true);
    // ~1M triangles: clicks and hovers need a BVH, or every raycast walks them all
    BW.pickables = [];
    root.traverse(o => { if (o.isMesh) { if (BW.bvh && !o.geometry.boundsTree) { o.geometry.computeBoundsTree = BW.bvh.computeBoundsTree; o.geometry.computeBoundsTree(); o.raycast = BW.bvh.acceleratedRaycast; } BW.pickables.push(o); } });
    BW.markers = []; BW.zones = [];
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x00c8ff, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    root.traverse(o => {
        const role = window.bridgeMarkerRole(o.name);
        if (!role) return;
        if (role.kind === 'holoscreen') { o.traverse(m => { if (m.isMesh) m.material = glowMat; }); return; }
        if (role.kind === 'nav') { o.visible = false; return; }
        const p = new THREE.Vector3(); o.getWorldPosition(p);
        const q = new THREE.Quaternion(); o.getWorldQuaternion(q);
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);        // Blender -Y = glTF +Z
        const lq = o.quaternion;
        const rotated = Math.abs(lq.x) + Math.abs(lq.y) + Math.abs(lq.z) > 1e-3; // marker turned in Blender?
        BW.markers.push(Object.assign({ name: o.name, pos: p, yaw: Math.atan2(-f.x, -f.z), rotated }, role));
    });
    BW.nav = window.bridgeBuildNav(L.nav);
    // click zones
    const holo = BW.markers.find(m => m.kind === 'holo');
    for (const m of BW.markers) {
        if (m.kind === 'station') {
            if (m.role === 'tactical' && holo && m.pos.distanceTo(holo.pos) < 2.5) continue; // the table is both (DM ruling)
            BW.zones.push({ m, r: 0.75, kind: 'station' });
        } else if (m.kind === 'holo') BW.zones.push({ m, r: 1.6, kind: 'holo' });
        else if (m.kind === 'chair') BW.zones.push({ m, r: 0.7, kind: 'chair' });
    }
    // live map hologram above the table
    BW.holo = null;
    if (holo) {
        const c = document.createElement('canvas'); c.width = 1024; c.height = 640;
        BW.holoCanvas = c; BW.holoTex = new THREE.CanvasTexture(c); BW.holoTex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.MeshBasicMaterial({ map: BW.holoTex, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
        const fit = fitTable(holo.pos);
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(fit.w, fit.d), mat);
        plane.rotation.x = -Math.PI / 2; plane.position.set(fit.cx, fit.y + 0.04, fit.cz);
        scene.add(plane); BW.holo = plane; drawHolo(true);
    }
    // camera + spawn
    BW.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 2000);
    BW.camera.rotation.order = 'YXZ';
    BW.scene = scene;
    const sp = BW.markers.find(m => m.kind === 'spawn') || holo || { pos: new THREE.Vector3(), rotated: false };
    const cell = BW.nav.nearest(sp.pos.x, sp.pos.z, sp.pos.y, 40);
    if (cell) { const [cx, cz] = BW.nav.center(cell.ix, cell.iz); BW.pos = new THREE.Vector3(cx, cell.y, cz); }
    else BW.pos = sp.pos.clone();
    BW.yaw = sp.rotated ? sp.yaw : window.bridgeOpenYaw(BW.nav, BW.pos.x, BW.pos.z, BW.pos.y);
    BW.pitch = -0.08; BW.path = null; BW.seated = null; BW.tween = null;
    const sub = BW.el.querySelector('#bw-sub'); if (sub) sub.textContent = cfg.title || 'Intrepid Horizon';
    resize();
}
// Find the table top under the HOLOTABLE marker: cast rays down on a 10 cm grid and keep the
// hits level with the centre one. Falls back to a 2.0 x 1.3 m sheet at the marker.
function fitTable(p) {
    const THREE = BW.THREE; const rc = new THREE.Raycaster(); rc.firstHitOnly = true;
    const down = new THREE.Vector3(0, -1, 0);
    const hitY = (x, z) => { rc.set(new THREE.Vector3(x, p.y + 0.3, z), down); rc.far = 2.5; const h = rc.intersectObjects(BW.pickables, false)[0]; return h ? h.point.y : null; };
    const y0 = hitY(p.x, p.z);
    if (y0 === null) return { cx: p.x, cz: p.z, y: p.y - 0.4, w: 2.0, d: 1.3 };
    let minX = p.x, maxX = p.x, minZ = p.z, maxZ = p.z;
    for (let dx = -2; dx <= 2.001; dx += 0.1) for (let dz = -2; dz <= 2.001; dz += 0.1) {
        const y = hitY(p.x + dx, p.z + dz);
        if (y !== null && Math.abs(y - y0) < 0.06) { minX = Math.min(minX, p.x + dx); maxX = Math.max(maxX, p.x + dx); minZ = Math.min(minZ, p.z + dz); maxZ = Math.max(maxZ, p.z + dz); }
    }
    const w = Math.max(0.8, maxX - minX), d = Math.max(0.6, maxZ - minZ);
    return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, y: y0, w: Math.min(w, 4), d: Math.min(d, 4) };
}
function resize() {
    if (!BW.renderer || !BW.el) return;
    const host = BW.el.querySelector('#bw-canvas-host'); const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    BW.renderer.setSize(w, h, false); BW.renderer.domElement.style.width = w + 'px'; BW.renderer.domElement.style.height = h + 'px';
    if (BW.camera) { BW.camera.aspect = w / h; BW.camera.updateProjectionMatrix(); }
}

/* ---------- live table ---------- */
function battleRunning() { return !!window.globalBattleEncounterCache; }
function drawHolo(force) {
    if (!BW.holoCanvas) return;
    const now = performance.now(); if (!force && now - BW.lastHoloDraw < 500) return; BW.lastHoloDraw = now;
    const g = BW.holoCanvas.getContext('2d'), W = BW.holoCanvas.width, H = BW.holoCanvas.height;
    g.clearRect(0, 0, W, H); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    let src = null;
    if (battleRunning()) src = document.querySelector('#battle-map-panel canvas');
    if (!src) src = document.getElementById('galaxyCanvas');
    if (src && src.width && src.height) {
        try { const s = Math.max(W / src.width, H / src.height); const w = src.width * s, h = src.height * s; g.globalAlpha = 0.95; g.drawImage(src, (W - w) / 2, (H - h) / 2, w, h); g.globalAlpha = 1; } catch (e) {}
    }
    g.strokeStyle = 'rgba(0,225,255,0.9)'; g.lineWidth = 6; g.strokeRect(6, 6, W - 12, H - 12);
    g.font = '600 34px Oxanium, sans-serif'; g.fillStyle = battleRunning() ? '#ff7a85' : '#7fe8ff';
    g.fillText(battleRunning() ? 'BATTLE MAP' : 'GALAXY MAP', 28, 52);
    BW.holoTex.needsUpdate = true;
}

/* ---------- interaction ---------- */
let drag = null;
function onDown(e) { if (BW.tween) return; drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }
function onMove(e) {
    if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) drag.moved = true;
        if (drag.moved && !BW.tween) { BW.yaw -= dx * 0.004; BW.pitch = Math.max(-1.3, Math.min(1.2, BW.pitch - dy * 0.0035)); }
        drag.x = e.clientX; drag.y = e.clientY; return;
    }
    hover(e.clientX, e.clientY);
}
function onUp(e) { const d = drag; drag = null; if (d && !d.moved) click(e.clientX, e.clientY); }
function rayAt(x, y) {
    const THREE = BW.THREE; const r = BW.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1), BW.camera); return rc;
}
function zoneHit(rc, maxD) {
    let best = null;
    for (const z of BW.zones) {
        const d = rc.ray.distanceToPoint(z.m.pos); const along = z.m.pos.clone().sub(rc.ray.origin).dot(rc.ray.direction);
        if (d < z.r && along > 0 && along < (maxD || 40) && (!best || along < best.along)) best = { z, along };
    }
    return best;
}
function sceneHit(rc) { rc.firstHitOnly = true; const hits = rc.intersectObjects(BW.pickables || [], false).filter(h => h.object.visible); return hits[0] || null; }
let lastHover = 0;
function hover(x, y) {
    if (!BW.scene || BW.tween || BW.seated) return;
    const now = performance.now(); if (now - lastHover < 80) return; lastHover = now;
    const rc = rayAt(x, y); const sh = sceneHit(rc); const zh = zoneHit(rc, sh ? sh.distance + 1.2 : 40);
    const tip = document.getElementById('bw-tip');
    if (zh) {
        const z = zh.z; let label = '';
        if (z.kind === 'holo') label = battleRunning() ? 'TABLE · Battle Map' : 'TABLE · Galaxy map';
        else if (z.kind === 'chair') label = 'SEAT · sit down';
        else { const info = STATION_INFO[z.m.role]; label = info.label + (info.opens ? ' · ' + info.opens : ' · not linked yet'); }
        tip.textContent = label; tip.style.left = x + 'px'; tip.style.top = y + 'px'; tip.hidden = false; BW.renderer.domElement.style.cursor = 'pointer';
    } else { tip.hidden = true; BW.renderer.domElement.style.cursor = ''; }
}
function click(x, y) {
    if (!BW.scene || BW.tween) return;
    if (BW.seated) return;
    const rc = rayAt(x, y); const sh = sceneHit(rc); const zh = zoneHit(rc, sh ? sh.distance + 1.2 : 40);
    if (zh) return useZone(zh.z);
    if (!sh) return;
    const p = sh.point; const cell = BW.nav.nearest(p.x, p.z, p.y, 6, 1.2);
    if (!cell || Math.abs(cell.y - p.y) > 1.2) { toast("You can't walk there."); return; }
    walkTo(cell, null);
}
function walkTo(cell, onArrive) {
    const N = BW.nav; const [ix, iz] = N.cellOf(BW.pos.x, BW.pos.z);
    const from = N.nearest(BW.pos.x, BW.pos.z, BW.pos.y, 4, 0.6); if (!from) return false;
    const path = window.bridgeFindPath(N, { ix: from.ix, iz: from.iz, y: from.y }, cell);
    if (!path) { toast('No way through to there.'); return false; }
    BW.path = path.slice(1).map(n => { const [x, z] = N.center(n.ix, n.iz); return { x, z, y: n.y }; });
    BW.onArrive = onArrive || null;
    if (!BW.path.length) { BW.path = null; onArrive && onArrive(); }
    return true;
}
function faceThen(target, cb) { BW.turnTo = { yaw: Math.atan2(-(target.x - BW.pos.x), -(target.z - BW.pos.z)), cb }; }
function useZone(z) {
    const m = z.m;
    const near = BW.nav.nearest(m.pos.x, m.pos.z, m.pos.y - 0.6, 16, 1.6) || BW.nav.nearest(m.pos.x, m.pos.z, m.pos.y - 0.6, 10);
    const go = (cb) => { if (near && Math.hypot(BW.pos.x - m.pos.x, BW.pos.z - m.pos.z) > (z.kind === 'holo' ? 2.4 : 1.4)) walkTo({ ix: near.ix, iz: near.iz, y: near.y }, () => faceThen(m.pos, cb)); else faceThen(m.pos, cb); };
    if (z.kind === 'holo') return go(() => leanOver(m));
    if (z.kind === 'chair') return go(() => sit(m));
    if (z.kind === 'station') {
        if (m.role === 'other') { go(() => toast('This console is not linked to anything yet.')); return; }
        return go(() => openStation(m.role));
    }
}
function tweenCam(toPos, toYaw, toPitch, dur, cb) {
    BW.tween = { fp: BW.camera.position.clone(), fy: BW.yaw, fpi: BW.pitch, tp: toPos, ty: toYaw, tpi: toPitch, t: 0, dur, cb };
}
function sit(chair) {
    const seat = BW.markers.find(m => m.kind === 'seat' && m.key === chair.key) || null; // SEAT_captain pairs with CHAIR_captain only
    const floor = BW.nav.nearest(chair.pos.x, chair.pos.z, chair.pos.y - 0.6, 6, 1.6);
    const eye = seat ? seat.pos.clone() : new BW.THREE.Vector3(chair.pos.x, (floor ? floor.y : chair.pos.y - 0.8) + SEAT_EYE, chair.pos.z);
    const yaw = (seat && seat.rotated) ? seat.yaw : (chair.rotated ? chair.yaw : BW.yaw);
    BW.seated = { chair, back: BW.pos.clone() };
    tweenCam(eye, yaw, -0.12, 0.9, () => { BW.el.querySelector('#bw-stand').hidden = false; });
}
function standUp() {
    if (!BW.seated) return;
    const back = BW.seated.back; BW.seated = null; BW.el.querySelector('#bw-stand').hidden = true;
    tweenCam(new BW.THREE.Vector3(back.x, back.y + EYE, back.z), BW.yaw, -0.08, 0.7, null);
}
function leanOver(m) {
    tweenCam(new BW.THREE.Vector3(m.pos.x, m.pos.y + 1.4, m.pos.z + 0.01), BW.yaw, -1.45, 1.0, () => {
        handOff(battleRunning() ? 'battle' : 'galaxy');
    });
}
/* Leave the 3D view for an existing panel; a floating button brings you back. */
function handOff(what) {
    BW.away = true; stopLoop();
    if (BW.el) BW.el.style.display = 'none';
    document.body.classList.remove('bw-open');
    try {
        if (what === 'battle') { const p = document.getElementById('battle-map-panel'); if (!p || p.style.display !== 'block') window.toggleBattleMap(); }
        else if (what === 'helm') {
            const cfg = window.bridgeConfig() || {};
            const ship = (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).find(s => s.id === cfg.ship_id);
            if (ship && typeof window.startJumpPlottingMode === 'function') { window.selectedTarget = { type: 'ship', data: ship }; window.startJumpPlottingMode(); }
            else if (typeof window.showToast === 'function') window.showToast('Helm: pick your ship on the map, then plot the jump.', 'info');
        }
        else if (what === 'sensors') { if (typeof window.toggleRadarSweep === 'function' && !window.radarSweepActive) window.toggleRadarSweep(); }
        else if (what === 'comms') { const p = document.getElementById('comms-array-panel'); if (!p || p.style.display !== 'block') window.toggleCommsArray(); }
        else if (what === 'quartermaster') { if (typeof window.openFullCargoTerminal === 'function') window.openFullCargoTerminal(); else { window.toggleCharacterTerminal(); window.switchTermTab('cargo'); } }
    } catch (e) { console.error('[bridge] hand-off failed', e); }
    showBackButton();
}
function openStation(role) { handOff(role === 'tactical' ? (battleRunning() ? 'battle' : 'galaxy') : role); }
function showBackButton() {
    let b = document.getElementById('bw-back');
    if (!b) { b = document.createElement('button'); b.id = 'bw-back'; b.textContent = '◂ BACK TO BRIDGE'; b.onclick = () => returnToBridge(); document.body.appendChild(b); }
    b.hidden = false;
}
function hideBackButton() { const b = document.getElementById('bw-back'); if (b) b.hidden = true; }
function returnToBridge() {
    hideBackButton();
    if (!BW.scene) { window.openBridge(); return; }
    BW.away = false; BW.open = true; BW.el.style.display = 'block'; document.body.classList.add('bw-open');
    // step back from wherever the hand-off left the camera
    if (BW.seated) { BW.seated = null; BW.el.querySelector('#bw-stand').hidden = true; }
    BW.pitch = -0.08; startLoop();
}
window.bridgeReturn = returnToBridge;

/* ---------- loop ---------- */
function startLoop() { if (BW.raf || (BW.test && BW.test.noLoop)) return; BW.lastT = performance.now(); const f = (t) => { BW.raf = requestAnimationFrame(f); step(Math.min(0.05, (t - BW.lastT) / 1000)); BW.lastT = t; }; BW.raf = requestAnimationFrame(f); }
function stopLoop() { if (BW.raf) cancelAnimationFrame(BW.raf); BW.raf = 0; }
function lerpAngle(a, b, t) { const d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * t; }
function step(dt, noRender) {
    if (!BW.scene) return;
    const cam = BW.camera;
    if (BW.tween) {
        const T = BW.tween; T.t = Math.min(1, T.t + dt / T.dur); const e = T.t < 0.5 ? 2 * T.t * T.t : 1 - Math.pow(-2 * T.t + 2, 2) / 2;
        cam.position.lerpVectors(T.fp, T.tp, e); BW.yaw = lerpAngle(T.fy, T.ty, e); BW.pitch = T.fpi + (T.tpi - T.fpi) * e;
        cam.rotation.set(BW.pitch, BW.yaw, 0);
        if (T.t >= 1) { BW.tween = null; T.cb && T.cb(); }
    } else if (BW.seated) {
        cam.rotation.set(BW.pitch, BW.yaw, 0);
    } else {
        let mx = 0, mz = 0; const K = BW.keys;
        if (K.KeyW || K.ArrowUp) mz += 1; if (K.KeyS || K.ArrowDown) mz -= 1; if (K.KeyA) mx -= 1; if (K.KeyD) mx += 1;
        if (K.ArrowLeft) BW.yaw += dt * 1.8; if (K.ArrowRight) BW.yaw -= dt * 1.8;
        if (mx || mz) {
            BW.path = null; BW.onArrive = null; BW.turnTo = null;
            const s = WALK * dt / Math.hypot(mx, mz), fx = -Math.sin(BW.yaw), fz = -Math.cos(BW.yaw);
            const nx = BW.pos.x + (fx * mz - fz * mx) * s, nz = BW.pos.z + (fz * mz + fx * mx) * s;
            const tryMove = (x, z) => { const h = BW.nav.heightAt(x, z, BW.pos.y); if (h === null) return false; BW.pos.x = x; BW.pos.z = z; BW.pos.y += (h - BW.pos.y) * Math.min(1, dt * 12); return true; };
            if (!tryMove(nx, nz)) { tryMove(nx, BW.pos.z) || tryMove(BW.pos.x, nz); }
        } else if (BW.path) {
            const tg = BW.path[0]; const dx = tg.x - BW.pos.x, dz = tg.z - BW.pos.z, d = Math.hypot(dx, dz), st = WALK * dt;
            if (d > 0.05) BW.yaw = lerpAngle(BW.yaw, Math.atan2(-dx, -dz), 1 - Math.exp(-6 * dt));
            if (d <= st) { BW.pos.x = tg.x; BW.pos.z = tg.z; BW.path.shift(); if (!BW.path.length) { BW.path = null; const f = BW.onArrive; BW.onArrive = null; f && f(); } }
            else { BW.pos.x += dx / d * st; BW.pos.z += dz / d * st; }
            BW.pos.y += (tg.y - BW.pos.y) * Math.min(1, dt * 10);
        } else if (BW.turnTo) {
            BW.yaw = lerpAngle(BW.yaw, BW.turnTo.yaw, 1 - Math.exp(-8 * dt));
            if (Math.abs(((BW.turnTo.yaw - BW.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) < 0.03) { const cb = BW.turnTo.cb; BW.turnTo = null; cb && cb(); }
        }
        cam.position.set(BW.pos.x, BW.pos.y + EYE, BW.pos.z); cam.rotation.set(BW.pitch, BW.yaw, 0);
    }
    if (noRender) return;
    if (BW.holo) drawHolo(false);
    BW.renderer.render(BW.scene, cam);
}
// Test hook: advance time without the render loop (software GL is too slow for 60 fps).
BW.tick = (dt, render) => step(dt, !render);
document.addEventListener('keydown', (e) => {
    if (!BW.open || BW.away) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'Escape') { if (BW.seated) standUp(); else window.closeBridge(); return; }
    BW.keys[e.code] = true;
    if (BW.seated && /Key[WASD]/.test(e.code)) standUp();
    if (e.code.startsWith('Arrow')) e.preventDefault();
});
document.addEventListener('keyup', (e) => { BW.keys[e.code] = false; });
window.addEventListener('blur', () => { BW.keys = {}; });

/* ---------- DM setup: upload the bridge files ---------- */
function showSetup(msg) {
    const box = BW.el.querySelector('#bw-setup'); BW.el.querySelector('#bw-loading').hidden = true; box.hidden = false;
    if (!isDm()) { box.innerHTML = `<div class="bw-load-card"><b>BRIDGE</b><p>The DM hasn't uploaded the bridge yet.</p><button class="bw-btn" onclick="window.closeBridge()">CLOSE</button></div>`; return; }
    const cfg = window.bridgeConfig();
    const ships = (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).filter(s => !s.is_strike_craft).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    box.innerHTML = `<div class="bw-load-card bw-setup-card">
        <b>BRIDGE SETUP (DM)</b>
        ${msg ? `<p class="bw-err">${esc(msg)}</p>` : ''}
        <p>${cfg ? `Current: version ${esc(cfg.version)}, ${cfg.parts.length} parts, ${((cfg.bytes || 0) / 1e6).toFixed(0)} MB.` : 'No bridge uploaded yet.'} Pick all the files from <code>bridge file/upload-v1</code>: the <code>.glb.part1</code>, <code>part2</code>, … files and the <code>.nav.json</code>.</p>
        <label for="bw-files">Bridge files</label>
        <input type="file" id="bw-files" multiple>
        <label for="bw-title">Name shown on the bridge</label>
        <input type="text" id="bw-title" value="${esc((cfg && cfg.title) || 'Intrepid Horizon')}">
        <label for="bw-ship">Ship the helm plots jumps for</label>
        <select id="bw-ship"><option value="">-- none (players pick on the map) --</option>${ships.map(s => `<option value="${s.id}"${cfg && cfg.ship_id === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <div class="bw-row"><button class="bw-btn" id="bw-setup-close">${BW.scene ? 'BACK TO BRIDGE' : 'CLOSE'}</button>${cfg ? '<button class="bw-btn" id="bw-save-meta">SAVE NAME / SHIP</button>' : ''}<button class="bw-btn bw-gold" id="bw-upload">UPLOAD</button></div>
        <div id="bw-up-status"></div>
    </div>`;
    box.querySelector('#bw-setup-close').onclick = () => { box.hidden = true; if (BW.scene) startLoop(); else window.closeBridge(); };
    box.querySelector('#bw-upload').onclick = () => window.uploadBridgeFiles(Array.from(box.querySelector('#bw-files').files || []), box.querySelector('#bw-title').value.trim(), box.querySelector('#bw-ship').value || null);
    const sm = box.querySelector('#bw-save-meta');
    if (sm) sm.onclick = () => saveConfig(Object.assign({}, cfg, { title: box.querySelector('#bw-title').value.trim() || cfg.title, ship_id: box.querySelector('#bw-ship').value || null })).then(() => { box.querySelector('#bw-up-status').textContent = 'Saved.'; });
}
window.openBridgeSetup = function () { if (!isDm()) return; ensureOverlay(); BW.el.style.display = 'block'; BW.open = true; showSetup(); };
async function saveConfig(cfg) {
    const { error } = await db.from('app_settings').upsert({ feature_key: CONFIG_KEY, mode: 'off', description: 'First-person bridge files (JSON manifest; written by the bridge setup screen).', value: JSON.stringify(cfg) }, { onConflict: 'feature_key' });
    if (error) throw new Error('Could not save the bridge settings: ' + error.message);
    if (window.appSettingsCache) window.appSettingsCache[CONFIG_KEY] = Object.assign({}, window.appSettingsCache[CONFIG_KEY] || {}, { feature_key: CONFIG_KEY, value: JSON.stringify(cfg) });
}
// Pure: which files are parts (in order) and which is the walkable grid.
window.bridgeSortUploads = function (names) {
    const parts = names.filter(n => /\.part\d+$/i.test(n)).sort((a, b) => parseInt(a.match(/(\d+)$/)[1], 10) - parseInt(b.match(/(\d+)$/)[1], 10));
    const nav = names.find(n => /\.nav\.json$/i.test(n)) || null;
    return { parts, nav, ok: parts.length > 0 && !!nav };
};
window.uploadBridgeFiles = async function (files, title, shipId) {
    const st = document.getElementById('bw-up-status'); const say = (t) => { if (st) st.textContent = t; };
    if (!isDm()) return;
    const byName = {}; files.forEach(f => byName[f.name] = f);
    const pick = window.bridgeSortUploads(Object.keys(byName));
    if (!pick.ok) { say('Pick the .glb.part files and the .nav.json together.'); return; }
    const version = 'v' + Date.now();
    let bytes = 0; const parts = [];
    try {
        for (let i = 0; i < pick.parts.length; i++) {
            const f = byName[pick.parts[i]]; say(`Uploading part ${i + 1} of ${pick.parts.length} (${(f.size / 1e6).toFixed(0)} MB)…`);
            const path = `${version}/part${i + 1}.bin`;
            const { error } = await db.storage.from(BUCKET).upload(path, f, { contentType: 'application/octet-stream', upsert: false });
            if (error) throw new Error('Part ' + (i + 1) + ': ' + error.message);
            parts.push(path); bytes += f.size;
        }
        say('Uploading the walkable floor…');
        const navPath = `${version}/nav.json`;
        const { error: ne } = await db.storage.from(BUCKET).upload(navPath, byName[pick.nav], { contentType: 'application/json', upsert: false });
        if (ne) throw new Error('Walkable floor: ' + ne.message);
        const old = window.bridgeConfig();
        await saveConfig({ version, parts, nav: navPath, bytes, title: title || 'Intrepid Horizon', ship_id: shipId || null, uploaded_at: new Date().toISOString() });
        // the previous version's files are no longer used: free the space (best effort)
        if (old && old.version !== version) { try { await db.storage.from(BUCKET).remove([...(old.parts || []), old.nav].filter(Boolean)); } catch (e) {} }
        say('Done. Opening the bridge…');
        BW.loaded = null; BW.scene = null;
        setTimeout(() => window.openBridge(), 300);
    } catch (e) { say('Upload failed: ' + (e && e.message ? e.message : e)); }
};

/* ---------- bottom-bar buttons ---------- */
function renderBottomButtons() {
    const bar = document.getElementById('bottom-toggle-bar'); if (!bar) return;
    let t = document.getElementById('bw-toggle'), go = document.getElementById('bw-enter');
    if (!window.bridgeAvailable()) { if (t) t.remove(); if (go) go.remove(); return; }
    if (!t) {
        t = document.createElement('button'); t.id = 'bw-toggle'; t.className = 'bw-bar-btn';
        t.title = '3D bridge on or off for you only (PC). Downloads about 60 MB the first time.';
        t.onclick = () => window.setBridgeUserOn(!window.bridgeUserOn());
        bar.appendChild(t);
    }
    t.textContent = '3D BRIDGE: ' + (window.bridgeUserOn() ? 'ON' : 'OFF');
    t.classList.toggle('on', window.bridgeUserOn());
    if (window.bridgeUserOn()) {
        if (!go) { go = document.createElement('button'); go.id = 'bw-enter'; go.className = 'bw-bar-btn bw-enter'; go.textContent = 'ENTER BRIDGE'; go.onclick = () => window.openBridge(); bar.insertBefore(go, t); }
    } else if (go) go.remove();
}
window.renderBridgeButtons = renderBottomButtons;
document.addEventListener('darkforest:features-changed', renderBottomButtons);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderBottomButtons); else renderBottomButtons();
})();
