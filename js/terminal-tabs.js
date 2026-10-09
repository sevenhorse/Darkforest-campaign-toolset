/* ==========================================================================
   js/terminal-tabs.js - Command Terminal grouped tabs (UI restyle R1)
   ==========================================================================
   DM decisions (2026-10-09, from the R1 mockup): four Codex-style group tabs
   across the top (CREW / FLEET / DESIGN / INTEL) with the chosen group's
   pages as a smaller tab row underneath; Manufacturing keeps its gold
   accent, Secret Repository and Cloud Codex their red; phones get two
   swipeable strips. Feature switch 'terminal_restyle' (DM first).

   Navigation only. Every page, its id and its loader stay as they are: a tab
   here just calls window.switchTermTab(name). The old sidebar stays in the
   page (hidden while the switch is on) and remains the source of truth for:
   - which page is open (.term-tab-btn-vert.active),
   - which pages this user may see (a sidebar button with display:none,
     e.g. the DM-only Strike Craft Designer / Secret Repository),
   - the page counts (#badge-<page>, set by the page files as before).
   A MutationObserver on the sidebar keeps this bar in step with all three,
   so none of the files that set badges or hide buttons need to know about it.
   ========================================================================== */
(function () {
const GROUPS = [
    { key: 'crew', label: 'CREW', icon: '<circle cx="12" cy="8" r="4"></circle><path d="M4 21c1-4 4-6 8-6s7 2 8 6"></path>',
      pages: [['stats', 'DOSSIER & STATS'], ['combat', 'ARSENAL'], ['cargo', 'MANIFEST'], ['roster', 'CREW ROSTER']] },
    { key: 'fleet', label: 'FLEET', icon: '<path d="M12 2l9 5v10l-9 5-9-5V7z"></path><path d="M12 7v10M7 9.5l10 5M17 9.5l-10 5"></path>',
      pages: [['vessel', 'VESSEL DECK'], ['colonies', 'COLONIES & FLEETS'], ['manufacturing', 'MANUFACTURING', 'var(--df-gold)']] },
    { key: 'design', label: 'DESIGN', icon: '<path d="M3 21l4-1 12-12-3-3L4 17z"></path><path d="M14 6l3 3"></path>',
      pages: [['shipdesigner', 'SHIP DESIGNER'], ['strikecraft', 'STRIKE CRAFT'], ['perkdesigner', 'PERKS'], ['augmentdesigner', 'AUGMENTS'],
              ['geardesigner', 'GEAR'], ['secretrepo', 'SECRET REPOSITORY', 'var(--df-red)']] },
    { key: 'intel', label: 'INTEL', icon: '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="4"></circle><path d="M12 12l6-6"></path>',
      pages: [['notes', 'INTEL & OPS'], ['codex', 'CLOUD CODEX', 'var(--df-red)']] }
];
// Pages the sidebar only shows to the DM: tagged "DM" on their tab.
const DM_ONLY = new Set(['strikecraft', 'secretrepo']);
const lastPage = {}; // group key -> last page opened in it (this visit)
let shownGroup = null;
let observer = null;

window.terminalRestyleOn = function () { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('terminal_restyle'); };
const esc = (s) => (typeof window.escapeHtml === 'function' ? window.escapeHtml(s) : String(s));
const sideBtn = (page) => document.getElementById('term-tab-btn-' + page);
function pageVisible(page) {
    const b = sideBtn(page);
    return !!b && b.style.display !== 'none';
}
function badgeText(page) {
    const b = document.getElementById('badge-' + page);
    if (!b) return '';
    const t = (b.textContent || '').trim();
    return t === '0' ? '' : t;
}
function currentPage() {
    const a = document.querySelector('.term-tab-btn-vert.active');
    return a ? a.id.replace('term-tab-btn-', '') : 'stats';
}
function groupOf(page) { return GROUPS.find(g => g.pages.some(p => p[0] === page)) || GROUPS[0]; }

function ensureNav() {
    let nav = document.getElementById('tt-nav');
    if (nav) return nav;
    const area = document.getElementById('term-content-area');
    if (!area) return null;
    nav = document.createElement('div');
    nav.id = 'tt-nav';
    nav.innerHTML = '<nav class="df-tabs" id="tt-groups" aria-label="Terminal sections"></nav><nav class="df-subtabs" id="tt-pages" aria-label="Pages in this section"></nav>';
    area.insertBefore(nav, area.firstChild);
    return nav;
}

function render() {
    const term = document.getElementById('character-terminal');
    if (!term) return;
    const on = window.terminalRestyleOn();
    term.classList.toggle('tt-on', on);
    if (!on) return;
    if (!ensureNav()) return;
    const cur = currentPage();
    const curGroup = groupOf(cur);
    if (pageVisible(cur)) lastPage[curGroup.key] = cur;
    const group = GROUPS.find(g => g.key === shownGroup) || curGroup;
    shownGroup = group.key;

    document.getElementById('tt-groups').innerHTML = GROUPS.map(g => {
        const pages = g.pages.filter(p => pageVisible(p[0]));
        if (!pages.length) return '';
        const count = pages.reduce((n, p) => n + (parseInt(badgeText(p[0]), 10) || 0), 0);
        return `<button type="button" class="df-tab${g.key === group.key ? ' on' : ''}" id="tt-group-${g.key}" data-group="${g.key}" aria-pressed="${g.key === group.key}">`
            + `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${g.icon}</svg>`
            + `<span>${g.label}</span>${count > 0 ? `<b>${count}</b>` : ''}</button>`;
    }).join('');

    document.getElementById('tt-pages').innerHTML = group.pages.filter(p => pageVisible(p[0])).map(p => {
        const [key, label, accent] = p;
        const count = badgeText(key);
        const style = accent ? ` style="--acc: ${accent}"` : '';
        return `<button type="button" class="df-subtab${key === cur ? ' on' : ''}" id="tt-sub-${key}" data-page="${key}"${style} aria-current="${key === cur ? 'page' : 'false'}">`
            + `<span>${esc(label)}</span>${count ? `<b>${esc(count)}</b>` : ''}${DM_ONLY.has(key) ? '<i>DM</i>' : ''}</button>`;
    }).join('');

    const active = document.querySelector('#tt-pages .df-subtab.on') || document.querySelector('#tt-groups .df-tab.on');
    if (active && typeof active.scrollIntoView === 'function') { try { active.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
    watchSidebar();
}
window.renderTerminalTabs = render;

// Group tab: show that group and open its last page (else its first visible page).
function openGroup(key) {
    const g = GROUPS.find(x => x.key === key);
    if (!g) return;
    shownGroup = key;
    const pages = g.pages.filter(p => pageVisible(p[0])).map(p => p[0]);
    const target = pages.includes(lastPage[key]) ? lastPage[key] : pages[0];
    if (target && target !== currentPage()) window.switchTermTab(target);
    else render();
}
document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('#tt-nav button') : null;
    if (!t) return;
    if (t.dataset.group) openGroup(t.dataset.group);
    else if (t.dataset.page) { shownGroup = groupOf(t.dataset.page).key; window.switchTermTab(t.dataset.page); }
});

// Keep counts / DM-only visibility in step with the (hidden) sidebar.
function watchSidebar() {
    if (observer || typeof MutationObserver !== 'function') return;
    const side = document.getElementById('term-sidebar');
    if (!side) return;
    let queued = false;
    observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        setTimeout(() => { queued = false; render(); }, 0);
    });
    observer.observe(side, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
}

// For the main tutorial: the visible tab for a terminal page (its group is
// shown first so the sub-tab exists), or null when the restyle is off.
window.terminalTabTarget = function (page) {
    if (!window.terminalRestyleOn()) return null;
    shownGroup = groupOf(page).key;
    render();
    return document.getElementById('tt-sub-' + page);
};

// Any page switch (tabs, tutorial, links): follow it.
window.onHook('term-tab-switched', 'terminal-tabs', (page) => { shownGroup = groupOf(page).key; render(); });
document.addEventListener('darkforest:features-changed', render);
render();
})();
