// One audio file picker, two callers: the arrangement importer and the rack's
// sample modules. Returns an Electron path, a FileSystemFileHandle, or null
// when the user cancels — the caller decides what to do with the file.

const AUDIO_EXT = ['wav', 'mp3', 'flac', 'ogg', 'aiff']

export async function pickAudioFile({ getLastDir, setLastDir } = {}) {
  if (window.electronFS) {
    const opts = { properties: ['openFile'], filters: [{ name: 'Audio', extensions: AUDIO_EXT }] }
    const last = getLastDir?.()
    if (last) opts.defaultPath = last
    const result = await window.electronFS.showOpenDialog(opts)
    if (result.canceled || !result.filePaths.length) return null
    const path = result.filePaths[0]
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    if (cut > 0) setLastDir?.(path.substring(0, cut))
    return path
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Audio Files', accept: { 'audio/*': AUDIO_EXT.map(ext => `.${ext}`) } }]
    })
    return handle ?? null
  } catch {
    // The browser picker rejects with AbortError on cancel. Nothing else in here
    // can throw, so a rejection means "no file", not a failure worth surfacing.
    return null
  }
}

export default pickAudioFile
