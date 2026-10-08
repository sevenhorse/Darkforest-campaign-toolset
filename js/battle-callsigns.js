/* ==========================================================================
   js/battle-callsigns.js - Auto-callsigns for same-named NPC ships in a battle.
   Classic script sharing the global scope: loads right after battle-map.js
   (see index.html for the order).
   ========================================================================== */
/* DM rule: when two or more NPC ships with the same name are in
   the same battle, each gets a callsign "<name> <NATO letter>-<number>":
   "Typhon Sub-Chaser Alpha-01", "...Bravo-02", ... "...Zulu-26", then
   "...Alpha-27". A lone copy keeps its plain name; the moment a second copy
   joins, the first becomes Alpha-01 and the newcomer Bravo-02. Numbers are
   never reused within a battle while a ship carrying that callsign still
   exists (a destroyed Bravo-02 stays Bravo-02; the next newcomer is
   Charlie-03, not a second Bravo).

   - Grouping is by base name (the name with any callsign suffix removed) --
     deployed ships don't record which template they came from.
   - Player-owned ships are never renamed (only ships whose owners are all
     DM accounts, or nobody). Strike craft are skipped (they have their own
     🛩️ token and squadron names).
   - The new name is written to the ship itself (ship_markers.name), so it
     shows everywhere (cards, targeting lists, galaxy map, chat), and the
     callsign is also stored on the battle token (callsign_base/index).
   - Ids are untouched; this is purely the label.
   - Runs in the browser that added the ships, right after they're saved.
   - Not part of the undo log: undoing a placement removes the ship but the
     remaining ships keep their callsigns. */
const NATO_ALPHABET = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima', 'Mike',
    'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'X-ray', 'Yankee', 'Zulu'];
const CALLSIGN_SUFFIX_RE = new RegExp(' (' + NATO_ALPHABET.join('|') + ')-(\\d{2,})$');
window.formatCallsign = function(base, index) {
    return `${base} ${NATO_ALPHABET[(index - 1) % NATO_ALPHABET.length]}-${String(index).padStart(2, '0')}`;
};
window.parseCallsign = function(name) {
    const m = String(name || '').match(CALLSIGN_SUFFIX_RE);
    if (!m) return { base: String(name || ''), index: null };
    return { base: String(name).slice(0, m.index), index: parseInt(m[2], 10) };
};
function isNpcVessel(v) {
    const ids = (typeof window.vesselOwnerIds === 'function') ? window.vesselOwnerIds(v) : (v.owner_ids || []);
    if (ids.length === 0) return true;
    const profs = (typeof allProfiles !== 'undefined' && Array.isArray(allProfiles)) ? allProfiles : [];
    return ids.every(id => {
        const p = profs.find(pr => pr.id === id);
        if (p) return p.role === 'dm';
        return currentUserRole === 'dm' && id === currentUserId; // profiles not loaded yet: the DM's own ships count as NPC
    });
}

let battleCallsignsInFlight = false, battleCallsignsAgain = false;
window.assignBattleCallsigns = async function() {
    if (battleCallsignsInFlight) { battleCallsignsAgain = true; return; }
    battleCallsignsInFlight = true;
    try {
        do {
            battleCallsignsAgain = false;
            await assignBattleCallsignsOnce();
        } while (battleCallsignsAgain);
    } finally { battleCallsignsInFlight = false; }
};
async function assignBattleCallsignsOnce() {
    const enc = window.globalBattleEncounterCache;
    if (!enc) return;
    const tokens = enc.tokens || [];
    const groups = {}; // base -> [{tok, vessel, parsed}]
    tokens.forEach(tok => {
        const v = globalShipMarkersCache.find(m => m.id === tok.ship_marker_id);
        if (!v || v.is_strike_craft || !isNpcVessel(v)) return;
        const parsed = window.parseCallsign(v.name);
        (groups[parsed.base] = groups[parsed.base] || []).push({ tok, vessel: v, parsed });
    });
    const tokenPatches = {};
    const renames = [];
    Object.keys(groups).forEach(base => {
        const members = groups[base];
        if (members.length < 2) return; // a lone copy keeps its plain name
        // Highest number already used for this base anywhere we can see
        // (ships on the grid, plus any ship elsewhere still carrying one).
        let maxUsed = 0;
        members.forEach(m => { if (m.tok.callsign_base === base && m.tok.callsign_index) maxUsed = Math.max(maxUsed, m.tok.callsign_index); });
        globalShipMarkersCache.forEach(v => { const p = window.parseCallsign(v.name); if (p.base === base && p.index) maxUsed = Math.max(maxUsed, p.index); });
        members.forEach(m => {
            let idx = (m.tok.callsign_base === base && m.tok.callsign_index) ? m.tok.callsign_index : (m.parsed.index || null);
            if (!idx) { maxUsed += 1; idx = maxUsed; }
            const wantName = window.formatCallsign(base, idx);
            if (m.tok.callsign_base !== base || m.tok.callsign_index !== idx) tokenPatches[m.tok.token_id] = { callsign_base: base, callsign_index: idx };
            if (m.vessel.name !== wantName) renames.push({ vessel: m.vessel, name: wantName });
        });
    });
    if (Object.keys(tokenPatches).length === 0 && renames.length === 0) return;
    for (const r of renames) {
        const { error } = await db.from('ship_markers').update({ name: r.name }).eq('id', r.vessel.id);
        if (error) { console.error('callsigns: rename failed', r.name, error); continue; }
        r.vessel.name = r.name;
    }
    if (Object.keys(tokenPatches).length > 0) {
        const cur = window.globalBattleEncounterCache;
        if (cur && cur.id === enc.id) await saveBattleTokens((cur.tokens || []).map(t => tokenPatches[t.token_id] ? { ...t, ...tokenPatches[t.token_id] } : t));
    }
    if (typeof window.renderBattleMapPanel === 'function') window.renderBattleMapPanel();
}
