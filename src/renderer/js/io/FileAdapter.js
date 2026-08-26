// FileAdapter.js — Platform-agnostic file I/O
// Detects whether running in Electron (window.electronFS available) or browser
// (File System Access API).

// ---------------------------------------------------------------------------
// Path traversal validation (exported for testing)
// ---------------------------------------------------------------------------
export function validateProjectPath(projectRoot, relativePath) {
  // A relative path is safe if it doesn't contain '..' segments or empty parts
  const parts = relativePath.replace(/\\/g, '/').split('/')
  for (const part of parts) {
    if (part === '..' || part === '') return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Browser implementation (File System Access API)
// ---------------------------------------------------------------------------
const BrowserAdapter = {
  async openProjectFolder() {
    try { return await window.showDirectoryPicker({ mode: 'readwrite' }) }
    catch (e) { if (e.name === 'AbortError') return null; throw e }
  },

  async createProjectFolder() {
    try { return await window.showDirectoryPicker({ mode: 'readwrite' }) }
    catch (e) { if (e.name === 'AbortError') return null; throw e }
  },

  async readProject(dirHandle) {
    const fileHandle = await dirHandle.getFileHandle('project.json')
    const file = await fileHandle.getFile()
    const text = await file.text()
    const state = JSON.parse(text)
    return { state, dirHandle }
  },

  async writeProject(dirHandle, state) {
    const fileHandle = await dirHandle.getFileHandle('project.json', { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(state, null, 2))
    await writable.close()
  },

  async importAudio(fileHandle, dirHandle) {
    // Ensure audio/ subfolder exists
    const audioDir = await dirHandle.getDirectoryHandle('audio', { create: true })
    const file = await fileHandle.getFile()
    const destHandle = await audioDir.getFileHandle(file.name, { create: true })
    const writable = await destHandle.createWritable()
    await writable.write(await file.arrayBuffer())
    await writable.close()
    return `audio/${file.name}`
  },

  async exportWav(arrayBuffer, defaultName) {
    const handle = await window.showSaveFilePicker({
      suggestedName: defaultName || 'export.wav',
      types: [{ description: 'WAV Audio', accept: { 'audio/wav': ['.wav'] } }]
    })
    const writable = await handle.createWritable()
    await writable.write(arrayBuffer)
    await writable.close()
  },

  async saveRecording(dirHandle, arrayBuffer, filename) {
    if (!dirHandle) return this.exportWav(arrayBuffer, filename)
    const recordings = await dirHandle.getDirectoryHandle('recordings', { create: true })
    const handle = await recordings.getFileHandle(filename, { create: true })
    const writable = await handle.createWritable()
    await writable.write(arrayBuffer)
    await writable.close()
    return `recordings/${filename}`
  },

  async importRackPatch() {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'Synth Rack Patch', accept: { 'application/json': ['.synthrack'] } }]
    })
    return (await handle.getFile()).text()
  },

  async exportRackPatch(json, defaultName = 'patch.synthrack') {
    const handle = await window.showSaveFilePicker({
      suggestedName: defaultName,
      types: [{ description: 'Synth Rack Patch', accept: { 'application/json': ['.synthrack'] } }]
    })
    const writable = await handle.createWritable()
    await writable.write(json)
    await writable.close()
  }
}

// ---------------------------------------------------------------------------
// Electron implementation (uses window.electronFS IPC bridge)
// ---------------------------------------------------------------------------
const ElectronAdapter = {
  async openProjectFolder(defaultPath) {
    const opts = { properties: ['openDirectory'] }
    if (defaultPath) opts.defaultPath = defaultPath
    const result = await window.electronFS.showOpenDialog(opts)
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  },

  async createProjectFolder(defaultPath) {
    const opts = { properties: ['openDirectory', 'createDirectory'] }
    if (defaultPath) opts.defaultPath = defaultPath
    const result = await window.electronFS.showOpenDialog(opts)
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  },

  async readProject(dirPath) {
    const state = await window.electronFS.readProject(dirPath)
    return { state, dirHandle: dirPath }
  },

  async writeProject(dirPath, state) {
    await window.electronFS.writeProject(dirPath, state)
  },

  async importAudio(filePath, dirPath) {
    return await window.electronFS.importAudio(filePath, dirPath)
  },

  async exportWav(arrayBuffer, defaultName) {
    return window.electronFS.exportWav(arrayBuffer, defaultName || 'export.wav')
  },

  async saveRecording(projectDir, arrayBuffer, filename) {
    if (!projectDir) return this.exportWav(arrayBuffer, filename)
    return window.electronFS.saveRecording(projectDir, arrayBuffer, filename)
  },

  async importRackPatch() {
    return await window.electronFS.importRackPatch()
  },

  async exportRackPatch(json, defaultName = 'patch.synthrack') {
    return await window.electronFS.exportRackPatch(json, defaultName)
  }
}

// ---------------------------------------------------------------------------
// Runtime detection and export
// ---------------------------------------------------------------------------
const FileAdapter = typeof window !== 'undefined' && window.electronFS
  ? ElectronAdapter
  : BrowserAdapter

export default FileAdapter
export { BrowserAdapter, ElectronAdapter }
