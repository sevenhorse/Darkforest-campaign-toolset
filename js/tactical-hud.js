/* ==========================================================================
   js/tactical-hud.js - Tactical look: roster, Vessel HUD, objective, lines
   (Command Terminal refactor, Phase 4c, 2026-10-02)
   ==========================================================================
   DM-confirmed (2026-10-02, mockups approved, all defaults + objective box):
   - Docked FLEET ROSTER over the grid's top-left (phones: a row of chips).
   - VESSEL HUD replaces the right-hand ship cards while the switch is on
     (phones: a bottom sheet). FULL SHEET opens the complete vessel terminal.
   - OBJECTIVE box over the grid's top-right: battle_encounters.objective,
     shown to everyone, set/edited by the DM (also settable in a preset).
   - LOCK LINES from a ship to its chosen targets: seen by that ship's owner
     and the DM only. MISSILE PATHS with "IMPACT IN N": seen by everyone
     (who can see both ships).
   - NAME PLATE at the bottom of the grid for the selected ship.
   - Oxanium font for the Battle Map.
   - Tapping a ship selects it in the HUD (own ships no longer open the
     terminal straight away -- FULL SHEET does; hostiles still auto-target).
   Feature switch 'tactical_v2_ui' (DM ONLY to start). */

const TV = {
    selected: null,      // vessel id shown in the HUD
    locks: {},           // vesselId -> { weaponIdx: targetVesselId }
    sheetOpen: false,    // phone bottom sheet expanded
    editingObjective: false,
    rosterCollapsed: false
};
window.__tv2 = TV;
try { TV.rosterCollapsed = localStorage.getItem('darkforest_tv2_roster_collapsed') === '1'; } catch (e) {}

function tvOn() { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('tactical_v2_ui'); }
window.tv2Active = function() { return tvOn() && !!window.globalBattleEncounterCache; };
const tvEsc = (s) => window.escapeHtml ? window.escapeHtml(s == null ? '' : String(s)) : String(s == null ? '' : s);
function tvTokens() { return (window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || []; }
function tvVessel(id) { return globalShipMarkersCache.find(m => m.id === id) || null; }
function tvVisible(v) { return !v || typeof window.isVesselVisibleToMe !== 'function' || window.isVesselVisibleToMe(v); }
function tvProfiles() { return (typeof allProfiles !== 'undefined' && Array.isArray(allProfiles)) ? allProfiles : []; }
function tvOwnedByPlayer(v) { return window.vesselOwnerIds(v).map(id => tvProfiles().find(p => p.id === id)).filter(Boolean).some(p => p.role !== 'dm'); }
function tvCanControl(v) { return !!v && (currentUserRole === 'dm' || window.vesselHasOwner(v, currentUserId)); }
function tvSide(v) {
    if (!v) return 'neutral';
    if (typeof window.getVesselTabBucket === 'function') return window.getVesselTabBucket(v, tvOwnedByPlayer(v));
    return v.iff || 'neutral';
}
const TV_SIDE_COLOR = { friendly: '#00e1ff', neutral: '#ffaa00', hostile: '#ff4d4d' };
function tvCenter(tok) { return typeof window.battleTokenCenter === 'function' ? window.battleTokenCenter(tok) : { x: tok.x + 17, y: tok.y + 17 }; }
function tvPct(a, b) { return b > 0 ? Math.max(0, Math.min(100, a / b * 100)) : 0; }
function tvHullColor(p) { return p > 66 ? '#00e5a3' : p > 33 ? '#ffaa00' : '#ff4d4d'; }
function tvOwnerNames(v) {
    const names = window.vesselOwnerIds(v).map(id => tvProfiles().find(p => p.id === id)).filter(Boolean).map(p => p.role === 'dm' ? (v.ai_controlled ? 'AI' : 'DM') : (p.username || 'player'));
    return names.length ? names.join('/') : (v.ai_controlled ? 'AI' : '—');
}

/* --- Selection --- */
function defaultSelection() {
    const enc = window.globalBattleEncounterCache;
    const toks = tvTokens().filter(t => tvVisible(tvVessel(t.ship_marker_id)));
    if (enc && enc.initiative_rolled) {
        const cur = toks.find(t => t.token_id === (enc.turn_order || [])[enc.current_turn_index]);
        const cv = cur && tvVessel(cur.ship_marker_id);
        if (cv && (currentUserRole === 'dm' || window.vesselHasOwner(cv, currentUserId))) return cv.id;
    }
    const mine = toks.map(t => tvVessel(t.ship_marker_id)).find(v => v && !v.is_strike_craft && window.vesselHasOwner(v, currentUserId));
    if (mine) return mine.id;
    const first = toks.map(t => tvVessel(t.ship_marker_id)).find(v => v && !v.is_strike_craft);
    return first ? first.id : null;
}
window.tv2Select = function(vesselId, opts) {
    TV.selected = vesselId;
    renderTv2();
    if (opts && opts.scroll) {
        const tok = tvTokens().find(t => t.ship_marker_id === vesselId);
        const el = tok && document.querySelector(`#battle-map-grid .battle-token-el[data-token-id="${tok.token_id}"]`);
        const wrap = document.getElementById('battle-map-grid-wrap');
        if (el && wrap && typeof wrap.scrollTo === 'function') {
            const c = tvCenter(tok);
            const scale = typeof BATTLE_GRID_SCALE !== 'undefined' ? BATTLE_GRID_SCALE : 1.5;
            try { wrap.scrollTo({ left: c.x * scale - wrap.clientWidth / 2, top: c.y * scale - wrap.clientHeight / 2, behavior: 'smooth' }); } catch (e) {}
        }
    }
};
// Called from js/battle-map.js on a token tap. true = handled (don't open the terminal).
window.tv2HandleTokenTap = function(vesselId) {
    if (!window.tv2Active()) return false;
    const v = tvVessel(vesselId);
    window.tv2Select(vesselId);
    const hostileTarget = v && v.iff === 'hostile' && !window.vesselHasOwner(v, currentUserId);
    return !hostileTarget; // hostiles still fall through to "target with all my weapons"
};

/* --- Target locks (lock lines) --- */
function parseTargetSelectId(id) {
    const m = /^bm-wpn-target-(.+)-(\d+)$/.exec(id || '');
    return m ? { vesselId: m[1], idx: parseInt(m[2], 10) } : null;
}
window.tv2SetLock = function(vesselId, idx, targetId) {
    TV.locks[vesselId] = TV.locks[vesselId] || {};
    if (targetId) TV.locks[vesselId][idx] = targetId; else delete TV.locks[vesselId][idx];
    drawTv2Overlay();
};
document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'SELECT' || !t.id) return;
    const p = parseTargetSelectId(t.id);
    if (p) window.tv2SetLock(p.vesselId, p.idx, t.value);
}, true);
// "Tap a hostile = target with all my weapons" also records locks for ships whose dropdowns aren't on screen.
(function wrapAutoTarget() {
    const orig = window.autoTargetAllMyWeapons;
    if (typeof orig !== 'function' || orig.__tv2) return;
    const wrapped = function(targetId) {
        const r = orig.apply(this, arguments);
        if (window.tv2Active()) {
            tvTokens().forEach(t => {
                const v = tvVessel(t.ship_marker_id);
                if (!v || v.id === targetId || !window.vesselHasOwner(v, currentUserId)) return;
                (v.ship_weapons || []).forEach((w, idx) => {
                    if (!w || w.is_point_defense) return;
                    const list = window.getBattleScopedTargets ? window.getBattleScopedTargets(v.id, w.range, { firerVessel: v, wpn: w }) : null;
                    if (list && list.some(x => x.id === targetId)) window.tv2SetLock(v.id, idx, targetId);
                });
            });
        }
        return r;
    };
    wrapped.__tv2 = true;
    window.autoTargetAllMyWeapons = wrapped;
})();
function restoreLockSelects(vesselId) {
    const locks = TV.locks[vesselId] || {};
    Object.keys(locks).forEach(idx => {
        const sel = document.getElementById(`bm-wpn-target-${vesselId}-${idx}`);
        if (!sel) return;
        const ok = Array.from(sel.options).some(o => o.value === locks[idx] && !o.disabled);
        if (ok) sel.value = locks[idx];
    });
}

/* --- Rendering --- */
function ensureTv2Elements() {
    const stage = document.getElementById('battle-map-stage');
    if (stage) {
        if (!document.getElementById('tv2-roster')) { const d = document.createElement('div'); d.id = 'tv2-roster'; d.className = 'tv2-panel tv2-roster'; stage.appendChild(d); }
        if (!document.getElementById('tv2-objective')) { const d = document.createElement('div'); d.id = 'tv2-objective'; d.className = 'tv2-panel tv2-amber tv2-objective'; stage.appendChild(d); }
        if (!document.getElementById('tv2-plate')) { const d = document.createElement('div'); d.id = 'tv2-plate'; d.className = 'tv2-panel tv2-plate'; stage.appendChild(d); }
    }
    const right = document.querySelector('#battle-map-panel .battle-map-right-col');
    if (right && !document.getElementById('tv2-hud')) { const d = document.createElement('div'); d.id = 'tv2-hud'; d.className = 'tv2-panel tv2-hud'; right.insertBefore(d, right.firstChild); }
}
function rosterTokens() {
    const enc = window.globalBattleEncounterCache;
    const order = (enc && enc.initiative_rolled) ? (enc.turn_order || []) : [];
    const sideRank = { friendly: 0, neutral: 1, hostile: 2 };
    return tvTokens().map(t => ({ t, v: tvVessel(t.ship_marker_id) })).filter(x => x.v && tvVisible(x.v))
        .sort((a, b) => {
            if (!!a.v.is_strike_craft !== !!b.v.is_strike_craft) return a.v.is_strike_craft ? 1 : -1;
            const ia = order.indexOf(a.t.token_id), ib = order.indexOf(b.t.token_id);
            if (ia !== ib && (ia >= 0 || ib >= 0)) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
            return (sideRank[tvSide(a.v)] || 0) - (sideRank[tvSide(b.v)] || 0) || String(a.v.name).localeCompare(String(b.v.name));
        });
}
function renderRoster() {
    const box = document.getElementById('tv2-roster');
    if (!box) return;
    const enc = window.globalBattleEncounterCache;
    const order = (enc && enc.initiative_rolled) ? (enc.turn_order || []) : [];
    const curTok = enc && enc.initiative_rolled ? order[enc.current_turn_index] : null;
    const rows = rosterTokens().map(({ t, v }) => {
        const hp = tvPct(v.integrity_hull || 0, v.max_hull || 0);
        const col = TV_SIDE_COLOR[tvSide(v)] || '#00e1ff';
        let ap = '';
        const oi = order.indexOf(t.token_id);
        if (oi >= 0) {
            const max = window.getTokenApMax ? window.getTokenApMax(v) : 2;
            const curAp = t.ap_current !== undefined ? t.ap_current : max;
            ap = `<div class="tv2-ap">${Array.from({ length: Math.min(max, 6) }, (_, i) => `<b class="${i < curAp ? '' : 'off'}"></b>`).join('')}</div><div class="tv2-ix">${oi + 1} / ${order.length}</div>`;
        }
        const cls = ['tv2-row', t.token_id === curTok ? 'cur' : '', v.id === TV.selected ? 'sel' : '', v.is_strike_craft ? 'sc' : ''].join(' ');
        return `<div class="${cls}" onclick="window.tv2Select('${v.id}', { scroll: true })" title="${tvEsc(v.name)}">
            <div class="tv2-iff" style="background:${col}"></div>
            <div class="tv2-rname"><div class="tv2-nm">${v.is_strike_craft ? '🛩 ' : ''}${tvEsc(v.name)}</div><div class="tv2-cl">${tvEsc(String(v.vessel_class || (v.is_station ? 'station' : 'vessel')).replace(/_/g, ' '))} · ${tvEsc(tvOwnerNames(v))}</div></div>
            <div class="tv2-hb"><i style="width:${hp}%; background:${tvHullColor(hp)}"></i></div>
            <div>${ap}</div>
            <span class="tv2-chip-dot" style="background:${col}"></span><span class="tv2-chip-name">${tvEsc(v.name)}</span>
        </div>`;
    }).join('') || '<div class="tv2-empty">No ships on the grid.</div>';
    box.innerHTML = `<div class="tv2-ttl" onclick="window.tv2ToggleRoster()" style="cursor:pointer;"><span>${TV.rosterCollapsed ? '▸' : '▾'} Fleet roster</span><span class="tv2-dim">${enc && enc.initiative_rolled ? 'ROUND ' + (enc.round_number || 1) : 'NO INITIATIVE'}</span></div>
        <div class="tv2-rows" style="${TV.rosterCollapsed ? 'display:none;' : ''}">${rows}</div>`;
}
window.tv2ToggleRoster = function() {
    TV.rosterCollapsed = !TV.rosterCollapsed;
    try { localStorage.setItem('darkforest_tv2_roster_collapsed', TV.rosterCollapsed ? '1' : '0'); } catch (e) {}
    renderRoster();
};

function renderObjective() {
    const box = document.getElementById('tv2-objective');
    const enc = window.globalBattleEncounterCache;
    if (!box || !enc) return;
    const text = enc.objective || '';
    const isDm = currentUserRole === 'dm';
    if (!text && !isDm) { box.style.display = 'none'; return; }
    box.style.display = '';
    if (isDm && TV.editingObjective) {
        box.innerHTML = `<div class="tv2-ttl tv2-amber-ttl"><span>Objective</span></div>
            <div style="padding:6px 8px;"><label for="tv2-objective-input" style="display:none;">Objective</label>
            <textarea id="tv2-objective-input" rows="3" style="width:100%; font-size:11px; margin:0;">${tvEsc(text)}</textarea>
            <div style="display:flex; gap:4px; margin-top:4px;"><button class="layer-edit" onclick="window.tv2SaveObjective()" style="flex:1; font-size:9px; margin:0;">SAVE</button>
            <button class="layer-del" onclick="window.tv2SaveObjective('')" style="font-size:9px; margin:0;">CLEAR</button>
            <button onclick="window.__tv2.editingObjective=false; window.tv2Render()" style="font-size:9px; margin:0; width:auto;">CANCEL</button></div></div>`;
        return;
    }
    box.innerHTML = `<div class="tv2-ttl tv2-amber-ttl"><span>Objective</span>${isDm ? `<span class="tv2-edit" onclick="window.__tv2.editingObjective=true; window.tv2Render()" title="DM: edit the objective players see">✎</span>` : ''}</div>
        <div class="tv2-objtext" ${isDm && !text ? `onclick="window.__tv2.editingObjective=true; window.tv2Render()" style="cursor:pointer; color:#6b8590;"` : ''}>${text ? tvEsc(text).replace(/\n/g, '<br>') : '+ Set an objective for this battle (players will see it)'}</div>`;
}
window.tv2SaveObjective = async function(value) {
    const enc = window.globalBattleEncounterCache;
    if (!enc || currentUserRole !== 'dm') return;
    const el = document.getElementById('tv2-objective-input');
    const text = (value !== undefined ? value : (el ? el.value : '')).trim();
    const { error } = await db.from('battle_encounters').update({ objective: text || null }).eq('id', enc.id);
    if (error) { alert('Failed to save the objective: ' + error.message); return; }
    enc.objective = text || null;
    TV.editingObjective = false;
    if (text) await db.from('chat_logs').insert({ sender_id: null, content: `🎯 [TACTICAL BATTLE MAP] Objective: ${text}`, message_type: 'system' });
    renderTv2();
};

function renderPlate() {
    const box = document.getElementById('tv2-plate');
    const v = tvVessel(TV.selected);
    if (!box) return;
    if (!v) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.textContent = `${v.name} · ${String(v.vessel_class || (v.is_station ? 'station' : 'vessel')).replace(/_/g, ' ')}`;
}

function pipsHtml(cur, max, color) {
    if (!max) return '<span class="tv2-dim">—</span>';
    if (max > 12) return `<span style="color:${color}">${cur} / ${max}</span>`;
    return `<span class="tv2-pips">${Array.from({ length: max }, (_, i) => `<b class="${i < cur ? 'on' : ''}" style="border-color:${color};${i < cur ? 'background:' + color : ''}"></b>`).join('')}</span>`;
}
function armorDiagramHtml(v) {
    if (!(window.vesselUsesArmorSides && window.vesselUsesArmorSides(v))) {
        const cur = v.integrity_hardened || 0, max = v.max_hardened || 0;
        return `<div class="tv2-lab"><span>Hardened armor</span><span>${cur} / ${max}</span></div><div class="tv2-bar"><i style="width:${tvPct(cur, max)}%; background:#c9962f"></i></div>`;
    }
    const { cur, max } = window.getArmorSides(v);
    const col = (k) => cur[k] <= 0 ? '#ff4d4d' : (cur[k] / Math.max(1, max[k]) > 0.5 ? '#c9962f' : '#ffaa00');
    const op = (k) => max[k] > 0 ? (0.35 + 0.65 * cur[k] / max[k]).toFixed(2) : 0.3;
    return `<div class="tv2-lab"><span>Hardened armor by side</span><span>${window.sumArmorSides(cur)} / ${window.sumArmorSides(max)}</span></div>
        <div class="tv2-armor-compact">${['front', 'starboard', 'rear', 'port'].map(k => `<span style="color:${col(k)}">${k.slice(0, 1).toUpperCase()} ${cur[k]}/${max[k]}</span>`).join('')}</div>
        <div class="tv2-armor">
            <div class="tv2-side"><div class="tv2-sv" style="color:${col('port')}">${cur.port}</div>PORT<div class="tv2-dim">/ ${max.port}</div></div>
            <svg viewBox="0 0 120 140" width="110" height="128" aria-label="Armor by side">
                <path d="M60 14 L80 46 L80 112 L60 126 L40 112 L40 46 Z" fill="#0c1a1f" stroke="#2a4a54"/>
                <path d="M36 42 L60 8 L84 42" stroke="${col('front')}" stroke-width="5" fill="none" opacity="${op('front')}"/>
                <path d="M88 48 L88 110" stroke="${col('starboard')}" stroke-width="5" opacity="${op('starboard')}"/>
                <path d="M32 48 L32 110" stroke="${col('port')}" stroke-width="5" opacity="${op('port')}"/>
                <path d="M84 116 L60 132 L36 116" stroke="${col('rear')}" stroke-width="5" fill="none" opacity="${op('rear')}"/>
                <text x="60" y="64" fill="${col('front')}" font-size="10" text-anchor="middle">F ${cur.front}/${max.front}</text>
                <text x="60" y="100" fill="${col('rear')}" font-size="10" text-anchor="middle">R ${cur.rear}/${max.rear}</text>
            </svg>
            <div class="tv2-side"><div class="tv2-sv" style="color:${col('starboard')}">${cur.starboard}</div>STARBOARD<div class="tv2-dim">/ ${max.starboard}</div></div>
        </div>`;
}
function renderHud() {
    const box = document.getElementById('tv2-hud');
    if (!box) return;
    const enc = window.globalBattleEncounterCache;
    const v = tvVessel(TV.selected);
    const tok = v && tvTokens().find(t => t.ship_marker_id === v.id);
    if (!v || !tok) { box.innerHTML = '<div class="tv2-empty" style="padding:14px;">Tap a ship on the grid or in the roster.</div>'; return; }
    const control = tvCanControl(v);
    const side = tvSide(v);
    const order = (enc && enc.initiative_rolled) ? (enc.turn_order || []) : [];
    const isTurn = !!(enc && enc.initiative_rolled && order[enc.current_turn_index] === tok.token_id);
    const apMax = window.getTokenApMax ? window.getTokenApMax(v) : 2;
    const ap = tok.ap_current !== undefined ? tok.ap_current : apMax;
    const moveRem = tok.move_remaining !== undefined ? tok.move_remaining : (v.tactical_speed ?? 160);
    const arcs = window.firingArcsOn && window.firingArcsOn() && !v.is_strike_craft;
    const canTurn = arcs && window.canTurnBattleToken && window.canTurnBattleToken(tok).ok;
    const sMax = v.max_shields || 0, sCur = v.integrity_shields || 0, hMax = v.max_hull || 0, hCur = v.integrity_hull || 0;
    const pic = window.isMediaRef && window.isMediaRef(v.image_url) ? window.mediaThumbHtml(v.image_url, { size: 80, width: 110, caption: v.name }) : `<div class="tv2-por">${v.is_strike_craft ? '🛩' : 'NO PICTURE'}</div>`;
    const tags = [`<span class="tv2-tag" style="border-color:${TV_SIDE_COLOR[side]}; color:${TV_SIDE_COLOR[side]}">${side.toUpperCase()}</span>`];
    if (isTurn) tags.push(`<span class="tv2-tag" style="border-color:#ffd700; color:#ffd700">${control ? 'YOUR TURN' : 'TURN'} · ${ap} AP</span>`);
    if (v.is_hidden && currentUserRole === 'dm') tags.push('<span class="tv2-tag" style="border-color:#c778dd; color:#c778dd">HIDDEN</span>');
    if (v.ai_controlled) tags.push('<span class="tv2-tag" style="border-color:#ff6b6b; color:#ff6b6b">AI</span>');
    const weapons = control && !v.is_strike_craft && typeof window.renderShipWeaponsHtml === 'function'
        ? `<div class="tv2-sec tv2-weapons"><div class="tv2-lab"><span>Weapons</span><span>tap a hostile on the grid to target all</span></div>${window.renderShipWeaponsHtml(v, { idPrefix: 'bm-', showManageButtons: false })}</div>` : '';
    const hangar = control && typeof window.renderCompactHangarHtml === 'function' ? window.renderCompactHangarHtml(v) : '';
    const isDm = currentUserRole === 'dm';
    const iffSel = isDm ? `<select onchange="window.updateShipIff('${v.id}', this.value)" title="DM: friend / foe" style="font-size:9px; width:auto; margin:0;"><option value="" ${!v.iff ? 'selected' : ''}>IFF —</option><option value="friendly" ${v.iff === 'friendly' ? 'selected' : ''}>Friendly</option><option value="neutral" ${v.iff === 'neutral' ? 'selected' : ''}>Neutral</option><option value="hostile" ${v.iff === 'hostile' ? 'selected' : ''}>Hostile</option></select>` : '';
    const dmRow = isDm ? `<div class="tv2-dmrow">${iffSel}<button class="layer-edit" onclick="window.toggleVesselHidden('${v.id}')" style="font-size:9px; margin:0; padding:2px 6px; border-color:#c778dd; color:#c778dd;">${v.is_hidden ? '👁 UNHIDE' : '🫥 HIDE'}</button></div>` : '';
    box.innerHTML = `
        <div class="tv2-hero">${pic}<div style="min-width:0;">
            <div class="tv2-big">${tvEsc(v.name)}</div>
            <div class="tv2-sub">${tvEsc(String(v.vessel_class || (v.is_station ? 'station' : 'vessel')).replace(/_/g, ' '))} · ${tvEsc(tvOwnerNames(v))}</div>
            <div>${tags.join('')}</div>
            <div class="tv2-nav">${arcs ? `🧭 ${String(((tok.facing || 0) % 360 + 360) % 360).padStart(3, '0')}° · ` : ''}${v.is_station ? 'STATIONARY' : `MOVE ${moveRem} / ${v.tactical_speed ?? 160}`}</div>
        </div></div>
        <div class="tv2-sec">
            <div class="tv2-lab"><span>Shields</span><span>${sCur} / ${sMax}</span></div><div class="tv2-bar"><i style="width:${tvPct(sCur, sMax)}%; background:#00e1ff"></i></div>
            <div class="tv2-lab"><span>Hull</span><span>${hCur} / ${hMax}</span></div><div class="tv2-bar"><i style="width:${tvPct(hCur, hMax)}%; background:${tvHullColor(tvPct(hCur, hMax))}"></i></div>
            <div style="display:flex; gap:16px;"><div><div class="tv2-lab"><span>Reactive</span></div>${pipsHtml(v.integrity_reactive || 0, v.max_reactive || 0, '#ffaa00')}</div>
            <div><div class="tv2-lab"><span>Ablative</span></div>${pipsHtml(v.integrity_ablative || 0, v.max_ablative || 0, '#ffaa00')}</div></div>
        </div>
        ${v.is_strike_craft ? '' : `<div class="tv2-sec">${armorDiagramHtml(v)}</div>`}
        ${weapons}
        ${hangar ? `<div class="tv2-sec">${hangar}</div>` : ''}
        ${dmRow}
        <div class="tv2-acts">
            ${canTurn ? `<button class="tv2-btn" onclick="window.rotateBattleToken('${tok.token_id}', -15)" title="Turn 15° to port">⟲</button><button class="tv2-btn" onclick="window.rotateBattleToken('${tok.token_id}', 15)" title="Turn 15° to starboard">⟳</button>` : ''}
            ${isTurn && control ? `<button class="tv2-btn tv2-amberbtn" onclick="window.endCurrentTurn()">⏭ END TURN</button>` : ''}
            ${control ? `<button class="tv2-btn tv2-sheetbtn" onclick="window.__tv2.sheetOpen=!window.__tv2.sheetOpen; window.tv2Render()">${TV.sheetOpen ? 'LESS ▾' : 'WEAPONS ▸'}</button>` : ''}
            ${control ? `<button class="tv2-btn tv2-dimbtn" onclick="window.openFullVesselTerminal && window.openFullVesselTerminal('${v.id}')">FULL SHEET</button>` : ''}
            ${control ? `<button class="tv2-btn tv2-dimbtn" onclick="window.removeBattleToken('${tok.token_id}')" title="Take this ship off the grid">WITHDRAW</button>` : ''}
        </div>`;
    box.classList.toggle('tv2-open', TV.sheetOpen);
    restoreLockSelects(v.id);
}

/* --- Lock lines + missile paths (SVG over the grid, under the tools overlay) --- */
function tvOverlay() {
    const grid = document.getElementById('battle-map-grid');
    if (!grid) return null;
    let svg = document.getElementById('tv2-overlay');
    if (!svg || svg.parentNode !== grid) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'tv2-overlay';
        svg.setAttribute('class', 'tv2-overlay');
        svg.setAttribute('width', String(BATTLE_GRID_W));
        svg.setAttribute('height', String(BATTLE_GRID_H));
        svg.setAttribute('viewBox', `0 0 ${BATTLE_GRID_W} ${BATTLE_GRID_H}`);
        grid.appendChild(svg);
    }
    return svg;
}
function drawTv2Overlay() {
    const svg = tvOverlay();
    if (!svg) return;
    if (!window.tv2Active()) { svg.innerHTML = ''; svg.style.display = 'none'; return; }
    const toks = tvTokens();
    const byVessel = {};
    toks.forEach(t => { byVessel[t.ship_marker_id] = t; });
    let html = '';
    // Lock lines (owner + DM only)
    Object.keys(TV.locks).forEach(vid => {
        const v = tvVessel(vid), ft = byVessel[vid];
        if (!v || !ft || !(currentUserRole === 'dm' || window.vesselHasOwner(v, currentUserId))) return;
        const byTarget = {};
        Object.keys(TV.locks[vid]).forEach(idx => {
            const tid = TV.locks[vid][idx];
            const w = (v.ship_weapons || [])[idx];
            if (!tid || !w || !byVessel[tid] || !tvVisible(tvVessel(tid))) return;
            (byTarget[tid] = byTarget[tid] || []).push(w.name);
        });
        Object.keys(byTarget).forEach(tid => {
            const a = tvCenter(ft), b = tvCenter(byVessel[tid]);
            const names = byTarget[tid];
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            html += `<line class="tv2-lock" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"></line>
                <text class="tv2-lock-label" x="${mx}" y="${my - 5}" text-anchor="middle">LOCK · ${tvEsc(names[0]).toUpperCase()}${names.length > 1 ? ' +' + (names.length - 1) : ''}</text>`;
        });
    });
    // Missile paths (everyone who can see both ends)
    const groups = {};
    (window.globalBattleEncounterCache.in_flight_ordnance || []).forEach(e => {
        const st = byVessel[e.source_vessel_id], tt = byVessel[e.target_vessel_id];
        if (!st || !tt || !tvVisible(tvVessel(e.source_vessel_id)) || !tvVisible(tvVessel(e.target_vessel_id))) return;
        const key = e.parent_salvo_id || e.salvo_id;
        (groups[key] = groups[key] || []).push({ e, st, tt });
    });
    Object.keys(groups).forEach(k => {
        const { e, st, tt } = groups[k][0];
        const s = tvCenter(st), t = tvCenter(tt);
        const turns = e.turns_remaining !== undefined ? e.turns_remaining : 3;
        const prog = Math.max(0, Math.min(1, (3 - turns) / 3));
        const px = s.x + (t.x - s.x) * prog, py = s.y + (t.y - s.y) * prog;
        const n = groups[k].length;
        html += `<line class="tv2-missile" x1="${px}" y1="${py}" x2="${t.x}" y2="${t.y}"></line>
            <text class="tv2-missile-label" x="${px + 8}" y="${py - 6}">☠ ${tvEsc(e.source_weapon_name || 'Ordnance').toUpperCase()}${n > 1 ? ' ×' + n : ''} · IMPACT IN ${turns}</text>`;
    });
    svg.innerHTML = html;
    svg.style.display = html ? 'block' : 'none';
}
window.drawTv2Overlay = drawTv2Overlay;

function renderTv2() {
    const panel = document.getElementById('battle-map-panel');
    const active = window.tv2Active();
    if (panel) panel.classList.toggle('tv2', active);
    if (!active) {
        ['tv2-roster', 'tv2-objective', 'tv2-plate', 'tv2-hud'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
        drawTv2Overlay();
        return;
    }
    ensureTv2Elements();
    ['tv2-roster', 'tv2-hud'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
    const onGrid = TV.selected && tvTokens().some(t => t.ship_marker_id === TV.selected && tvVisible(tvVessel(t.ship_marker_id)));
    if (!onGrid) TV.selected = defaultSelection();
    renderRoster(); renderObjective(); renderPlate();
    const hud = document.getElementById('tv2-hud');
    if (hud && typeof window.preserveFormState === 'function') window.preserveFormState(hud, renderHud, 'select[id^="bm-wpn-target-"], input[id^="bm-wpn-volley-"]');
    else renderHud();
    document.querySelectorAll('#battle-map-grid .battle-token-el').forEach(el => {
        const t = tvTokens().find(x => x.token_id === el.dataset.tokenId);
        el.classList.toggle('tv2-focus', !!(t && t.ship_marker_id === TV.selected));
    });
    drawTv2Overlay();
}
window.tv2Render = renderTv2;

window.onBattleMapRender('tactical-hud', renderTv2, 30);
// (switch changes: battle-map.js already re-renders the Battle Map on darkforest:features-changed)
