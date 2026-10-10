/* ==========================================================================
   js/manufacturing.js - Manufacturing Blueprints & Orders
   ==========================================================================
   A catalog (manufacturing_blueprints) of buildable items, each with a
   resource cost and a time cost. A build starts from:
     - a VESSEL: needs a Manufacturing-type deck (hard requirement). Costs
       come out of the vessel's cargo at once. A damaged deck slows the build.
     - a COLONY: no deck. Uses colony storage only with a Manufacturing
       Facility and enough stock, else time-only. Output goes to a picked vessel.
   Quartermaster/Master Engineer perks discount cost and time via
   perk_definitions.manufacturing_discount_pct (max across perks, not summed).
   Outputs: a cargo item (optional cargo_bucket, default 'expendables'; the
   rations check in js/ui.js reads perishables), an Arsenal weapon, or colony
   infrastructure. Orders snapshot the blueprint's name/output/cost at start,
   so editing or deleting a blueprint can't affect an order in flight.
   js/ui.js processTimeAdvancement calls processManufacturingOrders on every
   tick, since builds can be sub-day.
   ========================================================================== */

/* Production lines (DM rule): each Manufacturing-type deck on a vessel is one
   line (minimum 1). A colony has 1 line, 2 with a Manufacturing Facility at
   Infrastructure 3+. An order that finds every line busy is saved as 'queued'
   (resources are taken at queue time; cancel refunds them).
   processManufacturingOrders starts the oldest queued order when a line frees,
   back-to-back from the finishing order's end time. Orders already running
   are never stopped, even if the source now has fewer lines. */
/* Food (DM rule): counted in crew-days. A ship eats crew x days; crew is
   ship_markers.crew, blank = app_settings 'logistics_config' default_crew (100).
   Food in PERISHABLES is eaten in order: "Days"-unit rations (each feeds the
   whole ship for a day), then rations, then bulk food, then treats. An item
   can set its own food_crew_days per unit. Water isn't eaten. */
const FOOD_CREW_DAYS = { 'food ration': 1, 'food rations': 1, 'dehydrated nutrient blocks': 1000, 'mars bars': 0.1, 'payday candy bars': 0.1, 'butterfinger candy bars': 0.1 };
window.FOOD_CREW_DAYS = FOOD_CREW_DAYS;
window.defaultCrew = function () {
    try { const row = window.appSettingsCache && window.appSettingsCache.logistics_config; const v = row && row.value ? JSON.parse(row.value) : {}; const n = parseInt(v.default_crew, 10); return n > 0 ? n : 100; } catch (e) { return 100; }
};
window.vesselCrew = function (v) { const n = v && v.crew != null ? parseInt(v.crew, 10) : NaN; return n >= 0 ? n : window.defaultCrew(); };
// Crew-days one unit of this cargo item feeds; 'ship' for whole-ship-day items; 0 = not food.
window.foodValueOf = function (item) {
    if (!item) return 0;
    if (item.food_crew_days > 0) return Number(item.food_crew_days);
    const n = String(item.name || '').toLowerCase();
    if (/^days?$/i.test(String(item.unit || '').trim()) && /ration|food/.test(n)) return 'ship';
    if (FOOD_CREW_DAYS[n]) return FOOD_CREW_DAYS[n];
    return 0;
};
// Eats `days` days of food from cargo.perishables (mutates cargo).
// Returns { hadFood, changed, shortCrewDays, eaten: [{name, qty}] }.
window.consumeShipFood = function (vessel, cargo, days) {
    const crew = window.vesselCrew(vessel);
    const list = (cargo && cargo.perishables) || [];
    const foods = list.map(i => ({ i, v: window.foodValueOf(i) })).filter(f => f.v);
    const out = { hadFood: foods.length > 0, changed: false, shortCrewDays: 0, eaten: [] };
    if (!foods.length || crew <= 0 || days <= 0) return out;
    const rank = (f) => f.v === 'ship' ? 0 : f.v <= 0.5 ? 3 : f.v >= 100 ? 2 : 1;
    foods.sort((a, b) => rank(a) - rank(b));
    let need = crew * days;
    for (const f of foods) {
        if (need <= 1e-6) break;
        const qty = Number(f.i.qty) || 0;
        if (qty <= 0) continue;
        const per = f.v === 'ship' ? crew : f.v;
        const take = Math.min(qty, need / per);
        if (take <= 0) continue;
        f.i.qty = Math.round((qty - take) * 10000) / 10000;
        need -= take * per;
        out.changed = true;
        out.eaten.push({ name: f.i.name, qty: Math.round(take * 100) / 100 });
    }
    out.shortCrewDays = Math.max(0, Math.round(need));
    return out;
};
let manufacturingBlueprintsList = [];
window.globalManufacturingOrdersCache = [];
// Production lines for an order's source (vessel or colony).
window.manufacturingLinesFor = function (sourceType, id) {
    if (sourceType === 'colony') {
        const c = (typeof coloniesList !== 'undefined' ? coloniesList : []).find(x => x.id === id);
        return c && c.has_manufacturing_facility && (c.infrastructure_level || 1) >= 3 ? 2 : 1;
    }
    const v = (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).find(m => m.id === id);
    const n = v ? (v.ship_decks || []).filter(d => d.type === 'manufacturing').length : 0;
    return Math.max(1, n);
};
const orderSourceKey = (o) => o.source_type === 'colony' ? 'colony:' + o.source_colony_id : 'vessel:' + o.vessel_id;
function sourceOrders(sourceType, id, list) {
    return (list || window.globalManufacturingOrdersCache || []).filter(o => o.source_type === sourceType && (sourceType === 'colony' ? o.source_colony_id === id : o.vessel_id === id));
}
// Busy lines / total lines / queued count for one source, from the local cache.
window.manufacturingLineUsage = function (sourceType, id) {
    const mine = sourceOrders(sourceType, id);
    return { busy: mine.filter(o => o.status !== 'queued').length, lines: window.manufacturingLinesFor(sourceType, id), queued: mine.filter(o => o.status === 'queued').length };
};
// One line of status text for an order card.
window.manufacturingOrderStatus = function (o) {
    if (o.status === 'queued') {
        const q = sourceOrders(o.source_type, o.source_type === 'colony' ? o.source_colony_id : o.vessel_id).filter(x => x.status === 'queued');
        const pos = q.findIndex(x => x.id === o.id) + 1;
        return `🕒 Queued #${pos || '?'} — takes ${(o.duration_hours || 0).toFixed(1)}h once a line frees up`;
    }
    const remaining = Math.max(0, (o.started_at_hours || 0) + (o.duration_hours || 0) - (window.universeTimeHours || 0));
    return `⏳ Building — ready in ~${remaining.toFixed(1)}h`;
};
// Should a new order for this source queue? (true when every line is busy)
async function sourceIsFull(sourceType, id) {
    const col = sourceType === 'colony' ? 'source_colony_id' : 'vessel_id';
    const { data } = await db.from('manufacturing_orders').select('id,status,source_type,vessel_id,source_colony_id').eq(col, id).eq('source_type', sourceType);
    const rows = (data || []).filter(o => o.status === 'in_progress' || o.status === 'queued');
    const busy = rows.filter(o => o.status === 'in_progress').length;
    return busy >= window.manufacturingLinesFor(sourceType, id) || rows.some(o => o.status === 'queued');
}
window.__mfgSourceIsFull = sourceIsFull;

/* Catalog tabs + search. Tabs group by output_type (no category field
   exists). Search matches name or description, case-insensitive. Local UI
   state only: not persisted or synced. */
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
    const { data } = await db.from('manufacturing_orders').select('*').in('status', ['in_progress', 'queued']).order('created_at', { ascending: true });
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
   APPROVAL WORKFLOW (mirrors js/perk-designer.js): anyone can propose a
   blueprint. A DM's goes straight to 'approved'; others start as 'draft'.
   A draft is not buildable and can't be another blueprint's input until a
   DM approves it. The status column defaults to 'approved'.
   Differences from perks: canManageBlueprint is also checked inside the
   edit/delete functions, and the sidebar badge shows "N pending" when
   proposals await review, otherwise the order count.
   ========================================================================== */

function canManageBlueprint(bp) {
    // DM always. A non-DM can edit/delete only their own still-pending draft.
    if (currentUserRole === 'dm') return true;
    return !!(bp && bp.status === 'draft' && bp.created_by === currentUserId);
}

// Non-stacking: the MAX manufacturing_discount_pct across the character's
// perks, not a sum (Master Engineer "does not stack" with Quartermaster).
window.getManufacturingDiscountPct = function(charPerksList) {
    let maxPct = 0;
    (charPerksList || []).forEach(cp => {
        const def = (typeof window.findPerkDefinition === 'function') ? window.findPerkDefinition(cp.perk_definition_id) : null;
        if (def && (def.manufacturing_discount_pct || 0) > maxPct) maxPct = def.manufacturing_discount_pct;
    });
    return maxPct;
};

/* ==========================================================================
   MULTI-TIER CRAFTING: tier is derived, never stored. Tier 1 = no resource
   cost (raw feedstock). Tier N = 1 + the deepest tier among its inputs.
   An input resolves by case-insensitive match of the cost-row name against
   an approved blueprint's cargo output name; an unresolved name is Tier 1.
   Cycles (A -> B -> ... -> A) are caught with a visiting set and reported as
   Infinity ("circular"). DM rule: the 5-layer cap is a soft editor warning,
   not enforced.
   ========================================================================== */

function findBlueprintByOutputName(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    // Approved blueprints only: a name that only matches a draft is treated
    // as unresolved (Tier 1).
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

// Tier preview for an unsaved cost list (the editor's workingCosts).
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

const MANUFACTURING_TIER_CAP = 5; // soft guideline only, never enforced

function formatBlueprintTier(tier) {
    if (tier === Infinity) return '⚠ circular';
    return `Tier ${tier}`;
}

/* ==========================================================================
   SCREEN: blueprint catalog + in-progress builds, in the Manufacturing
   Command Terminal tab (term-panel-manufacturing). Everyone sees both.
   Dashboard only: builds start from the vessel Manufacturing Bay box
   (js/combat.js) and the colony card, which have the cargo/deck/delivery
   context. Data loads at app startup (js/db.js).
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

/* Where an order is being built and whether this user may cancel it. Same
   rule as cancelManufacturingOrder: DM, or owner of the source vessel/colony
   (not a colony order's delivery vessel). Shared with js/fleet-v2.js. */
window.manufacturingOrderSource = function(o) {
    const vessel = (typeof globalShipMarkersCache !== 'undefined') ? globalShipMarkersCache.find(m => m.id === o.vessel_id) : null;
    let canCancel = currentUserRole === 'dm';
    if (o.source_type === 'colony') {
        const colony = (typeof coloniesList !== 'undefined') ? coloniesList.find(c => c.id === o.source_colony_id) : null;
        if (colony && colony.owner_id === currentUserId) canCancel = true;
        return { isColony: true, canCancel, label: `${colony ? colony.name : 'Colony'}${vessel ? ` → ${vessel.name}` : ''}` };
    }
    if (vessel && window.vesselHasOwner(vessel, currentUserId)) canCancel = true;
    return { isColony: false, canCancel, label: vessel ? vessel.name : 'Vessel' };
};

window.renderManufacturingPanel = function() {
    const bpContainer = document.getElementById('manufacturing-blueprints-container');
    const ordContainer = document.getElementById('manufacturing-orders-container');
    const tabsContainer = document.getElementById('manufacturing-tabs-container');

    // Tab counts use the full catalog (drafts included), not the search results.
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

    // The badge's pending count also uses the full catalog.
    let pendingCount = manufacturingBlueprintsList.filter(bp => bp.status === 'draft').length;
    if (bpContainer) {
        const byTab = activeManufacturingTab === 'all'
            ? manufacturingBlueprintsList
            : manufacturingBlueprintsList.filter(bp => bp.output_type === activeManufacturingTab);
        const q = manufacturingSearchQuery;
        const visible = q
            ? byTab.filter(bp => (bp.name || '').toLowerCase().includes(q) || (bp.description || '').toLowerCase().includes(q))
            : byTab;

    // Pending/Approved split of the tab/search-filtered list.
        const pending = visible.filter(bp => bp.status === 'draft');
        const approved = visible.filter(bp => bp.status !== 'draft');

        const renderCard = (bp) => {
            const editable = canManageBlueprint(bp);
            const tier = computeBlueprintTier(bp);
            const tierWarn = (tier !== Infinity && tier > MANUFACTURING_TIER_CAP) ? ' <span style="color:#ff9b6b;">(exceeds 5-layer guideline)</span>' : '';
            const tierColor = tier === Infinity ? '#ff6b6b' : '#6b826a';
            // DM rule: a colony needs Infrastructure Level >= this tier to build
            // it. colony_infrastructure blueprints are exempt.
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
            const src = window.manufacturingOrderSource(o);
            const canCancel = src.canCancel;
            const sourceLabel = `${src.isColony ? '🏛' : '🚀'} ${src.label}`;
            html += `
            <div class="note-card">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong style="color:#c9962f; font-size:11px;">${o.blueprint_name || 'Unknown Blueprint'}</strong>
                        <p style="margin:2px 0 0 0; font-size:9px; color:#6b826a;">${sourceLabel}${o.discount_pct ? ` &nbsp;·&nbsp; ${o.discount_pct}% discount applied` : ''}</p>
                        <p style="margin:2px 0 0 0; font-size:9px; color:${o.status === 'queued' ? '#8fa7b0' : '#d4c5a9'};">${window.manufacturingOrderStatus(o)}</p>
                    </div>
                    ${canCancel ? `<button class="layer-del" onclick="window.cancelManufacturingOrder('${o.id}')" style="flex:0 0 auto; padding:3px 7px; font-size:9px;" title="Cancel this build and refund any deducted resources">✕ CANCEL</button>` : ''}
                </div>
            </div>`;
        });
        ordContainer.innerHTML = html;
    }

    // Badge: "N pending" when proposals await review, else the order count.
    const badge = document.getElementById('badge-manufacturing');
    if (badge) badge.innerText = pendingCount > 0 ? `${pendingCount} pending` : (window.globalManufacturingOrdersCache || []).length;
};

/* Rendered by js/colonies.js's renderColoniesPanel inside each editable
   colony's card. Finished output (except Infrastructure) goes to the vessel
   picked in that card's colony-deliver-vessel-<id> select. With a
   Manufacturing Facility, materials come from colony storage when available
   (see startColonyManufacturingOrder). */
window.renderColonyManufacturingBox = function(colony) {
    // Approved blueprints only; drafts aren't buildable.
    const blueprints = (manufacturingBlueprintsList || []).filter(b => b.status !== 'draft');
    const inProgress = (window.globalManufacturingOrdersCache || []).filter(o => o.source_type === 'colony' && o.source_colony_id === colony.id);
    let progressHtml = '';
    inProgress.forEach(o => {
        const remaining = Math.max(0, (o.started_at_hours || 0) + (o.duration_hours || 0) - (window.universeTimeHours || 0));
        // This box only renders for DM/owner, so cancel is offered here.
        // Cancel refunds a colony order's snapshot into colony storage.
        progressHtml += `<div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;"><p style="margin:0; font-size:8px; color:#6b826a;">"${o.blueprint_name}" — ${window.manufacturingOrderStatus(o).replace(/^\S+ /, '')}</p><button class="layer-del" onclick="window.cancelManufacturingOrder('${o.id}')" style="flex:0 0 auto; padding:1px 5px; font-size:8px; margin-left:6px;" title="Cancel this build">✕</button></div>`;
    });
    if (inProgress.length) { const u = window.manufacturingLineUsage('colony', colony.id); progressHtml = `<p style="margin:2px 0 0 0; font-size:8px; color:#8fa7b0;">Production lines: ${u.busy}/${u.lines} busy${u.queued ? ` · ${u.queued} queued` : ''}</p>` + progressHtml; }
    const facilityNote = colony.has_manufacturing_facility
        ? '🏭 Manufacturing Facility installed — draws materials from colony storage when available, falls back to time-only otherwise:'
        : '🏭 Manufacturing (time cost only — no Facility installed, see colony edit to add one):';
    // One button opens the build popup (openColonyBuildModal), which shows
    // details and a live afford-check per blueprint.
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

    // Cost-input options come live from the catalog: every approved blueprint
    // with a cargo-item output (matches findBlueprintByOutputName), so a new
    // input is just a new blueprint. The blueprint being edited is excluded to
    // block direct self-reference; longer cycles show as a tier warning.
    // Existing cost rows are plain {name,qty,unit} and keep working if the
    // referenced blueprint is renamed or deleted.
    function getKnownManufacturableBlueprints(excludeId) {
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

            <label style="font-size:9px; color:#6b826a; margin-top:8px; display:block;">Resource Cost (paid from the ship's cargo, or from colony storage for colony builds). Pick from any existing blueprint's output, grouped by tier below -- Tier 1 is a raw feedstock, Tier 2+ is itself something manufactured. To add a brand-new base feedstock, save a separate time-only blueprint for it first, then it'll appear here.</label>
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
                <label for="bp-out-infra-level" style="font-size:8px; color:#6b826a; display:block;">Target Infrastructure Level -- completing this build raises the colony to this level (never lowers it if already higher). Colony builds only. A colony normally needs Infrastructure Level N to build a Tier N item; this blueprint is exempt from that gate, since it's how a colony reaches the level in the first place.</label>
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
                // Updates never change status: approved stays approved, a
                // draft stays draft until a DM approves it.
                const { error } = await db.from('manufacturing_blueprints').update(payload).eq('id', currentId);
                if (error) { alert('Failed to save blueprint: ' + error.message); return; }
            } else {
                payload.created_by = currentUserId;
                // DM-authored blueprints are approved at once; others start as drafts.
                payload.status = currentUserRole === 'dm' ? 'approved' : 'draft';
                const { error } = await db.from('manufacturing_blueprints').insert(payload);
                if (error) { alert('Failed to create blueprint: ' + error.message); return; }
            }
            overlay.style.display = 'none';
            loadManufacturingBlueprints();
        });
    }

    window.openNewBlueprintModal = function() {
        // No permission gate: anyone can propose. Status is set on save.
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
        // Checked here too, not just by hiding the edit button.
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
   STARTING AN ORDER -- vessel path. Needs a Manufacturing-type deck. The
   perk discount applies to resource cost and time. Resources are deducted
   from the vessel's cargo immediately.
   ========================================================================== */

const MANUFACTURING_CARGO_BUCKETS = ['expendables', 'perishables', 'misc'];

// Outputs can land in any cargo bucket, so inputs are searched in all three.
// Returns {item, bucket} for the first case-insensitive name match (buckets
// checked in fixed order), or null.
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
    if (!(currentUserRole === 'dm' || window.vesselHasOwner(vessel, currentUserId))) { alert("Only this vessel's owners (or the DM) can start a build here."); return; }

    const mfgDeck = (vessel.ship_decks || []).find(d => d.type === 'manufacturing');
    if (!mfgDeck) { alert('This vessel has no Manufacturing-type deck installed -- building requires one.'); return; }

    // blueprintId comes from the build popup (openVesselBuildModal).
    if (!blueprintId) { alert('Select a blueprint to build first.'); return; }
    const bp = manufacturingBlueprintsList.find(b => b.id === blueprintId);
    if (!bp) return;
    // Infrastructure raises a colony's level, so vessels can't build it.
    // The build popup already filters these out; this is a backstop.
    if (bp.output_type === 'colony_infrastructure') { alert('Infrastructure blueprints can only be built at a colony.'); return; }

    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character || !myProf.character.id) { alert('Please save your Dossier & Stats once first before starting a build.'); return; }
    const discountPct = window.getManufacturingDiscountPct(myProf.perks);

    // A damaged Manufacturing deck lengthens build time (divided by hp/max_hp),
    // floored at 10% efficiency (at most 10x) so a 0-HP deck can still finish.
    // Applied after the perk discount.
    const deckScale = mfgDeck.max_hp > 0 ? Math.max(0.1, mfgDeck.hp / mfgDeck.max_hp) : 1;

    // Check every requirement before deducting anything.
    let cargo = window.sanitizeCargo(vessel.cargo_inventory);
    // Sum cost rows by name (case-insensitive) first, so duplicate rows can't
    // each pass against the same un-decremented cargo. The discount and its
    // minimum of 1 apply once per summed total, so splitting a cost across
    // rows doesn't change the result.
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
    // Record what was taken (and from which bucket) as resource_cost_snapshot
    // so a cancel refunds exactly that.
    const deductedSnapshot = requirements.map(req => {
        const found = findCargoItemAcrossBuckets(cargo, req.name);
        found.item.qty -= req.qty;
        return { name: req.name, unit: req.unit, qty: req.qty, bucket: found.bucket };
    });

    await db.from('ship_markers').update({ cargo_inventory: cargo }).eq('id', vesselId);
    vessel.cargo_inventory = cargo;
    if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();

    const durationHours = Math.max(0.1, (bp.time_cost_hours * (1 - discountPct / 100)) / deckScale);
    const queued = await sourceIsFull('vessel', vesselId);
    const { error } = await db.from('manufacturing_orders').insert({
        blueprint_id: bp.id, blueprint_name: bp.name, output_type: bp.output_type, output_payload: bp.output_payload,
        source_type: 'vessel', vessel_id: vesselId, character_id: myProf.character.id, initiated_by: currentUserId,
        started_at_hours: queued ? null : window.universeTimeHours, duration_hours: durationHours, discount_pct: discountPct,
        resource_cost_snapshot: deductedSnapshot, status: queued ? 'queued' : 'in_progress'
    });
    if (error) { alert('Failed to start build: ' + error.message); return; }

    await db.from('chat_logs').insert({
        sender_id: null, message_type: 'system',
        content: queued
            ? `🏭 [MANUFACTURING] ${vessel.name} queued "${bp.name}" — every production line is busy; it starts automatically when one frees up (${durationHours.toFixed(1)}h build).`
            : `🏭 [MANUFACTURING] ${vessel.name} began building "${bp.name}"${discountPct ? ` (${discountPct}% discount applied)` : ''}${deckScale < 1 ? ` (Manufacturing deck at ${Math.round(deckScale * 100)}% — build slowed)` : ''} — ready in ${durationHours.toFixed(1)}h.`
    });
    loadManufacturingOrders();
};

/* --- STARTING AN ORDER -- colony path.
   With a Manufacturing Facility, runs the same sum-check-deduct sequence as
   the vessel path against colony storage. This is a soft attempt: no
   facility, no resource cost, or not enough stock means a time-only build,
   never a refusal. The chat log says which happened. No deck penalty.
   Output goes to the picked delivery vessel, except colony_infrastructure,
   which raises the colony's own level and needs no vessel.
   Infrastructure gate (DM rule, hard block): Level N is needed for a Tier N
   blueprint. colony_infrastructure blueprints are exempt, or a colony could
   never level up. --- */

window.startColonyManufacturingOrder = async function(colonyId, blueprintId) {
    const colony = coloniesList.find(c => c.id === colonyId);
    if (!colony) return;
    if (!(currentUserRole === 'dm' || colony.owner_id === currentUserId)) return;

    // blueprintId comes from the build popup (openColonyBuildModal). The
    // delivery vessel select is on the colony card (shared with Storage pickup).
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
        if (typeof window.canAccessVesselDeck === 'function' && !window.canAccessVesselDeck(vessel)) { alert("🔒 You don't have access to that delivery vessel."); return; } // same rule as Vessel/Cargo Deck
    }

    const myProf = allProfiles.find(p => p.id === currentUserId);
    if (!myProf || !myProf.character || !myProf.character.id) { alert('Please save your Dossier & Stats once first before starting a build.'); return; }
    const discountPct = window.getManufacturingDiscountPct(myProf.perks);
    const durationHours = Math.max(0.1, bp.time_cost_hours * (1 - discountPct / 100));

    let deductedSnapshot = null;
    let usedMaterials = false;
    if (colony.has_manufacturing_facility && (bp.resource_cost || []).length > 0) {
        let cargo = window.sanitizeColonyCargo(colony.cargo_inventory);
        // Same sum-by-name-then-discount sequence as the vessel path.
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
        // else: not enough in storage -- time-only, nothing deducted.
    }

    const queued = await sourceIsFull('colony', colonyId);
    const { error } = await db.from('manufacturing_orders').insert({
        blueprint_id: bp.id, blueprint_name: bp.name, output_type: bp.output_type, output_payload: bp.output_payload,
        source_type: 'colony', vessel_id: vesselId, source_colony_id: colonyId, character_id: myProf.character.id, initiated_by: currentUserId,
        started_at_hours: queued ? null : window.universeTimeHours, duration_hours: durationHours, discount_pct: discountPct,
        resource_cost_snapshot: deductedSnapshot, status: queued ? 'queued' : 'in_progress'
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
        content: queued
            ? `🏭 [MANUFACTURING] ${colony.name} queued "${bp.name}"${destinationNote} — its production line is busy; it starts automatically when it frees up (${durationHours.toFixed(1)}h build).${materialsNote}`
            : `🏭 [MANUFACTURING] ${colony.name} began building "${bp.name}"${destinationNote}${discountPct ? ` (${discountPct}% discount applied)` : ''} — ready in ${durationHours.toFixed(1)}h.${materialsNote}`
    });
    loadManufacturingOrders();
};

/* ==========================================================================
   BUILD PREVIEW + BUILD POPUP, used by the vessel Manufacturing Bay box
   (js/combat.js) and the colony box.
   computeManufacturingPreview(bp, opts) is DOM-independent (opts = {vessel}
   or {colony}).
   Known limitation: it duplicates the gating/discount/deck-scale logic of
   startVesselManufacturingOrder and startColonyManufacturingOrder instead of
   sharing code. Change all three together, or the preview will disagree with
   what BUILD actually does. */
function computeManufacturingPreview(bp, opts) {
    const myProf = (typeof allProfiles !== 'undefined' && typeof currentUserId !== 'undefined') ? allProfiles.find(p => p.id === currentUserId) : null;
    const discountPct = (myProf && typeof window.getManufacturingDiscountPct === 'function') ? window.getManufacturingDiscountPct(myProf.perks) : 0;
    const tier = computeBlueprintTier(bp);
    const isInfrastructure = bp.output_type === 'colony_infrastructure';
    const result = { tier, discountPct, isInfrastructure, blocking: [], notes: [], costRows: [], timeHours: null, needsVessel: false, canBuild: true };

    // Same sum-by-name-then-discount sequence as the start functions.
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

/* Build popup: one overlay (created once, closes on backdrop click) shared
   by vessel and colony contexts; buildModalContext tracks which. */
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

        // The delivery-vessel select is DOM state the preview core can't see,
        // so it's checked here and added to each row's blocking reasons.
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

    // BUILD button in the popup. Keeps the popup open and re-renders it so
    // the afford-checks update.
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
   CANCELLING AN ORDER -- refunds resource_cost_snapshot into the bucket each
   item came from (colony storage or vessel cargo). Allowed for the DM or the
   owner of the source vessel/colony (not a colony order's delivery vessel).
   A legacy vessel order with no snapshot is cancelled without refund rather
   than guessing from the current blueprint.
   ========================================================================== */

window.cancelManufacturingOrder = async function(orderId) {
    // Re-fetch: the order may have completed or been cancelled since render.
    const { data: order } = await db.from('manufacturing_orders').select('*').eq('id', orderId).maybeSingle();
    if (!order) { alert('This build order no longer exists -- it may have already completed or been cancelled.'); loadManufacturingOrders(); return; }

    let ownerOk = currentUserRole === 'dm';
    let sourceName = 'Unknown source';
    if (!ownerOk && order.source_type === 'colony') {
        const colony = (typeof coloniesList !== 'undefined') ? coloniesList.find(c => c.id === order.source_colony_id) : null;
        if (colony) { ownerOk = colony.owner_id === currentUserId; sourceName = colony.name; }
    } else if (!ownerOk && order.source_type === 'vessel') {
        const vessel = globalShipMarkersCache.find(m => m.id === order.vessel_id);
        if (vessel) { ownerOk = window.vesselHasOwner(vessel, currentUserId); sourceName = vessel.name; }
    } else if (order.source_type === 'colony') {
        sourceName = ((typeof coloniesList !== 'undefined') ? coloniesList.find(c => c.id === order.source_colony_id) : null)?.name || sourceName;
    } else {
        sourceName = (globalShipMarkersCache.find(m => m.id === order.vessel_id) || {}).name || sourceName;
    }
    if (!ownerOk) { alert('Only the DM or the build\'s own source vessel/colony owner can cancel it.'); return; }

    // "No snapshot record" (legacy order, no refund possible) differs from
    // "empty snapshot" (a normal time-only build). Colony orders have a
    // snapshot only when they drew materials from storage.
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

    // Delete instead of marking cancelled; the chat log is the audit trail.
    await db.from('manufacturing_orders').delete().eq('id', order.id);

    await db.from('chat_logs').insert({
        sender_id: null, message_type: 'system',
        content: `🚫 [MANUFACTURING] "${order.blueprint_name}" build at ${sourceName} was cancelled.${hasRefund ? ` Refunded: ${order.resource_cost_snapshot.map(r => `${r.qty}x ${r.name}`).join(', ')}.` : (order.source_type === 'vessel' ? ' No refund on record for this build.' : '')}`
    });
    // loadManufacturingOrders re-renders every manufacturing view.
    loadManufacturingOrders();
};

/* ==========================================================================
   COMPLETION -- runs on every time advancement (js/ui.js
   processTimeAdvancement), since builds can be sub-day. Reads the DB, not
   the local cache, so whichever client advances time resolves every order.
   ========================================================================== */

// Claims (deletes) one finished order and delivers it. Returns true when
// the order is done (delivered or fizzled), false when someone else had
// already claimed it. A failed delivery puts the row back for next tick.
async function completeManufacturingOrder(order) {
    const { data: claimed, error: claimErr } = await db.from('manufacturing_orders').delete().eq('id', order.id).select();
    if (claimErr || !claimed || claimed.length === 0) return false; // already completed/cancelled elsewhere
    try {
        if (order.output_type === 'arsenal_weapon') {
            const { data: charRow } = await db.from('characters').select('id, profile_id, name').eq('id', order.character_id).maybeSingle();
            if (!charRow) return true; // crafting character no longer exists -- fizzle (order was already removed by the claim above)
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
            // Raises the building colony's level (vessel_id is null on these
            // orders). Never lowers it; the order is consumed either way.
            const colony = (typeof coloniesList !== 'undefined') ? coloniesList.find(c => c.id === order.source_colony_id) : null;
            if (!colony) return true; // colony no longer exists -- fizzle (order was already removed by the claim above)
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
            if (!vessel) return true; // target vessel no longer exists -- fizzle (order was already removed by the claim above)
            const p = order.output_payload || {};
            let cargo = window.sanitizeCargo(vessel.cargo_inventory);
            // Deliver into the output's cargo_bucket; missing = expendables.
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
        return true;
    } catch (err) {
        console.error(`processManufacturingOrders: failed for order ${order.id} ("${order.blueprint_name}")`, err);
        const { error: restoreErr } = await db.from('manufacturing_orders').insert(order);
        if (restoreErr) console.error('processManufacturingOrders: could not restore the order row after a failed delivery', restoreErr, order);
        return false;
    }
}
// Starts a queued order on a free line at `atHours` (only if it's still queued).
async function startQueuedOrder(order, atHours) {
    const { data, error } = await db.from('manufacturing_orders').update({ status: 'in_progress', started_at_hours: atHours }).eq('id', order.id).eq('status', 'queued').select();
    if (error || !data || !data.length) return false;
    Object.assign(order, { status: 'in_progress', started_at_hours: atHours });
    try { await db.from('chat_logs').insert({ sender_id: null, message_type: 'system', content: `🏭 [MANUFACTURING] A production line freed up — "${order.blueprint_name}" started (${(order.duration_hours || 0).toFixed(1)}h).` }); } catch (e) {}
    return true;
}
// Runs every source's lines forward to `newHours`: finishes due orders in
// end-time order and starts the next queued order on each freed line from
// the moment it freed, so one long time jump can run a whole queue.
window.processManufacturingOrders = async function(newHours) {
    const { data, error } = await db.from('manufacturing_orders').select('*').in('status', ['in_progress', 'queued']).order('created_at', { ascending: true });
    if (error || !data || data.length === 0) return;
    const groups = new Map();
    data.forEach(o => { const k = orderSourceKey(o); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); });
    let any = false;
    for (const list of groups.values()) {
        const first = list[0];
        const lines = window.manufacturingLinesFor(first.source_type, first.source_type === 'colony' ? first.source_colony_id : first.vessel_id);
        const active = list.filter(o => o.status === 'in_progress' && o.started_at_hours !== null && o.duration_hours !== null);
        const queue = list.filter(o => o.status === 'queued');
        // A line already free (an order was cancelled, a deck was added): start now.
        while (queue.length && active.length < lines) {
            const q = queue.shift();
            if (await startQueuedOrder(q, newHours)) { active.push(q); any = true; }
        }
        for (let guard = 0; guard < 500; guard++) {
            active.sort((a, b) => (a.started_at_hours + a.duration_hours) - (b.started_at_hours + b.duration_hours));
            const next = active[0];
            if (!next) break;
            const end = next.started_at_hours + next.duration_hours;
            if (newHours < end) break;
            active.shift();
            if (await completeManufacturingOrder(next)) any = true;
            if (queue.length && active.length < lines) {
                const q = queue.shift();
                if (await startQueuedOrder(q, end)) active.push(q);
            }
        }
    }
    if (any) {
        loadManufacturingOrders();
        if (typeof window.renderTerminalCargoDeck === 'function') window.renderTerminalCargoDeck();
    }
};

// A cancel frees a line (or a queue slot): start whatever is waiting right away.
window.cancelManufacturingOrder = window.withAfterHooks('manufacturing-order-cancelled', window.cancelManufacturingOrder);
// The Manufacturing page restyle (js/fleet-v2.js) redraws on this.
window.renderManufacturingPanel = window.withAfterHooks('manufacturing-rendered', window.renderManufacturingPanel);
window.onHook('manufacturing-order-cancelled', 'start-queued', async () => {
    try { await window.processManufacturingOrders(window.universeTimeHours || 0); } catch (e) { console.error('manufacturing: queue refresh after cancel failed', e); }
});
