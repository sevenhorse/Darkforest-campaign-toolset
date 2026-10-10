/* ==========================================================================
   js/polish-v2.js - Polish restyle (UI restyle R6, switch 'polish_restyle')
   ==========================================================================
   DM picks (2026-10-10, canvas row 5): one form-controls kit (inputs,
   dropdowns, text boxes, tick boxes; buttons coloured by meaning: green =
   save / confirm, cyan = action, grey = cancel, red = delete, gold =
   manufacturing) on every restyled page; the app's popups in the new frame
   (wording and behaviour unchanged); telemetry for a scanned system and the
   jump plotter as fact tiles (map.js draws them when the switch is on).

   Almost all of it is CSS under body.px-on (style.css, "R6"). This file
   only sets that class and redraws the telemetry panel when the switch
   changes. Switch off = the class goes and telemetry redraws the old way.
   ========================================================================== */
(function () {
window.polishRestyleOn = function () { return typeof window.isFeatureOn === 'function' && window.isFeatureOn('polish_restyle'); };
function apply() {
    const on = window.polishRestyleOn();
    const was = document.body.classList.contains('px-on');
    document.body.classList.toggle('px-on', on);
    if (on !== was && typeof window.renderHUDTelemetry === 'function') { try { window.renderHUDTelemetry(); } catch (e) {} }
}
window.applyPolishRestyle = apply;
document.addEventListener('darkforest:features-changed', apply);
apply();
})();
