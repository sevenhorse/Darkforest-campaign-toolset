/* Fleets panel + strength bar (roadmap item 2, switch 'fleets_panel').
   A strip at the top of the Battle Map's right column with one row per combat side
   (window.vesselCombatSide: players incl. allied NPCs / hostile / neutral):
   a strength bar, ships remaining, ships lost, wings out and in hangars.

   DISPLAY ONLY (DM decision 2026-11-11): nothing here feeds dice, damage or AI.

   Strength = the side's current shields + armour + hull, as a share of the
   same total when each ship entered the battle. That starting figure is kept
   per ship in battle_encounters.fleet_start ({ shipId: { hp, side, name, craft } }),
   written by the DM's browser the first time it sees a ship in the battle
   (launch, manual add and reinforcements all go through the same path).
   Strike craft are counted as wings, never added into the bar.

   Where it sits: with the Vessel HUD on (switch 'tactical_v2_ui', the live
   setup) the old Friendly/Neutral/Hostile tabs are hidden, so the panel goes
   directly above the HUD's ship sheet. With the HUD off it goes directly
   above those tabs, and a click on a side opens that side's tab.

   Fog of war: a ship the viewer cannot see (window.isVesselVisibleToMe) is
   left out of every number, so a player's enemy bar only covers what they can
   see and is marked "estimated". Hangar counts of other sides are DM only. */
(function () {
'use strict';
const SIDES = ['players', 'hostile', 'neutral'];
const SIDE_COLOR = { players: '#00e5a3', neutral: '#c9962f', hostile: '#ff3333' }; // same as the token rings
const SIDE_WORD = { players: 'ALLIED', neutral: 'NEUTRAL', hostile: 'HOSTILE' };
const SIDE_TAB = { players: 'friendly', neutral: 'neutral', hostile: 'hostile' };
const OPEN_KEY = 'darkforest_fleets_panel_open';

function panelOn() { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('fleets_panel'); }
const esc = (x) => (window.escapeHtml ? window.escapeHtml(x) : String(x));
const num = (x, d) => (x === undefined || x === null ? d : (Number(x) || 0));

// Everything damage has to chew through, with the same fallbacks as
// window.resolveShipDamage (js/combat.js) so the two can never disagree.
window.fleetShipHp = function (v) {
    if (!v) return 0;
    return Math.max(0, num(v.integrity_shields, 400)) + Math.max(0, num(v.integrity_reactive, 10)) + Math.max(0, num(v.integrity_ablative, 10))
        + Math.max(0, num(v.integrity_hardened, 0)) + Math.max(0, num(v.integrity_hull, 300));
};

/* The numbers behind the panel, for the current viewer.
   Returns null with no active battle, else
   { sides: [{ side, word, label, color, cur, start, pct, ships, shipsStart, lost: [names], withdrawn, wingsOut, wingsIn (null = not shown), estimated }] }
   in a fixed order, sides with nothing to show left out. */
window.fleetsPanelData = function () {
    const enc = window.globalBattleEncounterCache;
    if (!enc) return null;
    const isDm = typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
    const base = (enc.fleet_start && typeof enc.fleet_start === 'object') ? enc.fleet_start : {};
    const markers = new Map((typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).map(m => [m.id, m]));
    const inBattle = new Set((enc.tokens || []).map(t => t.ship_marker_id));
    const S = {};
    SIDES.forEach(side => { S[side] = { side, word: SIDE_WORD[side], color: SIDE_COLOR[side], cur: 0, start: 0, ships: 0, shipsStart: 0, lost: [], withdrawn: 0, wingsOut: 0, wingsIn: 0, factions: {} }; });
    new Set([...inBattle, ...Object.keys(base)]).forEach(id => {
        const v = markers.get(id), b = base[id];
        if (!v && !b) return; // token whose ship record is gone and was never counted
        if (v && typeof window.isVesselVisibleToMe === 'function' && !window.isVesselVisibleToMe(v)) return; // fog of war
        if (!v && !isDm) return; // record gone: nothing a player could have seen
        const side = S[v ? window.vesselCombatSide(v) : b.side];
        if (!side) return;
        const present = !!v && inBattle.has(id);
        if (v ? v.is_strike_craft : b.craft) { if (present) side.wingsOut++; return; }
        const hpNow = present ? window.fleetShipHp(v) : 0;
        side.cur += hpNow;
        side.start += b ? Math.max(0, Number(b.hp) || 0) : hpNow; // not recorded yet: counts as it stands
        side.shipsStart++;
        if (present) {
            side.ships++;
            side.wingsIn += (v.ship_hangar || []).length;
            const f = String(v.faction || '').trim(); if (f) side.factions[f] = (side.factions[f] || 0) + 1;
        } else if (!v || num(v.integrity_hull, 300) <= 0) side.lost.push(v ? v.name : (b.name || 'Unknown'));
        else side.withdrawn++;
    });
    const sides = SIDES.map(k => S[k]).filter(s => s.shipsStart > 0 || s.wingsOut > 0).map(s => {
        const names = Object.keys(s.factions).sort((a, b2) => s.factions[b2] - s.factions[a] || a.localeCompare(b2));
        const mine = s.side === 'players';
        return {
            side: s.side, word: s.word, color: s.color,
            label: names.length ? names[0] + (names.length > 1 ? ` +${names.length - 1}` : '') : '',
            cur: s.cur, start: s.start,
            pct: s.start > 0 ? Math.max(0, Math.min(100, Math.round(s.cur / s.start * 100))) : (s.ships ? 100 : 0),
            ships: s.ships, shipsStart: s.shipsStart, lost: s.lost, withdrawn: s.withdrawn, wingsOut: s.wingsOut,
            wingsIn: (isDm || mine) ? s.wingsIn : null,
            estimated: !isDm && !mine
        };
    });
    return { sides };
};

/* DM only: record the starting strength of every ship in the battle that has
   none yet. Debounced, because a launch adds dozens of tokens in a burst. */
let baseTimer = null;
function missingBaseline() {
    const enc = window.globalBattleEncounterCache;
    if (!enc) return [];
    const base = enc.fleet_start || {};
    return (enc.tokens || []).map(t => t.ship_marker_id).filter(id => id && !base[id] && globalShipMarkersCache.some(m => m.id === id));
}
async function writeBaseline(replaceAll) {
    const enc = window.globalBattleEncounterCache;
    if (!enc || currentUserRole !== 'dm' || !panelOn()) return;
    const ids = replaceAll ? (enc.tokens || []).map(t => t.ship_marker_id) : missingBaseline();
    if (!replaceAll && !ids.length) return;
    const next = replaceAll ? {} : Object.assign({}, enc.fleet_start || {});
    ids.forEach(id => {
        const v = globalShipMarkersCache.find(m => m.id === id);
        if (v) next[id] = { hp: window.fleetShipHp(v), side: window.vesselCombatSide(v), name: v.name, craft: !!v.is_strike_craft };
    });
    enc.fleet_start = next; // at once, so the next render does not queue the same write again
    const { error } = await db.from('battle_encounters').update({ fleet_start: next }).eq('id', enc.id);
    if (error) console.warn('Fleets panel: could not save the starting strength', error);
    render();
}
window.fleetsPanelRebase = function () {
    if (currentUserRole !== 'dm') return;
    if (!confirm('Set every fleet back to 100% from where the ships stand right now? Ships already lost or withdrawn drop off the count.')) return;
    return writeBaseline(true);
};
window.fleetsPanelWriteBaseline = () => writeBaseline(false); // tests

window.toggleFleetsPanel = function () {
    window.safeLocalSet(OPEN_KEY, window.safeLocalGet(OPEN_KEY, 'open') === 'closed' ? 'open' : 'closed');
    render();
};
window.fleetsPanelPickSide = function (side) {
    if (SIDE_TAB[side] && typeof window.switchBattleMapVesselTab === 'function') window.switchBattleMapVesselTab(SIDE_TAB[side]);
};

function hudOn() { return typeof window.tv2Active === 'function' && window.tv2Active() && !!document.getElementById('tv2-hud'); }
function sideRowHtml(s, clickable) {
    const bits = [`Ships ${s.ships}/${s.shipsStart}`];
    if (s.lost.length) bits.push(`lost ${s.lost.length}`);
    if (s.withdrawn) bits.push(`withdrawn ${s.withdrawn}`);
    if (s.wingsOut || s.wingsIn) bits.push(s.wingsIn === null ? `Wings ${s.wingsOut} out` : `Wings ${s.wingsOut} out / ${s.wingsIn} in hangars`);
    const lostTitle = s.lost.length ? `Lost: ${s.lost.join(', ')}` : (clickable ? 'Show this side in the vessel tabs' : '');
    const click = clickable ? ` role="button" tabindex="0" onclick="window.fleetsPanelPickSide('${s.side}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.fleetsPanelPickSide('${s.side}');}"` : '';
    return `<div class="fleets-side" data-side="${s.side}" title="${esc(lostTitle)}"${click}
            style="${clickable ? 'cursor:pointer; ' : ''}padding:5px 6px; background:rgba(6,9,7,0.6); border-left:2px solid ${s.color}; border-radius:2px; min-width:0;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:10px;">
            <span style="color:${s.color}; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><strong>${s.word}</strong>${s.label ? ` · ${esc(s.label)}` : ''}</span>
            <span class="fleets-pct" style="color:${s.color}; flex:none;">${s.pct}%${s.estimated ? ' <span style="color:#6b826a;">est.</span>' : ''}</span>
        </div>
        <div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s.pct}" aria-label="${s.word} fleet strength"
             style="height:6px; margin:4px 0; background:#030403; border:1px solid #3c4e36; border-radius:2px; overflow:hidden;">
            <div class="fleets-bar-fill" style="height:100%; width:${s.pct}%; background:${s.color};"></div>
        </div>
        <div style="font-size:9px; color:#6b826a; overflow-wrap:anywhere;">${esc(bits.join(' · '))}${s.estimated ? ' · visible ships only' : ''}</div>
    </div>`;
}

function render() {
    const tabs = document.getElementById('battle-map-vessel-tabs');
    let box = document.getElementById('fleets-panel');
    const data = panelOn() ? window.fleetsPanelData() : null;
    if (!tabs || !data || !data.sides.length) { if (box) box.style.display = 'none'; return; }
    if (!box) {
        box = document.createElement('div');
        box.id = 'fleets-panel';
        box.style.cssText = 'margin-bottom:8px; border:1px solid #3c4e36; border-radius:2px; padding:6px; background:#040605; min-width:0;';
    }
    const hud = hudOn();
    const anchor = hud ? document.getElementById('tv2-hud') : tabs;
    if (box.nextElementSibling !== anchor || box.parentNode !== anchor.parentNode) anchor.parentNode.insertBefore(box, anchor);
    const open = window.safeLocalGet(OPEN_KEY, 'open') !== 'closed';
    const isDm = currentUserRole === 'dm';
    const closedLine = data.sides.map(s => `<span style="color:${s.color};">${s.word} ${s.pct}%</span>`).join(' <span style="color:#3c4e36;">|</span> ');
    box.style.display = 'block';
    box.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:10px; color:#6b826a;">
            <span role="button" tabindex="0" aria-expanded="${open}" onclick="window.toggleFleetsPanel()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.toggleFleetsPanel();}"
                  style="cursor:pointer; letter-spacing:1px; min-width:0;">${open ? '▾' : '▸'} FLEETS${open ? '' : ` &nbsp; ${closedLine}`}</span>
            ${isDm && open ? `<span role="button" tabindex="0" title="Set every fleet back to 100% from where the ships stand now" onclick="window.fleetsPanelRebase()" onkeydown="if(event.key==='Enter'){window.fleetsPanelRebase();}" style="cursor:pointer; font-size:9px; flex:none;">↺ RE-BASE</span>` : ''}
        </div>
        ${open ? `<div style="display:flex; flex-direction:column; gap:5px; margin-top:6px;">${data.sides.map(s => sideRowHtml(s, !hud)).join('')}</div>` : ''}`;
    if (isDm && missingBaseline().length && !baseTimer) baseTimer = setTimeout(() => { baseTimer = null; writeBaseline(false); }, 400);
}
window.renderFleetsPanel = render;

if (typeof window.onBattleMapRender === 'function') window.onBattleMapRender('fleets-panel', render, 35);
document.addEventListener('darkforest:features-changed', () => { try { render(); } catch (e) { console.warn('Fleets panel render failed', e); } });
})();
