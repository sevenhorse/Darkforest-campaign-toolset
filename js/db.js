/* ==========================================================================
   js/db.js - Core State, Auth & Database Sync
   ========================================================================== */
console.log('%c [SYSTEM] DB.JS LOADED SUCCESSFULLY', 'color: #00e5a3; font-weight: bold; font-size: 14px;');

const SUPABASE_URL = 'https://uodeeyfaizbjplvvslry.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7Kj1D_Frh3v0MLNuAyyROQ_rcaTx2F8';

/* --- SHARED BACKEND HELPERS ---
   Small, dependency-free utilities used across the app. Defined here because
   db.js is the first app script index.html loads, so every other file can
   rely on them existing. Nothing here touches the database or the UI style.
   - safeJsonParse / safeLocalGet: localStorage reads that can't throw (a
     throw during this file's top-level setup kills the whole app).
   - escapeHtml: for putting user-typed text into innerHTML safely.
   - coalesceAsync: wraps an async loader so overlapping calls share one
     in-flight run plus at most one trailing re-run, instead of N parallel
     fetches racing to overwrite each other with stale results.
   - serializeAsync: wraps an async function so calls run one-at-a-time in
     arrival order (used for the time-advancement tick).
   - preserveFormState: re-render a container via innerHTML without wiping
     the user's in-progress dropdown/input choices that match a selector. */
window.safeJsonParse = function(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    try { const v = JSON.parse(raw); return (v === null || v === undefined) ? fallback : v; } catch (e) { return fallback; }
};
window.safeLocalGet = function(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw === null ? fallback : raw; } catch (e) { return fallback; }
};
// Browsers that block storage (some private modes) throw on any localStorage
// access; these never throw, so a blocked store can't stop the app starting.
window.safeLocalSet = function(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
};
window.safeLocalRemove = function(key) {
    try { localStorage.removeItem(key); } catch (e) {}
};
window.escapeHtml = function(str) {
    return String(str === null || str === undefined ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};
window.coalesceAsync = function(fn) {
    let running = null, trailing = null;
    const wrapped = function(...args) {
        if (!running) {
            running = Promise.resolve().then(() => fn.apply(this, args)).finally(() => { running = null; });
            return running;
        }
        if (!trailing) {
            trailing = running.catch(() => {}).then(() => { trailing = null; return wrapped.apply(this, args); });
        }
        return trailing;
    };
    return wrapped;
};
window.serializeAsync = function(fn, label) {
    let chain = Promise.resolve();
    return function(...args) {
        const run = chain.then(() => fn.apply(this, args));
        chain = run.catch(err => console.error(`${label || 'serializeAsync'}: run failed`, err));
        return run;
    };
};
window.preserveFormState = function(container, render, selector) {
    if (!container) { render(); return; }
    const saved = [];
    container.querySelectorAll(selector || 'select[id], input[id]').forEach(el => {
        if (!el.id) return;
        saved.push({ id: el.id, isCheck: el.type === 'checkbox' || el.type === 'radio', value: el.value, checked: el.checked, isSelect: el.tagName === 'SELECT' });
    });
    render();
    // Two passes: selects whose own onchange rebuilds sibling controls
    // (squadron weapon pickers) are restored first and their change
    // handler re-fired, so the dependent controls exist before pass two.
    const apply = (s) => {
        const el = document.getElementById(s.id);
        if (!el || !container.contains(el)) return false;
        if (s.isCheck) { el.checked = s.checked; return false; }
        if (s.isSelect) {
            if (el.value === s.value || !Array.from(el.options).some(o => o.value === s.value)) return false;
            el.value = s.value; return true;
        }
        if (el.value !== s.value) el.value = s.value;
        return false;
    };
    saved.filter(s => s.id.startsWith('sq-wpn-select-')).forEach(s => { if (apply(s)) document.getElementById(s.id).dispatchEvent(new Event('change')); });
    saved.filter(s => !s.id.startsWith('sq-wpn-select-')).forEach(apply);
};

/* --- MEDIA IMAGES ---
   Images on Codex entries and ships. An image can be either
   UPLOADED (shrunk to max 1600px, stored in the PRIVATE Supabase Storage
   bucket 'media' -- only logged-in users can load it, via short-lived
   signed links) or a PASTED https:// link. Who can set one = whoever can
   already edit that Codex entry / ship.

   One stored value ("media ref") covers both:
     'https://...'          -> an outside link, used as-is
     'storage:<path>'       -> an uploaded file in the 'media' bucket
   Images on screen are written as <img data-media-ref="..."> with no src;
   one watcher (below) notices them and fills in the real (signed) address,
   so every screen that shows an image just writes that one attribute.
   Click any such image to open it full-size (window.openImageLightbox). */
const MEDIA_BUCKET = 'media';
const MEDIA_MAX_PX = 1600;
const mediaSignedUrlCache = {}; // path -> { url, exp, pending }

window.isMediaRef = function(ref) {
    return typeof ref === 'string' && (/^https:\/\/\S+$/i.test(ref) || /^storage:[\w\-./]+$/.test(ref) || isInlineImageRef(ref));
};
// Older Codex picture *attachments* are stored inline (data:image/...;base64);
// accepted for DISPLAY so they can show as thumbnails / in the popup.
function isInlineImageRef(ref) {
    return typeof ref === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(ref);
}
window.resolveMediaUrl = async function(ref) {
    if (!window.isMediaRef(ref)) return null;
    if (/^https:/i.test(ref) || isInlineImageRef(ref)) return ref;
    const path = ref.slice('storage:'.length);
    const hit = mediaSignedUrlCache[path];
    if (hit && hit.url && hit.exp > Date.now()) return hit.url;
    if (hit && hit.pending) return hit.pending;
    const pending = (async () => {
        try {
            const { data, error } = await db.storage.from(MEDIA_BUCKET).createSignedUrl(path, 3600);
            if (error || !data) { console.warn('media: could not get a link for', path, error); return null; }
            mediaSignedUrlCache[path] = { url: data.signedUrl, exp: Date.now() + 55 * 60 * 1000 };
            return data.signedUrl;
        } catch (err) { console.warn('media: link request failed', err); return null; }
        finally { if (mediaSignedUrlCache[path]) delete mediaSignedUrlCache[path].pending; }
    })();
    mediaSignedUrlCache[path] = Object.assign(mediaSignedUrlCache[path] || {}, { pending });
    return pending;
};

// Fill in any <img data-media-ref> that doesn't have its real address yet.
window.hydrateMediaImages = function(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const imgs = [];
    if (scope.matches && scope.matches('img[data-media-ref]')) imgs.push(scope);
    scope.querySelectorAll('img[data-media-ref]').forEach(el => imgs.push(el));
    imgs.forEach(img => {
        const ref = img.getAttribute('data-media-ref');
        if (!ref || img.getAttribute('data-media-loaded') === ref) return;
        img.setAttribute('data-media-loaded', ref);
        window.resolveMediaUrl(ref).then(url => {
            if (img.getAttribute('data-media-ref') !== ref) return; // changed while loading
            img.style.visibility = '';
            if (!url) { showMediaUnavailable(img); return; }
            // A link that isn't really a picture (e.g. a web page) or a host
            // that blocks embedding loads as a broken image -- show a clear
            // "unavailable" tile instead of the browser's broken-icon.
            img.onerror = () => showMediaUnavailable(img);
            img.src = url;
        });
    });
};
if (typeof MutationObserver !== 'undefined') {
    const startMediaObserver = () => {
        new MutationObserver(muts => {
            for (const m of muts) {
                if (m.type === 'attributes') { window.hydrateMediaImages(m.target); continue; }
                m.addedNodes.forEach(n => { if (n.nodeType === 1) window.hydrateMediaImages(n); });
            }
        }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-media-ref'] });
        window.hydrateMediaImages(document);
    };
    if (document.body) startMediaObserver(); else document.addEventListener('DOMContentLoaded', startMediaObserver);
}

// Tidy stand-in for an image that can't be shown (bad link, blocked host,
// deleted upload). Inline SVG, so it never needs the network itself.
const MEDIA_UNAVAILABLE_SRC = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill="#040605"/>' +
    '<rect x="6" y="6" width="108" height="108" fill="none" stroke="#3c4e36" stroke-dasharray="6 4"/>' +
    '<text x="60" y="58" fill="#6b826a" font-family="monospace" font-size="13" text-anchor="middle">IMAGE</text>' +
    '<text x="60" y="76" fill="#6b826a" font-family="monospace" font-size="13" text-anchor="middle">UNAVAILABLE</text></svg>');
function showMediaUnavailable(img) {
    img.onerror = null;
    img.src = MEDIA_UNAVAILABLE_SRC;
    img.setAttribute('data-media-broken', '1');
    img.title = "Image unavailable — the link may be broken, blocked by its website, or not a direct link to a picture.";
}

// Checks that a pasted link really loads as a picture (not a web page, and
// not blocked by its host). Resolves true/false; gives up after 10s.
window.probeImageUrl = function(url) {
    return new Promise(resolve => {
        const probe = new Image();
        let done = false;
        const finish = (ok) => { if (done) return; done = true; clearTimeout(t); probe.onload = probe.onerror = null; resolve(ok); };
        const t = setTimeout(() => finish(false), 10000);
        probe.onload = () => finish(probe.naturalWidth > 0);
        probe.onerror = () => finish(false);
        probe.src = url;
    });
};

// Small clickable thumbnail markup for any screen. Empty string if no image.
window.mediaThumbHtml = function(ref, opts) {
    if (!window.isMediaRef(ref)) return '';
    opts = opts || {};
    const size = opts.size || 40;
    const esc = window.escapeHtml;
    const caption = esc(opts.caption || '');
    return `<img data-media-ref="${esc(ref)}" alt="${caption}" title="${caption ? caption + ' — ' : ''}click to enlarge" onclick="event.stopPropagation(); window.openImageLightbox(this.getAttribute('data-media-ref'), this.getAttribute('alt'))" style="width:${opts.width || size}px; height:${size}px; object-fit:cover; border:1px solid #3c4e36; border-radius:2px; background:#040605; cursor:zoom-in; flex-shrink:0; ${opts.style || ''}">`;
};

// Full-size popup. Click anywhere, the ✕, or press Esc to close.
window.openImageLightbox = function(ref, caption) {
    if (!window.isMediaRef(ref)) return;
    let box = document.getElementById('media-lightbox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'media-lightbox';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.style.cssText = 'position:fixed; inset:0; z-index:13000; background:rgba(2,3,4,0.92); display:none; flex-direction:column; align-items:center; justify-content:center; padding:16px; box-sizing:border-box; cursor:zoom-out;';
        box.innerHTML = `<button type="button" id="media-lightbox-close" aria-label="Close image" style="position:absolute; top:12px; right:12px; width:auto; padding:4px 10px; font-size:12px;">✕</button>
            <img id="media-lightbox-img" alt="" style="max-width:100%; max-height:85vh; object-fit:contain; border:1px solid #3c4e36; background:#040605;">
            <div id="media-lightbox-caption" style="margin-top:10px; font-size:12px; color:#d4c5a9; text-align:center;"></div>`;
        document.body.appendChild(box);
        const close = () => { box.style.display = 'none'; };
        box.addEventListener('click', close);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && box.style.display !== 'none') close(); });
    }
    const img = document.getElementById('media-lightbox-img');
    img.removeAttribute('src');
    img.alt = caption || '';
    img.setAttribute('data-media-ref', ref);
    img.removeAttribute('data-media-loaded');
    window.hydrateMediaImages(img);
    const cap = document.getElementById('media-lightbox-caption');
    cap.textContent = caption || '';
    img.onload = () => { if (img.getAttribute('data-media-broken')) cap.textContent = (caption ? caption + ' — ' : '') + 'this image is unavailable (bad link, blocked by its website, or not a direct link to a picture).'; };
    box.style.display = 'flex';
    document.getElementById('media-lightbox-close').focus();
};

// Shrink an image file (max 1600px on the long side) and upload it.
// Returns a 'storage:<path>' ref, or throws with a readable message.
window.uploadMediaImage = async function(file, folder) {
    if (!file || !/^image\//.test(file.type)) throw new Error('That file is not an image.');
    const bitmapUrl = URL.createObjectURL(file);
    let blob, ext;
    try {
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that image.')); i.src = bitmapUrl; });
        const scale = Math.min(1, MEDIA_MAX_PX / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale)), h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const keepPng = file.type === 'image/png'; // keep transparency for PNGs (ship cut-outs, logos)
        if (!keepPng) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(img, 0, 0, w, h);
        ext = keepPng ? 'png' : 'jpg';
        blob = await new Promise(res => canvas.toBlob(res, keepPng ? 'image/png' : 'image/jpeg', 0.86));
        if (!blob) throw new Error('Could not process that image.');
    } finally { URL.revokeObjectURL(bitmapUrl); }
    if (blob.size > 5 * 1024 * 1024) throw new Error('Image is still over 5 MB after shrinking -- try a smaller one.');
    const safeFolder = String(folder || 'misc').replace(/[^\w\-]/g, '');
    const path = `${safeFolder}/${currentUserId || 'anon'}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await db.storage.from(MEDIA_BUCKET).upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) throw new Error('Upload failed: ' + error.message);
    return 'storage:' + path;
};

// Reusable image field for forms: preview + UPLOAD + "or paste a link" + clear.
// The chosen value lives in a hidden input #<prefix>-media-ref; read it with
// window.getMediaPickerValue(prefix).
window.renderMediaPickerHtml = function(prefix, currentRef, label) {
    const esc = window.escapeHtml;
    const ref = window.isMediaRef(currentRef) ? currentRef : '';
    const urlVal = /^https:/i.test(ref) ? ref : '';
    return `<div class="media-picker" id="${prefix}-media" style="margin-top:6px;">
        <label for="${prefix}-media-url" style="font-size:9px; color:#6b826a; display:block;">${esc(label || 'Image (optional)')}</label>
        <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
            <img id="${prefix}-media-preview" ${ref ? `data-media-ref="${esc(ref)}"` : ''} alt="Image preview" onclick="window.openImageLightbox(document.getElementById('${prefix}-media-ref').value, 'Preview')" style="width:44px; height:44px; object-fit:cover; border:1px solid #3c4e36; background:#040605; cursor:zoom-in; ${ref ? '' : 'display:none;'}">
            <button type="button" class="layer-edit" onclick="document.getElementById('${prefix}-media-file').click()" style="width:auto; font-size:9px; padding:3px 8px; margin:0;">📷 UPLOAD</button>
            <input type="file" id="${prefix}-media-file" accept="image/*" style="display:none;" onchange="window.handleMediaPickerUpload('${prefix}', this)">
            <input type="text" inputmode="url" autocomplete="off" id="${prefix}-media-url" value="${esc(urlVal)}" placeholder="or paste an image link (https://…)" oninput="window.setMediaPickerValue('${prefix}', this.value.trim(), true)" style="flex:1; min-width:140px; font-size:10px; margin:0;">
            <button type="button" class="layer-del" onclick="window.setMediaPickerValue('${prefix}', '')" title="Remove image" style="width:auto; font-size:9px; padding:3px 6px; margin:0;">✕</button>
        </div>
        <input type="hidden" id="${prefix}-media-ref" value="${esc(ref)}">
        <div id="${prefix}-media-status" style="font-size:9px; color:#6b826a; margin-top:2px;"></div>
    </div>`;
};
const mediaPickerProbeSeq = {};
window.setMediaPickerValue = function(prefix, ref, fromUrlBox) {
    const hidden = document.getElementById(`${prefix}-media-ref`);
    const preview = document.getElementById(`${prefix}-media-preview`);
    const urlBox = document.getElementById(`${prefix}-media-url`);
    const status = document.getElementById(`${prefix}-media-status`);
    if (!hidden) return;
    const valid = window.isMediaRef(ref);
    if (fromUrlBox && ref && !valid) { hidden.value = ''; if (preview) preview.style.display = 'none'; if (status) status.textContent = 'Links must start with https://'; return; }
    // A pasted link is only accepted once it actually loads as a picture
    // (a web page link or a host that blocks embedding would just show
    // "unavailable" everywhere).
    if (fromUrlBox && valid) {
        const seq = (mediaPickerProbeSeq[prefix] || 0) + 1;
        mediaPickerProbeSeq[prefix] = seq;
        hidden.value = '';
        if (preview) { preview.style.display = 'none'; }
        if (status) status.textContent = '⏳ Checking link…';
        window.probeImageUrl(ref).then(ok => {
            if (mediaPickerProbeSeq[prefix] !== seq) return; // typed something newer since
            if (ok) { window.setMediaPickerValue(prefix, ref, false); if (status) status.textContent = '✓ Link works'; }
            else if (status) status.textContent = "✗ That link didn't load as a picture. Use the image's own address: right-click the picture → \"Copy image address\" (on a phone: long-press → Copy image link), or upload the file instead.";
        });
        return;
    }
    mediaPickerProbeSeq[prefix] = (mediaPickerProbeSeq[prefix] || 0) + 1; // cancel any pending check
    hidden.value = valid ? ref : '';
    if (urlBox && !fromUrlBox) urlBox.value = /^https:/i.test(hidden.value) ? hidden.value : '';
    if (status) status.textContent = hidden.value.startsWith('storage:') ? '✓ Uploaded image attached' : '';
    if (preview) {
        if (hidden.value) { preview.style.display = ''; preview.removeAttribute('data-media-loaded'); preview.setAttribute('data-media-ref', hidden.value); window.hydrateMediaImages(preview); }
        else { preview.style.display = 'none'; preview.removeAttribute('data-media-ref'); preview.removeAttribute('src'); }
    }
};
window.getMediaPickerValue = function(prefix) {
    const hidden = document.getElementById(`${prefix}-media-ref`);
    const v = hidden ? hidden.value.trim() : '';
    return window.isMediaRef(v) ? v : null;
};
window.handleMediaPickerUpload = async function(prefix, input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    const status = document.getElementById(`${prefix}-media-status`);
    if (status) status.textContent = '⏳ Uploading…';
    try {
        const ref = await window.uploadMediaImage(file, prefix.split('-')[0]);
        window.setMediaPickerValue(prefix, ref);
    } catch (err) {
        if (status) status.textContent = '⚠ ' + err.message;
    } finally { input.value = ''; }
};

/* --- FEATURE SWITCHES ---
   DM-controlled switches that keep new, unfinished features hidden from
   players until the DM unlocks them. Backed by the `app_settings` table
   (one row per feature: feature_key, mode, tester_ids). RLS: everyone
   logged in can READ it, only the DM can WRITE it (same role check as
   saved_fleets). Streams over realtime, so flipping a switch takes effect
   on every open browser without a redeploy.

   Modes: 'off' (nobody), 'dm' (DM only), 'testers' (DM + the picked
   tester accounts), 'everyone'. An unknown key counts as OFF -- a missing
   row can never expose anything.

   HONOR SYSTEM, same trust model as the rest of this app: the code for a
   hidden feature still downloads to every browser, so a player poking in
   devtools could force it on for themselves. Anything that must be truly
   secret lives in DM-only tables instead (e.g. encounter presets). */
// Build stamp (YYYY-MM-DD.NN). Compared with app_settings 'min_client_build'
// to force stale browsers to reload: bump it on every deploy that changes how
// data is stored, then (once live) raise min_client_build to match, so older
// cached copies show a "reload" banner instead of writing incompatible data.
window.DARKFOREST_BUILD = '2026-10-09.01';
window.appSettingsCache = {};
window.isFeatureOn = function(key) {
    const row = window.appSettingsCache[key];
    if (!row) return false;
    const isDm = (typeof currentUserRole !== 'undefined') && currentUserRole === 'dm';
    switch (row.mode) {
        case 'everyone': return true;
        case 'testers': return isDm || (Array.isArray(row.tester_ids) && typeof currentUserId !== 'undefined' && row.tester_ids.includes(currentUserId));
        case 'dm': return isDm;
        default: return false;
    }
};
window.loadAppSettings = async function() {
    const { data, error } = await db.from('app_settings').select('*');
    if (error) { console.error('loadAppSettings failed', error); return; }
    const next = {};
    (data || []).forEach(r => { next[r.feature_key] = r; });
    window.appSettingsCache = next;
    window.checkClientBuildIsCurrent();
    if (typeof window.renderFeatureSwitchPanel === 'function') window.renderFeatureSwitchPanel();
    // Anything gated by a switch re-checks itself on this event.
    document.dispatchEvent(new CustomEvent('darkforest:features-changed'));
};
window.checkClientBuildIsCurrent = function() {
    const row = window.appSettingsCache['min_client_build'];
    const min = row && row.value;
    const stale = !!min && String(min) > String(window.DARKFOREST_BUILD);
    let banner = document.getElementById('stale-build-banner');
    if (!stale) { if (banner) banner.remove(); return false; }
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'stale-build-banner';
        banner.setAttribute('role', 'alert');
        banner.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:20000; background:#3a0d0d; color:#ffd2d2; border-bottom:2px solid #ff3333; padding:8px 12px; font-size:12px; text-align:center; font-family:inherit;';
        banner.innerHTML = '⚠ A newer version of Darkforest is live. Reload this page to keep playing in sync (Ctrl+F5 on PC; pull down to refresh on a phone). <button type="button" onclick="location.reload()" style="margin-left:8px; font-size:11px; width:auto;">RELOAD NOW</button>';
        document.body.appendChild(banner);
    }
    return true;
};
let appSettingsRealtimeChannel = null;
window.initAppSettingsRealtimeChannel = function() {
    if (appSettingsRealtimeChannel) return;
    appSettingsRealtimeChannel = db.channel('app_settings_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, () => { window.loadAppSettings(); })
        .subscribe();
};
window.setFeatureMode = async function(key, mode) {
    if (currentUserRole !== 'dm') return;
    const { error } = await db.from('app_settings').update({ mode, updated_at: new Date().toISOString() }).eq('feature_key', key);
    if (error) { alert('Failed to change feature switch: ' + error.message); return; }
    if (window.appSettingsCache[key]) window.appSettingsCache[key].mode = mode;
    window.loadAppSettings();
};
window.toggleFeatureTester = async function(key, profileId, on) {
    if (currentUserRole !== 'dm') return;
    const row = window.appSettingsCache[key];
    if (!row) return;
    const ids = new Set(row.tester_ids || []);
    if (on) ids.add(profileId); else ids.delete(profileId);
    const tester_ids = Array.from(ids);
    const { error } = await db.from('app_settings').update({ tester_ids, updated_at: new Date().toISOString() }).eq('feature_key', key);
    if (error) { alert('Failed to update testers: ' + error.message); return; }
    row.tester_ids = tester_ids;
    window.loadAppSettings();
};
// DM Tools -> MAINT -> Feature Switches box (#feature-switch-list).
window.renderFeatureSwitchPanel = function() {
    const box = document.getElementById('feature-switch-list');
    if (!box || currentUserRole !== 'dm') return;
    const keys = Object.keys(window.appSettingsCache).filter(k => k !== 'min_client_build' && !/_config$/.test(k)).sort(); // *_config rows hold numbers, not switches
    if (keys.length === 0) { box.innerHTML = '<div style="font-size:9px; color:#6b826a;">No feature switches found.</div>' + window.combatBalancePanelHtml(); return; }
    const players = (typeof allProfiles !== 'undefined' ? allProfiles : []).filter(p => p.role !== 'dm');
    const modeLabels = { off: 'OFF', dm: 'DM ONLY', testers: 'TESTERS', everyone: 'EVERYONE' };
    box.innerHTML = keys.map(key => {
        const row = window.appSettingsCache[key];
        const esc = window.escapeHtml;
        const opts = Object.keys(modeLabels).map(m => `<option value="${m}" ${row.mode === m ? 'selected' : ''}>${modeLabels[m]}</option>`).join('');
        const testers = row.mode === 'testers' ? `<div style="margin-top:4px; display:flex; flex-wrap:wrap; gap:6px;">${players.map(p => {
            const checked = (row.tester_ids || []).includes(p.id) ? 'checked' : '';
            const name = esc(p.username || (p.character && p.character.name) || 'player');
            return `<label style="font-size:9px; color:#d4c5a9;"><input type="checkbox" ${checked} onchange="window.toggleFeatureTester('${esc(key)}', '${p.id}', this.checked)"> ${name}</label>`;
        }).join('') || '<span style="font-size:9px; color:#6b826a;">No player accounts.</span>'}</div>` : '';
        return `<div style="border:1px solid #2a3a2a; padding:6px; margin-bottom:6px; background:#050805;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                <div><div style="font-size:10px; color:#00e5a3; font-weight:bold;">${esc(key)}</div>
                <div style="font-size:9px; color:#6b826a;">${esc(row.description || '')}</div></div>
                <label for="feature-mode-${esc(key)}" style="display:none;">Mode for ${esc(key)}</label>
                <select id="feature-mode-${esc(key)}" onchange="window.setFeatureMode('${esc(key)}', this.value)" style="font-size:10px; width:auto;">${opts}</select>
            </div>${testers}
        </div>`;
    }).join('') + window.combatBalancePanelHtml();
};
// DM panel for the hidden damage bonus knob
// (app_settings 'combat_balance_config', read by window.combatBalanceConfig).
window.combatBalancePanelHtml = function() {
    if (!window.appSettingsCache || !window.appSettingsCache.combat_balance_config || typeof window.combatBalanceConfig !== 'function') return '';
    const pct = window.combatBalanceConfig().damage_bonus_pct;
    return `<div style="border:1px solid #2a3a2a; padding:6px; margin-bottom:6px; background:#050805;">
        <div style="font-size:10px; color:#00e5a3; font-weight:bold;">Combat balance</div>
        <div style="font-size:9px; color:#6b826a;">Hidden damage bonus on every ship and strike craft weapon roll, as a % of the dice average (100 = 1d10 gets +5). Players never see it. 0 turns it off.</div>
        <label style="font-size:10px; color:#d4c5a9;">Bonus % <input id="combat-bonus-pct" type="number" min="0" max="500" step="5" value="${pct}" style="width:70px; font-size:10px;"></label>
        <button type="button" onclick="window.saveCombatBalanceConfig()" style="font-size:9px; padding:2px 8px; width:auto;">SAVE</button>
    </div>`;
};
window.saveCombatBalanceConfig = async function() {
    if (currentUserRole !== 'dm') return;
    const el = document.getElementById('combat-bonus-pct');
    const pct = Math.max(0, Math.min(500, parseInt(el && el.value, 10) || 0));
    const value = JSON.stringify({ damage_bonus_pct: pct });
    const { error } = await db.from('app_settings').update({ value, updated_at: new Date().toISOString() }).eq('feature_key', 'combat_balance_config');
    if (error) { alert('Failed to save combat balance: ' + error.message); return; }
    if (window.appSettingsCache.combat_balance_config) window.appSettingsCache.combat_balance_config.value = value;
    if (el) { el.value = pct; const b = el.parentElement && el.parentElement.nextElementSibling; if (b) b.textContent = 'SAVED'; }
};

let db = null;
if (window.supabase) {
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
    console.error("CRITICAL ERROR: Supabase CDN failed to load. Check internet connection or AdBlockers.");
}

// Session restore on refresh: Supabase persists the session in localStorage,
// so at boot an existing session skips straight into fetchUserProfile, the
// same as a fresh login.
document.addEventListener('DOMContentLoaded', async function checkExistingSession() {
    // #login-wrapper defaults to display:none in CSS (avoids a login-form
    // flash for restored sessions), so every path here that does NOT reach
    // fetchUserProfile must reveal it -- nothing else will.
    const showLogin = () => {
        const el = document.getElementById('login-wrapper');
        if (el) el.style.display = 'flex';
    };
    if (!db) { showLogin(); return; }
    const { data, error } = await db.auth.getSession();
    if (error) { console.error('Session check failed:', error.message); showLogin(); return; }
    if (data && data.session && data.session.user) {
        fetchUserProfile(data.session.user);
    } else {
        showLogin();
    }
});

let currentUserRole = 'player';
let currentUserId = null;
let currentUserEmail = '';
let realtimeChannel = null;
let presenceChannel = null;

let onlineUsersMap = {};
let allProfiles = [];
let playerNotesList = [];
let combatantsList = [];
let campaignObjectivesList = [];
let chatLogsList = [];
// Per-tab comms caches — General stays in chatLogsList (fetched fresh),
// Dice and each PM thread are fetched on demand so a busy Dice Streamer
// can't crowd General/PM history out of a shared row limit.
window.diceLogsList = null;
window.pmLogsCache = {};
window.pmPartnerIds = new Set();
let editingNoteId = null;

let bookmarkedTargets = window.safeJsonParse(window.safeLocalGet('odyssey_bookmarks', '[]'), []);
let recentTargets = window.safeJsonParse(window.safeLocalGet('odyssey_recents', '[]'), []);

// MODULE C: Fog of War DRADIS Scan State
window.scannedSystems = window.safeJsonParse(window.safeLocalGet('odyssey_scanned', '[]'), []);

// These live on window because every reader/writer uses window.X -- a
// top-level `let` in a classic script does NOT create a window property.
window.activeHudTab = 'telemetry';
let globalProceduralSystemsCache = [];
let globalShipMarkersCache = [];
let globalDbSystemsCache = [];
let globalTerritoriesCache = [];
let globalCodexEntriesCache = [];
let globalHyperlanesCache = [];
window.globalSystemHazardsCache = [];

window.editingCodexId = null;
let activeCargoSubtab = 'perishables'; // genuinely used bare (js/combat.js), keep as let
window.activeCodexCategory = 'factions';
window.codexSearchFilter = '';

window.hoveredTarget = null;
window.selectedTarget = null;

// Map tool state (measuring tape, ping, jump plotter, territory/hyperlane
// drawing, hyperlanesVisible) lives on window and is initialized at the top
// of js/map.js.

const driveSpeeds = {
    sublight: { name: "Sublight Thrusters (0.1c)", speed: 10, label: "0.1c Sublight" },
    ftl_class1: { name: "Standard Class 1 Warp Drive", speed: 250, label: "Class 1 Warp" },
    ftl_class2: { name: "Military Class 2 Hyperdrive", speed: 600, label: "Class 2 Hyperdrive" },
    ftl_fold: { name: "Experimental Fold/Jump Drive", speed: 2500, label: "Fold Jump" }
};
// Relativistic time-inversion constant (used by window.executePlottedJump in
// js/map.js). DM rule: a plotted FTL jump's backward chronometer drift =
// distance * drive speed / this constant, so faster drives drift MORE for
// the same distance. Sublight causes none by default (window.jumpInversionFtlOnly).
// Tuning: a Class 1 Warp jump between stars 4 LY apart (minimum spacing)
// drifts ~2 hours; a full galaxy-width jump ~128 hours (~5.3 days).
window.TEMPORAL_DRIFT_CONSTANT = 62500;

window.handleLogin = async function() {
    if (!db) { alert("Database connection failed."); return; }
    // Guards against a double-click starting two login flows, which would
    // create duplicate presence channels (pings would fire twice).
    if (window._loginInProgress) return;
    window._loginInProgress = true;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
        window._loginInProgress = false;
        const errorDiv = document.getElementById('error-message');
        if (errorDiv) { errorDiv.innerText = "Access Denied: " + error.message; errorDiv.style.display = 'block'; }
        return;
    }
    fetchUserProfile(data.user);
};

async function fetchUserProfile(user) {
    currentUserId = user.id; currentUserEmail = user.email;
    const { data, error } = await db.from('profiles').select('*').eq('id', user.id).single();
    // On failure, reset the login guard and show an error; otherwise every
    // later login click would silently no-op at handleLogin's guard.
    if (error) {
        window._loginInProgress = false;
        const errorDiv = document.getElementById('error-message');
        if (errorDiv) { errorDiv.innerText = "Access Denied: failed to load your profile (" + error.message + "). Please try again."; errorDiv.style.display = 'block'; }
        return;
    }

    currentUserRole = data.role;
    
    document.getElementById('login-wrapper').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    document.getElementById('user-role').innerText = `Role: ${data.role}`;
    
    if (data.role === 'dm') {
        document.getElementById('user-role').classList.add('role-dm');
        document.getElementById('user-role').innerText = 'OVERSEER (DM)';
        document.getElementById('dm-tools').style.display = 'block';
        // DM-only Command Terminal tabs (Secret Repository, Strike Craft).
        const secretRepoTabBtn = document.getElementById('term-tab-btn-secretrepo');
        if (secretRepoTabBtn) secretRepoTabBtn.style.display = 'flex';
        const strikeCraftTabBtn = document.getElementById('term-tab-btn-strikecraft');
        if (strikeCraftTabBtn) strikeCraftTabBtn.style.display = 'flex';
        document.getElementById('dm-time-controls-box').style.display = 'block';
        document.getElementById('dm-scratchpad-toggle-btn').style.display = 'inline-block';
        document.getElementById('territory-tool-toggle-btn').style.display = 'inline-block';
        document.getElementById('codex-dm-creator-panel').style.display = 'block';
        const cargoCatalogDmEditor = document.getElementById('cargo-catalog-dm-editor');
        if (cargoCatalogDmEditor) cargoCatalogDmEditor.style.display = 'block';
        document.getElementById('codex-permission-indicator').innerText = '● OVERSEER AUTHORIZATION';
        document.getElementById('codex-permission-indicator').style.color = '#ff6b6b';
        
        const savedScratch = window.safeLocalGet('odyssey_dm_scratchpad', null);
        if (savedScratch) document.getElementById('dm-scratchpad-input').value = savedScratch;
    }

    // Feature switches first, so anything gated by one renders correctly.
    window.initAppSettingsRealtimeChannel();
    window.loadAppSettings();
    initPresenceChannel(data);
    initChatRealtimeChannel();
    initCombatTrackerRealtimeChannel();
    initColoniesRealtimeChannel();
    initShipTemplatesRealtimeChannel();
    if (typeof initShipMarkersRealtimeChannel === 'function') initShipMarkersRealtimeChannel();
    initSystemHazardsRealtimeChannel();
    initPerkDefinitionsRealtimeChannel();
    if (typeof initAugmentDefinitionsRealtimeChannel === 'function') initAugmentDefinitionsRealtimeChannel();
    if (typeof initGearDefinitionsRealtimeChannel === 'function') initGearDefinitionsRealtimeChannel();
    initHazardDefinitionsRealtimeChannel();
    initPlanetaryModifiersRealtimeChannel();
    initPersonalLabelsRealtimeChannel();
    initHyperlanesRealtimeChannel();
    initSystemOwnershipRealtimeChannel();
    if (typeof initBattleEncountersRealtimeChannel === 'function') initBattleEncountersRealtimeChannel();
    if (typeof initBattlefieldSalvageRealtimeChannel === 'function') initBattlefieldSalvageRealtimeChannel();
    if (typeof initSavedFleetsRealtimeChannel === 'function') initSavedFleetsRealtimeChannel();
    if (typeof initManufacturingBlueprintsRealtimeChannel === 'function') initManufacturingBlueprintsRealtimeChannel();
    if (typeof initManufacturingOrdersRealtimeChannel === 'function') initManufacturingOrdersRealtimeChannel();
    if (typeof initGalaxyEngine === 'function') initGalaxyEngine();
    if (typeof initCalendarEngine === 'function') initCalendarEngine();
    // FOW reset sync: picks up any pending fow_reset_state epoch bump and
    // subscribes for live ones.
    if (typeof window.initFowResetSync === 'function') window.initFowResetSync();
    // Start the ambient music bed now: its tracks need signed URLs from a
    // private bucket, which only work once logged in.
    if (window.AudioEngine && !window.AudioEngine.isMuted()) window.AudioEngine.startAmbient();

    loadAllProfiles(); loadPlayerNotes(); loadCombatTracker(); loadCampaignObjectives();
    loadChatLogs(); loadPmPartnerList(); loadTerritories(); loadHyperlanes(); loadCodexEntries();
    if (typeof loadColonies === 'function') loadColonies();
    if (typeof loadFleetGroups === 'function') loadFleetGroups();
    if (typeof loadShipTemplates === 'function') loadShipTemplates();
    if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
    if (typeof loadSystemHazards === 'function') loadSystemHazards();
    if (typeof loadPerkDefinitions === 'function') loadPerkDefinitions();
    if (typeof loadAugmentDefinitions === 'function') loadAugmentDefinitions();
    if (typeof loadGearDefinitions === 'function') loadGearDefinitions();
    if (typeof window.loadStrikeCraftTemplates === 'function') window.loadStrikeCraftTemplates();
    if (typeof window.loadCargoItemCatalog === 'function') window.loadCargoItemCatalog();
    if (typeof loadHazardDefinitions === 'function') loadHazardDefinitions();
    if (typeof loadPlanetaryModifiers === 'function') loadPlanetaryModifiers();
    if (typeof loadPersonalLabels === 'function') loadPersonalLabels();
    loadSystemOwnershipOverrides();
    if (typeof loadBattleEncounters === 'function') loadBattleEncounters();
    if (typeof loadBattlefieldSalvage === 'function') loadBattlefieldSalvage();
    if (typeof loadSavedFleets === 'function') loadSavedFleets();
    if (typeof loadManufacturingBlueprints === 'function') loadManufacturingBlueprints();
    if (typeof loadManufacturingOrders === 'function') loadManufacturingOrders();
    // Player tutorial: auto-runs once per device for non-DM players on first
    // login -- see js/tutorial.js.
    if (typeof window.maybeAutoStartTutorial === 'function') window.maybeAutoStartTutorial();
}

async function loadAllProfiles() {
    const { data: profData } = await db.from('profiles').select('*');
    const { data: charData } = await db.from('characters').select('*');
    const { data: skillData } = await db.from('character_skills').select('*');
    const { data: arsenalData } = await db.from('character_arsenal').select('*');
    const { data: perkData } = await db.from('character_perks').select('*');
    const { data: augmentData } = await db.from('character_augments').select('*');
    const { data: gearData } = await db.from('character_gear').select('*');

    if (profData) {
        allProfiles = profData.map(p => {
            const c = charData?.find(char => char.profile_id === p.id) || {};
            const s = skillData?.find(sk => sk.character_id === c.id) || {};
            const a = arsenalData?.filter(ars => ars.profile_id === p.id || ars.character_id === c.id) || [];
            const pk = perkData?.filter(perk => perk.character_id === c.id) || [];
            const ag = augmentData?.filter(aug => aug.character_id === c.id) || [];
            const gr = gearData?.filter(g => g.character_id === c.id) || [];
            return { ...p, character: c, skills: s, arsenal: a, perks: pk, augments: ag, gear: gr };
        });
        
        if (typeof window.renderFeatureSwitchPanel === 'function') window.renderFeatureSwitchPanel(); // tester picker needs the player list
        const myProf = allProfiles.find(p => p.id === currentUserId);
        if (myProf) {
            document.getElementById('term-username').value = myProf.username || '';
            if (myProf.avatar_url) {
                document.getElementById('my-terminal-avatar-preview').src = myProf.avatar_url;
                document.getElementById('term-avatar').value = myProf.avatar_url;
            }
        }
        if (typeof window.renderCharacterTerminalData === 'function') window.renderCharacterTerminalData(); 
        if (typeof window.renderCrewRoster === 'function') window.renderCrewRoster();
        if (typeof populateCommsRecipients === 'function') populateCommsRecipients();
    }
}

async function loadPlayerNotes() {
    const { data } = await db.from('player_notes').select('*').order('created_at', { ascending: false });
    if (data) { playerNotesList = data; if (typeof renderTerminalNotes === 'function') renderTerminalNotes(); }
}

async function loadCombatTracker() {
    const { data } = await db.from('combat_tracker').select('*').order('initiative', { ascending: false });
    if (data) { combatantsList = data; if (typeof renderCombatTracker === 'function') renderCombatTracker(); }
}

async function loadCampaignObjectives() {
    const { data } = await db.from('campaign_objectives').select('*').order('created_at', { ascending: false });
    if (data) { campaignObjectivesList = data; if (typeof renderCampaignObjectives === 'function') renderCampaignObjectives(); }
}

window.checkSysScan = function(log) {
    let match = log.content.match(/\[SYS_SCAN:(.+?)\]/);
    if (match && !window.scannedSystems.includes(match[1])) {
        window.scannedSystems.push(match[1]);
        window.safeLocalSet('odyssey_scanned', JSON.stringify(window.scannedSystems));
        if (typeof renderCodexMatrix === 'function') renderCodexMatrix();
        return true;
    }
    return false;
};

async function loadChatLogs() {
    // "General Broadcast" channel only — dice rolls and PMs are fetched
    // separately (loadDiceLogs / loadPmLogs), each with their own limit.
    const { data } = await db.from('chat_logs').select('*')
        .is('recipient_id', null).neq('message_type', 'roll')
        .order('created_at', { ascending: false }).limit(75);
    if (data) { 
        chatLogsList = data.reverse(); 
        if (chatLogsList.length === 0) chatLogsList = [{ sender_id: null, content: '📡 [SYSTEM] Intrepid Horizon secure mainframe linked.', message_type: 'system' }];
        chatLogsList.forEach(log => window.checkSysScan(log));
        if (typeof renderChatFeed === 'function') renderChatFeed(); 
    }
}

async function loadDiceLogs() {
    const { data } = await db.from('chat_logs').select('*').eq('message_type', 'roll').order('created_at', { ascending: false }).limit(50);
    if (data) window.diceLogsList = data.reverse();
}

async function loadPmLogs(partnerId) {
    const { data } = await db.from('chat_logs').select('*')
        .or(`and(sender_id.eq.${currentUserId},recipient_id.eq.${partnerId}),and(sender_id.eq.${partnerId},recipient_id.eq.${currentUserId})`)
        .order('created_at', { ascending: false }).limit(50);
    if (data) window.pmLogsCache[partnerId] = data.reverse();
}

async function loadPmPartnerList() {
    // Lightweight metadata-only query (no message content) just to know which
    // PM tabs should exist — actual thread content loads lazily via loadPmLogs
    // the first time each tab is opened.
    const { data } = await db.from('chat_logs').select('sender_id, recipient_id')
        .or(`sender_id.eq.${currentUserId},recipient_id.eq.${currentUserId}`)
        .not('recipient_id', 'is', null);
    if (!data) return;
    data.forEach(row => {
        if (row.sender_id === currentUserId && row.recipient_id !== currentUserId) window.pmPartnerIds.add(row.recipient_id);
        else if (row.recipient_id === currentUserId && row.sender_id !== currentUserId) window.pmPartnerIds.add(row.sender_id);
    });
    if (typeof window.renderCommsTabBar === 'function') window.renderCommsTabBar();
}

async function loadTerritories() {
    const { data } = await db.from('territories').select('*').order('created_at', { ascending: true });
    if (data) { globalTerritoriesCache = data; if (typeof renderTerritoryList === 'function') renderTerritoryList(); }
}

async function loadHyperlanes() {
    const { data } = await db.from('hyperlanes').select('*');
    if (data) { globalHyperlanesCache = data; if (typeof renderHyperlaneList === 'function') renderHyperlaneList(); }
}

async function loadSystemHazards() {
    const { data } = await db.from('system_hazards').select('*');
    if (data) { window.globalSystemHazardsCache = data; if (typeof renderHazardZoneList === 'function') renderHazardZoneList(); }
}

// Hazard Designer catalog — reusable blueprints, separate from the placed
// instances above (system_hazards). See js/ui.js for the CRUD.
async function loadHazardDefinitions() {
    const { data } = await db.from('hazard_definitions').select('*').order('created_at', { ascending: true });
    if (data) { window.hazardDefinitionsList = data; if (typeof window.renderHazardDefinitionsPanel === 'function') window.renderHazardDefinitionsPanel(); if (typeof window.populateHazardDefSelect === 'function') window.populateHazardDefSelect(); }
}

// Overseer Planet Editor overrides. planetary_modifiers holds ONE override
// row per DM-edited body, keyed on body_id (text, no FK: most bodies are
// procedural, with no star_systems row). js/map.js merges these over a
// body's generated values on every read. Only custom_name/type/gravity/
// atmosphere/resources are used; the table's other columns (industry,
// control, defenses, wealth, tech_level, ...) aren't wired to any UI yet.
window.globalPlanetaryModifiersCache = {}; // keyed by body_id for O(1) lookup in getSystemBodies
async function loadPlanetaryModifiers() {
    const { data } = await db.from('planetary_modifiers').select('*');
    if (data) {
        window.globalPlanetaryModifiersCache = {};
        data.forEach(row => { window.globalPlanetaryModifiersCache[row.body_id] = row; });
        // Re-render if a body is currently on screen so a DM edit (this
        // client's own, or synced in from another) shows immediately.
        if (window.selectedTarget && window.selectedTarget.type === 'body' && typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    }
}

// Personal system/planet labels: a player's own rename, applied only in
// their own client. It takes precedence over a DM's custom_name/star name
// for that viewer, and never touches star_systems or planetary_modifiers.
// Cache key: `${target_type}:${target_id}` (target_id is TEXT, so uuids and
// procedural ids like 'proc-spiral-14' both work). RLS is the blanket
// "Allow Auth Users" policy, so isolation comes from the user_id filter
// here, not from RLS.
window.globalPersonalLabelsCache = {};
async function loadPersonalLabels() {
    if (!currentUserId) return;
    const { data } = await db.from('personal_labels').select('*').eq('user_id', currentUserId);
    if (data) {
        window.globalPersonalLabelsCache = {};
        data.forEach(row => { window.globalPersonalLabelsCache[`${row.target_type}:${row.target_id}`] = row.custom_name; });
        // Re-render whatever's currently on screen so a label set on
        // another of this same player's own devices/tabs shows up here too.
        if (window.selectedTarget && typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    }
}

// System ownership/control overrides for PROCEDURAL systems only (they
// have no star_systems row; custom systems use star_systems.ownership).
// window.applySystemOwnershipOverrides() (js/map.js) patches
// globalProceduralSystemsCache in place after each load, so `.ownership`
// reads the same for both kinds of system.
window.globalSystemOwnershipCache = {}; // keyed by system_id (procedural systems only) -> { ownership, control }
async function loadSystemOwnershipOverrides() {
    const { data } = await db.from('system_ownership_overrides').select('*');
    window.globalSystemOwnershipCache = {};
    if (data) data.forEach(row => { window.globalSystemOwnershipCache[row.system_id] = { ownership: row.ownership, control: row.control }; });
    if (typeof window.applySystemOwnershipOverrides === 'function') window.applySystemOwnershipOverrides();
    if (window.selectedTarget && window.selectedTarget.type === 'star' && typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
}

async function loadCodexEntries() {
    const { data } = await db.from('codex_entries').select('*').order('created_at', { ascending: false });
    if (data && data.length > 0) {
        globalCodexEntriesCache = data;
    } else {
        globalCodexEntriesCache = [{ id: 'cdx-1', category: 'factions', title: 'Task Force Black', subtitle: 'Allied Command', content: 'Autonomous fleet.' }];
    }
    if (typeof renderCodexMatrix === 'function') renderCodexMatrix();
    if (typeof populateTerritoryFactionSelect === 'function') populateTerritoryFactionSelect();
    if (typeof window.populateHyperlaneFactionSelect === 'function') window.populateHyperlaneFactionSelect();
}

async function checkAnomalyProximity(ship) {
    if (!ship) return;
    const DRADIS_RANGE = 180;
    let anomalies = globalDbSystemsCache.filter(s => s.luminosity === 'Hidden Anomaly');
    for (let anomaly of anomalies) {
        let dist = Math.hypot(ship.x - anomaly.x, ship.y - anomaly.y);
        if (dist < DRADIS_RANGE) {
            // Mark revealed locally BEFORE the awaits: this can be called
            // every movement tick, and overlapping calls must not repeat the
            // one-time reveal (update/chat log/klaxon).
            anomaly.luminosity = 'Revealed Anomaly'; anomaly.color = '#ff3333';
            await db.from('star_systems').update({ luminosity: 'Revealed Anomaly', color: '#ff3333' }).eq('id', anomaly.id);
            await db.from('chat_logs').insert({ sender_id: null, content: `🚨 [DRADIS ALERT] Vessel '${ship.name}' detected a subspace anomaly at X:${Math.round(anomaly.x)} Y:${Math.round(anomaly.y)}.`, message_type: 'system' });
            if (window.AudioEngine) window.AudioEngine.playKlaxon();
        }
    }
}

/* --- PRESENCE: ACTIVITY BLURB TRACKING ---
   Supabase presence .track() replaces the ENTIRE payload for a key on every
   call, it doesn't merge — so both the profile fields (username/role/avatar)
   and the current activity string have to be re-sent together every time
   either one changes, or the other silently disappears from presence state.
   Everything routes through trackMyPresence() so that never happens. */
window.myPresenceProfile = { username: '', role: '', avatar_url: '' };
window.myCurrentActivity = 'Monitoring DRADIS';

async function trackMyPresence() {
    if (!presenceChannel) return;
    await presenceChannel.track({
        online_at: new Date().toISOString(),
        username: window.myPresenceProfile.username || currentUserEmail.split('@')[0],
        role: window.myPresenceProfile.role || currentUserRole,
        avatar_url: window.myPresenceProfile.avatar_url || '',
        activity: window.myCurrentActivity
    });
}

function initPresenceChannel(userProfile) {
    if (presenceChannel) { try { presenceChannel.unsubscribe(); } catch (e) {} } // defends against duplicate channels if this ever gets called twice
    window.myPresenceProfile = { username: userProfile.username, role: userProfile.role, avatar_url: userProfile.avatar_url };
    presenceChannel = db.channel('online_map_users', { config: { presence: { key: currentUserId } } });
    realtimeChannel = presenceChannel;
    presenceChannel.on('presence', { event: 'sync' }, () => { 
        onlineUsersMap = presenceChannel.presenceState(); 
        if (typeof renderPresenceTicker === 'function') renderPresenceTicker(); 
    }).on('broadcast', { event: 'tactical_ping' }, ({ payload }) => {
        if (!payload) return;
        window.activePings.push({ x: payload.x, y: payload.y, color: payload.color, user: payload.username, startTime: Date.now() });
        if (window.AudioEngine) window.AudioEngine.playPing();
        if (typeof loadChatLogs === 'function') loadChatLogs();
    }).subscribe(async (status) => {
        if (status === 'SUBSCRIBED') { await trackMyPresence(); }
    });
}

// Re-track presence with fresh profile data (e.g. after a display handle change)
// so the Active Commanders ticker updates immediately instead of only on reload.
window.refreshMyPresence = async function(userProfile) {
    window.myPresenceProfile = { username: userProfile.username, role: userProfile.role || currentUserRole, avatar_url: userProfile.avatar_url };
    await trackMyPresence();
};

// Called whenever the user switches terminal tabs, opens/closes the terminal,
// etc. — see the TERM_TAB_ACTIVITY_LABELS hookup in ui.js.
window.broadcastActivity = async function(activityLabel) {
    if (!activityLabel || activityLabel === window.myCurrentActivity) return;
    window.myCurrentActivity = activityLabel;
    await trackMyPresence();
};

/* --- COMMS: REAL-TIME chat_logs SUBSCRIPTION ---
   Drives the multi-tab Comms Array — new PM tabs spawn/reopen and unread
   highlights fire the moment a row lands, instead of only on the next
   manual loadChatLogs() call. Requires Realtime replication to be enabled
   on the chat_logs table in the Supabase dashboard (Database > Replication)
   — without that, this channel connects but never receives INSERT events. */
let chatRealtimeChannel = null;
function initChatRealtimeChannel() {
    chatRealtimeChannel = db.channel('chat_logs_stream')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_logs' }, (payload) => {
            if (typeof window.handleIncomingChatLog === 'function') window.handleIncomingChatLog(payload.new);
        })
        .subscribe();
}

/* --- COMBAT INITIATIVE TRACKER: REAL-TIME SYNC ---
   Refetches on any change so every client's tracker stays in sync.
   Requires Realtime replication enabled for combat_tracker
   (Database > Replication). */
let combatTrackerRealtimeChannel = null;
function initCombatTrackerRealtimeChannel() {
    combatTrackerRealtimeChannel = db.channel('combat_tracker_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'combat_tracker' }, () => {
            if (typeof loadCombatTracker === 'function') loadCombatTracker();
        })
        .subscribe();
}

/* --- COLONIES & FLEET GROUPS: REAL-TIME SYNC ---
   Requires Realtime replication enabled for both tables
   (Database > Replication). */
let coloniesRealtimeChannel = null;
let fleetGroupsRealtimeChannel = null;
function initColoniesRealtimeChannel() {
    coloniesRealtimeChannel = db.channel('colonies_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'colonies' }, () => {
            if (typeof loadColonies === 'function') loadColonies();
        })
        .subscribe();
    fleetGroupsRealtimeChannel = db.channel('fleet_groups_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'fleet_groups' }, () => {
            if (typeof loadFleetGroups === 'function') loadFleetGroups();
        })
        .subscribe();
}

/* --- SHIP TEMPLATES: REAL-TIME SYNC ---
   One table backs both the public Ship Designer and the DM Secret Repository
   (is_secret flag), so a change to either needs both lists refreshed —
   loadSecretShipTemplates() is a no-op for non-DM clients anyway. */
let shipTemplatesRealtimeChannel = null;
function initShipTemplatesRealtimeChannel() {
    shipTemplatesRealtimeChannel = db.channel('ship_templates_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ship_templates' }, () => {
            if (typeof loadShipTemplates === 'function') loadShipTemplates();
            if (typeof loadSecretShipTemplates === 'function') loadSecretShipTemplates();
        })
        .subscribe();
}

/* --- SHIP MARKERS (deployed vessels/stations/strike craft): REAL-TIME SYNC ---
   Keeps HP/shields/weapons/ownership/decks live on every client: reloads
   galaxy data, then re-renders the Vessel Deck and Battle Map (which also
   covers its ship-status cards). Does NOT redraw the overworld galaxy
   canvas (js/map.js has its own triggers). combat_tracker's `hp` is a
   snapshot string, not linked to ship_markers.
   Like every channel here, this also echoes to the acting client -- a
   redundant but harmless refresh. */
let shipMarkersRealtimeChannel = null;
function initShipMarkersRealtimeChannel() {
    shipMarkersRealtimeChannel = db.channel('ship_markers_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ship_markers' }, async () => {
            if (typeof window.loadGalaxyData === 'function') await window.loadGalaxyData();
            if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
            if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
        })
        .subscribe();
}

/* --- SYSTEM HAZARDS: REAL-TIME SYNC --- */
let systemHazardsRealtimeChannel = null;
function initSystemHazardsRealtimeChannel() {
    systemHazardsRealtimeChannel = db.channel('system_hazards_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'system_hazards' }, () => {
            if (typeof loadSystemHazards === 'function') loadSystemHazards();
        })
        .subscribe();
}

/* --- PERK DEFINITIONS: REAL-TIME SYNC ---
   Matters more here than most tables — a player proposing a draft needs the
   DM's client to actually see it show up, and vice versa for approvals. */
let perkDefinitionsRealtimeChannel = null;
function initPerkDefinitionsRealtimeChannel() {
    perkDefinitionsRealtimeChannel = db.channel('perk_definitions_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'perk_definitions' }, () => {
            if (typeof loadPerkDefinitions === 'function') loadPerkDefinitions();
        })
        .subscribe();
}

// Augment Designer catalog -- same shape as the perk channel above.
// character_augments (the per-character installations) has no realtime
// channel of its own -- installing/removing is self-service on your own
// character and already patches the local cache immediately (js/ui.js),
// same convention character_perks already uses (also uncached-live).
let augmentDefinitionsRealtimeChannel;
function initAugmentDefinitionsRealtimeChannel() {
    augmentDefinitionsRealtimeChannel = db.channel('augment_definitions_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'augment_definitions' }, () => {
            if (typeof loadAugmentDefinitions === 'function') loadAugmentDefinitions();
        })
        .subscribe();
}

// Gear Designer catalog -- same shape as the perk/augment channels above.
// character_gear (the per-character loadout, including the equipped
// toggle) has no realtime channel of its own -- same self-service,
// uncached-live convention as character_perks/character_augments.
let gearDefinitionsRealtimeChannel;
function initGearDefinitionsRealtimeChannel() {
    gearDefinitionsRealtimeChannel = db.channel('gear_definitions_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'gear_definitions' }, () => {
            if (typeof loadGearDefinitions === 'function') loadGearDefinitions();
        })
        .subscribe();
}

/* --- HAZARD DEFINITIONS: REAL-TIME SYNC ---
   DM-only catalog, matching the ship_templates/perk_definitions pattern —
   mainly useful if the DM has two browser tabs open. */
let hazardDefinitionsRealtimeChannel = null;
function initHazardDefinitionsRealtimeChannel() {
    hazardDefinitionsRealtimeChannel = db.channel('hazard_definitions_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hazard_definitions' }, () => {
            if (typeof loadHazardDefinitions === 'function') loadHazardDefinitions();
        })
        .subscribe();
}

/* --- PLANETARY MODIFIERS (Overseer Planet Editor overrides): REAL-TIME SYNC --- */
let planetaryModifiersRealtimeChannel = null;
function initPlanetaryModifiersRealtimeChannel() {
    planetaryModifiersRealtimeChannel = db.channel('planetary_modifiers_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'planetary_modifiers' }, () => {
            if (typeof loadPlanetaryModifiers === 'function') loadPlanetaryModifiers();
        })
        .subscribe();
}

/* --- PERSONAL LABELS: REAL-TIME SYNC ---
   Subscribes to the whole table (no server-side filter, like every channel
   here), so it fires on any player's change; loadPersonalLabels' user_id
   filter keeps only this user's rows in the cache. */
let personalLabelsRealtimeChannel = null;
function initPersonalLabelsRealtimeChannel() {
    personalLabelsRealtimeChannel = db.channel('personal_labels_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'personal_labels' }, () => {
            if (typeof loadPersonalLabels === 'function') loadPersonalLabels();
        })
        .subscribe();
}

let systemOwnershipRealtimeChannel = null;
function initSystemOwnershipRealtimeChannel() {
    systemOwnershipRealtimeChannel = db.channel('system_ownership_overrides_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'system_ownership_overrides' }, () => {
            if (typeof loadSystemOwnershipOverrides === 'function') loadSystemOwnershipOverrides();
        })
        .subscribe();
}

/* --- HYPERLANES: REAL-TIME SYNC --- */
let hyperlanesRealtimeChannel = null;
function initHyperlanesRealtimeChannel() {
    hyperlanesRealtimeChannel = db.channel('hyperlanes_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hyperlanes' }, () => {
            if (typeof loadHyperlanes === 'function') loadHyperlanes();
        })
        .subscribe();
}

function renderPresenceTicker() {
    const listDiv = document.getElementById('presence-list');
    if (!listDiv) return;
    let html = '';
    Object.keys(onlineUsersMap).forEach(userId => {
        const presences = onlineUsersMap[userId];
        if (presences && presences.length > 0) {
            const p = presences[0];
            const activity = (p.activity || 'Monitoring DRADIS').toLowerCase();
            html += `<div class="presence-pill" onclick="window.snapToCommander('${userId}')" title="Click to locate vessel">
                <span class="presence-name">🟢 ${p.username} ${p.role === 'dm' ? '[DM]' : ''}</span>
                <span class="presence-activity">${activity}</span>
            </div>`;
        }
    });
    listDiv.innerHTML = html || '<span style="font-size:10px; color:#6b826a;">No active commanders</span>';
}

/* SHIP OWNERSHIP: ship_markers.owner_ids (uuid[]) is the source of truth;
   a token can have zero, one, or several owners. The old single
   ship_markers.owner_id column is deprecated -- never read or write it.
   Always check ownership through these helpers:
   - vesselOwnerIds(vessel): always an array, even for a malformed row.
   - vesselHasOwner(vessel, userId): is userId an owner (permission checks).
   - ownerIdsShareOwner(idsA, idsB): "same side" for combat (Point Defense,
     squadron uplink, AI friend/foe). DM rule: sharing ANY one owner counts
     as allied. Two UNOWNED vessels also count as same side, so ownerless
     NPCs don't target each other. */
window.vesselOwnerIds = function(vessel) {
    return (vessel && Array.isArray(vessel.owner_ids)) ? vessel.owner_ids : [];
};
window.vesselHasOwner = function(vessel, userId) {
    return !!userId && window.vesselOwnerIds(vessel).includes(userId);
};
window.ownerIdsShareOwner = function(idsA, idsB) {
    idsA = idsA || []; idsB = idsB || [];
    if (idsA.length === 0 && idsB.length === 0) return true;
    return idsA.some(id => idsB.includes(id));
};

window.snapToCommander = function(userId) {
    let ship = globalShipMarkersCache.find(m => window.vesselHasOwner(m, userId));
    if (ship) {
        window.selectedTarget = { type: 'ship', data: ship };
        if (typeof window.lockCameraOnSelected === 'function') window.lockCameraOnSelected();
        if (typeof renderHUDTelemetry === 'function') window.renderHUDTelemetry();
        document.getElementById('character-terminal').style.display = 'none'; 
        if (window.AudioEngine) window.AudioEngine.playPing();
    } else {
        alert("DRADIS Error: No active vessel found assigned to this commander.");
    }
};

/* --- FEATURE: "JUMP TO SHIP" CAMERA SHORTCUT ---
   Pans the canvas to the user's own vessel and opens its Vessel Deck. A
   pure camera/terminal shortcut with no calendar effect (time inversion
   lives in window.executePlottedJump, js/map.js).
   ship_markers.last_ftl_position is unused dead schema. */
window.jumpToActiveShip = async function() {
    let ship = globalShipMarkersCache.find(m => window.vesselHasOwner(m, currentUserId));
    if (!ship) { alert("DRADIS Error: No active vessel found assigned to your callsign."); return; }

    window.selectedTarget = { type: 'ship', data: ship };
    if (typeof window.lockCameraOnSelected === 'function') window.lockCameraOnSelected();
    if (typeof window.renderHUDTelemetry === 'function') window.renderHUDTelemetry();
    if (typeof window.openFullVesselTerminal === 'function') window.openFullVesselTerminal(ship.id);
    if (window.AudioEngine) window.AudioEngine.playPing();
};

/* --- RELATIVISTIC TIME-INVERSION ---
   DM rule: every genuine FTL jump (window.executePlottedJump, js/map.js)
   makes the ship's chronometer read EARLIER than departure, scaled by
   distance and drive (see TEMPORAL_DRIFT_CONSTANT). This replaces any
   forward "trip takes N hours" travel time. Capped at 168h (~7 days) per
   jump. FTL drives only by default; the DM can untick
   window.jumpInversionFtlOnly (Chronology Control Deck) to apply it to all
   drives. Always logged to Comms. Free clock rewinds stay DM-only
   (window.adjustTime). */
window.JUMP_TIME_INVERSION_MAX_HOURS = 168;
window.jumpInversionFtlOnly = window.safeLocalGet('odyssey_jump_ftl_only', null) !== 'false'; // default ON
window.setJumpInversionFtlOnly = function(checked) {
    window.jumpInversionFtlOnly = !!checked;
    window.safeLocalSet('odyssey_jump_ftl_only', window.jumpInversionFtlOnly ? 'true' : 'false');
};

window.exportCampaignBackup = function() {
    if (currentUserRole !== 'dm') return;
    const backup = {
        timestamp: new Date().toISOString(), universeTimeHours: window.universeTimeHours,
        starSystems: globalDbSystemsCache, shipMarkers: globalShipMarkersCache,
        territories: globalTerritoriesCache, hyperlanes: globalHyperlanesCache,
        codexEntries: globalCodexEntriesCache, combatants: combatantsList
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `task_force_black_backup_${Date.now()}.json`);
    document.body.appendChild(downloadAnchorNode); downloadAnchorNode.click(); downloadAnchorNode.remove();
};

/* ==========================================================================
   FULL CAMPAIGN BACKUP / RESTORE
   ==========================================================================
   The QUICK BACKUP above only covers in-memory map data and was never meant
   to be restored. This exports every live campaign table and restores it.

   DM decisions:
     - Restore is a TRUE wipe-and-replace, not a merge: every covered table
       is emptied, then the backup's rows are inserted as captured. Anything
       created since the backup is gone. Not for casual undo.
     - `profiles` IS restored. A profile whose auth user was since recreated
       becomes an orphan row; this client can't touch auth.users.
     - Needs the typed phrase RESTORE FULL CAMPAIGN plus a confirm modal.
     - Chat logs and player notes are included.
   Not covered: the abandoned tables (celestial_bodies, stations,
   explored_sectors, campaign_codex) and the music-tracks Storage bucket
   (re-upload by hand via the Supabase dashboard if lost).

   FULL_BACKUP_TABLE_GROUPS is ordered by FK dependency: a group only
   references earlier groups. INSERT runs in this order, DELETE in reverse,
   or FK violations fail the request. ship_markers references itself
   (docked_to/parent_id), so restoreOneTable inserts those columns as null
   and patches them in a second pass. */
window.FULL_BACKUP_TABLE_GROUPS = [
    ['profiles'],
    ['campaign_objectives', 'perk_definitions', 'augment_definitions', 'gear_definitions', 'hazard_definitions',
     'hyperlanes', 'star_systems', 'system_ownership_overrides', 'territories', 'planetary_modifiers', 'personal_labels',
     'campaign_clock', 'saved_fleets', 'manufacturing_blueprints', 'strike_craft_templates', 'ship_templates',
     'codex_entries', 'characters', 'colonies', 'battle_encounters', 'chat_logs', 'player_notes',
     'cargo_item_catalog', // no table references it
     'app_settings', 'encounter_presets'],
    ['ship_markers', 'system_hazards'],
    // battle_tokens / battle_events (undo log) / battle_reinforcements are children of battle_encounters.
    ['fleet_groups', 'manufacturing_orders', 'battlefield_salvage', 'combat_tracker', 'battle_tokens', 'battle_events', 'battle_reinforcements'],
    ['character_arsenal', 'character_perks', 'character_augments', 'character_gear', 'character_skills']
];
// Primary key column per table (default 'id'). The wipe step deletes every
// row with `.not(pkCol, 'is', null)`, which works for any PK type.
window.FULL_BACKUP_PK_COLUMN = {
    character_skills: 'character_id',
    planetary_modifiers: 'body_id',
    system_ownership_overrides: 'system_id',
    app_settings: 'feature_key'
};
// Tables with a column that references another row in the SAME table.
window.FULL_BACKUP_SELF_REF_TABLES = { ship_markers: ['docked_to', 'parent_id'] };

function fullBackupPkColumn(table) {
    return window.FULL_BACKUP_PK_COLUMN[table] || 'id';
}

function fullBackupLog(msg) {
    const el = document.getElementById('full-campaign-status');
    if (!el) return;
    el.style.display = 'block';
    el.innerText += (el.innerText ? '\n' : '') + msg;
    el.scrollTop = el.scrollHeight;
}

window.exportFullCampaignBackup = async function() {
    if (currentUserRole !== 'dm') return;
    const el = document.getElementById('full-campaign-status');
    if (el) { el.style.display = 'block'; el.innerText = 'Exporting full campaign backup...'; }
    const allTables = window.FULL_BACKUP_TABLE_GROUPS.flat();
    const backup = { kind: 'full_campaign_backup', schemaVersion: 1, timestamp: new Date().toISOString(), tables: {} };
    let totalRows = 0;
    for (const table of allTables) {
        const { data, error } = await db.from(table).select('*');
        if (error) {
            alert(`Full backup failed reading "${table}": ${error.message}\n\nNo file was downloaded -- nothing partial gets saved.`);
            if (el) el.style.display = 'none';
            return;
        }
        backup.tables[table] = data || [];
        totalRows += (data || []).length;
        fullBackupLog(`Read ${table} (${(data || []).length} rows)`);
    }
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `task_force_black_FULL_backup_${Date.now()}.json`);
    document.body.appendChild(downloadAnchorNode); downloadAnchorNode.click(); downloadAnchorNode.remove();
    fullBackupLog(`✓ Full backup complete -- ${allTables.length} tables, ${totalRows} total rows. File downloaded.`);
};

/* --- Restore: paste -> preview -> typed confirmation -> execute --- */
window.previewFullCampaignRestore = function() {
    const raw = document.getElementById('full-restore-paste').value.trim();
    const previewEl = document.getElementById('full-restore-preview');
    const confirmSection = document.getElementById('full-restore-confirm-section');
    if (!raw) { alert("Paste a Full Campaign Backup JSON file's contents first."); return; }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { alert("That's not valid JSON: " + e.message); return; }
    if (!parsed || parsed.kind !== 'full_campaign_backup' || !parsed.tables) {
        alert('This doesn\'t look like a Full Campaign Backup file (missing the "full_campaign_backup" marker or its table data). The QUICK BACKUP file above is a different, older format and was never meant to be restored -- only a file downloaded from FULL CAMPAIGN BACKUP will work here.');
        return;
    }
    window._pendingRestorePayload = parsed;
    const allTables = window.FULL_BACKUP_TABLE_GROUPS.flat();
    const rowLines = allTables.map(t => `${t}: ${(parsed.tables[t] || []).length}`).join(' · ');
    const missing = allTables.filter(t => !(t in parsed.tables));
    const skippedNote = 'will be LEFT AS-IS (not cleared, not restored)';
    previewEl.style.display = 'block';
    previewEl.innerHTML = `<strong style="color:#ffaa00;">Backup captured: ${parsed.timestamp || 'unknown time'}</strong><br><span style="font-size:9px;">${rowLines}</span>`
        + (missing.length ? `<br><span style="color:#ff6b6b; font-size:9px;">⚠ Not present in this file (${skippedNote}): ${missing.join(', ')}</span>` : '');
    confirmSection.style.display = 'block';
};

window.cancelFullCampaignRestore = function() {
    window._pendingRestorePayload = null;
    document.getElementById('full-restore-preview').style.display = 'none';
    document.getElementById('full-restore-confirm-section').style.display = 'none';
    document.getElementById('full-restore-confirm-phrase').value = '';
    document.getElementById('full-restore-paste').value = '';
};

const FULL_RESTORE_CONFIRM_PHRASE = 'RESTORE FULL CAMPAIGN';

window.executeFullCampaignRestore = async function() {
    if (currentUserRole !== 'dm') return;
    const phraseInput = document.getElementById('full-restore-confirm-phrase');
    if (!phraseInput || phraseInput.value.trim() !== FULL_RESTORE_CONFIRM_PHRASE) {
        alert(`Type the confirmation phrase exactly: ${FULL_RESTORE_CONFIRM_PHRASE}`);
        return;
    }
    const payload = window._pendingRestorePayload;
    if (!payload) { alert("Click PREVIEW BACKUP first."); return; }
    if (!(await window.showConfirmModal("This will PERMANENTLY DELETE all current campaign data (every character, ship, colony, and everything else covered) and replace it with the pasted backup. This cannot be undone. Continue?"))) return;

    const groups = window.FULL_BACKUP_TABLE_GROUPS;
    const el = document.getElementById('full-campaign-status');
    if (el) { el.style.display = 'block'; el.innerText = 'Starting restore...'; }

    // --- Delete phase: reverse group order (children before parents) ---
    for (let i = groups.length - 1; i >= 0; i--) {
        for (const table of groups[i]) {
            // A table missing from the backup file (e.g. added to the list
            // later) is left untouched. A table present with 0 rows is cleared.
            if (!(table in payload.tables)) { fullBackupLog(`${table}: not in this backup file -- left as-is`); continue; }
            const pk = fullBackupPkColumn(table);
            const { error } = await db.from(table).delete().not(pk, 'is', null);
            if (error) {
                fullBackupLog(`✕ STOPPED -- failed clearing ${table}: ${error.message}`);
                alert(`Restore stopped while clearing "${table}": ${error.message}\n\nSome tables are already wiped and some aren't -- the campaign is in a mixed state right now. Don't close this tab; tell your dev/Claude session what table it stopped on so it can be fixed directly against the database.`);
                return;
            }
            fullBackupLog(`Cleared ${table}`);
        }
    }

    // --- Insert phase: forward group order (parents before children) ---
    for (const group of groups) {
        for (const table of group) {
            if (!(table in payload.tables)) continue; // left as-is, see delete phase
            const rows = payload.tables[table] || [];
            if (rows.length === 0) { fullBackupLog(`${table}: nothing to restore (0 rows in backup)`); continue; }
            try {
                await restoreOneTable(table, rows);
                fullBackupLog(`Restored ${table} (${rows.length} rows)`);
            } catch (e) {
                fullBackupLog(`✕ STOPPED -- failed restoring ${table}: ${e.message}`);
                alert(`Restore stopped while writing "${table}": ${e.message}\n\nEvery table before this one in the list was already cleared AND restored successfully -- everything from here on is still empty (cleared but not yet reloaded). Don't close this tab; tell your dev/Claude session what table it stopped on.`);
                return;
            }
        }
    }

    fullBackupLog('✓ Restore complete. Reloading app in 3 seconds...');
    setTimeout(() => location.reload(), 3000);
};

async function restoreOneTable(table, rows) {
    const selfRefCols = window.FULL_BACKUP_SELF_REF_TABLES[table];
    let insertRows = rows;
    const patches = [];
    if (selfRefCols) {
        insertRows = rows.map(r => {
            const clean = { ...r };
            const patch = {};
            let needsPatch = false;
            selfRefCols.forEach(col => {
                if (clean[col] !== null && clean[col] !== undefined) { patch[col] = clean[col]; needsPatch = true; }
                clean[col] = null;
            });
            if (needsPatch) patches.push({ id: r.id, patch });
            return clean;
        });
    }
    const CHUNK = 500;
    for (let i = 0; i < insertRows.length; i += CHUNK) {
        const { error } = await db.from(table).insert(insertRows.slice(i, i + CHUNK));
        if (error) throw new Error(error.message);
    }
    for (const p of patches) {
        const { error } = await db.from(table).update(p.patch).eq('id', p.id);
        if (error) throw new Error(`self-reference patch -- ${error.message}`);
    }
}

window.handleLogout = async function() {
    if (presenceChannel) await presenceChannel.untrack();
    await db.auth.signOut();
    location.reload();
};