/* ==========================================================================
   js/action-points.js - Action Points for characters (2026-10-17)
   ==========================================================================
   DM decisions (2026-10-17):
   - Characters get their own Action Points in ground / deck fights.
     Base 2 per turn, plus every `personal_ap_bonus` on the character's
     perks and augments, plus `ap_bonus` on each weapon in their Arsenal.
   - TRACKED ONLY: pips show and count down, nothing is refused. The DM
     rules it at the table. (Ships keep their enforced AP, js/battle-turns.js.)
   - Weapons carry two fields: `ap_cost` (AP per attack, blank = 1) and
     `ap_bonus` (AP added to the pool while the weapon is in the Arsenal).
     A resolved ⚔ attack spends the cost from the attacker's tracker row.
   - The Initiative Tracker gets a turn pointer: START / NEXT TURN / STOP.
     The next combatant refills to their max when their turn starts; wrapping
     to the top of the order is a new round. Strike-craft rows are skipped
     (they take turns on the Battle Map). NEXT TURN is the DM's, or the
     player whose turn it is (server RPC df_combat_next_turn checks this,
     because players can only write their own tracker rows).
     NEXT TURN does not run ADVANCE COMBAT ROUND (the ship cooldown tick);
     that stays its own button so nothing ticks twice.
   - Perks and augments also carry `ship_ap_bonus`. Each ship
     (ship_markers.commander_profile_id) and each deployed squadron
     (ship_deployed[i].commander_profile_id) can name one Commander; that
     character's ship AP bonuses add to the vessel's AP in space battles.
     That part is data-driven (no Commander set = no change) so every
     browser computes the same AP whatever the switch says; the switch
     only hides the Commander pickers.
   - Behind app_settings 'personal_ap' (starts DM-only). Hidden fields use
     the `pap-field` class; body.pap-on shows them (style.css).
   ========================================================================== */
(function () {
    const BASE = 2;
    window.PERSONAL_AP_BASE = BASE;
    const on = () => typeof window.isFeatureOn === 'function' && window.isFeatureOn('personal_ap');
    window.personalApOn = on;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const profs = () => (typeof allProfiles !== 'undefined' ? allProfiles : []);
    const rows = () => (typeof combatantsList !== 'undefined' ? combatantsList : []);
    const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';
    const me = () => (typeof currentUserId !== 'undefined' ? currentUserId : null);
    const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

    /* ---------- bonuses ---------- */
    window.characterApBonus = function (prof) {
        const out = { personal: 0, ship: 0, sources: [], shipSources: [] };
        if (!prof) return out;
        const add = (def, label) => {
            if (!def || def.flavor_only) return;
            const p = int(def.personal_ap_bonus, 0), s = int(def.ship_ap_bonus, 0);
            if (p) { out.personal += p; out.sources.push(`${label} ${p > 0 ? '+' : ''}${p}`); }
            if (s) { out.ship += s; out.shipSources.push(`${label} ${s > 0 ? '+' : ''}${s}`); }
        };
        (prof.perks || []).forEach(cp => { const d = typeof window.findPerkDefinition === 'function' ? window.findPerkDefinition(cp.perk_definition_id) : null; add(d, d && d.name); });
        (prof.augments || []).forEach(ca => { const d = typeof window.findAugmentDefinition === 'function' ? window.findAugmentDefinition(ca.augment_definition_id) : null; add(d, d && d.name); });
        (prof.arsenal || []).forEach(w => { const b = int(w.ap_bonus, 0); if (b) { out.personal += b; out.sources.push(`${w.name} ${b > 0 ? '+' : ''}${b}`); } });
        return out;
    };
    window.weaponApCost = function (w) {
        if (!w || w.ap_cost === null || w.ap_cost === undefined || w.ap_cost === '') return 1;
        return Math.max(0, int(w.ap_cost, 1));
    };
    window.combatantProfile = function (row) {
        if (!row || row.is_strike_craft || row.is_npc !== false) return null;
        return profs().find(p => p.id === row.owner_id) || null;
    };
    window.personalApMax = function (row) {
        if (!row) return BASE;
        const prof = window.combatantProfile(row);
        return Math.max(0, BASE + (prof ? window.characterApBonus(prof).personal : 0) + int(row.ap_adj, 0));
    };
    const apCur = (row) => (row.ap_current === null || row.ap_current === undefined) ? window.personalApMax(row) : row.ap_current;
    window.personalApCurrent = apCur;

    /* Extra ship AP from the vessel's Commander (js/battle-turns.js adds it). */
    window.commanderShipApBonus = function (vessel, squadronRecord) {
        const pid = squadronRecord ? squadronRecord.commander_profile_id : (vessel && vessel.commander_profile_id);
        if (!pid) return 0;
        const prof = profs().find(p => p.id === pid);
        return prof ? Math.max(-10, window.characterApBonus(prof).ship) : 0;
    };
    window.commanderOptionsHtml = function (selectedId) {
        const list = profs().filter(p => p.character && p.character.id).slice().sort((a, b) => String((a.character && a.character.name) || a.username).localeCompare(String((b.character && b.character.name) || b.username)));
        return `<option value="">-- No commander --</option>` + list.map(p => {
            const b = window.characterApBonus(p).ship;
            return `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${esc((p.character && p.character.name) || p.username || 'Unnamed')}${b ? ` (ship AP ${b > 0 ? '+' : ''}${b})` : ''}</option>`;
        }).join('');
    };
    window.setSquadronCommander = async function (vesselId, sqIdx, profileId) {
        const vessel = (typeof globalShipMarkersCache !== 'undefined' ? globalShipMarkersCache : []).find(m => m.id === vesselId);
        const sq = vessel ? (vessel.ship_deployed || [])[sqIdx] : null;
        if (!sq) return;
        sq.commander_profile_id = profileId || null;
        const { error } = await db.from('ship_markers').update({ ship_deployed: vessel.ship_deployed }).eq('id', vessel.id);
        if (error) { alert('Could not save the commander: ' + error.message); return; }
        if (typeof window.renderVesselDeck === 'function') window.renderVesselDeck();
    };

    /* ---------- turn pointer ---------- */
    const order = () => rows().filter(c => !c.is_strike_craft);
    const current = () => order().find(c => c.is_turn) || null;
    window.canEndCombatTurn = function () {
        const cur = current();
        return isDm() || !!(cur && cur.owner_id === me());
    };
    async function announce(text) {
        try { await db.from('chat_logs').insert({ sender_id: null, content: text, message_type: 'system' }); } catch (e) { /* chat is a courtesy */ }
    }
    window.nextCombatTurn = async function () {
        const list = order();
        if (!list.length) { alert('Nobody is in the Initiative Tracker.'); return; }
        if (!window.canEndCombatTurn()) { alert("Only the DM or the combatant whose turn it is can end the turn."); return; }
        const cur = current();
        const idx = cur ? list.indexOf(cur) : -1;
        let round = cur ? (int(cur.turn_round, 1)) : 1;
        let next = list[idx + 1];
        if (!next) { next = list[0]; if (cur) round += 1; }
        const ap = window.personalApMax(next);
        const { error } = await db.rpc('df_combat_next_turn', { p_next: next.id, p_ap: ap, p_round: round });
        if (error) { alert('Could not advance the turn: ' + error.message); return; }
        await announce(`⏭️ [INITIATIVE] ${next.name}'s turn (${ap} AP), round ${round}.`);
        if (typeof loadCombatTracker === 'function') await loadCombatTracker();
    };
    window.stopCombatTurns = async function () {
        if (!isDm()) return;
        const { error } = await db.rpc('df_combat_stop_turns');
        if (error) { alert('Could not stop turns: ' + error.message); return; }
        await announce('⏹️ [INITIATIVE] Turn order stopped.');
        if (typeof loadCombatTracker === 'function') await loadCombatTracker();
    };
    const canEditRow = (row) => isDm() || row.owner_id === me();
    window.adjustCombatantAp = async function (id, delta) {
        const row = rows().find(c => c.id === id);
        if (!row || !canEditRow(row)) return;
        const next = Math.max(0, Math.min(99, apCur(row) + delta));
        const { error } = await db.from('combat_tracker').update({ ap_current: next }).eq('id', id);
        if (error) { alert('Could not change AP: ' + error.message); return; }
        row.ap_current = next;
        if (typeof window.renderCombatTracker === 'function') window.renderCombatTracker();
    };
    window.adjustCombatantApMax = async function (id, delta) {
        const row = rows().find(c => c.id === id);
        if (!row || !isDm()) return;
        const adj = Math.max(-20, Math.min(20, int(row.ap_adj, 0) + delta));
        const { error } = await db.from('combat_tracker').update({ ap_adj: adj }).eq('id', id);
        if (error) { alert('Could not change max AP: ' + error.message); return; }
        row.ap_adj = adj;
        if (typeof window.renderCombatTracker === 'function') window.renderCombatTracker();
    };

    /* Called by window.resolveArsenalAttack after a shot is fired. Returns a
       line for the attack card ('' when nothing was tracked). Never refuses. */
    window.spendPersonalAp = async function (wpn) {
        if (!on()) return '';
        const row = rows().find(c => c.owner_id === me() && c.is_npc === false && !c.is_strike_craft);
        if (!row) return '';
        const cost = window.weaponApCost(wpn);
        if (cost <= 0) return '';
        const max = window.personalApMax(row);
        const have = apCur(row);
        const left = Math.max(0, have - cost);
        const { error } = await db.from('combat_tracker').update({ ap_current: left }).eq('id', row.id);
        if (error) return '';
        row.ap_current = left;
        const notes = [];
        if (cost > have) notes.push('over budget');
        if (current() && !row.is_turn) notes.push('not their turn');
        return `<div style="margin-top:4px; font-size:10px; color:#c9962f;">AP −${cost} → ${left}/${max} left${notes.length ? ' · ' + notes.join(' · ') : ''}</div>`;
    };

    /* ---------- Initiative Tracker decoration ---------- */
    function pips(cur, max) {
        const shown = Math.max(cur, max);
        if (shown > 10) return `<b style="color:#00e5a3;">${cur}/${max}</b>`;
        return Array.from({ length: shown }, (_, i) => `<i class="pap-pip${i < cur ? '' : ' off'}${i >= max ? ' extra' : ''}"></i>`).join('');
    }
    function decorate() {
        document.querySelectorAll('.pap-bar, .pap-row').forEach(n => n.remove());
        document.querySelectorAll('.ct-row.pap-turn').forEach(n => n.classList.remove('pap-turn'));
        if (!on()) return;
        const cur = current();
        document.querySelectorAll('.ct-list').forEach(list => {
            let bar = `<div class="pap-bar">`;
            bar += cur ? `<span>ROUND <b>${int(cur.turn_round, 1)}</b> · <b style="color:#c9962f;">${esc(cur.name)}</b>'s turn</span>` : `<span>No turn order running.</span>`;
            if (cur && window.canEndCombatTurn()) bar += `<button class="pap-btn" onclick="window.nextCombatTurn()">⏭ NEXT TURN</button>`;
            if (!cur && isDm()) bar += `<button class="pap-btn" onclick="window.nextCombatTurn()">▶ START TURNS</button>`;
            if (cur && isDm()) bar += `<button class="pap-btn dim" onclick="window.stopCombatTurns()" title="Clear the turn pointer">■</button>`;
            bar += `</div>`;
            list.insertAdjacentHTML('beforebegin', bar);
            list.querySelectorAll('.ct-row[data-combatant-id]').forEach(el => {
                const row = rows().find(c => c.id === el.dataset.combatantId);
                if (!row || row.is_strike_craft) return;
                if (row.is_turn) el.classList.add('pap-turn');
                const max = window.personalApMax(row), c = apCur(row);
                const prof = window.combatantProfile(row);
                const tip = prof ? `Base ${BASE}` + (window.characterApBonus(prof).sources.length ? ' + ' + window.characterApBonus(prof).sources.join(', ') : '') + (int(row.ap_adj, 0) ? ` + DM ${int(row.ap_adj, 0)}` : '') : `Base ${BASE}` + (int(row.ap_adj, 0) ? ` + DM ${int(row.ap_adj, 0)}` : '');
                let html = `<div class="pap-row" title="${esc(tip)}"><span class="pap-lbl">AP</span><span class="pap-pips">${pips(c, max)}</span>`;
                if (canEditRow(row)) html += `<button class="pap-mini" onclick="window.adjustCombatantAp('${row.id}', -1)" aria-label="Spend 1 AP">−</button><button class="pap-mini" onclick="window.adjustCombatantAp('${row.id}', 1)" aria-label="Give back 1 AP">+</button>`;
                if (isDm()) html += `<span class="pap-max">MAX ${max}</span><button class="pap-mini" onclick="window.adjustCombatantApMax('${row.id}', -1)" aria-label="Lower max AP">−</button><button class="pap-mini" onclick="window.adjustCombatantApMax('${row.id}', 1)" aria-label="Raise max AP">+</button>`;
                html += `</div>`;
                const info = el.firstElementChild;
                if (info) info.insertAdjacentHTML('beforeend', html);
            });
        });
    }
    window.decoratePersonalAp = decorate;
    window.onHook('combat-tracker-rendered', 'action-points', decorate);

    function syncBody() {
        document.body.classList.toggle('pap-on', on());
        decorate();
        if (typeof window.renderArsenal === 'function') { try { window.renderArsenal(); } catch (e) { /* not ready yet */ } }
    }
    document.addEventListener('darkforest:features-changed', syncBody);
    if (document.body) syncBody(); else document.addEventListener('DOMContentLoaded', syncBody);
})();
