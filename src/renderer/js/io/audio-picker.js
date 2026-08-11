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
  // Secure-context only, so it is simply absent on the plain-http LAN deploy and
  // in browsers that never shipped it. Say so instead of letting the TypeError
  // be swallowed below and read as "the user cancelled".
  if (typeof window.showOpenFilePicker !== 'function') {
    throw new Error('File picking needs a secure context (https). Open the app over https to import audio.')
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Audio Files', accept: { 'audio/*': AUDIO_EXT.map(ext => `.${ext}`) } }]
    })
    return handle ?? null
  } catch (err) {
    // Cancelling is the only rejection that means "no file". Anything else is a
    // real failure and has to reach the caller, or the button just does nothing.
    if (err?.name === 'AbortError') return null
    throw err
  }
}

export default pickAudioFile
