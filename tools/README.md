# Voice synthesis tools

`JDM Turbo` and `EV Hyper` are generated here rather than recorded, which
removes the two limits every found recording hit:

1. **Exact pitch tags.** `playbackRate = currentRPM / loop.rpm`, so two loops
   only agree in pitch if their rpm tags are in the same ratio as their real
   pitches. Synthesized layers know their own firing frequency exactly, so
   the tags are correct by construction rather than measured after the fact.
2. **Full rev-range coverage.** Found recordings capture an engine at one or
   two operating points (our best was 1.4x of pitch span), so the ends of the
   rev range get stretched badly. These render a layer *at* each rpm, so
   playbackRate stays near 1.0 across the whole range.

## The model

An engine is a train of combustion impulses exciting the resonances of its
exhaust and intake plumbing. The important detail is that **those resonances
are fixed** — a real pipe doesn't change length when the revs rise. Pitch-
shifting a recording moves them, which is exactly the chipmunk effect. Here
each rpm layer is rendered through the *same* fixed formants, so the voice
keeps one identity from idle to redline.

- `engine.py` — the renderer: impulse train, per-cylinder jitter, damped
  resonators, turbulent noise, and a loop trimmer that cuts to a whole number
  of firing cycles and circular-crossfades the seam.
- `build_voices.py` — the two voice definitions, and prints a periodicity
  score for each rendered layer.

## Rebuilding

```sh
cd tools && python3 build_voices.py && mv *.wav ../samples/
```

Tuning notes: `noise_amt` trades tonality for turbulence (0.02 is nearly pure,
0.22 is mush — real recordings measure a periodicity score of about 0.05-0.25,
and 0.035 lands there). Resonator `Q` must be low enough that a pulse decays
before the next one arrives, or successive cycles stop matching. Engine
`order` sets the character: 3 for an inline-6, 4 for a V8, 24 for motor whine.
