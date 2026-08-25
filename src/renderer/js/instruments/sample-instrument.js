function zoneFor(patch, pitch, velocity) {
  return patch?.zones?.find(zone => pitch >= zone.keyLo && pitch <= zone.keyHi &&
    (zone.velocityLo === undefined || velocity >= zone.velocityLo) &&
    (zone.velocityHi === undefined || velocity <= zone.velocityHi)) || null
}

/** One Web Audio source per held note; sample loading stays in the injected store. */
export function sampleInstrumentFor(patch, { ctx, output, sampleStore }) {
  if (!ctx || !output || !sampleStore?.get) throw new TypeError('sample instrument needs ctx, output, and sampleStore')
  const voices = new Map()
  const pending = new Map()
  let disposed = false

  const stop = (pitch) => {
    pending.delete(pitch)
    const voice = voices.get(pitch)
    if (!voice) return
    voices.delete(pitch)
    try { voice.source.stop(ctx.currentTime) } catch { /* already stopped */ }
    voice.source.disconnect()
    voice.gain.disconnect()
  }

  const start = (pitch, velocity, zone, buffer, token) => {
    if (disposed || pending.get(pitch) !== token) return
    pending.delete(pitch)
    const source = ctx.createBufferSource()
    const gain = ctx.createGain()
    source.buffer = buffer
    source.playbackRate.value = Math.pow(2, (pitch - zone.rootKey) / 12)
    gain.gain.setValueAtTime((zone.gain ?? 1) * Math.max(0, Math.min(127, velocity)) / 127, ctx.currentTime)
    if (Number.isFinite(zone.loopStart) && Number.isFinite(zone.loopEnd) && zone.loopEnd > zone.loopStart) {
      source.loop = true
      source.loopStart = zone.loopStart
      source.loopEnd = zone.loopEnd
    }
    source.connect(gain)
    gain.connect(output)
    const voice = { source, gain }
    voices.set(pitch, voice)
    source.onended = () => {
      if (voices.get(pitch) !== voice) return
      voices.delete(pitch)
      source.disconnect()
      gain.disconnect()
    }
    source.start(ctx.currentTime)
  }

  return {
    noteOn(pitch, velocity = 127) {
      stop(pitch)
      const zone = zoneFor(patch, pitch, velocity)
      if (!zone || disposed) return
      const token = {}
      pending.set(pitch, token)
      Promise.resolve(sampleStore.get(zone.sampleId)).then(buffer => start(pitch, velocity, zone, buffer, token)).catch(() => {
        if (pending.get(pitch) === token) pending.delete(pitch)
      })
    },
    noteOff: stop,
    preload() { return sampleStore.preload ? sampleStore.preload((patch.zones || []).map(zone => zone.sampleId)) : Promise.all((patch.zones || []).map(zone => sampleStore.get(zone.sampleId))) },
    dispose() {
      disposed = true
      pending.clear()
      for (const pitch of [...voices.keys()]) stop(pitch)
    }
  }
}
