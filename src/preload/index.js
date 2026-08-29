import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronFS', {
  readProject: (dirPath) => ipcRenderer.invoke('fs:readProject', dirPath),
  writeProject: (dirPath, json) => ipcRenderer.invoke('fs:writeProject', dirPath, json),
  importAudio: (srcPath, projectDir) => ipcRenderer.invoke('fs:importAudio', srcPath, projectDir),
  exportWav: (buffer, defaultName) => ipcRenderer.invoke('fs:exportWav', buffer, defaultName),
  saveRecording: (projectDir, buffer, filename) => ipcRenderer.invoke('fs:saveRecording', projectDir, buffer, filename),
  importRackPatch: () => ipcRenderer.invoke('fs:importRackPatch'),
  exportRackPatch: (json, defaultName) => ipcRenderer.invoke('fs:exportRackPatch', json, defaultName),
  showOpenDialog: (options) => ipcRenderer.invoke('dialog:showOpen', options),
  showSaveDialog: (options) => ipcRenderer.invoke('dialog:showSave', options),
  readAudioBytes: (dirPath, relPath) => ipcRenderer.invoke('fs:readAudioBytes', dirPath, relPath),
  listInstrumentPacks: () => ipcRenderer.invoke('instrumentPacks:list'),
  importSf2Pack: () => ipcRenderer.invoke('instrumentPacks:importSf2'),
  readInstrumentSample: (packId, version, sampleId) => ipcRenderer.invoke('instrumentPacks:readSample', packId, version, sampleId),
  addSoundFontFolder: () => ipcRenderer.invoke('instrumentPacks:addFolder'),
  listSoundFontFolders: () => ipcRenderer.invoke('instrumentPacks:listFolders'),
  removeSoundFontFolder: (folderPath) => ipcRenderer.invoke('instrumentPacks:removeFolder', folderPath),
  scanSoundFontFolders: () => ipcRenderer.invoke('instrumentPacks:scanFolders'),
  importSf2Preset: (sourcePath, presetIndex) => ipcRenderer.invoke('instrumentPacks:importPreset', sourcePath, presetIndex),
})
