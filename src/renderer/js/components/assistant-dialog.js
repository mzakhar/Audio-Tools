// assistant-dialog.js — describe an edit, read the plan, apply it as one undo.
//
// The model proposes; this file decides. Nothing a model returns reaches the
// store without validatePlan running against the state that is on screen at
// the moment Apply is clicked, and a factory name is bound through the literal
// map below — never Commands[name] with a model-supplied string.
//
// Rack-affecting plans reach audio only through rack-view.js's existing store
// subscription; this file never touches RackEngine.

import { openDialog, closeDialog } from '../ui/dialog.js'
import ProjectStore, {
  SetBpm,
  AddTrack, RemoveTrack, SetTrackInstrument, SetTrackMidiChannel,
  AddClip, RemoveClip, MoveClip, DuplicateClip, TileClip,
  SetMidiClipNotes, AddMidiNote, RemoveMidiNote,
  SetMixerParam, SetSendLevel,
  AddEffect, RemoveEffect, SetEffectParam,
  SetPatternStep, SetBarParam, ClearBar, AddBar, SetChain,
  AddModule, RemoveModule, MoveModule, SetModuleParam, SetAttenuverter, SetModuleBypass, Connect, Disconnect,
} from '../store/ProjectStore.js'
import { buildDigest } from '../../../shared/daw-assistant/digest.js'
import { validatePlan, describeAction, planToCommands } from '../../../shared/daw-assistant/plan.js'
import { resolveCitations } from '../../../shared/daw-assistant/ask.js'
import { MODULES, paramDefaults, canConnect } from '../rack/modules/index.js'

export const ASSISTANT_DIALOG_ID = 'assistant-dialog'
export const ASSISTANT_ROUTE = '/api/assistant'

/** The only names that may become a command. A descriptor naming anything
 *  else is a bug or an attack; either way the whole plan is refused. */
const FACTORIES = {
  SetBpm,
  AddTrack, RemoveTrack, SetTrackInstrument, SetTrackMidiChannel,
  AddClip, RemoveClip, MoveClip, DuplicateClip, TileClip,
  SetMidiClipNotes, AddMidiNote, RemoveMidiNote,
  SetMixerParam, SetSendLevel,
  AddEffect, RemoveEffect, SetEffectParam,
  SetPatternStep, SetBarParam, ClearBar, AddBar, SetChain,
  AddModule, RemoveModule, MoveModule, SetModuleParam, SetAttenuverter, SetModuleBypass, Connect, Disconnect,
}

/** What the shared validator cannot know: the renderer's module registry. */
export const ASSISTANT_CAPABILITIES = {
  moduleTypes: Object.keys(MODULES),
  moduleParamKeys: type => Object.keys(paramDefaults(type)),
  // Port direction and duplicates — ProjectStore.Connect checks none of it.
  canConnect: (rack, from, to) => canConnect(rack, from, to),
}

let _minted = 0
/** Unique per call, so applying one plan twice cannot collide. */
const makeId = kind => `${kind}-asst-${++_minted}-${Date.now()}`

export function bindCommands(descriptors) {
  return descriptors.map(({ factory, args }) => {
    if (!Object.prototype.hasOwnProperty.call(FACTORIES, factory)) {
      throw new TypeError(`Unknown command factory "${factory}"`)
    }
    return FACTORIES[factory](...args)
  })
}

/**
 * Re-validate against live state, then apply the whole plan or none of it.
 * -> { ok: true, summary, count } | { ok: false, errors }
 */
export function applyPlan(plan, store = ProjectStore) {
  const state = store.getState()
  const checked = validatePlan(plan, state, ASSISTANT_CAPABILITIES)
  if (!checked.ok) return { ok: false, errors: checked.errors }
  const { summary, actions } = checked.value
  let commands
  try {
    commands = bindCommands(planToCommands(checked.value, state, { makeId }))
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : 'Plan could not be applied'] }
  }
  store.dispatchBatch(commands, `Assistant: ${summary || 'plan'}`)
  return { ok: true, summary, count: actions.length }
}

/** Same-origin only; the key lives in the cluster, never here. */
async function postPlan(prompt, digest, signal) {
  const response = await fetch(ASSISTANT_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, digest, mode: 'plan' }),
    signal,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Assistant unavailable')
  if (!data.plan) throw new Error('Assistant returned no plan')
  return data.plan
}

/** Ask mode: prose plus digest paths, never a plan. Same route, no Apply. */
async function postAnswer(prompt, digest, signal) {
  const response = await fetch(ASSISTANT_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, digest, mode: 'ask' }),
    signal,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Assistant unavailable')
  if (typeof data.answer !== 'string') throw new Error('Assistant returned no answer')
  return { answer: data.answer, cited: Array.isArray(data.cited) ? data.cited : [] }
}

export class AssistantDialog {
  /** deps: { propose(prompt, digest, signal) → plan, ask(prompt, digest, signal) → { answer, cited }, store } */
  constructor(deps = {}) {
    this.propose = deps.propose || postPlan
    this.ask = deps.ask || postAnswer
    this.store = deps.store || ProjectStore
    this.plan = null
    this.controller = null
    this.el = document.getElementById(ASSISTANT_DIALOG_ID)
    if (!this.el) return
    this.promptEl = this.el.querySelector('#asst-prompt')
    this.statusEl = this.el.querySelector('#asst-status')
    this.planEl = this.el.querySelector('#asst-plan')
    this.proposeBtn = this.el.querySelector('#asst-propose-btn')
    this.applyBtn = this.el.querySelector('#asst-apply-btn')
    this.askBtn = this.el.querySelector('#asst-ask-btn')
    this.proposeBtn.addEventListener('click', () => this.runPropose())
    this.askBtn.addEventListener('click', () => this.runAsk())
    this.applyBtn.addEventListener('click', () => this.runApply())
    this.el.querySelector('#asst-discard-btn').addEventListener('click', () => closeDialog(ASSISTANT_DIALOG_ID))
    // Esc, the ✕ and Discard all land here, so a request never outlives the UI.
    this.el.addEventListener('close', () => { this.controller?.abort(); this.controller = null })
  }

  open() {
    if (!this.el) return
    openDialog(ASSISTANT_DIALOG_ID)
    this.promptEl.focus()
  }

  setStatus(text) { if (this.statusEl) this.statusEl.textContent = text }

  showPlan(plan) {
    this.plan = plan
    this.planEl.innerHTML = ''
    this.applyBtn.disabled = !plan
    if (!plan) return
    const state = this.store.getState()
    const summary = document.createElement('p')
    summary.className = 'asst-summary'
    summary.textContent = plan.summary || ''
    this.planEl.appendChild(summary)
    for (const action of plan.actions || []) {
      const row = document.createElement('div')
      row.className = 'asst-action'
      row.textContent = describeAction(action, state, plan.actions || [])
      this.planEl.appendChild(row)
    }
  }

  /** An ask result is never a plan: Apply stays disabled, always. */
  showAnswer(result, digest) {
    this.showPlan(null)
    this.planEl.innerHTML = ''
    if (!result) return
    const answer = document.createElement('p')
    answer.className = 'asst-summary'
    answer.textContent = result.answer || ''
    this.planEl.appendChild(answer)
    for (const { path, value } of resolveCitations(digest, result.cited)) {
      const row = document.createElement('div')
      row.className = 'asst-action asst-citation'
      row.textContent = `${path}: ${JSON.stringify(value)}`
      this.planEl.appendChild(row)
    }
  }

  async runPropose() {
    const prompt = (this.promptEl.value || '').trim()
    if (!prompt) { this.setStatus('Describe the edit first.'); return }
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.proposeBtn.disabled = true
    this.showPlan(null)
    this.setStatus('Thinking…')
    try {
      const plan = await this.propose(prompt, buildDigest(this.store.getState()), controller.signal)
      if (this.controller !== controller) return
      this.showPlan(plan)
      this.setStatus(`${plan.actions?.length || 0} proposed edit${plan.actions?.length === 1 ? '' : 's'}. Nothing has changed yet.`)
    } catch (error) {
      if (controller.signal.aborted) return
      this.setStatus(error instanceof Error ? error.message : 'Assistant unavailable')
    } finally {
      if (this.controller === controller) this.controller = null
      this.proposeBtn.disabled = false
    }
  }

  async runAsk() {
    const prompt = (this.promptEl.value || '').trim()
    if (!prompt) { this.setStatus('Describe the question first.'); return }
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.askBtn.disabled = true
    this.showPlan(null)
    this.setStatus('Thinking…')
    // Resolve citations against exactly what the model saw, not live state.
    const digest = buildDigest(this.store.getState())
    try {
      const result = await this.ask(prompt, digest, controller.signal)
      if (this.controller !== controller) return
      this.showAnswer(result, digest)
      this.setStatus('Answer only — nothing changed.')
    } catch (error) {
      if (controller.signal.aborted) return
      this.setStatus(error instanceof Error ? error.message : 'Assistant unavailable')
    } finally {
      if (this.controller === controller) this.controller = null
      this.askBtn.disabled = false
    }
  }

  runApply() {
    if (!this.plan) return
    const result = applyPlan(this.plan, this.store)
    if (!result.ok) {
      this.setStatus(`Plan refused, nothing applied:\n${result.errors.join('\n')}`)
      return
    }
    this.setStatus(`Applied ${result.count} edit${result.count === 1 ? '' : 's'}: ${result.summary}. Ctrl+Z reverses all of it.`)
    this.showPlan(null)
  }
}
