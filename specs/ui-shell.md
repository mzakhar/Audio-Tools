# UI Shell — one command bar, dialogs for the rest

The app inherited the DAW habit of a bar for everything. Today, above any actual
content, sit `#global-header` (index.html:28), `#project-bar` (index.html:40)
with the recorder, theme picker and MIDI row inside it, and — in arrange —
`#arrange-toolbar` (index.html:69) holding one button. Down the right side is
`#instrument-inspector` (index.html:74), along the bottom `#mixer-bar`
(index.html:98). Roughly 120 px of vertical chrome and 268 px of horizontal are
permanently spent on controls touched once a session.

**Rule: a control stays on screen only if it changes while you play.**
Everything else lives in a dialog on a shortcut.

---

## Status

| Phase | State | Commit |
|---|---|---|
| 0 — Guard fixes + `data-view` switching | not started | |
| 1 — Command bar | not started | |
| 2 — Dialog kit + piano-roll migration | not started | |
| 3 — Project, MIDI and Library dialogs | not started | |
| 4 — Mixer drawer | not started | |

Companion specs: `specs/instrument-browser.md` (the instrument picker and the
synth view, which depend on phases 1–2 here) and `specs/midi-control-surface.md`
(deferred, builds nothing).

---

## Ground rules

- **Native platform first.** `<dialog>` + `showModal()` for modals — focus trap,
  `Esc`, `::backdrop` and inert background come free. The `popover` attribute for
  menus. No modal library, no focus-trap dependency. This is Electron Chromium
  and a modern-browser deploy; both support it.
- **Pure core.** Which command-bar items are enabled, and which dialog a shortcut
  opens, are pure functions with tests. DOM wiring stays an imperative shell in
  `app.js`.
- **No new dependency.**
- Each phase ends committable, `npm test` green, and never leaves a control
  unreachable — every dialog is on both a shortcut and the `⋯` menu.

---

## Target shell

```
┌─────────────────────────────────────────────────────────────────────┐
│ ▤ ◈ ⊞ │ Untitled *  ▶ ■ ●REC   BPM 120   MASTER 80   ● K25    ⋯   │  command bar
├───────┴─────────────────────────────────────────────────────────────┤
│                                                                     │
│                        view body (synth / arrange / rack)           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

The 72 px sidebar survives as the only always-on navigation, slimmed to 48 px and
folded into the command bar row on narrow widths. Everything else above is one
bar.

### What stays visible

| Item | Why |
|---|---|
| View switcher | Navigation |
| Play / Stop | Changes while you play |
| Record (audio or MIDI, mode-aware) + elapsed timer while recording | Live |
| BPM, master volume | Live |
| Project name + dirty marker | One glance, no interaction |
| Status tokens: `● K25` when a MIDI input is live, a pack-loading spinner, the recorder's timer | One live signal per hidden dialog |

### What moves into a dialog

| Control | Today | New home | Shortcut |
|---|---|---|---|
| New / Open / Save | `#project-bar` index.html:41-43 | `⋯` menu | `Ctrl+N/O/S` (already exist, app.js:1189-1197) |
| Import audio, + MIDI track, + PACK, Bounce | index.html:45-48 | `⋯` menu | `Ctrl+B` for bounce |
| Theme select | index.html:56 | `⋯` menu submenu | — |
| Enable MIDI, device select, MIDI channel defaults | index.html:61-66 | **MIDI setup** dialog | `Ctrl+M` |
| Pack import, installed packs, licences, disk use | `+ PACK` button | **Library** dialog | `Ctrl+L` |
| Per-track bank / program / follow-PC / channel / bend range | `#instrument-inspector` | **Instrument settings** dialog | `specs/instrument-browser.md` |
| Pick an instrument | `#instrument-inspector` | **Instrument browser** overlay | `Ctrl+I` |
| Mixer | `#mixer-bar`, always on in arrange | Drawer, closed by default | `Ctrl+Shift+M` |
| `+ TRACK` | `#arrange-toolbar` index.html:70 | Command bar in arrange view, or context menu on empty timeline | — |

`#header-view-slot` (index.html:38) is unused — delete it. `#header` /
`#app-title` inside the synth view (index.html:103-105) is a second title bar for
the same app — delete it; the command bar already names the project.

### Cut, not moved

- **The Library as a fourth top-level view.** It was drawn as one; it is a dialog.
  A view is for something you work inside — the library is administration for
  what is currently two SoundFont files.
- **`RAW WAV TEST`** (instrument-inspector.js) — a debug button in shipped UI.
- **The tightened-rail instrument picker.** Superseded by the overlay; see the
  companion spec.

---

## Phase 0 — Guard fixes and `data-view` switching

Two unguarded DOM lookups will throw the moment the bars are restructured, so
they go first, alone, as a no-visual-change commit:

- `setProjectOpen()` (app.js:665-671) does unguarded
  `getElementById('save-project-btn').disabled = …` for four buttons. Optional-chain
  them, or better, drive them from one `applyProjectState(state)` helper.
- `initMidi()` (app.js:895) guards only `enableBtn` (app.js:902), then dereferences
  `statusEl`, `deviceSel`, `recBtn` unguarded (app.js:907-914). Same treatment.

Then replace the `style.display` juggling in `switchMode()` (app.js:578-616) and
`switchPalette()` (app.js:176-214) with a single attribute:

```js
document.getElementById('main').dataset.view = mode      // 'synth' | 'arrange' | 'rack'
```

and CSS `[data-view="arrange"] #app { display: none }` etc. `switchMode` keeps
its real side effects (`_rackView.show/hide`, `startArrangeLoop`, the resize
kick at app.js:600-602) and loses eleven `style.display` writes.

`updateGlobalPlayAvailability()` (app.js:220) keeps deriving from both
`_currentMode` and `currentPaletteKey` — the comment at app.js:216-219 records
exactly why, and that hazard does not change here.

**Test:** none needed for the guards; the `data-view` change is covered by
existing view tests staying green.

---

## Phase 1 — Command bar

New markup replaces `#global-header`, `#project-bar` and `#arrange-toolbar` with
one `#command-bar`. New pure module:

```js
// src/renderer/js/ui/command-model.js
export function commandItems({ mode, projectOpen, recording, midiInput, paletteKey })
// -> [{ id, label, shortcut, group, enabled, visible }]
```

Both the bar and the `⋯` menu render from this one list, so a control can never
be enabled in one place and dead in the other. `bounce`, `import-audio`,
`add-midi-track` and `save` are `enabled: projectOpen`; `play` is
`enabled: !(mode === 'synth' && paletteKey === 'tr909')`.

The `⋯` menu is a native popover:

```html
<button popovertarget="app-menu">⋯</button>
<div id="app-menu" popover>…</div>
```

Light dismiss, `Esc` and top-layer stacking come from the platform.

**Status tokens** replace whole rows: `midi-status` becomes a dot plus device
name, clickable to open the MIDI dialog; the recorder's timer only appears while
recording; `rec-status` messages become a transient toast rather than a permanent
span.

**Test:** `tests/command-model.test.js` — bounce disabled with no project, play
disabled on the 909, MIDI token hidden when no input is selected.

---

## Phase 2 — Dialog kit

One small shell module, not a framework:

```js
// src/renderer/js/ui/dialog.js
export function openDialog(id, { context = 'dialog', onClose } = {})
export function closeDialog(id)
```

Behaviour: `showModal()`, `ShortcutManager.setContext(context)` on open, restore
the previous context and focus on `close`. The native `close` event is the single
close path, so `Esc`, the close button and a programmatic close all restore state
identically — the current drawer restores context in `closePianoRoll()`
(app.js:1150-1155) and nowhere else.

Then migrate `#piano-roll-drawer` (index.html:76-97) from the hand-rolled
`role="dialog"` div to a real `<dialog>`. It keeps its `pianoroll` shortcut
context for the `d`/`s`/`e` tool keys (app.js:1171-1173) and gains the focus trap
and backdrop it never had. `Escape` stops needing its own binding (app.js:1174).

The arrangement context menu (arrangement-view.js:78-116) migrates to `popover`
in the same phase or is left alone — it already light-dismisses correctly. Prefer
leaving it; it is not broken.

**Test:** `tests/dialog.test.js` (jsdom) — open sets context, `close` event
restores the prior context exactly once, even when closed twice.

---

## Phase 3 — Project, MIDI and Library dialogs

| Dialog | Contents | Notes |
|---|---|---|
| **MIDI setup** `Ctrl+M` | Enable MIDI, input device select, per-project default channel behaviour, and a plain-language line about secure context | Nothing from `specs/midi-control-surface.md` — no learn table, no monitor, no clock |
| **Library** `Ctrl+L` | Installed packs, patch counts, disk use, licence/notice per pack, import `.sf2`, remove | Absorbs `+ PACK` (app.js:791-799). Remove is new and needs the installer side; ship list + import first |
| **Instrument settings** | Per-track dense fields | Specified in `specs/instrument-browser.md`; built there |

MIDI must keep working when the dialog has never been opened: `enableMidi()` is
auto-invoked at boot today (app.js:921) and stays that way. The dialog configures;
it does not gate.

---

## Phase 4 — Mixer drawer

`#mixer-bar` (index.html:98) currently occupies 120 px of every arrange session.
It becomes a bottom drawer, closed by default, toggled by `Ctrl+Shift+M` and a
command-bar button that lights when any channel is clipping.

`syncMixerStrips()` (app.js:635-662) is subscription-driven, not visibility-driven,
so strips keep updating while hidden — the drawer can be a pure CSS
`translateY` with no wiring change. Open/closed is session state, not project
state; a project file does not remember your panel layout.

---

## Modernization allowed inside these phases

- `data-*` attributes and CSS over imperative `style.display`.
- Native `<dialog>`, `popover`, `:focus-visible`, `prefers-reduced-motion`.
- `aria-pressed` on every toggle; the command bar is one `role="toolbar"` with
  proper labels.
- Delete dead chrome as it is passed: `#header-view-slot`, `#app-title`,
  `RAW WAV TEST`.

## Not allowed

- No CSS framework, no component library, no state-management library.
- No new persistent bar or rail. If something needs to be visible always, it
  belongs in the command bar or it does not exist.
- No shortcut-only feature: everything reachable from `⋯`.

---

## Verify

```sh
npm test
npm run dev        # Electron
```

Manual acceptance:

1. Open a project. One bar above the content, nothing else. Play, stop, record,
   BPM and volume all still one click away.
2. `Ctrl+M`, `Ctrl+L`, `Ctrl+I`, `Ctrl+Shift+M` each open their surface; `Esc`
   closes it and returns focus where it was.
3. Every menu item in `⋯` works, and its disabled state matches whether a project
   is open.
4. Piano roll opens from a double-clicked MIDI clip, traps focus, closes on `Esc`,
   and `d`/`s`/`e` still switch tools inside it.
5. Arrange view with the mixer closed shows more timeline than it does today.

## Risk notes

- No test in `tests/` references any of these DOM ids — there is no safety net
  from the suite for this restructure. Manual acceptance above is the net.
- Two raw `keydown` listeners bypass `ShortcutManager` entirely (app.js:272-292,
  drum pads and 909). They must be moved into `ShortcutManager` contexts during
  phase 2 or a dialog will receive number keys meant for a pad.
