/* ==========================================================================
   js/manufacturing.js - Manufacturing Blueprints & Orders
   ==========================================================================
   New this session. Gives the Quartermaster/Master Engineer perks'
   previously-unfulfilled "reduce time and resource cost to manufacture by
   25%" flavor text a real backing mechanic (both perks were pure flavor
   text with zero mechanical effect before this build -- see
   darkforest-architecture-reference.md for the full confirmed design and
   the perk-data verification that surfaced this before any code was
   written).

   Shape: a catalog (manufacturing_blueprints) of buildable items, each
   costing a resource list + a time cost. A player starts a build order
   from EITHER:
     - one of their own VESSELS (must have a Manufacturing-type deck --
       a real, confirmed hard requirement, unlike Fleet Group Production /
       Salvage Processing which treat a missing deck as "full rate, not a
       block"). Resources are deducted from that vessel's cargo
       expendables immediately.
     - one of their own COLONIES (no deck concept exists for colonies at
       all -- confirmed exempt from both the deck requirement AND the
       resource-cost check; a colony order costs time only). Output is
       delivered to a DM/owner-picked vessel's cargo, reusing the exact
       vessel-picker the pre-existing "DELIVER TO EXPENDABLES" colony
       button already uses.
   Both paths apply the crafting character's own Quartermaster/Master
   Engineer discount (25%, non-stacking -- takes the MAX across held
   perks, not a sum, per Master Engineer's own "does not stack" text) to
   both the resource cost (vessel orders only) and the time cost (both).

   Vessel orders also apply a damage-based time penalty from the
   Manufacturing deck itself: a damaged deck (below 100% HP) slows the
   build down, floored at 10% efficiency (worst case, a 10x time
   penalty) rather than letting duration approach infinity as HP nears
   zero. This is separate from the discount above and stacks with it
   (discount shrinks the base time, deck damage then divides the result).
   Colony orders have no deck at all and are exempt, per the existing
   colony design.
   The discount is read via a new perk_definitions.manufacturing_discount_pct
   dedicated field (matching the existing shield_max_bonus/dr_bonus
   convention) rather than hardcoding the two perk names in this file.

   MULTI-TIER CRAFTING (added later this session, per the DM's own lore --
   "the Intrepid Horizon's Manufacturing deck is capable of producing
   another Jupiter-class vessel if need be, given enough time and
   resources"): a recipe's resource_cost can now reference ANY other
   blueprint's cargo output, not just a base-tier raw feedstock. A
   blueprint's "tier" is derived at display time, never stored: Tier 1 =
   no resource cost (raw feedstock); Tier N = 1 + the deepest tier among
   its own inputs. The DM's own "5 layers" guideline is a SOFT warning
   only (shown in the editor, not enforced) -- consistent with every other
   Manufacturing action already being DM-trusted rather than code-blocked.
   Actually spawning a whole new vessel as an output (the literal
   end-of-chain lore example) is explicitly OUT of scope for this pass --
   confirmed with the DM as a separate, bigger future feature; today's
   ceiling for an output is still a cargo item or an Arsenal weapon, same
   as before. See darkforest-architecture-reference.md for the full
   confirmed design.

   CARGO CATEGORY (added in the pre-deploy bug-hunt follow-up): a
   cargo_item output's payload now carries an optional cargo_bucket
   ('expendables' | 'perishables' | 'misc'), defaulting to 'expendables'
   when absent so every pre-existing blueprint keeps behaving exactly as
   before. This exists because the daily rations/starvation check in
   js/ui.js only ever reads cargo.perishables -- before this, a
   manufactured food/water blueprint could never reach the bucket that
   check looks at. Both the delivery step (processManufacturingOrders)
   and the resource-cost consumption step (startVesselManufacturingOrder)
   now look across all three buckets by name, not just expendables --
   necessary so a Tier 2+ recipe can still consume an input that some
   other blueprint delivers into perishables or misc, not just
   expendables.

   Orders live in manufacturing_orders as a discrete in-progress row with
   its own started_at_hours/duration_hours timer -- same shape as
   battlefield_salvage's gather timer, for the same reason (a one-shot
   lifecycle, not a recurring rate). A blueprint's output/name/cost are
   snapshotted onto the order at start time (NOT a live reference), same
   precedent as launchOrdnance's in-flight-ordnance snapshot, so an edited
   or deleted blueprint can't corrupt an order already in flight.
   Completion is fully automatic on time-advance (js/ui.js
   processTimeAdvancement calls window.processManufacturingOrders on
   EVERY tick, not just daily ones, mirroring processSalvageGatherCompletion
   exactly -- a build's duration can be sub-day).
   ========================================================================== */

let manufacturingBlueprintsList = [];
window.globalManufacturingOrdersCache = [];

/* Manufacturing Tabs + Search (added 2026-09-14, per the DM's own request
   -- "add tabs to the manufacturing screen where different blueprints are
   grouped into various tabs as well as adding in a search function").
   Groups the Blueprint Catalog by each blueprint's existing output_type
   field rather than a new category/tag field (confirmed design -- no such
   field exists, and output_type is the only thing that meaningfully
   buckets a blueprint today: Cargo Items / Arsenal Weapons / Colony
   Infrastructure, plus an "All" tab). Search matches name OR description,
   case-insensitively. Both are local UI-only state -- not persisted, not
   synced across clients -- same scope as e.g. js/colonies.js's own
   colonies/fleets subtab selection. Reuses the existing .cargo-subtabs /
   .cargo-subtab-btn CSS pattern (style.css) already shared by the cargo
   bucket tabs, vessel deck tabs, and colonies/fleets tabs, for visual
   consistency. */
let activeManufacturingTab = 'all';
let manufacturingSearchQuery = '';

window.switchManufacturingTab = function(tab) {
    activeManufacturingTab = tab;
    window.renderManufacturingPanel();
};

window.filterManufacturingSearch = function(value) {
    manufacturingSearchQuery = (value || '').trim().toLowerCase();
    window.renderManufacturingPanel();
};

async function loadManufacturingBlueprints() {
    const { data } = await db.from('manufacturing_blueprints').select('*').order('created_at', { ascending: true });
    if (data) {
        manufacturingBlueprintsList = data;
        if (typeof window.renderManufacturingPanel === 'function') window.renderManufacturingPanel();
        if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
        if (typeof window.renderColoniesPanel === 'function') window.renderColoniesPanel();
    }
}

async function loadManufacturingOrders() {
    const { data } = await db.from('manufacturing_orders').select('*').eq('status', 'in_progress').order('created_at', { ascending: true });
    if (data) {
        window.globalManufacturingOrdersCache = data;
        if (typeof window.renderManufacturingPanel === 'function') window.renderManufacturingPanel();
        if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
        if (typeof window.renderColoniesPanel === 'function') window.renderColoniesPanel();
    }
}

function initManufacturingBlueprintsRealtimeChannel() {
    db.channel('manufacturing_blueprints_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'manufacturing_blueprints' }, () => {
            loadManufacturingBlueprints();
        })
        .subscribe();
}

function initManufacturingOrdersRealtimeChannel() {
    db.channel('manufacturing_orders_stream')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'manufacturing_orders' }, () => {
            loadManufacturingOrders();
        })
        .subscribe();
}

window.loadManufacturingBlueprints = loadManufacturingBlueprints;
window.loadManufacturingOrders = loadManufacturingOrders;
window.initManufacturingBlueprintsRealtimeChannel = initManufacturingBlueprintsRealtimeChannel;
window.initManufacturingOrdersRealtimeChannel = initManufacturingOrdersRealtimeChannel;

/* ==========================================================================
   APPROVAL WORKFLOW (added on request -- "copy the approval system from
   the perk designer... it will save me some work overhead"): copied
   structurally from js/perk-designer.js's own draft/approved flow on
   perk_definitions, applied here to manufacturing_blueprints via a new
   status column (migration manufacturing_blueprints_add_approval_status,
   default 'approved' so all 47 pre-existing seeded blueprints stayed
   immediately buildable -- nothing got swept into a pending bucket by
   adding the column).

   Anyone can now propose a new blueprint (same fields a DM would fill in
   -- resource cost, time, output -- no field-level restriction, matching
   perks exactly); a DM-authored blueprint still goes straight to
   'approved' with zero extra clicks (same as a DM-authored perk). A
   'draft' blueprint is NOT buildable and NOT selectable as another
   blueprint's resource-cost input until a DM approves it -- the DM's
   actual "work overhead" savings is that they now only have to review
   and click ✓ APPROVE instead of hand-entering every blueprint
   themselves.

   Two divergences from copying perks 1:1, both deliberate:
   1. canManageBlueprint(bp) below double-checks permission INSIDE
      openEditBlueprintModal/deleteManufacturingBlueprint (perks' own
      openEditPerkModal has no such internal check at all, trusting the
      edit button's own visibility as the only gate) -- a small, free
      hardening, not a functional difference for any legitimate caller.
   2. The Manufacturing tab's sidebar badge already meant something before
      this change (count of in-progress BUILD ORDERS, added last session)
      -- rather than overwriting that with a "pending PROPOSALS" count
      the way perk's own badge works, it now shows "N pending" only when
      a proposal is actually awaiting review, falling back to the
      in-progress-orders count otherwise. Keeps both signals instead of
      losing one to match perks exactly.
   ========================================================================== */

function canManageBlueprint(bp) {
    // DM always. A non-DM can additionally manage (edit/delete) ONLY their
    // own still-pending ('draft') proposal -- exactly canManagePerk's own
    // rule. Once approved, a blueprint reverts to DM-only, same as a perk.
    if (currentUserRole === 'dm') return true;
    return !!(bp && bp.status === 'draft' && bp.created_by === currentUserId);
}

// Non-stacking: takes the MAX manufacturing_discount_pct across every perk
// the character holds, not a sum -- matches Master Engineer's own "Does
// not stack with Quartermster" text. A character could theoretically hold
// both (different sections -- Quartermaster is Section 1 self-pick,
// Master Engineer is Section 2 DM-awarded, and Section 1 is uncapped this
// project) without ending up with a 50% discount.
window.getManufacturingDiscountPct = function(charPerksList) {
    let maxPct = 0;
    (charPerksList || []).forEach(cp => {
        const def = (typeof window.findPerkDefinition === 'function') ? window.findPerkDefinition(cp.perk_definition_id) : null;
        if (def && (def.manufacturing_discount_pct || 0) > maxPct) maxPct = def.manufacturing_discount_pct;
    });
    return maxPct;
};

/* ==========================================================================
   MULTI-TIER CRAFTING: a blueprint's "tier" is derived, not stored. Tier 1
   is a raw feedstock (empty resource_cost, time-only). Tier N (N>1) is
   1 + the deepest tier among its own resource-cost inputs, each resolved
   by matching the stored cost-row name against another blueprint's cargo
   output name (case-insensitive) -- the exact same name-matching
   convention startVesselManufacturingOrder already uses against a
   vessel's cargo. An unresolvable input name (no blueprint currently
   produces it -- e.g. legacy data, or a feedstock later deleted) is
   treated as Tier 1: a "raw" input with no known recipe of its own,
   rather than an error.

   A genuine circular dependency (A costs B costs ... costs A) is guarded
   with a visiting-set DFS and reported as Infinity ("circular") rather
   than recursing forever. The blueprint editor's own dropdown already
   excludes a blueprint from referencing itself directly, so this mainly
   protects against a multi-hop cycle introduced by editing an EARLIER
   blueprint in an existing chain.

   Per the DM's own confirmed choice, the "shouldn't exceed 5 layers"
   guideline is a SOFT warning shown in the editor, not a hard save-block
   -- matches every other Manufacturing action already being DM-trusted,
   not code-enforced.
   ========================================================================== */

function findBlueprintByOutputName(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    // Only resolves against an APPROVED blueprint's output -- a still-draft
    // proposal isn't "real" yet, so it can't participate in a tier chain as
    // if it were. An unresolvable name (including one that only matches a
    // pending draft) falls through to computeBlueprintTier's existing
    // "unresolved input -- treat as Tier 1, raw feedstock" handling, same
    // as a renamed/deleted blueprint already does.
    return (manufacturingBlueprintsList || []).find(b => b.output_type === 'cargo_item' && b.status !== 'draft' && ((b.output_payload && b.output_payload.name) || '').toLowerCase() === lower);
}

function computeBlueprintTier(bp, visiting) {
    visiting = visiting || new Set();
    if (!bp) return 1; // unresolved input name -- treat as a raw, recipe-less resource
    if (visiting.has(bp.id)) return Infinity; // circular dependency
    const costs = bp.resource_cost || [];
    if (costs.length === 0) return 1;
    visiting.add(bp.id);
    let maxInputTier = 0;
    costs.forEach(c => {
        const t = computeBlueprintTier(findBlueprintByOutputName(c.name), visiting);
        if (t > maxInputTier) maxInputTier = t;
    });
    visiting.delete(bp.id);
    return maxInputTier === Infinity ? Infinity : maxInputTier + 1;
}

// Used by the editor to preview the tier of a not-yet-saved cost list
// (workingCosts) -- same logic as computeBlueprintTier but starting from a
// plain array instead of an already-saved blueprint, since a new/in-edit
// blueprint has no id/row of its own yet to run the visiting-set guard on.
function computeTierFromCostRows(costRows) {
    if (!costRows || costRows.length === 0) return 1;
    let maxInputTier = 0;
    for (const c of costRows) {
        const t = computeBlueprintTier(findBlueprintByOutputName(c.name));
        if (t === Infinity) return Infinity;
        if (t > maxInputTier) maxInputTier = t;
    }
    return maxInputTier + 1;
}

const MANUFACTURING_TIER_CAP = 5; // soft guideline only, see header comment above -- never enforced

function formatBlueprintTier(tier) {
    if (tier === Infinity) return '⚠ circular';
    return `Tier ${tier}`;
}

/* ==========================================================================
   SCREEN: blueprint catalog (now propose-and-approve, see the APPROVAL
   WORKFLOW header comment above) + a live "in-progress builds" list,
   everyone can see both (same visibility split as Battlefield Salvage's
   own panel -- the catalog/order data itself isn't secret; editing an
   APPROVED blueprint is DM-only, but anyone can propose a new one, and a
   proposer can edit/delete their own still-pending draft).

   Originally a floating draggable panel; moved to its own Command Terminal
   tab (term-panel-manufacturing) alongside Ship Designer/Perk Designer --
   this screen is a catalog/dashboard only (per the DM's own confirmed
   choice), NOT where a build is started. The actual "start a build"
   controls stay put on their existing source-specific screens (the
   Manufacturing Bay box on a vessel's own Vessel Deck tab, and the box on
   a colony's own card in Colonies & Fleets) since those need that
   vessel's/colony's own context (cargo, deck, delivery-vessel picker) that
   this dashboard doesn't have. renderManufacturingPanel below is unchanged
   by the move -- it only ever targeted element IDs, not the floating
   panel's own container, so re-parenting those same IDs into the new tab's
   markup required no logic changes here at all. loadManufacturingBlueprints/
   loadManufacturingOrders already run unconditionally at app startup (see
   js/db.js's init wiring), so there's no more "load lazily when the panel
   opens" step to replace -- switchTermTab('manufacturing') just shows
   already-loaded data, same as every other tab.
   ========================================================================== */

function describeBlueprintOutput(bp) {
    const p = bp.output_payload || {};
    if (bp.output_type === 'arsenal_weapon') {
        return `🔫 ${p.name || 'Unnamed Weapon'} (${p.dice || '1d6'}${p.modifier || '+0'}${p.damage_type ? ', ' + p.damage_type : ''}) → crafting character's Arsenal`;
    }
    if (bp.output_type === 'colony_infrastructure') {
        return `🏗️ Reaches Infrastructure Level ${p.infrastructure_level || 1} → the building colony itself (colony builds only)`;
    }
    const bucket = (p.cargo_bucket && p.cargo_bucket !== 'expendables') ? ` (${p.cargo_bucket})` : '';
    return `📦 ${p.qty || 0}x ${p.name || 'Unnamed Item'} (${p.unit || 'Units'}) → target vessel's cargo${bucket}`;
}

function describeBlueprintCost(bp) {
    const costs = bp.resource_cost || [];
    if (costs.length === 0) return 'No listed resource cost (time only).';
    return costs.map(c => `${c.qty}x ${c.name} (${c.unit || 'Units'})`).join(', ');
}

window.renderManufacturingPanel = function() {
    const bpContainer = document.getElementById('manufacturing-blueprints-container');
    const ordContainer = document.getElementById('manufacturing-orders-container');
    const tabsContainer = document.getElementById('manufacturing-tabs-container');
    // The "+ PROPOSE BLUEPRINT" button is always visible now -- anyone can
    // propose, same as "+ PROPOSE PERK" has no visibility gate.

    // Tab bar -- counts always come from the FULL catalog (drafts
    // included), never the search-filtered view, so a tab's own count
    // means the same thing regardless of what's currently typed in the
    // search box.
    const MANUFACTURING_TABS = [
        { key: 'all', label: 'All' },
        { key: 'cargo_item', label: '📦 Cargo Items' },
        { key: 'arsenal_weapon', label: '⚔ Arsenal Weapons' },
        { key: 'colony_infrastructure', label: '🏗 Infrastructure' }
    ];
    if (tabsContainer) {
        tabsContainer.innerHTML = MANUFACTURING_TABS.map(t => {
            const count = t.key === 'all' ? manufacturingBlueprintsList.length : manufacturingBlueprintsList.filter(bp => bp.output_type === t.key).length;
            return `<button class="cargo-subtab-btn${activeManufacturingTab === t.key ? ' active' : ''}" onclick="window.switchManufacturingTab('${t.key}')">${t.label} (${count})</button>`;
        }).join('');
    }

    // Badge below (further down this function) always reflects the TRUE
    // total pending count across the whole catalog, never the tab/search-
    // filtered view -- a DM shouldn't lose track of a proposal awaiting
    // review just because a different tab happens to be active.
    let pendingCount = manufacturingBlueprintsList.filter(bp => bp.status === 'draft').length;
    if (bpContainer) {
        const byTab = activeManufacturingTab === 'all'
            ? manufacturingBlueprintsList
            : manufacturingBlueprintsList.filter(bp => bp.output_type === activeManufacturingTab);
        const q = manufacturingSearchQuery;
        const visible = q
            ? byTab.filter(bp => (bp.name || '').toLowerCase().includes(q) || (bp.description || '').toLowerCase().includes(q))
            : byTab;

        // Pending Review / Approved Blueprints split -- direct mirror of
        // js/perk-designer.js's own renderPerkDesignerPanel. Now split from
        // the tab/search-filtered `visible` list rather than the full
        // catalog, so a tab or search query narrows both sections at once.
        const pending = visible.filter(bp => bp.status === 'draft');
        const approved = visible.filter(bp => bp.status !== 'draft');

        const renderCard = (bp) => {
            const editable = canManageBlueprint(bp);
            const tier = computeBlueprintTier(bp);
            const tierWarn = (tier !== Infinity && tier > MANUFACTURING_TIER_CAP) ? ' <span style="color:#ff9b6b;">(exceeds 5-layer guideline)</span>' : '';
            const tierColor = tier === Infinity ? '#ff6b6b' : '#6b826a';
            // Infrastructure (2026-09-14): a colony must already be at
            // Infrastructure Level >= this blueprint's own derived tier to
            // build it there (1:1, confirmed design) -- EXCEPT a
            // colony_infrastructure blueprint itself, which is exempt (it's
            // how a colony reaches that level in the first place). Shown
            // here so the requirement is visible without opening the colony
            // card and trying a build.
            const infraNote = (bp.output_type !== 'colony_infrastructure' && tier !== Infinity && tier > 1)
                ? ` <span style="color:#6b826a;">(needs Colony Infrastructure Lvl ${tier} to build at a colony)</span>` : '';
            const proposer = (bp.status === 'draft' && typeof allProfiles !== 'undefined') ? allProfiles.find(a => a.id === bp.created_by) : null;
            return `
            <div class="note-card" style="border-left: 3px solid ${bp.status === 'draft' ? '#ffaa00' : '#3c4e36'};">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:${bp.status === 'draft' ? '#ffaa00' : '#c9962f'}; font-size:12px;">${bp.name}</strong>
                        <span style="font-size:8px; color:${tierColor}; margin-left:6px;">${formatBlueprintTier(tier)}${tierWarn}${infraNote}</span>
                        ${bp.status === 'draft' ? '<span style="font-size:8px; color:#ffaa00;"> · PENDING REVIEW</span>' : ''}
                        <p style="margin:2px 0 0 0; font-size:10px; color:#d4c5a9;">${bp.description || ''}</p>
                        <p style="margin:4px 0 0 0; font-size:9px; color:#6b826a;">Cost: ${describeBlueprintCost(bp)} &nbsp;·&nbsp; Time: ${bp.time_cost_hours}h</p>
                        <p style="margin:2px 0 0 0; font-size:9px; color:#6b826a;">${describeBlueprintOutput(bp)}</p>
                        ${proposer ? `<span class="author-tag">proposed by: ${proposer.username || 'Commander'}</span>` : ''}
                    </div>
                    <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; max-width:110px;">
                        ${(currentUserRole === 'dm' && bp.status === 'draft') ? `<button class="btn-deploy" onclick="window.approveBlueprint('${bp.id}')" style="width:auto; margin:0; padding:3px 6px; font-size:9px;">✓ APPROVE</button>` : ''}
                        ${editable ? `<button class="layer-edit" onclick="window.openEditBlueprintModal('${bp.id}')" style="padding:3px 7px; font-size:9px;">✎</button>` : ''}
                        ${editable ? `<button class="layer-del" onclick="window.deleteManufacturingBlueprint('${bp.id}')" style="padding:3px 7px; font-size:9px;">✕</button>` : ''}
                    </div>
                </div>
            </div>`;
        };

        let html = '';
        if (manufacturingBlueprintsList.length === 0) {
            html = '<span style="font-size:10px; color:#6b826a;">No blueprints exist yet.</span>';
        } else if (visible.length === 0) {
            const qSafe = q.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            html = `<span style="font-size:10px; color:#6b826a;">No blueprints match${q ? ` "${qSafe}"` : ' this tab'}.</span>`;
        } else {
            if (pending.length > 0) {
                html += `<h5 style="color:#ffaa00; font-size:10px; border-bottom:1px solid #ffaa00; padding-bottom:4px; margin-top:0;">Pending Review (${pending.length})</h5>`;
                pending.forEach(bp => html += renderCard(bp));
            }
            html += `<h5 style="color:#6b826a; font-size:10px; margin:${pending.length > 0 ? '10px' : '0'} 0 4px 0;">Approved Blueprints (${approved.length})</h5>`;
            if (approved.length === 0) html += '<span style="font-size:10px; color:#6b826a;">No approved blueprints in this view.</span>';
            approved.forEach(bp => html += renderCard(bp));
        }
        bpContainer.innerHTML = html;
    }

    if (ordContainer) {
        let html = '';
        const orders = window.globalManufacturingOrdersCache || [];
        if (orders.length === 0) html = '<span style="font-size:10px; color:#6b826a;">No builds currently in progress.</span>';
        orders.forEach(o => {
            const readyAt = (o.started_at_hours || 0) + (o.duration_hours || 0);
            const remaining = Math.max(0, readyAt - (window.universeTimeHours || 0));
            const vessel = (typeof globalShipMarkersCache !== 'undefined') ? globalShipMarkersCache.find(m => m.id === o.vessel_id) : null;
            // Cancel permission mirrors window.cancelManufacturingOrder's own
            // check exactly -- DM, or the owner of whichever vessel/colony
            // actually initiated the build (not the delivery vessel for a
            // colony order).
            let canCancel = currentUserRole === 'dm';
            let sourceLabel;
            if (o.source_type === 'colony') {
                const colony = (typeof coloniesList !== 'undefined') ? coloniesList.find(c => c.id === o.source_colony_id) : null;
                if (colony && colony.owner_id === currentUserId) canCancel = true;
                sourceLabel = `🏛 ${colony ? colony.name : 'Colony'}${vessel ? ` → ${vessel.name}` : ''}`;
            } else {
                if (vessel && window.vesselHasOwner(vessel, currentUserId)) canCancel = true; // Bug-hunt pass (2026-09-24): ships moved to multi-owner `owner_ids` long ago; this still read the legacy single `owner_id` column (stale on 2 of 8 ships, blank on the rest), so non-DM owners were silently refused.
                sourceLabel = `🚀 ${vessel ? vessel.name : 'Vessel'}`;
            }
            html += `
            <div class="note-card">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#c9962f; font-size:11px;">${o.blueprint_name || 'Unknown Blueprint'}</strong>
                        <p style="margin:2px 0 0 0; font-size:9px; color:#6b826a;">${sourceLabel}${o.discount_pct ? ` &nbsp;·&nbsp; ${o.discount_pct}% discount applied` : ''}</p>
                        <p style="margin:2px 0 0 0; font-size:9px; color:#d4c5a9;">Ready in ~${remaining.toFixed(1)}h</p>
                    </div>
                    ${canCancel ? `<button class="layer-del" onclick="window.cancelManufacturingOrder('${o.id}')" style="flex:0 0 auto; padding:3px 7px; font-size:9px;" title="Cancel this build and refund any deducted resources">✕ CANCEL</button>` : ''}
                </div>
            </div>`;
        });
        ordContainer.innerHTML = html;
    }

    // Badge prioritizes "N pending" (a blueprint proposal awaiting DM
    // review -- same priority perk-designer's own badge gives its pending
    // count), falling back to the in-progress-build-order count otherwise
    // (that count is what this badge showed before the approval workflow
    // was added, and is still worth surfacing when nothing needs review).
    const badge = document.getElementById('badge-manufacturing');
    if (badge) badge.innerText = pendingCount > 0 ? `${pendingCount} pending` : (window.globalManufacturingOrdersCache || []).length;
};

/* Rendered by js/colonies.js's renderColoniesPanel, inside each editable
   colony's card -- reuses that same card's colony-deliver-vessel-<id>
   select as the Manufacturing order's delivery target for the FINISHED
   product (a build still always ships out to a vessel, that part hasn't
   changed), same reasoning as before: the crafted output isn't "stored
   items" in the new colony-storage sense, it's a one-shot delivery like a
   vessel build's output always was.

   Colony Manufacturing Facility (2026-09-14): a colony with
   has_manufacturing_facility now CAN draw real materials out of its own
   cargo_inventory (see the header comment on window.startColonyManufacturingOrder
   below) instead of every colony build being unconditionally time-only.
   Whether this particular build actually used materials or fell back to
   time-only is reported in the chat log after BUILD is clicked -- no live
   pre-build cost/sufficiency preview here (deferred; a judgment call to
   keep this pass's scope to the storage + gating mechanic itself). */
window.renderColonyManufacturingBox = function(colony) {
    // Approved-only -- a still-pending proposal isn't buildable yet.
    const blueprints = (manufacturingBlueprintsList || []).filter(b => b.status !== 'draft');
    const inProgress = (window.globalManufacturingOrdersCache || []).filter(o => o.source_type === 'colony' && o.source_colony_id === colony.id);
    let progressHtml = '';
    inProgress.forEach(o => {
        const remaining = Math.max(0, (o.started_at_hours || 0) + (o.duration_hours || 0) - (window.universeTimeHours || 0));
        // This box only renders for an editable (DM/owner) colony already
        // (see js/colonies.js's renderColoniesPanel), so anyone seeing it
        // can also cancel from here -- window.cancelManufacturingOrder now
        // refunds a colony order's snapshot back into colony storage when
        // one exists, same as a vessel order refunds into vessel cargo.
        progressHtml += `<div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;"><p style="margin:0; font-size:8px; color:#6b826a;">⏳ Building "${o.blueprint_name}" — ready in ~${remaining.toFixed(1)}h</p><button class="layer-del" onclick="window.cancelManufacturingOrder('${o.id}')" style="flex:0 0 auto; padding:1px 5px; font-size:8px; margin-left:6px;" title="Cancel this build">✕</button></div>`;
    });
    const facilityNote = colony.has_manufacturing_facility
        ? '🏭 Manufacturing Facility installed — draws materials from colony storage when available, falls back to time-only otherwise:'
        : '🏭 Manufacturing (time cost only — no Facility installed, see colony edit to add one):';
    // Build Popup (Tabs/Search/Build-Popup pass, 2026-09-14): same
    // replacement as the vessel Manufacturing Bay box (js/combat.js) -- the
    // old inline <select> + BUILD button is now a single button opening a
    // modal with full details and a live afford-check per blueprint. See
    // openColonyBuildModal / computeManufacturingPreview below.
    return `
    <div style="background:#030403; padding:8px; border:1px solid #c9962f; border-radius:2px; margin-top:6px;">
        <label style="font-size: 9px; color: #c9962f;">${facilityNote}</label>
        <div style="margin-top:4px;">
            ${blueprints.length
                ? `<button class="btn-deploy" onclick="window.openColonyBuildModal('${colony.id}')" style="width:100%; font-size:9px; padding:5px 8px; margin:0;">🔍 SELECT BLUEPRINT TO BUILD</button>`
                : `<p style="margin:0; font-size:9px; color:#6b826a;">No approved blueprints yet.</p>`}
        </div>
        <p style="font-size:8px; color:#6b826a; margin:4px 0 0 0;">Finished build (except Infrastructure) delivers to whichever vessel is selected in the Storage pickup dropdown above.</p>
        ${progressHtml}
    </div>`;
};

window.deleteManufacturingBlueprint = async function(id) {
    const bp = manufacturingBlueprintsList.find(b => b.id === id);
    if (bp && !canManageBlueprint(bp)) return;
    if (!(await window.showConfirmModal(`Delete blueprint "${bp ? bp.name : ''}"? Any order currently in progress from it is unaffected (it already has its own snapshot).`))) return;
    await db.from('manufacturing_blueprints').delete().eq('id', id);
    loadManufacturingBlueprints();
};

// Direct mirror of window.approvePerk.
window.approveBlueprint = async function(id) {
    if (currentUserRole !== 'dm') return;
    const bp = manufacturingBlueprintsList.find(b => b.id === id);
    if (!bp) return;
    const { error } = await db.from('manufacturing_blueprints').update({ status: 'approved' }).eq('id', id);
    if (error) { alert('Failed to approve blueprint: ' + error.message); return; }
    await db.from('chat_logs').insert({ sender_id: null, message_type: 'system', content: `📋 [OVERSEER] Blueprint "${bp.name}" approved and added to the active manufacturing catalog.` });
    loadManufacturingBlueprints();
};

/* --- CREATE / EDIT BLUEPRINT MODAL (self-contained IIFE, with a
   repeatable resource-cost sub-editor -- same shape as the Perk Designer's
   effects sub-editor) --- */
(function() {
    let overlay, currentId, workingCosts;

    function renderCostList() {
        const listEl = document.getElementById('bp-cost-list');
        if (!listEl) return;
        let html = '';
        if (workingCosts.length === 0) html = '<span style="font-size:9px; color:#6b826a;">No resource cost added -- time-only build.</span>';
        workingCosts.forEach((c, idx) => {
            const inputTier = computeBlueprintTier(findBlueprintByOutputName(c.name));
            html += `<div style="display:flex; justify-content:space-between; align-items:center; background:#030403; padding:4px 6px; border:1px solid #3c4e36; border-radius:2px; margin-bottom:3px;">
                <span style="font-size:10px; color:#d4c5a9;">${c.qty}x ${c.name} (${c.unit}) <span style="font-size:8px; color:${inputTier === Infinity ? '#ff6b6b' : '#6b826a'};">[${formatBlueprintTier(inputTier)}]</span></span>
                <button class="layer-del" onclick="window.removeBpCostRow(${idx})" style="padding:1px 5px; font-size:8px;">✕</button>
            </div>`;
        });
        listEl.innerHTML = html;
        updateTierWarning();
    }

    function updateTierWarning() {
        const el = document.getElementById('bp-tier-warning');
        if (!el) return;
        const tier = computeTierFromCostRows(workingCosts);
        if (tier === Infinity) {
            el.innerHTML = '⚠ <span style="color:#ff6b6b;">This recipe circularly depends on itself through one of its inputs — fix before saving.</span>';
        } else if (tier > MANUFACTURING_TIER_CAP) {
            el.innerHTML = `⚠ <span style="color:#ff9b6b;">This blueprint would be Tier ${tier} — exceeds the ${MANUFACTURING_TIER_CAP}-layer guideline. Soft limit only, saving is still allowed.</span>`;
        } else {
            el.innerHTML = `<span style="color:#6b826a;">This blueprint would be Tier ${tier}.</span>`;
        }
    }

    window.removeBpCostRow = function(idx) { workingCosts.splice(idx, 1); renderCostList(); };

    // Cost-input dropdown: sourced live from manufacturingBlueprintsList
    // rather than a fixed enum, so adding a new feedstock (or a new
    // intermediate manufactured good) is just "create a new blueprint" --
    // no separate registry table, no code change, ever needed. Unlike the
    // prior single-session version of this dropdown, this now lists EVERY
    // cargo-item-producing blueprint, not just Tier-1 raw feedstocks -- a
    // recipe can cost another manufactured good, enabling multi-tier
    // chains (per the DM's own confirmed design). The blueprint currently
    // being edited is excluded from its own dropdown to block the one
    // cycle this UI can prevent outright (direct self-reference); deeper
    // multi-hop cycles are instead caught by computeBlueprintTier's
    // visiting-set guard and surfaced as a warning, not blocked. Existing
    // stored resource_cost rows are plain {name,qty,unit} data and keep
    // displaying/working even if the blueprint they reference is later
    // renamed or deleted -- only ADDING a new cost row requires picking
    // from this list.
    function getKnownManufacturableBlueprints(excludeId) {
        // Approved-only -- a pending proposal isn't real yet, so it can't be
        // picked as another (possibly also-pending) blueprint's resource
        // input. Matches findBlueprintByOutputName's own approved-only rule.
        return (manufacturingBlueprintsList || []).filter(b => b.output_type === 'cargo_item' && b.id !== excludeId && b.status !== 'draft');
    }

    function populateCostInputDropdown() {
        const sel = document.getElementById('bp-cost-name');
        if (!sel) return;
        const candidates = getKnownManufacturableBlueprints(currentId);
        if (candidates.length === 0) {
            sel.innerHTML = '<option value="">No manufacturable inputs defined yet</option>';
            window.syncBpCostUnitFromFeedstock();
            return;
        }
        const withTiers = candidates.map(b => ({ b, tier: computeBlueprintTier(b) }));
        withTiers.sort((a, b2) => (a.tier === b2.tier) ? a.b.name.localeCompare(b2.b.name) : (a.tier - b2.tier));
        let html = '';
        let lastTier = null;
        withTiers.forEach(({ b, tier }) => {
            if (tier !== lastTier) {
                if (lastTier !== null) html += '</optgroup>';
                html += `<optgroup label="${formatBlueprintTier(tier)}">`;
                lastTier = tier;
            }
            const p = b.output_payload || {};
            const itemName = p.name || b.name;
            const unit = p.unit || 'Units';
            html += `<option value="${itemName.replace(/"/g, '&quot;')}" data-unit="${unit.replace(/"/g, '&quot;')}">${b.name}</option>`;
        });
        html += '</optgroup>';
        sel.innerHTML = html;
        window.syncBpCostUnitFromFeedstock();
    }

    window.syncBpCostUnitFromFeedstock = function() {
        const sel = document.getElementById('bp-cost-name');
        const unitInput = document.getElementById('bp-cost-unit');
        if (!sel || !unitInput) return;
        const opt = sel.options[sel.selectedIndex];
        unitInput.value = opt ? (opt.getAttribute('data-unit') || 'Units') : 'Units';
    };

    window.addBpCostRow = function() {
        const sel = document.getElementById('bp-cost-name');
        const name = sel ? sel.value : '';
        // Bug fix (bug hunt, this session): the `qty <= 0` validation below
        // was dead code -- qty was already floored to a minimum of 1 above
        // BEFORE the check ran, so a blank/zero/negative input silently
        // became qty 1 instead of triggering the intended alert. Validate
        // the raw parsed value first, then apply the floor.
        const rawQty = parseInt(document.getElementById('bp-cost-qty').value);
        const unit = document.getElementById('bp-cost-unit').value.trim() || 'Units';
        if (!name || !(rawQty > 0)) { alert('Select an input and enter a positive quantity.'); return; }
        const qty = rawQty;
        workingCosts.push({ name, qty, unit });
        document.getElementById('bp-cost-qty').value = '';
        renderCostList();
    };

    function syncOutputFields() {
        const type = document.getElementById('bp-output-type').value;
        document.getElementById('bp-output-cargo-fields').style.display = type === 'cargo_item' ? 'block' : 'none';
        document.getElementById('bp-output-weapon-fields').style.display = type === 'arsenal_weapon' ? 'block' : 'none';
        document.getElementById('bp-output-infra-fields').style.display = type === 'colony_infrastructure' ? 'block' : 'none';
    }

    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'blueprint-edit-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:440px; max-width:94vw; max-height:88vh; overflow-y:auto; border-color:#c9962f;">
            <h4 style="color:#c9962f; margin-top:0;" id="bp-modal-title">New Manufacturing Blueprint</h4>
            <label for="bp-edit-name" style="font-size:9px; color:#6b826a;">Blueprint Name</label>
            <input type="text" id="bp-edit-name" style="border-color:#c9962f;">
            <label for="bp-edit-desc" style="font-size:9px; color:#6b826a;">Description</label>
            <textarea id="bp-edit-desc" rows="2" style="border-color:#c9962f;"></textarea>
            <label for="bp-edit-hours" style="font-size:9px; color:#6b826a;">Base Time Cost (hours, before any perk discount)</label>
            <input type="number" id="bp-edit-hours" min="0.1" step="0.1" value="24" style="border-color:#c9962f;">

            <label style="font-size:9px; color:#6b826a; margin-top:8px; display:block;">Resource Cost (ignored for colony-started builds -- colonies have no cargo of their own). Pick from any existing blueprint's output, grouped by tier below -- Tier 1 is a raw feedstock, Tier 2+ is itself something manufactured. To add a brand-new base feedstock, save a separate time-only blueprint for it first, then it'll appear here.</label>
            <div id="bp-cost-list" style="margin-bottom:4px;"></div>
            <div id="bp-tier-warning" style="font-size:9px; margin-bottom:6px;"></div>
            <div style="background:#030403; padding:6px; border:1px solid #c9962f; border-radius:2px; display:flex; gap:4px; align-items:center;">
                <label for="bp-cost-name" style="display:none;">Input</label>
                <select id="bp-cost-name" onchange="window.syncBpCostUnitFromFeedstock()" style="flex:1.6; margin:0; font-size:9px;"></select>
                <label for="bp-cost-qty" style="display:none;">Qty</label>
                <input type="number" id="bp-cost-qty" placeholder="Qty" min="1" style="flex:0.7; margin:0; font-size:9px; text-align:center;">
                <label for="bp-cost-unit" style="display:none;">Unit</label>
                <input type="text" id="bp-cost-unit" placeholder="Unit" value="Units" style="flex:0.9; margin:0; font-size:9px;" readonly title="Auto-filled from the selected input's own blueprint -- edit that blueprint to change its unit.">
                <button class="btn-reveal" onclick="window.addBpCostRow()" style="width:auto; margin:0; padding:3px 8px; font-size:9px;">+</button>
            </div>

            <label for="bp-output-type" style="font-size:9px; color:#6b826a; margin-top:8px; display:block;">Produces</label>
            <select id="bp-output-type" onchange="window.syncBlueprintOutputFieldsPublic()" style="border-color:#c9962f;">
                <option value="cargo_item">A named cargo item (delivered to a vessel's hold)</option>
                <option value="arsenal_weapon">An Arsenal weapon (delivered to the crafting character)</option>
                <option value="colony_infrastructure">Colony Infrastructure (raises a colony's Infrastructure Level -- colony builds only)</option>
            </select>

            <div id="bp-output-cargo-fields" style="margin-top:6px;">
                <div style="display:flex; gap:6px;">
                    <input type="text" id="bp-out-cargo-name" placeholder="Item name" style="flex:2; margin:0; font-size:9px; border-color:#c9962f;">
                    <input type="number" id="bp-out-cargo-qty" placeholder="Qty" min="1" value="1" style="flex:1; margin:0; font-size:9px; text-align:center; border-color:#c9962f;">
                    <input type="text" id="bp-out-cargo-unit" placeholder="Unit" value="Units" style="flex:1; margin:0; font-size:9px; border-color:#c9962f;">
                </div>
                <label for="bp-out-cargo-bucket" style="font-size:8px; color:#6b826a; margin-top:5px; display:block;">Cargo Category -- which hold this lands in on delivery. Perishables is what the daily rations/starvation check reads from; defaults to Expendables.</label>
                <select id="bp-out-cargo-bucket" style="margin:0; font-size:9px; border-color:#c9962f;">
                    <option value="expendables">Expendables (default)</option>
                    <option value="perishables">Perishables</option>
                    <option value="misc">Misc</option>
                </select>
            </div>
            <div id="bp-output-weapon-fields" style="margin-top:6px; display:none;">
                <div style="display:flex; gap:6px; margin-bottom:6px;">
                    <input type="text" id="bp-out-wpn-name" placeholder="Weapon name" style="flex:2; margin:0; font-size:9px; border-color:#c9962f;">
                    <input type="text" id="bp-out-wpn-dice" placeholder="Dice (e.g. 1d6)" value="1d6" style="flex:1; margin:0; font-size:9px; border-color:#c9962f;">
                    <input type="text" id="bp-out-wpn-mod" placeholder="Mod (e.g. +0)" value="+0" style="flex:1; margin:0; font-size:9px; border-color:#c9962f;">
                </div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <select id="bp-out-wpn-dmgtype" style="flex:1.4; margin:0; font-size:9px; border-color:#c9962f;"></select>
                    <input type="number" id="bp-out-wpn-ammo" placeholder="Ammo (blank=infinite)" style="flex:1; margin:0; font-size:9px; border-color:#c9962f;">
                    <label style="font-size:9px; color:#d4c5a9; display:flex; align-items:center; gap:3px; white-space:nowrap;"><input type="checkbox" id="bp-out-wpn-explodes" checked style="margin:0;"> Explodes</label>
                </div>
            </div>
            <div id="bp-output-infra-fields" style="margin-top:6px; display:none;">
                <label for="bp-out-infra-level" style="font-size:8px; color:#6b826a; display:block;">Target Infrastructure Level -- completing this build raises the colony to this level (never lowers it if already higher). Colony-build-only; per the confirmed design a colony must already be at Infrastructure Level N to build a Tier N item, so this blueprint's OWN resource-cost tier is exempt from that gate (it's how a colony reaches the level in the first place).</label>
                <input type="number" id="bp-out-infra-level" min="1" value="2" style="border-color:#c9962f; text-align:center;">
            </div>

            <div style="display:flex; gap:10px; margin-top:14px;">
                <button id="bp-edit-cancel-btn" style="flex:1; margin-top:0;">CANCEL</button>
                <button id="bp-edit-save-btn" class="btn-reveal" style="flex:1; margin-top:0; border-color:#c9962f; color:#c9962f;">SAVE</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('bp-edit-cancel-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        window.syncBlueprintOutputFieldsPublic = syncOutputFields;
        if (typeof window.buildDamageTypeOptionsHtml === 'function') {
            document.getElementById('bp-out-wpn-dmgtype').innerHTML = window.buildDamageTypeOptionsHtml('Impact');
        }

        document.getElementById('bp-edit-save-btn').addEventListener('click', async () => {
            const name = document.getElementById('bp-edit-name').value.trim();
            if (!name) { alert('Enter a blueprint name.'); return; }
            const outputType = document.getElementById('bp-output-type').value;
            let outputPayload = {};
            if (outputType === 'arsenal_weapon') {
                const wpnName = document.getElementById('bp-out-wpn-name').value.trim();
                if (!wpnName) { alert('Enter the produced weapon\'s name.'); return; }
                let mod = document.getElementById('bp-out-wpn-mod').value.trim();
                if (mod && !mod.startsWith('+') && !mod.startsWith('-')) mod = '+' + mod;
                const ammoInput = document.getElementById('bp-out-wpn-ammo');
                const ammoVal = (ammoInput.value.trim() !== '') ? Math.max(0, parseInt(ammoInput.value) || 0) : null;
                outputPayload = {
                    name: wpnName,
                    dice: document.getElementById('bp-out-wpn-dice').value.trim() || '1d6',
                    modifier: mod || '+0',
                    explodes: document.getElementById('bp-out-wpn-explodes').checked,
                    damage_type: document.getElementById('bp-out-wpn-dmgtype').value || null,
                    ammo: ammoVal, max_ammo: ammoVal
                };
            } else if (outputType === 'colony_infrastructure') {
                outputPayload = {
                    infrastructure_level: Math.max(1, parseInt(document.getElementById('bp-out-infra-level').value) || 1)
                };
            } else {
                const itemName = document.getElementById('bp-out-cargo-name').value.trim();
                if (!itemName) { alert('Enter the produced item\'s name.'); return; }
                outputPayload = {
                    name: itemName,
                    qty: Math.max(1, parseInt(document.getElementById('bp-out-cargo-qty').value) || 1),
                    unit: document.getElementById('bp-out-cargo-unit').value.trim() || 'Units',
                    cargo_bucket: document.getElementById('bp-out-cargo-bucket').value || 'expendables'
                };
            }

            const payload = {
                name,
                description: document.getElementById('bp-edit-desc').value.trim(),
                time_cost_hours: Math.max(0.1, parseFloat(document.getElementById('bp-edit-hours').value) || 24),
                resource_cost: workingCosts,
                output_type: outputType,
                output_payload: outputPayload
            };

            if (currentId) {
                // Never touch status on an update -- an approved blueprint
                // being edited by the DM stays approved, and a draft being
                // edited by its own proposer stays draft until a DM
                // approves it. Same as perk_definitions' own update path.
                const { error } = await db.from('manufacturing_blueprints').update(payload).eq('id', currentId);
                if (error) { alert('Failed to save blueprint: ' + error.message); return; }
            } else {
                payload.created_by = currentUserId;
                // DM-authored blueprints go straight in as approved; anyone
                // else's proposal starts as a draft pending DM review --
                // exact mirror of perk_definitions' own insert-status rule.
                payload.status = currentUserRole === 'dm' ? 'approved' : 'draft';
                const { error } = await db.from('manufacturing_blueprints').insert(payload);
                if (error) { alert('Failed to create blueprint: ' + error.message); return; }
            }
            overlay.style.display = 'none';
            loadManufacturingBlueprints();
        });
    }

    window.openNewBlueprintModal = function() {
        // No permission gate -- anyone can propose a new blueprint now (same
        // as openNewPerkModal has none). A DM's own submission still saves
        // straight to 'approved'; anyone else's starts as a 'draft' pending
        // review -- see the save handler above.
        ensureModal();
        currentId = null;
        workingCosts = [];
        document.getElementById('bp-modal-title').innerText = currentUserRole === 'dm' ? 'New Manufacturing Blueprint' : 'Propose New Manufacturing Blueprint';
        document.getElementById('bp-edit-name').value = '';
        document.getElementById('bp-edit-desc').value = '';
        document.getElementById('bp-edit-hours').value = 24;
        document.getElementById('bp-output-type').value = 'cargo_item';
        document.getElementById('bp-out-cargo-name').value = '';
        document.getElementById('bp-out-cargo-qty').value = 1;
        document.getElementById('bp-out-cargo-unit').value = 'Units';
        document.getElementById('bp-out-cargo-bucket').value = 'expendables';
        document.getElementById('bp-out-wpn-name').value = '';
        document.getElementById('bp-out-wpn-dice').value = '1d6';
        document.getElementById('bp-out-wpn-mod').value = '+0';
        document.getElementById('bp-out-wpn-ammo').value = '';
        document.getElementById('bp-out-wpn-explodes').checked = true;
        document.getElementById('bp-out-infra-level').value = 2;
        syncOutputFields();
        populateCostInputDropdown();
        renderCostList();
        overlay.style.display = 'flex';
    };

    window.openEditBlueprintModal = function(id) {
        const bp = manufacturingBlueprintsList.find(b => b.id === id);
        if (!bp) return;
        // Belt-and-suspenders check (the edit button itself is already only
        // ever rendered for someone canManageBlueprint(bp) already allows --
        // see renderManufacturingPanel below) -- unlike openEditPerkModal,
        // which trusts the button's own visibility as its only gate.
        if (!canManageBlueprint(bp)) return;
        ensureModal();
        currentId = id;
        workingCosts = JSON.parse(JSON.stringify(bp.resource_cost || []));
        document.getElementById('bp-modal-title').innerText = 'Edit Manufacturing Blueprint';
        document.getElementById('bp-edit-name').value = bp.name || '';
        document.getElementById('bp-edit-desc').value = bp.description || '';
        document.getElementById('bp-edit-hours').value = bp.time_cost_hours || 24;
        document.getElementById('bp-output-type').value = bp.output_type || 'cargo_item';
        const p = bp.output_payload || {};
        document.getElementById('bp-out-cargo-name').value = bp.output_type === 'cargo_item' ? (p.name || '') : '';
        document.getElementById('bp-out-cargo-qty').value = bp.output_type === 'cargo_item' ? (p.qty || 1) : 1;
        document.getElementById('bp-out-cargo-unit').value = bp.output_type === 'cargo_item' ? (p.unit || 'Units') : 'Units';
        document.getElementById('bp-out-cargo-bucket').value = (bp.output_type === 'cargo_item' && ['expendables', 'perishables', 'misc'].includes(p.cargo_bucket)) ? p.cargo_bucket : 'expendables';
        document.getElementById('bp-out-wpn-name').value = bp.output_type === 'arsenal_weapon' ? (p.name || '') : '';
        document.getElementById('bp-out-wpn-dice').value = bp.output_type === 'arsenal_weapon' ? (p.dice || '1d6') : '1d6';
        document.getElementById('bp-out-wpn-mod').value = bp.output_type === 'arsenal_weapon' ? (p.modifier || '+0') : '+0';
        document.getElementById('bp-out-wpn-ammo').value = (bp.output_type === 'arsenal_weapon' && p.ammo !== null && p.ammo !== undefined) ? p.ammo : '';
        document.getElementById('bp-out-wpn-explodes').checked = bp.output_type === 'arsenal_weapon' ? (p.explodes !== false) : true;
        if (bp.output_type === 'arsenal_weapon' && p.damage_type) document.getElementById('bp-out-wpn-dmgtype').value = p.damage_type;
        document.getElementById('bp-out-infra-level').value = bp.output_type === 'colony_infrastructure' ? (p.infrastructure_level || 2) : 2;
        syncOutputFields();
        populateCostInputDropdown();
        renderCostList();
        overlay.style.display = 'flex';
    };
})();

/* ==========================================================================
   STARTING AN ORDER -- vessel path (must have a Manufacturing-type deck;
   discount applies to both resource cost and time; resources deducted
   from the vessel's own cargo expendables immediately).
   ========================================================================== */

const MANUFACTURING_CARGO_BUCKETS = ['expendables', 'perishables', 'misc'];

// A manufactured cargo output can now land in any of the three cargo
// buckets (see the CARGO CATEGORY header comment at the top of this file),
// so a resource-cost input has to be searched for across all three, not
// just expendables -- otherwise a Tier 2+ recipe could never consume an
// input another blueprint delivers into perishables or misc. Returns
// {item, bucket} for the first bucket (checked in a fixed order) that has
// a case-insensitive name match, or null if none does.
function findCargoItemAcrossBuckets(cargo, name) {
    const lower = (name || '').toLowerCase();
    for (const bucket of MANUFACTURING_CARGO_BUCKETS) {
        const item = (cargo[bucket] || []).find(i => i.name.toLowerCase() === lower);
        if (item) return { item, bucket };
    }
    return null;
}

window.startVesselManufacturingOrder = async function(vesselId, blueprintId) {
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    // Bug-hunt pass (2026-09-24): ships moved to multi-owner `owner_ids` long ago; this still read the legacy single `owner_id` column (stale on 2 of 8 ships, blank on the rest), so non-DM owners were silently refused.
    if (!(currentUserRole === 'dm' || window.vesselHasOwner(vessel, currentUserId))) { alert("Only this vessel's owners (or the DM) can start a build here."); return; }

    const mfgDeck = (vessel.ship_decks || []).find(d => d.type === 'manufacturing');
    if (!mfgDeck) { alert('This vessel has no Manufacturing-type deck installed -- building requires one.'); return; }

    // Blueprint id now comes from the Build modal (Tabs/Search/Build-Popup
    // pass, 2026-09-14 -- js/manufacturing.js's openVesselBuildModal) rather
    // than an inline <select> that used to live in the Manufacturing Bay
    // box (js/combat.js). No other caller of this function exists.
    if (!blueprintId) { alert('Select a blueprint to build first.'); return; }
    const bp = manufacturingBlueprintsList.find(b => b.id === blueprintId);
    if (!bp) return;
    // Infrastructure (2026-09-14): colony_infrastructure output raises a
    // COLONY's Infrastructure Level -- vessels have no such concept, so this
    // is rejected here as defense in depth even though the vessel Manufacturing
    // Bay's own blueprint dropdown already filters these out (js/combat.js).
    if (bp.output_type === 'colony_infrastructure') { alert('Infrastructure blueprints can only be built at a colony.'); return; }

    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character || !myProf.character.id) { alert('Please save your Dossier & Stats once first before starting a build.'); return; }
    const discountPct = window.getManufacturingDiscountPct(myProf.perks);

    // Damaged Manufacturing deck slows a build down rather than blocking it
    // outright (the existence check above is the hard gate; this is a soft
    // penalty on top of it). Same ratio Fleet Group Production already uses
    // for its own Manufacturing-deck scaling (js/colonies.js:
    // mfgDeck.hp / mfgDeck.max_hp), but applied inversely here since deck
    // damage is meant to lengthen TIME, not shrink an output quantity --
    // there is no output quantity to shrink on a build order. Floored at
    // 10% efficiency (never worse than a 10x time penalty) rather than
    // scaling all the way to 0 the way Production's OUTPUT does, since a
    // 0%-HP deck there just means "produces nothing" while a 0%-HP deck
    // here would otherwise mean "this build order can never complete" --
    // a judgment call, tune the floor here if that's not the intent.
    const deckScale = mfgDeck.max_hp > 0 ? Math.max(0.1, mfgDeck.hp / mfgDeck.max_hp) : 1;

    // Check every requirement BEFORE deducting anything, so a shortfall on
    // the second resource in the list never leaves the first one already
    // spent.
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    // Aggregate by name (case-insensitive) BEFORE checking sufficiency AND
    // before applying the discount. A blueprint can end up with more than
    // one cost row naming the same input (the multi-tier dropdown makes
    // picking the same entry twice an easy mistake, and nothing in the
    // editor stops it) -- checking each row independently against the SAME
    // un-decremented cargo snapshot would let a build pass the check even
    // when the rows' combined total exceeds what's actually in the hold,
    // driving that cargo item negative once every row's deduction lands.
    // Summing up front closes that gap; found during this session's
    // pre-deploy bug hunt.
    //
    // Bug fix (bug hunt, this session): the discount's `Math.max(1, ...)`
    // floor used to be applied to each RAW row individually, before this
    // aggregation step -- so two rows of qty 1 each (2 total) at a 50%
    // discount became `max(1, round(0.5))=1` PER ROW, summing to 2 (no
    // discount at all), while the same 2-total entered as a single row
    // would correctly floor to 1. Aggregate the undiscounted raw
    // quantities first, THEN apply the discount/floor once to each summed
    // total, so a recipe's discount is consistent regardless of how many
    // rows the author happened to split it across.
    const rawTotalsByName = new Map();
    (bp.resource_cost || []).forEach(c => {
        const key = c.name.toLowerCase();
        const existing = rawTotalsByName.get(key);
        if (existing) existing.qty += c.qty;
        else rawTotalsByName.set(key, { name: c.name, unit: c.unit || 'Units', qty: c.qty });
    });
    const requirements = Array.from(rawTotalsByName.values()).map(req => ({
        ...req,
        qty: discountPct ? Math.max(1, Math.round(req.qty * (1 - discountPct / 100))) : req.qty
    }));
    for (const req of requirements) {
        const found = findCargoItemAcrossBuckets(cargo, req.name);
        if (!found || found.item.qty < req.qty) {
            alert(`Insufficient ${req.name}: need ${req.qty}, have ${found ? found.item.qty : 0}.`);
            return;
        }
    }
    // Snapshot exactly what's deducted -- name/unit/qty AND which bucket it
    // came from -- onto the order itself as resource_cost_snapshot. Needed
    // so a later cancel can refund precisely what was taken, into the same
    // bucket, rather than guessing from the blueprint's current (possibly
    // since-edited) resource_cost. See window.cancelManufacturingOrder.
    const deductedSnapshot = requirements.map(req => {
        const found = findCargoItemAcrossBuckets(cargo, req.name);
        found.item.qty -= req.qty;
        return { name: req.name, unit: req.unit, qty: req.qty, bucket: found.bucket };
    });

    await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
    vessel.cargo_inventory = cargo;
    if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();

    const durationHours = Math.max(0.1, (bp.time_cost_hours * (1 - discountPct / 100)) / deckScale);
    const { error } = await db.from('manufacturing_orders').insert({
        blueprint_id: bp.id, blueprint_name: bp.name, output_type: bp.output_type, output_payload: bp.output_payload,
        source_type: 'vessel', vessel_id: vesselId, character_id: myProf.character.id, initiated_by: currentUserId,
        started_at_hours: window.universeTimeHours, duration_hours: durationHours, discount_pct: discountPct,
        resource_cost_snapshot: deductedSnapshot
    });
    if (error) { alert('Failed to start build: ' + error.message); return; }

    await db.from('chat_logs').insert({
        sender_id: null, message_type: 'system',
        content: `🏭 [MANUFACTURING] ${vessel.name} began building "${bp.name}"${discountPct ? ` (${discountPct}% discount applied)` : ''}${deckScale < 1 ? ` (Manufacturing deck at ${Math.round(deckScale * 100)}% — build slowed)` : ''} — ready in ${durationHours.toFixed(1)}h.`
    });
    loadManufacturingOrders();
};

/* --- STARTING AN ORDER -- colony path.

   Manufacturing Facility (2026-09-14): a colony with has_manufacturing_facility
   now attempts the SAME aggregate-then-check-then-deduct sequence
   window.startVesselManufacturingOrder uses, drawing from the colony's own
   cargo_inventory (see js/colonies.js's window.sanitizeColonyCargo) instead
   of a vessel's. Per the confirmed design, this is a SOFT attempt, not a
   hard gate the way a vessel build is: no facility, no resource_cost on the
   blueprint, or insufficient stock all fall back to today's original
   time-only behavior rather than blocking the build outright -- colonies
   never refuse a build the way a vessel does. Which path actually happened
   is reported in the completion chat log below.

   Finished output delivers to a picked vessel, reusing the same
   vessel-select the colony's Storage pickup box uses -- EXCEPT a
   colony_infrastructure build (Infrastructure, 2026-09-14), which has
   nothing to deliver anywhere (its "output" is the colony's own
   infrastructure_level going up) and so needs no vessel selected at all.

   Infrastructure GATE (2026-09-14, confirmed design: Level N unlocks Tier
   N, 1:1): unlike the soft materials fallback above, this one IS a hard
   block -- a colony below the blueprint's own derived tier cannot attempt
   the build at all, full stop, no time-only fallback. The one deliberate
   exception is a colony_infrastructure blueprint itself: its own tier is
   exempt from this check, since otherwise a colony could never reach a
   higher level in the first place (reaching Level 3 would require an
   infrastructure blueprint whose own resource chain is Tier 3, which would
   require already being at Level 3 -- a contradiction). --- */

window.startColonyManufacturingOrder = async function(colonyId, blueprintId) {
    const colony = coloniesList.find(c => c.id === colonyId);
    if (!colony) return;
    if (!(currentUserRole === 'dm' || colony.owner_id === currentUserId)) return;

    // Blueprint id now comes from the Build modal (Tabs/Search/Build-Popup
    // pass, 2026-09-14 -- js/manufacturing.js's openColonyBuildModal) rather
    // than an inline <select> that used to live in this box. The delivery
    // vessel picker below is untouched -- it's a separate element on the
    // colony card itself (shared with the Storage pickup dropdown).
    if (!blueprintId) { alert('Select a blueprint to build first.'); return; }
    const bp = manufacturingBlueprintsList.find(b => b.id === blueprintId);
    if (!bp) return;

    const isInfrastructure = bp.output_type === 'colony_infrastructure';
    if (!isInfrastructure) {
        const requiredLevel = computeBlueprintTier(bp);
        const currentLevel = colony.infrastructure_level || 1;
        if (requiredLevel !== Infinity && requiredLevel > currentLevel) {
            alert(`${colony.name}'s Infrastructure Level (${currentLevel}) is too low to build "${bp.name}" (Tier ${requiredLevel}). Raise Infrastructure to Level ${requiredLevel} first.`);
            return;
        }
    }

    let vesselId = null, vessel = null;
    if (!isInfrastructure) {
        const vesselSelect = document.getElementById(`colony-deliver-vessel-${colonyId}`);
        vesselId = vesselSelect ? vesselSelect.value : null;
        if (!vesselId) { alert('Select a vessel to receive the finished build first (same dropdown used for storage pickups).'); return; }
        vessel = globalShipMarkersCache.find(m => m.id === vesselId);
        if (!vessel) return;
    }

    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character || !myProf.character.id) { alert('Please save your Dossier & Stats once first before starting a build.'); return; }
    const discountPct = window.getManufacturingDiscountPct(myProf.perks);
    const durationHours = Math.max(0.1, bp.time_cost_hours * (1 - discountPct / 100));

    let deductedSnapshot = null;
    let usedMaterials = false;
    if (colony.has_manufacturing_facility && (bp.resource_cost || []).length > 0) {
        let cargo = window.sanitizeColonyCargo(colony.cargo_inventory);
        // Same aggregate-by-name-then-discount sequence as the vessel path,
        // and for the same reason -- a blueprint can list the same input
        // across more than one cost row.
        const rawTotalsByName = new Map();
        bp.resource_cost.forEach(c => {
            const key = c.name.toLowerCase();
            const existing = rawTotalsByName.get(key);
            if (existing) existing.qty += c.qty;
            else rawTotalsByName.set(key, { name: c.name, unit: c.unit || 'Units', qty: c.qty });
        });
        const requirements = Array.from(rawTotalsByName.values()).map(req => ({
            ...req,
            qty: discountPct ? Math.max(1, Math.round(req.qty * (1 - discountPct / 100))) : req.qty
        }));
        const allAvailable = requirements.every(req => {
            const found = findCargoItemAcrossBuckets(cargo, req.name);
            return found && found.item.qty >= req.qty;
        });
        if (allAvailable) {
            deductedSnapshot = requirements.map(req => {
                const found = findCargoItemAcrossBuckets(cargo, req.name);
                found.item.qty -= req.qty;
                return { name: req.name, unit: req.unit, qty: req.qty, bucket: found.bucket };
            });
            await db.from('colonies').update({ cargo_inventory: cargo }).eq('id', colonyId);
            colony.cargo_inventory = cargo;
            usedMaterials = true;
            if (typeof window.renderColoniesPanel === 'function') window.renderColoniesPanel();
        }
        // else: not enough in storage -- fall through to time-only below,
        // deductedSnapshot stays null, nothing is deducted.
    }

    const { error } = await db.from('manufacturing_orders').insert({
        blueprint_id: bp.id, blueprint_name: bp.name, output_type: bp.output_type, output_payload: bp.output_payload,
        source_type: 'colony', vessel_id: vesselId, source_colony_id: colonyId, character_id: myProf.character.id, initiated_by: currentUserId,
        started_at_hours: window.universeTimeHours, duration_hours: durationHours, discount_pct: discountPct,
        resource_cost_snapshot: deductedSnapshot
    });
    if (error) { alert('Failed to start build: ' + error.message); return; }

    const materialsNote = usedMaterials
        ? ` Materials drawn from colony storage: ${deductedSnapshot.map(r => `${r.qty}x ${r.name}`).join(', ')}.`
        : (colony.has_manufacturing_facility && (bp.resource_cost || []).length > 0
            ? ' Insufficient stored materials — built as time-only instead.'
            : ' Colony builds without stored materials cost time only.');
    const destinationNote = isInfrastructure ? '' : ` for delivery to ${vessel.name}`;
    await db.from('chat_logs').insert({
        sender_id: null, message_type: 'system',
        content: `🏭 [MANUFACTURING] ${colony.name} began building "${bp.name}"${destinationNote}${discountPct ? ` (${discountPct}% discount applied)` : ''} — ready in ${durationHours.toFixed(1)}h.${materialsNote}`
    });
    loadManufacturingOrders();
};

/* ==========================================================================
   BUILD PREVIEW (shared core) + BUILD POPUP MODAL -- added 2026-09-14 per
   the DM's request for "a pop up function similar to how notes pop up...
   so it is more clear what a user's options are", replacing the old blind
   <select>+BUILD button at both the vessel Manufacturing Bay box
   (js/combat.js) and the colony Manufacturing box (renderColonyManufacturingBox
   above).

   computeManufacturingPreview(bp, opts) is a DOM-independent "core"
   function (opts = {vessel} or {colony}) -- the same core/wrapper shape
   used elsewhere in this codebase (e.g. resolveShipWeaponFire), so it can
   be called equally from this popup's render loop or, in principle, from
   anywhere else that needs a live afford-check without touching the DOM.

   Judgment call / known limitation (flagging per project convention rather
   than implying full parity): this function MIRRORS the requirement/
   sufficiency logic inside startVesselManufacturingOrder and
   startColonyManufacturingOrder rather than sharing a single code path
   with them -- extracting a true shared core would mean touching the two
   already-working, already-tested order-start functions themselves, which
   felt like more risk than this pass warranted. If either start function's
   gating/discount/deck-scale logic changes later, this preview needs the
   same change made here or it will silently drift out of sync and show a
   "can build" preview that the actual BUILD click then contradicts. */
function computeManufacturingPreview(bp, opts) {
    const myProf = (typeof allProfiles !== 'undefined' && typeof currentUserId !== 'undefined') ? allProfiles.find(p => p.id === currentUserId) : null;
    const discountPct = (myProf && typeof window.getManufacturingDiscountPct === 'function') ? window.getManufacturingDiscountPct(myProf.perks) : 0;
    const tier = computeBlueprintTier(bp);
    const isInfrastructure = bp.output_type === 'colony_infrastructure';
    const result = { tier, discountPct, isInfrastructure, blocking: [], notes: [], costRows: [], timeHours: null, needsVessel: false, canBuild: true };

    // Same aggregate-by-name-then-discount sequence the two start functions
    // use, for the same reason -- a blueprint can list the same input
    // across more than one cost row.
    const rawTotalsByName = new Map();
    (bp.resource_cost || []).forEach(c => {
        const key = c.name.toLowerCase();
        const existing = rawTotalsByName.get(key);
        if (existing) existing.qty += c.qty;
        else rawTotalsByName.set(key, { name: c.name, unit: c.unit || 'Units', qty: c.qty });
    });
    const requirements = Array.from(rawTotalsByName.values()).map(req => ({
        ...req,
        qty: discountPct ? Math.max(1, Math.round(req.qty * (1 - discountPct / 100))) : req.qty
    }));

    if (opts && opts.vessel) {
        const vessel = opts.vessel;
        if (isInfrastructure) result.blocking.push('Infrastructure blueprints can only be built at a colony.');
        const mfgDeck = (vessel.ship_decks || []).find(d => d.type === 'manufacturing');
        if (!mfgDeck) result.blocking.push('No Manufacturing-type deck installed on this vessel.');
        const deckScale = mfgDeck && mfgDeck.max_hp > 0 ? Math.max(0.1, mfgDeck.hp / mfgDeck.max_hp) : 1;
        if (mfgDeck && deckScale < 1) result.notes.push(`Manufacturing deck at ${Math.round(deckScale * 100)}% HP — build will take ${(1 / deckScale).toFixed(1)}x longer.`);
        result.timeHours = Math.max(0.1, (bp.time_cost_hours * (1 - discountPct / 100)) / deckScale);

        const cargo = window.sanitizeCargo(vessel.cargo_inventory);
        result.costRows = requirements.map(req => {
            const found = findCargoItemAcrossBuckets(cargo, req.name);
            const have = found ? found.item.qty : 0;
            const sufficient = have >= req.qty;
            if (!sufficient) result.blocking.push(`Insufficient ${req.name}: need ${req.qty}, have ${have}.`);
            return { name: req.name, unit: req.unit, qty: req.qty, have, sufficient };
        });
    } else if (opts && opts.colony) {
        const colony = opts.colony;
        if (!isInfrastructure) {
            const currentLevel = colony.infrastructure_level || 1;
            if (tier !== Infinity && tier > currentLevel) {
                result.blocking.push(`${colony.name}'s Infrastructure Level (${currentLevel}) is too low — needs Level ${tier}.`);
            }
            result.needsVessel = true;
        }
        result.timeHours = Math.max(0.1, bp.time_cost_hours * (1 - discountPct / 100));

        if (requirements.length > 0) {
            if (colony.has_manufacturing_facility) {
                const cargo = window.sanitizeColonyCargo(colony.cargo_inventory);
                let allAvailable = true;
                result.costRows = requirements.map(req => {
                    const found = findCargoItemAcrossBuckets(cargo, req.name);
                    const have = found ? found.item.qty : 0;
                    const sufficient = have >= req.qty;
                    if (!sufficient) allAvailable = false;
                    return { name: req.name, unit: req.unit, qty: req.qty, have, sufficient };
                });
                result.notes.push(allAvailable
                    ? 'Sufficient materials in colony storage — will draw from storage.'
                    : 'Insufficient stored materials right now — will fall back to a time-only build (not blocked).');
            } else {
                result.costRows = requirements.map(req => ({ name: req.name, unit: req.unit, qty: req.qty, have: null, sufficient: null }));
                result.notes.push('No Manufacturing Facility installed — this build will be time-only regardless of the listed materials.');
            }
        }
    }

    result.canBuild = result.blocking.length === 0;
    return result;
}
window.computeManufacturingPreview = computeManufacturingPreview;

/* Self-contained IIFE-wrapped popup modal -- same convention as the
   Blueprint editor modal above (overlay div injected into the body once,
   toggled via display:flex/none, closes on backdrop click). One shared
   overlay reused for both the vessel and colony contexts (buildModalContext
   tracks which). */
(function() {
    let overlay, buildModalContext = null; // { type: 'vessel'|'colony', id }

    function ensureBuildModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'manufacturing-build-overlay';
        overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(3,4,6,0.85); z-index:5000; align-items:center; justify-content:center;';
        overlay.innerHTML = `<div class="panel" style="position:relative; width:520px; max-width:94vw; max-height:88vh; overflow-y:auto; border-color:#c9962f;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <h4 style="color:#c9962f; margin:0;" id="mfg-build-modal-title">Select a Blueprint</h4>
                <button id="mfg-build-modal-close" style="width:auto; margin:0; padding:3px 10px; font-size:10px;">✕ CLOSE</button>
            </div>
            <p id="mfg-build-modal-subtitle" style="font-size:9px; color:#6b826a; margin:4px 0 10px 0;"></p>
            <div id="mfg-build-modal-list" style="display:flex; flex-direction:column; gap:8px;"></div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('mfg-build-modal-close').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
    }

    function renderBuildModalList() {
        if (!buildModalContext) return;
        const listEl = document.getElementById('mfg-build-modal-list');
        const subtitleEl = document.getElementById('mfg-build-modal-subtitle');
        if (!listEl) return;

        let opts, blueprints;
        if (buildModalContext.type === 'vessel') {
            const vessel = globalShipMarkersCache.find(m => m.id === buildModalContext.id);
            if (!vessel) { overlay.style.display = 'none'; return; }
            opts = { vessel };
            // Same exclusion as the Manufacturing Bay box's own filter --
            // colony_infrastructure is colony-build-only.
            blueprints = manufacturingBlueprintsList.filter(b => b.status !== 'draft' && b.output_type !== 'colony_infrastructure');
            document.getElementById('mfg-build-modal-title').innerText = `Build at ${vessel.name}`;
            subtitleEl.innerText = 'Drawn from this vessel\'s own cargo. A greyed-out entry cannot be built right now -- the reason is listed under it.';
        } else {
            const colony = coloniesList.find(c => c.id === buildModalContext.id);
            if (!colony) { overlay.style.display = 'none'; return; }
            opts = { colony };
            blueprints = manufacturingBlueprintsList.filter(b => b.status !== 'draft');
            document.getElementById('mfg-build-modal-title').innerText = `Build at ${colony.name}`;
            const vesselSelect = document.getElementById(`colony-deliver-vessel-${colony.id}`);
            const deliveryVessel = vesselSelect ? globalShipMarkersCache.find(m => m.id === vesselSelect.value) : null;
            subtitleEl.innerHTML = deliveryVessel
                ? `Non-Infrastructure builds deliver to <strong style="color:#d4c5a9;">${deliveryVessel.name}</strong> (the vessel currently selected above). Materials are drawn from colony storage when a Facility is installed and stock allows -- otherwise time-only, never blocked.`
                : `⚠ No delivery vessel is selected in the Storage/Delivery dropdown above -- pick one first for any non-Infrastructure build. Materials are drawn from colony storage when a Facility is installed and stock allows -- otherwise time-only, never blocked.`;
        }

        if (blueprints.length === 0) {
            listEl.innerHTML = '<span style="font-size:10px; color:#6b826a;">No approved blueprints are buildable here.</span>';
            return;
        }

        // Whether a delivery vessel is picked is DOM state (the shared
        // colony-deliver-vessel-<id> select), not something the DOM-
        // independent computeManufacturingPreview core can see -- checked
        // here instead and folded into this row's own blocking list so the
        // reason shows up next to the button, not just in the subtitle.
        const missingDeliveryVessel = buildModalContext.type === 'colony' && !document.getElementById(`colony-deliver-vessel-${buildModalContext.id}`)?.value;

        listEl.innerHTML = blueprints.map(bp => {
            const preview = computeManufacturingPreview(bp, opts);
            const costText = preview.costRows.length === 0
                ? 'No listed resource cost (time only).'
                : preview.costRows.map(r => {
                    if (r.sufficient === null) return `${r.qty}x ${r.name}`; // no facility -- have/sufficient not meaningful
                    return `<span style="color:${r.sufficient ? '#6b826a' : '#ff6b6b'};">${r.qty}x ${r.name} (have ${r.have})</span>`;
                }).join(', ');
            const tierLine = preview.isInfrastructure
                ? `Reaches Infrastructure Level ${(bp.output_payload || {}).infrastructure_level || 1}`
                : `${formatBlueprintTier(preview.tier)}${preview.tier !== Infinity && preview.tier > 1 ? ` (needs Colony Infrastructure Lvl ${preview.tier} if built at a colony)` : ''}`;
            const rowBlocking = preview.blocking.slice();
            if (preview.needsVessel && missingDeliveryVessel) rowBlocking.push('No delivery vessel selected (pick one in the Storage/Delivery dropdown above).');
            const blockedHtml = rowBlocking.length
                ? `<p style="margin:4px 0 0 0; font-size:9px; color:#ff6b6b;">✕ ${rowBlocking.join(' &nbsp;·&nbsp; ')}</p>` : '';
            const notesHtml = preview.notes.length
                ? `<p style="margin:4px 0 0 0; font-size:9px; color:#6b826a;">${preview.notes.join(' &nbsp;·&nbsp; ')}</p>` : '';
            const buildableNow = preview.canBuild && !(preview.needsVessel && missingDeliveryVessel);
            return `
            <div class="note-card" style="border-left: 3px solid ${buildableNow ? '#3c4e36' : '#5a3a3a'}; opacity:${buildableNow ? '1' : '0.75'};">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                    <div style="flex:1;">
                        <strong style="color:#c9962f; font-size:12px;">${bp.name}</strong>
                        <span style="font-size:8px; color:#6b826a; margin-left:6px;">${tierLine}</span>
                        <p style="margin:2px 0 0 0; font-size:10px; color:#d4c5a9;">${bp.description || ''}</p>
                        <p style="margin:4px 0 0 0; font-size:9px; color:#6b826a;">Cost: ${costText} &nbsp;·&nbsp; Time: ~${preview.timeHours.toFixed(1)}h${preview.discountPct ? ` (${preview.discountPct}% perk discount applied)` : ''}</p>
                        ${blockedHtml}
                        ${notesHtml}
                    </div>
                    <button class="btn-deploy" ${buildableNow ? '' : 'disabled'} onclick="window.executeManufacturingBuildFromModal('${bp.id}')" style="flex:0 0 auto; font-size:9px; padding:4px 8px; margin:0;${buildableNow ? '' : ' opacity:0.5; cursor:not-allowed;'}">BUILD</button>
                </div>
            </div>`;
        }).join('');
    }

    window.openVesselBuildModal = function(vesselId) {
        ensureBuildModal();
        buildModalContext = { type: 'vessel', id: vesselId };
        renderBuildModalList();
        overlay.style.display = 'flex';
    };

    window.openColonyBuildModal = function(colonyId) {
        ensureBuildModal();
        buildModalContext = { type: 'colony', id: colonyId };
        renderBuildModalList();
        overlay.style.display = 'flex';
    };

    // Fired by a BUILD button inside the modal. Deliberately does NOT close
    // the modal -- it re-renders in place instead, so the user immediately
    // sees the effect of the build (materials drawn, in-progress row
    // appended elsewhere, another blueprint's afford-check possibly now
    // failing) without losing their place. Backdrop-click or the CLOSE
    // button dismiss it, same as the Blueprint editor modal above.
    window.executeManufacturingBuildFromModal = async function(blueprintId) {
        if (!buildModalContext) return;
        if (buildModalContext.type === 'vessel') {
            await window.startVesselManufacturingOrder(buildModalContext.id, blueprintId);
        } else {
            await window.startColonyManufacturingOrder(buildModalContext.id, blueprintId);
        }
        renderBuildModalList();
    };
})();

/* ==========================================================================
   CANCELLING AN IN-PROGRESS ORDER -- refunds the exact resources deducted
   at start time (via resource_cost_snapshot, see startVesselManufacturingOrder)
   back into whichever cargo bucket they came from. Permission mirrors the
   START permission exactly: DM, or the owner of whichever vessel/colony
   actually initiated the build (NOT the delivery vessel for a colony
   order -- the colony is what "paid" the time cost and is what a player
   would expect "my build" to mean there).

   A vessel order started before this column existed has
   resource_cost_snapshot === null -- there is no record of what was
   deducted (the blueprint's CURRENT resource_cost might not even match
   what the order actually cost if it's been edited since), so those
   cancel with a clear "could not auto-refund" notice instead of guessing.
   A colony order never deducted anything to begin with (time cost only),
   so its cancel is refund-free by design, not a gap.
   ========================================================================== */

window.cancelManufacturingOrder = async function(orderId) {
    // Re-fetch fresh rather than trusting the local cache -- the order may
    // have already completed (processManufacturingOrders deletes it) or
    // been cancelled by someone else in the moment between this button
    // rendering and being clicked.
    const { data: order } = await db.from('manufacturing_orders').select('*').eq('id', orderId).maybeSingle();
    if (!order) { alert('This build order no longer exists -- it may have already completed or been cancelled.'); loadManufacturingOrders(); return; }

    let ownerOk = currentUserRole === 'dm';
    let sourceName = 'Unknown source';
    if (!ownerOk && order.source_type === 'colony') {
        const colony = (typeof coloniesList !== 'undefined') ? coloniesList.find(c => c.id === order.source_colony_id) : null;
        if (colony) { ownerOk = colony.owner_id === currentUserId; sourceName = colony.name; }
    } else if (!ownerOk && order.source_type === 'vessel') {
        const vessel = globalShipMarkersCache.find(m => m.id === order.vessel_id);
        if (vessel) { ownerOk = window.vesselHasOwner(vessel, currentUserId); sourceName = vessel.name; } // Bug-hunt pass (2026-09-24): ships moved to multi-owner `owner_ids` long ago; this still read the legacy single `owner_id` column (stale on 2 of 8 ships, blank on the rest), so non-DM owners were silently refused.
    } else if (order.source_type === 'colony') {
        sourceName = ((typeof coloniesList !== 'undefined') ? coloniesList.find(c => c.id === order.source_colony_id) : null)?.name || sourceName;
    } else {
        sourceName = (globalShipMarkersCache.find(m => m.id === order.vessel_id) || {}).name || sourceName;
    }
    if (!ownerOk) { alert('Only the DM or the build\'s own source vessel/colony owner can cancel it.'); return; }

    // Bug fix (bug hunt, this session): `hasRefund` used to conflate two
    // different states -- (a) a legacy order with no resource_cost_snapshot
    // column value at all (started before refund tracking existed), and
    // (b) a perfectly normal, current-schema vessel order whose blueprint
    // simply has an empty resource_cost (a supported, deliberate "time-only
    // build" case, same as colony builds). Both produced an empty/absent
    // snapshot array, so both got the misleading "started before refund
    // tracking existed" message even when nothing is actually wrong. Check
    // "does a snapshot record exist at all" separately from "does it have
    // anything to refund."
    //
    // Manufacturing Facility (2026-09-14): a colony order can now ALSO carry
    // a real resource_cost_snapshot (when it drew materials from colony
    // storage -- see window.startColonyManufacturingOrder), so the snapshot
    // check is no longer vessel-only; a colony order with no snapshot (the
    // time-only fallback path, still the common case) reads exactly like
    // before.
    const hasSnapshotRecord = Array.isArray(order.resource_cost_snapshot);
    const hasRefund = hasSnapshotRecord && order.resource_cost_snapshot.length > 0;
    const refundLine = hasRefund
        ? `Refunds: ${order.resource_cost_snapshot.map(r => `${r.qty}x ${r.name}`).join(', ')}.`
        : (order.source_type === 'colony' || hasSnapshotRecord ? 'This build has no resource cost (time-only) -- nothing to refund.' : 'No resource-cost record on this order (started before refund tracking existed) -- it will be cancelled with NO automatic refund.');
    if (!(await window.showConfirmModal(`Cancel "${order.blueprint_name}" (${sourceName})? ${refundLine}`))) return;

    if (hasRefund) {
        if (order.source_type === 'colony') {
            const colony = (typeof coloniesList !== 'undefined') ? coloniesList.find(c => c.id === order.source_colony_id) : null;
            if (colony) {
                let cargo = window.sanitizeColonyCargo(colony.cargo_inventory);
                order.resource_cost_snapshot.forEach(r => {
                    const bucket = MANUFACTURING_CARGO_BUCKETS.includes(r.bucket) ? r.bucket : 'expendables';
                    const existing = (cargo[bucket] || []).find(i => i.name.toLowerCase() === r.name.toLowerCase());
                    if (existing) existing.qty += r.qty;
                    else cargo[bucket].push({ name: r.name, qty: r.qty, unit: r.unit || 'Units' });
                });
                await db.from('colonies').update({ cargo_inventory: cargo }).eq('id', colony.id);
                colony.cargo_inventory = cargo;
                if (typeof window.renderColoniesPanel === 'function') window.renderColoniesPanel();
            }
        } else {
            const vessel = globalShipMarkersCache.find(m => m.id === order.vessel_id);
            if (vessel) {
                let cargo = window.sanitizeCargo(vessel.cargo_inventory);
                order.resource_cost_snapshot.forEach(r => {
                    const bucket = MANUFACTURING_CARGO_BUCKETS.includes(r.bucket) ? r.bucket : 'expendables';
                    const existing = (cargo[bucket] || []).find(i => i.name.toLowerCase() === r.name.toLowerCase());
                    if (existing) existing.qty += r.qty;
                    else cargo[bucket].push({ name: r.name, qty: r.qty, unit: r.unit || 'Units' });
                });
                await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vessel.id);
                vessel.cargo_inventory = cargo;
                if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
            }
        }
    }

    // Delete rather than a status='cancelled' row -- same "no unbounded
    // table growth, chat log is the audit trail" convention completion
    // already uses just below.
    await db.from('manufacturing_orders').delete().eq('id', order.id);

    await db.from('chat_logs').insert({
        sender_id: null, message_type: 'system',
        content: `🚫 [MANUFACTURING] "${order.blueprint_name}" build at ${sourceName} was cancelled.${hasRefund ? ` Refunded: ${order.resource_cost_snapshot.map(r => `${r.qty}x ${r.name}`).join(', ')}.` : (order.source_type === 'vessel' ? ' No refund on record for this build.' : '')}`
    });
    // loadManufacturingOrders already re-renders the Manufacturing tab, the
    // Vessel Deck's Manufacturing Bay box, and the Colonies & Fleets boxes
    // (see its own definition near the top of this file) -- no separate
    // re-render calls needed here.
    loadManufacturingOrders();
};

/* ==========================================================================
   COMPLETION -- runs on EVERY time advancement (js/ui.js
   processTimeAdvancement), not just daily ticks, mirroring
   processSalvageGatherCompletion exactly (a build's duration can be
   sub-day). Queries the DB directly rather than the local cache, for the
   same reason battlefield_salvage does -- whichever client advances time
   should resolve every completed order regardless of that client's own
   cache freshness.
   ========================================================================== */

window.processManufacturingOrders = async function(newHours) {
    const { data, error } = await db.from('manufacturing_orders').select('*').eq('status', 'in_progress');
    if (error || !data || data.length === 0) return;
    let any = false;
    for (const order of data) {
        try {
            if (order.started_at_hours === null || order.duration_hours === null) continue;
            if (newHours < order.started_at_hours + order.duration_hours) continue;

            // Bug-hunt pass (2026-09-24): claim the order FIRST (delete it and
            // confirm we were the one who removed it), then deliver. Two
            // overlapping time ticks -- or two clients -- used to both see
            // the same finished order and BOTH deliver it before either
            // deleted it. If delivery then throws, the order row is put back
            // (catch block below) so it's retried next tick rather than lost.
            const { data: claimed, error: claimErr } = await db.from('manufacturing_orders').delete().eq('id', order.id).select();
            if (claimErr || !claimed || claimed.length === 0) continue; // already completed/cancelled elsewhere
            order._claimed = true;

            if (order.output_type === 'arsenal_weapon') {
                const { data: charRow } = await db.from('characters').select('id, profile_id, name').eq('id', order.character_id).maybeSingle();
                if (!charRow) continue; // crafting character no longer exists -- fizzle (order was already removed by the claim above)
                const p = order.output_payload || {};
                const { error: arsenalErr } = await db.from('character_arsenal').insert({
                    profile_id: charRow.profile_id, character_id: charRow.id,
                    name: p.name, dice: p.dice || '1d6', modifier: p.modifier || '+0',
                    explodes: p.explodes !== false, damage_type: p.damage_type || null,
                    ammo: p.ammo, max_ammo: p.max_ammo
                });
                if (arsenalErr) throw new Error('arsenal delivery failed: ' + arsenalErr.message);
                await db.from('chat_logs').insert({ sender_id: null, message_type: 'system', content: `✅ [MANUFACTURING] "${order.blueprint_name}" complete — ${p.name} added to ${charRow.name || 'the crafting character'}'s Arsenal.` });
            } else if (order.output_type === 'colony_infrastructure') {
                // Infrastructure (2026-09-14): "delivers" to the colony that
                // built it, not a vessel -- vessel_id is null on these
                // orders (see window.startColonyManufacturingOrder). Never
                // lowers the level -- if the colony already reached a higher
                // level some other way by the time this completes, this is
                // a no-op on the level itself (still consumes the order).
                const colony = (typeof coloniesList !== 'undefined') ? coloniesList.find(c => c.id === order.source_colony_id) : null;
                if (!colony) continue; // colony no longer exists -- fizzle (order was already removed by the claim above)
                const p = order.output_payload || {};
                const targetLevel = Math.max(1, parseInt(p.infrastructure_level) || 1);
                const newLevel = Math.max(colony.infrastructure_level || 1, targetLevel);
                const { error: infraErr } = await db.from('colonies').update({ infrastructure_level: newLevel }).eq('id', colony.id);
                if (infraErr) throw new Error('infrastructure delivery failed: ' + infraErr.message);
                colony.infrastructure_level = newLevel;
                await db.from('chat_logs').insert({ sender_id: null, message_type: 'system', content: `✅ [MANUFACTURING] "${order.blueprint_name}" complete — ${colony.name}'s Infrastructure reached Level ${newLevel}.` });
                if (typeof window.renderColoniesPanel === 'function') window.renderColoniesPanel();
            } else {
                const vessel = globalShipMarkersCache.find(m => m.id === order.vessel_id);
                if (!vessel) continue; // target vessel no longer exists -- fizzle (order was already removed by the claim above)
                const p = order.output_payload || {};
                let cargo = window.sanitizeCargo(vessel.cargo_inventory);
                // Deliver into whichever bucket the blueprint's output picked
                // (see the CARGO CATEGORY header comment) -- an older order
                // snapshotted before this field existed has no cargo_bucket
                // at all, so falls back to expendables, its historical
                // behavior.
                const bucket = MANUFACTURING_CARGO_BUCKETS.includes(p.cargo_bucket) ? p.cargo_bucket : 'expendables';
                let existing = (cargo[bucket] || []).find(i => (i.name || '').toLowerCase() === (p.name || '').toLowerCase());
                if (existing) existing.qty += (p.qty || 0);
                else cargo[bucket].push({ name: p.name, qty: p.qty || 0, unit: p.unit || 'Units' });
                const { error: cargoErr } = await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vessel.id);
                if (cargoErr) throw new Error('cargo delivery failed: ' + cargoErr.message);
                vessel.cargo_inventory = cargo;
                const bucketLabel = bucket === 'perishables' ? 'perishables' : (bucket === 'misc' ? 'misc cargo' : 'expendables');
                await db.from('chat_logs').insert({ sender_id: null, message_type: 'system', content: `✅ [MANUFACTURING] "${order.blueprint_name}" complete — ${p.qty || 0}x ${p.name} delivered to ${vessel.name}'s ${bucketLabel} hold.` });
            }

            // Completed orders are deleted, not kept -- same convention as
            // battlefield_salvage (the chat log above is the audit trail,
            // avoiding unbounded table growth). The delete itself now happens
            // up front as the "claim" (see top of this loop).
            any = true;
        } catch (err) {
            console.error(`processManufacturingOrders: failed for order ${order.id} ("${order.blueprint_name}")`, err);
            if (order._claimed) {
                const { _claimed, ...originalRow } = order;
                const { error: restoreErr } = await db.from('manufacturing_orders').insert(originalRow);
                if (restoreErr) console.error('processManufacturingOrders: could not restore the order row after a failed delivery', restoreErr, originalRow);
            }
        }
    }
    if (any) {
        loadManufacturingOrders();
        if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
    }
};

/* Manufacturing moved from a floating draggable panel to its own Command
   Terminal tab (term-panel-manufacturing) this session -- no more
   makePanelDraggable registration needed here; the tab shows/hides via
   switchTermTab like every other tab, not a drag-positioned overlay. */
