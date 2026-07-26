"""Offline engine-sound renderer.

Models an engine as a train of combustion impulses exciting a set of FIXED
resonances (the exhaust/intake plumbing). Fixed formants are the key detail:
a real car's pipe resonances don't move when the revs rise, which is exactly
what pitch-shifting a recording gets wrong (that's the chipmunk effect). By
rendering each rpm layer separately with the same formants, the voice keeps
one identity across the whole rev range.
"""
import math, random, wave, array

SR = 44100

class Res:
    """Resonant band-pass (2-pole), excited by impulses."""
    def __init__(self, f, q, gain):
        self.gain = gain
        w = 2*math.pi*f/SR
        r = math.exp(-w/(2*q))
        self.a1 = 2*r*math.cos(w); self.a2 = -r*r
        self.y1 = 0.0; self.y2 = 0.0
    def step(self, x):
        y = x + self.a1*self.y1 + self.a2*self.y2
        self.y2 = self.y1; self.y1 = y
        return y*self.gain

def render(fire_hz, seconds, formants, noise_amt=0.25, jitter=0.02,
           uneven=None, pulse_w=0.0012, seed=7):
    """fire_hz  = combustion events per second
       formants = [(freq, Q, gain), ...] fixed resonances
       uneven   = per-cylinder amplitude pattern (firing irregularity)"""
    rnd = random.Random(seed)
    n = int(SR*seconds)
    out = [0.0]*n
    res = [Res(*f) for f in formants]
    period = SR/fire_hz
    # noise state
    pink = 0.0
    pat = uneven or [1.0]
    i = 0.0; k = 0
    events = []
    while i < n:
        events.append((int(i), pat[k % len(pat)] * (1 + rnd.uniform(-jitter, jitter))))
        i += period * (1 + rnd.uniform(-jitter, jitter))
        k += 1
    ev = dict(events)
    pw = max(1, int(SR*pulse_w))
    burst = 0
    for t in range(n):
        x = 0.0
        if t in ev:
            x = ev[t]           # combustion impulse
            burst = pw
        # turbulent noise, gated harder right after each firing
        white = rnd.uniform(-1, 1)
        pink = (pink + 0.12*white)/1.12
        g = 1.0 if burst > 0 else 0.35
        if burst > 0: burst -= 1
        x += (white*0.8 + pink*1.2) * noise_amt * g
        s = 0.0
        for r in res: s += r.step(x)
        out[t] = s
    return out

def loopify(buf, fire_hz, seconds, fade_ms=12, peak=0.82):
    """Trim to a whole number of firing cycles, then circular-crossfade."""
    period = SR/fire_hz
    ncyc = int((len(buf)-SR*0.05)//period)
    n = int(round(ncyc*period))
    x = buf[:n+int(SR*fade_ms/1000)]
    fade = int(SR*fade_ms/1000)
    out = x[:n]
    for i in range(min(fade, len(out))):
        t = i/fade
        out[i] = out[i]*t + x[n+i]*(1-t)
    # dc removal + normalize
    m = sum(out)/len(out)
    out = [v-m for v in out]
    mx = max(abs(v) for v in out) or 1
    g = peak*32767/mx
    return array.array('h', [int(max(-32768, min(32767, v*g))) for v in out])

def save(samples, path):
    w = wave.open(path, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(samples.tobytes()); w.close()
    print(f"  {path}  {len(samples)/SR:.2f}s")
