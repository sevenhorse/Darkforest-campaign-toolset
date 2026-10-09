/* ==========================================================================
   js/battle-cards.js - Battle Map ship-status cards (classic look) and the comms dock toggle.
   Classic script sharing the global scope: loads right after battle-map.js
   (see index.html for the order).
   ========================================================================== */
/* --- SHIP-STATUS CARDS ---
   Permission rule (DM decision): the DM sees full detail on every token. A
   player sees full detail (stance, interactive weapons, editable health
   bars) on any player-owned vessel, their own and allies' ("player-owned" =
   an owner whose profile role !== 'dm'; NPCs are owned by the DM). An NPC
   vessel viewed by a player shows the 5 health bars only, read-only.
   This is display-only: it does not change RLS or add access control.
   Every card starts collapsed (name + HULL/SHIELDS %) and expands on click
   to its permission tier's full detail. */
// Expanded cards, keyed by token_id. Per-browser UI state only: not saved,
// not synced, resets on reload.
let battleMapExpandedCards = new Set();

/* Comms & Dice dock on the Battle Map (markup in index.html; chat
   render/send shared with js/ui.js). Collapsed by default. Opening it calls
   renderChatFeed() again: the feed is kept in sync while hidden, but its
   scroll-to-bottom can't work on a 0-height element. */
window.toggleBattleMapCommsDock = function() {
    const body = document.getElementById('bm-comms-dock-body');
    const caret = document.getElementById('bm-comms-dock-caret');
    if (!body) return;
    const opening = body.style.display !== 'block';
    body.style.display = opening ? 'block' : 'none';
    if (caret) caret.textContent = opening ? '▾' : '▸';
    if (opening && typeof window.renderChatFeed === 'function') window.renderChatFeed();
};

window.toggleBattleShipCardExpanded = function(tokenId) {
    if (battleMapExpandedCards.has(tokenId)) battleMapExpandedCards.delete(tokenId);
    else battleMapExpandedCards.add(tokenId);
    window.renderBattleShipCards((window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || []);
};

// One-line HULL/SHIELDS % summary for a collapsed card (the full 5 bars
// show when expanded).
function renderCompactHealthLine(vessel) {
    const h_max = vessel.max_hull || 300;
    const h_int = vessel.integrity_hull !== undefined ? vessel.integrity_hull : h_max;
    const s_max = vessel.max_shields || 400;
    const s_int = vessel.integrity_shields !== undefined ? vessel.integrity_shields : s_max;
    const hullPct = h_max > 0 ? Math.max(0, Math.min(100, Math.round((h_int / h_max) * 100))) : 100;
    const shieldPct = s_max > 0 ? Math.max(0, Math.min(100, Math.round((s_int / s_max) * 100))) : 100;
    const colorFor = (pct) => pct > 66 ? '#00e5a3' : (pct > 33 ? '#ffaa00' : '#ff3333');
    return `<div style="display:flex; gap:14px; font-size:9px; margin-top:2px;">
        <span style="color:${colorFor(hullPct)};">HULL ${hullPct}%</span>
        <span style="color:${colorFor(shieldPct)};">SHIELDS ${shieldPct}%</span>
    </div>`;
}

// Active vessel roster tab (one of 5; see the comment above
// #battle-map-vessel-tabs in index.html). Not saved; resets on reload.
window.battleMapVesselTab = window.battleMapVesselTab || 'friendly';

// Buckets a capital ship into Friendly/Neutral/Hostile. The DM's iff tag
// always wins when set (so a captured or revealed vessel can be reclassified
// mid-fight). Unset: player-owned -> Friendly, otherwise Neutral (never
// Hostile without the DM saying so). Strike craft have no iff and are
// bucketed by ownership only (see renderBattleShipCards).
window.getVesselTabBucket = function(vessel, ownedByPlayer) {
    if (vessel.iff === 'friendly' || vessel.iff === 'neutral' || vessel.iff === 'hostile') return vessel.iff;
    return ownedByPlayer ? 'friendly' : 'neutral';
};

window.switchBattleMapVesselTab = function(tab) {
    window.battleMapVesselTab = tab;
    ['friendly', 'neutral', 'hostile', 'sc_friendly', 'sc_hostile'].forEach(t => {
        const btn = document.getElementById('bm-vessel-tab-btn-' + t);
        if (btn) btn.classList.toggle('active', t === tab);
    });
    window.renderBattleShipCards((window.globalBattleEncounterCache && window.globalBattleEncounterCache.tokens) || []);
};

// Read-only status card (name/owner/HP/move/withdraw) for the strike-craft
// tabs. Strike craft have no ship_weapons; they fire from the Hangar Bay
// panel on their carrier's card.
function renderStrikeCraftCard(tok, isDm, profiles) {
    const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
    if (!vessel) {
        return `<div class="battle-ship-card" style="border-color:#ff3333;"><span style="font-size:10px; color:#ff3333;">(vessel record missing — token may need to be withdrawn)</span></div>`;
    }
    const ownerProfs = window.vesselOwnerIds(vessel).map(id => profiles.find(p => p.id === id)).filter(Boolean);
    const ownedByPlayer = ownerProfs.some(p => p.role !== 'dm');
    const accentColor = ownedByPlayer ? '#00e5a3' : '#ff3333';
    const canWithdraw = isDm || window.vesselHasOwner(vessel, currentUserId);
    const moveRemaining = tok.move_remaining !== undefined ? tok.move_remaining : (vessel.tactical_speed ?? 160);
    const moveColor = moveRemaining < 0 ? '#ff3333' : '#6b826a';
    const ownerTag = ownerProfs.length ? ownerProfs.map(p => p.username || 'Commander').join('/') : (isDm ? 'Unowned' : 'Unknown');
    return `<div class="battle-ship-card" style="border-color:${accentColor};">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid #3c4e36;">
            <div style="display:flex; align-items:center; gap:6px;">
                <strong style="color:${accentColor}; font-size:13px;">🛩️ ${vessel.name}</strong>
                <span style="font-size:9px; color:#6b826a;">${ownerTag}</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                ${vessel.is_hidden ? `<span style="font-size:9px; color:#c778dd;" title="Hidden from every non-DM viewer except this vessel's own player-owner">🫥 HIDDEN</span>` : ''}
                <span style="font-size:9px; color:${moveColor};" title="Movement left this round (refills each round)">Move ${moveRemaining}/${vessel.tactical_speed ?? 160}</span>
                ${canWithdraw ? `<button class="layer-del" onclick="window.removeBattleToken('${tok.token_id}')" style="font-size:8px; padding:2px 6px;">WITHDRAW</button>` : ''}
            </div>
        </div>
        ${renderCompactHealthLine(vessel)}
        <div style="font-size:8px; color:#6b826a; margin-top:4px;">Fire from the Hangar Bay panel on the carrier's card, not from here.</div>
    </div>`;
}

window.renderBattleShipCards = function(tokens) {
    const container = document.getElementById('battle-map-ship-cards');
    if (!container) return;
    // When active, the Vessel HUD replaces these cards (and must be the only
    // place the bm-wpn-* controls exist, or FIRE would read the wrong copy).
    if (typeof window.tv2Active === 'function' && window.tv2Active()) { container.innerHTML = ''; return; }
    const isDm = currentUserRole === 'dm';
    const profiles = (typeof allProfiles !== 'undefined' ? allProfiles : []);
    const activeTab = window.battleMapVesselTab || 'friendly';
    const isScTab = activeTab === 'sc_friendly' || activeTab === 'sc_hostile';

    tokens = (tokens || []).filter(tok => {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        // Fog of War: same visibility rule as the grid tokens. A hidden vessel
        // gets no card except for the DM and its own player-owner.
        if (v && typeof window.isVesselVisibleToMe === 'function' && !window.isVesselVisibleToMe(v)) return false;
        return true;
    });

    // Bucket every visible token into all 5 tabs so the tab counts are
    // right, then render only the active bucket.
    const buckets = { friendly: [], neutral: [], hostile: [], sc_friendly: [], sc_hostile: [] };
    tokens.forEach(tok => {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!v) { buckets.neutral.push(tok); return; } // missing record: shown under Neutral as a "(vessel record missing...)" card
        if (v.is_strike_craft) {
            const ownedByPlayer = window.vesselOwnerIds(v).map(id => profiles.find(p => p.id === id)).filter(Boolean).some(p => p.role !== 'dm');
            buckets[ownedByPlayer ? 'sc_friendly' : 'sc_hostile'].push(tok);
        } else {
            const ownerProfs = window.vesselOwnerIds(v).map(id => profiles.find(p => p.id === id)).filter(Boolean);
            buckets[window.getVesselTabBucket(v, ownerProfs.some(p => p.role !== 'dm'))].push(tok);
        }
    });

    const tabLabels = { friendly: 'Friendly', neutral: 'Neutral', hostile: 'Hostile', sc_friendly: '🛩️ Friendly', sc_hostile: '🛩️ Hostile' };
    Object.keys(tabLabels).forEach(t => {
        const btn = document.getElementById('bm-vessel-tab-btn-' + t);
        if (btn) btn.textContent = `${tabLabels[t]} (${buckets[t].length})`;
    });

    const activeTokens = buckets[activeTab] || [];

    if (activeTokens.length === 0) {
        container.innerHTML = '<span style="font-size:10px; color:#6b826a;">No vessels here.</span>';
        return;
    }

    if (isScTab) {
        container.innerHTML = activeTokens.map(tok => renderStrikeCraftCard(tok, isDm, profiles)).join('');
        return;
    }

    // preserveFormState (js/db.js) keeps weapon target dropdowns and volley
    // counts a player is setting across the realtime re-renders.
    window.preserveFormState(container, () => { container.innerHTML = activeTokens.map(tok => {
        const vessel = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!vessel) {
            return `<div class="battle-ship-card" style="border-color:#ff3333;"><span style="font-size:10px; color:#ff3333;">(vessel record missing — token may need to be withdrawn)</span></div>`;
        }

        const ownerProfs = window.vesselOwnerIds(vessel).map(id => profiles.find(p => p.id === id)).filter(Boolean);
        const ownedByPlayer = ownerProfs.some(p => p.role !== 'dm');
        const fullDetail = isDm || ownedByPlayer;
        const canWithdraw = isDm || window.vesselHasOwner(vessel, currentUserId);
        const moveRemaining = tok.move_remaining !== undefined ? tok.move_remaining : (vessel.tactical_speed ?? 160);
        const moveColor = moveRemaining < 0 ? '#ff3333' : '#6b826a';
        const accentColor = fullDetail ? '#00e5a3' : '#ff3333';
        const ownerTag = ownerProfs.length ? ownerProfs.map(p => p.username || 'Commander').join('/') : (isDm ? 'Unowned' : 'Unknown');
        const expanded = battleMapExpandedCards.has(tok.token_id);
        // Stations never move, so show STATIONARY instead of a move readout.
        const moveLine = vessel.is_station
            ? `<span style="font-size:9px; color:#6b826a;" title="Stationary platform — no Battle Map movement">🛰 STATIONARY</span>`
            : `<span style="font-size:9px; color:${moveColor};" title="Movement left this round (refills each round)">Move ${moveRemaining}/${vessel.tactical_speed ?? 160}</span>`;

        // DM-only IFF dropdown for changing a ship's tag mid-battle. Mirrors
        // the Galaxy Map HUD's IFF box (js/map.js): same IFF_COLORS, options
        // and window.updateShipIff call, laid out compactly.
        const iffVal = vessel.iff || null;
        const iffColor = iffVal ? ((window.IFF_COLORS && window.IFF_COLORS[iffVal]) || '#00e1ff') : '#6b826a';
        const dmIffBox = isDm ? `<select onchange="window.updateShipIff('${vessel.id}', this.value)" onclick="event.stopPropagation();" style="font-size:8px; padding:2px; background:#0a1410; color:${iffColor}; border:1px solid ${iffColor};" title="DM: change this vessel's IFF tag mid-battle"><option value="" ${!iffVal ? 'selected' : ''} style="color:#6b826a;">-- Unset --</option><option value="friendly" ${iffVal === 'friendly' ? 'selected' : ''} style="color:#00e5a3;">✓ Friendly</option><option value="neutral" ${iffVal === 'neutral' ? 'selected' : ''} style="color:#c9962f;">◌ Neutral</option><option value="hostile" ${iffVal === 'hostile' ? 'selected' : ''} style="color:#ff3333;">⚠ Hostile</option></select>` : '';

        // Firing arcs: heading readout + turn buttons on their own row (empty while the feature is off).
        const headingCtl = typeof window.renderHeadingControlsHtml === 'function' ? window.renderHeadingControlsHtml(tok, vessel) : '';
        const headingRow = headingCtl ? `<div style="display:flex; justify-content:flex-end; margin:-2px 0 6px 0;">${headingCtl}</div>` : '';
        const header = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid #3c4e36;">
                <div style="display:flex; align-items:center; gap:6px; cursor:pointer;" onclick="window.toggleBattleShipCardExpanded('${tok.token_id}')" title="${expanded ? 'Click to collapse' : 'Click to expand full detail'}">
                    <span style="font-size:9px; color:#6b826a;">${expanded ? '▾' : '▸'}</span>
                    <strong style="color:${accentColor}; font-size:13px;">${vessel.name}</strong>
                    <span style="font-size:9px; color:#6b826a;">${ownerTag}${vessel.is_strike_craft ? ' · 🛩️' : ''}</span>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${vessel.is_hidden ? `<span style="font-size:9px; color:#c778dd;" title="Hidden from every non-DM viewer except this vessel's own player-owner">🫥 HIDDEN</span>` : ''}
                    ${moveLine}
                    ${dmIffBox}
                    ${isDm ? `<button class="layer-edit" onclick="window.toggleVesselHidden('${vessel.id}')" style="font-size:8px; padding:2px 6px; border-color:#c778dd; color:#c778dd;" title="Fog of War: toggle whether this vessel is hidden from every non-DM viewer except its own player-owner">${vessel.is_hidden ? '👁 UNHIDE' : '🫥 HIDE'}</button>` : ''}
                    ${canWithdraw ? `<button class="layer-del" onclick="window.removeBattleToken('${tok.token_id}')" style="font-size:8px; padding:2px 6px;">WITHDRAW</button>` : ''}
                </div>
            </div>${headingRow}`;

        if (!expanded) {
            return `<div class="battle-ship-card" style="border-color:${accentColor};">${header}${renderCompactHealthLine(vessel)}</div>`;
        }

        if (!fullDetail) {
            return `<div class="battle-ship-card" style="border-color:${accentColor};">${header}${window.renderShipHealthBarsHtml(vessel, false)}</div>`;
        }

        return `<div class="battle-ship-card" style="border-color:${accentColor};">
            ${header}
            ${window.renderShipStanceHtml(vessel)}
            ${window.renderShipHealthBarsHtml(vessel, true)}
            <div style="margin-top:8px; padding-top:8px; border-top:1px dashed #3c4e36;">
                ${window.renderShipWeaponsHtml(vessel, { idPrefix: 'bm-', showManageButtons: false })}
            </div>
            ${typeof window.renderCompactHangarHtml === 'function' ? window.renderCompactHangarHtml(vessel) : ''}
        </div>`;
    }).join(''); }, 'select[id^="bm-wpn-target-"], input[id^="bm-wpn-volley-"]');
};
