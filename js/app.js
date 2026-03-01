/**
 * app.js
 * Entry point. Wires AudioEngine, Palettes, Keyboard, and Sequencer together.
 * Handles palette switching, knob panel, and transport controls.
 */

(function () {
  let currentPaletteKey = 'classic';
  let currentPalette = Palettes.classic;
  const activeVoices = {}; // midi note → voice object

  const DRUM_DEFS = [
    { label: 'KICK',   key: '1', color: '#ff4444' },
    { label: 'SNARE',  key: '2', color: '#ffaa00' },
    { label: 'HI-HAT', key: '3', color: '#39ff14' },
    { label: 'CLAP',   key: '4', color: '#ff00aa' },
  ];
  const drumPadEls = []; // indexed by drumIndex

  // ─── Audio init on first gesture ──────────────────────────────────────────
  function ensureAudio() {
    AudioEngine.init();
  }

  // ─── Palette switching ─────────────────────────────────────────────────────
  function switchPalette(key) {
    // Stop any held notes
    Object.keys(activeVoices).forEach(note => {
      try { activeVoices[note].stop(AudioEngine.getContext()?.currentTime || 0); } catch (e) {}
      delete activeVoices[note];
    });
    document.querySelectorAll('.key-white.active, .key-black.active')
      .forEach(el => el.classList.remove('active'));

    currentPaletteKey = key;
    currentPalette = Palettes[key];
    renderKnobPanel();

    // Apply this palette's default reverb
    if (AudioEngine.getContext()) {
      AudioEngine.setReverb(currentPalette.params.reverb || 0.2);
    }

    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.palette === key);
    });

    const isDrum = key === 'drum';
    document.getElementById('keyboard-wrap').style.display = isDrum ? 'none' : '';
    document.getElementById('keyboard-hint').style.display = isDrum ? 'none' : '';
    document.getElementById('drum-pads').style.display    = isDrum ? 'flex' : 'none';
    document.getElementById('drum-hint').style.display    = isDrum ? '' : 'none';
  }

  // ─── Drum pads ─────────────────────────────────────────────────────────────
  function triggerDrumPad(drumIndex) {
    ensureAudio();
    const ctx = AudioEngine.getContext();
    if (!ctx) return;
    Palettes.drum.createDrumVoice(ctx, AudioEngine.getMasterInput(), drumIndex, 0.9, ctx.currentTime);

    const pad = drumPadEls[drumIndex];
    if (!pad) return;
    pad.classList.add('active');
    setTimeout(() => pad.classList.remove('active'), 120);
  }

  function renderDrumPads() {
    const container = document.getElementById('drum-pads');
    if (!container) return;
    container.style.display = 'none'; // hidden until drum tab selected

    DRUM_DEFS.forEach((def, i) => {
      const pad = document.createElement('div');
      pad.className = 'drum-pad';
      pad.style.setProperty('--pad-color', def.color);

      const label = document.createElement('div');
      label.className = 'drum-pad-label';
      label.textContent = def.label;

      const kbd = document.createElement('div');
      kbd.className = 'drum-pad-key';
      kbd.textContent = def.key;

      pad.appendChild(label);
      pad.appendChild(kbd);

      pad.addEventListener('mousedown', (e) => { e.preventDefault(); triggerDrumPad(i); });
      pad.addEventListener('touchstart', (e) => { e.preventDefault(); triggerDrumPad(i); }, { passive: false });

      container.appendChild(pad);
      drumPadEls[i] = pad;
    });
  }

  // PC keyboard 1–4 for drum pads
  window.addEventListener('keydown', (e) => {
    if (currentPaletteKey !== 'drum') return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.activeElement && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) return;
    const idx = ['1','2','3','4'].indexOf(e.key);
    if (idx !== -1) triggerDrumPad(idx);
  });

  // ─── Knob panel ────────────────────────────────────────────────────────────
  function renderKnobPanel() {
    const panel = document.getElementById('knob-panel');
    if (!panel) return;
    panel.innerHTML = '';

    const p = currentPalette;

    // Selectors (waveform picker etc.)
    if (p.selectors && p.selectors.length) {
      p.selectors.forEach(def => {
        const group = document.createElement('div');
        group.className = 'knob-select-group';

        const lbl = document.createElement('label');
        lbl.className = 'knob-label';
        lbl.textContent = def.label;

        const sel = document.createElement('select');
        sel.className = 'knob-select';
        def.options.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt.toUpperCase();
          if (p.params[def.key] === opt) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
          p.params[def.key] = sel.value;
        });

        group.appendChild(lbl);
        group.appendChild(sel);
        panel.appendChild(group);
        addDivider(panel);
      });
    }

    // Knobs (range sliders)
    p.knobs.forEach((def, i) => {
      const group = document.createElement('div');
      group.className = 'knob-group';

      const lbl = document.createElement('label');
      lbl.className = 'knob-label';
      lbl.textContent = def.label;

      const rawVal = p.params[def.key];
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'filled';
      slider.min = def.min;
      slider.max = def.max;
      slider.step = def.step;
      slider.value = rawVal;

      const valSpan = document.createElement('span');
      valSpan.className = 'knob-val';

      function formatVal(v) {
        const fmt = def.fmt || '';
        if (fmt === 's') return parseFloat(v).toFixed(2) + 's';
        if (fmt === 'Hz') return v >= 1000 ? (v/1000).toFixed(1) + 'k' : Math.round(v) + '';
        if (fmt === 'c') return Math.round(v) + 'c';
        return parseFloat(v).toFixed(2);
      }

      function updateFill() {
        const pct = (slider.value - slider.min) / (slider.max - slider.min) * 100;
        slider.style.setProperty('--fill', pct + '%');
        valSpan.textContent = formatVal(slider.value);
      }

      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        p.params[def.key] = v;
        updateFill();

        if (def.key === 'reverb') {
          AudioEngine.setReverb(v);
        }
      });

      updateFill();
      group.appendChild(lbl);
      group.appendChild(slider);
      group.appendChild(valSpan);
      panel.appendChild(group);

      // Divider after every knob except last
      if (i < p.knobs.length - 1) addDivider(panel);
    });
  }

  function addDivider(panel) {
    const div = document.createElement('div');
    div.className = 'knob-divider';
    panel.appendChild(div);
  }

  // ─── Master volume ──────────────────────────────────────────────────────────
  function initMasterVolume() {
    const slider = document.getElementById('master-vol');
    const disp   = document.getElementById('master-vol-display');
    if (!slider) return;

    function update() {
      const v = parseFloat(slider.value);
      const pct = v * 100;
      slider.style.setProperty('--fill', pct + '%');
      slider.classList.add('filled');
      if (disp) disp.textContent = Math.round(pct);
      AudioEngine.setMasterVolume(v);
    }

    slider.addEventListener('input', update);
    // Init fill
    const pct = parseFloat(slider.value) * 100;
    slider.style.setProperty('--fill', pct + '%');
    slider.classList.add('filled');
    if (disp) disp.textContent = Math.round(pct);
  }

  // ─── BPM slider ────────────────────────────────────────────────────────────
  function initBPM() {
    const slider = document.getElementById('bpm-slider');
    const disp   = document.getElementById('bpm-display');
    if (!slider) return;

    function update() {
      Sequencer.setBPM(slider.value);
      if (disp) disp.textContent = slider.value;
      const pct = (slider.value - slider.min) / (slider.max - slider.min) * 100;
      slider.style.setProperty('--fill', pct + '%');
    }

    slider.classList.add('filled');
    slider.addEventListener('input', update);
    update();
  }

  // ─── Note events (from Keyboard) ───────────────────────────────────────────
  document.addEventListener('note-on', (e) => {
    ensureAudio();
    const ctx = AudioEngine.getContext();
    if (!ctx) return;
    const note = e.detail.note;
    if (activeVoices[note]) return;

    const freq = 440 * Math.pow(2, (note - 69) / 12);
    try {
      const voice = currentPalette.createVoice(ctx, AudioEngine.getMasterInput(), freq, 0.85, ctx.currentTime);
      activeVoices[note] = voice;
    } catch (err) { console.error('createVoice error', err); }
  });

  document.addEventListener('note-off', (e) => {
    const note = e.detail.note;
    if (activeVoices[note]) {
      const ctx = AudioEngine.getContext();
      try { activeVoices[note].stop(ctx ? ctx.currentTime : 0); } catch (err) {}
      delete activeVoices[note];
    }
  });

  // ─── Transport buttons ──────────────────────────────────────────────────────
  function initTransport() {
    document.getElementById('play-btn')?.addEventListener('click', () => {
      ensureAudio();
      Sequencer.play();
    });
    document.getElementById('stop-btn')?.addEventListener('click', () => {
      Sequencer.stop();
    });
    document.getElementById('clear-btn')?.addEventListener('click', () => {
      Sequencer.clear();
    });
    document.getElementById('add-track-btn')?.addEventListener('click', () => {
      ensureAudio();
      Sequencer.addTrack();
    });
  }

  // ─── Palette tabs ───────────────────────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        ensureAudio();
        switchPalette(tab.dataset.palette);
      });
    });
  }

  // ─── Recorder ───────────────────────────────────────────────────────────────
  function pad(n) { return String(n).padStart(2, '0'); }

  function initRecorder() {
    const btn    = document.getElementById('rec-btn');
    const timer  = document.getElementById('rec-timer');
    const status = document.getElementById('rec-status');
    if (!btn) return;

    let recording = false, interval = null, elapsed = 0;

    btn.addEventListener('click', () => {
      ensureAudio();
      if (!recording) {
        recording = true;
        elapsed = 0;
        btn.textContent = '■ STOP & SAVE';
        btn.classList.add('recording');
        status.textContent = '● RECORDING';
        Recorder.start(AudioEngine.getContext(), AudioEngine.getCompressor());
        interval = setInterval(() => {
          elapsed++;
          timer.textContent = pad(Math.floor(elapsed / 60)) + ':' + pad(elapsed % 60);
        }, 1000);
      } else {
        recording = false;
        clearInterval(interval);
        btn.textContent = '● REC';
        btn.classList.remove('recording');
        status.textContent = '';
        timer.textContent = '00:00';
        const ts = new Date().toISOString().replace('T', '-').replace(/:/g, '-').slice(0, 19);
        Recorder.stop('synth-' + ts + '.wav');
      }
    });
  }

  // ─── Bootstrap ─────────────────────────────────────────────────────────────
  function boot() {
    Keyboard.render('keyboard');
    renderDrumPads();
    Sequencer.init('seq-tracks');

    renderKnobPanel();
    initMasterVolume();
    initBPM();
    initTransport();
    initTabs();
    initRecorder();

    // Init audio on first click anywhere (required by browsers)
    document.body.addEventListener('click', ensureAudio, { once: false });
    document.body.addEventListener('keydown', ensureAudio, { once: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
