# Real engine sounds

## Included sounds & credits

| Voice | Files | Source | License |
| --- | --- | --- | --- |
| 🚗 V8 Classic | `classic_low/high.wav` | ["Generic V8 Engine Sound" by DerMeehdrescher / Meehdrescher Studios](https://opengameart.org/content/generic-v8-engine-sound) | **CC-BY-SA 4.0** |
| 🌀 Turbo Sport | `tbody_low.wav` | ["Car Engine Loop 96kHz" by qubodup](https://opengameart.org/content/car-engine-loop-96khz-4s) | **CC-BY 3.0** |

`jdm_*.wav` (JDM Turbo) and `evh_*.wav` (EV Hyper) are **synthesized in-house**
by [`../tools/`](../tools/) and carry no third-party rights.

All loops were lightly processed (mono/resample/normalize plus a ~12–15 ms
crossfade at the loop seam so they cycle without clicks). CC-BY files require
the attribution above; the CC-BY-SA files remain under
[CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) — keep the
credits if you redistribute.

## Adding more

Drop your own engine loops in this folder — the app pitch-tracks each loop to
the live RPM and crossfades between them.

## Quickest way (no repo needed)

In the app, tap the **➕ Add sound** chip and pick an MP3/WAV from the device.
It's stored on that device (IndexedDB) and shows up as a new voice.

## Permanent way (works on every device, including the Tesla)

1. Download or record engine loops. Best results: **short seamless loops
   (1–10 s) at a steady RPM** — e.g. one at idle, one at cruise, one high.
2. Upload the files to this `samples/` folder (GitHub → *Add file → Upload
   files*).
3. Edit `pack.json` and describe them:

```json
{
  "voices": [
    {
      "key": "mustang",
      "name": "Mustang GT",
      "emoji": "🐎",
      "loops": [
        { "file": "mustang_idle.mp3", "rpm": 900 },
        { "file": "mustang_mid.mp3",  "rpm": 3000 },
        { "file": "mustang_high.mp3", "rpm": 5500 }
      ]
    }
  ]
}
```

- `rpm` is **not a label** — it is the denominator of the pitch shift
  (`playbackRate = currentRPM / loop.rpm`). Two loops only agree in pitch if
  their rpm values are in the same ratio as their *actual* recorded pitches.
  Getting this wrong is what made every voice sound detuned in earlier
  versions, so measure rather than guess.
- One loop works; **three loops at different RPMs sounds dramatically better**
  because pitch-shifting a single clip too far sounds chipmunky/droney.
- Reload the app once after uploading (the service worker fetches
  `samples/` network-first, so new packs appear on the next load).

## Where to find sounds (legally)

| Source | License notes |
| --- | --- |
| [freesound.org](https://freesound.org) | Filter by license **Creative Commons 0** for worry-free use |
| [pixabay.com/sound-effects](https://pixabay.com/sound-effects/) | Royalty-free, no attribution needed |
| [BBC Sound Effects](https://sound-effects.bbcrewind.co.uk) | Free for **personal** use |
| Record your own | Point a phone at a friend's car — 100% yours |

Search terms that work well: *"V8 engine loop"*, *"engine idle loop"*,
*"engine rpm steady"*, *"motorcycle idle"*, *"muscle car interior"*.

**This repo is public** — only commit files whose license allows
redistribution (CC0 is the safe pick). Sounds added via **➕ Add sound** stay
on your device and are never uploaded anywhere.
