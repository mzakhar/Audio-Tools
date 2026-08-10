import AudioEngine from '../audio-engine.js'
import Sequencer from '../sequencer.js'
import { INSTRUMENTS, PARAM_DEFS, makeKitParams, createTr909Voice } from '../drums/tr909-kit.js'
import { LookaheadScheduler } from '../rack/scheduler.js'

const STEPS = 16

function makeStep() {
  return { on: false, velocity: 0.85, accent: false, flam: false }
}

function makePattern() {
  return {
    name: '909 Pattern 1',
    steps: STEPS,
    scale: '1/16',
    shuffle: 0,
    flam: 0.18,
    lastStep: 16,
    totalAccent: 0.45,
    lanes: Object.fromEntries(INSTRUMENTS.map(inst => [
      inst.id,
      Array.from({ length: STEPS }, makeStep)
    ]))
  }
}

function formatPct(v) {
  return Math.round(v * 100)
}

export class Tr909View {
  constructor(container, options = {}) {
    this.container = container
    this.ensureAudio = options.ensureAudio || (() => AudioEngine.init())
    this.pattern = makePattern()
    this.kitParams = makeKitParams()
    this.selectedInstrumentId = 'bd'
    this.showAllLanes = false
    this.isPlaying = false
    this.schedulerLoop = null
    this.playheadStep = -1
    this.rafId = null

    this.render()
  }

  destroy() {
    this.stop()
    this.container.innerHTML = ''
  }

  render() {
    this.container.innerHTML = `
      <div class="tr909-shell">
        <div class="tr909-header">
          <div class="tr909-title">
            <span class="tr909-kicker">RHYTHM COMPOSER</span>
            <strong>909</strong>
          </div>
          <div class="tr909-transport" role="toolbar" aria-label="909 transport">
            <button class="transport-btn play" data-action="play" aria-pressed="false">Play</button>
            <button class="transport-btn stop" data-action="stop">Stop</button>
            <button class="transport-btn clear" data-action="clear">Clear</button>
            <button class="transport-btn" data-action="randomize">Random</button>
          </div>
          <div class="tr909-pattern">
            <label class="knob-label" for="tr909-pattern-slot">Pattern</label>
            <select id="tr909-pattern-slot" class="knob-select" aria-label="909 pattern slot">
              <option>A1</option><option>A2</option><option>A3</option><option>A4</option>
            </select>
          </div>
        </div>

        <div class="tr909-global">
          ${this.renderGlobalSlider('shuffle', 'Shuffle', 0, 1, 0.01)}
          ${this.renderGlobalSlider('flam', 'Flam', 0, 1, 0.01)}
          ${this.renderGlobalSlider('totalAccent', 'Accent', 0, 1, 0.01)}
          <label class="tr909-control">
            <span>Last</span>
            <input type="number" min="1" max="16" value="${this.pattern.lastStep}" data-global="lastStep" aria-label="Last step">
          </label>
          <label class="tr909-control">
            <span>Scale</span>
            <select data-global="scale" aria-label="Step scale">
              <option value="1/16"${this.pattern.scale === '1/16' ? ' selected' : ''}>1/16</option>
              <option value="1/32"${this.pattern.scale === '1/32' ? ' selected' : ''}>1/32</option>
            </select>
          </label>
          <button class="tr909-toggle${this.showAllLanes ? ' active' : ''}" data-action="toggle-lanes" aria-pressed="${this.showAllLanes}">All Lanes</button>
        </div>

        <div class="tr909-body">
          <div class="tr909-instruments" role="listbox" aria-label="909 instruments">
            ${INSTRUMENTS.map(inst => this.renderInstrumentStrip(inst)).join('')}
          </div>
          <div class="tr909-editor">
            <div class="tr909-lane-head">
              <span>${this.selectedInstrument().name}</span>
              <button class="tr909-audition" data-action="audition">Trig</button>
            </div>
            <div class="tr909-steps" role="grid" aria-label="Selected instrument steps">
              ${Array.from({ length: STEPS }, (_, i) => this.renderStepButton(this.selectedInstrumentId, i)).join('')}
            </div>
            <div class="tr909-sub-lanes">
              <div class="tr909-sub-label">Accent</div>
              <div class="tr909-mini-steps">${Array.from({ length: STEPS }, (_, i) => this.renderMiniButton('accent', i)).join('')}</div>
              <div class="tr909-sub-label">Flam</div>
              <div class="tr909-mini-steps">${Array.from({ length: STEPS }, (_, i) => this.renderMiniButton('flam', i)).join('')}</div>
            </div>
            <div class="tr909-all-lanes"${this.showAllLanes ? '' : ' hidden'}>
              ${INSTRUMENTS.map(inst => this.renderAllLane(inst)).join('')}
            </div>
          </div>
          <div class="tr909-params">
            ${this.renderParamControls()}
          </div>
        </div>
      </div>
    `

    this.bindEvents()
    this.updateSliderFills()
    this.updatePlayhead()
  }

  renderGlobalSlider(key, label, min, max, step) {
    const value = this.pattern[key]
    return `
      <label class="tr909-control">
        <span>${label}</span>
        <input class="filled" type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-global="${key}" aria-label="${label}">
        <b>${formatPct(value)}</b>
      </label>
    `
  }

  renderInstrumentStrip(inst) {
    const params = this.kitParams[inst.id]
    const isSelected = inst.id === this.selectedInstrumentId
    return `
      <button class="tr909-strip${isSelected ? ' selected' : ''}" data-inst="${inst.id}" style="--inst-color:${inst.color}" role="option" aria-selected="${isSelected}">
        <span class="tr909-strip-label">${inst.label}</span>
        <span class="tr909-strip-meter" style="height:${Math.round((params.level ?? 0.7) * 42)}px"></span>
      </button>
    `
  }

  renderStepButton(laneId, index) {
    const step = this.pattern.lanes[laneId][index]
    const beat = index % 4 === 0 ? ' beat' : ''
    return `
      <button class="tr909-step${step.on ? ' on' : ''}${beat}" data-step="${index}" aria-pressed="${step.on}">
        <span>${index + 1}</span>
      </button>
    `
  }

  renderMiniButton(key, index) {
    const step = this.pattern.lanes[this.selectedInstrumentId][index]
    return `<button class="tr909-mini${step[key] ? ' on' : ''}" data-sub="${key}" data-step="${index}" aria-pressed="${step[key]}"></button>`
  }

  renderAllLane(inst) {
    return `
      <div class="tr909-grid-row" style="--inst-color:${inst.color}">
        <button class="tr909-grid-label" data-inst="${inst.id}">${inst.label}</button>
        <div class="tr909-grid-steps">
          ${Array.from({ length: STEPS }, (_, i) => this.renderGridCell(inst.id, i)).join('')}
        </div>
      </div>
    `
  }

  renderGridCell(laneId, index) {
    const step = this.pattern.lanes[laneId][index]
    return `<button class="tr909-grid-cell${step.on ? ' on' : ''}" data-grid-lane="${laneId}" data-step="${index}" aria-pressed="${step.on}"></button>`
  }

  renderParamControls() {
    const inst = this.selectedInstrument()
    const params = this.kitParams[inst.id]
    return Object.keys(params).map(key => {
      const def = PARAM_DEFS[key]
      return `
        <label class="tr909-param">
          <span>${def.label}</span>
          <input class="filled" type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${params[key]}" data-param="${key}" aria-label="${inst.name} ${def.label}">
          <b>${key === 'decay' ? Number(params[key]).toFixed(2) : formatPct(params[key])}</b>
        </label>
      `
    }).join('')
  }

  bindEvents() {
    this.container.querySelector('[data-action="play"]')?.addEventListener('click', () => this.play())
    this.container.querySelector('[data-action="stop"]')?.addEventListener('click', () => this.stop())
    this.container.querySelector('[data-action="clear"]')?.addEventListener('click', () => this.clearPattern())
    this.container.querySelector('[data-action="randomize"]')?.addEventListener('click', () => this.randomize())
    this.container.querySelector('[data-action="toggle-lanes"]')?.addEventListener('click', () => {
      this.showAllLanes = !this.showAllLanes
      this.render()
    })
    this.container.querySelector('[data-action="audition"]')?.addEventListener('click', () => this.trigger(this.selectedInstrumentId, 0.9))

    this.container.querySelectorAll('[data-inst]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.selectedInstrumentId = btn.dataset.inst
        this.render()
      })
    })

    this.container.querySelectorAll('[data-step]:not([data-sub]):not([data-grid-lane])').forEach(btn => {
      btn.addEventListener('click', () => {
        this.toggleStep(this.selectedInstrumentId, Number(btn.dataset.step), 'on')
        this.render()
      })
    })

    this.container.querySelectorAll('[data-sub]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.toggleStep(this.selectedInstrumentId, Number(btn.dataset.step), btn.dataset.sub)
        this.render()
      })
    })

    this.container.querySelectorAll('[data-grid-lane]').forEach(btn => {
      btn.addEventListener('click', () => {
        const laneId = btn.dataset.gridLane
        this.toggleStep(laneId, Number(btn.dataset.step), 'on')
        this.selectedInstrumentId = laneId
        this.render()
      })
    })

    this.container.querySelectorAll('[data-global]').forEach(input => {
      input.addEventListener('input', () => {
        const key = input.dataset.global
        if (key === 'lastStep') {
          this.pattern.lastStep = Math.max(1, Math.min(16, Number(input.value) || 16))
        } else if (key === 'scale') {
          this.pattern.scale = input.value
        } else {
          this.pattern[key] = Number(input.value)
        }
        this.updateSliderFills()
      })
    })

    this.container.querySelectorAll('[data-param]').forEach(input => {
      input.addEventListener('input', () => {
        const key = input.dataset.param
        this.kitParams[this.selectedInstrumentId][key] = Number(input.value)
        this.updateSliderFills()
        this.updateParamValue(input)
      })
    })
  }

  selectedInstrument() {
    return INSTRUMENTS.find(inst => inst.id === this.selectedInstrumentId) || INSTRUMENTS[0]
  }

  toggleStep(laneId, stepIndex, key) {
    const step = this.pattern.lanes[laneId][stepIndex]
    step[key] = !step[key]
    if ((key === 'accent' || key === 'flam') && step[key]) step.on = true
  }

  clearPattern() {
    Object.values(this.pattern.lanes).forEach(lane => lane.forEach(step => {
      step.on = false; step.accent = false; step.flam = false; step.velocity = 0.85
    }))
    this.render()
  }

  randomize() {
    const density = { bd: 0.28, sd: 0.18, lt: 0.08, mt: 0.08, ht: 0.08, rs: 0.06, cp: 0.09, ch: 0.44, oh: 0.12, cr: 0.05, rd: 0.08 }
    INSTRUMENTS.forEach(inst => {
      this.pattern.lanes[inst.id].forEach((step, i) => {
        const beatBias = (inst.id === 'bd' && i % 4 === 0) || (inst.id === 'sd' && i % 8 === 4) ? 0.25 : 0
        step.on = Math.random() < (density[inst.id] + beatBias)
        step.accent = step.on && Math.random() < 0.12
        step.flam = step.on && ['sd', 'cp', 'rs'].includes(inst.id) && Math.random() < 0.08
        step.velocity = 0.72 + Math.random() * 0.25
      })
    })
    this.render()
  }

  async trigger(instrumentId, velocity, event = {}, time = null) {
    await this.ensureAudio()
    const ctx = AudioEngine.getContext()
    if (!ctx) return
    createTr909Voice(
      ctx,
      AudioEngine.getMasterInput(),
      instrumentId,
      this.kitParams,
      { velocity, ...event },
      time ?? ctx.currentTime
    )
  }

  async play() {
    if (this.isPlaying) return
    await this.ensureAudio()
    const ctx = AudioEngine.getContext()
    if (!ctx) return
    this.isPlaying = true
    this.schedulerLoop = new LookaheadScheduler({
      getCurrentTime: () => AudioEngine.getContext()?.currentTime,
      schedule: (step, time) => this.scheduleStep(step, time),
      advance: () => this.stepDuration(),
      steps: this.pattern.lastStep
    })
    this.schedulerLoop.stepTimes = new Array(STEPS).fill(-Infinity)
    this.container.querySelector('[data-action="play"]')?.classList.add('active-btn')
    this.container.querySelector('[data-action="play"]')?.setAttribute('aria-pressed', 'true')
    this.schedulerLoop.start({ time: ctx.currentTime + 0.05 })
    this.startPlayhead()
  }

  stop() {
    if (!this.isPlaying) return
    this.isPlaying = false
    this.schedulerLoop?.stop()
    cancelAnimationFrame(this.rafId)
    this.playheadStep = -1
    this.container.querySelector('[data-action="play"]')?.classList.remove('active-btn')
    this.container.querySelector('[data-action="play"]')?.setAttribute('aria-pressed', 'false')
    this.updatePlayhead()
  }

  scheduleStep(stepIndex, time) {
    const stepDur = this.stepDuration()
    const shuffleOffset = this.pattern.shuffle * stepDur * 0.45
    const shuffledTime = stepIndex % 2 === 1 ? time + shuffleOffset : time
    INSTRUMENTS.forEach(inst => {
      const step = this.pattern.lanes[inst.id][stepIndex]
      if (!step.on) return
      const accentAmount = step.accent ? this.pattern.totalAccent : 0
      const event = {
        velocity: Math.min(1, step.velocity + accentAmount * 0.25),
        accent: step.accent,
        flam: step.flam
      }
      createTr909Voice(AudioEngine.getContext(), AudioEngine.getMasterInput(), inst.id, this.kitParams, event, shuffledTime)
      if (step.flam) {
        createTr909Voice(
          AudioEngine.getContext(),
          AudioEngine.getMasterInput(),
          inst.id,
          this.kitParams,
          { ...event, velocity: event.velocity * 0.62 },
          shuffledTime + 0.012 + this.pattern.flam * 0.055
        )
      }
    })
  }

  stepDuration() {
    const bpm = Sequencer.getBPM ? Sequencer.getBPM() : 120
    const sixteenth = (60 / bpm) / 4
    return this.pattern.scale === '1/32' ? sixteenth / 2 : sixteenth
  }

  startPlayhead() {
    const tick = () => {
      if (!this.isPlaying) return
      const ctx = AudioEngine.getContext()
      if (ctx) {
        let bestStep = -1
        let bestTime = -Infinity
        for (let i = 0; i < STEPS; i++) {
          if (this.schedulerLoop?.stepTimes[i] <= ctx.currentTime && this.schedulerLoop.stepTimes[i] > bestTime) {
            bestStep = i
            bestTime = this.schedulerLoop.stepTimes[i]
          }
        }
        if (bestStep !== this.playheadStep) {
          this.playheadStep = bestStep
          this.updatePlayhead()
        }
      }
      this.rafId = requestAnimationFrame(tick)
    }
    tick()
  }

  updatePlayhead() {
    this.container.querySelectorAll('[data-step]').forEach(el => {
      el.classList.toggle('playing', Number(el.dataset.step) === this.playheadStep)
    })
  }

  updateSliderFills() {
    this.container.querySelectorAll('input[type="range"]').forEach(input => {
      const min = Number(input.min)
      const max = Number(input.max)
      const value = Number(input.value)
      const pct = ((value - min) / (max - min)) * 100
      input.style.setProperty('--fill', `${pct}%`)
      const val = input.parentElement?.querySelector('b')
      if (val && input.dataset.global) val.textContent = formatPct(value)
    })
  }

  updateParamValue(input) {
    const val = input.parentElement?.querySelector('b')
    if (!val) return
    val.textContent = input.dataset.param === 'decay' ? Number(input.value).toFixed(2) : formatPct(Number(input.value))
  }
}
