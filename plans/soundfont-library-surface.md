# SoundFont library surface pointer brief

Read-only investigation. Every claim is file:line verified on main at commit c0fe592. No fixes or designs proposed here.

## 1. IPC surface

### src/preload/index.js -- contextBridge.exposeInMainWorld('electronFS', {...}) lines 3-17, single object literal, every method a thin (...) => ipcRenderer.invoke('channel', ...) wrapper. No ipcRenderer.on listeners in preload.

| Channel arg shape | IPC channel | Line |
|---|---|---|
| readProject(dirPath) | fs:readProject | 4 |
| writeProject(dirPath, json) | fs:writeProject | 5 |
| importAudio(srcPath, projectDir) | fs:importAudio | 6 |
| exportWav(buffer, defaultName) | fs:exportWav | 7 |
| saveRecording(projectDir, buffer, filename) | fs:saveRecording | 8 |
| importRackPatch() | fs:importRackPatch | 9 |
| exportRackPatch(json, defaultName) | fs:exportRackPatch | 10 |
| showOpenDialog(options) | dialog:showOpen | 11 |
| showSaveDialog(options) | dialog:showSave | 12 |
| readAudioBytes(dirPath, relPath) | fs:readAudioBytes | 13 |
| listInstrumentPacks() | instrumentPacks:list | 14 |
| importSf2Pack() | instrumentPacks:importSf2 | 15 |
| readInstrumentSample(packId, version, sampleId) | instrumentPacks:readSample | 16 |

### src/main/index.js -- ipcMain.handle registrations

| Channel | Line | Notes |
|---|---|---|
| fs:readProject | 88 | |
| fs:writeProject | 94 | |
| fs:importAudio | 101 | |
| fs:exportWav | 112 | uses dialog.showSaveDialog |
| fs:saveRecording | 122 | |
| fs:importRackPatch | 131 | uses dialog.showOpenDialog |
| fs:exportRackPatch | 136 | |
| dialog:showOpen | 143 | passthrough to dialog.showOpenDialog(options) |
| dialog:showSave | 147 | passthrough |
| fs:readAudioBytes | 151 | |
| instrumentPacks:list | 158 | listInstrumentPacks(app.getPath('userData')) |
| instrumentPacks:importSf2 | 160-167 | dialog.showOpenDialog then importSf2Pack(app.getPath('userData'), filePaths[0]) |
| instrumentPacks:readSample | 169-171 | readInstrumentSample(app.getPath('userData'), packId, version, sampleId) |

userData obtained via app.getPath('userData') inline at each call site (158, 166, 170), not cached.

The dialog.showOpenDialog call for SF2 import (160-166) uses filters: [{ name: 'SoundFont', extensions: ['sf2','sf3'] }] and properties: ['openFile'] -- single-file picker only, no openDirectory/multiSelections. Returns null if canceled or no file picked, else importSf2Pack(userData, filePaths[0]).

Path-traversal guard: assertPathWithin(filePath, allowedDir), src/main/index.js:76-84 (resolve + relative + '..' check). Used by every fs:* handler except the instrument-pack ones, which delegate to their own within() guard at src/main/instrument-packs.js:10-14.

src/main/instrument-packs.js (pure Node module, imported by main index.js line 5):

| Export | Line | Signature |
|---|---|---|
| instrumentPackRoot(userData) | 25-27 | join(resolve(userData), 'instrument-packs') |
| listInstrumentPacks(userData) | 64-76 | returns [{ id, version, manifest }], sorted, silently drops invalid/corrupt dirs |
| readInstrumentSample(userData, id, version, sampleId) | 78-84 | returns ArrayBuffer |
| importSf2Pack(userData, sourcePath) | 87-122 | stage, validate, atomic rename install, returns { id, version, manifest } |

Ceilings: MAX_SF2_BYTES 256 MiB (line 6), MAX_PACK_BYTES 512 MiB (7), MAX_SAMPLES 4096 (8).

## 2. Renderer pack plumbing -- src/renderer/js/app.js

| Name | Line | Signature / role |
|---|---|---|
| _packCatalog | 54 | let _packCatalog = [] -- module-level compiled catalog |
| packFor(packId, version) | 62-64 | linear find in _packCatalog |
| webPackStore() | 68-73 | lazy singleton, createPackStore() (idb) in try/catch -> null in private mode |
| canImportPacks() | 75-77 | true if electronFS.importSf2Pack exists OR webPackStore() succeeds |
| sampleLoaderFor(pack) | 80-87 | branches on pack.origin === 'idb' (81) vs Electron window.electronFS.readInstrumentSample (85-86) |
| sampleStoreFor(pack, ctx) | 89-97 | one createSampleStore per ctx, WeakMap _sampleStores (line 60), key = origin:id@version |
| warmPack(pack, patch) | 103-111 | preloads samples covering notes [48,60,72] at velocity 100 |
| importPack(onProgress) | 210-216 | electronFS.importSf2Pack else importPackFromFile({store: webPackStore(), onProgress}); calls refreshPackCatalog() on success |
| listPacksFrom(source, origin) | 218-221 | tags entries with origin, swallows source errors to [] |
| refreshPackCatalog() | 223-239 | builds sources[] from electronFS.listInstrumentPacks (origin fs) plus webPackStore() (origin idb), compiles via compilePackManifest, sets _packCatalog, re-renders instrument slot, _arrangementView, _instrumentBrowser, _libraryDialog |
| packState(instrument) | 141-145 | 'missing' if patch absent from pack.byId; else 'ready'/'unavailable' checks only window.electronFS?.readInstrumentSample (idb path never checked here -- flag for implementers, not fixed here) |

Catalog entry shape (line 231-234, compilePackManifest result spread with extras): id, version, manifest, byAddress, byId, origin (fs or idb), bytes. byAddress/byId come from compilePackManifest (src/renderer/js/instruments/pack-registry.js:77-93, Maps keyed by patch address / patch id). bytes defaults to 0 for fs origin (main-process listInstrumentPacks never returns bytes) and is real for idb (from pack-store-idb.js records).

Origin decision: origin fs set at app.js:225, gated on window.electronFS?.listInstrumentPacks existing (Electron build). origin idb set at app.js:227, gated on webPackStore() succeeding (any build with working IndexedDB, including the LAN http browser build). Both sources can be present at once in an Electron renderer that also has IndexedDB -- per-source flags, not per-build.

Construction/wiring: _libraryDialog = new LibraryDialog({...}) app.js:1560-1572; _instrumentBrowser = new InstrumentBrowser({...}) app.js:1548-1559. Both refreshed at tail of refreshPackCatalog() (237-238). document.addEventListener('open-library', () => _libraryDialog.open()) at app.js:1574.

## 3. src/renderer/js/components/library-dialog.js

137-line file. Class LibraryDialog, lines 27-136.

| Method | Lines | Notes |
|---|---|---|
| constructor(deps) | 29-38 | deps documented line 28: packCatalog(), importPack(onProgress), canImport(), removePack(pack) optional, usage() optional. this.el = document.getElementById(LIBRARY_DIALOG_ID); early-returns (no listEl/importBtn wiring) if element absent -- a new tab must follow the same guard. this.listEl = querySelector('#lib-list') (35), this.importBtn = querySelector('#lib-import-btn') (36), click -> runImport() (37) |
| runImport() | 40-53 | disables button, calls deps.importPack(step => setStatus(PROGRESS[step.stage] or '')), catches error into this.status |
| setStatus(value) | 55-58 | sets this.status, calls render() |
| refreshUsage() | 60-66 | Promise.resolve(deps.usage()), sets this.usage, render() |
| open() | 68-75 | guards this.el.open, calls shared openDialog(LIBRARY_DIALOG_ID) from ../ui/dialog.js, resets status, refreshUsage() plus render(), focuses import button |
| render() | 77-94 | clears listEl.innerHTML; status note; "no IndexedDB" note if not canImport; "no packs" note if empty; else one row(pack) per pack; usage footer note if usage.bytes |
| row(pack) | 96-128 | one .lib-row div: .lib-name, .lib-counts, .lib-licence spans; .lib-remove button appended only when pack.origin is idb and deps.removePack exists (114) |
| note(value) | 130-135 | p.instrument-empty helper, reused for all status/empty messages |

PROGRESS stage-label map (20-25): reading, parsing, storing, done. manifestOf(pack) (line 10): pack.manifest or pack -- tolerates raw manifest or catalog-entry wrapper.

DOM markup: src/renderer/index.html:178-189, one dialog#library-dialog.app-dialog, containing .dlg-header (title span#lib-title, close button), .dlg-body with button#lib-import-btn.midi-btn and div#lib-list.lib-list. No separate tab-strip markup exists yet -- a browse tab needs new DOM inside .dlg-body plus a new querySelector wired in the constructor. instrument-settings-dialog has an is-tabs/is-body pattern (index.html:174-175), the closest existing precedent for tabs in one dialog, not detailed further here.

openDialog/closeDialog shared helpers live in src/renderer/js/ui/dialog.js (imported library-dialog.js line 6), used by both LibraryDialog and InstrumentBrowser for show/hide -- a new tab reuses this, not new open/close logic.

## 4. src/renderer/js/components/instrument-browser.js (import-from-folder relevant surface only)

Class InstrumentBrowser, deps documented lines 37-48: store (ProjectStore), packCatalog(), palettes(), racks(), auditioner, ensureTrack(), addTrack(), packState(instrument), openSettings(trackId). Constructor 49-81; builds scope chips from SCOPES (27-34) into #ib-scopes, grabs #ib-search (60) and #ib-list (62) inside #instrument-browser-dialog (BROWSER_DIALOG_ID, line 9).

Listing: index() (100-106) calls buildIndex with packs from packCatalog(), palettes from palettes(), racks from racks(), from src/renderer/js/instruments/patch-index.js (not read -- ranking/flattening live there per its own header comment, line 3). refresh() (108-121) runs searchIndex(...) against search text plus scope, sets this.rows, calls render().

Arming a track: assign(row, newTrack) (214-226) -- newTrack true uses deps.addTrack(), else deps.ensureTrack(), then deps.store.dispatch(SetTrackInstrument(track.id, row.instrument)) (220, action from ../store/ProjectStore.js line 7), updates RECENT localStorage list, closes dialog. Triggered by Enter (onKeyDown, 237) or row double-click (ondblclick, 188).

Wiring: new InstrumentBrowser({...}) app.js:1548-1559; open-instrument-browser document event -> .open() at app.js:1573.

## 5. Sample loading path (pack sample to createSampleStore.load)

Both origins converge on sampleStoreFor(pack, ctx) / sampleLoaderFor(pack), app.js:80-97 (section 2 table). The load callback passed into createSampleStore({ ctx, load }) (src/renderer/js/instruments/sample-store.js:11) is one of:

Electron (origin not idb), app.js:86: load = sampleId => window.electronFS.readInstrumentSample(pack.id, pack.version, sampleId) -> preload readInstrumentSample (src/preload/index.js:16) -> ipcMain.handle('instrumentPacks:readSample', ...) (src/main/index.js:169-171) -> readInstrumentSample(userData, packId, version, sampleId) (src/main/instrument-packs.js:78-84), which validates the installed pack, resolves assetPath (wav/ogg fallback, lines 35-44), readFile, returns sliced ArrayBuffer.

IDB (origin is idb), app.js:83: load = sampleId => store.readSample(pack.id, pack.version, sampleId) where store = webPackStore() -> createPackStore().readSample (src/renderer/js/instruments/pack-store-idb.js:93-98), an IndexedDB transaction on the SAMPLES store, get(sampleKey(...)), toBuffer() normalizes to ArrayBuffer.

Both results feed createSampleStore.get(sampleId) (sample-store.js:28-46): resolves load(sampleId) then ctx.decodeAudioData(bytes), LRU-cached, bounded by maxBytes (default 128 MiB, line 1).

## 6. Test conventions

tests/instrument-packs.test.js (36 lines, imports src/main/instrument-packs.js directly): no mocking library, uses the real filesystem via fs/promises (mkdtemp/mkdir/rm/writeFile, line 1) against os.tmpdir() (line 2). Helper root() (line 8) makes one temp dir per test, tracked in module-level roots array, cleaned in afterEach (line 9) via rm with recursive and force true. Helper install(userData, opts) (11-20) hand-writes a valid pack dir (manifest.json, NOTICE.txt, audio wav files). userData is just the temp dir path -- no app.getPath stubbing needed since tested functions take userData as an explicit argument.

tests/pack-store-idb.test.js (imports src/renderer/js/instruments/pack-store-idb.js): hand-rolled fake IndexedDB, no library. fakeIdb(opts) (6-37): plain Maps per object store (stores, line 7), settle(target, run) (8-14) resolves via queueMicrotask mimicking async IDBRequest onsuccess/onerror, objectStore(name) (15-26) implements put/delete/get/getAll, db.transaction(names, mode) (30-34) fires tx.oncomplete on a microtask for readwrite. failPut option (19) throws a QuotaExceededError-named error to exercise storageError() (pack-store-idb.js:29-34). Passed into the real createPackStore via its idb constructor param (pack-store-idb.js:51, called line 53) -- no globalThis.indexedDB monkey-patching.

## 7. CSS

Single stylesheet: src/renderer/style.css.

- Library dialog: lib- prefixed rules, lines 2103-2133 (section header comment at 2103). lib-list (2104), lib-row (2105-2115), lib-name/lib-counts/lib-licence (2116-2118, 2132-2133), lib-remove (2119-2130).
- Shared dialog chrome (every app-dialog, including library-dialog and instrument-browser-dialog): app-dialog (1996-2007), dlg-header (2008-2016), dlg-title (2017), dlg-close-btn (2018-2027), dlg-body (2028).
- instrument-browser rules for precedent: ib- prefixed block, lines 2036-2086 (ib-search, ib-scopes, ib-chip, ib-list, ib-row, ib-fav, ib-state).

Naming convention: one short component-prefix class namespace per dialog (lib- for library, ib- for instrument browser, is- for instrument settings, see is-tab at 2101), flat classes, no BEM double-dash, scoped by prefix not nesting. A new browse tab inside the library dialog should extend the lib- prefix rather than introduce a new one.
