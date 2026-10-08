/* ==========================================================================
   js/audio.js - Web Audio API Synthesizer + Music Beds
   ==========================================================================
   SFX are pure oscillator synthesis (no sample files), routed through one
   SFX gain node. Music (ambient + battle beds) is NOT synthesized: it streams
   real soundtrack tracks from a private Supabase Storage bucket -- see the
   MUSIC BEDS block below.
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

    // Sound-effects volume + mute, separate from music. All effects route
    // through one gain node controlled from the AUDIO menu (per device,
    // localStorage).
    let sfxVolume = (function() {
        try { const v = parseFloat(localStorage.getItem('darkforest_sfx_volume')); return isNaN(v) ? 1 : Math.max(0, Math.min(1, v)); } catch (e) { return 1; }
    })();
    let sfxMuted = (function() {
        try { return localStorage.getItem('darkforest_sfx_muted') === 'true'; } catch (e) { return false; }
    })();
    let sfxGainNode = null;
    function sfxOut() {
        if (!sfxGainNode) {
            sfxGainNode = audioCtx.createGain();
            sfxGainNode.connect(audioCtx.destination);
        }
        sfxGainNode.gain.value = sfxMuted ? 0 : sfxVolume;
        return sfxGainNode;
    }
    function setSfxVolume(v) {
        sfxVolume = Math.max(0, Math.min(1, parseFloat(v)));
        try { localStorage.setItem('darkforest_sfx_volume', String(sfxVolume)); } catch (e) {}
        if (sfxGainNode) sfxGainNode.gain.value = sfxMuted ? 0 : sfxVolume;
    }
    function setSfxMuted(b) {
        sfxMuted = !!b;
        try { localStorage.setItem('darkforest_sfx_muted', sfxMuted ? 'true' : 'false'); } catch (e) {}
        if (sfxGainNode) sfxGainNode.gain.value = sfxMuted ? 0 : sfxVolume;
    }
    // Small synth helpers: a pitch-swept tone and a filtered noise burst.
    // t0/dur are seconds from now.
    function tone(type, f0, f1, t0, dur, vol) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(f0, audioCtx.currentTime + t0);
        if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, audioCtx.currentTime + t0 + dur);
        gain.gain.setValueAtTime(vol, audioCtx.currentTime + t0);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t0 + dur);
        osc.connect(gain);
        gain.connect(sfxOut());
        osc.start(audioCtx.currentTime + t0);
        osc.stop(audioCtx.currentTime + t0 + dur + 0.02);
    }
    function noiseBurst(t0, dur, vol, filterHz) {
        const len = Math.max(1, Math.floor(audioCtx.sampleRate * dur));
        const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = filterHz;
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(vol, audioCtx.currentTime + t0);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t0 + dur);
        src.connect(filter); filter.connect(gain); gain.connect(sfxOut());
        src.start(audioCtx.currentTime + t0);
    }

    /* ----------------------------------------------------------------------
       MUSIC BEDS -- Battlestar Galactica soundtrack (Bear McCreary)
       ----------------------------------------------------------------------
       The m4a files live in the PRIVATE Storage bucket 'music-tracks', not
       the git repo (the site is a public static host). Each track start
       requests a short-lived signed URL, which only works for a logged-in
       session (RLS: music_tracks_authenticated_read). Uploads are DM-only
       (RLS: music_tracks_dm_write), done via the Supabase dashboard -- there
       is no in-app uploader. A logged-in player can still save a played
       track; this narrows exposure, it does not eliminate it.

       These are copyrighted commercial recordings, meant for the DM's
       private table only -- not for a public release of this tool.

       Each bed is a shuffled rotation, reshuffled when exhausted. The battle
       bed starts/stops with battle_encounters.is_active (battle-map.js
       loadBattleEncounters()). "Worthy of Survival" is in BOTH rotations on
       purpose (DM decision).
    */
    const MUSIC_BUCKET = 'music-tracks';
    const MUSIC_SIGNED_URL_TTL_SEC = 6 * 60 * 60; // 6h; a fresh URL is fetched per track anyway
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

    // localStorage reads are guarded: a throw here (storage disabled) would
    // abort the whole IIFE and leave window.AudioEngine undefined app-wide.
    let musicVolume = (function() {
        try {
            const v = parseFloat(localStorage.getItem('odyssey_audio_volume'));
            return isNaN(v) ? 0.4 : Math.max(0, Math.min(1, v));
        } catch (e) { return 0.4; }
    })();
    let muted = (function() {
        try { return localStorage.getItem('odyssey_audio_muted') === 'true'; } catch (e) { return false; }
    })();

    let ambientAudio = null;
    let battleAudio = null;
    let ambientDesired = false; // "should ambient be playing when nothing overrides it"
    let battleActive = false;
    // Consecutive-failure guards: if the whole bed is unreachable (logged
    // out, RLS or bucket problem), "try the next track" would loop forever.
    // After a full rotation of consecutive failures, retries stop until
    // startAmbient()/startBattleMusic() is called again.
    let ambientFailStreak = 0;
    let battleFailStreak = 0;

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
        // Cancel any in-flight fade first: fadeTo forces its own fixed target
        // volume on its last tick, which would undo a live mute/volume change.
        if (ambientAudio) { if (ambientAudio._fadeInterval) { clearInterval(ambientAudio._fadeInterval); ambientAudio._fadeInterval = null; } if (!ambientAudio.paused) ambientAudio.volume = v; }
        if (battleAudio) { if (battleAudio._fadeInterval) { clearInterval(battleAudio._fadeInterval); battleAudio._fadeInterval = null; } if (!battleAudio.paused) battleAudio.volume = v; }
    }

    // Volume ramp on a plain <audio> element (50 ms steps via .volume).
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

    // Shuffled rotating playlist, reshuffled on exhaustion. next() returns
    // the bucket-relative path (filename), not a URL -- signed URLs are
    // fetched per track in playTrackAttempt.
    function makeRotatingPlaylist(filenames) {
        let order = shuffleIndices(filenames.length);
        let cursor = -1;
        return function next() {
            cursor++;
            if (cursor >= order.length) { order = shuffleIndices(filenames.length); cursor = 0; }
            return filenames[order[cursor]];
        };
    }
    const nextAmbientPath = makeRotatingPlaylist(AMBIENT_TRACKS);
    const nextBattlePath = makeRotatingPlaylist(BATTLE_TRACKS);

    // Records a load/play failure for the given bed; returns true if the
    // bed has now failed a full rotation's worth in a row and should STOP
    // retrying (caller must not recurse further in that case).
    function recordFailureAndCheckGiveUp(isAmbient) {
        const trackCount = isAmbient ? AMBIENT_TRACKS.length : BATTLE_TRACKS.length;
        if (isAmbient) {
            ambientFailStreak++;
            if (ambientFailStreak > trackCount) { console.warn('[AudioEngine] ambient bed: every track failed to load/play -- pausing retries until startAmbient() runs again (check login + the music-tracks bucket).'); return true; }
        } else {
            battleFailStreak++;
            if (battleFailStreak > trackCount) { console.warn('[AudioEngine] battle bed: every track failed to load/play -- pausing retries until startBattleMusic() runs again (check login + the music-tracks bucket).'); return true; }
        }
        return false;
    }

    // Extra attempts on the SAME track (fresh signed URL each time) before
    // moving on in the rotation. Playback errors such as Chrome's transient
    // net::ERR_QUIC_PROTOCOL_ERROR hit the large tracks (~18 MB) most; a
    // retry usually succeeds.
    const MUSIC_TRACK_RETRY_LIMIT = 2;
    const MUSIC_TRACK_RETRY_DELAY_MS = 1200;

    async function playTrackAttempt(kind, path, attempt) {
        const isAmbient = kind === 'ambient';
        // Re-checked on every attempt: state can change during a retry delay.
        if (isAmbient) { if (!ambientDesired || battleActive) return; }
        else { if (!battleActive) return; }

        let signedUrl;
        try {
            const { data, error } = await db.storage.from(MUSIC_BUCKET).createSignedUrl(path, MUSIC_SIGNED_URL_TTL_SEC);
            if (error || !data || !data.signedUrl) throw error || new Error('no signedUrl in response');
            signedUrl = data.signedUrl;
        } catch (err) {
            console.warn('[AudioEngine] could not get a signed URL (check you are logged in and this file exists in the "music-tracks" Storage bucket):', path, err);
            if (recordFailureAndCheckGiveUp(isAmbient)) return;
            return playNextTrack(kind); // a signed-URL failure isn't a streaming glitch -- move on, don't retry
        }

        // Re-check after the await: state may have changed while the signed
        // URL was fetched (e.g. the battle ended), so a stale track must not play.
        if (isAmbient) { if (!ambientDesired || battleActive) return; }
        else { if (!battleActive) return; }

        const el = new Audio(signedUrl);
        el.volume = 0;
        el.addEventListener('ended', () => playNextTrack(kind));
        el.addEventListener('error', () => {
            if (attempt < MUSIC_TRACK_RETRY_LIMIT) {
                console.warn(`[AudioEngine] track failed to play (attempt ${attempt + 1}/${MUSIC_TRACK_RETRY_LIMIT + 1}), retrying same track:`, path);
                setTimeout(() => playTrackAttempt(kind, path, attempt + 1), MUSIC_TRACK_RETRY_DELAY_MS);
                return;
            }
            console.warn(`[AudioEngine] track failed to play after ${MUSIC_TRACK_RETRY_LIMIT + 1} attempts, moving on:`, path);
            if (!recordFailureAndCheckGiveUp(isAmbient)) playNextTrack(kind);
        });
        if (isAmbient) { ambientAudio = el; ambientFailStreak = 0; } else { battleAudio = el; battleFailStreak = 0; }
        el.play().catch(() => { /* blocked until a user gesture -- click-unlock listener below retries */ });
        fadeTo(el, effectiveVolume(), isAmbient ? 2000 : 1000);
    }

    // kind: 'ambient' | 'battle'. Plays (fading in) the next track in that
    // bed's rotation. Used for track-ended advancement and manual skips.
    function playNextTrack(kind) {
        const isAmbient = kind === 'ambient';
        if (isAmbient) { if (!ambientDesired || battleActive) return; }
        else { if (!battleActive) return; }
        const path = isAmbient ? nextAmbientPath() : nextBattlePath();
        return playTrackAttempt(kind, path, 0);
    }

    function startAmbient() {
        ambientDesired = true;
        ambientFailStreak = 0; // explicit (re)start always gets a fresh full attempt
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
        battleFailStreak = 0; // explicit (re)start always gets a fresh full attempt
        if (ambientAudio && !ambientAudio.paused) { const a = ambientAudio; fadeTo(a, 0, 1200, () => a.pause()); }
        playNextTrack('battle');
    }

    function stopBattleMusic() {
        if (!battleActive) return;
        battleActive = false;
        if (battleAudio) { const el = battleAudio; fadeTo(el, 0, 1500, () => { el.pause(); el.currentTime = 0; }); }
        if (ambientDesired) playNextTrack('ambient'); // resumes on the NEXT track, not mid-song
    }

    // Manual skip: hard-stops the current track (no fade-out) and fades in
    // the next track of the active bed (battle takes priority). No-op if
    // neither bed should be playing.
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
        const sfxChk = document.getElementById('sfx-mute-toggle');
        const sfxSld = document.getElementById('sfx-volume-slider');
        if (sfxChk) sfxChk.checked = sfxMuted;
        if (sfxSld) sfxSld.value = Math.round(sfxVolume * 100);
    }
    document.addEventListener('DOMContentLoaded', syncControlsUI);

    // The dropdown lives inside #top-bar (overflow-y:hidden), which would
    // clip an absolutely-positioned dropdown. Use position:fixed, placed
    // from the button's rect on each open.
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

    // Browsers need a user gesture to unlock audio: the first click resumes
    // the SFX context. The ambient bed normally starts from db.js
    // fetchUserProfile() after login (signed URLs need a session); it is
    // only tried here if this first click lands after login.
    document.addEventListener('click', () => {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        if (!muted && typeof currentUserId !== 'undefined' && currentUserId) startAmbient();
    }, { once: true });

    return {
        // --- SFX ---
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
            gain.connect(sfxOut());
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
            gain.connect(sfxOut());
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
            gain.connect(sfxOut());
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
            gain.connect(sfxOut());
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
            gain.connect(sfxOut());
            osc.start();
            osc.stop(audioCtx.currentTime + 1.5);
        },

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
            gain.connect(sfxOut());
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
                gain.connect(sfxOut());
                osc.start(audioCtx.currentTime + t);
                osc.stop(audioCtx.currentTime + t + 0.08);
            });
        },

        // Very short, quiet UI tick. Not wired to any button yet.
        playClick: function() {
            init();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1200, audioCtx.currentTime);
            gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
            osc.connect(gain);
            gain.connect(sfxOut());
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
                gain.connect(sfxOut());
                osc.start(audioCtx.currentTime + t);
                osc.stop(audioCtx.currentTime + t + 0.12);
            });
        },

        // Descending "cancel/abort" tone, distinct from playError(). Not
        // wired yet: there is no "Cancel Jump" button, and the jump cleanup
        // path also runs after a successful jump, so don't hook it there.
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
            gain.connect(sfxOut());
            osc.start();
            osc.stop(audioCtx.currentTime + 0.25);
        },

        // Ascending three-note chime: daily logistics cycle complete.
        // Not yet wired for salvage/gather completion.
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
                gain.connect(sfxOut());
                osc.start(audioCtx.currentTime + t);
                osc.stop(audioCtx.currentTime + t + 0.35);
            });
        },

        // --- Battle sounds ---
        // Two quick rising beeps: a weapon has a target.
        playTargetLock: function() {
            init();
            tone('square', 1300, 1300, 0, 0.06, 0.035);
            tone('square', 1750, 1750, 0.09, 0.08, 0.035);
        },
        // Shot absorbed by shields: a bright shimmering sweep.
        playShieldHit: function() {
            init();
            tone('sine', 1500, 600, 0, 0.35, 0.07);
            tone('triangle', 2200, 900, 0.02, 0.3, 0.035);
            noiseBurst(0, 0.18, 0.05, 4000);
        },
        // Shot through to the hull: a low thud with a crunch.
        playHullHit: function() {
            init();
            tone('sine', 110, 45, 0, 0.35, 0.22);
            noiseBurst(0, 0.25, 0.14, 900);
        },
        // It's now YOUR ship's turn (plays only on that player's own device).
        playTurnStart: function() {
            init();
            tone('sine', 660, 660, 0, 0.12, 0.08);
            tone('sine', 880, 880, 0.13, 0.12, 0.08);
            tone('sine', 1320, 1320, 0.26, 0.22, 0.07);
        },
        setSfxVolume: function(v) { setSfxVolume(v); },
        setSfxMuted: function(b) { setSfxMuted(b); },
        isSfxMuted: function() { return sfxMuted; },
        getSfxVolume: function() { return sfxVolume; },

        // --- Music beds ---
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
