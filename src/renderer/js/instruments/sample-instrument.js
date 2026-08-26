function zoneFor(patch, pitch, velocity) {
  return patch?.zones?.find(zone => pitch >= zone.keyLo && pitch <= zone.keyHi &&
    (zone.velocityLo === undefined || velocity >= zone.velocityLo) &&
    (zone.velocityHi === undefined || velocity <= zone.velocityHi)) || null
}

/** One Web Audio source per held note; sample loading stays in the injected store. */
export function sampleInstrumentFor(patch, { ctx, output, sampleStore, onStatus = () => {} }) {
  if (!ctx || !output || !sampleStore?.get) throw new TypeError('sample instrument needs ctx, output, and sampleStore')
  const voices = new Map()
  const pending = new Map()
  let disposed = false

  const stop = (pitch, time = ctx.currentTime) => {
    const pendingVoice = pending.get(pitch)
    if (pendingVoice) {
      pendingVoice.released = true
      return
    }
    const voice = voices.get(pitch)
    if (!voice) return
    voices.delete(pitch)
    try { voice.source.stop(time) } catch { /* already stopped */ }
    if (time <= ctx.currentTime) {
      voice.source.disconnect()
      voice.gain.disconnect()
      voice.analyser?.disconnect()
    }
  }

  const start = (pitch, velocity, zone, buffer, token, time) => {
    const pendingVoice = pending.get(pitch)
    if (disposed || pendingVoice?.token !== token) return
    pending.delete(pitch)
    const source = ctx.createBufferSource()
    const gain = ctx.createGain()
    source.buffer = buffer
    const tune = Number.isFinite(zone.tune) && Math.abs(zone.tune) <= 2400 ? zone.tune : 0
    source.playbackRate.value = Math.pow(2, (pitch - zone.rootKey - tune / 100) / 12)
    // Earlier SF2 imports stored attenuation as zero/negative gain. Treat it
    // as unity so existing local packs become audible after this fix.
    const zoneGain = Number.isFinite(zone.gain) && zone.gain > 0 ? zone.gain : 1
    gain.gain.setValueAtTime(zoneGain * Math.max(0, Math.min(127, velocity)) / 127, time)
    // SF2 loop offsets are sample frames; Web Audio loop points are seconds.
    // Accept already-converted packs and repair early installed packs here.
    const loopStart = zone.loopStart > buffer.duration ? zone.loopStart / buffer.sampleRate : zone.loopStart
    const loopEnd = zone.loopEnd > buffer.duration ? zone.loopEnd / buffer.sampleRate : zone.loopEnd
    // Tiny SF2 loops rely on an SF2 volume envelope we do not render. Repeating
    // them raw turns a natural attack into a harsh buzzy sustain.
    if (Number.isFinite(loopStart) && Number.isFinite(loopEnd) && loopEnd - loopStart >= 0.02 && loopEnd <= buffer.duration) {
      source.loop = true
      source.loopStart = loopStart
      source.loopEnd = loopEnd
    }
    const analyser = ctx.createAnalyser?.()
    if (analyser) {
      analyser.fftSize = 256
      gain.connect(analyser)
      analyser.connect(output)
    } else gain.connect(output)
    source.connect(gain)
    const voice = { source, gain, analyser }
    voices.set(pitch, voice)
    source.onended = () => {
      if (voices.get(pitch) === voice) voices.delete(pitch)
      source.disconnect()
      gain.disconnect()
      analyser?.disconnect()
    }
    source.start(time)
    if (pendingVoice.released) source.stop(Math.max(time, ctx.currentTime) + 0.08)
    onStatus({ state: 'started', sampleId: zone.sampleId, pitch, gain: zoneGain, duration: buffer.duration })
    // Visible signal probe remains in the active source route, otherwise
    // Web Audio may skip rendering its passive analyser branch.
    if (analyser) {
      setTimeout(() => {
        const data = new Float32Array(analyser.fftSize)
        analyser.getFloatTimeDomainData(data)
        let peak = 0
        for (const value of data) peak = Math.max(peak, Math.abs(value))
        onStatus({ state: 'track-signal', sampleId: zone.sampleId, peak })
      }, 100)
    }
  }

  return {
    noteOn(pitch, velocity = 127, time = ctx.currentTime) {
      stop(pitch)
      const zone = zoneFor(patch, pitch, velocity)
      if (!zone || disposed) return
      const token = {}
      pending.set(pitch, { token, released: false })
      onStatus({ state: 'loading', sampleId: zone.sampleId, pitch })
      const cached = sampleStore.peek?.(zone.sampleId)
      if (cached) return start(pitch, velocity, zone, cached, token, time)
      Promise.resolve(sampleStore.get(zone.sampleId)).then(buffer => start(pitch, velocity, zone, buffer, token, time)).catch(error => {
        if (pending.get(pitch)?.token === token) pending.delete(pitch)
        onStatus({ state: 'error', sampleId: zone.sampleId, pitch, error: error?.message || 'Sample load failed' })
      })
    },
    noteOff: stop,
    preload(pitch, velocity = 127) {
      const zone = Number.isFinite(pitch) && zoneFor(patch, pitch, velocity)
      const sampleIds = zone ? [zone.sampleId] : (patch.zones || []).map(item => item.sampleId)
      return sampleStore.preload ? sampleStore.preload(sampleIds) : Promise.all(sampleIds.map(sampleId => sampleStore.get(sampleId)))
    },
    dispose() {
      disposed = true
      pending.clear()
      for (const pitch of [...voices.keys()]) stop(pitch)
    }
  }
}
