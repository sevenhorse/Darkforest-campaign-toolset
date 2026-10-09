/* ==========================================================================
   js/codex-v2.js - Codex restyle (Phase 6d, 2026-10-03)
   ==========================================================================
   DM decisions (2026-10-03, from the 6d mockup):
   - List + reading pane: pick an entry on the left, read it in full on the
     right. Phones: the list, then a full-screen reader with a back button.
   - The entry's subtitle shows as a chip, coloured by keyword (hostile =
     red, ally/allied/friendly = green, neutral = grey, crew = cyan, anything
     else = purple). The text is exactly what the DM typed.
   - Opening "**LABEL:** value" lines (2 or more, at the very start, after an
     optional "# heading") are lifted into a fact box; the rest of the entry
     renders as written. A leading "# heading" becomes the small kicker line
     above the title when there is a fact box.
   - The Command Terminal's own header/sidebar are NOT restyled.

   Feature switch 'codex_restyle' (DM only to start). When it's off, the old
   Codex renders exactly as before. Nothing here changes how entries are
   stored: saving still goes through window.saveNewCodexEntry (ui.js) and
   the DM form is the same #codex-dm-creator-panel, moved into the reading
   pane while editing and moved back afterwards.

   Visibility rules match renderCodexMatrix: the DM sees everything; players
   never see is_hidden entries, and an entry with "| LINK:<system>" in its
   subtitle only after that system has been DRADIS-scanned. */
(function () {
const CATS = [
    { key: 'factions', tab: 'FACTIONS', title: 'FACTIONS & POWERS', icon: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"></path>' },
    { key: 'lore', tab: 'SECTOR LORE', title: 'SECTOR LORE & INTEL', icon: '<circle cx="12" cy="12" r="3"></circle><ellipse cx="12" cy="12" rx="10" ry="4"></ellipse>' },
    { key: 'npcs', tab: 'KEY NPCS', title: 'KEY NPCS & CONTACTS', icon: '<circle cx="12" cy="8" r="4"></circle><path d="M4 21c1-4 4-6 8-6s7 2 8 6"></path>' },
    { key: 'docs', tab: 'DOCUMENTS', title: 'DOCUMENTS & LOGS', icon: '<path d="M6 3h9l4 4v14H6z"></path><path d="M14 3v5h5"></path>' }
];
const S = window.__cx2 = window.__cx2 || { selected: {}, view: 'list', editing: false, editTab: 'write', charts: [], pendingSelect: null };
const esc = (v) => window.escapeHtml(v == null ? '' : String(v));
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
window.codexRestyleOn = function () { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('codex_restyle'); };

/* --- Data --- */
function linkOf(e) { const m = (e.subtitle || '').match(/\|?\s*LINK:(.+)/); return m ? m[1].trim() : null; }
function cleanTag(e) { return (e.subtitle || '').replace(/\|?\s*LINK:.+/, '').trim(); }
function visibleToMe(e) {
    if (isDm()) return true;
    if (e.is_hidden) return false;
    const link = linkOf(e);
    if (link) return !!(window.scannedSystems && window.scannedSystems.includes(link));
    return true;
}
function matchesSearch(e) {
    const q = window.codexSearchFilter;
    if (!q) return true;
    return [e.title, e.subtitle, e.content].some(t => t && String(t).toLowerCase().includes(q));
}
function entriesFor(cat) {
    const list = (globalCodexEntriesCache || []).filter(e => e.category === cat && visibleToMe(e) && matchesSearch(e));
    return window.applySavedOrder('codex_' + cat, list);
}
window.codexV2Entries = entriesFor; // tests
// Keyword colour for the tag chip.
window.codexTagKind = function (tag) {
    const t = String(tag || '').toLowerCase();
    if (!t) return '';
    if (/hostile|enemy/.test(t)) return 'hostile';
    if (/\ball(y|ied|ies)\b|friendly/.test(t)) return 'ally';
    if (/neutral/.test(t)) return 'neutral';
    if (/\bcrew\b/.test(t)) return 'crew';
    return 'other';
};
function initials(title) {
    let name = String(title || '');
    const i = name.lastIndexOf(':');
    if (i !== -1 && name.slice(i + 1).trim()) name = name.slice(i + 1);
    const w = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
}
function readMinutes(e) { const words = String(e.content || '').split(/\s+/).filter(Boolean).length; return Math.max(1, Math.round(words / 200)); }
function fmtDate(d) {
    if (!d) return '';
    const t = new Date(d);
    if (isNaN(t)) return '';
    return `${t.getDate()} ${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][t.getMonth()]} ${t.getFullYear()}`;
}
function cleanInline(md) {
    let html;
    if (typeof marked !== 'undefined' && typeof marked.parseInline === 'function' && window.DOMPurify) html = window.DOMPurify.sanitize(marked.parseInline(md));
    else html = esc(md.replace(/\*\*|__/g, ''));
    return html;
}
// Splits opening "**LABEL:** value" lines off the top of an entry.
// Returns { kicker, facts: [{ label, html }], rest } -- facts is empty (and
// rest is the untouched text) unless there are at least 2 such lines.
window.codexSplitFacts = function (raw) {
    const text = String(raw || '');
    const lines = text.split('\n');
    let i = 0;
    const skipBlank = () => { while (i < lines.length && !lines[i].trim()) i++; };
    skipBlank();
    let kicker = null;
    const h = (lines[i] || '').match(/^#\s+(.+)$/);
    if (h) { kicker = h[1].replace(/\*\*/g, '').trim(); i++; }
    const facts = [];
    const FACT = /^\*\*\s*([^*:\n]{1,40}?)\s*(?::\s*\*\*|\*\*\s*:)\s*(.+)$/;
    for (;;) {
        const save = i;
        skipBlank();
        const m = (lines[i] || '').match(FACT);
        if (!m) { i = save; break; }
        facts.push({ label: m[1].trim(), html: cleanInline(m[2].trim()) });
        i++;
    }
    if (facts.length < 2) return { kicker: null, facts: [], rest: text };
    skipBlank();
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i] || '')) i++;
    return { kicker, facts, rest: lines.slice(i).join('\n') };
};

/* --- Layout --- */
function svg(path, color) { return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color || 'currentColor'}" stroke-width="1.8" aria-hidden="true">${path}</svg>`; }
function ensureRoot() {
    const panel = document.getElementById('term-panel-codex');
    if (!panel) return null;
    let root = document.getElementById('cx2-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'cx2-root';
        root.innerHTML = `
            <div class="cx2-top">
                <div class="cx2-brand"><h3 class="cx2-h1">CODEX</h3><span class="cx2-h1sub">// GALACTIC INTEL</span></div>
                <span class="cx2-clear" id="cx2-clear"></span>
                <span class="cx2-grow"></span>
                <label class="cx2-search"><span class="cx2-sr">Search the Codex</span>${svg('<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>', '#6b8590')}
                    <input type="text" id="cx2-search" placeholder="Search titles, tags and text" autocomplete="off" oninput="window.filterCodexEntries(this.value)"></label>
                <button type="button" class="cx2-btn cx2-amber" id="cx2-new" onclick="window.cx2NewEntry()">+ NEW ENTRY</button>
            </div>
            <div class="cx2-tabs" role="tablist" aria-label="Codex categories" id="cx2-tabs"></div>
            <div class="cx2-body">
                <section class="cx2-list cx2-panel" id="cx2-list" aria-label="Entries"></section>
                <article class="cx2-reader cx2-panel" id="cx2-reader" aria-live="polite"></article>
            </div>`;
        panel.appendChild(root);
    }
    return root;
}
function teardown() {
    const panel = document.getElementById('term-panel-codex');
    if (panel) panel.classList.remove('cx2-on');
    restoreForm();
    destroyCharts();
}
function destroyCharts() { (S.charts || []).forEach(c => { try { c.destroy(); } catch (e) {} }); S.charts = []; }

// The DM form lives in the old deck; it's borrowed while editing.
let formHome = null;
function borrowForm(into) {
    const form = document.getElementById('codex-dm-creator-panel');
    if (!form) return null;
    if (!formHome) { formHome = document.createElement('span'); formHome.id = 'cx2-form-home'; formHome.style.display = 'none'; form.parentNode.insertBefore(formHome, form); }
    into.appendChild(form);
    form.classList.add('cx2-form');
    decorateForm(form);
    // The old label says markdown only renders in the fullscreen reader --
    // not true here (PREVIEW tab), so it is swapped while the form is borrowed.
    const lab = form.querySelector('label[for="new-codex-content"]');
    if (lab) { if (lab.dataset.cx2Old == null) lab.dataset.cx2Old = lab.innerHTML; lab.textContent = 'Entry text (Markdown + charts — use PREVIEW to check it):'; }
    return form;
}
function restoreForm() {
    const form = document.getElementById('codex-dm-creator-panel');
    const home = document.getElementById('cx2-form-home');
    if (form && home && form.previousSibling !== home) { home.parentNode.insertBefore(form, home.nextSibling); }
    if (form) form.classList.remove('cx2-form');
    const lab = form && form.querySelector('label[for="new-codex-content"]');
    if (lab && lab.dataset.cx2Old != null) { lab.innerHTML = lab.dataset.cx2Old; delete lab.dataset.cx2Old; }
}
// One-time extras on the DM form: quick tag buttons + Write/Preview tabs.
function decorateForm(form) {
    if (form.dataset.cx2) return;
    form.dataset.cx2 = '1';
    const sub = document.getElementById('new-codex-subtitle');
    if (sub) {
        const quick = document.createElement('div');
        quick.className = 'cx2-quicktags';
        quick.innerHTML = [['Allied', 'ally'], ['Neutral', 'neutral'], ['Hostile', 'hostile'], ['Crew', 'crew']]
            .map(([t, k]) => `<button type="button" class="cx2-chip cx2-k-${k}" onclick="window.cx2SetTag('${t}')">${t.toUpperCase()}</button>`).join('');
        sub.parentNode.insertBefore(quick, sub.nextSibling);
    }
    const content = document.getElementById('new-codex-content');
    if (content) {
        const tabs = document.createElement('div');
        tabs.className = 'cx2-edtabs';
        tabs.innerHTML = `<button type="button" id="cx2-tab-write" onclick="window.cx2EditTab('write')">WRITE</button><button type="button" id="cx2-tab-preview" onclick="window.cx2EditTab('preview')">PREVIEW</button><span class="cx2-edhelp"># heading · **bold** · * list · --- · \`\`\`chart</span>`;
        content.parentNode.insertBefore(tabs, content);
        const prev = document.createElement('div');
        prev.id = 'cx2-preview';
        prev.className = 'cx2-text cx2-preview';
        content.parentNode.insertBefore(prev, content.nextSibling);
    }
}
window.cx2SetTag = function (t) { const sub = document.getElementById('new-codex-subtitle'); if (sub) sub.value = t; };
window.cx2EditTab = function (tab) {
    S.editTab = tab === 'preview' ? 'preview' : 'write';
    const content = document.getElementById('new-codex-content'), prev = document.getElementById('cx2-preview');
    const w = document.getElementById('cx2-tab-write'), p = document.getElementById('cx2-tab-preview');
    if (w) w.classList.toggle('on', S.editTab === 'write');
    if (p) p.classList.toggle('on', S.editTab === 'preview');
    if (content) content.style.display = S.editTab === 'write' ? '' : 'none';
    if (prev) {
        prev.style.display = S.editTab === 'preview' ? '' : 'none';
        if (S.editTab === 'preview') {
            destroyCharts();
            const b = bodyHtml(content ? content.value : '', 'cx2-pchart');
            prev.innerHTML = (b.kicker ? `<div class="cx2-kicker">${esc(b.kicker.toUpperCase())}</div>` : '') + b.html;
            window.drawCodexCharts(b.charts, S.charts);
        }
    }
};

// Entry text -> html (fact box + rendered markdown).
function bodyHtml(raw, chartPrefix) {
    const split = window.codexSplitFacts(raw);
    const md = window.renderCodexMarkdown(split.rest || '', chartPrefix);
    const facts = split.facts.length ? `<dl class="cx2-facts">${split.facts.map(f => `<dt>${esc(f.label.toUpperCase())}</dt><dd>${f.html}</dd>`).join('')}</dl>` : '';
    return { html: `${facts}<div class="codex-markdown">${md.html}</div>`, charts: md.charts, kicker: split.kicker };
}

/* --- Render --- */
function renderV2() {
    const root = ensureRoot();
    if (!root) return;
    document.getElementById('term-panel-codex').classList.add('cx2-on');
    const dm = isDm();
    const cat = CATS.some(c => c.key === window.activeCodexCategory) ? window.activeCodexCategory : 'factions';
    window.activeCodexCategory = cat;

    const clear = document.getElementById('cx2-clear');
    clear.textContent = dm ? 'OVERSEER CLEARANCE' : 'READ-ONLY CLEARANCE';
    clear.classList.toggle('cx2-amber', dm);
    document.getElementById('cx2-new').style.display = dm ? '' : 'none';
    const search = document.getElementById('cx2-search');
    if (search && document.activeElement !== search) search.value = window.codexSearchFilter || '';

    document.getElementById('cx2-tabs').innerHTML = CATS.map(c => {
        const on = c.key === cat;
        return `<button type="button" role="tab" aria-selected="${on}" class="cx2-tab${on ? ' on' : ''}" onclick="window.cx2Category('${c.key}')">${svg(c.icon)}<span>${c.tab}</span><b>${entriesFor(c.key).length}</b></button>`;
    }).join('');

    const list = entriesFor(cat);
    if (S.pendingSelect) {
        const hit = list.find(e => e.title === S.pendingSelect.title && (!S.pendingSelect.id || e.id === S.pendingSelect.id)) || list.find(e => e.title === S.pendingSelect.title);
        if (hit) { S.selected[cat] = hit.id; S.pendingSelect = null; }
    }
    let selId = S.selected[cat];
    if (!list.some(e => e.id === selId)) { selId = list.length ? list[0].id : null; S.selected[cat] = selId; }
    const orderKey = 'codex_' + cat;
    const catInfo = CATS.find(c => c.key === cat);

    document.getElementById('cx2-list').innerHTML = `
        <div class="cx2-ttl"><span>${catInfo.title}</span><span class="cx2-dim">${list.length} ${list.length === 1 ? 'ENTRY' : 'ENTRIES'}</span></div>
        <div class="cx2-rows">${list.length ? list.map(e => {
            const tag = cleanTag(e), kind = window.codexTagKind(tag);
            const img = window.codexDisplayImageRef(e);
            const sel = e.id === selId;
            return `<div class="cx2-row${sel ? ' sel' : ''}${e.is_hidden ? ' hid' : ''}" draggable="true" data-id="${esc(e.id)}" title="Drag to reorder (your order, this browser)">
                <button type="button" class="cx2-rowbtn" onclick="window.cx2Select('${e.id}')" aria-current="${sel}">
                    <span class="cx2-thumb">${img ? `<img data-media-ref="${esc(img)}" alt="">` : esc(initials(e.title))}</span>
                    <span class="cx2-rowtxt"><span class="cx2-rowtitle">${esc(e.title || 'Untitled')}</span>
                    <span class="cx2-rowmeta">${tag ? `<span class="cx2-chip cx2-k-${kind}">${esc(tag.toUpperCase())}</span>` : ''}${dm && e.is_hidden ? '<span class="cx2-chip cx2-k-hostile">HIDDEN</span>' : ''}${dm && linkOf(e) ? '<span class="cx2-chip cx2-k-other">SCAN-LOCKED</span>' : ''}<span class="cx2-dim">${readMinutes(e)} MIN</span></span></span>
                </button>
                ${sel ? `<span class="cx2-reorder">${window.renderReorderArrows(orderKey, list, e.id, 'moveCodexEntryOrder')}</span>` : ''}
            </div>`;
        }).join('') : `<div class="cx2-empty">${window.codexSearchFilter ? 'Nothing here matches your search.' : 'No records located under this classification.'}</div>`}</div>`;

    wireDrag(document.getElementById('cx2-list'), cat);
    const root2 = document.getElementById('cx2-root');
    root2.classList.toggle('cx2-reading', S.view === 'read');
    renderReader(list, selId, catInfo);
}
/* Phase 11 (DM 2026-10-03): drag entries to reorder. Same storage as the
   ▲▼ arrows (this browser's own order, localStorage 'order_codex_<cat>');
   the arrows stay for phones and keyboards. The new order covers the whole
   category, so entries hidden by a search keep their places. */
window.cx2Reorder = function (cat, dragId, targetId, after) {
    if (!dragId || !targetId || dragId === targetId) return false;
    const key = 'codex_' + cat;
    const all = window.applySavedOrder(key, (globalCodexEntriesCache || []).filter(e => e.category === cat));
    const ids = all.map(e => e.id).filter(id => id !== dragId);
    let i = ids.indexOf(targetId);
    if (i < 0 || !all.some(e => e.id === dragId)) return false;
    ids.splice(after ? i + 1 : i, 0, dragId);
    window.saveListOrder(key, ids);
    renderV2();
    return true;
};
function wireDrag(listEl, cat) {
    if (!listEl || listEl.__cx2Drag) { if (listEl) listEl.__cx2Cat = cat; return; }
    listEl.__cx2Drag = true; listEl.__cx2Cat = cat;
    let dragId = null;
    const rowOf = (ev) => ev.target && ev.target.closest ? ev.target.closest('.cx2-row[data-id]') : null;
    const clearMarks = () => listEl.querySelectorAll('.cx2-drop-before, .cx2-drop-after').forEach(n => n.classList.remove('cx2-drop-before', 'cx2-drop-after'));
    listEl.addEventListener('dragstart', (ev) => {
        const row = rowOf(ev); if (!row) return;
        dragId = row.dataset.id; row.classList.add('cx2-dragging');
        try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', dragId); } catch (e) {}
    });
    listEl.addEventListener('dragover', (ev) => {
        const row = rowOf(ev); if (!row || !dragId) return;
        ev.preventDefault();
        const r = row.getBoundingClientRect();
        const after = ev.clientY > r.top + r.height / 2;
        clearMarks(); row.classList.add(after ? 'cx2-drop-after' : 'cx2-drop-before');
    });
    listEl.addEventListener('dragleave', (ev) => { if (!listEl.contains(ev.relatedTarget)) clearMarks(); });
    listEl.addEventListener('drop', (ev) => {
        const row = rowOf(ev); if (!row || !dragId) return;
        ev.preventDefault();
        const after = row.classList.contains('cx2-drop-after');
        clearMarks();
        const id = dragId; dragId = null;
        window.cx2Reorder(listEl.__cx2Cat, id, row.dataset.id, after);
    });
    listEl.addEventListener('dragend', () => { dragId = null; clearMarks(); listEl.querySelectorAll('.cx2-dragging').forEach(n => n.classList.remove('cx2-dragging')); });
}
function renderReader(list, selId, catInfo) {
    const box = document.getElementById('cx2-reader');
    destroyCharts();
    if (S.editing && isDm()) {
        const editingId = window.editingCodexId;
        if (!box.querySelector('#codex-dm-creator-panel')) {
            box.innerHTML = `<div class="cx2-back-row"><button type="button" class="cx2-back" onclick="window.cancelCodexEdit()">‹ CANCEL</button></div>
                <div class="cx2-ttl cx2-amber-ttl"><span>${editingId ? 'EDIT ENTRY' : 'NEW ENTRY'}</span><span>DM ONLY</span></div>`;
            const form = borrowForm(box);
            if (form) form.style.display = 'block';
        }
        window.cx2EditTab(S.editTab);
        return;
    }
    restoreForm();
    const e = list.find(x => x.id === selId);
    if (!e) {
        box.innerHTML = `<div class="cx2-back-row"><button type="button" class="cx2-back" onclick="window.cx2Back()">‹ ${catInfo.tab}</button></div><div class="cx2-empty cx2-empty-big">Select an entry to read it here.</div>`;
        return;
    }
    const dm = isDm();
    const tag = cleanTag(e), kind = window.codexTagKind(tag);
    const author = (allProfiles || []).find(p => p.id === e.created_by);
    const img = window.codexDisplayImageRef(e);
    const body = bodyHtml(e.content || 'No narrative content recorded.', 'cx2-chart');
    const i = list.findIndex(x => x.id === e.id);
    const prev = i > 0 ? list[i - 1] : null, next = i < list.length - 1 ? list[i + 1] : null;
    const short = (t) => { const s = String(t || ''); const k = s.lastIndexOf(':'); const n = (k !== -1 && s.slice(k + 1).trim()) ? s.slice(k + 1).trim() : s; return n.length > 28 ? n.slice(0, 27) + '…' : n; };
    const link = linkOf(e);
    box.innerHTML = `
        <div class="cx2-back-row"><button type="button" class="cx2-back" onclick="window.cx2Back()">‹ ${catInfo.tab}</button></div>
        <div class="cx2-head">
            <div class="cx2-por${img ? '' : ' cx2-noimg'}">${img ? `<img data-media-ref="${esc(img)}" alt="${esc(e.title || '')}" title="Click to enlarge" onclick="window.openImageLightbox(this.getAttribute('data-media-ref'), this.getAttribute('alt'))">` : `${svg('<rect x="3" y="5" width="18" height="14"></rect><path d="M3 16l5-5 4 4 3-3 6 6"></path>', '#3f6a75')}<span>NO IMAGE</span>`}</div>
            <div class="cx2-headtxt">
                ${body.kicker ? `<div class="cx2-kicker">${esc(body.kicker.toUpperCase())}</div>` : `<div class="cx2-kicker">${catInfo.title}</div>`}
                <h2 class="cx2-title">${esc(e.title || 'Untitled')}</h2>
                <div class="cx2-chips">${tag ? `<span class="cx2-chip cx2-k-${kind}">${esc(tag.toUpperCase())}</span>` : ''}<span class="cx2-chip cx2-k-cat">${catInfo.tab}</span>${dm && e.is_hidden ? '<span class="cx2-chip cx2-k-hostile">HIDDEN FROM PLAYERS</span>' : ''}${dm && link ? `<span class="cx2-chip cx2-k-other" title="Players see this after scanning that system">UNLOCKS ON SCAN: ${esc(link)}</span>` : ''}</div>
                <div class="cx2-meta">FILED BY ${esc((author && author.username || 'UNKNOWN').toUpperCase())}${e.created_at ? ' · ' + fmtDate(e.created_at) : ''} · ~${readMinutes(e)} MIN READ</div>
            </div>
            <div class="cx2-acts">
                <button type="button" class="cx2-btn" onclick="window.openCodexFullscreen('${e.id}')">⛶ FULL SCREEN</button>
                ${dm ? `<button type="button" class="cx2-btn cx2-amber" onclick="window.editCodexEntry('${e.id}')">EDIT</button>
                <button type="button" class="cx2-btn cx2-dimbtn" onclick="window.cx2ToggleHidden('${e.id}')">${e.is_hidden ? 'SHOW' : 'HIDE'}</button>
                <button type="button" class="cx2-btn cx2-red" aria-label="Delete entry" onclick="window.deleteCodexEntry('${e.id}')">✕</button>` : ''}
            </div>
        </div>
        <div class="cx2-text">${body.html}</div>
        <div class="cx2-foot">
            ${e.doc_data && e.doc_name ? `<button type="button" class="cx2-btn" onclick="window.openCodexAttachment('${e.id}')">📎 ${esc(e.doc_name)} (${esc((e.doc_type || 'FILE').toUpperCase())})</button>` : '<span class="cx2-dim">NO ATTACHMENTS</span>'}
            <span class="cx2-grow"></span>
            ${prev ? `<button type="button" class="cx2-btn cx2-soft" onclick="window.cx2Select('${prev.id}')">‹ ${esc(short(prev.title).toUpperCase())}</button>` : ''}
            ${next ? `<button type="button" class="cx2-btn cx2-soft" onclick="window.cx2Select('${next.id}')">${esc(short(next.title).toUpperCase())} ›</button>` : ''}
        </div>`;
    window.drawCodexCharts(body.charts, S.charts);
}

/* --- Actions --- */
async function leaveEditor() {
    if (!S.editing) return true;
    if (window.showConfirmModal && !(await window.showConfirmModal('Discard your unsaved changes to this entry?'))) return false;
    window.cancelCodexEdit();
    return true;
}
window.cx2Category = async function (cat) {
    if (!(await leaveEditor())) return;
    S.view = 'list';
    window.switchCodexCategory(cat);
};
window.cx2Select = async function (id) {
    if (!(await leaveEditor())) return;
    S.selected[window.activeCodexCategory] = id;
    S.view = 'read';
    renderV2();
    const reader = document.getElementById('cx2-reader');
    if (reader) {
        reader.scrollTop = 0;
        const phone = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
        if (phone && reader.scrollIntoView) reader.scrollIntoView({ block: 'start' });
    }
};
window.cx2Back = function () { S.view = 'list'; renderV2(); };
window.cx2NewEntry = async function () {
    if (!isDm()) return;
    if (!(await leaveEditor())) return;
    window.cancelCodexEdit();
    const sel = document.getElementById('new-codex-category'); if (sel) sel.value = window.activeCodexCategory || 'factions';
    const h = document.getElementById('codex-creator-heading'); if (h) h.innerText = '+ New Codex Entry';
    S.editing = true; S.editTab = 'write'; S.view = 'read';
    renderV2();
    const t = document.getElementById('new-codex-title'); if (t) t.focus();
};
window.cx2ToggleHidden = async function (id) {
    if (!isDm()) return;
    const e = (globalCodexEntriesCache || []).find(x => x.id === id); if (!e) return;
    const { error } = await db.from('codex_entries').update({ is_hidden: !e.is_hidden }).eq('id', id);
    if (error) { alert('Could not change who sees this entry: ' + error.message); return; }
    e.is_hidden = !e.is_hidden;
    renderV2();
};

/* --- Hooks into the existing Codex (ui.js announces these; see window.onHook in js/db.js) --- */
// Take over the draw while the switch is on; otherwise tidy up and let ui.js draw the classic list.
window.onHook('codex-render', 'codex-v2', () => {
    if (window.codexRestyleOn()) { renderV2(); return false; }
    teardown();
    S.editing = false;
    return true;
});
// Phase 11: the ⛶ fullscreen reader picks up the new Codex look (same
// switch). Only classes change; ui.js still fills it.
window.onHook('codex-fullscreen-opened', 'codex-v2', () => {
    const on = window.codexRestyleOn();
    const modal = document.getElementById('codex-fullscreen-reader');
    const body = document.getElementById('reader-body-content');
    if (modal) modal.classList.toggle('cx2-fs', on);
    if (body) body.classList.toggle('cx2-text', on);
});
window.onHook('codex-entry-edit', 'codex-v2', (id) => {
    if (!window.codexRestyleOn() || !isDm()) return;
    const e = (globalCodexEntriesCache || []).find(x => x.id === id);
    if (e && e.category && e.category !== window.activeCodexCategory) window.activeCodexCategory = e.category;
    S.selected[window.activeCodexCategory] = id;
    S.editing = true; S.editTab = 'write'; S.view = 'read';
    renderV2();
});
window.onHook('codex-edit-cancelled', 'codex-v2', () => {
    if (!S.editing) return;
    S.editing = false; S.editTab = 'write';
    const content = document.getElementById('new-codex-content'); if (content) content.style.display = '';
    const prev = document.getElementById('cx2-preview'); if (prev) prev.style.display = 'none';
    if (window.codexRestyleOn()) renderV2(); else restoreForm();
});
// Remember which entry is being saved (read before ui.js clears the form), then select it after.
window.onHook('codex-save-start', 'codex-v2', () => {
    const t = document.getElementById('new-codex-title');
    S.savePending = { title: t ? t.value.trim() : '', id: window.editingCodexId || null };
});
window.onHook('codex-entry-saved', 'codex-v2', () => {
    const pending = S.savePending; S.savePending = null;
    if (window.codexRestyleOn() && !S.editing && pending && pending.title) { S.pendingSelect = pending; S.view = 'read'; renderV2(); }
});
window.onHook('codex-entry-deleted', 'codex-v2', (id) => {
    if (window.codexRestyleOn()) { Object.keys(S.selected).forEach(k => { if (S.selected[k] === id) delete S.selected[k]; }); }
});
window.onHook('codex-fullscreen-closed', 'codex-v2', () => {
    if (window.codexRestyleOn() && !S.editing) renderV2(); // its charts were drawn again if the pane shares any
});
// The switch flipping while the Codex is open re-draws it.
document.addEventListener('darkforest:features-changed', () => {
    const panel = document.getElementById('term-panel-codex');
    if (panel && (panel.classList.contains('active') || panel.classList.contains('cx2-on'))) window.renderCodexMatrix();
});
})();
