// The FILE param and the panel row that loads it, shared by SAMPLR and GRAIN.
// A fileKey is a string, so the generic panel renderer skips it — without this
// row neither module has any way to be pointed at audio.

export const FILE_PARAM = { key: 'fileKey', label: 'FILE', def: '' }

export function filePanel({ params, setParam, getInstance, addPoll }) {
  const row = document.createElement('div')
  row.className = 'rack-file'
  const button = document.createElement('button')
  button.className = 'rack-file-btn'
  const badge = document.createElement('span')
  badge.className = 'rack-file-badge'
  row.append(button, badge)

  const paint = () => {
    const key = params().fileKey || ''
    button.textContent = key ? key.split('/').pop() : 'LOAD…'
    button.title = key || 'Load an audio file'
  }

  button.addEventListener('click', async e => {
    e.stopPropagation()
    // Loaded on demand: the module registry is imported by the test suite and by
    // the offline bounce, and neither should drag in the audio store, its
    // decoder or its waveform worker just to describe a module.
    const [{ default: AudioStore }, { pickAudioFile }] = await Promise.all([
      import('../../audio-store.js'),
      import('../../io/audio-picker.js')
    ])
    if (!AudioStore.getProjectDir()) { badge.textContent = 'no project'; return }
    try {
      // Picking can fail outright — there is no file picker without a secure
      // context — and the badge is the only place that can say so.
      const handle = await pickAudioFile()
      if (!handle) return
      badge.textContent = ''
      setParam('fileKey', await AudioStore.importFile(handle))
      paint()
    } catch (err) {
      badge.textContent = err?.message || 'load failed'
    }
  })

  // The module itself knows whether the buffer has arrived — it is the thing
  // holding getBuffer. Anything else here would be a second source of truth.
  let shown = null
  const removePoll = addPoll(() => {
    if (!row.isConnected) { removePoll(); return }
    const state = getInstance()?.uiState?.()
    const text = !state?.file ? '' : state.ready ? '' : 'loading…'
    if (text === shown) return
    shown = text
    badge.textContent = text
  })

  paint()
  row.refresh = paint
  return row
}
