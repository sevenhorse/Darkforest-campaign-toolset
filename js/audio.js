/* ==========================================================================
   js/audio.js - Web Audio API Synthesizer + Music Beds
   ==========================================================================
   SFX are all pure oscillator synthesis (no sample files) -- unchanged
   approach from before this session's audio-polish pass, just more of them.

   Music (ambient + battle) is the one part of this file that is NOT
   synthesized: it plays real Battlestar Galactica soundtrack tracks (Bear
   McCreary) the DM supplied as local files in a "music tracks/" folder
   alongside this project -- see the block comment above MUSIC_DIR below
   for the full rationale, the personal-use note, and what changed from
   the earlier CC0/CC-BY OpenGameArt hotlinks this replaced.
   ========================================================================== */
window.AudioEngine = (function() {
    let audioCtx = null;

    function init() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    /* ----------------------------------------------------------------------
       MUSIC BEDS -- real Battlestar Galactica soundtrack (Bear McCreary),
       supplied by the DM as local files
       ----------------------------------------------------------------------
       Replaces the earlier CC0/CC-BY OpenGameArt hotlinks entirely (the DM
       found the OpenGameArt ambient pack's horror lean didn't fit BSG's
       tone, then supplied real soundtrack tracks directly as local files
       in a "music tracks/" folder alongside index.html/js/style.css --
       see the "Real soundtrack swap" checkpoint in
       darkforest-architecture-reference.md). Filenames below match the
       DM's own files exactly, numeric prefixes included.

       Ambient bed rotates through 6 tracks (shuffled, reshuffled on
       exhaustion): Pegasus, Dark Unions, Something Dark Is Coming, Worthy
       of Survival, Martial Law, Standing In the Mud.
       Battle bed rotates through 3 tracks the same way, auto-starting/
       stopping with battle_encounters.is_active (js/battle-map.js's
       loadBattleEncounters(), unchanged wiring from before): Prelude to
       War, Worthy of Survival, Scar. "Worthy of Survival" deliberately
       appears in BOTH rotations -- the DM's own choice, not a mistake.

       PERSONAL-USE NOTE (flagged plainly, not silently assumed): these
       are real, commercially-released, copyrighted recordings, not
       royalty-free assets like the tracks they replaced. Referencing
       local files the DM already owns, for their own private table, is
       one thing -- if this project is ever meant to be published,
       distributed, or run for a paying audience, these files would need
       to come out first. That's a real constraint on this project's
       future, not just a footnote.

       No hotlink risk anymore (files are local, not fetched from a
       third-party server) -- but the app now depends on this exact
       "music tracks/" folder shipping alongside index.html/js/style.css.
       If it's ever missing (fresh clone, moved files), a track fails
       silently the same way a broken hotlink used to (console.warn, no
       crash, that track just doesn't play).
    */
    const MUSIC_DIR = 'music tracks/';
    const AMBIENT_TRACKS = [
        '08 Pegasus.m4a',
        '15 Dark Unions.m4a',
        '10 Something Dark Is Coming.m4a',
        '21 Worthy of Survival.m4a',
        '06 Martial Law.m4a',
        '07 Standing In the Mud.m4a'
    ];
    const BATTLE_TRACKS = [
        '17 Prelude to War.m4a',
        '21 Worthy of Survival.m4a',
        '11 Scar.m4a'
    ];

    let musicVolume = (function() {
        const v = parseFloat(localStorage.getItem('odyssey_audio_volume'));
        return isNaN(v) ? 0.4 : Math.max(0, Math.min(1, v));
    })();
    let muted = localStorage.getItem('odyssey_audio_muted') === 'true';

    let ambientAudio = null;
    let battleAudio = null;
    let ambientDesired = false; // "should ambient be playing when nothing overrides it"
    let battleActive = false;

    function shuffleIndices(n) {
        const a = []; for (let i = 0; i < n; i++) a.push(i);
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
        }
        return a;
    }

    function effectiveVolume() { return muted ? 0 : musicVolume; }

    function applyLiveVolume() {
        const v = effectiveVolume();
        if (ambientAudio && !ambientAudio.paused) ambientAudio.volume = v;
        if (battleAudio && !battleAudio.paused) battleAudio.volume = v;
    }

    // Simple volume ramp over plain <audio> elements (no Web Audio graph
    // needed for these -- .volume is enough for a fade).
    function fadeTo(el, targetVol, durationMs, onDone) {
        if (!el) { if (onDone) onDone(); return; }
        if (el._fadeInterval) clearInterval(el._fadeInterval);
        const startVol = el.volume;
        const steps = Math.max(1, Math.round((durationMs || 1000) / 50));
        const stepVol = (targetVol - startVol) / steps;
        let i = 0;
        el._fadeInterval = setInterval(() => {
            i++;
            el.volume = Math.max(0, Math.min(1, startVol + stepVol * i));
            if (i >= steps) {
                clearInterval(el._fadeInterval); el._fadeInterval = null;
                el.volume = Math.max(0, Math.min(1, targetVol));
                if (onDone) onDone();
            }
        }, 50);
    }

    // Shared rotating-playlist factory -- ambient and battle both need
    // identical shuffle/reshuffle-on-exhaustion behavior now that BOTH are
    // multi-track playlists (battle wasn't, before this swap), so this is
    // one implementation instead of two that could drift apart.
    function makeRotatingPlaylist(filenames) {
        let order = shuffleIndices(filenames.length);
        let cursor = -1;
        return function next() {
            cursor++;
            if (cursor >= order.length) { order = shuffleIndices(filenames.length); cursor = 0; }
            return MUSIC_DIR + filenames[order[cursor]];
        };
    }
    const nextAmbientUrl = makeRotatingPlaylist(AMBIENT_TRACKS);
    const nextBattleUrl = makeRotatingPlaylist(BATTLE_TRACKS);

    // kind: 'ambient' | 'battle' -- plays the next track in that bed's own
    // rotation, fading it in. Used both for normal track-ended advancement
    // and for a manual skip (see skipTrack below).
    function playNextTrack(kind) {
        const isAmbient = kind === 'ambient';
        if (isAmbient) { if (!ambientDesired || battleActive) return; }
        else { if (!battleActive) return; }
        const rawUrl = isAmbient ? nextAmbientUrl() : nextBattleUrl();
        const el = new Audio(encodeURI(rawUrl)); // encodeURI handles the spaces in folder/file names
        el.volume = 0;
        el.addEventListener('ended', () => playNextTrack(kind));
        el.addEventListener('error', () => { console.warn('[AudioEngine] track failed to load (check the "music tracks" folder is present):', rawUrl); playNextTrack(kind); });
        if (isAmbient) ambientAudio = el; else battleAudio = el;
        el.play().catch(() => { /* blocked until a user gesture -- click-unlock listener below retries */ });
        fadeTo(el, effectiveVolume(), isAmbient ? 2000 : 1000);
    }

    function startAmbient() {
        ambientDesired = true;
        if (battleActive) return; // battle bed takes priority; resumes when it ends
        if (ambientAudio && !ambientAudio.paused) return;
        playNextTrack('ambient');
    }

    function stopAmbient(fadeMs) {
        ambientDesired = false;
        if (!ambientAudio) return;
        const el = ambientAudio;
        fadeTo(el, 0, fadeMs || 1200, () => { el.pause(); if (el === ambientAudio) ambientAudio = null; });
    }

    function startBattleMusic() {
        if (battleActive) return; // already running, don't restart from 0
        battleActive = true;
        if (ambientAudio && !ambientAudio.paused) { const a = ambientAudio; fadeTo(a, 0, 1200, () => a.pause()); }
        playNextTrack('battle');
    }

    function stopBattleMusic() {
        if (!battleActive) return;
        battleActive = false;
        if (battleAudio) { const el = battleAudio; fadeTo(el, 0, 1500, () => { el.pause(); el.currentTime = 0; }); }
        if (ambientDesired) playNextTrack('ambient'); // resumes on the NEXT track, not mid-song where it left off -- simplification, flagged here rather than silently done
    }

    // Manual "skip to next track" -- hard-stops whatever's currently
    // audible (no fade-out; a deliberate skip should feel instant, not
    // linger) and immediately fades in the next track of WHICHEVER bed is
    // currently active (battle takes priority, same as everywhere else).
    // No-ops if neither bed is supposed to be playing.
    function skipTrack() {
        if (battleActive) {
            if (battleAudio) { if (battleAudio._fadeInterval) clearInterval(battleAudio._fadeInterval); battleAudio.pause(); }
            playNextTrack('battle');
        } else if (ambientDesired) {
            if (ambientAudio) { if (ambientAudio._fadeInterval) clearInterval(ambientAudio._fadeInterval); ambientAudio.pause(); }
            playNextTrack('ambient');
        }
    }

    function setMusicVolume(v) {
        musicVolume = Math.max(0, Math.min(1, parseFloat(v)));
        localStorage.setItem('odyssey_audio_volume', musicVolume);
        applyLiveVolume();
    }
    function setMuted(b) {
        muted = !!b;
        localStorage.setItem('odyssey_audio_muted', muted ? 'true' : 'false');
        applyLiveVolume();
    }
    function toggleMute() { setMuted(!muted); syncControlsUI(); }

    function syncControlsUI() {
        const chk = document.getElementById('audio-mute-toggle');
        const sld = document.getElementById('audio-volume-slider');
        if (chk) chk.checked = muted;
        if (sld) sld.value = Math.round(musicVolume * 100);
    }
    document.addEventListener('DOMContentLoaded', syncControlsUI);

    // #audio-controls-dropdown lives inside #top-bar, which has
    // overflow-y:hidden (for the button row's horizontal-scroll safety net)
    // -- an absolutely-positioned dropdown there gets silently clipped to
    // invisible the moment it extends past the bar's own 50px height. Same
    // bug class as #search-results-dropdown / #hazard-system-search-dropdown
    // elsewhere in this app, and the same fix: switch to position:fixed
    // (escapes ancestor overflow-clipping since nothing here sets a
    // transform/filter) and compute the on-screen position from the
    // button's own getBoundingClientRect() each time it opens.
    window.toggleAudioControls = function() {
        const dd = document.getElementById('audio-controls-dropdown');
        const btn = document.getElementById('audio-controls-toggle-btn');
        if (!dd) return;
        const opening = dd.style.display !== 'block';
        if (opening && btn) {
            const rect = btn.getBoundingClientRect();
            dd.style.position = 'fixed';
            dd.style.top = (rect.bottom + 4) + 'px';
            dd.style.left = rect.left + 'px';
        }
        dd.style.display = opening ? 'block' : 'none';
    };
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('audio-controls-dropdown');
        const btn = document.getElementById('audio-controls-toggle-btn');
        if (!dd || dd.style.display !== 'block') return;
        if (e.target === btn || (btn && btn.contains(e.target)) || dd.contains(e.target)) return;
        dd.style.display = 'none';
    });

    // Browsers require a user interaction to unlock audio playback. This
    // both resumes the oscillator SFX context (original behavior, unchanged)
    // and kicks off the ambient bed for the first time (new).
    document.addEventListener('click', () => {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        if (!muted) startAmbient();
    }, { once: true });

    return {
        // --- Existing SFX (unchanged) ---
        // High-pitched sonar blip for tactical map pings
        playPing: function() {
            init();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, audioCtx.currentTime);
            gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.5);
        },

        // Heavy sci-fi thud/pew for weapon fire
        playShoot: function() {
            init();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(150, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime + 0.3);
            gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.3);
        },

        // Dissonant buzzer for errors (No ammo, insufficient fuel)
        playError: function() {
            init();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(150, audioCtx.currentTime);
            osc.frequency.setValueAtTime(100, audioCtx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
            gain.gain.setValueAtTime(0.1, audioCtx.currentTime + 0.2);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.3);
        },

        // Oscillating alarm for anomalies and Bingo Fuel
        playKlaxon: function() {
            init();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(400, audioCtx.currentTime);
            osc.frequency.linearRampToValueAtTime(600, audioCtx.currentTime + 0.4);
            osc.frequency.linearRampToValueAtTime(400, audioCtx.currentTime + 0.8);

            gain.gain.setValueAtTime(0, audioCtx.currentTime);
            gain.gain.linearRampToValueAtTime(0.1, audioCtx.currentTime + 0.1);
            gain.gain.linearRampToValueAtTime(0.1, audioCtx.currentTime + 0.7);
            gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.8);

            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.8);
        },

        // Low frequency accelerating rumble for FTL jumps
        playWarp: function() {
            init();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(50, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(800, audioCtx.currentTime + 1.5);
            gain.gain.setValueAtTime(0.01, audioCtx.currentTime);
            gain.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + 1.0);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1.5);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 1.5);
        },

        // --- New SFX (2026-08 audio polish) ---

        // Low mechanical clunk for docking/undocking a vessel to/from a master
        playDock: function() {
            init();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(120, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(45, audioCtx.currentTime + 0.18);
            gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.22);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.22);
        },

        // Two-tone comms chirp for an incoming chat message
        playChirp: function() {
            init();
            [[0, 700], [0.09, 1000]].forEach(function(pair) {
                const t = pair[0], freq = pair[1];
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, audioCtx.currentTime + t);
                gain.gain.setValueAtTime(0.08, audioCtx.currentTime + t);
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.08);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(audioCtx.currentTime + t);
                osc.stop(audioCtx.currentTime + t + 0.08);
            });
        },

        // Very short, quiet UI tick -- available for button click feedback.
        // Not wired to any button yet (see darkforest-architecture-reference.md
        // for why -- deliberately deferred, not silently skipped).
        playClick: function() {
            init();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1200, audioCtx.currentTime);
            gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.05);
        },

        // Quick ascending "lock" tone for setting a Jump Vector Plotter
        // target point -- distinct from the full playWarp() that fires on
        // actual jump execution.
        playConfirm: function() {
            init();
            [[0, 500], [0.1, 750]].forEach(function(pair) {
                const t = pair[0], freq = pair[1];
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, audioCtx.currentTime + t);
                gain.gain.setValueAtTime(0.09, audioCtx.currentTime + t);
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.12);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(audioCtx.currentTime + t);
                osc.stop(audioCtx.currentTime + t + 0.12);
            });
        },

        // Descending "cancel/abort" tone -- distinct from playError()'s
        // buzz. Not wired anywhere yet: there's no dedicated "Cancel Jump"
        // button in the current UI to hang it on (only an internal cleanup
        // path that also fires after a SUCCESSFUL jump, which would misfire
        // this sound if hooked there). Available for whenever that UI gets
        // added.
        playCancel: function() {
            init();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(500, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(180, audioCtx.currentTime + 0.25);
            gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.25);
        },

        // Pleasant ascending three-note chime -- daily logistics cycle
        // complete (wired). Also usable for salvage/gather completion,
        // which is NOT wired yet -- couldn't confidently locate a single
        // "gather complete" trigger point in this pass, so left as a
        // deferred hookup rather than guessing at the wrong function.
        playChime: function() {
            init();
            const freqs = [523.25, 659.25, 783.99]; // C5, E5, G5
            [0, 0.12, 0.24].forEach(function(t, i) {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freqs[i], audioCtx.currentTime + t);
                gain.gain.setValueAtTime(0.09, audioCtx.currentTime + t);
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.35);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(audioCtx.currentTime + t);
                osc.stop(audioCtx.currentTime + t + 0.35);
            });
        },

        // --- Music beds (2026-08 audio polish) ---
        startAmbient: startAmbient,
        stopAmbient: stopAmbient,
        startBattleMusic: startBattleMusic,
        stopBattleMusic: stopBattleMusic,
        skipTrack: skipTrack,
        setMusicVolume: setMusicVolume,
        setMuted: setMuted,
        toggleMute: toggleMute,
        getMusicVolume: function() { return musicVolume; },
        isMuted: function() { return muted; }
    };
})();
