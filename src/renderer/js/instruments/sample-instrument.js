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

  // Shared expression sources: one bend offset (cents) and one vibrato LFO
  // (cents), summed into every live voice's detune. Built once per
  // instrument, not per voice. Guarded — fake test contexts and older
  // browsers may lack ConstantSourceNode or a connectable AudioParam.
  let bendSource = null
  let vibratoGain = null
  try {
    if (ctx.createConstantSource && ctx.createOscillator && ctx.createGain) {
      bendSource = ctx.createConstantSource()
      bendSource.offset.value = 0
      bendSource.start(ctx.currentTime)
      const vibratoOsc = ctx.createOscillator()
      vibratoOsc.frequency.value = 5
      vibratoGain = ctx.createGain()
      vibratoGain.gain.value = 0
      vibratoOsc.connect(vibratoGain)
      vibratoOsc.start(ctx.currentTime)
      vibratoGain._osc = vibratoOsc
    }
  } catch { bendSource = null; vibratoGain = null }

  const connectExpression = source => {
    if (!source.detune || typeof source.detune.connect !== 'function') return
    try {
      bendSource?.connect(source.detune)
      vibratoGain?.connect(source.detune)
    } catch { /* not connectable in this context */ }
  }
  const disconnectExpression = source => {
    if (!source.detune) return
    try { bendSource?.disconnect(source.detune) } catch { /* already disconnected */ }
    try { vibratoGain?.disconnect(source.detune) } catch { /* already disconnected */ }
  }

  const stop = (pitch, time = ctx.currentTime) => {
    const pendingVoice = pending.get(pitch)
    if (pendingVoice) {
      pendingVoice.released = true
      return
    }
    const voice = voices.get(pitch)
    if (!voice) return
    voices.delete(pitch)
    const release = voice.release || 0
    if (release > 0 && time >= ctx.currentTime) {
      voice.gain.gain.cancelScheduledValues?.(time)
      voice.gain.gain.setTargetAtTime?.(0, time, Math.max(0.005, release / 5))
      try { voice.source.stop(time + release * 6) } catch { /* already stopped */ }
    } else try { voice.source.stop(time) } catch { /* already stopped */ }
    if (time <= ctx.currentTime) {
      voice.source.disconnect()
      voice.gain.disconnect()
      voice.analyser?.disconnect()
      disconnectExpression(voice.source)
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
    const amplitude = zoneGain * Math.max(0, Math.min(127, velocity)) / 127
    const envelope = zone.volumeEnvelope
    if (envelope) {
      const delay = Math.max(0, envelope.delay || 0), attack = Math.max(0, envelope.attack || 0)
      const hold = Math.max(0, envelope.hold || 0), decay = Math.max(0, envelope.decay || 0)
      const sustain = amplitude * Math.max(0, Math.min(1, envelope.sustain ?? 1))
      let at = time + delay
      gain.gain.setValueAtTime(0, time)
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime?.(amplitude, at + attack)
      at += attack + hold
      gain.gain.linearRampToValueAtTime?.(sustain, at + decay)
    } else gain.gain.setValueAtTime(amplitude, time)
    // SF2 loop offsets are sample frames; Web Audio loop points are seconds.
    // Accept already-converted packs and repair early installed packs here.
    const loopStart = zone.loopStart > buffer.duration ? zone.loopStart / buffer.sampleRate : zone.loopStart
    const loopEnd = zone.loopEnd > buffer.duration ? zone.loopEnd / buffer.sampleRate : zone.loopEnd
    // Tiny SF2 loops need their volume envelope; raw repetition is harsh.
    if (Number.isFinite(loopStart) && Number.isFinite(loopEnd) && (loopEnd - loopStart >= 0.02 || envelope) && loopEnd <= buffer.duration) {
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
    connectExpression(source)
    const voice = { source, gain, analyser, release: envelope?.release || 0 }
    voices.set(pitch, voice)
    source.onended = () => {
      if (voices.get(pitch) === voice) voices.delete(pitch)
      source.disconnect()
      gain.disconnect()
      analyser?.disconnect()
      disconnectExpression(source)
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
    setBend(semitones) {
      if (!bendSource) return
      const cents = (Number(semitones) || 0) * 100
      bendSource.offset.setValueAtTime?.(cents, ctx.currentTime)
      if (!bendSource.offset.setValueAtTime) bendSource.offset.value = cents
    },
    setMod(value01) {
      if (!vibratoGain) return
      const depth = Math.max(0, Math.min(1, Number(value01) || 0)) * 50
      vibratoGain.gain.setValueAtTime?.(depth, ctx.currentTime)
      if (!vibratoGain.gain.setValueAtTime) vibratoGain.gain.value = depth
    },
    dispose() {
      disposed = true
      pending.clear()
      for (const pitch of [...voices.keys()]) stop(pitch)
      try { bendSource?.stop(ctx.currentTime) } catch { /* already stopped */ }
      bendSource?.disconnect()
      try { vibratoGain?._osc?.stop(ctx.currentTime) } catch { /* already stopped */ }
      vibratoGain?._osc?.disconnect()
      vibratoGain?.disconnect()
    }
  }
}
