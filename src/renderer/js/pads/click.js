// Metronome click: one short oscillator blip. Accent = higher and louder.
// No worklet — plain nodes, safe on the plain-HTTP LAN route.
export function playClick(ctx, output, accent, time) {
  if (!ctx || !output) return
  const t = Math.max(time, ctx.currentTime)
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.frequency.value = accent ? 1600 : 1000
  const peak = accent ? 0.5 : 0.28
  gain.gain.setValueAtTime(peak, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04)
  osc.connect(gain)
  gain.connect(output)
  osc.start(t)
  osc.stop(t + 0.05)
  osc.onended = () => { osc.disconnect(); gain.disconnect() }
}
