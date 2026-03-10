import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronFS', {
  readProject: (dirPath) => ipcRenderer.invoke('fs:readProject', dirPath),
  writeProject: (dirPath, json) => ipcRenderer.invoke('fs:writeProject', dirPath, json),
  importAudio: (srcPath, projectDir) => ipcRenderer.invoke('fs:importAudio', srcPath, projectDir),
  exportWav: (buffer, defaultName) => ipcRenderer.invoke('fs:exportWav', buffer, defaultName),
  showOpenDialog: (options) => ipcRenderer.invoke('dialog:showOpen', options),
  showSaveDialog: (options) => ipcRenderer.invoke('dialog:showSave', options),
})
