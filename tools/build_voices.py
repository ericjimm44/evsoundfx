from engine import render, loopify, save
import wave, array, math
def per(path, fire):
    w=wave.open(path); sr=w.getframerate(); d=array.array('h',w.readframes(w.getnframes())); w.close()
    m=sum(d)/len(d); x=[v-m for v in d]
    lag=int(round(sr/fire)); n=len(x)-lag
    num=sum(x[i]*x[i+lag] for i in range(0,n,2))
    d1=math.sqrt(sum(x[i]**2 for i in range(0,n,2))); d2=math.sqrt(sum(x[i+lag]**2 for i in range(0,n,2)))
    return num/((d1*d2) or 1)

# --- JDM Turbo: inline-6, 3 firing events per crank rev, even firing.
JDM_F = [(118,1.8,1.00),(330,1.6,0.66),(760,1.5,0.40),(1680,1.4,0.22),(3200,1.3,0.10)]
print("JDM Turbo (inline-6, order 3):")
for fn,rpm in [("jdm_idle.wav",1000),("jdm_low.wav",2200),("jdm_mid.wav",4000),("jdm_high.wav",6200)]:
    fire=rpm/60*3
    save(loopify(render(fire,3.2,JDM_F,noise_amt=0.035,jitter=0.006,pulse_w=0.0009,seed=11+rpm), fire, 3.2), fn)
    print(f"     rpm={rpm} fire={fire:.0f}Hz  r={per(fn,fire):+.3f}")

# --- EV Hyper: motor/gear whine, order 24, tighter resonances, minimal noise.
EV_F = [(430,9.0,0.85),(900,8.0,0.70),(1750,7.0,0.52),(2900,6.0,0.32),(150,3.0,0.45)]
print("EV Hyper (motor order 24):")
for fn,rpm in [("evh_idle.wav",1000),("evh_low.wav",2500),("evh_mid.wav",4500),("evh_high.wav",6500)]:
    fire=rpm/60*24
    save(loopify(render(fire,2.6,EV_F,noise_amt=0.02,jitter=0.003,pulse_w=0.0004,seed=31+rpm), fire, 2.6), fn)
    print(f"     rpm={rpm} fire={fire:.0f}Hz  r={per(fn,fire):+.3f}")
