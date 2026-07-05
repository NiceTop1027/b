// Audio layer — implements IAudio from client/contracts. Everything is
// synthesized with WebAudio (no assets, works offline). The context is only
// created inside unlock(), which the core calls after a user gesture.

import type { GameEvent } from '../shared/types';
import type { IAudio } from './contracts';

export function createAudio(): IAudio {
  return new AudioImpl();
}

const MASTER_LEVEL = 0.8;
const AMBIENT_LEVEL = 0.3;

class AudioImpl implements IAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private ambient: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  private muted = false;
  private ambientOn = false;
  private lastPlayed = new Map<string, number>();

  unlock(): void {
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch {
        return;
      }
      this.buildGraph();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  playEvent(ev: GameEvent): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || this.muted) return;
    if (ctx.state !== 'running') return;

    // throttle: snapshots can batch several identical events
    const key = ev.kind + (ev.hitType ?? '');
    const now = ctx.currentTime;
    const last = this.lastPlayed.get(key) ?? -1;
    if (now - last < 0.06) return;
    this.lastPlayed.set(key, now);

    switch (ev.kind) {
      case 'hit':
        switch (ev.hitType) {
          case 'spike':
            this.noise(now, 0.16, 'bandpass', 950, 0.8, 0.5);
            this.tone(now, 110, 0.12, 'sine', 0.35, 55);
            break;
          case 'serve':
            this.noise(now, 0.12, 'lowpass', 1000, 1, 0.3);
            this.tone(now, 170, 0.1, 'sine', 0.22, 120);
            break;
          case 'attack':
            this.noise(now, 0.13, 'lowpass', 1200, 1, 0.35);
            this.tone(now, 150, 0.1, 'sine', 0.28, 90);
            break;
          case 'block':
            this.noise(now, 0.09, 'bandpass', 1600, 1.4, 0.4);
            break;
          default: // pass
            this.noise(now, 0.1, 'lowpass', 650, 1, 0.25);
            this.tone(now, 200, 0.08, 'sine', 0.16, 150);
            break;
        }
        break;

      case 'block':
        this.noise(now, 0.1, 'bandpass', 1500, 1.2, 0.4);
        this.tone(now, 130, 0.08, 'sine', 0.2, 80);
        break;

      case 'net':
        this.noise(now, 0.18, 'lowpass', 320, 1, 0.35);
        break;

      case 'netcord': {
        // twang: quick pitch-wobbled ping over a thud
        this.noise(now, 0.12, 'lowpass', 400, 1, 0.25);
        this.tone(now, 620, 0.22, 'triangle', 0.22, 480);
        this.tone(now + 0.05, 500, 0.16, 'triangle', 0.12, 430);
        break;
      }

      case 'land':
        this.noise(now, 0.22, 'lowpass', 420, 1, 0.45);
        break;

      case 'score':
        this.tone(now, 660, 0.14, 'sine', 0.22);
        this.tone(now + 0.13, 880, 0.22, 'sine', 0.22);
        break;

      case 'matchOver':
        [523, 659, 784, 1047].forEach((f, i) => {
          this.tone(now + i * 0.15, f, 0.3, 'triangle', 0.2);
        });
        break;

      case 'denied':
        this.tone(now, 130, 0.11, 'square', 0.07, 95);
        break;

      case 'phase':
        // referee: pip-pip on each new serve
        if (ev.phase === 'serve') {
          this.tone(now, 2200, 0.08, 'sine', 0.1);
          this.tone(now + 0.12, 2200, 0.09, 'sine', 0.1);
        }
        break;
    }
  }

  setAmbient(on: boolean): void {
    this.ambientOn = on;
    if (this.ctx && this.ambient) {
      this.ambient.gain.setTargetAtTime(on ? AMBIENT_LEVEL : 0, this.ctx.currentTime, 0.8);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, this.ctx.currentTime, 0.04);
    }
  }

  // ── graph & synth helpers ──────────────────────────────────

  private buildGraph(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER_LEVEL;
    this.master.connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);

    // 2 s of reusable white noise
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // ── ambient: waves (slow LFO on filtered noise) + faint crowd ──
    this.ambient = ctx.createGain();
    this.ambient.gain.value = this.ambientOn ? AMBIENT_LEVEL : 0;
    this.ambient.connect(this.master);

    const waves = ctx.createBufferSource();
    waves.buffer = this.noiseBuf;
    waves.loop = true;
    const waveFilter = ctx.createBiquadFilter();
    waveFilter.type = 'lowpass';
    waveFilter.frequency.value = 420;
    const waveGain = ctx.createGain();
    waveGain.gain.value = 0.5;
    waves.connect(waveFilter).connect(waveGain).connect(this.ambient);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.3;
    lfo.connect(lfoDepth).connect(waveGain.gain);

    const crowd = ctx.createBufferSource();
    crowd.buffer = this.noiseBuf;
    crowd.loop = true;
    crowd.playbackRate.value = 0.5;
    const crowdFilter = ctx.createBiquadFilter();
    crowdFilter.type = 'bandpass';
    crowdFilter.frequency.value = 900;
    crowdFilter.Q.value = 0.6;
    const crowdGain = ctx.createGain();
    crowdGain.gain.value = 0.12;
    crowd.connect(crowdFilter).connect(crowdGain).connect(this.ambient);

    waves.start();
    crowd.start();
    lfo.start();
  }

  /** Short pitched blip with exponential decay; optional pitch slide. */
  private tone(
    t0: number,
    freq: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    slideTo?: number,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.sfx!);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /** Filtered noise burst with a fast attack and exponential decay. */
  private noise(
    t0: number,
    dur: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    gain: number,
  ): void {
    const ctx = this.ctx!;
    if (!this.noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.loopStart = Math.random(); // decorrelate overlapping bursts
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(this.sfx!);
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.03);
  }
}
