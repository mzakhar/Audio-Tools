import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, resolve, dirname, relative } from 'path'
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

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

ipcMain.handle('fs:exportWav', async (_event, buffer, defaultName) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    defaultPath: defaultName || 'recording.wav',
    filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
  })
  if (canceled || !filePath) return null
  await writeFile(filePath, Buffer.from(buffer))
  return filePath
})

ipcMain.handle('dialog:showOpen', async (_event, options) => {
  return dialog.showOpenDialog(options)
})

ipcMain.handle('dialog:showSave', async (_event, options) => {
  return dialog.showSaveDialog(options)
})
