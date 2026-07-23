# EV Roar — engine sound for your (silent) EV

A tiny web app that gives an electric car a voice. It **synthesizes an engine
sound in real time** and makes it rise, shift, and settle with your **actual
GPS speed** — a from-scratch, no-subscription recreation of the idea behind
*EVsoundfx.com*, built to run in the **Tesla browser** through the car speakers.

Everything is generated live with the Web Audio API. There are **no sound
files**, no accounts, and no network calls — so it installs as an offline PWA
and every "voice" is free.

## Voices

| Voice | Character |
| --- | --- |
| 🏁 **V8 Muscle** | Deep combustion rumble with a growl on throttle |
| 🌀 **Turbo Sport** | Tighter, raspier four/six with turbo air |
| 🛸 **Spaceship EV** | Sci-fi inverter whine that climbs with speed |
| ✈️ **Jet Turbine** | Filtered air + rising turbine whine |

## How it works

- **Speed → revs.** GPS speed (`coords.speed`, with a distance/time fallback)
  feeds a simulated 6-speed gearbox: revs climb within a gear, the box shifts
  up/down, and coasting eases off like engine braking.
- **Live synthesis.** A custom-harmonic oscillator sets the firing note
  (`f0 = rpm/60 × engine-order`), layered with a sub-octave rumble, an
  odd-harmonic growl, and band-passed exhaust noise. Throttle and revs open a
  low-pass filter and add grit through a waveshaper — so it brightens and
  snarls under load.
- **Modes.** *Sport* shifts later and adds bite. *Exterior boost* maxes
  loudness and compression for a Bluetooth speaker mounted outside the car.
- **Parked?** Use the **manual throttle** slider to rev it in place.

## Run it on your Tesla

1. Publish this folder over HTTPS (GitHub Pages works — see below), then open
   the URL in the **Tesla web browser**.
2. Tap **Tap to Start**, then **allow location** so the sound reacts to speed.
3. Turn on **Use GPS speed**, set the volume, pick a voice. Audio plays through
   the car speakers.
4. Keep the browser tab in the foreground while moving — browsers pause audio
   and sensors when a tab is fully backgrounded.

> Drive responsibly. Keep the volume safe and legal, and never let audio
> distract from the road. Not affiliated with Tesla or any manufacturer.

## Run it locally

No build step. A service worker needs HTTP (not `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000/evsoundfx/
```

Tap **Use GPS speed** off and drag the **manual throttle** to hear it at a desk.

## Publish with GitHub Pages

This app lives in the `evsoundfx/` subfolder of the site. With Pages enabled
(Settings → Pages → deploy from branch → root), it's served at:

```
https://<your-username>.github.io/evsoundfx/
```

## Stack

Vanilla HTML/CSS/JS + Web Audio API. Installable, offline-first PWA. ~0 KB of
audio assets — the engine is math.
