import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } from 'electron'
import { join, resolve, dirname, relative } from 'path'
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { importSf2Pack, importSf2Preset, listInstrumentPacks, readInstrumentSample } from './instrument-packs.js'
import { addSoundFontFolder, listSoundFontFolders, removeSoundFontFolder, scanSoundFontFolders } from './soundfont-folders.js'
import { loadConnections, saveConnections } from './music-discovery/connections.js'
import { createDiscoveryService } from './music-discovery/index.js'
import { linkLead, listLeads, saveLead } from './music-discovery/leads.js'
import { safeOpenUrl } from '../shared/music-discovery/contracts.js'
import { loadFreesound, saveFreesound } from './music-discovery/freesound-connection.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = !!process.env.ELECTRON_RENDERER_URL
let discoveryService = null

async function discovery() {
  if (!discoveryService) discoveryService = createDiscoveryService({
    connections: await loadConnections(app.getPath('userData'), safeStorage),
    freesound: await loadFreesound(app.getPath('userData'), safeStorage),
  })
  return discoveryService
}

async function configureDiscovery({ freesoundToken, openaiKey, model }) {
  if (typeof freesoundToken !== 'string') throw new Error('Freesound API key is required')
  const userData = app.getPath('userData')
  await saveFreesound(userData, freesoundToken, safeStorage)
  if (typeof openaiKey === 'string' && openaiKey.trim()) await saveConnections(userData, [{
      id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com',
      model: typeof model === 'string' && model.trim() ? model.trim() : 'gpt-5.6-luna', auth: openaiKey,
      capabilities: { structuredOutput: true }
    }], safeStorage)
  discoveryService = null
}

// Auto-updater — only active in packaged builds (not dev)
function getAutoUpdater() {
  if (isDev) return null
  try {
    // electron-updater is an optional runtime dependency
    // eslint-disable-next-line
    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    return autoUpdater
  } catch (e) {
    return null
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: join(__dirname, '../preload/index.js'),
    },
  })

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)

  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => {
    const updater = getAutoUpdater()
    if (updater) {
      updater.checkForUpdatesAndNotify().catch(() => {
        // Silent failure — update server may not be reachable
      })
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })

  app.whenReady().then(() => {
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── Path validation helper ───────────────────────────────────────────────────
function assertPathWithin(filePath, allowedDir) {
  const resolved = resolve(filePath)
  const base = resolve(allowedDir)
  const rel = relative(base, resolved)
  if (rel.startsWith('..') || resolve(base, rel) !== resolved) {
    throw new Error(`Path traversal detected: ${filePath}`)
  }
  return resolved
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('fs:readProject', async (_event, dirPath) => {
  const projectFile = assertPathWithin(join(dirPath, 'project.json'), dirPath)
  const data = await readFile(projectFile, 'utf-8')
  return JSON.parse(data)
})

ipcMain.handle('fs:writeProject', async (_event, dirPath, json) => {
  const resolvedDir = resolve(dirPath)
  await mkdir(resolvedDir, { recursive: true })
  const projectFile = assertPathWithin(join(resolvedDir, 'project.json'), resolvedDir)
  await writeFile(projectFile, JSON.stringify(json, null, 2), 'utf-8')
})

ipcMain.handle('fs:importAudio', async (_event, srcPath, projectDir) => {
  const resolvedSrc = resolve(srcPath)
  const resolvedDir = resolve(projectDir)
  const audioDir = join(resolvedDir, 'audio')
  await mkdir(audioDir, { recursive: true })
  const filename = resolvedSrc.split(/[\\/]/).pop()
  const destPath = assertPathWithin(join(audioDir, filename), audioDir)
  await copyFile(resolvedSrc, destPath)
  return join('audio', filename)
})

ipcMain.handle('fs:exportWav', async (event, buffer, defaultName) => {
  const { filePath, canceled } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: defaultName || 'recording.wav',
    filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
  })
  if (canceled || !filePath) return null
  await writeFile(filePath, Buffer.from(buffer))
  return filePath
})

ipcMain.handle('fs:saveRecording', async (_event, projectDir, buffer, filename) => {
  if (typeof projectDir !== 'string' || !/^[\w.-]+\.wav$/i.test(filename)) throw new Error('Invalid recording destination')
  const recordingsDir = assertPathWithin(join(resolve(projectDir), 'recordings'), projectDir)
  const filePath = assertPathWithin(join(recordingsDir, filename), recordingsDir)
  await mkdir(recordingsDir, { recursive: true })
  await writeFile(filePath, Buffer.from(buffer))
  return filePath
})

ipcMain.handle('fs:importRackPatch', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({ filters: [{ name: 'Synth Rack Patch', extensions: ['synthrack'] }], properties: ['openFile'] })
  return canceled || !filePaths[0] ? null : readFile(filePaths[0], 'utf-8')
})

ipcMain.handle('fs:exportRackPatch', async (_event, json, defaultName) => {
  const { filePath, canceled } = await dialog.showSaveDialog({ defaultPath: defaultName, filters: [{ name: 'Synth Rack Patch', extensions: ['synthrack'] }] })
  if (canceled || !filePath) return null
  await writeFile(filePath, json, 'utf-8')
  return filePath
})

ipcMain.handle('dialog:showOpen', async (_event, options) => {
  return dialog.showOpenDialog(options)
})

ipcMain.handle('dialog:showSave', async (_event, options) => {
  return dialog.showSaveDialog(options)
})

ipcMain.handle('fs:readAudioBytes', async (_event, dirPath, relPath) => {
  const resolvedDir = resolve(dirPath)
  const fullPath = assertPathWithin(resolve(resolvedDir, relPath), resolvedDir)
  const buf = await readFile(fullPath)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
})

ipcMain.handle('instrumentPacks:list', () => listInstrumentPacks(app.getPath('userData')))

ipcMain.handle('instrumentPacks:importSf2', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    filters: [{ name: 'SoundFont', extensions: ['sf2', 'sf3'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null
  return importSf2Pack(app.getPath('userData'), filePaths[0])
})

ipcMain.handle('instrumentPacks:readSample', (_event, packId, version, sampleId) => {
  return readInstrumentSample(app.getPath('userData'), packId, version, sampleId)
})

// Registered bank folders are read-only inputs picked by the user, so they sit
// outside the pack root by design; everything written still goes under userData.
ipcMain.handle('instrumentPacks:addFolder', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (canceled || !filePaths[0]) return null
  return addSoundFontFolder(app.getPath('userData'), filePaths[0])
})

ipcMain.handle('instrumentPacks:listFolders', () => listSoundFontFolders(app.getPath('userData')))

ipcMain.handle('instrumentPacks:removeFolder', (_event, folderPath) => {
  return removeSoundFontFolder(app.getPath('userData'), folderPath)
})

ipcMain.handle('instrumentPacks:scanFolders', () => scanSoundFontFolders(app.getPath('userData')))

ipcMain.handle('instrumentPacks:importPreset', (_event, sourcePath, presetIndex) => {
  return importSf2Preset(app.getPath('userData'), sourcePath, presetIndex)
})

ipcMain.handle('musicDiscovery:available', async () => (await discovery()).available())

ipcMain.handle('musicDiscovery:configure', async (_event, config) => {
  await configureDiscovery(config || {})
  return (await discovery()).available()
})

ipcMain.handle('musicDiscovery:run', async (event, request) => {
  const service = await discovery()
  return service.start(request || {}, payload => event.sender.send('musicDiscovery:event', payload))
})

ipcMain.handle('musicDiscovery:cancel', async (_event, runId) => (await discovery()).cancel(runId))

ipcMain.handle('musicDiscovery:open', async (_event, candidate) => {
  const url = safeOpenUrl(candidate)
  if (!url) throw new Error('Unsafe discovery link')
  await shell.openExternal(url)
})

ipcMain.handle('musicDiscovery:listLeads', () => listLeads(app.getPath('userData')))
ipcMain.handle('musicDiscovery:saveLead', (_event, lead) => saveLead(app.getPath('userData'), lead || {}))
ipcMain.handle('musicDiscovery:linkLead', (_event, leadId, importedPreset) => linkLead(app.getPath('userData'), leadId, importedPreset))
