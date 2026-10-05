/* ==========================================================================
   js/ship-models.js - Ship 3D models (Phase 6c, 2026-10-03)
   ==========================================================================
   DM decision (2026-10-03): a model lives on the ship TEMPLATE and is copied
   onto every ship deployed from it (deployShipTemplate), with a per-ship
   override in the Vessel Deck's EDIT BASE STATS sheet.

   Fields (ship_templates + ship_markers):
     model_url        FULL .glb   (HIGH quality)
     model_lite_url   LITE .glb   (LOW quality / phones; FULL is used if empty)
     model_yaw_offset 0/90/180/270 -- turn a model that faces the wrong way
     model_scale      size multiplier in the 3D view (1 = normal for its class)

   Files are made by the Darkforest ship converter (ship_project/
   darkforest-converter): glTF binary, nose on +Z, Y up, metres, vertex
   colours, Draco-compressed. They are uploaded to the PRIVATE Supabase
   Storage bucket 'battle-assets' (signed-in users can read, only the DM can
   upload) and stored as 'asset:<path>'. A pasted https:// link to a .glb
   also works.

   The 3D view (js/battle-3d.js) calls window.loadShipModel(ref) and falls
   back to its low-poly hull while a model loads or if it fails. */
(function () {
const ASSET_BUCKET = 'battle-assets';
const MAX_MODEL_BYTES = 10 * 1024 * 1024;
const signedCache = {};   // path -> { url, exp } | { pending }

window.isModelRef = function (ref) {
    return typeof ref === 'string' && (/^asset:[\w\-./]+\.glb$/i.test(ref) || /^https:\/\/\S+$/i.test(ref));
};
window.resolveModelUrl = async function (ref) {
    if (!window.isModelRef(ref)) return null;
    if (/^https:/i.test(ref)) return ref;
    const path = ref.slice('asset:'.length);
    const hit = signedCache[path];
    if (hit && hit.url && hit.exp > Date.now()) return hit.url;
    if (hit && hit.pending) return hit.pending;
    const pending = (async () => {
        try {
            const { data, error } = await db.storage.from(ASSET_BUCKET).createSignedUrl(path, 3600);
            if (error || !data) { console.warn('ship model: could not get a link for', path, error); return null; }
            signedCache[path] = { url: data.signedUrl, exp: Date.now() + 55 * 60 * 1000 };
            return data.signedUrl;
        } catch (err) { console.warn('ship model: link request failed', err); return null; }
        finally { if (signedCache[path]) delete signedCache[path].pending; }
    })();
    signedCache[path] = Object.assign(signedCache[path] || {}, { pending });
    return pending;
};

// Checks the file really is a binary glTF before uploading it.
async function checkGlb(file) {
    if (!file) throw new Error('No file chosen.');
    if (!/\.glb$/i.test(file.name || '')) throw new Error('That is not a .glb file (use the files the ship converter makes).');
    if (file.size > MAX_MODEL_BYTES) throw new Error(`That model is ${(file.size / 1048576).toFixed(1)} MB — the limit is 10 MB. Re-run the converter (the FULL file should be well under 1 MB).`);
    const part = file.slice(0, 4);
    const buf = part.arrayBuffer ? await part.arrayBuffer() : await new Promise((res, rej) => {
        const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(part);
    });
    const head = new Uint8Array(buf);
    if (String.fromCharCode(...head) !== 'glTF') throw new Error('That file is not a valid .glb model.');
}
window.uploadShipModel = async function (file) {
    await checkGlb(file);
    const base = String(file.name || 'model').replace(/\.glb$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'model';
    const path = `models/${currentUserId || 'anon'}/${Date.now()}-${base}.glb`;
    const { error } = await db.storage.from(ASSET_BUCKET).upload(path, file, { contentType: 'model/gltf-binary', upsert: false });
    if (error) throw new Error('Upload failed: ' + error.message);
    return 'asset:' + path;
};

/* --- Loading (shared cache; each ship gets a clone that shares geometry) --- */
const modelCache = {};    // ref -> Promise<{ scene, length, center }>
let loaderPromise = null;
const ADDONS = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/';
function getLoader() {
    if (window.__shipModelTest && window.__shipModelTest.loader) return Promise.resolve(window.__shipModelTest.loader);
    if (!loaderPromise) {
        loaderPromise = Promise.all([import(ADDONS + 'loaders/GLTFLoader.js'), import(ADDONS + 'loaders/DRACOLoader.js')]).then(([g, d]) => {
            const draco = new d.DRACOLoader();
            draco.setDecoderPath(ADDONS + 'libs/draco/gltf/');
            const loader = new g.GLTFLoader();
            loader.setDRACOLoader(draco);
            return loader;
        });
        loaderPromise.catch(() => { loaderPromise = null; });
    }
    return loaderPromise;
}
// Resolves to { scene, length, center } (length = longest side, in the
// file's own units) or rejects. Callers clone `scene` per ship.
window.loadShipModel = function (ref) {
    if (!window.isModelRef(ref)) return Promise.reject(new Error('not a model ref'));
    if (modelCache[ref]) return modelCache[ref];
    const p = (async () => {
        const url = await window.resolveModelUrl(ref);
        if (!url) throw new Error('no link for ' + ref);
        const loader = await getLoader();
        const gltf = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
        const THREE = window.__b3d && window.__b3d.THREE;
        const scene = gltf.scene;
        const box = new THREE.Box3().setFromObject(scene);
        const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
        return { scene, length: Math.max(size.x, size.y, size.z) || 1, center };
    })();
    modelCache[ref] = p;
    p.catch(err => { console.warn('ship model: could not load', ref, err && err.message); });
    return p;
};
window.__shipModelCache = modelCache; // tests

/* --- The picker (template editors + EDIT BASE STATS) --- DM only. ---
   Inserted after the form's image picker (#<prefix>-media). Values live in
   hidden inputs; window.readModelPicker(prefix) returns the four fields, or
   undefined when the picker isn't on the page (so saves leave them alone). */
const esc = (s) => window.escapeHtml ? window.escapeHtml(s == null ? '' : String(s)) : String(s == null ? '' : s);
function refLabel(ref) {
    if (!ref) return '— none —';
    if (/^https:/i.test(ref)) return 'linked: ' + ref.replace(/^https:\/\//, '').slice(0, 40) + (ref.length > 48 ? '…' : '');
    return '✓ ' + ref.split('/').pop().replace(/^\d+-/, '');
}
// Phase 11: short Blender export guide (matches what loadShipModel and the
// 3D view expect: glTF nose on +Z, Y up; size is set by ship class, so
// units don't matter).
const BLENDER_TIPS = `<details class="model-picker-tips"><summary>Blender export tips</summary><ol>
    <li><b>Facing:</b> point the nose toward Blender's <b>−Y</b> (it faces you in Front view, numpad 1), top toward <b>+Z</b>. Apply rotation and scale (Ctrl+A).</li>
    <li><b>Export:</b> File › Export › glTF 2.0 › format <b>glTF Binary (.glb)</b>; Include › <b>Selected Objects</b>; Transform › <b>+Y Up</b> on. Turning on Draco compression makes the file smaller.</li>
    <li><b>Size:</b> any units — the app scales every model to its class (capital, escort, craft). Use SIZE × above to fine-tune.</li>
    <li><b>Budgets:</b> FULL up to ~50k triangles, LITE ~5–10k (Decimate modifier). Keep files well under 5 MB (10 MB is the upload cap). Plain colours or one small texture; no lights or cameras.</li>
    <li><b>Wrong way round?</b> Fix it with TURN above instead of re-exporting.</li>
</ol></details>`;
window.ensureModelPicker = function (prefix, data) {
    const isDm = typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
    let box = document.getElementById(`${prefix}-model`);
    if (!isDm) { if (box) box.remove(); return; }
    data = data || {};
    if (!box) {
        const anchor = document.getElementById(`${prefix}-media`);
        if (!anchor || !anchor.parentNode) return;
        box = document.createElement('div');
        box.id = `${prefix}-model`;
        box.className = 'model-picker';
        anchor.parentNode.insertBefore(box, anchor.nextSibling);
    }
    const yaw = [0, 90, 180, 270].includes(Number(data.model_yaw_offset)) ? Number(data.model_yaw_offset) : 0;
    const scale = Number(data.model_scale) > 0 ? Number(data.model_scale) : 1;
    box.innerHTML = `
        <div class="model-picker-title">🛰 3D model — Battle Map 3D view (DM only)</div>
        ${['full', 'lite'].map(k => {
            const ref = k === 'full' ? data.model_url : data.model_lite_url;
            return `<div class="model-picker-row">
                <span class="model-picker-k">${k === 'full' ? 'FULL' : 'LITE'}</span>
                <span class="model-picker-v" id="${prefix}-model-${k}-label">${esc(refLabel(ref))}</span>
                <input type="hidden" id="${prefix}-model-${k}" value="${esc(ref || '')}">
                <button type="button" class="layer-edit" onclick="document.getElementById('${prefix}-model-${k}-file').click()">⬆ .glb</button>
                <input type="file" id="${prefix}-model-${k}-file" accept=".glb,model/gltf-binary" style="display:none;" onchange="window.handleModelPickerUpload('${prefix}', '${k}', this)">
                <button type="button" class="layer-del" title="Remove" onclick="window.setModelPickerValue('${prefix}', '${k}', '')">✕</button>
            </div>`;
        }).join('')}
        <div class="model-picker-row">
            <label class="model-picker-k" for="${prefix}-model-yaw">TURN</label>
            <select id="${prefix}-model-yaw" title="Use this if the model faces the wrong way on the grid">
                ${[0, 90, 180, 270].map(d => `<option value="${d}" ${d === yaw ? 'selected' : ''}>${d}°</option>`).join('')}
            </select>
            <label class="model-picker-k" for="${prefix}-model-scale">SIZE ×</label>
            <input type="number" id="${prefix}-model-scale" min="0.25" max="4" step="0.05" value="${scale}" title="1 = the normal size for its class; bigger or smaller to taste">
        </div>
        <div class="model-picker-help" id="${prefix}-model-status">FULL is shown on HIGH quality, LITE on LOW / phones (FULL is used if LITE is empty). Make the files with the ship converter, or export from Blender (tips below).</div>
        ${BLENDER_TIPS}`;
};
window.setModelPickerValue = function (prefix, k, ref) {
    const input = document.getElementById(`${prefix}-model-${k}`);
    const label = document.getElementById(`${prefix}-model-${k}-label`);
    if (input) input.value = ref || '';
    if (label) label.textContent = refLabel(ref);
};
window.handleModelPickerUpload = async function (prefix, k, input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    const status = document.getElementById(`${prefix}-model-status`);
    if (status) status.textContent = `⏳ Uploading ${file.name}…`;
    try {
        const ref = await window.uploadShipModel(file);
        window.setModelPickerValue(prefix, k, ref);
        if (status) status.textContent = `✓ ${file.name} uploaded (${(file.size / 1024).toFixed(0)} KB) — press SAVE to keep it.`;
    } catch (err) {
        if (status) status.textContent = '⚠ ' + err.message;
    } finally { input.value = ''; }
};
/* Model follow-through (2026-10-04, DM): a ship gets its design's model
   copied at deploy, so a model added to a design later never reached ships
   already deployed from it. Ships now remember their design
   (ship_markers.template_id, set by deployShipTemplate; older ships were
   back-filled by name). After a design's model changes, this offers to copy
   it to those ships -- skipping any ship that carries its OWN different model
   (a per-ship override set in EDIT BASE STATS). `before` = the design's
   model fields before the save. Returns how many ships were updated. */
const MODEL_KEYS = ['model_url', 'model_lite_url', 'model_yaw_offset', 'model_scale'];
// A ship counts as "using the design's model" when it has the same FILES
// (turn / size may differ -- fixing those is what this is usually for).
const fileSig = (o) => o ? JSON.stringify([o.model_url || null, o.model_lite_url || null]) : '';
const modelSig = (o) => o ? JSON.stringify([o.model_url || null, o.model_lite_url || null, Number(o.model_yaw_offset) || 0, Number(o.model_scale) || 1]) : '';
window.offerModelToDeployedShips = async function (template, before, after) {
    if (!template || !after || currentUserRole !== 'dm') return 0;
    if (modelSig(before) === modelSig(after)) return 0;
    const ships = (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).filter(m =>
        m.template_id === template.id && !m.is_strike_craft &&
        ((!m.model_url && !m.model_lite_url) || fileSig(m) === fileSig(before)));
    if (ships.length === 0) return 0;
    const n = ships.length;
    const ask = `Apply this 3D model to the ${n} ship${n === 1 ? '' : 's'} already deployed from "${template.name}"? (Ships with their own different model are left alone.)`;
    const ok = typeof window.showConfirmModal === 'function' ? await window.showConfirmModal(ask) : window.confirm(ask);
    if (!ok) return 0;
    const fields = {};
    MODEL_KEYS.forEach(k => { fields[k] = after[k] === undefined ? null : after[k]; });
    const { error } = await db.from('ship_markers').update(fields).in('id', ships.map(m => m.id));
    if (error) { alert('Failed to update the deployed ships: ' + error.message); return 0; }
    ships.forEach(m => Object.assign(m, fields));
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
    return n;
};
window.readModelPicker = function (prefix) {
    if (!document.getElementById(`${prefix}-model`)) return undefined;
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const full = val(`${prefix}-model-full`), lite = val(`${prefix}-model-lite`);
    const scale = parseFloat(val(`${prefix}-model-scale`));
    return {
        model_url: window.isModelRef(full) ? full : null,
        model_lite_url: window.isModelRef(lite) ? lite : null,
        model_yaw_offset: [0, 90, 180, 270].includes(parseInt(val(`${prefix}-model-yaw`), 10)) ? parseInt(val(`${prefix}-model-yaw`), 10) : 0,
        model_scale: scale > 0 ? Math.max(0.25, Math.min(4, scale)) : 1
    };
};
})();
