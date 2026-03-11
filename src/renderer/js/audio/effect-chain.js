/**
 * effect-chain.js
 * Manages an ordered chain of up to 4 effect insert slots per track.
 * Uses native Web Audio API nodes — no AudioWorklet needed.
 *
 * Chain topology: input → [effect0] → [effect1] → ... → output
 * When empty, input connects directly to output.
 */

let _chainIdCounter = 0
let _effectIdCounter = 0

function genChainId() { return `chain-${++_chainIdCounter}` }
function genEffectId() { return `effect-${++_effectIdCounter}` }

const MAX_EFFECTS = 4

// Internal storage: chainId → chainRecord
const _chains = new Map()

// ---------------------------------------------------------------------------
// Effect node factories
// ---------------------------------------------------------------------------

function _createEq3Nodes(ctx, params) {
  const defaults = { lowGain: 0, midGain: 0, highGain: 0, ...params }

  const low = ctx.createBiquadFilter()
  low.type = 'lowshelf'
  low.frequency.value = 100
  low.gain.value = Math.max(-12, Math.min(12, defaults.lowGain))

  const mid = ctx.createBiquadFilter()
  mid.type = 'peaking'
  mid.frequency.value = 1000
  mid.Q.value = 1
  mid.gain.value = Math.max(-12, Math.min(12, defaults.midGain))

  const high = ctx.createBiquadFilter()
  high.type = 'highshelf'
  high.frequency.value = 8000
  high.gain.value = Math.max(-12, Math.min(12, defaults.highGain))

  // Wire internally: low → mid → high
  low.connect(mid)
  mid.connect(high)

  return {
    inputNode: low,
    outputNode: high,
    internalNodes: [low, mid, high],
    params: { ...defaults }
  }
}

function _createCompressorNodes(ctx, params) {
  const defaults = {
    threshold: -24,
    ratio: 4,
    attack: 0.003,
    release: 0.25,
    knee: 30,
    ...params
  }

  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = Math.max(-60, Math.min(0, defaults.threshold))
  comp.ratio.value = Math.max(1, Math.min(20, defaults.ratio))
  comp.attack.value = Math.max(0, Math.min(1, defaults.attack))
  comp.release.value = Math.max(0, Math.min(1, defaults.release))
  comp.knee.value = Math.max(0, Math.min(40, defaults.knee))

  return {
    inputNode: comp,
    outputNode: comp,
    internalNodes: [comp],
    params: { ...defaults }
  }
}

function _createGainNodes(ctx, params) {
  const defaults = { gain: 1, ...params }

  const g = ctx.createGain()
  g.gain.value = Math.max(0, Math.min(4, defaults.gain))

  return {
    inputNode: g,
    outputNode: g,
    internalNodes: [g],
    params: { ...defaults }
  }
}

function _createEffectNodes(ctx, type, params) {
  switch (type) {
    case 'eq3':        return _createEq3Nodes(ctx, params || {})
    case 'compressor': return _createCompressorNodes(ctx, params || {})
    case 'gain':       return _createGainNodes(ctx, params || {})
    default:           throw new Error(`Unknown effect type: ${type}`)
  }
}

// ---------------------------------------------------------------------------
// Rewiring helpers
// ---------------------------------------------------------------------------

/**
 * Rewire the full chain: input → effects[0] → effects[1] → ... → output.
 * Disconnects all first, then reconnects in order.
 */
function _rewire(chain) {
  const { input, output, effects } = chain

  // Disconnect input from everything
  try { input.disconnect() } catch (_) { /* safe */ }

  // Disconnect each effect's output node from everything
  for (const effect of effects) {
    try { effect.nodes.outputNode.disconnect() } catch (_) { /* safe */ }
  }

  if (effects.length === 0) {
    input.connect(output)
    return
  }

  // input → first effect
  input.connect(effects[0].nodes.inputNode)

  // chain effects
  for (let i = 0; i < effects.length - 1; i++) {
    effects[i].nodes.outputNode.connect(effects[i + 1].nodes.inputNode)
  }

  // last effect → output
  effects[effects.length - 1].nodes.outputNode.connect(output)
}

// ---------------------------------------------------------------------------
// Param setters
// ---------------------------------------------------------------------------

function _setEq3Param(nodes, param, value) {
  const [low, mid, high] = nodes.internalNodes
  switch (param) {
    case 'lowGain':  low.gain.value  = Math.max(-12, Math.min(12, value)); break
    case 'midGain':  mid.gain.value  = Math.max(-12, Math.min(12, value)); break
    case 'highGain': high.gain.value = Math.max(-12, Math.min(12, value)); break
    default: throw new Error(`Unknown eq3 param: ${param}`)
  }
}

function _setCompressorParam(nodes, param, value) {
  const comp = nodes.internalNodes[0]
  switch (param) {
    case 'threshold': comp.threshold.value = Math.max(-60, Math.min(0,  value)); break
    case 'ratio':     comp.ratio.value     = Math.max(1,   Math.min(20, value)); break
    case 'attack':    comp.attack.value    = Math.max(0,   Math.min(1,  value)); break
    case 'release':   comp.release.value   = Math.max(0,   Math.min(1,  value)); break
    case 'knee':      comp.knee.value      = Math.max(0,   Math.min(40, value)); break
    default: throw new Error(`Unknown compressor param: ${param}`)
  }
}

function _setGainParam(nodes, param, value) {
  const g = nodes.internalNodes[0]
  switch (param) {
    case 'gain': g.gain.value = Math.max(0, Math.min(4, value)); break
    default: throw new Error(`Unknown gain param: ${param}`)
  }
}

function _setNodeParam(type, nodes, param, value) {
  switch (type) {
    case 'eq3':        _setEq3Param(nodes, param, value);        break
    case 'compressor': _setCompressorParam(nodes, param, value); break
    case 'gain':       _setGainParam(nodes, param, value);       break
    default: throw new Error(`Unknown effect type: ${type}`)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const EffectChain = {
  /**
   * Create a new empty chain for a track channel.
   * @param {AudioContext} ctx
   * @param {AudioNode} input  — node whose output feeds into the chain
   * @param {AudioNode} output — destination node (e.g. panNode or masterInput)
   * @returns {string} chainHandle (chainId)
   */
  create(ctx, input, output) {
    const id = genChainId()
    const chain = { id, ctx, input, output, effects: [] }
    _chains.set(id, chain)
    _rewire(chain)
    return id
  },

  /**
   * Add an effect at the end of the chain (position is appended; limit 4).
   * @param {string} chainHandle
   * @param {string} type  — 'eq3' | 'compressor' | 'gain'
   * @param {object} [params] — initial param values
   * @returns {string} effectId
   */
  addEffect(chainHandle, type, params) {
    const chain = _chains.get(chainHandle)
    if (!chain) throw new Error(`Unknown chain: ${chainHandle}`)
    if (chain.effects.length >= MAX_EFFECTS) {
      throw new Error(`Effect chain is full (max ${MAX_EFFECTS} effects)`)
    }

    const effectId = genEffectId()
    const nodes = _createEffectNodes(chain.ctx, type, params)
    chain.effects.push({ id: effectId, type, nodes })
    _rewire(chain)
    return effectId
  },

  /**
   * Remove an effect by id and rewire the remaining effects.
   * @param {string} chainHandle
   * @param {string} effectId
   */
  removeEffect(chainHandle, effectId) {
    const chain = _chains.get(chainHandle)
    if (!chain) throw new Error(`Unknown chain: ${chainHandle}`)

    const idx = chain.effects.findIndex(e => e.id === effectId)
    if (idx === -1) return // silently ignore unknown effectId

    const [removed] = chain.effects.splice(idx, 1)

    // Disconnect all internal nodes of the removed effect
    for (const node of removed.nodes.internalNodes) {
      try { node.disconnect() } catch (_) { /* safe */ }
    }

    _rewire(chain)
  },

  /**
   * Update a single param on an effect.
   * @param {string} chainHandle
   * @param {string} effectId
   * @param {string} param
   * @param {number} value
   */
  setEffectParam(chainHandle, effectId, param, value) {
    const chain = _chains.get(chainHandle)
    if (!chain) throw new Error(`Unknown chain: ${chainHandle}`)

    const effect = chain.effects.find(e => e.id === effectId)
    if (!effect) throw new Error(`Unknown effect: ${effectId}`)

    _setNodeParam(effect.type, effect.nodes, param, value)
    effect.nodes.params[param] = value
  },

  /**
   * Get a copy of the current params for an effect.
   * @param {string} chainHandle
   * @param {string} effectId
   * @returns {object} params
   */
  getEffectParams(chainHandle, effectId) {
    const chain = _chains.get(chainHandle)
    if (!chain) throw new Error(`Unknown chain: ${chainHandle}`)

    const effect = chain.effects.find(e => e.id === effectId)
    if (!effect) throw new Error(`Unknown effect: ${effectId}`)

    return { ...effect.nodes.params }
  },

  /**
   * Destroy the chain and disconnect all nodes.
   * @param {string} chainHandle
   */
  destroy(chainHandle) {
    const chain = _chains.get(chainHandle)
    if (!chain) return

    // Disconnect input
    try { chain.input.disconnect() } catch (_) { /* safe */ }

    // Disconnect all effect internal nodes
    for (const effect of chain.effects) {
      for (const node of effect.nodes.internalNodes) {
        try { node.disconnect() } catch (_) { /* safe */ }
      }
    }

    _chains.delete(chainHandle)
  }
}

export default EffectChain
