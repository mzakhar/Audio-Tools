// rack-engine.js — patch state → live Web Audio graph.
//
// The engine is the only thing that connects one module to another; modules
// never know about each other (specs/modular-rack.md §5.3). All node churn is
// keyed on ids, so moving a module or recolouring a cable rebuilds nothing.

import MODULES, { paramDefaults } from './modules/index.js'
import { resolveChannels } from './poly.js'

// ─── Cycle detection ───────────────────────────────────────────────────────
// Web Audio needs a DelayNode inside any cycle, and imposes a one-render-
// quantum (128 sample) minimum latency across it. We find the cycle-closing
// cables so the engine can insert DelayNode(0) exactly there.

export function findCycleCables(rack) {
  const out = new Map()   // moduleId → cables leaving it
  for (const cable of rack.cables) {
    if (!out.has(cable.from.moduleId)) out.set(cable.from.moduleId, [])
    out.get(cable.from.moduleId).push(cable)
  }

  const cycleCables = new Set()
  const state = new Map()  // moduleId → 'open' | 'done'

  const visit = (moduleId) => {
    state.set(moduleId, 'open')
    for (const cable of out.get(moduleId) || []) {
      const next = cable.to.moduleId
      if (state.get(next) === 'open') cycleCables.add(cable.id)   // back edge
      else if (state.get(next) !== 'done') visit(next)
    }
    state.set(moduleId, 'done')
  }

  for (const mod of rack.modules) if (!state.has(mod.id)) visit(mod.id)
  return cycleCables
}

// ─── Module instances ──────────────────────────────────────────────────────

// A module type the registry does not know, or a worklet-tier module on a host
// without `audioWorklet`. Its state and cables survive; it just makes no sound.
function placeholderInstance() {
  return { inputs: {}, outputs: {}, placeholder: true, setParam() {}, dispose() {} }
}

function createModule(handle, mod, channels) {
  const def = handle.registry[mod.type]
  const params = { ...paramDefaults(mod.type), ...mod.params }
  if (!def || (def.tier === 'worklet' && !handle.hasWorklet)) {
    return { def: def || null, inst: placeholderInstance(), channels, params }
  }
  const inst = def.create(handle.ctx, {
    channels,
    params,
    ctxTime: handle.ctx.currentTime,
    onParam: handle.onParam,
    poll: handle.poll,
    random: handle.random,
    emitEvent: (port, event) => RackEngine.emitEvent(handle, mod.id, port, event)
  })
  if (def.terminal && inst.output && handle.output) inst.output.connect(handle.output)
  return { def, inst, channels, params }
}

function disposeModule(handle, entry) {
  if (entry.def?.terminal && entry.inst.output && handle.output) {
    try { entry.inst.output.disconnect(handle.output) } catch { /* already gone */ }
  }
  entry.inst.dispose()
}

// ─── Cables ────────────────────────────────────────────────────────────────

// Attenuverters live in the engine, not in modules: one GainNode per
// (module, input port, channel), shared by every cable landing on that input,
// so several cables into one attenuated input still sum before attenuation.
function attenNode(handle, moduleId, portId, channel, target) {
  const key = `${moduleId}:${portId}:${channel}`
  let node = handle.atten.get(key)
  if (!node) {
    node = handle.ctx.createGain()
    // Unity, not zero: nothing in the UI turns an attenuverter up yet, so a 0
    // default silently swallows every cable into an attenuated input. An explicit
    // stored 0 still means 0 — only the absent case changes.
    node.gain.value = handle.rack.modules.find(m => m.id === moduleId)?.atten?.[portId] ?? 1
    node.connect(target)
    handle.atten.set(key, node)
  }
  return node
}

function connectCable(handle, cable, cycleCables) {
  const src = handle.mods.get(cable.from.moduleId)
  const dst = handle.mods.get(cable.to.moduleId)
  const link = { links: [], nodes: [] }
  handle.cables.set(cable.id, link)
  if (!src || !dst) return

  const srcPorts = src.inst.outputs[cable.from.port]
  const dstPorts = dst.inst.inputs[cable.to.port]
  if (!srcPorts?.length || !dstPorts?.length) return   // placeholder, or bad patch

  const attenuated = !!dst.def?.ports.find(p => p.id === cable.to.port)?.atten
  const inCycle = cycleCables.has(cable.id)

  // The eurorack/VCV channel rules, both directions: a poly source into a mono
  // destination sums down, and a mono source into a poly destination fans out to
  // every channel. Without the fan-out an LFO into a 4-voice VCA's CV would
  // modulate voice 1 and leave the rest wide open.
  const pairs = dstPorts.length === 1
    ? srcPorts.map(s => [s, dstPorts[0]])
    : srcPorts.length === 1
      ? dstPorts.map(d => [srcPorts[0], d])
      : srcPorts.slice(0, dstPorts.length).map((s, i) => [s, dstPorts[i]])

  pairs.forEach(([from, to], i) => {
    let target = attenuated ? attenNode(handle, cable.to.moduleId, cable.to.port, i, to) : to
    if (inCycle) {
      const delay = handle.ctx.createDelay(1)
      delay.delayTime.value = 0
      delay.connect(target)
      link.nodes.push(delay)
      target = delay
    }
    from.connect(target)
    link.links.push([from, target])
  })
}

function disconnectCable(handle, cableId) {
  const link = handle.cables.get(cableId)
  if (!link) return
  for (const [from, to] of link.links) {
    try { from.disconnect(to) } catch { /* node already disposed */ }
  }
  for (const node of link.nodes) {
    try { node.disconnect() } catch { /* already gone */ }
  }
  handle.cables.delete(cableId)
}

// A normalled input — VCA's CV resting at unity so an unpatched VCA still
// passes audio — has to drop its normal the moment a cable lands on it, or the
// patched signal adds to unity instead of replacing it. Only the engine knows
// the cables, so the engine tells the module; the module just owns the switch.
function syncNormals(handle) {
  for (const [id, entry] of handle.mods) {
    if (!entry.inst.setInputPatched) continue
    for (const port of entry.def?.ports || []) {
      if (port.dir !== 'in') continue
      entry.inst.setInputPatched(port.id, handle.rack.cables.some(c => c.to.moduleId === id && c.to.port === port.id))
    }
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

// A deep but finite chain (a burst into a divider into a sequencer) is legal;
// anything past this is a cycle. One counter for the whole module is enough —
// dispatch is synchronous and single-threaded, so no two emits ever interleave.
const MAX_EVENT_DEPTH = 64
let emitDepth = 0

const RackEngine = {
  // `random` is injected rather than reached for: stochastic modules become
  // testable with a scripted sequence, and an offline bounce can pass a seeded
  // PRNG to render the same take twice.
  mount(ctx, rackState, { output = null, registry = MODULES, hasWorklet = true, onParam = null, poll = null, random = Math.random } = {}) {
    const handle = {
      ctx,
      output,
      registry,
      hasWorklet,
      onParam,
      poll,
      random,
      rack: JSON.parse(JSON.stringify(rackState)),
      mods: new Map(),
      cables: new Map(),
      atten: new Map(),
    }
    const channels = resolveChannels(handle.rack, registry)
    for (const mod of handle.rack.modules) {
      handle.mods.set(mod.id, createModule(handle, mod, channels.get(mod.id) ?? 1))
    }
    const cycleCables = findCycleCables(handle.rack)
    for (const cable of handle.rack.cables) connectCable(handle, cable, cycleCables)
    syncNormals(handle)
    return handle
  },

  // Diff by id. Anything that does not change audio (position, name, colour)
  // must produce zero node churn.
  update(handle, nextState) {
    const next = JSON.parse(JSON.stringify(nextState))
    const prev = handle.rack
    const prevMods = new Map(prev.modules.map(m => [m.id, m]))
    const nextMods = new Map(next.modules.map(m => [m.id, m]))
    const nextChannels = resolveChannels(next, handle.registry)

    // 1. cables first — a cable into a module about to be rebuilt must go
    //    before the module does, or it holds a reference to a dead node.
    const prevCables = new Map(prev.cables.map(c => [c.id, c]))
    const nextCables = new Map(next.cables.map(c => [c.id, c]))
    const rebuilt = new Set()

    for (const mod of next.modules) {
      const before = prevMods.get(mod.id)
      const entry = handle.mods.get(mod.id)
      if (!before || !entry) continue
      if (entry.channels !== (nextChannels.get(mod.id) ?? 1)) rebuilt.add(mod.id)
    }

    const touched = cableId => {
      const c = prevCables.get(cableId)
      return c && (rebuilt.has(c.from.moduleId) || rebuilt.has(c.to.moduleId))
    }

    for (const id of [...handle.cables.keys()]) {
      if (!nextCables.has(id) || touched(id)) disconnectCable(handle, id)
    }

    // 2. modules: remove, rebuild, add
    for (const [id, entry] of [...handle.mods]) {
      if (!nextMods.has(id) || rebuilt.has(id)) {
        disposeModule(handle, entry)
        handle.mods.delete(id)
        for (const key of [...handle.atten.keys()]) {
          if (key.startsWith(`${id}:`)) handle.atten.delete(key)
        }
      }
    }

    handle.rack = next
    for (const mod of next.modules) {
      if (handle.mods.has(mod.id)) continue
      handle.mods.set(mod.id, createModule(handle, mod, nextChannels.get(mod.id) ?? 1))
    }

    // 3. params and attenuverters on surviving modules — no churn
    for (const mod of next.modules) {
      const entry = handle.mods.get(mod.id)
      const before = prevMods.get(mod.id)
      if (!entry || !before || rebuilt.has(mod.id)) continue
      const params = { ...paramDefaults(mod.type), ...mod.params }
      for (const [key, value] of Object.entries(params)) {
        if (entry.params[key] !== value) entry.inst.setParam?.(key, value, handle.ctx.currentTime)
      }
      entry.params = params
      for (const [portId, value] of Object.entries(mod.atten || {})) {
        if ((before.atten?.[portId] ?? 0) === value) continue
        for (let ch = 0; ch < entry.channels; ch++) {
          const node = handle.atten.get(`${mod.id}:${portId}:${ch}`)
          if (node) node.gain.setTargetAtTime(value, handle.ctx.currentTime, 0.01)
        }
      }
    }

    // 4. new and re-made cables
    const cycleCables = findCycleCables(next)
    for (const cable of next.cables) {
      if (!handle.cables.has(cable.id)) connectCable(handle, cable, cycleCables)
    }
    syncNormals(handle)
    return handle
  },

  // Knob drags: live audio now, one coalesced store command on pointer-up.
  setParamLive(handle, moduleId, key, value) {
    const entry = handle.mods.get(moduleId)
    if (!entry) return
    entry.params[key] = value
    entry.inst.setParam?.(key, value, handle.ctx.currentTime)
  },

  setAttenLive(handle, moduleId, portId, value) {
    const entry = handle.mods.get(moduleId)
    if (!entry) return
    for (let ch = 0; ch < entry.channels; ch++) {
      const node = handle.atten.get(`${moduleId}:${portId}:${ch}`)
      if (node) node.gain.setTargetAtTime(value, handle.ctx.currentTime, 0.01)
    }
  },

  // Event domain (§5.4): scheduled gates travel as direct calls along cables,
  // carrying an audio-context timestamp in the future.
  //
  // Dispatch is synchronous, so a patched event cycle (AD's EOC back into its own
  // TRIG is the obvious one) recurses until the stack blows and takes the tab
  // with it. Cables are the user's to patch, so the guard lives here rather than
  // in any module: past MAX_EVENT_DEPTH the chain is simply dropped.
  emitEvent(handle, fromModuleId, fromPort, event) {
    if (emitDepth >= MAX_EVENT_DEPTH) return
    emitDepth++
    try {
      for (const cable of handle.rack.cables) {
        if (cable.from.moduleId !== fromModuleId || cable.from.port !== fromPort) continue
        handle.mods.get(cable.to.moduleId)?.inst.onEvent?.(cable.to.port, event)
      }
    } finally {
      emitDepth--
    }
  },

  sendEvent(handle, moduleId, portId, event) {
    handle.mods.get(moduleId)?.inst.onEvent?.(portId, event)
  },

  getChannels(handle, moduleId) { return handle.mods.get(moduleId)?.channels ?? 0 },
  getInstance(handle, moduleId) { return handle.mods.get(moduleId)?.inst ?? null },

  unmount(handle) {
    for (const id of [...handle.cables.keys()]) disconnectCable(handle, id)
    for (const [, entry] of handle.mods) disposeModule(handle, entry)
    for (const [, node] of handle.atten) { try { node.disconnect() } catch { /* gone */ } }
    handle.mods.clear()
    handle.atten.clear()
  }
}

export default RackEngine
