/* =====================================================================
   EV ROAR — live-synthesized engine sound that reacts to real GPS speed.
   Vanilla JS + Web Audio API. No sound files, no network, works offline.
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
      name: "V8 Muscle", emoji: "🏁",
      order: 4, mapPow: 1.0, fMin: 30, fMax: 470,
      sub: 0.9, growl: 0.5, tone: 1.0, noise: 0.5,
      wave: [0, 1, 0.6, 0.9, 0.35, 0.6, 0.2, 0.4, 0.15, 0.25],
      bright: 520, brightRpm: 3.2, drive: 0.35, vibrato: 0,
    },
    turbo: {
      name: "Turbo Sport", emoji: "🌀",
      order: 3, mapPow: 1.05, fMin: 45, fMax: 620,
      sub: 0.55, growl: 0.6, tone: 0.9, noise: 0.85,
      wave: [0, 1, 0.35, 0.7, 0.2, 0.5, 0.18, 0.35, 0.12],
      bright: 700, brightRpm: 5.0, drive: 0.5, vibrato: 0,
    },
    ev: {
      name: "Spaceship EV", emoji: "🛸",
      order: 6, mapPow: 1.35, fMin: 90, fMax: 1650,
      sub: 0.3, growl: 0.25, tone: 1.0, noise: 0.12,
      wave: [0, 1, 0.15, 0.5, 0.1, 0.28, 0.08, 0.18],
      bright: 1400, brightRpm: 6.5, drive: 0.12, vibrato: 0.05,
    },
    jet: {
      name: "Jet Turbine", emoji: "✈️",
      order: 5, mapPow: 1.4, fMin: 120, fMax: 2200,
      sub: 0.18, growl: 0.15, tone: 0.35, noise: 1.0,
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
  const SHIFT_UP = 6100;      // rpm to upshift (Sport shifts later, set below)
  const SHIFT_DN = 2100;      // rpm to downshift
  // engine-rpm added per (m/s) of road speed, per gear. Tuned so 1st tops out
  // near 15 mph and top gear cruises revvy-but-sane at highway speed.
  const GEARS = [900, 560, 360, 240, 165, 120];

  /* ---------------------------------------------------------------
     STATE
  ---------------------------------------------------------------- */
  const S = {
    started: false,
    power: true,
    voiceKey: "v8",
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
    throttle: 0,         // 0..1 estimated load
    rpm: IDLE_RPM,
    gear: 1,             // 1-indexed
    lastShift: 0,
    gpsWatchId: null,
    gpsOk: false,
  };

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
    A.comp.ratio.value = 3;
    A.comp.attack.value = 0.004;
    A.comp.release.value = 0.15;

    A.lpf = ctx.createBiquadFilter();
    A.lpf.type = "lowpass";
    A.lpf.frequency.value = 700;
    A.lpf.Q.value = 0.7;

    A.shaper = makeShaper(ctx, 0.3);

    A.engineBus = ctx.createGain();
    A.engineBus.gain.value = 0.0; // fade in

    A.engineBus.connect(A.shaper);
    A.shaper.connect(A.lpf);
    A.lpf.connect(A.comp);
    A.comp.connect(A.master);
    A.master.connect(ctx.destination);

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
    if (!ctx) return;
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
  ---------------------------------------------------------------- */
  let rafId = null, lastT = 0;

  function frame(t) {
    rafId = requestAnimationFrame(frame);
    const now = t / 1000;
    let dt = now - lastT;
    lastT = now;
    if (!ctx) return;
    if (dt <= 0 || dt > 0.25) dt = 1 / 60;

    updatePhysics(dt);
    updateAudio();
    updateUI();
  }

  function updatePhysics(dt) {
    const v = VOICES[S.voiceKey];

    // Smooth incoming speed
    S.speed += (S.rawSpeed - S.speed) * Math.min(1, dt * 4);
    const accel = (S.speed - S.lastSpeed) / dt; // m/s^2
    S.lastSpeed = S.speed;

    const usingGps = S.useGps && S.gpsOk;

    if (!S.power) {
      // engine off — glide rpm to 0, throttle 0
      S.throttle += (0 - S.throttle) * Math.min(1, dt * 3);
      S.rpm += (0 - S.rpm) * Math.min(1, dt * 2);
      return;
    }

    if (usingGps) {
      // Throttle estimated from acceleration + speed (load).
      const accelN = clamp(accel / 2.2, -1, 1);
      const target = clamp(0.18 + Math.max(0, accelN) * 0.9 + (accel < -0.4 ? -0.15 : 0), 0, 1);
      S.throttle += (target - S.throttle) * Math.min(1, dt * 5);

      // Gearbox: pick engine rpm from speed & current gear, auto-shift.
      const shiftUp = S.sport ? REDLINE - 250 : SHIFT_UP;
      let gi = S.gear - 1;
      let rpm = engineRpmFor(S.speed, gi);

      const canShift = (performance.now() - S.lastShift) > 550;
      if (canShift && rpm > shiftUp && gi < GEARS.length - 1) {
        S.gear++; S.lastShift = performance.now();
      } else if (canShift && engineRpmFor(S.speed, gi) < SHIFT_DN && gi > 0) {
        S.gear--; S.lastShift = performance.now();
      }
      rpm = engineRpmFor(S.speed, S.gear - 1);

      // brief throttle lift right after a shift (realism)
      if (performance.now() - S.lastShift < 180) S.throttle *= 0.5;

      S.rpm += (clamp(rpm, IDLE_RPM, REDLINE) - S.rpm) * Math.min(1, dt * 8);
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
    void v;
  }

  function engineRpmFor(speed, gi) {
    return IDLE_RPM + Math.max(0, speed) * GEARS[gi];
  }

  function updateAudio() {
    if (!ctx) return;
    const v = VOICES[S.voiceKey];
    const tc = 0.03; // smoothing time-constant
    const now = ctx.currentTime;

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

    // Master volume + boost
    const vol = S.volume * (S.boost ? 1.35 : 1.0);
    A.master.gain.setTargetAtTime(S.power ? vol : 0.0001, now, 0.05);
    A.comp.ratio.setTargetAtTime(S.boost ? 8 : 3, now, 0.1);
    A.comp.threshold.setTargetAtTime(S.boost ? -26 : -18, now, 0.1);
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
    wrap.innerHTML = "";
    VOICE_ORDER.forEach((k) => {
      const v = VOICES[k];
      const b = document.createElement("button");
      b.className = "voice" + (k === S.voiceKey ? " active" : "");
      b.dataset.k = k;
      b.innerHTML = `<span class="v-emoji">${v.emoji}</span><span class="v-name">${v.name}</span>`;
      b.addEventListener("click", () => selectVoice(k));
      wrap.appendChild(b);
    });
  }

  function selectVoice(k) {
    S.voiceKey = k;
    document.querySelectorAll(".voice").forEach((b) =>
      b.classList.toggle("active", b.dataset.k === k));
    if (ctx) applyVoice(k);
    save();
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
        S.gpsOk = true;
        setSrc(true);
        let sp = pos.coords.speed; // m/s, may be null
        if (sp == null || isNaN(sp) || sp < 0) sp = deriveSpeedFrom(pos);
        S.rawSpeed = sp;
        setStatus("");
      },
      (err) => {
        S.gpsOk = false; setSrc(false);
        setStatus("Location blocked (" + err.message + "). Using manual throttle.");
        setToggle("gpsBtn", false); S.useGps = false;
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
      if (j.voiceKey && VOICES[j.voiceKey]) S.voiceKey = j.voiceKey;
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
    requestWake();
    lastT = performance.now() / 1000;
    rafId = requestAnimationFrame(frame);
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
