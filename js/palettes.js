/**
 * palettes.js
 * Four palette definitions. Each palette exposes:
 *   name, type ('melodic'|'drum'), params, knobs[], createVoice()
 * For drum palette also: createDrumVoice()
 *
 * createVoice(ctx, output, freq, velocity, startTime) → { stop(time) }
 */

// ─── Shared helpers ──────────────────────────────────────────────────────────

function noteToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function applyADSR(gain, params, startTime, velocity) {
  const { attack, decay, sustain } = params;
  const v = velocity || 1;
  gain.gain.cancelScheduledValues(startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(v, startTime + attack);
  gain.gain.linearRampToValueAtTime(v * sustain, startTime + attack + decay);
}

// ─── Classic Synth ───────────────────────────────────────────────────────────

const classicPalette = {
  name: 'Classic Synth',
  type: 'melodic',
  params: {
    waveform: 'sawtooth',
    attack: 0.01,
    decay: 0.15,
    sustain: 0.65,
    release: 0.4,
    cutoff: 2200,
    resonance: 2,
    reverb: 0.2,
  },
  knobs: [
    { key: 'attack',    label: 'ATK',    min: 0.001, max: 2.0,   step: 0.001, fmt: 's' },
    { key: 'decay',     label: 'DEC',    min: 0.001, max: 2.0,   step: 0.001, fmt: 's' },
    { key: 'sustain',   label: 'SUS',    min: 0,     max: 1.0,   step: 0.01,  fmt: '' },
    { key: 'release',   label: 'REL',    min: 0.01,  max: 4.0,   step: 0.01,  fmt: 's' },
    { key: 'cutoff',    label: 'CUTOFF', min: 80,    max: 18000, step: 1,     fmt: 'Hz', log: true },
    { key: 'resonance', label: 'RESO',   min: 0.1,   max: 20,    step: 0.1,   fmt: '' },
    { key: 'reverb',    label: 'REVERB', min: 0,     max: 1,     step: 0.01,  fmt: '' },
  ],
  selectors: [
    { key: 'waveform', label: 'WAVE', options: ['sine', 'square', 'sawtooth', 'triangle'] },
  ],
  createVoice(ctx, output, freq, velocity, startTime) {
    const p = this.params;
    const gainNode = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.cutoff;
    filter.Q.value = p.resonance;

    const osc = ctx.createOscillator();
    osc.type = p.waveform;
    osc.frequency.value = freq;

    applyADSR(gainNode, p, startTime, velocity);
    osc.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(output);
    osc.start(startTime);

    return {
      stop(t) {
        const rel = p.release;
        gainNode.gain.cancelScheduledValues(t);
        gainNode.gain.setValueAtTime(gainNode.gain.value, t);
        gainNode.gain.linearRampToValueAtTime(0, t + rel);
        osc.stop(t + rel + 0.05);
        osc.onended = () => { osc.disconnect(); filter.disconnect(); gainNode.disconnect(); };
      }
    };
  }
};

// ─── FM Synthesis ────────────────────────────────────────────────────────────

const fmPalette = {
  name: 'FM Synthesis',
  type: 'melodic',
  params: {
    attack:   0.01,
    decay:    0.3,
    sustain:  0.5,
    release:  0.5,
    modRatio: 2,
    modIndex: 4,
    reverb:   0.25,
  },
  knobs: [
    { key: 'attack',   label: 'ATK',    min: 0.001, max: 2.0,  step: 0.001, fmt: 's' },
    { key: 'decay',    label: 'DEC',    min: 0.001, max: 2.0,  step: 0.001, fmt: 's' },
    { key: 'sustain',  label: 'SUS',    min: 0,     max: 1.0,  step: 0.01,  fmt: '' },
    { key: 'release',  label: 'REL',    min: 0.01,  max: 4.0,  step: 0.01,  fmt: 's' },
    { key: 'modRatio', label: 'M.RATIO',min: 0.5,   max: 8.0,  step: 0.5,   fmt: '' },
    { key: 'modIndex', label: 'M.IDX',  min: 0,     max: 20,   step: 0.1,   fmt: '' },
    { key: 'reverb',   label: 'REVERB', min: 0,     max: 1,    step: 0.01,  fmt: '' },
  ],
  selectors: [],
  createVoice(ctx, output, freq, velocity, startTime) {
    const p = this.params;

    // Carrier
    const carrier = ctx.createOscillator();
    carrier.frequency.value = freq;

    // Modulator
    const modulator = ctx.createOscillator();
    modulator.frequency.value = freq * p.modRatio;

    // FM depth: deviation = modIndex × modulator frequency
    const modDepth = ctx.createGain();
    modDepth.gain.value = freq * p.modRatio * p.modIndex;

    // Output gain with ADSR
    const outGain = ctx.createGain();
    applyADSR(outGain, p, startTime, velocity);

    modulator.connect(modDepth);
    modDepth.connect(carrier.frequency);
    carrier.connect(outGain);
    outGain.connect(output);

    modulator.start(startTime);
    carrier.start(startTime);

    return {
      stop(t) {
        const rel = p.release;
        outGain.gain.cancelScheduledValues(t);
        outGain.gain.setValueAtTime(outGain.gain.value, t);
        outGain.gain.linearRampToValueAtTime(0, t + rel);
        carrier.stop(t + rel + 0.05);
        modulator.stop(t + rel + 0.05);
        carrier.onended = () => {
          carrier.disconnect(); modulator.disconnect();
          modDepth.disconnect(); outGain.disconnect();
        };
      }
    };
  }
};

// ─── Drum Machine ────────────────────────────────────────────────────────────

const drumPalette = {
  name: 'Drum Machine',
  type: 'drum',
  params: {
    kickDecay:  0.5,
    snareDecay: 0.2,
    hihatDecay: 0.08,
    clapDecay:  0.15,
    reverb:     0.15,
  },
  knobs: [
    { key: 'kickDecay',  label: 'KICK',  min: 0.1, max: 1.5, step: 0.01, fmt: 's' },
    { key: 'snareDecay', label: 'SNARE', min: 0.05,max: 0.8, step: 0.01, fmt: 's' },
    { key: 'hihatDecay', label: 'HIHAT', min: 0.02,max: 0.5, step: 0.01, fmt: 's' },
    { key: 'clapDecay',  label: 'CLAP',  min: 0.05,max: 0.5, step: 0.01, fmt: 's' },
    { key: 'reverb',     label: 'REVERB',min: 0,   max: 1,   step: 0.01, fmt: '' },
  ],
  selectors: [],

  // drumIndex: 0=kick, 1=snare, 2=hihat, 3=clap
  createDrumVoice(ctx, output, drumIndex, velocity, startTime) {
    const p = this.params;
    const v = velocity || 1;
    switch (drumIndex) {
      case 0: return this._kick(ctx, output, p.kickDecay, v, startTime);
      case 1: return this._snare(ctx, output, p.snareDecay, v, startTime);
      case 2: return this._hihat(ctx, output, p.hihatDecay, v, startTime);
      case 3: return this._clap(ctx, output, p.clapDecay, v, startTime);
      default: return { stop() {} };
    }
  },

  // createVoice maps note to drum index for keyboard play
  createVoice(ctx, output, freq, velocity, startTime) {
    // Map to drum type by frequency range
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    const idx = [60, 62, 65, 69].indexOf(midi);
    return this.createDrumVoice(ctx, output, idx >= 0 ? idx : 0, velocity, startTime);
  },

  _kick(ctx, output, decay, v, t) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + decay);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(v, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + decay);

    osc.connect(gain);
    gain.connect(output);
    osc.start(t);
    osc.stop(t + decay + 0.05);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    return { stop() {} };
  },

  _snare(ctx, output, decay, v, t) {
    const rate = ctx.sampleRate;
    const bufLen = Math.ceil(rate * decay);
    const noiseBuf = ctx.createBuffer(1, bufLen, rate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;

    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 1200;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(v * 0.7, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + decay);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 200;
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(v * 0.5, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + decay * 0.5);

    noise.connect(hpf);
    hpf.connect(noiseGain);
    noiseGain.connect(output);
    osc.connect(oscGain);
    oscGain.connect(output);

    noise.start(t);
    noise.stop(t + decay + 0.05);
    osc.start(t);
    osc.stop(t + decay * 0.5 + 0.05);
    noise.onended = () => { noise.disconnect(); hpf.disconnect(); noiseGain.disconnect(); };
    osc.onended = () => { osc.disconnect(); oscGain.disconnect(); };
    return { stop() {} };
  },

  _hihat(ctx, output, decay, v, t) {
    const rate = ctx.sampleRate;
    const bufLen = Math.ceil(rate * decay);
    const noiseBuf = ctx.createBuffer(1, bufLen, rate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;

    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 8000;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(v * 0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + decay);

    noise.connect(hpf);
    hpf.connect(gain);
    gain.connect(output);
    noise.start(t);
    noise.stop(t + decay + 0.05);
    noise.onended = () => { noise.disconnect(); hpf.disconnect(); gain.disconnect(); };
    return { stop() {} };
  },

  _clap(ctx, output, decay, v, t) {
    // Multiple noise bursts for realism
    const bursts = [0, 0.008, 0.016, 0.024];
    bursts.forEach((offset, i) => {
      const rate = ctx.sampleRate;
      const bufLen = Math.ceil(rate * 0.04);
      const noiseBuf = ctx.createBuffer(1, bufLen, rate);
      const d = noiseBuf.getChannelData(0);
      for (let j = 0; j < bufLen; j++) d[j] = Math.random() * 2 - 1;

      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;

      const hpf = ctx.createBiquadFilter();
      hpf.type = 'bandpass';
      hpf.frequency.value = 1500;
      hpf.Q.value = 1;

      const gain = ctx.createGain();
      const peakVol = i === bursts.length - 1 ? v * 0.9 : v * 0.4;
      gain.gain.setValueAtTime(peakVol, t + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, t + offset + (i === bursts.length - 1 ? decay : 0.025));

      noise.connect(hpf);
      hpf.connect(gain);
      gain.connect(output);
      noise.start(t + offset);
      noise.stop(t + offset + decay + 0.05);
      noise.onended = () => { noise.disconnect(); hpf.disconnect(); gain.disconnect(); };
    });
    return { stop() {} };
  }
};

// ─── Pad / Ambient ───────────────────────────────────────────────────────────

const padPalette = {
  name: 'Pad / Ambient',
  type: 'melodic',
  params: {
    attack:  1.2,
    decay:   0.5,
    sustain: 0.8,
    release: 3.0,
    detune:  8,
    cutoff:  1200,
    reverb:  0.65,
  },
  knobs: [
    { key: 'attack',  label: 'ATK',    min: 0.1, max: 5.0,   step: 0.01,  fmt: 's' },
    { key: 'decay',   label: 'DEC',    min: 0.1, max: 3.0,   step: 0.01,  fmt: 's' },
    { key: 'sustain', label: 'SUS',    min: 0,   max: 1.0,   step: 0.01,  fmt: '' },
    { key: 'release', label: 'REL',    min: 0.5, max: 8.0,   step: 0.1,   fmt: 's' },
    { key: 'detune',  label: 'DETUNE', min: 0,   max: 50,    step: 1,     fmt: 'c' },
    { key: 'cutoff',  label: 'CUTOFF', min: 200, max: 8000,  step: 1,     fmt: 'Hz', log: true },
    { key: 'reverb',  label: 'REVERB', min: 0,   max: 1,     step: 0.01,  fmt: '' },
  ],
  selectors: [],
  createVoice(ctx, output, freq, velocity, startTime) {
    const p = this.params;

    const oscA = ctx.createOscillator();
    oscA.type = 'triangle';
    oscA.frequency.value = freq;
    oscA.detune.value = p.detune;

    const oscB = ctx.createOscillator();
    oscB.type = 'sine';
    oscB.frequency.value = freq;
    oscB.detune.value = -p.detune;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.cutoff;
    filter.Q.value = 1;

    const outGain = ctx.createGain();
    applyADSR(outGain, p, startTime, velocity * 0.6);

    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(outGain);
    outGain.connect(output);

    oscA.start(startTime);
    oscB.start(startTime);

    return {
      stop(t) {
        const rel = p.release;
        outGain.gain.cancelScheduledValues(t);
        outGain.gain.setValueAtTime(outGain.gain.value, t);
        outGain.gain.linearRampToValueAtTime(0, t + rel);
        oscA.stop(t + rel + 0.1);
        oscB.stop(t + rel + 0.1);
        oscA.onended = () => { oscA.disconnect(); oscB.disconnect(); filter.disconnect(); outGain.disconnect(); };
      }
    };
  }
};

// ─── Export ──────────────────────────────────────────────────────────────────

const Palettes = { classic: classicPalette, fm: fmPalette, drum: drumPalette, pad: padPalette };
