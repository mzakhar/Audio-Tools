import AudioEngine from '../audio-engine.js'
import Sequencer from '../sequencer.js'
import { INSTRUMENTS, PARAM_DEFS, makeKitParams, createTr909Voice } from '../drums/tr909-kit.js'
import { LookaheadScheduler } from '../rack/scheduler.js'
import ProjectStore, {
  SetPatternStep,
  SetBarParam,
  AddBar,
  RemoveBar,
  SetCurrentBar,
  ClearBar,
  nextChainPos
} from '../store/ProjectStore.js'

const STEPS = 16
const PATTERN_ID = '909-main'

// Grid rows read bottom-up: BD on the bottom row, RD on the top, the way a
// drummer sits behind the kit. INSTRUMENTS stays low-to-high everywhere else.
const LANE_ORDER = [...INSTRUMENTS].reverse()

function formatPct(v) {
  return Math.round(v * 100)
}

export class Tr909View {
  constructor(container, options = {}) {
    this.container = container
    this.ensureAudio = options.ensureAudio || (() => AudioEngine.init())
    this.patternId = PATTERN_ID

    // Lazily create the pattern via a harmless dispatch — patternCommand
    // creates any missing patternId on first dispatch (see store-handoff).
    if (!ProjectStore.getState().patterns[this.patternId]) {
      ProjectStore.dispatch(SetCurrentBar(this.patternId, 0))
    }

    // Cache of patterns[patternId], refreshed in onStoreChange — a dispatch is
    // the only thing that can change it. Keeps scheduleStep off getState(),
    // which deep-clones the whole project on every scheduled step.
    this._patternCache = ProjectStore.getState().patterns[this.patternId]

    this.kitParams = makeKitParams()
    this.selectedInstrumentId = 'bd'
    this.showAllLanes = false

    this.isPlaying = false
    this.mode = null // 'bar' | 'chain' | null
    this.schedulerLoop = null
    this.playheadStep = -1
    this.playingBarIndex = -1 // UI-only: which bar the RAF loop last saw sounding
    this._activeBarIndex = -1 // audio-only: which bar scheduleStep is reading from
    this._playingBar = null
    this.playChainPos = 0
    this._chainStepsScheduled = 0
    this.rafId = null
    this._suppressNextRender = false
    this._viewedBar = 0 // cache of pattern.currentBar, refreshed in render()

    this._lastPatternJSON = null
    this._unsubscribe = ProjectStore.subscribe(state => this.onStoreChange(state))

    this.render()
  }

  destroy() {
    this.stop()
    this._unsubscribe?.()
    this.container.innerHTML = ''
  }

  // ---------------------------------------------------------------------
  // Store accessors — reads go through _patternCache, kept in sync by the
  // subscription, so no read path clones the project state.
  // ---------------------------------------------------------------------

  pattern() {
    return this._patternCache
  }

  currentBar() {
    const pattern = this.pattern()
    return pattern.bars[pattern.currentBar]
  }

  // dispatch() always triggers a full re-render via the subscription.
  // dispatchQuiet() is for high-frequency writes (slider drags) where a
  // full innerHTML rebuild would break the drag gesture — see updateSliderFills.
  dispatchQuiet(command) {
    this._suppressNextRender = true
    try {
      ProjectStore.dispatch(command)
    } finally {
      this._suppressNextRender = false
    }
  }

  // ProjectStore clones the *entire* state tree (JSON.stringify/parse) on
  // every single dispatch, including unrelated ones (mixer, rack, ...) — so
  // `patterns[id]` is a fresh object reference after every dispatch, not
  // just ones that touch it. A literal reference check would therefore
  // always be "changed" and re-render on every dispatch. Comparing
  // serialized content instead gives the behaviour the spec actually wants:
  // re-render only when this pattern's data really changed.
  // ponytail: JSON.stringify of one pattern per dispatch, cheap enough here —
  // revisit if bars grow far beyond a handful of steps/lanes.
  onStoreChange(state) {
    const pattern = state.patterns[this.patternId]
    if (!pattern) return
    this._patternCache = pattern
    const json = JSON.stringify(pattern)
    if (json === this._lastPatternJSON) return
    this._lastPatternJSON = json
    if (this._suppressNextRender) {
      this._suppressNextRender = false
      return
    }
    this.render()
  }

  render() {
    const pattern = this.pattern()
    const bar = pattern.bars[pattern.currentBar]
    this._viewedBar = pattern.currentBar

    this.container.innerHTML = `
      <div class="tr909-shell">
        <div class="tr909-header">
          <div class="tr909-title">
            <span class="tr909-kicker">RHYTHM COMPOSER</span>
            <strong>909</strong>
          </div>
          <div class="tr909-transport" role="toolbar" aria-label="909 transport">
            <button class="transport-btn play" data-action="play-bar" aria-pressed="${this.mode === 'bar'}">▸ Bar</button>
            <button class="transport-btn play" data-action="play-chain" aria-pressed="${this.mode === 'chain'}">▸ Chain</button>
            <button class="transport-btn stop" data-action="stop">■ Stop</button>
            <button class="transport-btn clear" data-action="clear">Clear</button>
            <button class="transport-btn" data-action="randomize">Random</button>
          </div>
          <div class="tr909-barstrip" role="toolbar" aria-label="Pattern bars">
            <span class="tr909-barstrip-label">BARS</span>
            <div class="tr909-bar-buttons">
              ${pattern.bars.map((b, i) => this.renderBarButton(pattern, i)).join('')}
            </div>
            <button class="tr909-bar-add" data-action="add-bar" aria-label="Add bar" title="Add empty bar">+</button>
            <button class="tr909-bar-copy" data-action="copy-bar" title="Copy current bar into a new bar">⧉ Copy Bar</button>
          </div>
        </div>

        <div class="tr909-global">
          ${this.renderGlobalSlider(bar, 'shuffle', 'Shuffle', 0, 1, 0.01)}
          ${this.renderGlobalSlider(bar, 'flam', 'Flam', 0, 1, 0.01)}
          ${this.renderGlobalSlider(bar, 'totalAccent', 'Accent', 0, 1, 0.01)}
          <label class="tr909-control">
            <span>Last</span>
            <input type="number" min="1" max="16" value="${bar.lastStep}" data-global="lastStep" aria-label="Last step">
          </label>
          <label class="tr909-control">
            <span>Scale</span>
            <select data-global="scale" aria-label="Step scale">
              <option value="1/16"${bar.scale === '1/16' ? ' selected' : ''}>1/16</option>
              <option value="1/32"${bar.scale === '1/32' ? ' selected' : ''}>1/32</option>
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
            <div class="tr909-lane-row tr909-selected-lane" role="grid" aria-label="Selected instrument steps">
              <span class="tr909-lane-label">${this.selectedInstrument().label}</span>
              <div class="tr909-steps">
                ${Array.from({ length: STEPS }, (_, i) => this.renderStepButton(bar, this.selectedInstrumentId, i)).join('')}
              </div>
            </div>
            <div class="tr909-all-lanes"${this.showAllLanes ? '' : ' hidden'}>
              ${LANE_ORDER.map(inst => this.renderAllLane(bar, inst)).join('')}
            </div>
            <div class="tr909-sub-lanes">
              ${this.renderSubLane(bar, 'accent', 'Accent')}
              ${this.renderSubLane(bar, 'flam', 'Flam')}
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
    this.updateTransportButtons()
    this.updatePlayhead()
  }

  renderBarButton(pattern, index) {
    const selected = index === pattern.currentBar
    const playing = this.isPlaying && index === this.playingBarIndex
    const canRemove = pattern.bars.length > 1
    return `
      <span class="tr909-bar-btn-wrap">
        <button class="tr909-bar-btn${selected ? ' selected' : ''}${playing ? ' bar-playing' : ''}" data-bar="${index}" aria-pressed="${selected}"${playing ? ' aria-current="true"' : ''}>${index + 1}</button>
        ${canRemove ? `<button class="tr909-bar-remove" data-action="remove-bar" data-bar="${index}" aria-label="Remove bar ${index + 1}" title="Remove bar">×</button>` : ''}
      </span>
    `
  }

  renderGlobalSlider(bar, key, label, min, max, step) {
    const value = bar[key]
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

  renderStepButton(bar, laneId, index) {
    const step = bar.lanes[laneId][index]
    const beat = index % 4 === 0 ? ' beat' : ''
    return `
      <button class="tr909-step${step.on ? ' on' : ''}${beat}" data-step="${index}" aria-pressed="${step.on}">
        <span>${index + 1}</span>
      </button>
    `
  }

  renderSubLane(bar, key, label) {
    return `
      <div class="tr909-lane-row">
        <span class="tr909-lane-label">${label}</span>
        <div class="tr909-mini-steps">
          ${Array.from({ length: STEPS }, (_, i) => this.renderMiniButton(bar, key, i)).join('')}
        </div>
      </div>
    `
  }

  renderMiniButton(bar, key, index) {
    const step = bar.lanes[this.selectedInstrumentId][index]
    return `<button class="tr909-mini${step[key] ? ' on' : ''}" data-sub="${key}" data-step="${index}" aria-pressed="${step[key]}"></button>`
  }

  renderAllLane(bar, inst) {
    return `
      <div class="tr909-lane-row" style="--inst-color:${inst.color}">
        <button class="tr909-lane-label tr909-grid-label" data-inst="${inst.id}">${inst.label}</button>
        <div class="tr909-grid-steps">
          ${Array.from({ length: STEPS }, (_, i) => this.renderGridCell(bar, inst.id, i)).join('')}
        </div>
      </div>
    `
  }

  renderGridCell(bar, laneId, index) {
    const step = bar.lanes[laneId][index]
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
    this.container.querySelector('[data-action="play-bar"]')?.addEventListener('click', () => this.playBar())
    this.container.querySelector('[data-action="play-chain"]')?.addEventListener('click', () => this.playChain())
    this.container.querySelector('[data-action="stop"]')?.addEventListener('click', () => this.stop())
    this.container.querySelector('[data-action="clear"]')?.addEventListener('click', () => this.clearBar())
    this.container.querySelector('[data-action="randomize"]')?.addEventListener('click', () => this.randomize())
    this.container.querySelector('[data-action="toggle-lanes"]')?.addEventListener('click', () => {
      this.showAllLanes = !this.showAllLanes
      this.render()
    })
    this.container.querySelector('[data-action="audition"]')?.addEventListener('click', () => this.trigger(this.selectedInstrumentId, 0.9))

    this.container.querySelectorAll('.tr909-bar-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        ProjectStore.dispatch(SetCurrentBar(this.patternId, Number(btn.dataset.bar)))
      })
    })
    this.container.querySelectorAll('.tr909-bar-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        ProjectStore.dispatch(RemoveBar(this.patternId, Number(btn.dataset.bar)))
      })
    })
    this.container.querySelector('[data-action="add-bar"]')?.addEventListener('click', () => {
      ProjectStore.dispatch(AddBar(this.patternId, { copyFrom: null }))
    })
    this.container.querySelector('[data-action="copy-bar"]')?.addEventListener('click', () => {
      const barIndex = this.pattern().currentBar
      this.dispatchQuiet(AddBar(this.patternId, { copyFrom: barIndex }))
      const newIndex = this.pattern().bars.length - 1
      ProjectStore.dispatch(SetCurrentBar(this.patternId, newIndex))
    })

    this.container.querySelectorAll('[data-inst]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.selectedInstrumentId = btn.dataset.inst
        this.render()
      })
    })

    this.container.querySelectorAll('[data-step]:not([data-sub]):not([data-grid-lane])').forEach(btn => {
      btn.addEventListener('click', () => {
        this.toggleStep(this.selectedInstrumentId, Number(btn.dataset.step), 'on')
      })
    })

    this.container.querySelectorAll('[data-sub]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.toggleStep(this.selectedInstrumentId, Number(btn.dataset.step), btn.dataset.sub)
      })
    })

    this.container.querySelectorAll('[data-grid-lane]').forEach(btn => {
      btn.addEventListener('click', () => {
        const laneId = btn.dataset.gridLane
        this.selectedInstrumentId = laneId
        this.toggleStep(laneId, Number(btn.dataset.step), 'on')
      })
    })

    this.container.querySelectorAll('[data-global]').forEach(input => {
      input.addEventListener('input', () => {
        const key = input.dataset.global
        let value
        if (key === 'lastStep') value = Math.max(1, Math.min(16, Number(input.value) || 16))
        else if (key === 'scale') value = input.value
        else value = Number(input.value)
        // Quiet dispatch: persists the value but skips the auto full-rebuild
        // that dispatch() would otherwise trigger — a slider mid-drag can't
        // survive its own DOM node being replaced under the pointer.
        this.dispatchQuiet(SetBarParam(this.patternId, this.pattern().currentBar, key, value))
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
    const bar = this.currentBar()
    const step = bar.lanes[laneId][stepIndex]
    const patch = { [key]: !step[key] }
    if ((key === 'accent' || key === 'flam') && patch[key]) patch.on = true
    ProjectStore.dispatch(SetPatternStep(this.patternId, this.pattern().currentBar, laneId, stepIndex, patch))
  }

  clearBar() {
    ProjectStore.dispatch(ClearBar(this.patternId, this.pattern().currentBar))
  }

  randomize() {
    const density = { bd: 0.28, sd: 0.18, lt: 0.08, mt: 0.08, ht: 0.08, rs: 0.06, cp: 0.09, ch: 0.44, oh: 0.12, cr: 0.05, rd: 0.08 }
    const barIndex = this.pattern().currentBar
    const patches = []
    INSTRUMENTS.forEach(inst => {
      for (let i = 0; i < STEPS; i++) {
        const beatBias = (inst.id === 'bd' && i % 4 === 0) || (inst.id === 'sd' && i % 8 === 4) ? 0.25 : 0
        const on = Math.random() < (density[inst.id] + beatBias)
        patches.push([inst.id, i, {
          on,
          accent: on && Math.random() < 0.12,
          flam: on && ['sd', 'cp', 'rs'].includes(inst.id) && Math.random() < 0.08,
          velocity: 0.72 + Math.random() * 0.25
        }])
      }
    })
    // One dispatch per step, but only the last one triggers a re-render.
    patches.forEach(([instId, i, patch], idx) => {
      const command = SetPatternStep(this.patternId, barIndex, instId, i, patch)
      if (idx < patches.length - 1) this.dispatchQuiet(command)
      else ProjectStore.dispatch(command)
    })
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

  async playBar() {
    if (this.isPlaying) this.stop()
    await this.ensureAudio()
    const ctx = AudioEngine.getContext()
    if (!ctx) return
    const pattern = this.pattern()
    this.isPlaying = true
    this.mode = 'bar'
    this._activeBarIndex = pattern.currentBar
    const bar = pattern.bars[this._activeBarIndex]
    this.schedulerLoop = new LookaheadScheduler({
      getCurrentTime: () => AudioEngine.getContext()?.currentTime,
      schedule: (step, time) => this.scheduleStep(step, time),
      advance: () => this.stepDuration(),
      steps: bar.lastStep
    })
    this.schedulerLoop.stepTimes = new Array(STEPS).fill(-Infinity)
    this.schedulerLoop.barAtStepTime = new Array(STEPS).fill(-1)
    this.updateTransportButtons()
    this.schedulerLoop.start({ time: ctx.currentTime + 0.05 })
    this.startPlayhead()
  }

  async playChain() {
    if (this.isPlaying) this.stop()
    await this.ensureAudio()
    const ctx = AudioEngine.getContext()
    if (!ctx) return
    const pattern = this.pattern()
    this.isPlaying = true
    this.mode = 'chain'
    this.playChainPos = 0
    this._chainStepsScheduled = 0
    this._activeBarIndex = pattern.chain[0] ?? 0
    const bar = pattern.bars[this._activeBarIndex] || pattern.bars[0]
    this.schedulerLoop = new LookaheadScheduler({
      getCurrentTime: () => AudioEngine.getContext()?.currentTime,
      schedule: (step, time) => this.scheduleStep(step, time),
      advance: () => this.stepDuration(),
      steps: bar.lastStep
    })
    this.schedulerLoop.stepTimes = new Array(STEPS).fill(-Infinity)
    this.schedulerLoop.barAtStepTime = new Array(STEPS).fill(-1)
    this.updateTransportButtons()
    this.schedulerLoop.start({ time: ctx.currentTime + 0.05 })
    this.startPlayhead()
  }

  stop() {
    if (!this.isPlaying) return
    this.isPlaying = false
    this.mode = null
    this.schedulerLoop?.stop()
    cancelAnimationFrame(this.rafId)
    this.playheadStep = -1
    this.playingBarIndex = -1
    this._activeBarIndex = -1
    this._playingBar = null
    this.updateTransportButtons()
    this.updatePlayhead()
  }

  // stepIndex/time come straight from LookaheadScheduler.tick() — stepIndex
  // is the step *about to be scheduled*, called before tick() advances
  // `this.step`. In chain mode, resolving the next bar and reassigning
  // schedulerLoop.steps must happen here, at stepIndex === 0, not at the
  // outgoing bar's last step — tick()'s wrap `(lastStep-1+1) % steps` needs
  // the *outgoing* bar's lastStep to land on 0.
  scheduleStep(stepIndex, time) {
    const pattern = this.pattern()

    if (this.mode === 'chain' && stepIndex === 0) {
      if (this._chainStepsScheduled > 0) {
        this.playChainPos = nextChainPos(this.playChainPos, pattern.chain.length)
      }
      this._chainStepsScheduled++
      this._activeBarIndex = pattern.chain[this.playChainPos] ?? 0
      const nextBar = pattern.bars[this._activeBarIndex] || pattern.bars[0]
      if (this.schedulerLoop) this.schedulerLoop.steps = nextBar.lastStep
    }

    const bar = pattern.bars[this._activeBarIndex] || pattern.bars[0]
    this._playingBar = bar
    if (this.schedulerLoop) this.schedulerLoop.barAtStepTime[stepIndex] = this._activeBarIndex

    const stepDur = this.stepDuration()
    const shuffleOffset = bar.shuffle * stepDur * 0.45
    const shuffledTime = stepIndex % 2 === 1 ? time + shuffleOffset : time
    INSTRUMENTS.forEach(inst => {
      const step = bar.lanes[inst.id][stepIndex]
      if (!step.on) return
      const accentAmount = step.accent ? bar.totalAccent : 0
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
          shuffledTime + 0.012 + bar.flam * 0.055
        )
      }
    })
  }

  stepDuration() {
    const bar = this._playingBar || this.currentBar()
    const bpm = Sequencer.getBPM ? Sequencer.getBPM() : 120
    const sixteenth = (60 / bpm) / 4
    return bar.scale === '1/32' ? sixteenth / 2 : sixteenth
  }

  startPlayhead() {
    const tick = () => {
      if (!this.isPlaying) return
      const ctx = AudioEngine.getContext()
      if (ctx) {
        let bestStep = -1
        let bestTime = -Infinity
        for (let i = 0; i < STEPS; i++) {
          const t = this.schedulerLoop?.stepTimes[i]
          if (t !== undefined && t <= ctx.currentTime && t > bestTime) {
            bestStep = i
            bestTime = t
          }
        }
        if (bestStep !== this.playheadStep) {
          this.playheadStep = bestStep
          // Read which bar is sounding out of barAtStepTime — recorded at
          // schedule time. The RAF loop only paints; it never advances
          // playback itself, audio runs ahead of the display.
          this.playingBarIndex = bestStep >= 0 ? (this.schedulerLoop?.barAtStepTime[bestStep] ?? -1) : -1
          this.updatePlayhead()
        }
      }
      this.rafId = requestAnimationFrame(tick)
    }
    tick()
  }

  updatePlayhead() {
    const showStepGlow = this.isPlaying && this.playingBarIndex === this._viewedBar
    this.container.querySelectorAll('[data-step]').forEach(el => {
      el.classList.toggle('playing', showStepGlow && Number(el.dataset.step) === this.playheadStep)
    })
    this.container.querySelectorAll('.tr909-bar-btn').forEach(el => {
      const isPlayingBar = this.isPlaying && Number(el.dataset.bar) === this.playingBarIndex
      el.classList.toggle('bar-playing', isPlayingBar)
      if (isPlayingBar) el.setAttribute('aria-current', 'true')
      else el.removeAttribute('aria-current')
    })
  }

  updateTransportButtons() {
    const barBtn = this.container.querySelector('[data-action="play-bar"]')
    const chainBtn = this.container.querySelector('[data-action="play-chain"]')
    if (barBtn) {
      barBtn.classList.toggle('active-btn', this.mode === 'bar')
      barBtn.setAttribute('aria-pressed', String(this.mode === 'bar'))
    }
    if (chainBtn) {
      chainBtn.classList.toggle('active-btn', this.mode === 'chain')
      chainBtn.setAttribute('aria-pressed', String(this.mode === 'chain'))
    }
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
