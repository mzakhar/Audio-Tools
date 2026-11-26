# Playful retro instrument UI — design and implementation plan

Status: phase 0 not started. Applies to the whole renderer. `specs/ui-shell.md`,
`specs/instrument-browser.md` and existing accessibility behaviour stay
authoritative for workflows; this plan changes appearance, not structure.
Companion: `specs/fm1-emulator.md` (consumes this visual system; does not gate it).

## Intent

Make Synth feel like an inviting electronic instrument — playful colour, clear
physical groupings, compact expressive displays, satisfying controls — without
giving up the screen space and precision a DAW needs.

References: [OP-1 overview](https://teenage.engineering/products/op-1/original/overview)
and [layout guide](https://teenage.engineering/guides/op-1/original/layout)
(colour-coded encoders tied to on-screen values),
[M-VAVE FM-1 overview](https://www.youtube.com/watch?v=fwt7fRni09s). Take
principles only — no logos, device artwork, exact graphics or trade dress.

## Baseline (audit 2026-11-26)

Facts the plan is built on. Re-verify pointers before each phase; line numbers drift.

| Area | Today |
|---|---|
| CSS | One file, `src/renderer/style.css`, 2291 lines. Tokens on `:root` (:4), `[data-theme="light"]` (:46), `[data-theme="rainbow"]` (:81). Colour + one font token only; no spacing, radius or type scale. ~40 hex literals outside theme blocks (`#ff4444` ×14, `#f05a28` ×10 in 909, `#00e5ff` ×10). Light omits `--signal-*`. |
| CSS sections | rack 184–504, synth 505–930 + sequencer 1346–1500, 909 931–1345, shell 1502–1680, view switching 1690–1700, arrange + mixer 1681–1943, dialogs 1987–2184, piano roll 2185–2276, assistant 2277+ |
| Themes | dark (default), light, rainbow. `js/theme.js` sets `<html data-theme>`, persists localStorage `synth_theme`; `public/theme-init.js` applies pre-paint; picker in `⋯` menu (app.js:460). `themechange` event fires (theme.js:8) but **nothing listens**. |
| Canvases | Colours hardcoded in JS, so they stay dark under light/rainbow: `components/arrangement-view.js` (19 literals), `components/piano-roll.js` (20), `components/rack-cables.js` (3), `rack/modules/meter.js` (7), `rack/modules/scope.js` (6). Canvas text hardcoded `8–10px monospace`. |
| Type | `--font-mono: 'Courier New'` everywhere, body 13 px. No bundled fonts. |
| Primitives | Two knob systems: `components/knob.js` (rack only) and synth knob panel (`app.js:603`, range sliders + `--fill`). No shared button class (`.cmd-btn`, `.tool-btn`, `.oct-btn`, `.pad-bank`, `.drum-pad`, `.menu-item`, `.ib-chip` each separate). `ui/dialog.js` + `.app-dialog` is the one shared primitive. |
| Views | Sidebar SYNTH F1, ARRANGE F2, RACK F3, 909 F4 (`switchMode` app.js:932). Pads are bank pads inside synth view; F5 Pads view (`specs/pads-view.md`) not built. Mixer = drawer in arrange. Piano roll and library = dialogs. |
| A11y | 13 `:focus-visible` rules, 1 `prefers-reduced-motion` (mixer drawer), 0 `prefers-color-scheme`. |
| Tests | vitest + jsdom, ~22 DOM tests (`tests/theme.test.js`, `tests/ui-shell-structure.test.js`, …). No layout, canvas or screenshot coverage; no Playwright/axe. |
| CSP | `index.html:6`: `connect-src 'self'`, `font-src` unset (falls to `default-src 'self'`, so bundled fonts are allowed, remote blocked). |

## Decisions

1. **No new theme.** Re-value the existing `dark` and `light` token sets into the
   new language: `light` becomes the warm-neutral instrument surface, `dark` the
   same system on dark display panels. `rainbow` keeps its character but is
   re-expressed in the new tokens so it does not rot. Saved `synth_theme` values
   keep working; no migration.
2. **Fonts: system stacks, zero bytes.** `--font-ui: system-ui, "Segoe UI", sans-serif`;
   `--font-mono: ui-monospace, "Cascadia Mono", Consolas, monospace`. Mono for
   values, clocks, BPM and canvas labels only. Bundle a face only if phase 0
   mockups prove system fonts fail the look; CSP already permits same-origin fonts.
3. **Canvases read tokens.** One pure-ish helper `js/ui/theme-colors.js`:
   `readThemeColors(el) → { gridMajor, gridMinor, clip, playhead, … }` via
   `getComputedStyle`, called at paint setup and on `themechange`. Every canvas
   listed above repaints on theme change. This also fixes today's light/rainbow
   bug and is a prerequisite for every DAW surface.
4. **Split `style.css` by surface before restyling.** `styles/tokens.css`,
   `base.css`, `shell.css`, `synth.css`, `arrange.css`, `rack.css`, `tr909.css`,
   `dialogs.css`, `piano-roll.css`, imported in today's cascade order. Pure move,
   zero visual change. It exists so restyle agents own disjoint files and do not
   collide.
5. **Shared primitives are CSS, not new JS.** Add `.btn`, `.btn--toggle`,
   `.btn--danger`, `.panel`, `.lcd` (dark display treatment), `.knob` styling.
   Existing classes adopt them by composition. Merging the two knob
   implementations is **out of scope**; both get the same look via tokens.
6. **Colour roles, not colours.** Tokens are named by role:
   `--surface-*`, `--ink-*`, `--line-*`, `--focus`, `--state-record`,
   `--state-danger`, `--state-on`, `--group-1..4` (orange/blue/green/yellow
   control groups), `--track-1..n` (track identity), `--signal-audio/cv/gate`.
   Record/error/destructive stay red **plus** text or icon. No component may
   introduce a colour literal; a test enforces it (see Verify).
7. **Add spacing/radius/type tokens** (`--space-1..6`, `--radius-s/m`,
   `--text-xs..l`) only as surfaces are restyled — no up-front scale nobody uses.
8. **FM-1 device UI is not a phase here.** Its dialog uses these tokens and
   primitives when `fm1-emulator.md` phase 2 builds it. The F5 Pads view does the
   same when built.
9. **Visual baseline without new deps.** Screenshots via Chrome DevTools MCP
   against `npm run dev` renderer at 1440×900, 390×844 and 200 % zoom, each view,
   each theme, saved to `specs/ui-baseline/<phase>/`. No Playwright.

## Visual direction

Warm neutral surfaces, ink-dark text, one dark `.lcd` display treatment, four
saturated group accents. Group controls with hairline borders, flat panels,
small radii, light depth; clear pressed/active/disabled states. Motion confirms
an action, meter or transport position and is disabled under
`prefers-reduced-motion` (one global block, not per component). No faux screws,
textures or deep shadows. Uppercase micro-labels are accents, never the only label.

| Surface | Design |
|---|---|
| Shell (`#command-bar`, sidebar) | Compact instrument panel: project name, play/stop/record, BPM in `.lcd`, master, view nav. Record state unmistakable (colour + label + `aria-pressed`). Nothing above the workspace beyond the command bar. |
| Synth | Instrument slot, knob panel, keys and pads read as one performance surface. Knob groups carry `--group-n` markers matched to their value readouts. MIDI activity and unavailable instrument shown without blocking play. |
| Arrange + mixer drawer | Density first: beat-grid hierarchy, readable clip names, clear playhead, armed/mute/solo with shape + label. Track colour = identity, never the only cue. Must show at least as many tracks and as fine an edit grid as baseline. Strips with legible meter scales. |
| Piano roll | Same grid hierarchy as arrange; velocity readable; canvas colours from tokens. |
| Rack | HP sizing, port types, cable colours (`--signal-*`) and gestures unchanged; panels adopt surface/ink tokens. |
| 909 | Tactile step buttons; on / off / current step distinguishable without colour (fill + outline + playhead marker). Shortcuts unchanged. |
| Dialogs (browser, library, settings, MIDI, assistant) | `.app-dialog` restyled once; compact searchable lists, keyboard navigation, long names and errors readable. |

## Constraints

- No change to IDs, commands, accessible names, shortcuts, audio, timing,
  storage or project semantics. Rendering never blocks audio scheduling.
- Semantic HTML, native dialogs, focus restoration, visible focus on every
  control. WCAG AA for text and essential control/state boundaries. Never colour
  alone. Typing in inputs/dialogs never triggers note keys.
- No UI framework, no CDN/font fetch, no CSP change. Works under `/synth/` base
  path and on the LAN http route.

## Phases

Each phase is its own PR to `main`, deployable alone. Phases 2a–2e run as
parallel agents because phase 1 gave them disjoint CSS files.

| Phase | State | Deliverable | Exit gate |
|---|---|---|---|
| 0 — Baseline + direction | planned | Baseline screenshots (decision 9). Token table with real values for light and dark, plus a static mockup page (`specs/ui-mockups/index.html`, uses the token CSS directly) showing shell, synth, arrange and 909 at realistic density. | **User signs off** on direction. Contrast test passes for the proposed tokens. |
| 1 — Foundations | planned | Split CSS (decision 4); `theme-colors.js` + every canvas on tokens and repainting on `themechange`; new tokens and values from phase 0; system fonts; shared primitives; global reduced-motion block; no-literal and contrast tests. | Tests + build green. Screenshot diff: dark visually equivalent except fonts/token values; light/rainbow canvases now follow theme. |
| 2a — Shell + dialogs | planned | `shell.css`, `dialogs.css` | per-surface checklist below |
| 2b — Synth (knobs, keys, pads, sequencer) | planned | `synth.css`, knob panel markup only if needed for group markers | " |
| 2c — 909 | planned | `tr909.css`, `tr909-view.js` colours | " |
| 2d — Arrange, mixer, piano roll | planned | `arrange.css`, `piano-roll.css`, canvas palettes | " + track-count and grid-density check vs baseline |
| 2e — Rack | planned | `rack.css`, module canvases | " + cable/port colours unchanged in meaning |
| 3 — Consistency pass | planned | Cross-view review in Electron and browser, all themes, three viewport sizes; fix drift; update this table and AGENTS.md. | User review of final screenshots. |

Per-surface checklist (2a–2e): `npm test` and `npm run build` pass; screenshots
at the three viewports × light/dark saved next to baseline; keyboard-only pass of
the surface's primary workflow; no control lost; reduced motion respected; no
new colour literal.

## Verify

- `tests/theme-tokens.test.js` (added in phase 1): parses `styles/tokens.css`,
  asserts every theme defines every token, and checks WCAG ratios for declared
  pairs (`--ink-1` on `--surface-1` ≥ 4.5, state boundaries ≥ 3). Pure function,
  no DOM.
- Same test greps `styles/*.css` (except `tokens.css`) and the canvas modules for
  colour literals; allowlist is empty by end of phase 2.
- Screenshot review is human/agent visual comparison; no pixel-diff tooling.

## Agent execution

Main thread orchestrates, reviews and commits; agents never commit.

| Step | Agent | Input | Output |
|---|---|---|---|
| 0a baseline | main thread (needs Chrome MCP) | decision 9 | `specs/ui-baseline/0/` |
| 0b direction | main thread | this spec, baseline | token table + mockup; publish for user sign-off |
| 1 | `cavecrew-implementer` (sonnet), one brief | baseline section + decisions 2–7 with file:line pointers | branch diff + `phase1-handoff.md` |
| 1 review | `cavecrew-reviewer` | phase 1 diff | findings; fix before merge |
| 2a–2e | five `cavecrew-implementer` in parallel, `isolation: worktree`, one surface each | phase 1 handoff + surface row + checklist | per-surface diff + handoff |
| 2 review + screenshots | `cavecrew-reviewer` per diff; main thread captures screenshots | | merge one PR per surface |
| 3 | main thread | all handoffs | final screenshots, spec status |

Briefs carry exact pointers and pre-answered facts (CSS section lines, canvas
files, `themechange` already dispatched, jsdom has no canvas — test colour
reading as a pure function on a fake style object).

## Out of scope

Merging the two knob implementations; a new theme or theme setting; FM-1 device
and F5 Pads view (they adopt the system when built); any layout/IA change from
`ui-shell.md`; pixel-diff tooling; manufacturer branding.
