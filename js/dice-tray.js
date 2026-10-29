/* ==========================================================================
   js/dice-tray.js - Dice tray (2026-10-29)
   ==========================================================================
   A plain dice roller for "give me a straight roll" moments, no stats
   involved. DM decisions (2026-10-29): lives in chat (a 🎲 button next to
   SEND, in the Comms panel and the Battle Map comms dock); any quantity of
   d4/d6/d8/d10/d12/d20/d100 plus a bonus (e.g. 3d6+2); a roll can be public
   or private to the DM.

   - Rolls post as message_type 'roll' (they land in the DICE tab, like
     every other roll). Public: recipient_id null.
   - Private (player): one row per DM account, recipient_id = that DM, so
     only the roller and the DM(s) can read it (chat_logs RLS). Each copy
     carries the same roll_data.gid; the roller's feed shows one.
   - Private (DM): one row to the DM's own id, a hidden roll only the DM sees.
   - Dice use crypto.getRandomValues (unbiased), not Math.random.
   No feature switch: DM-requested, self-contained, nothing else changes. */
(function () {
const SIDES = [4, 6, 8, 10, 12, 20, 100];
const MAX_QTY = 50, MAX_BONUS = 999;
const T = window.__diceTray = window.__diceTray || { sides: 20, qty: 1, bonus: 0, priv: false, last: '' };
const esc = (v) => window.escapeHtml(v == null ? '' : String(v));
const isDm = () => typeof currentUserRole !== 'undefined' && currentUserRole === 'dm';

// One fair die: rejection sampling over 32-bit values.
function rollDie(sides) {
    const c = window.crypto || window.msCrypto;
    if (!c || !c.getRandomValues) return 1 + Math.floor(Math.random() * sides);
    const buf = new Uint32Array(1), limit = Math.floor(0x100000000 / sides) * sides;
    let x;
    do { c.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return 1 + (x % sides);
}
const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return isNaN(n) ? dflt : Math.max(lo, Math.min(hi, n)); };
window.diceNotation = function (qty, sides, bonus) { return `${qty}d${sides}${bonus > 0 ? '+' + bonus : (bonus < 0 ? bonus : '')}`; };
// Rolls qty dice of `sides` plus bonus. Returns { rolls, sum, total, notation, breakdown(html) }.
window.rollDiceExpr = function (qty, sides, bonus) {
    qty = clampInt(qty, 1, MAX_QTY, 1); sides = SIDES.includes(+sides) ? +sides : 20; bonus = clampInt(bonus, -MAX_BONUS, MAX_BONUS, 0);
    const rolls = Array.from({ length: qty }, () => rollDie(sides));
    const sum = rolls.reduce((a, b) => a + b, 0), total = sum + bonus;
    const mark = (r) => (sides >= 4 && (r === sides || r === 1)) ? `<strong>${r}</strong>` : String(r); // highs and ones stand out
    const breakdown = `${qty > 1 ? '[' + rolls.map(mark).join(', ') + ']' : mark(rolls[0])}${bonus ? (bonus > 0 ? ' + ' : ' − ') + Math.abs(bonus) : ''} = <strong>${total}</strong>`;
    return { rolls, sum, total, notation: window.diceNotation(qty, sides, bonus), breakdown };
};

// Posts a roll. Returns the result, or null if nothing was sent.
window.diceTrayRoll = async function () {
    if (typeof currentUserId === 'undefined' || !currentUserId) return null;
    const r = window.rollDiceExpr(T.qty, T.sides, T.bonus);
    const me = (allProfiles || []).find(p => p.id === currentUserId);
    const who = (me && me.username) || 'Commander';
    const gid = 'dt-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    let recipients = [null];
    if (T.priv) {
        recipients = isDm() ? [currentUserId] : (allProfiles || []).filter(p => p.role === 'dm').map(p => p.id);
        if (!recipients.length) { alert('No DM account found to send a private roll to.'); return null; }
    }
    const rows = recipients.map(rid => ({ sender_id: currentUserId, recipient_id: rid, message_type: 'roll',
        content: `Rolled [${who}] ${r.notation}${T.priv ? (isDm() ? ' (hidden)' : ' (private to DM)') : ''}: ${r.total}`,
        roll_data: { breakdown: r.breakdown, gid, dice: { qty: r.rolls.length, sides: +T.sides, bonus: T.bonus, rolls: r.rolls }, private: !!T.priv } }));
    const { data, error } = await db.from('chat_logs').insert(rows).select();
    if (error) { alert('Could not post the roll: ' + error.message); return null; }
    if (data && data[0]) window.appendLocalChatLog(data[0]); // the other DM copies are the same roll
    T.last = `${r.notation} → ${r.total}${r.rolls.length > 1 ? '  [' + r.rolls.join(', ') + ']' : ''}`;
    if (window.AudioEngine && window.AudioEngine.playClick) window.AudioEngine.playClick();
    renderTray();
    return r;
};

/* --- The tray (one popover, opened from either chat's 🎲 button) --- */
function renderTray() {
    const pop = document.getElementById('dice-tray'); if (!pop) return;
    const priv = isDm() ? 'Hidden roll (only you see it)' : 'Private (only the DM sees it)';
    pop.innerHTML = `
        <div class="dt-head"><span>DICE TRAY</span><button type="button" class="dt-x" aria-label="Close dice tray" onclick="window.closeDiceTray()">✕</button></div>
        <div class="dt-dice" role="group" aria-label="Die">${SIDES.map(s => `<button type="button" class="dt-die${+T.sides === s ? ' on' : ''}" aria-pressed="${+T.sides === s}" onclick="window.diceTraySet('sides', ${s})">d${s}</button>`).join('')}</div>
        <div class="dt-row">
            <label>HOW MANY<span class="dt-step"><button type="button" aria-label="One fewer die" onclick="window.diceTraySet('qty', ${T.qty - 1})">−</button><input type="number" id="dt-qty" min="1" max="${MAX_QTY}" value="${T.qty}" onchange="window.diceTraySet('qty', this.value)"><button type="button" aria-label="One more die" onclick="window.diceTraySet('qty', ${T.qty + 1})">+</button></span></label>
            <label>BONUS<span class="dt-step"><button type="button" aria-label="Bonus down" onclick="window.diceTraySet('bonus', ${T.bonus - 1})">−</button><input type="number" id="dt-bonus" min="${-MAX_BONUS}" max="${MAX_BONUS}" value="${T.bonus}" onchange="window.diceTraySet('bonus', this.value)"><button type="button" aria-label="Bonus up" onclick="window.diceTraySet('bonus', ${T.bonus + 1})">+</button></span></label>
        </div>
        <label class="dt-priv"><input type="checkbox" id="dt-priv" ${T.priv ? 'checked' : ''} onchange="window.diceTraySet('priv', this.checked)"> ${priv}</label>
        <button type="button" class="btn-reveal dt-roll" id="dt-roll" onclick="window.diceTrayRoll()">🎲 ROLL ${esc(window.diceNotation(T.qty, T.sides, T.bonus))}</button>
        ${T.last ? `<div class="dt-last" aria-live="polite">LAST: ${esc(T.last)}</div>` : ''}`;
}
window.diceTraySet = function (key, val) {
    if (key === 'sides') T.sides = SIDES.includes(+val) ? +val : 20;
    else if (key === 'qty') T.qty = clampInt(val, 1, MAX_QTY, 1);
    else if (key === 'bonus') T.bonus = clampInt(val, -MAX_BONUS, MAX_BONUS, 0);
    else if (key === 'priv') T.priv = !!val;
    renderTray();
};
window.openDiceTray = function (btn) {
    let pop = document.getElementById('dice-tray');
    if (!pop) { pop = document.createElement('div'); pop.id = 'dice-tray'; pop.className = 'dt-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Dice tray'); document.body.appendChild(pop); }
    if (pop.style.display === 'block' && pop.__btn === btn) { window.closeDiceTray(); return; }
    pop.__btn = btn;
    renderTray();
    pop.style.display = 'block';
    // Fixed, above the button (the chat panels scroll and clip); phones get it centred.
    const phone = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    if (phone || !btn) { pop.style.left = Math.max(8, (window.innerWidth - w) / 2) + 'px'; pop.style.top = Math.max(8, window.innerHeight - h - 16) + 'px'; }
    else {
        const r = btn.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
        pop.style.top = (r.top - h - 6 > 8 ? r.top - h - 6 : r.bottom + 6) + 'px';
    }
};
window.closeDiceTray = function () { const pop = document.getElementById('dice-tray'); if (pop) pop.style.display = 'none'; };
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { const pop = document.getElementById('dice-tray'); if (pop && pop.style.display === 'block') window.closeDiceTray(); } });
})();
