// Screenshot every view × theme × viewport of a served renderer build.
// Usage: npm run build; serve out/renderer on a port; then
//   SNAP_URL=<url> SNAP_OUT=<dir> electron scripts/ui-snap.cjs  (a URL argv makes Electron exit)
// Unset ELECTRON_IS_PACKAGED / ELECTRON_RUN_AS_NODE if your shell inherits them.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const url = process.env.SNAP_URL || 'http://127.0.0.1:5199/'
const outDir = process.env.SNAP_OUT || 'specs/ui-baseline/latest'
const THEMES = ['light', 'dark', 'rainbow']
const VIEWPORTS = [['desktop', 1440, 900, 1], ['narrow', 390, 844, 1], ['zoom200', 1440, 900, 2]]
// [name, script run after load]; each script returns nothing, the page settles after.
const SHOTS = [
  ['synth', `document.querySelector('[data-tool="synth"]').click()`],
  ['arrange', `document.querySelector('[data-tool="arrange"]').click()`],
  ['arrange-mixer', `document.querySelector('[data-tool="arrange"]').click(); document.getElementById('mixer-toggle-btn').click()`],
  ['rack', `document.querySelector('[data-tool="rack"]').click()`],
  ['tr909', `document.querySelector('[data-tool="tr909"]').click()`],
  ['pads', `document.querySelector('[data-tool="pads"]').click()`],
  ['lesson', `document.querySelector('[data-tool="pads"]').click(); document.querySelector('.pads-lessons').click(); document.querySelector('[data-lesson="l3"]').click()`],
  ['browser-dialog', `document.querySelector('[data-tool="synth"]').click(); document.getElementById('instrument-browser-dialog').showModal()`],
  ['library-dialog', `document.getElementById('library-dialog').showModal()`],
  ['fm1-library', `document.querySelector('[data-cmd="fm1-library"]').click(); new Promise(r => setTimeout(r, 1200))`],
]
// Own profile per run: parallel runs must not share localStorage (the theme lives there).
app.setPath('userData', path.join(require('os').tmpdir(), 'ui-snap-' + process.pid))
const log = msg => fs.appendFileSync(path.join(require('os').tmpdir(), 'ui-snap.log'), msg + '\n')
process.on('uncaughtException', e => { log(e.stack); app.exit(1) })
process.on('unhandledRejection', e => { log(e && e.stack); app.exit(1) })
log('start ' + JSON.stringify(process.argv))
const wait = ms => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true })
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  for (const theme of THEMES) {
    for (const [vp, w, h, zoom] of VIEWPORTS) {
      win.setContentSize(w, h)
      for (const [name, script] of SHOTS) {
        if (process.env.SNAP_ONLY && !process.env.SNAP_ONLY.split(',').includes(name)) continue // SNAP_ONLY=a,b limits shots
        const file = path.join(outDir, `${name}--${theme}--${vp}.png`)
        if (fs.existsSync(file)) continue // rerun resumes after an Electron crash
        await win.loadURL(url)
        await win.webContents.executeJavaScript(`localStorage.setItem('synth_theme', ${JSON.stringify(theme)})`)
        await win.loadURL(url)
        win.webContents.setZoomFactor(zoom)
        await wait(400)
        try { await win.webContents.executeJavaScript(script) } catch (e) { console.warn(name, e.message) }
        await wait(500)
        const img = await win.webContents.capturePage()
        fs.writeFileSync(file, img.toPNG())
      }
    }
  }
  console.log('done', outDir)
  app.quit()
})
