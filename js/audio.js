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
       served from a PRIVATE Supabase Storage bucket, not a public file
       ----------------------------------------------------------------------
       Earlier this session these tracks were referenced as local files in
       a "music tracks/" folder, which worked fine locally but turned out
       to be a real problem the moment this app got deployed to a public
       GitHub Pages site: a static host has zero access control, so any
       file sitting in that repo is a plain public URL anyone (or any
       crawler) can fetch, logged in or not -- not something that should
       be true of full copyrighted commercial recordings. See the "Private
       Supabase Storage for music" checkpoint in
       darkforest-architecture-reference.md for the full discussion.

       Fix: the 8 real audio files (m4a) now live in a PRIVATE Storage
       bucket ('music-tracks', public:false, migration
       music_tracks_private_storage) instead of the git repo. This file
       never references a raw file URL -- it asks Supabase for a
       short-lived SIGNED url (createSignedUrl, MUSIC_SIGNED_URL_TTL_SEC
       below) each time a track starts, which only succeeds for an
       authenticated session (RLS: music_tracks_authenticated_read).
       Uploading/replacing files in the bucket is DM-only (RLS:
       music_tracks_dm_write, same profiles.role='dm' pattern as the
       pre-existing saved_fleets_dm_only policy) -- done via the Supabase
       dashboard's Storage UI directly, not through this app's own UI (a
       deliberate scope call for a one-time 8-file task, not built as an
       in-app uploader this round).

       This meaningfully narrows exposure (no public crawlable URL, no
       search-engine indexing, access requires an actual login to this
       campaign) but does NOT eliminate it -- nothing stops an
       authenticated player from saving a track once it's played in their
       own browser and re-sharing it themselves. That's a real, standing
       limit, not something this fixes outright.

       PERSONAL-USE NOTE (carried over, still true): these are real,
       commercially-released, copyrighted recordings, not royalty-free
       assets. This setup is meant for the DM's own table's private
       sessions -- not a general public release of this tool.

       Ambient bed rotates through 6 tracks (shuffled, reshuffled on
       exhaustion): Pegasus, Dark Unions, Something Dark Is Coming, Worthy
       of Survival, Martial Law, Standing In the Mud.
       Battle bed rotates through 3 tracks the same way, auto-starting/
       stopping with battle_encounters.is_active (js/battle-map.js's
       loadBattleEncounters(), unchanged wiring from before): Prelude to
       War, Worthy of Survival, Scar. "Worthy of Survival" deliberately
       appears in BOTH rotations -- the DM's own choice, not a mistake.
    */
    const MUSIC_BUCKET = 'music-tracks';
    const MUSIC_SIGNED_URL_TTL_SEC = 6 * 60 * 60; // 6h -- comfortably covers one session; a fresh URL is fetched per track anyway, not cached across the whole session
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

    // Bug fix (bug hunt, this session): unguarded localStorage access here
    // ran as part of this whole IIFE's top-level evaluation -- in any
    // environment where localStorage throws (locked-down browser settings,
    // certain extensions, storage-disabled contexts), this would throw
    // before the `return {...}` at the bottom of the IIFE is ever reached,
    // leaving window.AudioEngine undefined and breaking every SFX call
    // app-wide (AudioEngine.playPing()/playError()/etc.), not just music.
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
    // Consecutive-failure guards -- without these, if the WHOLE bucket/bed
    // is unreachable (RLS misconfigured, bucket empty, logged out), the old
    // "on error, just try the next track" logic would spin forever, firing
    // a fresh failed network request every few ms (this is exactly what
    // happened with the old local-file 404s before this fix -- a genuine
    // bug, not just a symptom of the wrong URL). Once a full rotation's
    // worth of consecutive failures happens, stop retrying until
    // startAmbient()/startBattleMusic() is explicitly called again.
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
        // Bug fix (bug hunt, this session): fadeTo's setInterval captures a
        // fixed targetVol when a fade starts and unconditionally forces
        // el.volume = targetVol on its last tick. If setMusicVolume/setMuted
        // ran while a fade-in was still in flight (e.g. muting while a track
        // is fading in), the fade's own ticks -- and its final forced
        // assignment -- would keep overwriting the volume this function just
        // set, eventually re-asserting the stale pre-mute/pre-change target
        // once the fade completed. Cancel any in-flight fade on an element
        // before authoritatively setting its volume here, so a live mute/
        // volume change always wins and can't be silently undone later by an
        // already-running fade.
        if (ambientAudio) { if (ambientAudio._fadeInterval) { clearInterval(ambientAudio._fadeInterval); ambientAudio._fadeInterval = null; } if (!ambientAudio.paused) ambientAudio.volume = v; }
        if (battleAudio) { if (battleAudio._fadeInterval) { clearInterval(battleAudio._fadeInterval); battleAudio._fadeInterval = null; } if (!battleAudio.paused) battleAudio.volume = v; }
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
    // identical shuffle/reshuffle-on-exhaustion behavior, so this is one
    // implementation instead of two that could drift apart. Returns the
    // bucket-relative object path (filename), not a URL -- signed URLs are
    // fetched per-track in playNextTrack below.
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
    // giving up on it and moving to a different track in the rotation.
    // Added after a real report of "10 Something Dark Is Coming.m4a"
    // repeatedly hitting net::ERR_QUIC_PROTOCOL_ERROR in Chrome -- that's a
    // browser/network-layer QUIC connection failure talking to Supabase
    // Storage's CDN, not something this app's code can prevent outright.
    // Checked file sizes directly in Storage afterward: that track (18.4MB)
    // and "17 Prelude to War.m4a" (18.1MB) are both roughly 2.5-4x every
    // other track (4.3-7.8MB) -- a longer-lived streaming connection simply
    // gets more chances to hit a transient QUIC error mid-playback, which
    // is almost certainly why this specific (large, frequently-rotated
    // ambient) track was the one actually reported. QUIC errors are usually
    // transient, so retrying the SAME track a couple of times first (before
    // this code's existing "move to the next track" fallback kicks in)
    // gives it a real chance to succeed instead of just skipping a track
    // that would likely have played fine a moment later.
    const MUSIC_TRACK_RETRY_LIMIT = 2;
    const MUSIC_TRACK_RETRY_DELAY_MS = 1200;

    async function playTrackAttempt(kind, path, attempt) {
        const isAmbient = kind === 'ambient';
        // Re-check on every attempt, not just the first -- state can change
        // during a retry's delay (e.g. the user stopped ambient, or battle
        // ended, while this track was still trying to recover).
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
            return playNextTrack(kind); // signed-URL step failing isn't a per-track streaming glitch -- move to a different track, not a retry of this one
        }

        // Bug fix (bug hunt, this session): the ambientDesired/battleActive
        // check above only ran BEFORE this await -- createSignedUrl can take
        // hundreds of ms, and nothing re-validated state after it resolved.
        // A battle ending mid-fetch (stopBattleMusic, which starts the
        // ambient bed if desired) could let this now-stale battle-track
        // fetch land anyway, overwriting battleAudio and playing a track for
        // a battle that already ended -- defeating the "battle bed takes
        // priority" invariant. Re-check the same way the top-of-function
        // guard does before committing to this track.
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

    // kind: 'ambient' | 'battle' -- picks the next track in that bed's own
    // rotation and plays it (fading in), retrying that SAME track a couple
    // of times first on failure (see playTrackAttempt above) before this
    // bed's own rotation moves on to a different track. Used both for
    // normal track-ended advancement and for a manual skip (see skipTrack
    // below).
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
    // resumes the oscillator SFX context (original behavior, unchanged).
    // NOTE: starting the ambient bed itself now happens from db.js's
    // fetchUserProfile() right after a real login succeeds -- the signed-URL
    // fetch requires an authenticated session, so calling startAmbient() from
    // a pre-login click (e.g. clicking the email field) would just fail and
    // burn this one-time listener for nothing. We still try it here too, in
    // case this fires on a click that happens to land after login.
    document.addEventListener('click', () => {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        if (!muted && typeof currentUserId !== 'undefined' && currentUserId) startAmbient();
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
