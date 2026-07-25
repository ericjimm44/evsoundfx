/* =====================================================================
   EV ROAR — recorded engine sound that reacts to real GPS speed.
   Vanilla JS + Web Audio API. Recorded loops in samples/ are pitch-tracked
   to live rpm and crossfaded; a synthesized engine remains as an offline
   fallback. Installs as a PWA and runs fully offline once cached.
   Designed to run in the Tesla browser (Chromium) through the car speakers.
   ===================================================================== */

(() => {
  "use strict";

  /* ---------------------------------------------------------------
     VOICES — each is a preset for the synthesis engine.
     - order:        firing events per revolution (V8 4-stroke ≈ 4).
                     Sets the fundamental pitch: f0 = rpm/60 * order.
     - mapPow:       >1 makes pitch rise more toward the top (whine).
     - fMin/fMax:    clamp for the fundamental (Hz).
     - sub/growl/tone/noise: relative levels of each layer.
     - wave:         harmonic recipe for the main oscillator.
     - bright:       base low-pass cutoff & how much rpm opens it.
     - drive:        waveshaper grit.
     - vibrato:      pitch shimmer (EV/jet character).
  ---------------------------------------------------------------- */
  const VOICES = {
    v8: {
      name: "Synth V8", emoji: "🎛️",
      order: 4, mapPow: 1.0, fMin: 30, fMax: 380,
      sub: 1.15, growl: 0.5, tone: 1.0, noise: 0.5,
      wave: [0, 1, 0.6, 0.9, 0.35, 0.6, 0.2, 0.4, 0.15, 0.25],
      bright: 520, brightRpm: 2.6, drive: 0.5, vibrato: 0,
    },
    turbo: {
      name: "Synth Turbo", emoji: "🎛️",
      order: 3, mapPow: 1.05, fMin: 45, fMax: 620,
      sub: 0.55, growl: 0.6, tone: 0.9, noise: 0.85,
      wave: [0, 1, 0.35, 0.7, 0.2, 0.5, 0.18, 0.35, 0.12],
      bright: 700, brightRpm: 5.0, drive: 0.5, vibrato: 0,
    },
    ev: {
      name: "Synth EV", emoji: "🎛️",
      order: 6, mapPow: 1.55, fMin: 90, fMax: 1650,
      sub: 0.3, growl: 0.25, tone: 1.0, noise: 0.12,
      wave: [0, 1, 0.15, 0.5, 0.1, 0.28, 0.08, 0.18],
      bright: 1400, brightRpm: 6.5, drive: 0.12, vibrato: 0.05,
    },
    jet: {
      name: "Synth Jet", emoji: "🎛️",
      order: 5, mapPow: 1.55, fMin: 120, fMax: 2200,
      sub: 0.18, growl: 0.15, tone: 0.18, noise: 1.0,
      wave: [0, 1, 0.2, 0.35, 0.12, 0.2],
      bright: 1800, brightRpm: 7.5, drive: 0.15, vibrato: 0.03,
    },
  };
  const VOICE_ORDER = ["v8", "turbo", "ev", "jet"];

  /* ---------------------------------------------------------------
     DRIVETRAIN — simulate a gearbox so revs climb and shift.
  ---------------------------------------------------------------- */
  const IDLE_RPM = 780;
  const REDLINE = 6800;
  // engine-rpm added per (m/s) of road speed, per gear. Evenly spaced
  // ~1.44 ratio steps (the old set had a 1.88 jump into top, which put an
  // audible rpm cliff at highway speed). 7 speeds keeps a relaxed
  // ~3,000 rpm cruise at 70 mph.
  const GEARS = [640, 445, 310, 216, 150, 105, 73];
  const SHIFT_COOLDOWN = 600; // ms between shifts

  /* ---------------------------------------------------------------
     STATE
  ---------------------------------------------------------------- */
  const S = {
    started: false,
    power: true,
    voiceKey: "smp:v8classic", // real recording by default; falls back to synth offline
    sport: false,
    boost: false,
    useGps: false,
    units: "mph",
    volume: 0.7,
    manualThrottle: 0,   // 0..1 from slider
    // live
    speed: 0,            // m/s (smoothed)
    rawSpeed: 0,
    lastSpeed: 0,
    throttle: 0,         // 0..1 estimated load (drives tone — fast)
    gearLoad: 0,         // 0..1 damped load (drives gear choice — slow)
    accelHist: [],       // rolling speed samples for a stable accel estimate
    rpm: IDLE_RPM,
    gear: 1,             // 1-indexed
    lastShift: 0,
    shiftAt: 0,          // timestamp of the last shift (for the shift punch)
    gpsWatchId: null,
    gpsOk: false,
  };

  /* ---------------------------------------------------------------
     REAL SAMPLE PACKS — recorded engine loops, either shipped in the
     repo's samples/ folder (listed in samples/pack.json) or loaded by
     the user from a file and kept on-device in IndexedDB. Loops are
     pitch-bent with playbackRate and crossfaded by rpm — the realism
     pure synthesis can't reach.
  ---------------------------------------------------------------- */
  const SMP = { packs: {}, active: null, nodes: [], bus: null, loadToken: 0 };

  async function loadSamplePacks() {
    try {
      const res = await fetch("samples/pack.json", { cache: "no-store" });
      if (res.ok) {
        const j = await res.json();
        (j.voices || []).forEach((v) => {
          if (!v.key || !Array.isArray(v.loops) || !v.loops.length) return;
          SMP.packs["smp:" + v.key] = {
            name: v.name || v.key, emoji: v.emoji || "🎧", whistle: !!v.whistle,
            loops: v.loops.map((l) => ({ rpm: l.rpm || 3000, url: "samples/" + l.file, buffer: null })),
          };
        });
      }
    } catch (e) { /* no pack yet — fine */ }
    try {
      const rows = await idbGetAll();
      rows.forEach((r) => {
        SMP.packs["smp:" + r.key] = {
          name: r.val.name, emoji: "🎧", custom: true,
          loops: [{ rpm: r.val.rpm || 3000, data: r.val.data, buffer: null }],
        };
      });
    } catch (e) { /* IndexedDB unavailable — fine */ }
    buildVoiceChips();
  }

  async function activateSample(key) {
    const pack = SMP.packs[key];
    if (!pack || !ctx) return;
    // Guard against overlapping activations: tapping two chips quickly used
    // to let the slower load finish last and play the wrong voice.
    const token = ++SMP.loadToken;
    setStatus("Loading sound…");
    try {
      for (const l of pack.loops) {
        if (l.buffer) continue;
        const ab = l.data ? l.data.slice(0) : await (await fetch(l.url)).arrayBuffer();
        l.buffer = await ctx.decodeAudioData(ab);
      }
    } catch (e) {
      if (token !== SMP.loadToken) return; // superseded; stay quiet
      // NEVER leave the app silent: fall back to the built-in synth engine
      // so there is always sound, and say why.
      setStatus("Couldn't load that sound — using the backup engine.");
      deactivateSample();
      applyVoice("v8");
      return;
    }
    if (token !== SMP.loadToken) return; // a newer selection won
    stopSample();
    pack.loops.slice().sort((a, b) => a.rpm - b.rpm).forEach((l) => {
      const src = ctx.createBufferSource();
      src.buffer = l.buffer; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(g); g.connect(SMP.bus); src.start();
      SMP.nodes.push({ src, g, rpm: l.rpm });
    });
    SMP.active = key;
    SMP.whistleOn = !!pack.whistle;
    A.engineBus.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    SMP.bus.gain.setTargetAtTime(1, ctx.currentTime, 0.15);
    setStatus("");
  }

  function stopSample() {
    SMP.nodes.forEach((n) => {
      try { n.src.stop(); } catch (e) {}
      // release the graph edges too, so switching voices repeatedly
      // doesn't pile up orphaned connections
      try { n.src.disconnect(); n.g.disconnect(); } catch (e) {}
    });
    SMP.nodes = [];
    SMP.active = null;
  }

  function deactivateSample() {
    if (!SMP.active) return;
    stopSample();
    if (!ctx) return;
    SMP.bus.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    SMP.subGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    SMP.whistleGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    SMP.whistleOn = false;
    A.engineBus.gain.setTargetAtTime(1, ctx.currentTime, 0.15);
  }

  // Equal-power crossfade between the two loops bracketing current rpm.
  function applySampleGains(now, tc, load) {
    const nodes = SMP.nodes;
    if (!nodes.length) return;
    const overall = 0.45 + load * 0.55;
    if (nodes.length === 1) {
      nodes[0].g.gain.setTargetAtTime(overall, now, tc);
      return;
    }
    let i = 0;
    while (i < nodes.length - 2 && S.rpm > nodes[i + 1].rpm) i++;
    const a = nodes[i], b = nodes[i + 1];
    const t = clamp((S.rpm - a.rpm) / Math.max(1, b.rpm - a.rpm), 0, 1);
    nodes.forEach((node, j) => {
      let w = 0;
      if (j === i) w = Math.cos(t * Math.PI / 2);
      else if (j === i + 1) w = Math.sin(t * Math.PI / 2);
      // fade a badly-stretched loop out rather than let it dominate as a
      // chipmunk: 0.5 octaves of stretch -> 0.61 gain, 1 octave -> 0.14
      const sp = Math.exp(-Math.pow((node.stretch || 0) / 0.55, 2) / 2);
      node.g.gain.setTargetAtTime(w * sp * overall, now, tc);
    });
  }

  /* IndexedDB — user-loaded sounds survive reloads on this device */
  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("evroar-sounds", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("sounds");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbPut(key, val) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const t = db.transaction("sounds", "readwrite");
      t.objectStore("sounds").put(val, key);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }
  async function idbGetAll() {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const t = db.transaction("sounds", "readonly");
      const st = t.objectStore("sounds");
      const kq = st.getAllKeys(), vq = st.getAll();
      t.oncomplete = () => res(kq.result.map((k, i) => ({ key: k, val: vq.result[i] })));
      t.onerror = () => rej(t.error);
    });
  }

  /* ---------------------------------------------------------------
     AUDIO GRAPH
  ---------------------------------------------------------------- */
  let ctx = null;
  const A = {}; // audio nodes

  function makeNoiseBuffer(context) {
    const len = context.sampleRate * 2;
    const buf = context.createBuffer(1, len, context.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // pinkish noise: low-pass the white noise a touch
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = (white * 0.35 + last * 3);
    }
    return buf;
  }

  function makeShaper(context, amount) {
    const n = 1024, curve = new Float32Array(n);
    const k = amount * 40 + 0.001;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    const ws = context.createWaveShaper();
    ws.curve = curve;
    ws.oversample = "2x";
    return ws;
  }

  function buildAudio() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Master chain: engineBus -> shaper -> tone LPF -> comp -> master -> out
    A.master = ctx.createGain();
    A.master.gain.value = S.volume;

    A.comp = ctx.createDynamicsCompressor();
    A.comp.threshold.value = -18;
    A.comp.knee.value = 24;
    // A 4 ms attack clamped down on exactly the 2–10 ms exhaust pulses that
    // make a recording sound like a real engine, flattening every voice
    // toward the same texture. The loops are loudness-matched now, so heavy
    // compression isn't needed for level control.
    A.comp.ratio.value = 2;
    A.comp.attack.value = 0.020;
    A.comp.release.value = 0.25;

    A.lpf = ctx.createBiquadFilter();
    A.lpf.type = "lowpass";
    A.lpf.frequency.value = 700;
    A.lpf.Q.value = 0.7;

    A.shaper = makeShaper(ctx, 0.3);

    A.engineBus = ctx.createGain();
    A.engineBus.gain.value = 0.0; // fade in

    // Exterior-boost high-pass: small outdoor Bluetooth speakers can't
    // reproduce deep bass — cutting it frees headroom for loudness.
    // At 20 Hz it's effectively bypassed.
    A.hpf = ctx.createBiquadFilter();
    A.hpf.type = "highpass";
    A.hpf.frequency.value = 20;
    A.hpf.Q.value = 0.7;

    A.engineBus.connect(A.shaper);
    A.shaper.connect(A.lpf);
    A.lpf.connect(A.comp);
    A.comp.connect(A.hpf);
    A.hpf.connect(A.master);
    A.master.connect(ctx.destination);

    // Sample-pack bus — recorded loops get their own tone filter (darker
    // off-throttle, brighter on it) and a sub-bass layer for body, then
    // join at the compressor so they stay otherwise natural.
    SMP.bus = ctx.createGain();
    SMP.bus.gain.value = 0;
    SMP.lpf = ctx.createBiquadFilter();
    SMP.lpf.type = "lowpass";
    SMP.lpf.frequency.value = 4000;
    SMP.lpf.Q.value = 0.5;
    // Insurance DC-block: shipped loops are DC-free, but a user-loaded sound
    // with a big DC offset would pump the compressor and eat headroom.
    SMP.dcBlock = ctx.createBiquadFilter();
    SMP.dcBlock.type = "highpass";
    SMP.dcBlock.frequency.value = 18;
    SMP.dcBlock.Q.value = 0.7;
    SMP.bus.connect(SMP.dcBlock);
    SMP.dcBlock.connect(SMP.lpf);
    SMP.lpf.connect(A.comp);

    // deep rpm-tracking sine under the recordings — the chest-thump
    // that thin source clips are missing
    SMP.sub = ctx.createOscillator();
    SMP.sub.type = "sine";
    SMP.subGain = ctx.createGain();
    SMP.subGain.gain.value = 0;
    SMP.sub.connect(SMP.subGain);
    SMP.subGain.connect(A.comp);
    SMP.sub.start();

    // Synthesized turbo whistle — a bandpassed tone that glides up with
    // rpm. Only enabled for voices flagged whistle:true. Because it moves
    // continuously it adds real turbo character AND masks the body loop's
    // repetition (a steady drone is what makes a loop obvious).
    SMP.whistle = ctx.createOscillator();
    SMP.whistle.type = "triangle";
    SMP.whistleBP = ctx.createBiquadFilter();
    SMP.whistleBP.type = "bandpass";
    SMP.whistleBP.Q.value = 5;
    SMP.whistleGain = ctx.createGain();
    SMP.whistleGain.gain.value = 0;
    SMP.whistle.connect(SMP.whistleBP);
    SMP.whistleBP.connect(SMP.whistleGain);
    SMP.whistleGain.connect(A.comp);
    SMP.whistle.start();

    // Main firing oscillator (custom periodic wave, swapped per voice)
    A.osc = ctx.createOscillator();
    A.oscGain = ctx.createGain(); A.oscGain.gain.value = 0.0;
    A.osc.connect(A.oscGain); A.oscGain.connect(A.engineBus);

    // Sub rumble (one octave below fundamental)
    A.sub = ctx.createOscillator(); A.sub.type = "sine";
    A.subGain = ctx.createGain(); A.subGain.gain.value = 0.0;
    A.sub.connect(A.subGain); A.subGain.connect(A.engineBus);

    // Growl (odd harmonic, sawtooth)
    A.growl = ctx.createOscillator(); A.growl.type = "sawtooth";
    A.growlGain = ctx.createGain(); A.growlGain.gain.value = 0.0;
    A.growl.connect(A.growlGain); A.growlGain.connect(A.engineBus);

    // Exhaust / air noise -> bandpass
    A.noise = ctx.createBufferSource();
    A.noise.buffer = makeNoiseBuffer(ctx);
    A.noise.loop = true;
    A.noiseBP = ctx.createBiquadFilter();
    A.noiseBP.type = "bandpass";
    A.noiseBP.frequency.value = 300;
    A.noiseBP.Q.value = 0.9;
    A.noiseGain = ctx.createGain(); A.noiseGain.gain.value = 0.0;
    A.noise.connect(A.noiseBP); A.noiseBP.connect(A.noiseGain);
    A.noiseGain.connect(A.engineBus);

    // Vibrato LFO for EV/jet shimmer (modulates main osc detune)
    A.lfo = ctx.createOscillator(); A.lfo.frequency.value = 6.5;
    A.lfoGain = ctx.createGain(); A.lfoGain.gain.value = 0;
    A.lfo.connect(A.lfoGain); A.lfoGain.connect(A.osc.detune);

    // Idle "lump" LFO — gentle amplitude wobble at idle
    A.lump = ctx.createOscillator(); A.lump.type = "sine"; A.lump.frequency.value = 8;
    A.lumpGain = ctx.createGain(); A.lumpGain.gain.value = 0;
    A.lump.connect(A.lumpGain); A.lumpGain.connect(A.engineBus.gain);

    applyVoice(S.voiceKey, true);

    A.osc.start(); A.sub.start(); A.growl.start();
    A.noise.start(); A.lfo.start(); A.lump.start();

    // fade engine in
    A.engineBus.gain.setTargetAtTime(1.0, ctx.currentTime, 0.4);
  }

  function applyVoice(key, initial) {
    const v = VOICES[key];
    if (!ctx || !v) return;
    // periodic wave from harmonic recipe
    const real = new Float32Array(v.wave.length);
    const imag = new Float32Array(v.wave.length);
    for (let i = 0; i < v.wave.length; i++) imag[i] = v.wave[i];
    const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    A.osc.setPeriodicWave(wave);
    A.lfoGain.gain.setTargetAtTime(v.vibrato * 60, ctx.currentTime, 0.1);
    // rebuild shaper for this voice's grit + mode
    const drive = v.drive * (S.sport ? 1.5 : 1) * (S.boost ? 1.3 : 1);
    A.shaper.curve = makeShaper(ctx, Math.min(drive, 0.95)).curve;
  }

  /* ---------------------------------------------------------------
     PER-FRAME UPDATE: physics + audio parameter mapping

     Driven by setInterval, NOT requestAnimationFrame: browsers stop
     calling rAF entirely for a backgrounded page, which would freeze the
     engine mid-rev the moment the driver switches to Nav. Pages playing
     audible audio are exempt from timer throttling, so an interval keeps
     running. A separate rAF pass handles the gauges (no point repainting
     a hidden screen).
  ---------------------------------------------------------------- */
  let tickId = null, gaugeRaf = null, lastT = 0;
  const TICK_MS = 1000 / 60;

  // Engine tick — must keep running even when the page is hidden.
  function frame() {
    const now = performance.now() / 1000;
    let dt = now - lastT;
    lastT = now;
    if (!ctx) return;
    if (dt <= 0 || dt > 0.25) dt = 1 / 60;

    updatePhysics(dt);
    updateAudio();
  }

  // Gauges — visual only, so rAF (which pauses when hidden) is correct.
  function paintGauges() {
    gaugeRaf = requestAnimationFrame(paintGauges);
    if (ctx) updateUI();
  }

  function updatePhysics(dt) {
    // Smooth incoming speed
    S.speed += (S.rawSpeed - S.speed) * Math.min(1, dt * 4);

    // Acceleration measured over a ~1.2 s window. A frame-to-frame delta
    // is useless here: GPS only reports about once a second, so the
    // smoothed speed is a staircase and per-frame deltas spike on every
    // fix — which used to pulse the throttle estimate and make the
    // gearbox hunt while cruising at a constant speed.
    S.accelHist.push({ t: performance.now(), v: S.speed });
    while (S.accelHist.length > 2 && performance.now() - S.accelHist[0].t > 1200) {
      S.accelHist.shift();
    }
    const a0 = S.accelHist[0];
    const span = (performance.now() - a0.t) / 1000;
    const accel = span > 0.25 ? (S.speed - a0.v) / span : 0;

    const usingGps = S.useGps && S.gpsOk;

    // No fix for a while? Bleed speed off gradually rather than holding a
    // stale number forever, so a long dropout winds the engine down
    // naturally instead of freezing the speedo at highway speed.
    if (usingGps && S.lastFixAt && performance.now() - S.lastFixAt > 4000) {
      S.rawSpeed = Math.max(0, S.rawSpeed - dt * 1.5);
    }

    if (!S.power) {
      // engine off — glide rpm to 0, throttle 0
      S.throttle += (0 - S.throttle) * Math.min(1, dt * 3);
      S.rpm += (0 - S.rpm) * Math.min(1, dt * 2);
      return;
    }

    if (usingGps) {
      // Throttle estimated from acceleration (drives tone/loudness + how
      // long gears are held), but NOT the gear choice itself.
      const accelN = clamp(accel / 2.2, -1, 1);
      const target = clamp(0.15 + Math.max(0, accelN) * 0.85 + (accel < -0.4 ? -0.12 : 0), 0, 1);
      S.throttle += (target - S.throttle) * Math.min(1, dt * 5);

      // A second, heavily damped load signal drives GEAR choices. Tone can
      // react fast; gear selection must not, or a single GPS blip shifts.
      S.gearLoad += (target - S.gearLoad) * Math.min(1, dt * 0.7);

      // Hysteresis gearbox: upshift above one rpm, downshift below a much
      // lower one. The gap is wider than a gear step, so a shift can never
      // immediately trigger its own reverse — no hunting at steady speed.
      const upAt = (S.sport ? 3400 : 2400) + S.gearLoad * (S.sport ? 3200 : 3400);
      const downAt = (S.sport ? 1700 : 1250) + S.gearLoad * 1500;
      const curRpm = engineRpmFor(S.speed, S.gear - 1);
      const canShift = (performance.now() - S.lastShift) > SHIFT_COOLDOWN;
      if (canShift) {
        if (curRpm > upAt && S.gear < GEARS.length) {
          S.gear++; S.lastShift = performance.now(); S.shiftAt = performance.now();
        } else if (curRpm < downAt && S.gear > 1) {
          S.gear--; S.lastShift = performance.now(); S.shiftAt = performance.now();
        }
      }
      const rpm = engineRpmFor(S.speed, S.gear - 1);
      S.rpm += (clamp(rpm, IDLE_RPM, REDLINE) - S.rpm) * Math.min(1, dt * 6);
    } else {
      // Manual / parked mode — throttle slider directly revs the engine.
      const tgt = S.manualThrottle;
      S.throttle += (tgt - S.throttle) * Math.min(1, dt * 6);
      const targetRpm = IDLE_RPM + tgt * (REDLINE - IDLE_RPM);
      S.rpm += (targetRpm - S.rpm) * Math.min(1, dt * (tgt > 0.02 ? 5 : 2));
      S.gear = 1;
    }
    // idle wander
    if (S.rpm < IDLE_RPM + 40) S.rpm = IDLE_RPM + Math.sin(performance.now() / 220) * 18;
  }

  function engineRpmFor(speed, gi) {
    return IDLE_RPM + Math.max(0, speed) * GEARS[gi];
  }

  function updateAudio() {
    if (!ctx) return;
    const tc = 0.03; // smoothing time-constant
    const now = ctx.currentTime;
    const loadS = clamp(S.throttle, 0, 1);

    // Master volume + boost — shared by synth and sample engines
    const vol = S.volume * (S.boost ? 1.5 : 1.0);
    A.master.gain.setTargetAtTime(S.power ? vol : 0.0001, now, 0.05);
    A.comp.ratio.setTargetAtTime(S.boost ? 8 : 2, now, 0.1);
    A.comp.threshold.setTargetAtTime(S.boost ? -30 : -18, now, 0.1);
    A.hpf.frequency.setTargetAtTime(S.boost ? 130 : 20, now, 0.1);

    // Real-sample engine: pitch-bend each loop to the current rpm and
    // crossfade between the loops bracketing it.
    if (SMP.active) {
      SMP.nodes.forEach((node, i) => {
        // per-loop wobble phase, so loops decorrelate instead of moving as one
        const ph = i * 2.399;
        const wob = 1 + 0.005 * Math.sin(now * 4.3 + ph)
                      + 0.004 * Math.sin(now * 1.7 + ph * 1.7)
                      + 0.003 * Math.sin(now * 0.53 + ph * 2.3);
        const want = (S.rpm / node.rpm) * wob;
        // A recording resampled far from 1.0x loses its formants and turns
        // chipmunky/mushy, so keep the audible rate near 1.0 and fade out
        // whatever we had to give up (tracked as `stretch`, in octaves).
        node.rate = clamp(want, 0.62, 1.85);
        node.stretch = Math.abs(Math.log2(node.rate / want));
        node.src.playbackRate.setTargetAtTime(node.rate, now, tc);
      });
      applySampleGains(now, tc, loadS);

      const rev = clamp((S.rpm - IDLE_RPM) / (REDLINE - IDLE_RPM), 0, 1);
      // tone: darker when coasting, opens up on throttle and revs
      SMP.lpf.frequency.setTargetAtTime(clamp(1100 + rev * 5200 + loadS * 3200, 900, 11000), now, 0.06);
      // sub-bass body: strongest low in the rev range and on throttle
      SMP.sub.frequency.setTargetAtTime(clamp((S.rpm / 60) * 2, 25, 130), now, tc);
      SMP.subGain.gain.setTargetAtTime(
        S.power && !S.boost ? (0.05 + loadS * 0.09) * (1 - rev * 0.5) : 0, now, 0.08);
      // turbo whistle: pitch tracks rpm, comes in as you rev/load up
      if (SMP.whistleOn) {
        const wf = clamp((S.rpm / 60) * 7, 500, 4800);
        SMP.whistle.frequency.setTargetAtTime(wf, now, tc);
        SMP.whistleBP.frequency.setTargetAtTime(wf, now, tc);
        const wv = clamp((rev * 0.7 + loadS * 0.45) - 0.12, 0, 1) * 0.11;
        SMP.whistleGain.gain.setTargetAtTime(S.power ? wv : 0, now, 0.06);
      } else {
        SMP.whistleGain.gain.setTargetAtTime(0, now, 0.05);
      }
      return;
    }

    const v = VOICES[S.voiceKey];
    if (!v) return;

    // Fundamental firing frequency
    const norm = (S.rpm - IDLE_RPM) / (REDLINE - IDLE_RPM); // 0..1
    let f0 = (S.rpm / 60) * v.order;
    f0 = clamp(f0 * Math.pow(1 + norm, v.mapPow - 1), v.fMin, v.fMax);

    const load = clamp(S.throttle, 0, 1);
    const rev = clamp(norm, 0, 1);

    A.osc.frequency.setTargetAtTime(f0, now, tc);
    A.sub.frequency.setTargetAtTime(Math.max(20, f0 / 2), now, tc);
    A.growl.frequency.setTargetAtTime(f0 * 1.5, now, tc);
    A.noiseBP.frequency.setTargetAtTime(clamp(220 + rev * 2600 + load * 500, 120, 5000), now, tc);
    A.noiseBP.Q.setTargetAtTime(0.7 + load * 1.5, now, tc);

    // Layer levels — throttle brings in growl & noise (that "on-power" snarl)
    const base = 0.22 + rev * 0.18;
    A.oscGain.gain.setTargetAtTime(v.tone * (0.28 + rev * 0.22), now, tc);
    A.subGain.gain.setTargetAtTime(v.sub * (0.30 + (1 - rev) * 0.12), now, tc);
    A.growlGain.gain.setTargetAtTime(v.growl * (0.05 + load * 0.42), now, tc);
    A.noiseGain.gain.setTargetAtTime(v.noise * (0.03 + load * 0.30 + rev * 0.10), now, tc);

    // Brightness opens with revs & load
    const cutoff = clamp(v.bright + rev * v.bright * v.brightRpm + load * 900, 300, 12000);
    A.lpf.frequency.setTargetAtTime(cutoff, now, tc);

    // idle lump only near idle
    A.lumpGain.gain.setTargetAtTime((1 - Math.min(1, norm * 6)) * 0.06, now, 0.1);
    A.lump.frequency.setTargetAtTime(Math.max(6, f0 / 8), now, tc);
    void base;
  }

  /* ---------------------------------------------------------------
     UI
  ---------------------------------------------------------------- */
  const el = (id) => document.getElementById(id);
  let ui = {};

  function updateUI() {
    const mph = S.speed * 2.236936;
    const kmh = S.speed * 3.6;
    const shown = S.units === "mph" ? mph : kmh;
    ui.speedVal.textContent = Math.round(shown);
    ui.rpmVal.textContent = Math.round(S.rpm);
    const pct = clamp((S.rpm - IDLE_RPM) / (REDLINE - IDLE_RPM), 0, 1) * 100;
    ui.tachFill.style.width = pct + "%";
    ui.tachFill.classList.toggle("redline", S.rpm > REDLINE - 500);
    ui.gearBox.textContent = (!S.power) ? "—" : (S.useGps && S.gpsOk ? S.gear : "P");
  }

  function buildVoiceChips() {
    const wrap = el("voices");
    if (!wrap) return;
    wrap.innerHTML = "";
    const addChip = (k, name, emoji) => {
      const b = document.createElement("button");
      b.className = "voice" + (k === S.voiceKey ? " active" : "");
      b.dataset.k = k;
      b.innerHTML = `<span class="v-emoji">${emoji}</span><span class="v-name">${name}</span>`;
      b.addEventListener("click", () => selectVoice(k));
      wrap.appendChild(b);
    };
    // Only real recordings get chips; the synth engine survives solely as
    // an invisible fallback for when no sample can be loaded (offline).
    Object.keys(SMP.packs).forEach((k) => addChip(k, SMP.packs[k].name, SMP.packs[k].emoji));
    const plus = document.createElement("button");
    plus.className = "voice add-voice";
    plus.innerHTML = `<span class="v-emoji">➕</span><span class="v-name">Add sound</span>`;
    plus.addEventListener("click", () => el("soundFile").click());
    wrap.appendChild(plus);
  }

  function selectVoice(k) {
    S.voiceKey = k;
    document.querySelectorAll(".voice").forEach((b) =>
      b.classList.toggle("active", b.dataset.k === k));
    if (ctx) {
      if (k.startsWith("smp:")) activateSample(k);
      else { deactivateSample(); applyVoice(k); }
    }
    save();
  }

  async function addSoundFile(file) {
    if (!file || !ctx) return;
    try {
      const data = await file.arrayBuffer();
      await ctx.decodeAudioData(data.slice(0)); // verify it decodes
      const key = "my-" + Date.now();
      const name = (file.name.replace(/\.[^.]+$/, "") || "My sound").slice(0, 18);
      try { await idbPut(key, { name, rpm: 3000, data }); } catch (e) { /* still usable this session */ }
      SMP.packs["smp:" + key] = {
        name, emoji: "🎧", custom: true,
        loops: [{ rpm: 3000, data, buffer: null }],
      };
      buildVoiceChips();
      selectVoice("smp:" + key);
    } catch (e) {
      setStatus("Couldn't read that file — use an MP3/WAV engine loop.");
    }
  }

  /* ---------------------------------------------------------------
     GPS
  ---------------------------------------------------------------- */
  function startGps() {
    if (!("geolocation" in navigator)) {
      setStatus("This browser has no location access — use manual throttle.");
      return;
    }
    setStatus("Requesting location…");
    S.gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const firstFix = !S.gpsOk;
        S.gpsOk = true;
        setSrc(true);
        let sp = pos.coords.speed; // m/s, may be null
        if (sp == null || isNaN(sp) || sp < 0) sp = deriveSpeedFrom(pos);
        S.rawSpeed = clamp(sp, 0, 90); // ignore absurd fixes (~200 mph cap)
        S.lastFixAt = performance.now();
        // Engaging GPS mid-drive must not start in 1st and climb: that
        // slammed the engine to redline for a couple of seconds. Snap
        // straight to a sane gear for the speed we're already doing.
        if (firstFix) {
          S.speed = S.rawSpeed;
          S.accelHist = [];
          S.gear = 1;
          for (let g = GEARS.length - 1; g >= 0; g--) {
            if (engineRpmFor(S.rawSpeed, g) >= 1800) { S.gear = g + 1; break; }
          }
          S.rpm = engineRpmFor(S.rawSpeed, S.gear - 1);
        }
        setStatus("");
      },
      (err) => {
        S.gpsOk = false; setSrc(false);
        if (err.code === 1) {
          // permission denied — actually off; user must re-enable
          setStatus("Location blocked — allow location access, or use manual throttle.");
          setToggle("gpsBtn", false);
          stopGps();               // release the watch and reset the pill
          S.useGps = false;
        } else {
          // Transient dropout (tunnel, cold start). Keep GPS "live" and
          // keep driving off the last known speed — dropping to idle while
          // the speedometer still read 60 was worse than coasting. The
          // next good fix takes over seamlessly.
          setStatus("GPS signal lost — coasting…");
        }
      },
      { enableHighAccuracy: true, maximumAge: 500, timeout: 10000 }
    );
  }

  // Fallback when coords.speed isn't provided: distance between fixes / time.
  let _lastFix = null;
  function deriveSpeedFrom(pos) {
    const c = pos.coords, tms = pos.timestamp;
    if (_lastFix) {
      const d = haversine(_lastFix.lat, _lastFix.lon, c.latitude, c.longitude);
      const dt = (tms - _lastFix.t) / 1000;
      _lastFix = { lat: c.latitude, lon: c.longitude, t: tms };
      if (dt > 0 && dt < 5) return clamp(d / dt, 0, 90);
    } else {
      _lastFix = { lat: c.latitude, lon: c.longitude, t: tms };
    }
    return 0;
  }

  function haversine(la1, lo1, la2, lo2) {
    const R = 6371000, r = Math.PI / 180;
    const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 +
      Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function stopGps() {
    if (S.gpsWatchId != null) navigator.geolocation.clearWatch(S.gpsWatchId);
    S.gpsWatchId = null; S.gpsOk = false; S.rawSpeed = 0; setSrc(false);
  }

  function setSrc(on) {
    ui.srcPill.textContent = on ? "GPS live" : "GPS off";
    ui.srcPill.classList.toggle("src-on", on);
    ui.srcPill.classList.toggle("src-off", !on);
  }

  /* ---------------------------------------------------------------
     WAKE LOCK — keep the Tesla/phone screen awake
  ---------------------------------------------------------------- */
  let wakeLock = null;
  async function requestWake() {
    try {
      if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
        document.addEventListener("visibilitychange", async () => {
          if (wakeLock !== null && document.visibilityState === "visible") {
            try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
          }
        });
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------
     HELPERS
  ---------------------------------------------------------------- */
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function setStatus(t) { ui.status.textContent = t || ""; }
  function setToggle(id, on) {
    const b = el(id); if (!b) return;
    b.dataset.on = on ? "true" : "false";
    b.classList.toggle("on", !!on);
  }

  function save() {
    try {
      localStorage.setItem("evroar", JSON.stringify({
        voiceKey: S.voiceKey, sport: S.sport, boost: S.boost,
        units: S.units, volume: S.volume,
      }));
    } catch (e) {}
  }
  function load() {
    try {
      const j = JSON.parse(localStorage.getItem("evroar") || "{}");
      // only sample voices are selectable now; old synth keys migrate to default
      if (j.voiceKey && j.voiceKey.startsWith("smp:")) S.voiceKey = j.voiceKey;
      if (typeof j.sport === "boolean") S.sport = j.sport;
      if (typeof j.boost === "boolean") S.boost = j.boost;
      if (j.units) S.units = j.units;
      if (typeof j.volume === "number") S.volume = j.volume;
    } catch (e) {}
  }

  /* ---------------------------------------------------------------
     WIRE UP
  ---------------------------------------------------------------- */
  function bind() {
    ui = {
      speedVal: el("speedVal"), rpmVal: el("rpmVal"),
      tachFill: el("tachFill"), gearBox: el("gearBox"),
      srcPill: el("srcPill"), status: el("status"),
    };

    el("startBtn").addEventListener("click", start);

    el("volume").value = Math.round(S.volume * 100);
    el("volume").addEventListener("input", (e) => {
      S.volume = e.target.value / 100; save();
    });

    el("throttle").addEventListener("input", (e) => {
      S.manualThrottle = e.target.value / 100;
    });
    el("throttle").addEventListener("change", (e) => {
      // spring back to 0 like a real pedal, unless held
      if (!S.useGps) { /* keep value */ }
    });

    el("powerBtn").addEventListener("click", () => {
      S.power = !S.power;
      const b = el("powerBtn");
      b.classList.toggle("is-on", S.power);
      b.setAttribute("aria-pressed", String(S.power));
      b.querySelector(".txt").textContent = S.power ? "Engine ON" : "Engine OFF";
    });

    el("modeBtn").addEventListener("click", () => {
      S.sport = !S.sport; setToggle("modeBtn", S.sport);
      if (ctx) applyVoice(S.voiceKey); save();
    });
    el("boostBtn").addEventListener("click", () => {
      S.boost = !S.boost; setToggle("boostBtn", S.boost);
      if (ctx) applyVoice(S.voiceKey); save();
    });
    el("gpsBtn").addEventListener("click", () => {
      S.useGps = !S.useGps; setToggle("gpsBtn", S.useGps);
      updateThrottleLabel();
      if (S.useGps) startGps(); else stopGps();
    });
    el("fsBtn").addEventListener("click", async () => {
      try {
        if (!document.fullscreenElement) { await document.documentElement.requestFullscreen(); setToggle("fsBtn", true); }
        else { await document.exitFullscreen(); setToggle("fsBtn", false); }
      } catch (e) {}
    });
    el("unitBtn").addEventListener("click", () => {
      S.units = S.units === "mph" ? "kmh" : "mph";
      el("unitBtn").textContent = S.units.toUpperCase();
      save();
    });
    el("helpBtn").addEventListener("click", () => {
      const h = el("help"); h.hidden = !h.hidden;
    });
    el("soundFile").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      addSoundFile(f);
    });

    // restore visual state
    setToggle("modeBtn", S.sport);
    setToggle("boostBtn", S.boost);
    el("unitBtn").textContent = S.units.toUpperCase();
    buildVoiceChips();
    updateThrottleLabel();
  }

  function updateThrottleLabel() {
    const lbl = el("throttleLabel");
    lbl.innerHTML = S.useGps
      ? "Manual throttle <em>(GPS is driving the engine)</em>"
      : "Manual throttle <em>(rev while parked)</em>";
  }

  function start() {
    if (S.started) return;
    S.started = true;
    el("startScreen").classList.add("hide");
    setTimeout(() => { el("startScreen").style.display = "none"; }, 500);
    el("app").hidden = false;

    buildAudio();
    // resume in case suspended
    if (ctx.state === "suspended") ctx.resume();
    // discover repo sample packs + user sounds, then restore selection
    loadSamplePacks().then(() => {
      if (SMP.packs[S.voiceKey]) activateSample(S.voiceKey);
      else if (SMP.packs["smp:v8classic"]) selectVoice("smp:v8classic");
      else if (SMP.packs["smp:v8beast"]) selectVoice("smp:v8beast");
      else {
        // nothing downloadable (offline first run) — synth keeps sound alive
        selectVoice("v8");
        setStatus("Offline — using backup engine until sounds can download.");
      }
    });
    requestWake();
    lastT = performance.now() / 1000;
    tickId = setInterval(frame, TICK_MS);
    gaugeRaf = requestAnimationFrame(paintGauges);

    // Some browsers suspend the AudioContext when a tab is backgrounded;
    // resume as soon as we're visible again so sound returns instantly.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && ctx && ctx.state === "suspended") ctx.resume();
    });
  }

  // init
  load();
  document.addEventListener("DOMContentLoaded", bind);

  // service worker
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
