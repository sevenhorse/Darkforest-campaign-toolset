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
   subtitle only after that system has been DRADIS-scanned. Since 2026-10-29
   the database enforces the hidden part too: codex_entries RLS returns
   is_hidden rows to the DM only, and only the DM may insert/update/delete.

   Linked files + DM notes (switch 'codex_links', DM only to start):
   - A tab says what an entry IS, is_hidden says who sees it, and links say
     which story it belongs to. Links live in codex_links (child_id,
     master_id; many-to-many, so one file can belong to several masters).
   - A master shows LINKED FILES (each with SHOW/HIDE); a child shows a
     PART OF chip per master. MOVE TO changes the tab (moving into Session
     Prep also hides it).
   - DM notes live in codex_dm_notes, never in the entry text, so revealing
     an entry never reveals them. Both tables are DM-only by RLS.
   - Live sync: after a DM change the DM's browser broadcasts 'changed' on
     channel codex_sync; every client reloads the Codex, so a reveal (or a
     re-hide) reaches players without a page reload. Broadcast, not
     postgres_changes: RLS means a player never gets an event for a row
     going hidden, so a re-hide would otherwise linger on their screen. */
(function () {
const CATS = [
    { key: 'factions', tab: 'FACTIONS', title: 'FACTIONS & POWERS', icon: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"></path>' },
    { key: 'lore', tab: 'SECTOR LORE', title: 'SECTOR LORE & INTEL', icon: '<circle cx="12" cy="12" r="3"></circle><ellipse cx="12" cy="12" rx="10" ry="4"></ellipse>' },
    { key: 'npcs', tab: 'KEY NPCS', title: 'KEY NPCS & CONTACTS', icon: '<circle cx="12" cy="8" r="4"></circle><path d="M4 21c1-4 4-6 8-6s7 2 8 6"></path>' },
    { key: 'docs', tab: 'DOCUMENTS', title: 'DOCUMENTS & LOGS', icon: '<path d="M6 3h9l4 4v14H6z"></path><path d="M14 3v5h5"></path>' },
    // DM's own planning notes: the tab only exists for the DM (entries stay is_hidden as well).
    { key: 'prep', tab: 'SESSION PREP', title: 'SESSION PREP (DM ONLY)', dmOnly: true, icon: '<rect x="5" y="4" width="14" height="17"></rect><path d="M9 4V2h6v2"></path><path d="M8 10h8M8 14h8M8 18h5"></path>' }
];
const catsForMe = () => CATS.filter(c => !c.dmOnly || isDm());
const S = window.__cx2 = window.__cx2 || { selected: {}, view: 'list', editing: false, editTab: 'write', charts: [], pendingSelect: null, links: [], notes: {}, notesEditing: null, notesDraft: '' };
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
    if (link) return typeof window.codexLinkUnlocked === 'function' ? window.codexLinkUnlocked(link) : !!(window.scannedSystems && window.scannedSystems.includes(link));
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
    const cat = catsForMe().some(c => c.key === window.activeCodexCategory) ? window.activeCodexCategory : 'factions';
    window.activeCodexCategory = cat;

    const clear = document.getElementById('cx2-clear');
    clear.textContent = dm ? 'OVERSEER CLEARANCE' : 'READ-ONLY CLEARANCE';
    clear.classList.toggle('cx2-amber', dm);
    document.getElementById('cx2-new').style.display = dm ? '' : 'none';
    const search = document.getElementById('cx2-search');
    if (search && document.activeElement !== search) search.value = window.codexSearchFilter || '';

    document.getElementById('cx2-tabs').innerHTML = catsForMe().map(c => {
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
                    <span class="cx2-rowmeta">${tag ? `<span class="cx2-chip cx2-k-${kind}">${esc(tag.toUpperCase())}</span>` : ''}${dm && e.is_hidden ? '<span class="cx2-chip cx2-k-hostile">HIDDEN</span>' : ''}${dm && linkOf(e) ? '<span class="cx2-chip cx2-k-other">SCAN-LOCKED</span>' : ''}${linksOn() && childrenOf(e.id).length ? `<span class="cx2-chip cx2-k-part">${childrenOf(e.id).length} LINKED</span>` : ''}<span class="cx2-dim">${readMinutes(e)} MIN</span></span></span>
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
                <div class="cx2-chips">${tag ? `<span class="cx2-chip cx2-k-${kind}">${esc(tag.toUpperCase())}</span>` : ''}<span class="cx2-chip cx2-k-cat">${catInfo.tab}</span>${dm && e.is_hidden ? '<span class="cx2-chip cx2-k-hostile">HIDDEN FROM PLAYERS</span>' : ''}${dm && link ? `<span class="cx2-chip cx2-k-other" title="Players see this after scanning that system">UNLOCKS ON SCAN: ${esc(link)}</span>` : ''}${linksOn() ? partOfChips(e) : ''}</div>
                <div class="cx2-meta">FILED BY ${esc((author && author.username || 'UNKNOWN').toUpperCase())}${e.created_at ? ' · ' + fmtDate(e.created_at) : ''} · ~${readMinutes(e)} MIN READ</div>
            </div>
            <div class="cx2-acts">
                <button type="button" class="cx2-btn" onclick="window.openCodexFullscreen('${e.id}')">⛶ FULL SCREEN</button>
                ${dm ? `<button type="button" class="cx2-btn cx2-amber" onclick="window.editCodexEntry('${e.id}')">EDIT</button>
                <button type="button" class="cx2-btn cx2-dimbtn" onclick="window.cx2ToggleHidden('${e.id}')">${e.is_hidden ? 'SHOW' : 'HIDE'}</button>
                ${linksOn() ? moveSelect(e) : ''}
                <button type="button" class="cx2-btn cx2-red" aria-label="Delete entry" onclick="window.deleteCodexEntry('${e.id}')">✕</button>` : ''}
            </div>
        </div>
        <div class="cx2-text">${body.html}</div>
        ${linksOn() ? dmBox(e) : ''}
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
    // Players have no Session Prep tab, so showing a prep entry reaches nobody.
    if (e.is_hidden && e.category === 'prep' && window.showConfirmModal &&
        !(await window.showConfirmModal('This file is in Session Prep, which players never see. Showing it changes nothing for them until it is moved to another tab (MOVE TO). Show it anyway?'))) return;
    const { error } = await db.from('codex_entries').update({ is_hidden: !e.is_hidden }).eq('id', id);
    if (error) { alert('Could not change who sees this entry: ' + error.message); return; }
    e.is_hidden = !e.is_hidden;
    renderV2();
    window.codexAnnounceChange();
};

/* --- Linked files + DM notes (switch 'codex_links'; see the header) --- */
const byId = (id) => (globalCodexEntriesCache || []).find(x => x.id === id);
function linksOn() { return isDm() && window.codexRestyleOn() && typeof window.isFeatureOn === 'function' && window.isFeatureOn('codex_links'); }
window.codexLinksOn = linksOn;
function childrenOf(id) { return (S.links || []).filter(l => l.master_id === id && byId(l.child_id)).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map(l => byId(l.child_id)); }
function mastersOf(id) { return (S.links || []).filter(l => l.child_id === id && byId(l.master_id)).map(l => byId(l.master_id)); }
window.codexChildrenOf = childrenOf; window.codexMastersOf = mastersOf; // tests
function tabName(cat) { const c = CATS.find(x => x.key === cat); return c ? c.tab : String(cat || '').toUpperCase(); }

async function loadLinkData() {
    if (!isDm()) { S.links = []; S.notes = {}; return; }
    const [l, n] = await Promise.all([
        db.from('codex_links').select('*'),
        db.from('codex_dm_notes').select('*')
    ]);
    if (l && !l.error) S.links = l.data || [];
    if (n && !n.error) { S.notes = {}; (n.data || []).forEach(r => { S.notes[r.entry_id] = r.notes || ''; }); }
    const panel = document.getElementById('term-panel-codex');
    if (window.codexRestyleOn() && panel && panel.classList.contains('cx2-on') && !S.editing) renderV2();
}
window.codexLoadLinkData = loadLinkData;

// Live sync. Players only listen; the DM's browser announces.
let syncCh = null, syncTimer = null;
function ensureSync() {
    if (syncCh || typeof db === 'undefined' || !db || typeof db.channel !== 'function') return;
    syncCh = db.channel('codex_sync');
    syncCh.on('broadcast', { event: 'changed' }, () => {
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => { if (typeof loadCodexEntries === 'function') loadCodexEntries(); }, 400);
    });
    syncCh.subscribe();
}
window.codexSyncReset = function () { syncCh = null; ensureSync(); }; // tests
window.codexAnnounceChange = function () {
    if (!isDm() || !syncCh || !window.isFeatureOn || !window.isFeatureOn('codex_links')) return;
    try { const p = syncCh.send({ type: 'broadcast', event: 'changed', payload: {} }); if (p && p.then) p.then(() => {}, () => {}); } catch (e) {}
};

function partOfChips(e) {
    return mastersOf(e.id).map(m => `<button type="button" class="cx2-chip cx2-k-part" title="Open the master file" onclick="window.cx2Goto('${m.id}')">PART OF: ${esc(String(m.title || 'Untitled').toUpperCase())}</button>`).join('');
}
function moveSelect(e) {
    const opts = CATS.filter(c => c.key !== e.category).map(c => `<option value="${c.key}">${c.tab}</option>`).join('');
    return `<label class="cx2-move"><span class="cx2-sr">Move this entry to another tab</span><select onchange="window.cx2MoveTo('${e.id}', this.value); this.value='';"><option value="">MOVE TO…</option>${opts}</select></label>`;
}
function statusChip(c) {
    if (c.category === 'prep') return '<span class="cx2-chip cx2-k-neutral" title="Players never see the Session Prep tab">PREP TAB</span>';
    if (c.is_hidden) return '<span class="cx2-chip cx2-k-hostile">HIDDEN</span>';
    if (linkOf(c)) return '<span class="cx2-chip cx2-k-other" title="Shown, but players need to scan its system first">SCAN-LOCKED</span>';
    return '<span class="cx2-chip cx2-k-ally">PLAYERS SEE IT</span>';
}
function dmBox(e) {
    const kids = childrenOf(e.id);
    const rows = kids.map(c => `<div class="cx2-lrow">
            <button type="button" class="cx2-lopen" onclick="window.cx2Goto('${c.id}')">${esc(c.title || 'Untitled')}</button>
            <span class="cx2-chip cx2-k-cat">${tabName(c.category)}</span>${statusChip(c)}
            <span class="cx2-grow"></span>
            <button type="button" class="cx2-btn cx2-dimbtn cx2-sm" onclick="window.cx2ToggleHidden('${c.id}')">${c.is_hidden ? 'SHOW' : 'HIDE'}</button>
            <button type="button" class="cx2-btn cx2-red cx2-sm" aria-label="Unlink ${esc(c.title || '')}" title="Unlink (the file itself is kept)" onclick="window.cx2Unlink('${c.id}', '${e.id}')">✕</button>
        </div>`).join('');
    const has = Object.prototype.hasOwnProperty.call(S.notes, e.id) && String(S.notes[e.id]).trim();
    let notes;
    if (S.notesEditing === e.id) {
        notes = `<textarea id="cx2-notes-input" class="cx2-notes-input" rows="8" placeholder="Secrets, rulings, what this NPC really knows... never sent to players." oninput="window.__cx2.notesDraft = this.value">${esc(S.notesDraft)}</textarea>
            <div class="cx2-dmacts"><button type="button" class="cx2-btn cx2-amber cx2-sm" onclick="window.cx2SaveNotes('${e.id}')">SAVE NOTES</button><button type="button" class="cx2-btn cx2-dimbtn cx2-sm" onclick="window.cx2EditNotes(null)">CANCEL</button></div>`;
    } else {
        notes = has ? `<div class="cx2-notes codex-markdown">${window.renderCodexMarkdown(String(S.notes[e.id]), 'cx2-nchart').html}</div>` : '<div class="cx2-dim cx2-pad">No DM notes on this file.</div>';
        notes += `<div class="cx2-dmacts"><button type="button" class="cx2-btn cx2-amber cx2-sm" onclick="window.cx2EditNotes('${e.id}')">${has ? 'EDIT NOTES' : '+ ADD DM NOTES'}</button></div>`;
    }
    return `<section class="cx2-dmbox" aria-label="DM only">
        <div class="cx2-ttl cx2-amber-ttl"><span>LINKED FILES (${kids.length})</span><span class="cx2-dmacts-inline">
            <button type="button" class="cx2-btn cx2-amber cx2-sm" onclick="window.cx2OpenPicker('${e.id}', 'children')">+ ADD FILES</button>
            <button type="button" class="cx2-btn cx2-soft cx2-sm" onclick="window.cx2OpenPicker('${e.id}', 'masters')">PART OF…</button></span></div>
        ${kids.length ? `<div class="cx2-lrows">${rows}</div>` : '<div class="cx2-dim cx2-pad">No files are linked to this one. + ADD FILES links NPCs, species or documents to it; PART OF… links this file to a master doc.</div>'}
        <div class="cx2-ttl cx2-amber-ttl"><span>DM NOTES</span><span>NEVER SHOWN TO PLAYERS</span></div>
        ${notes}
    </section>`;
}

// Open any entry, in whatever tab it lives in.
window.cx2Goto = async function (id) {
    const e = byId(id); if (!e) return;
    if (!(await leaveEditor())) return;
    if (window.codexSearchFilter && !matchesSearch(e)) window.codexSearchFilter = '';
    S.selected[e.category] = id;
    S.view = 'read';
    window.switchCodexCategory(e.category);
    const reader = document.getElementById('cx2-reader'); if (reader) reader.scrollTop = 0;
};
window.cx2MoveTo = async function (id, cat) {
    if (!isDm() || !cat || !CATS.some(c => c.key === cat)) return;
    const e = byId(id); if (!e || e.category === cat) return;
    const upd = { category: cat };
    if (cat === 'prep') upd.is_hidden = true; // Session Prep entries are always hidden
    const { error } = await db.from('codex_entries').update(upd).eq('id', id);
    if (error) { alert('Could not move this entry: ' + error.message); return; }
    Object.assign(e, upd);
    if (window.showToast) window.showToast(`Moved to ${tabName(cat)}${upd.is_hidden ? ' (hidden)' : ''}.`);
    window.codexAnnounceChange();
    await window.cx2Goto(id);
};
window.cx2Unlink = async function (childId, masterId) {
    if (!isDm()) return;
    const l = (S.links || []).find(x => x.child_id === childId && x.master_id === masterId); if (!l) return;
    const { error } = await db.from('codex_links').delete().eq('id', l.id);
    if (error) { alert('Could not unlink: ' + error.message); return; }
    S.links = S.links.filter(x => x.id !== l.id);
    renderV2();
};
window.cx2EditNotes = function (id) {
    S.notesEditing = id || null;
    S.notesDraft = id ? (S.notes[id] || '') : '';
    renderV2();
    if (id) { const t = document.getElementById('cx2-notes-input'); if (t) t.focus(); }
};
window.cx2SaveNotes = async function (id) {
    if (!isDm()) return;
    const notes = String(S.notesDraft || '');
    const { error } = await db.from('codex_dm_notes').upsert({ entry_id: id, notes, updated_at: new Date().toISOString() }, { onConflict: 'entry_id' });
    if (error) { alert('Could not save the DM notes: ' + error.message); return; }
    S.notes[id] = notes; S.notesEditing = null; S.notesDraft = '';
    renderV2();
};

// Picker: choose this entry's linked files ('children') or its masters ('masters').
window.cx2OpenPicker = function (id, mode) {
    const e = byId(id); if (!e || !isDm()) return;
    const linked = new Set((S.links || []).filter(l => mode === 'children' ? l.master_id === id : l.child_id === id).map(l => mode === 'children' ? l.child_id : l.master_id));
    S.pick = { id, mode, chosen: new Set(linked), q: '' };
    let ov = document.getElementById('cx2-pick');
    if (!ov) { ov = document.createElement('div'); ov.id = 'cx2-pick'; ov.className = 'cx2-pick-ov'; document.body.appendChild(ov); }
    ov.innerHTML = `<div class="cx2-pick cx2-panel" role="dialog" aria-modal="true" aria-labelledby="cx2-pick-h">
        <div class="cx2-ttl cx2-amber-ttl"><span id="cx2-pick-h">${mode === 'children' ? 'FILES LINKED TO' : 'MASTER DOCS FOR'}: ${esc(String(e.title || '').toUpperCase())}</span></div>
        <label class="cx2-search cx2-pick-search"><span class="cx2-sr">Filter entries</span><input type="text" id="cx2-pick-q" placeholder="Filter by title or tag" autocomplete="off" oninput="window.cx2PickFilter(this.value)"></label>
        <div class="cx2-pick-list" id="cx2-pick-list"></div>
        <div class="cx2-dmacts"><span class="cx2-dim" id="cx2-pick-count"></span><span class="cx2-grow"></span>
            <button type="button" class="cx2-btn cx2-dimbtn" onclick="window.cx2ClosePicker()">CANCEL</button>
            <button type="button" class="cx2-btn cx2-amber" onclick="window.cx2SavePicker()">SAVE LINKS</button></div>
    </div>`;
    ov.style.display = 'flex';
    ov.onclick = (ev) => { if (ev.target === ov) window.cx2ClosePicker(); };
    renderPickList();
    const q = document.getElementById('cx2-pick-q'); if (q) q.focus();
};
function renderPickList() {
    const P = S.pick, box = document.getElementById('cx2-pick-list'); if (!P || !box) return;
    const q = P.q;
    box.innerHTML = CATS.map(c => {
        const items = window.applySavedOrder('codex_' + c.key, (globalCodexEntriesCache || []).filter(x => x.category === c.key && x.id !== P.id))
            .filter(x => !q || [x.title, x.subtitle].some(t => t && String(t).toLowerCase().includes(q)));
        if (!items.length) return '';
        return `<div class="cx2-pick-cat">${c.tab}</div>` + items.map(x => `<label class="cx2-pick-row"><input type="checkbox" ${P.chosen.has(x.id) ? 'checked' : ''} onchange="window.cx2PickToggle('${x.id}', this.checked)"><span>${esc(x.title || 'Untitled')}</span>${x.is_hidden ? '<span class="cx2-chip cx2-k-hostile">HIDDEN</span>' : ''}</label>`).join('');
    }).join('') || '<div class="cx2-empty">Nothing matches.</div>';
    const n = document.getElementById('cx2-pick-count'); if (n) n.textContent = `${P.chosen.size} SELECTED`;
}
window.cx2PickFilter = function (v) { if (S.pick) { S.pick.q = String(v || '').toLowerCase().trim(); renderPickList(); } };
window.cx2PickToggle = function (id, on) { if (!S.pick) return; if (on) S.pick.chosen.add(id); else S.pick.chosen.delete(id); const n = document.getElementById('cx2-pick-count'); if (n) n.textContent = `${S.pick.chosen.size} SELECTED`; };
window.cx2ClosePicker = function () { S.pick = null; const ov = document.getElementById('cx2-pick'); if (ov) ov.style.display = 'none'; };
window.cx2SavePicker = async function () {
    const P = S.pick; if (!P || !isDm()) return;
    const kids = P.mode === 'children';
    const mine = (S.links || []).filter(l => kids ? l.master_id === P.id : l.child_id === P.id);
    const other = (l) => kids ? l.child_id : l.master_id;
    const drop = mine.filter(l => !P.chosen.has(other(l))).map(l => l.id);
    const have = new Set(mine.map(other));
    const add = [...P.chosen].filter(x => !have.has(x)).map((x, i) => kids
        ? { child_id: x, master_id: P.id, sort_order: Date.now() + i }
        : { child_id: P.id, master_id: x, sort_order: Date.now() + i });
    if (drop.length) { const { error } = await db.from('codex_links').delete().in('id', drop); if (error) { alert('Could not remove links: ' + error.message); return; } }
    if (add.length) { const { error } = await db.from('codex_links').insert(add); if (error) { alert('Could not add links: ' + error.message); return; } }
    window.cx2ClosePicker();
    await loadLinkData();
    renderV2();
};

/* --- Shared with the Codex quick look (js/screen-switcher.js) --- */
window.codexV2Api = { cats: catsForMe, visible: visibleToMe, cleanTag, initials, readMinutes, body: bodyHtml, linkOf };
// Open one entry in the Codex tab's reading pane (the quick look's OPEN IN CODEX).
window.codexOpenEntry = function (id) {
    const e = (globalCodexEntriesCache || []).find(x => x.id === id);
    if (!e) return;
    if (!window.codexRestyleOn()) { window.openFullCodexTerminal(); window.openCodexFullscreen(id); return; }
    if (!S.editing) {
        if (window.codexSearchFilter && !matchesSearch(e)) window.codexSearchFilter = '';
        window.activeCodexCategory = e.category;
        S.selected[e.category] = id;
        S.view = 'read';
    }
    window.openFullCodexTerminal();
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
// Links/notes + live sync: db.js loadCodexEntries announces codex-loaded.
window.onHook('codex-loaded', 'codex-v2', () => { ensureSync(); if (isDm()) loadLinkData(); });
window.onHook('codex-entry-saved', 'codex-v2-sync', () => window.codexAnnounceChange(), 60);
window.onHook('codex-entry-deleted', 'codex-v2-sync', () => window.codexAnnounceChange(), 60);
window.onHook('codex-fullscreen-closed', 'codex-v2', () => {
    if (window.codexRestyleOn() && !S.editing) renderV2(); // its charts were drawn again if the pane shares any
});
// The switch flipping while the Codex is open re-draws it.
document.addEventListener('darkforest:features-changed', () => {
    const panel = document.getElementById('term-panel-codex');
    if (panel && (panel.classList.contains('active') || panel.classList.contains('cx2-on'))) window.renderCodexMatrix();
});
})();
