/**
 * mixer-strip.js
 * Per-track mixer channel strip: label, volume fader, pan, mute/solo,
 * a row of up to 4 effect insert slots, and a sends section.
 */
export class MixerStrip {
  constructor(container, { channel, track, onParam, onAddEffect, onRemoveEffect, onSendLevel, buses }) {
    this._channelId = channel.id
    this._onParam = onParam
    this._onAddEffect = onAddEffect || null
    this._onRemoveEffect = onRemoveEffect || null
    this._onSendLevel = onSendLevel ?? null
    this._buses = buses ?? []
    this._el = document.createElement('div')
    this._el.className = 'mixer-strip'
    this._render(channel, track)
    container.appendChild(this._el)
  }

  _render(channel, track) {
    this._el.innerHTML = ''

    const label = document.createElement('div')
    label.className = 'mixer-strip-label'
    label.textContent = track?.name ?? 'Track'

    const volFader = document.createElement('input')
    volFader.type = 'range'
    volFader.className = 'mixer-fader filled'
    volFader.min = 0; volFader.max = 1; volFader.step = 0.01
    volFader.value = channel.volume
    const volPct = channel.volume * 100
    volFader.style.setProperty('--fill', volPct + '%')
    volFader.addEventListener('input', () => {
      const v = parseFloat(volFader.value)
      volFader.style.setProperty('--fill', v * 100 + '%')
      this._onParam(this._channelId, 'volume', v)
    })

    const panKnob = document.createElement('input')
    panKnob.type = 'range'
    panKnob.className = 'mixer-pan filled'
    panKnob.min = -1; panKnob.max = 1; panKnob.step = 0.01
    panKnob.value = channel.pan
    const panPct = (channel.pan + 1) / 2 * 100
    panKnob.style.setProperty('--fill', panPct + '%')
    panKnob.addEventListener('input', () => {
      const v = parseFloat(panKnob.value)
      panKnob.style.setProperty('--fill', (v + 1) / 2 * 100 + '%')
      this._onParam(this._channelId, 'pan', v)
    })

    const muteBtn = document.createElement('button')
    muteBtn.className = 'mute-btn' + (channel.mute ? ' active' : '')
    muteBtn.textContent = 'M'
    muteBtn.addEventListener('click', () => {
      this._onParam(this._channelId, 'mute', !channel.mute)
    })

    const soloBtn = document.createElement('button')
    soloBtn.className = 'solo-btn' + (channel.solo ? ' active' : '')
    soloBtn.textContent = 'S'
    soloBtn.addEventListener('click', () => {
      this._onParam(this._channelId, 'solo', !channel.solo)
    })

    // Effect slots row — up to 4 slots
    const effectSlots = document.createElement('div')
    effectSlots.className = 'mixer-effect-slots'
    const effects = track?.effects ?? []
    const MAX_SLOTS = 4
    for (let i = 0; i < MAX_SLOTS; i++) {
      const btn = document.createElement('button')
      btn.className = 'effect-slot-btn'
      if (i < effects.length) {
        const effect = effects[i]
        btn.textContent = effect.type
        btn.classList.add('occupied')
        btn.addEventListener('click', () => {
          if (this._onRemoveEffect) this._onRemoveEffect(this._channelId, effect.id)
        })
      } else {
        btn.textContent = '+'
        btn.addEventListener('click', () => {
          if (this._onAddEffect) this._onAddEffect(this._channelId)
        })
      }
      effectSlots.appendChild(btn)
    }

    // Sends section — one send knob per bus
    const sendsSection = document.createElement('div')
    sendsSection.className = 'mixer-sends'
    const sends = channel.sends ?? {}
    this._buses.forEach(bus => {
      const wrapper = document.createElement('div')
      wrapper.className = 'mixer-send'

      const sendLabel = document.createElement('label')
      sendLabel.className = 'mixer-send-label'
      sendLabel.textContent = bus.name

      const sendKnob = document.createElement('input')
      sendKnob.type = 'range'
      sendKnob.className = 'mixer-send-knob filled'
      sendKnob.min = 0; sendKnob.max = 1; sendKnob.step = 0.01
      sendKnob.value = sends[bus.id] ?? 0
      sendKnob.style.setProperty('--fill', (sendKnob.value * 100) + '%')
      sendKnob.addEventListener('input', () => {
        const v = parseFloat(sendKnob.value)
        sendKnob.style.setProperty('--fill', v * 100 + '%')
        if (this._onSendLevel) this._onSendLevel(this._channelId, bus.id, v)
      })

      wrapper.append(sendLabel, sendKnob)
      sendsSection.appendChild(wrapper)
    })

    this._el.append(label, volFader, panKnob, muteBtn, soloBtn, effectSlots, sendsSection)

    // Store refs for update()
    this._volFader = volFader
    this._panKnob = panKnob
    this._muteBtn = muteBtn
    this._soloBtn = soloBtn
    this._effectSlots = effectSlots
    this._sendsSection = sendsSection
  }

  update(channel, track) {
    this._volFader.value = channel.volume
    this._volFader.style.setProperty('--fill', channel.volume * 100 + '%')
    this._panKnob.value = channel.pan
    this._panKnob.style.setProperty('--fill', (channel.pan + 1) / 2 * 100 + '%')
    this._muteBtn.className = 'mute-btn' + (channel.mute ? ' active' : '')
    this._soloBtn.className = 'solo-btn' + (channel.solo ? ' active' : '')

    // Refresh effect slots
    const effects = track?.effects ?? []
    const btns = this._effectSlots.querySelectorAll('.effect-slot-btn')
    btns.forEach((btn, i) => {
      // Remove all listeners by replacing node
      const newBtn = btn.cloneNode(false)
      newBtn.className = 'effect-slot-btn'
      if (i < effects.length) {
        const effect = effects[i]
        newBtn.textContent = effect.type
        newBtn.classList.add('occupied')
        newBtn.addEventListener('click', () => {
          if (this._onRemoveEffect) this._onRemoveEffect(this._channelId, effect.id)
        })
      } else {
        newBtn.textContent = '+'
        newBtn.addEventListener('click', () => {
          if (this._onAddEffect) this._onAddEffect(this._channelId)
        })
      }
      btn.parentNode.replaceChild(newBtn, btn)
    })
  }

  destroy() {
    this._el.remove()
  }
}
