// modules/index.js — modular rack module registry.
//
// A module definition is pure data plus a `create(ctx, opts)` factory
// (see specs/modular-rack.md §5.2). `create` receives the BaseAudioContext
// explicitly and reads no globals — that is what makes offline bounce and
// unit testing possible.

import vco from './vco.js'
import noise from './noise.js'
import vcf from './vcf.js'
import adsr from './adsr.js'
import lfo from './lfo.js'
import vca from './vca.js'
import mix from './mix.js'
import att from './att.js'
import out from './out.js'
import clock from './clock.js'
import seq8 from './seq8.js'
import clkdiv from './clkdiv.js'
import ad from './ad.js'
import rnd from './rnd.js'
import euclid from './euclid.js'
// NOTE: file is quantizer.js, not quant.js — ad-block filter lists block `quant.js`
// (Quantcast rule), which aborts the whole module graph and blanks the app.
import quant from './quantizer.js'
import midiIn from './midi-in.js'
import keys from './keys.js'
import audioIn from './audio-in.js'
import paramOut from './param-out.js'
import fmop from './fmop.js'
import drum from './drum.js'
import fold from './fold.js'
import slew from './slew.js'
import sh from './sh.js'
import comp from './comp.js'
import scope from './scope.js'
import cvMon from './cv-mon.js'
import tuner from './tuner.js'
import delay from './delay.js'
import drive from './drive.js'
import math from './math.js'
import mult from './mult.js'
import sum from './sum.js'
import reverb from './reverb.js'
import chorus from './chorus.js'
import ringmod from './ringmod.js'
import split from './split.js'
import merge from './merge.js'

const MODULE_LIST = [vco, noise, vcf, adsr, lfo, vca, mix, att, out, clock, seq8, clkdiv, ad, rnd, euclid, quant, midiIn, keys, audioIn, paramOut, fmop, drum, fold, slew, sh, comp, scope, cvMon, tuner, delay, drive, math, mult, sum, reverb, chorus, ringmod, split, merge]

export const MODULES = Object.fromEntries(MODULE_LIST.map(m => [m.type, m]))

export const VALID_GROUPS = ['source', 'mod', 'filter', 'env', 'seq', 'util', 'fx', 'io']
export const VALID_KINDS = ['audio', 'cv', 'gate']
export const VALID_TIERS = ['native', 'worklet']

// Width used for a module type that is not in the registry. Unknown modules
// still lay out and still round-trip through save/load — they never get dropped.
export const UNKNOWN_MODULE = {
  type: 'unknown',
  name: 'Unknown',
  group: 'util',
  hp: 8,
  tier: 'native',
  poly: false,
  ports: [],
  params: [],
  placeholder: true,
}

export function getModule(type) {
  return MODULES[type] || null
}

export function getPort(type, portId) {
  return getModule(type)?.ports.find(p => p.id === portId) || null
}

export function paramDefaults(type) {
  const def = getModule(type)
  if (!def) return {}
  return Object.fromEntries(def.params.map(p => [p.key, p.def]))
}

// ─── Validation ────────────────────────────────────────────────────────────
// Runs at import time in dev and in the test suite: a malformed module should
// fail the suite, not the user's speakers.

export function validateRegistry(registry = MODULES) {
  const errors = []
  const seen = new Set()

  for (const [key, def] of Object.entries(registry)) {
    const at = msg => errors.push(`${key}: ${msg}`)

    if (!def.type) at('missing type')
    else if (def.type !== key) at(`registry key "${key}" does not match type "${def.type}"`)
    if (seen.has(def.type)) at('duplicate type')
    seen.add(def.type)

    if (!def.name) at('missing name')
    if (!VALID_GROUPS.includes(def.group)) at(`invalid group "${def.group}"`)
    if (!VALID_TIERS.includes(def.tier)) at(`invalid tier "${def.tier}"`)
    if (!Number.isInteger(def.hp) || def.hp <= 0) at('hp must be a positive integer')
    if (def.tier === 'worklet' && !def.processorUrl) at('worklet tier must declare processorUrl')
    if (typeof def.create !== 'function') at('missing create()')

    if (!Array.isArray(def.ports)) { at('ports must be an array'); continue }
    const portIds = new Set()
    for (const port of def.ports) {
      if (!port.id) at('port missing id')
      if (portIds.has(port.id)) at(`duplicate port id "${port.id}"`)
      portIds.add(port.id)
      if (port.dir !== 'in' && port.dir !== 'out') at(`port "${port.id}" has invalid dir "${port.dir}"`)
      if (!VALID_KINDS.includes(port.kind)) at(`port "${port.id}" has invalid kind "${port.kind}"`)
      if (port.atten && port.dir !== 'in') at(`port "${port.id}" is an output and cannot have an attenuverter`)
    }

    if (!Array.isArray(def.params)) { at('params must be an array'); continue }
    const paramKeys = new Set()
    for (const param of def.params) {
      if (!param.key) at('param missing key')
      if (paramKeys.has(param.key)) at(`duplicate param key "${param.key}"`)
      paramKeys.add(param.key)
      if (param.def === undefined) at(`param "${param.key}" has no default`)
      if (param.options) {
        if (!param.options.includes(param.def)) at(`param "${param.key}" default is not one of its options`)
      } else if (typeof param.def === 'number') {
        if (!(param.min <= param.def && param.def <= param.max)) {
          at(`param "${param.key}" default ${param.def} is outside [${param.min}, ${param.max}]`)
        }
      }
      // A param key may match a port id on purpose — a RES knob next to a RES
      // CV jack is standard hardware. Params and ports are separate namespaces.
    }
  }

  return errors
}

// ─── Patching rules (specs/modular-rack.md §4.4) ───────────────────────────
// All kinds are electrically the same signal, so any output may connect to any
// input. Kind only drives colour and a soft warning.

export function canConnect(rack, from, to, registry = MODULES) {
  const modOf = id => rack.modules.find(m => m.id === id)
  const portOf = (end) => {
    const mod = modOf(end.moduleId)
    if (!mod) return null
    const def = registry[mod.type]
    if (!def) return null
    return def.ports.find(p => p.id === end.port) || null
  }

  const src = portOf(from)
  const dst = portOf(to)
  if (!src || !dst) return { ok: false, reason: 'unknown port' }
  if (src.dir !== 'out') return { ok: false, reason: 'source must be an output' }
  if (dst.dir !== 'in') return { ok: false, reason: 'destination must be an input' }

  const dup = rack.cables.some(c =>
    c.from.moduleId === from.moduleId && c.from.port === from.port &&
    c.to.moduleId === to.moduleId && c.to.port === to.port
  )
  if (dup) return { ok: false, reason: 'already patched' }

  return { ok: true, mismatch: src.kind !== dst.kind }
}

if (import.meta.env?.DEV) {
  const errors = validateRegistry()
  if (errors.length) throw new Error(`Invalid module registry:\n  ${errors.join('\n  ')}`)
}

export default MODULES
