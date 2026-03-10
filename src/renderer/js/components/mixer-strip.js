/**
 * mixer-strip.js
 * Per-track mixer channel strip: label, volume fader, pan, mute/solo.
 */
export class MixerStrip {
  constructor(container, { channel, track, onParam }) {
    this._channelId = channel.id
    this._onParam = onParam
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

    this._el.append(label, volFader, panKnob, muteBtn, soloBtn)

    // Store refs for update()
    this._volFader = volFader
    this._panKnob = panKnob
    this._muteBtn = muteBtn
    this._soloBtn = soloBtn
  }

  update(channel, track) {
    this._volFader.value = channel.volume
    this._volFader.style.setProperty('--fill', channel.volume * 100 + '%')
    this._panKnob.value = channel.pan
    this._panKnob.style.setProperty('--fill', (channel.pan + 1) / 2 * 100 + '%')
    this._muteBtn.className = 'mute-btn' + (channel.mute ? ' active' : '')
    this._soloBtn.className = 'solo-btn' + (channel.solo ? ' active' : '')
  }

  destroy() {
    this._el.remove()
  }
}
