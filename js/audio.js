/* ==========================================================================
   js/audio.js - Web Audio API Synthesizer + Music Beds
   ==========================================================================
   SFX are all pure oscillator synthesis (no sample files) -- unchanged
   approach from before this session's audio-polish pass, just more of them.

   Music (ambient + battle) is the one part of this file that is NOT
   synthesized: it hotlinks real CC0 / CC-BY tracks from opengameart.org via
   plain <audio> elements. That's a deliberate, confirmed tradeoff (2026-08
   audio polish session) -- see the block comment above AMBIENT_PLAYLIST
   below for what that means and what could break it.
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
       MUSIC BEDS -- state, licensing notes, and hotlink risk
       ----------------------------------------------------------------------
       Confirmed design (2026-08 audio polish session):
         - Ambient bed: rotates through all 5 tracks below (shuffled order,
           reshuffled each time the playlist is exhausted) rather than
           looping just one -- each track is only ~1 min, a single one on
           repeat would get noticeable fast.
         - Battle bed: a single track, auto-starts/stops with
           battle_encounters.is_active flipping true/false (wired in
           js/battle-map.js's loadBattleEncounters(), which already runs on
           EVERY connected client via that table's realtime channel -- so
           this fires for players too, not just the DM who started the
           encounter).
         - Both are real hotlinked files from opengameart.org, NOT
           synthesized -- the user explicitly chose this over synthesizing
           the music too, accepting the tradeoff below.

       HOTLINK RISK (flagged plainly, not silently decided): these files
       live on opengameart.org's own file server, not this project. There is
       no local copy and no offline fallback. If OpenGameArt ever moves,
       renames, or removes any of these files, that track just goes silent
       (console.warn logged, no crash) until someone notices and swaps the
       URL. If that ever becomes a problem, the fix is to download the files
       and self-host them from the project instead -- ask and that can get
       wired up, but downloading binary assets isn't something this build
       session can do on its own.

       LICENSING:
         - Ambient pack ("Ambience Pack 1 -- Sci-Fi Horror") is CC0 --
           public domain, no attribution required.
         - Battle track ("Battle Music" by Peter Eastman) is CC-BY 3.0, NOT
           CC0 -- it requires a credit ("Please credit Peter Eastman").
           That credit still needs to go somewhere the user/testers will
           actually see it, e.g. an About/Credits panel -- not yet added
           anywhere in this build. Flagging this as an open item, not
           assuming it's handled.
    */
    const AMBIENT_PLAYLIST = [
        'https://opengameart.org/sites/default/files/The%20Surreal%20Truth.mp3',
        'https://opengameart.org/sites/default/files/Infestation%20in%20the%20Control%20Room.mp3',
        "https://opengameart.org/sites/default/files/Final%20Captain%27s%20Log.mp3",
        'https://opengameart.org/sites/default/files/The%20Depths%20of%20Hell.mp3',
        'https://opengameart.org/sites/default/files/Cage%20of%20the%20Cryptid.mp3'
    ];
    const BATTLE_TRACK_URL = 'https://opengameart.org/sites/default/files/Battle_1.ogg';
    // Creator's own loop instructions: cut off the final chord at 1:28.6 and
    // jump back to 0:04.6 (skips the intro on repeats, not on the first play).
    const BATTLE_LOOP_START = 4.6;
    const BATTLE_LOOP_END = 88.6;

    let musicVolume = (function() {
        const v = parseFloat(localStorage.getItem('odyssey_audio_volume'));
        return isNaN(v) ? 0.4 : Math.max(0, Math.min(1, v));
    })();
    let muted = localStorage.getItem('odyssey_audio_muted') === 'true';

    let ambientAudio = null;
    let battleAudio = null;
    let ambientOrder = shuffleIndices(AMBIENT_PLAYLIST.length);
    let ambientCursor = -1;
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

    function nextAmbientUrl() {
        ambientCursor++;
        if (ambientCursor >= ambientOrder.length) { ambientOrder = shuffleIndices(AMBIENT_PLAYLIST.length); ambientCursor = 0; }
        return AMBIENT_PLAYLIST[ambientOrder[ambientCursor]];
    }

    function playNextAmbientTrack() {
        if (!ambientDesired || battleActive) return;
        const url = nextAmbientUrl();
        const el = new Audio(url);
        el.volume = 0;
        el.addEventListener('ended', playNextAmbientTrack);
        el.addEventListener('error', () => { console.warn('[AudioEngine] ambient track failed to load (hotlink may be broken):', url); playNextAmbientTrack(); });
        ambientAudio = el;
        el.play().catch(() => { /* blocked until a user gesture -- click-unlock listener below retries */ });
        fadeTo(el, effectiveVolume(), 2000);
    }

    function startAmbient() {
        ambientDesired = true;
        if (battleActive) return; // battle bed takes priority; resumes when it ends
        if (ambientAudio && !ambientAudio.paused) return;
        playNextAmbientTrack();
    }

    function stopAmbient(fadeMs) {
        ambientDesired = false;
        if (!ambientAudio) return;
        const el = ambientAudio;
        fadeTo(el, 0, fadeMs || 1200, () => { el.pause(); if (el === ambientAudio) ambientAudio = null; });
    }

    function ensureBattleAudio() {
        if (battleAudio) return battleAudio;
        const el = new Audio(BATTLE_TRACK_URL);
        el.volume = 0;
        el.addEventListener('timeupdate', () => { if (el.currentTime >= BATTLE_LOOP_END) el.currentTime = BATTLE_LOOP_START; });
        el.addEventListener('error', () => console.warn('[AudioEngine] battle track failed to load (hotlink may be broken):', BATTLE_TRACK_URL));
        battleAudio = el;
        return el;
    }

    function startBattleMusic() {
        if (battleActive) return; // already running, don't restart from 0
        battleActive = true;
        if (ambientAudio && !ambientAudio.paused) { const a = ambientAudio; fadeTo(a, 0, 1200, () => a.pause()); }
        const el = ensureBattleAudio();
        el.currentTime = 0; el.volume = 0;
        el.play().catch(() => {});
        fadeTo(el, effectiveVolume(), 1000);
    }

    function stopBattleMusic() {
        if (!battleActive) return;
        battleActive = false;
        if (battleAudio) { const el = battleAudio; fadeTo(el, 0, 1500, () => { el.pause(); el.currentTime = 0; }); }
        if (ambientDesired) playNextAmbientTrack(); // resumes on the NEXT track, not mid-song where it left off -- simplification, flagged here rather than silently done
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
        setMusicVolume: setMusicVolume,
        setMuted: setMuted,
        toggleMute: toggleMute,
        getMusicVolume: function() { return musicVolume; },
        isMuted: function() { return muted; }
    };
})();
