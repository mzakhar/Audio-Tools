# GEMINI.md

## Project Overview
**Synth** is a browser-based, single-page application (SPA) synthesizer. It features four distinct synthesis engines, a 25-key on-screen piano, a 16-step sequencer, and a WAV recorder for capturing output.

### Tech Stack
- **Frontend:** Vanilla HTML5, CSS3, and JavaScript (ES6+).
- **Audio:** Web Audio API.
- **Architecture:** Modular design using IIFEs (Immediately Invoked Function Expressions) to expose global singletons.
- **Build System:** None. The project is designed to be run directly by opening `index.html` in a modern web browser.

## Building and Running
- **Run:** Open `index.html` directly in any modern web browser.
- **Local Development:** A simple static file server (e.g., `python -m http.server` or `npx serve`) is recommended to avoid potential CORS issues with certain Web Audio features, though not strictly required for the core functionality.
- **Testing:** No automated test suite is currently implemented. Verification is performed manually via browser playback and recording.

## Architecture & Modules
The application follows a strict load order defined in `index.html`:
`audio-engine.js` → `palettes.js` → `keyboard.js` → `sequencer.js` → `recorder.js` → `app.js`

### Key Modules
- **`AudioEngine`**: Manages the `AudioContext` and master gain/effect chain (`masterGain` → `reverb` → `compressor` → `destination`).
- **`Palettes`**: Contains definitions for synth engines (`classic`, `fm`, `drum`, `pad`). Each palette provides a `createVoice` (or `createDrumVoice`) method.
- **`Keyboard`**: Handles piano UI rendering and input (mouse, touch, PC keyboard). Dispatches `'note-on'` and `'note-off'` CustomEvents on `document`.
- **`Sequencer`**: A 16-step lookahead scheduler for melodic and drum tracks.
- **`Recorder`**: Captures the final mixed output using a `ScriptProcessorNode` and encodes it as a 16-bit PCM WAV.
- **`app.js`**: The main entry point that wires all modules together, manages the UI state (knobs, tabs, transport), and bootstraps the application.

## Development Conventions

### General
- **No Dependencies:** Do not add external libraries or package managers (npm/yarn) unless explicitly requested.
- **Global Scope:** Modules are exposed as globals (e.g., `AudioEngine`, `Palettes`). Follow this pattern when adding new modules.
- **User Gesture:** Web Audio requires initialization on a user gesture. Always call `AudioEngine.init()` within a click or keydown handler.

### UI & Styling
- **CSS Variables:** Use CSS custom properties for dynamic styling. For example, sliders use `--fill` for their progress gradient.
- **Knob Rendering:** Knobs (sliders) are rendered dynamically in `app.js` based on the `knobs[]` array in each palette.
- **Responsiveness:** The layout uses Flexbox to adapt to different screen sizes, with a fixed-width sidebar.

### Adding New Features
- **New Palette:** Create a new object in `js/palettes.js` implementing the `createVoice(ctx, output, freq, vel, time)` interface, register it in the `Palettes` map, and add a corresponding tab in `index.html`.
- **New Controls:** Add entries to the `knobs` or `selectors` arrays within a palette. `app.js` will automatically render them.
- **Audio Routing:** All audio sources should connect to `AudioEngine.getMasterInput()` to ensure they pass through the master effect chain and recorder.

## Key Files
- `index.html`: Main structure and script loading.
- `style.css`: All application styling, including custom slider designs and layout.
- `js/audio-engine.js`: Core audio graph and master context management.
- `js/palettes.js`: Synthesis engine logic and parameter definitions.
- `js/app.js`: Application logic and UI event orchestration.
