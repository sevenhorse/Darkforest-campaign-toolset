/* ==========================================================================
   js/battle-cards.js - Battle Map ship-status cards (classic look) and the comms dock toggle.
   Split out of js/battle-map.js (consolidation pass 2, 2026-10-08), code
   unchanged. Classic script sharing the global scope: loads right after
   battle-map.js (see index.html for the order).
   ========================================================================== */
/* --- SHIP-STATUS CARDS (full-screen build; collapse/expand added later
   this session per tester feedback) ---
   Confirmed permission rule: the DM sees full weapon+health detail on every
   token, no exceptions. A player sees full detail (stance, interactive
   weapons, editable health bars) on any PLAYER-owned vessel — their own
   AND allies' (every NPC in this app is owned by the DM's account, so
   "player-owned" == "owner's profile role !== 'dm'" cleanly separates the
   two, same heuristic this project already uses for combat_tracker
   PC-vs-NPC detection). A DM/NPC-owned vessel viewed by a player shows
   health only — all 5 defensive bars, read-only, no stance selector, no
   weapons at all. This is a DISPLAY-level rule only, same honor-system
   trust model as the rest of this app — nothing here changes RLS or adds
   real access control, it just controls what gets rendered into the DOM.

   Every card now starts COLLAPSED (name + HULL/SHIELDS % only) regardless
   of the permission tier above, and expands to that same tier's full detail
   on click — a display-density toggle layered on top of the existing
   permission split, not a replacement for it. See renderCompactHealthLine /
   battleMapExpandedCards / window.toggleBattleShipCardExpanded below. */
// Per-vessel card expand/collapse state, keyed by token_id. Pure
// client-side UI convenience -- not persisted, not synced between players,
// resets on page reload -- same "each browser keeps its own not-quite-
// permanent UI state" spirit as other collapsible bits of this app.
// Collapsed by default per tester feedback: showing full stance + all 5
// health bars + the complete weapons list for EVERY engaged vessel at once
// was "overwhelming" -- see darkforest-architecture-reference.md's Battle
// Map layout addendum for the full reasoning.
let battleMapExpandedCards = new Set();

/* Comms & Dice dock (live-session feature request, 2026-09-13: "dice roller
   chat integrated into the battle map"). Collapsed by default -- same
   "don't eat vertical space nobody asked to see yet" reasoning as the ship
   cards' own collapse-by-default above -- and, once opened, forces a fresh
   renderChatFeed() so the feed's scrollTop-pin recalculates against the
   dock's REAL now-visible height (its innerHTML was already kept in sync
   the whole time via renderChatFeed/renderCommsTabBar's mirrored-render
   approach in js/ui.js even while display:none, but scrollTop math against
   a hidden 0-height element wouldn't have pinned it to the bottom). See
   index.html for the dock markup and js/ui.js for the shared
   render/send functions this reuses (unmodified in spirit, just now
   rendering into two targets instead of one). */
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

// One-line HULL/SHIELDS % summary for a collapsed card -- deliberately just
// these two (not all 5 defensive layers renderShipHealthBarsHtml shows) as
// the "glance" version; the full breakdown is one click away via expand.
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

// Vessel roster tabs build (live-session feature request, 2026-09-13): see
// the HTML comment above #battle-map-vessel-tabs in index.html for why this
// exists and why strike craft need a separate, simpler card type. Tracks
// which of the 5 tabs is currently showing; persists only for the session
// (not saved anywhere), same lifetime as battleMapExpandedCards below.
window.battleMapVesselTab = window.battleMapVesselTab || 'friendly';

// Buckets a CAPITAL ship into Friendly/Neutral/Hostile. The DM's explicit
// iff tag (the dropdown built into this card's header, further down) always
// wins when set -- that control exists specifically so a boarded/captured/
// revealed vessel can be reclassified mid-fight, and this tab would silently
// fight that if it used its own separate rule. When iff is unset (the
// common case -- a player's own ship never needed one before this build),
// falls back to ownership: player-owned defaults to Friendly, anything else
// (DM/NPC, still unset) defaults to Neutral rather than assuming Hostile
// with no DM confirmation. Strike craft use a simpler ownership-only rule
// (see the sc_friendly/sc_hostile bucketing below) since squadron tokens
// don't carry an iff value at all.
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

// New lightweight card for the sc_friendly/sc_hostile tabs (live-session
// feature request, 2026-09-13). Strike craft were deliberately excluded
// from the capital-ship card below (see that function's own header comment)
// because their weapons/stats live entirely in the Hangar Bay panel on
// their carrier's card, not on a ship_weapons row -- this card is read-only
// status (name/owner/HP/move/withdraw) for exactly that reason, it doesn't
// try to grow a weapons section to match.
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
                <span style="font-size:9px; color:${moveColor};" title="Movement remaining this round (informational — not enforced)">Move ${moveRemaining}/${vessel.tactical_speed ?? 160}</span>
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
    // Phase 4c: the Vessel HUD replaces these cards (and must be the only
    // place the bm-wpn-* controls exist, or FIRE would read the wrong copy).
    if (typeof window.tv2Active === 'function' && window.tv2Active()) { container.innerHTML = ''; return; }
    const isDm = currentUserRole === 'dm';
    const profiles = (typeof allProfiles !== 'undefined' ? allProfiles : []);
    const activeTab = window.battleMapVesselTab || 'friendly';
    const isScTab = activeTab === 'sc_friendly' || activeTab === 'sc_hostile';

    tokens = (tokens || []).filter(tok => {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        // Fog of War build (this session): same visibility rule as the grid
        // token rendering above -- a hidden vessel gets no status card
        // either, except for the DM and its own player-owner.
        if (v && typeof window.isVesselVisibleToMe === 'function' && !window.isVesselVisibleToMe(v)) return false;
        return true;
    });

    // Vessel roster tabs build: bucket every visible token into all 5 tabs
    // up front (not just the active one) so the tab button counts are
    // always right, then only render the active bucket's cards below.
    const buckets = { friendly: [], neutral: [], hostile: [], sc_friendly: [], sc_hostile: [] };
    tokens.forEach(tok => {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!v) { buckets.neutral.push(tok); return; } // missing record -- surfaced under Neutral rather than silently dropped, see the "(vessel record missing...)" card below
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

    // Bug-hunt pass (2026-09-24): wrapped in preserveFormState (js/db.js) --
    // this re-renders on every realtime ship/battle update during combat,
    // which used to reset the weapon target dropdowns and volley counts a
    // player was in the middle of setting.
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
        // Station Designer build: stations are immobile, so the move-
        // remaining readout is dropped entirely rather than showing a
        // meaningless "Move 0/0" — matches the Battle Map grid's own
        // stationary-platform tooltip.
        const moveLine = vessel.is_station
            ? `<span style="font-size:9px; color:#6b826a;" title="Stationary platform — no Battle Map movement">🛰 STATIONARY</span>`
            : `<span style="font-size:9px; color:${moveColor};" title="Movement remaining this round (informational — not enforced)">Move ${moveRemaining}/${vessel.tactical_speed ?? 160}</span>`;

        // Mid-battle IFF change (live-session feature request, 2026-09-13): DM
        // asked to be able to flip a ship's Friendly/Hostile/Neutral tag mid-
        // fight (e.g. a boarded/captured vessel, a reveal). Reuses the exact
        // same dropdown markup/behavior as the Galaxy Map HUD's own DM-only
        // IFF box (js/map.js, selected-target 'ship' panel) for consistency —
        // same window.IFF_COLORS palette, same "-- Unset --" option, same
        // window.updateShipIff(shipId, newIff) call — just laid out compactly
        // for this card's header instead of the HUD's full-width panel.
        const iffVal = vessel.iff || null;
        const iffColor = iffVal ? ((window.IFF_COLORS && window.IFF_COLORS[iffVal]) || '#00e1ff') : '#6b826a';
        const dmIffBox = isDm ? `<select onchange="window.updateShipIff('${vessel.id}', this.value)" onclick="event.stopPropagation();" style="font-size:8px; padding:2px; background:#0a1410; color:${iffColor}; border:1px solid ${iffColor};" title="DM: change this vessel's IFF tag mid-battle"><option value="" ${!iffVal ? 'selected' : ''} style="color:#6b826a;">-- Unset --</option><option value="friendly" ${iffVal === 'friendly' ? 'selected' : ''} style="color:#00e5a3;">✓ Friendly</option><option value="neutral" ${iffVal === 'neutral' ? 'selected' : ''} style="color:#c9962f;">◌ Neutral</option><option value="hostile" ${iffVal === 'hostile' ? 'selected' : ''} style="color:#ff3333;">⚠ Hostile</option></select>` : '';

        // Firing arcs (Phase 3): heading readout + turn buttons on their own row (empty while the switch is off).
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
