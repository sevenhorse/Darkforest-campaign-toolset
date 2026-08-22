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

   Shape: a DM-authored catalog (manufacturing_blueprints -- same
   DM-only-CRUD/everyone-can-see convention as the Hazard Designer, no
   draft/approval workflow) of buildable items, each costing a resource
   list + a time cost. A player starts a build order from EITHER:
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

function canManageBlueprint() {
    // DM-only, no per-owner permission complexity -- same exception the
    // Hazard Designer already established (a catalog with no per-owner
    // concept, unlike Ship Templates/Perks/Colonies/Fleets).
    return currentUserRole === 'dm';
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
    return (manufacturingBlueprintsList || []).find(b => b.output_type === 'cargo_item' && ((b.output_payload && b.output_payload.name) || '').toLowerCase() === lower);
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
   PANEL: DM blueprint catalog + a live "in-progress builds" list, everyone
   can see both (same visibility split as Battlefield Salvage's own panel --
   the catalog/order data itself isn't secret, only editing the catalog is
   DM-gated).
   ========================================================================== */

window.toggleManufacturingPanel = function() {
    const panel = document.getElementById('manufacturing-panel');
    if (!panel) return;
    const opening = panel.style.display !== 'block';
    panel.style.display = opening ? 'block' : 'none';
    if (opening) { loadManufacturingBlueprints(); loadManufacturingOrders(); }
};

function describeBlueprintOutput(bp) {
    const p = bp.output_payload || {};
    if (bp.output_type === 'arsenal_weapon') {
        return `🔫 ${p.name || 'Unnamed Weapon'} (${p.dice || '1d6'}${p.modifier || '+0'}${p.damage_type ? ', ' + p.damage_type : ''}) → crafting character's Arsenal`;
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
    const addBtnWrap = document.getElementById('manufacturing-add-blueprint-wrap');
    if (addBtnWrap) addBtnWrap.style.display = canManageBlueprint() ? 'block' : 'none';

    if (bpContainer) {
        let html = '';
        if (manufacturingBlueprintsList.length === 0) html = '<span style="font-size:10px; color:#6b826a;">No manufacturing blueprints defined yet.</span>';
        manufacturingBlueprintsList.forEach(bp => {
            const editable = canManageBlueprint();
            const tier = computeBlueprintTier(bp);
            const tierWarn = (tier !== Infinity && tier > MANUFACTURING_TIER_CAP) ? ' <span style="color:#ff9b6b;">(exceeds 5-layer guideline)</span>' : '';
            const tierColor = tier === Infinity ? '#ff6b6b' : '#6b826a';
            html += `
            <div class="note-card">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#c9962f; font-size:12px;">${bp.name}</strong>
                        <span style="font-size:8px; color:${tierColor}; margin-left:6px;">${formatBlueprintTier(tier)}${tierWarn}</span>
                        <p style="margin:2px 0 0 0; font-size:10px; color:#d4c5a9;">${bp.description || ''}</p>
                        <p style="margin:4px 0 0 0; font-size:9px; color:#6b826a;">Cost: ${describeBlueprintCost(bp)} &nbsp;·&nbsp; Time: ${bp.time_cost_hours}h</p>
                        <p style="margin:2px 0 0 0; font-size:9px; color:#6b826a;">${describeBlueprintOutput(bp)}</p>
                    </div>
                    ${editable ? `<div style="display:flex; gap:4px; flex:0 0 auto;">
                        <button class="layer-edit" onclick="window.openEditBlueprintModal('${bp.id}')" style="padding:3px 7px; font-size:9px;">✎</button>
                        <button class="layer-del" onclick="window.deleteManufacturingBlueprint('${bp.id}')" style="padding:3px 7px; font-size:9px;">✕</button>
                    </div>` : ''}
                </div>
            </div>`;
        });
        bpContainer.innerHTML = html;
    }

    if (ordContainer) {
        let html = '';
        const orders = window.globalManufacturingOrdersCache || [];
        if (orders.length === 0) html = '<span style="font-size:10px; color:#6b826a;">No builds currently in progress.</span>';
        orders.forEach(o => {
            const readyAt = (o.started_at_hours || 0) + (o.duration_hours || 0);
            const remaining = Math.max(0, readyAt - (window.universeTimeHours || 0));
            const sourceLabel = o.source_type === 'colony' ? '🏛 Colony' : '🚀 Vessel';
            const vessel = (typeof globalShipMarkersCache !== 'undefined') ? globalShipMarkersCache.find(m => m.id === o.vessel_id) : null;
            html += `
            <div class="note-card">
                <strong style="color:#c9962f; font-size:11px;">${o.blueprint_name || 'Unknown Blueprint'}</strong>
                <p style="margin:2px 0 0 0; font-size:9px; color:#6b826a;">${sourceLabel}${vessel ? ` → ${vessel.name}` : ''}${o.discount_pct ? ` &nbsp;·&nbsp; ${o.discount_pct}% discount applied` : ''}</p>
                <p style="margin:2px 0 0 0; font-size:9px; color:#d4c5a9;">Ready in ~${remaining.toFixed(1)}h</p>
            </div>`;
        });
        ordContainer.innerHTML = html;
    }
};

/* Rendered by js/colonies.js's renderColoniesPanel, inside each editable
   colony's card -- colonies have no deck concept (unlike vessels, no hard
   gate here) and no cargo of their own, so this reuses that same card's
   existing colony-deliver-vessel-<id> select as the Manufacturing order's
   delivery target instead of drawing a second picker. */
window.renderColonyManufacturingBox = function(colony) {
    const blueprints = manufacturingBlueprintsList || [];
    const bpOptions = blueprints.length
        ? blueprints.map(bp => `<option value="${bp.id}">${bp.name}</option>`).join('')
        : '<option value="">No blueprints defined yet</option>';
    const inProgress = (window.globalManufacturingOrdersCache || []).filter(o => o.source_type === 'colony' && o.source_colony_id === colony.id);
    let progressHtml = '';
    inProgress.forEach(o => {
        const remaining = Math.max(0, (o.started_at_hours || 0) + (o.duration_hours || 0) - (window.universeTimeHours || 0));
        progressHtml += `<p style="margin:2px 0 0 0; font-size:8px; color:#6b826a;">⏳ Building "${o.blueprint_name}" — ready in ~${remaining.toFixed(1)}h</p>`;
    });
    return `
    <div style="background:#030403; padding:8px; border:1px solid #c9962f; border-radius:2px; margin-top:6px;">
        <label style="font-size: 9px; color: #c9962f;">🏭 Manufacturing (time cost only — colonies have no cargo to draw materials from):</label>
        <div style="display:flex; gap:6px; margin-top:4px;">
            <label for="mfg-colony-blueprint-${colony.id}" style="display:none;">Blueprint</label>
            <select id="mfg-colony-blueprint-${colony.id}" style="flex:1; margin:0; font-size:9px; padding:3px; border-color:#c9962f;">${bpOptions}</select>
            <button class="btn-deploy" onclick="window.startColonyManufacturingOrder('${colony.id}')" style="flex:0 0 auto; font-size:9px; padding:4px 8px; margin:0;">BUILD</button>
        </div>
        <p style="font-size:8px; color:#6b826a; margin:4px 0 0 0;">Delivers to whichever vessel is selected in the dropdown above.</p>
        ${progressHtml}
    </div>`;
};

window.deleteManufacturingBlueprint = async function(id) {
    if (!canManageBlueprint()) return;
    const bp = manufacturingBlueprintsList.find(b => b.id === id);
    if (!(await window.showConfirmModal(`Delete blueprint "${bp ? bp.name : ''}"? Any order currently in progress from it is unaffected (it already has its own snapshot).`))) return;
    await db.from('manufacturing_blueprints').delete().eq('id', id);
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
        return (manufacturingBlueprintsList || []).filter(b => b.output_type === 'cargo_item' && b.id !== excludeId);
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
        const qty = Math.max(1, parseInt(document.getElementById('bp-cost-qty').value) || 0);
        const unit = document.getElementById('bp-cost-unit').value.trim() || 'Units';
        if (!name || qty <= 0) { alert('Select an input and enter a positive quantity.'); return; }
        workingCosts.push({ name, qty, unit });
        document.getElementById('bp-cost-qty').value = '';
        renderCostList();
    };

    function syncOutputFields() {
        const type = document.getElementById('bp-output-type').value;
        document.getElementById('bp-output-cargo-fields').style.display = type === 'cargo_item' ? 'block' : 'none';
        document.getElementById('bp-output-weapon-fields').style.display = type === 'arsenal_weapon' ? 'block' : 'none';
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
                const { error } = await db.from('manufacturing_blueprints').update(payload).eq('id', currentId);
                if (error) { alert('Failed to save blueprint: ' + error.message); return; }
            } else {
                payload.created_by = currentUserId;
                const { error } = await db.from('manufacturing_blueprints').insert(payload);
                if (error) { alert('Failed to create blueprint: ' + error.message); return; }
            }
            overlay.style.display = 'none';
            loadManufacturingBlueprints();
        });
    }

    window.openNewBlueprintModal = function() {
        if (!canManageBlueprint()) return;
        ensureModal();
        currentId = null;
        workingCosts = [];
        document.getElementById('bp-modal-title').innerText = 'New Manufacturing Blueprint';
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
        syncOutputFields();
        populateCostInputDropdown();
        renderCostList();
        overlay.style.display = 'flex';
    };

    window.openEditBlueprintModal = function(id) {
        if (!canManageBlueprint()) return;
        const bp = manufacturingBlueprintsList.find(b => b.id === id);
        if (!bp) return;
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

window.startVesselManufacturingOrder = async function(vesselId) {
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;
    if (!(currentUserRole === 'dm' || vessel.owner_id === currentUserId)) return;

    const mfgDeck = (vessel.ship_decks || []).find(d => d.type === 'manufacturing');
    if (!mfgDeck) { alert('This vessel has no Manufacturing-type deck installed -- building requires one.'); return; }

    const select = document.getElementById(`mfg-vessel-blueprint-${vesselId}`);
    const blueprintId = select ? select.value : null;
    if (!blueprintId) { alert('Select a blueprint to build first.'); return; }
    const bp = manufacturingBlueprintsList.find(b => b.id === blueprintId);
    if (!bp) return;

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
    const rawRequirements = (bp.resource_cost || []).map(c => ({
        name: c.name, unit: c.unit || 'Units',
        qty: discountPct ? Math.max(1, Math.round(c.qty * (1 - discountPct / 100))) : c.qty
    }));
    // Aggregate by name (case-insensitive) BEFORE checking sufficiency. A
    // blueprint can end up with more than one cost row naming the same
    // input (the multi-tier dropdown makes picking the same entry twice an
    // easy mistake, and nothing in the editor stops it) -- checking each
    // row independently against the SAME un-decremented cargo snapshot
    // would let a build pass the check even when the rows' combined total
    // exceeds what's actually in the hold, driving that cargo item
    // negative once every row's deduction lands. Summing up front closes
    // that gap; found during this session's pre-deploy bug hunt.
    const requirementsByName = new Map();
    rawRequirements.forEach(req => {
        const key = req.name.toLowerCase();
        const existing = requirementsByName.get(key);
        if (existing) existing.qty += req.qty;
        else requirementsByName.set(key, { ...req });
    });
    const requirements = Array.from(requirementsByName.values());
    for (const req of requirements) {
        const found = findCargoItemAcrossBuckets(cargo, req.name);
        if (!found || found.item.qty < req.qty) {
            alert(`Insufficient ${req.name}: need ${req.qty}, have ${found ? found.item.qty : 0}.`);
            return;
        }
    }
    requirements.forEach(req => {
        findCargoItemAcrossBuckets(cargo, req.name).item.qty -= req.qty;
    });

    await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
    vessel.cargo_inventory = cargo;
    if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();

    const durationHours = Math.max(0.1, (bp.time_cost_hours * (1 - discountPct / 100)) / deckScale);
    const { error } = await db.from('manufacturing_orders').insert({
        blueprint_id: bp.id, blueprint_name: bp.name, output_type: bp.output_type, output_payload: bp.output_payload,
        source_type: 'vessel', vessel_id: vesselId, character_id: myProf.character.id, initiated_by: currentUserId,
        started_at_hours: window.universeTimeHours, duration_hours: durationHours, discount_pct: discountPct
    });
    if (error) { alert('Failed to start build: ' + error.message); return; }

    await db.from('chat_logs').insert({
        sender_id: null, message_type: 'system',
        content: `🏭 [MANUFACTURING] ${vessel.name} began building "${bp.name}"${discountPct ? ` (${discountPct}% discount applied)` : ''}${deckScale < 1 ? ` (Manufacturing deck at ${Math.round(deckScale * 100)}% — build slowed)` : ''} — ready in ${durationHours.toFixed(1)}h.`
    });
    loadManufacturingOrders();
};

/* --- STARTING AN ORDER -- colony path (no deck check, no resource
   deduction -- colonies have no cargo of their own; time cost only,
   discount still applies to time). Delivers to a picked vessel, reusing
   the same vessel-select the existing colony resource-delivery button
   already uses. --- */

window.startColonyManufacturingOrder = async function(colonyId) {
    const colony = coloniesList.find(c => c.id === colonyId);
    if (!colony) return;
    if (!(currentUserRole === 'dm' || colony.owner_id === currentUserId)) return;

    const bpSelect = document.getElementById(`mfg-colony-blueprint-${colonyId}`);
    const blueprintId = bpSelect ? bpSelect.value : null;
    if (!blueprintId) { alert('Select a blueprint to build first.'); return; }
    const bp = manufacturingBlueprintsList.find(b => b.id === blueprintId);
    if (!bp) return;

    const vesselSelect = document.getElementById(`colony-deliver-vessel-${colonyId}`);
    const vesselId = vesselSelect ? vesselSelect.value : null;
    if (!vesselId) { alert('Select a vessel to receive the finished build first (same dropdown used for resource deliveries).'); return; }
    const vessel = globalShipMarkersCache.find(m => m.id === vesselId);
    if (!vessel) return;

    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character || !myProf.character.id) { alert('Please save your Dossier & Stats once first before starting a build.'); return; }
    const discountPct = window.getManufacturingDiscountPct(myProf.perks);
    const durationHours = Math.max(0.1, bp.time_cost_hours * (1 - discountPct / 100));

    const { error } = await db.from('manufacturing_orders').insert({
        blueprint_id: bp.id, blueprint_name: bp.name, output_type: bp.output_type, output_payload: bp.output_payload,
        source_type: 'colony', vessel_id: vesselId, source_colony_id: colonyId, character_id: myProf.character.id, initiated_by: currentUserId,
        started_at_hours: window.universeTimeHours, duration_hours: durationHours, discount_pct: discountPct
    });
    if (error) { alert('Failed to start build: ' + error.message); return; }

    await db.from('chat_logs').insert({
        sender_id: null, message_type: 'system',
        content: `🏭 [MANUFACTURING] ${colony.name} began building "${bp.name}" for delivery to ${vessel.name}${discountPct ? ` (${discountPct}% discount applied)` : ''} — ready in ${durationHours.toFixed(1)}h. (Colony builds cost time only -- no material deduction.)`
    });
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

            if (order.output_type === 'arsenal_weapon') {
                const { data: charRow } = await db.from('characters').select('id, profile_id, name').eq('id', order.character_id).maybeSingle();
                if (!charRow) { await db.from('manufacturing_orders').delete().eq('id', order.id); continue; } // crafting character no longer exists -- fizzle rather than error
                const p = order.output_payload || {};
                await db.from('character_arsenal').insert({
                    profile_id: charRow.profile_id, character_id: charRow.id,
                    name: p.name, dice: p.dice || '1d6', modifier: p.modifier || '+0',
                    explodes: p.explodes !== false, damage_type: p.damage_type || null,
                    ammo: p.ammo, max_ammo: p.max_ammo
                });
                await db.from('chat_logs').insert({ sender_id: null, message_type: 'system', content: `✅ [MANUFACTURING] "${order.blueprint_name}" complete — ${p.name} added to ${charRow.name || 'the crafting character'}'s Arsenal.` });
            } else {
                const vessel = globalShipMarkersCache.find(m => m.id === order.vessel_id);
                if (!vessel) { await db.from('manufacturing_orders').delete().eq('id', order.id); continue; } // target vessel no longer exists -- fizzle rather than error
                const p = order.output_payload || {};
                let cargo = window.sanitizeCargo(vessel.cargo_inventory);
                // Deliver into whichever bucket the blueprint's output picked
                // (see the CARGO CATEGORY header comment) -- an older order
                // snapshotted before this field existed has no cargo_bucket
                // at all, so falls back to expendables, its historical
                // behavior.
                const bucket = MANUFACTURING_CARGO_BUCKETS.includes(p.cargo_bucket) ? p.cargo_bucket : 'expendables';
                let existing = (cargo[bucket] || []).find(i => i.name.toLowerCase() === (p.name || '').toLowerCase());
                if (existing) existing.qty += (p.qty || 0);
                else cargo[bucket].push({ name: p.name, qty: p.qty || 0, unit: p.unit || 'Units' });
                await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vessel.id);
                vessel.cargo_inventory = cargo;
                const bucketLabel = bucket === 'perishables' ? 'perishables' : (bucket === 'misc' ? 'misc cargo' : 'expendables');
                await db.from('chat_logs').insert({ sender_id: null, message_type: 'system', content: `✅ [MANUFACTURING] "${order.blueprint_name}" complete — ${p.qty || 0}x ${p.name} delivered to ${vessel.name}'s ${bucketLabel} hold.` });
            }

            // Completed orders are deleted, not kept -- same convention as
            // battlefield_salvage (the chat log above is the audit trail,
            // avoiding unbounded table growth).
            await db.from('manufacturing_orders').delete().eq('id', order.id);
            any = true;
        } catch (err) {
            console.error(`processManufacturingOrders: failed for order ${order.id} ("${order.blueprint_name}")`, err);
        }
    }
    if (any) {
        loadManufacturingOrders();
        if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
    }
};

/* Registers the manufacturing panel with the same draggable-.panel system
   every other floating panel uses. */
if (typeof makePanelDraggable === 'function') makePanelDraggable('manufacturing-panel', 'manufacturing-header', 'odyssey_manufacturing_pos');
