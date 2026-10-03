/* ==========================================================================
   js/battle-chrome.js - Battle Map header + left column restyle (Phase 6d)
   ==========================================================================
   DM decision (2026-10-03, from the 6d mockup): after the Codex, restyle
   the parts of the Battle Map around the grid that still had the old
   green-terminal look:
   - one command bar on top: battle name, ROUND chip, the turn bar, the
     existing action buttons, and CLOSE;
   - the left column as tactical panels: DEPLOY (tabs VESSELS / TEMPLATE /
     FLEET -- the last two DM only) above COMMS & DICE;
   - Incoming Ordnance as a panel under the view.
   The grid / 3D view, roster, objective and Vessel HUD are unchanged.

   No logic moves: the existing elements (same ids, same handlers, still
   shown/hidden by renderBattleMapPanel) are re-parented into the new
   layout while the switch is on and put back exactly where they were when
   it's off. Feature switch 'battle_chrome' (DM only to start); it only
   applies on top of the tactical look (tactical_v2_ui). */
(function () {
const moved = [];   // { node, parent, next } -- where each element came from
function remember(node) {
    if (!node || moved.some(m => m.node === node)) return;
    moved.push({ node, parent: node.parentNode, next: node.nextSibling });
}
function putBack() {
    for (let i = moved.length - 1; i >= 0; i--) {
        const m = moved[i];
        if (m.next && m.next.parentNode === m.parent) m.parent.insertBefore(m.node, m.next);
        else m.parent.appendChild(m.node);
    }
    moved.length = 0;
}
window.battleChromeOn = function () {
    return typeof window.isFeatureOn === 'function' && window.isFeatureOn('battle_chrome')
        && document.getElementById('battle-map-panel') && document.getElementById('battle-map-panel').classList.contains('tv2');
};

function ensureBar(panel) {
    let bar = document.getElementById('bmx-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'bmx-bar';
    bar.className = 'bmx-bar';
    bar.innerHTML = `
        <div class="bmx-id"><span class="bmx-kicker">TACTICAL BATTLE MAP</span><span id="bmx-name-slot"></span></div>
        <span class="bmx-chip" id="bmx-round"></span>
        <span id="bmx-turn-slot"></span>
        <span class="bmx-grow"></span>
        <span id="bmx-btn-slot"></span>
        <button type="button" class="bmx-close" onclick="window.toggleBattleMap()">✕ CLOSE</button>`;
    const header = document.getElementById('battle-map-header');
    panel.insertBefore(bar, header ? header.nextSibling : panel.firstChild);
    const name = document.getElementById('battle-map-encounter-name');
    const btnRow = document.getElementById('battle-map-roll-initiative-btn') && document.getElementById('battle-map-roll-initiative-btn').parentNode;
    const turnBar = document.getElementById('battle-map-turn-bar');
    [name, btnRow, turnBar].forEach(remember);
    if (name) document.getElementById('bmx-name-slot').appendChild(name);
    if (turnBar) document.getElementById('bmx-turn-slot').appendChild(turnBar);
    if (btnRow) { btnRow.classList.add('bmx-btns'); document.getElementById('bmx-btn-slot').appendChild(btnRow); }
    return bar;
}
function ensureDeploy() {
    const col = document.querySelector('#battle-map-panel .battle-map-dice-col');
    const palette = document.getElementById('battle-map-palette');
    const dmDeploy = document.getElementById('battle-map-dm-deploy');
    if (!col || !palette || !dmDeploy) return null;
    let box = document.getElementById('bmx-deploy');
    if (box) return box;
    // Split the DM deploy block into its two halves once (plain wrappers,
    // harmless when the switch is off).
    if (!dmDeploy.querySelector('.bmx-tpl')) {
        const kids = Array.from(dmDeploy.children);
        const fleetStart = kids.findIndex(k => k.id === 'battle-map-fleet-select') - 2; // its <h5> + <label>
        const tpl = document.createElement('div'); tpl.className = 'bmx-tpl';
        const fleet = document.createElement('div'); fleet.className = 'bmx-fleet';
        kids.forEach((k, i) => (fleetStart > 0 && i >= fleetStart ? fleet : tpl).appendChild(k));
        dmDeploy.appendChild(tpl); dmDeploy.appendChild(fleet);
    }
    box = document.createElement('section');
    box.id = 'bmx-deploy';
    box.className = 'bmx-panel';
    box.setAttribute('aria-label', 'Deploy');
    box.innerHTML = `<div class="bmx-ttl">DEPLOY</div>
        <div class="bmx-tabs" role="tablist" id="bmx-deploy-tabs">
            <button type="button" role="tab" data-tab="vessels" onclick="window.bmxDeployTab('vessels')">VESSELS</button>
            <button type="button" role="tab" data-tab="template" onclick="window.bmxDeployTab('template')">TEMPLATE</button>
            <button type="button" role="tab" data-tab="fleet" onclick="window.bmxDeployTab('fleet')">FLEET</button>
        </div>
        <div class="bmx-deploy-body"></div>`;
    const palWrap = palette.parentNode;
    remember(palWrap); remember(dmDeploy);
    col.insertBefore(box, col.firstChild);
    const body = box.querySelector('.bmx-deploy-body');
    palWrap.classList.add('bmx-palwrap');
    body.appendChild(palWrap);
    body.appendChild(dmDeploy);
    // the comms dock becomes the second panel
    const comms = document.getElementById('bm-comms-dock-body');
    if (comms && comms.parentNode) comms.parentNode.classList.add('bmx-comms');
    box.__made = true;
    return box;
}
let deployTab = 'vessels';
window.bmxDeployTab = function (tab) {
    deployTab = ['vessels', 'template', 'fleet'].includes(tab) ? tab : 'vessels';
    applyDeployTab();
};
function applyDeployTab() {
    const panel = document.getElementById('battle-map-panel');
    const dmDeploy = document.getElementById('battle-map-dm-deploy');
    const dmCan = !!dmDeploy && dmDeploy.style.display !== 'none';
    if (!dmCan) deployTab = 'vessels';
    panel.setAttribute('data-bmx-tab', deployTab);
    panel.classList.toggle('bmx-dmdeploy', dmCan);
    document.querySelectorAll('#bmx-deploy-tabs button').forEach(b => {
        const on = b.dataset.tab === deployTab;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
}

function sync() {
    const panel = document.getElementById('battle-map-panel');
    if (!panel) return;
    const on = window.battleChromeOn();
    if (!on) {
        if (panel.classList.contains('bmx')) {
            putBack();
            const bar = document.getElementById('bmx-bar'); if (bar) bar.remove();
            const dep = document.getElementById('bmx-deploy'); if (dep) dep.remove();
            panel.classList.remove('bmx', 'bmx-active', 'bmx-dmdeploy');
            panel.removeAttribute('data-bmx-tab');
        }
        return;
    }
    panel.classList.add('bmx');
    const bar = ensureBar(panel);
    ensureDeploy();
    const active = document.getElementById('battle-map-active-container');
    const isActive = !!active && active.style.display !== 'none';
    panel.classList.toggle('bmx-active', isActive);
    bar.style.display = isActive ? '' : 'none';
    const enc = window.globalBattleEncounterCache;
    const round = document.getElementById('bmx-round');
    // The turn bar already says "ROUND n -- X'S TURN" once initiative is rolled.
    const turnBar = document.getElementById('battle-map-turn-bar');
    const turnShown = !!turnBar && turnBar.style.display !== 'none';
    if (round) { round.textContent = enc ? `ROUND ${enc.round_number || 1}` : ''; round.style.display = enc && !turnShown ? '' : 'none'; }
    applyDeployTab();
}
window.battleChromeSync = sync;

const orig = window.renderBattleMapPanel;
if (typeof orig === 'function') {
    window.renderBattleMapPanel = function () {
        const r = orig.apply(this, arguments);
        try { sync(); } catch (e) { console.error('battle chrome:', e); }
        return r;
    };
}
document.addEventListener('darkforest:features-changed', () => { try { sync(); } catch (e) {} });
})();
