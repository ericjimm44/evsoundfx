"""Renders every synthesized voice in the pack. Run, then move *.wav to samples/."""
from engine import render, loopify, save
import wave, array, math

def periodicity(path, fire):
    w=wave.open(path); sr=w.getframerate(); d=array.array('h',w.readframes(w.getnframes())); w.close()
    m=sum(d)/len(d); x=[v-m for v in d]
    lag=int(round(sr/fire)); n=len(x)-lag
    num=sum(x[i]*x[i+lag] for i in range(0,n,2))
    d1=math.sqrt(sum(x[i]**2 for i in range(0,n,2))); d2=math.sqrt(sum(x[i+lag]**2 for i in range(0,n,2)))
    return num/((d1*d2) or 1)

def damp_for(formants, fire, frac=0.8):
    """Cap each resonator's ring time at a fraction of the firing period. A
       resonance still ringing when the next combustion arrives rings at its
       own frequency rather than the engine's, so successive cycles differ —
       audible as an unsteady, detuned note. Physically right too: at high
       rpm a low resonance is driven continuously and locks to the firing
       rate instead of ringing free."""
    return [(f, min(q, max(0.5, frac*(1.0/fire)*math.pi*f)), g) for f,q,g in formants]

def build(name, order, formants, layers, noise, jitter, pulse_w, secs,
          uneven=None, seed0=11):
    print(f"{name} (order {order}):")
    for fn, rpm in layers:
        fire = rpm/60*order
        buf = render(fire, secs, damp_for(formants, fire), noise_amt=noise,
                     jitter=jitter, uneven=uneven, pulse_w=pulse_w, seed=seed0+rpm)
        save(loopify(buf, fire, secs), fn)
        print(f"     rpm={rpm} fire={fire:6.1f}Hz  r={periodicity(fn, fire):+.3f}")

# --- JDM Turbo: inline-6, evenly spaced (an I6 is inherently balanced; that
#     smoothness is what separates a 2JZ/RB26 note from a lumpy V8).
build("JDM Turbo", 3,
      [(118,1.8,1.00),(330,1.6,0.66),(760,1.5,0.40),(1680,1.4,0.22),(3200,1.3,0.10)],
      [("jdm_idle.wav",1000),("jdm_low.wav",2200),("jdm_mid.wav",4000),("jdm_high.wav",6200)],
      noise=0.035, jitter=0.006, pulse_w=0.0009, secs=3.2, seed0=11)

# --- Turbo Sport: inline-4. Formants measured from tbody_low.wav, the
#     recorded loop this voice used before, so it keeps that character but
#     now covers the whole rev range. The 860 Hz peak is its rasp.
build("Turbo Sport", 2,
      [(60,2.0,1.00),(150,2.2,0.78),(300,2.0,0.55),(860,3.0,0.72),(1000,2.6,0.50),(2100,1.8,0.22)],
      [("turbo_idle.wav",1000),("turbo_low.wav",2400),("turbo_mid.wav",4200),("turbo_high.wav",6400)],
      noise=0.05, jitter=0.008, pulse_w=0.0012, secs=3.4,
      uneven=[1.0,0.94,1.03,0.97], seed0=77)

# --- EV Hyper: not combustion. Motor/gear whine at electrical order 24 with
#     inverter harmonics, high-Q resonances, so it sings instead of pulsing.
build("EV Hyper", 24,
      [(430,9.0,0.85),(900,8.0,0.70),(1750,7.0,0.52),(2900,6.0,0.32),(150,3.0,0.45)],
      [("evh_idle.wav",1000),("evh_low.wav",2500),("evh_mid.wav",4500),("evh_high.wav",6500)],
      noise=0.02, jitter=0.003, pulse_w=0.0004, secs=2.6, seed0=31)
