// The rack factory contract is synchronous; real AudioWorkletNode construction
// needs async module loading. Keep these modules explicit placeholders until
// that infrastructure exists, while retaining their patch schema.
export function workletModule(def) {
  return { ...def, tier: 'worklet', processorUrl: 'worklets/rack-p1-processor.js', create(ctx) { const input = ctx.createGain(), output = ctx.createGain(); input.connect(output); const inputs = Object.fromEntries(def.ports.filter(p => p.dir === 'in').map(p => [p.id, [input]])); const outputs = Object.fromEntries(def.ports.filter(p => p.dir === 'out').map(p => [p.id, [output]])); return { inputs, outputs, setParam() {}, dispose() { input.disconnect(); output.disconnect() } } } }
}
