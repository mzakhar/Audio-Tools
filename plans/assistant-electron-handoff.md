# DAW Assistant — phase 3 (Electron parity) handoff

Spec: `specs/daw-assistant.md`, phase 3 status flipped `proposed` → `shipped`.

## Files changed

- `src/shared/daw-assistant/provider.js` — **new**. Extracted from
  `src/web-discovery/index.js`: `assistantModelCall`, `ASSISTANT_INSTRUCTIONS`,
  `ASSISTANT_PLAN_SCHEMA`, `ASSISTANT_ASK_INSTRUCTIONS`, `ASSISTANT_ASK_SCHEMA`,
  `ASSISTANT_MAX_OUTPUT_TOKENS`, `ASSISTANT_TIMEOUT_MS`. Reads no globals;
  `fetchFn`, `url`, `apiKey`, `model` all come in as call arguments (the web
  route previously hardcoded `OPENAI_URL` and the param name `openaiKey` —
  renamed to `url`/`apiKey` so the module has no notion of "OpenAI" baked in,
  since Electron connections may point at a personal provider).
- `src/web-discovery/index.js` — imports the above from `provider.js` instead
  of defining them locally. Two call sites now pass `url: OPENAI_URL, apiKey:
  openaiKey`. No behavior change; `tests/daw-assistant-route.test.js` passes
  untouched.
- `src/main/daw-assistant.js` — **new**. `createAssistantService({
  connections, fetchFn })` → `{ available(), propose({ prompt, digest,
  providerId }), ask({ prompt, digest, providerId }) }`. Picks a connection by
  `providerId`, falling back to `openai` then `provider` then the first
  configured connection (same order `music-discovery/index.js` uses).
  Validates/caps the prompt and clamps the digest with `clampDigest` before
  the model call, and gates the response through `validatePlanShape` /
  `validateAnswerShape` before returning. No rate limiting — commented as a
  deliberate omission (one local user, their own key).
- `src/main/index.js` — imports `createAssistantService`, adds a lazily
  constructed `assistant()` singleton beside `discovery()`, reset (along with
  `discoveryService`) inside `configureDiscovery` since they share the same
  connection store. Adds `ipcMain.handle('dawAssistant:available'|'propose'|
  'ask', ...)`.
- `src/preload/index.js` — `contextBridge.exposeInMainWorld('dawAssistant', {
  available, propose, ask })`, mirroring the `musicDiscovery` block.
- `src/renderer/js/app.js` — `assistantAvailable()` also returns true when
  `window.dawAssistant` exists.
- `src/renderer/js/components/assistant-dialog.js` — added `ipcPropose`/
  `ipcAsk` transport functions (same contract as `postPlan`/`postAnswer`, over
  `window.dawAssistant` instead of `fetch`). Constructor default changed from
  `deps.propose || postPlan` to `deps.propose || (window.dawAssistant ?
  ipcPropose : postPlan)` (same shape for `ask`). Injected deps still win.
  Nothing else in the dialog changed.
- `specs/daw-assistant.md` — phase 3 status → shipped, phase 3 prose rewritten
  to describe what actually shipped.

## Tests added

- `tests/daw-assistant-provider.test.js` — asserts the extracted
  `assistantModelCall` request shape (schema name, `strict: false`, capped
  `max_output_tokens`, digest carried in `input` not `instructions`) against a
  stubbed `fetchFn`, plus upstream-failure/status propagation.
- `tests/daw-assistant-main.test.js` — `createAssistantService`: unavailable
  with no connection, `providerId` selection, invalid plan refused before
  return, digest clamped before the provider call, ask mode never returns a
  plan/actions and refuses a response smuggling `actions`, no request made
  when no connection is configured, connection key never appears in the
  returned value.
- `tests/daw-assistant-transport.test.js` — `AssistantDialog` picks the IPC
  bridge when `window.dawAssistant` exists and no dep was injected, falls back
  to `fetch` otherwise, and an injected dep always wins.

## Verify

`npm test` — 101 files / 1306 tests, all green (baseline was 98/1293; +3 files
/ +13 tests, no regressions).

## Deviations / decisions

- Renamed `openaiKey` → `apiKey` and hardcoded `OPENAI_URL` → an injected
  `url` param on the extracted `assistantModelCall`, since Electron
  connections (`music-discovery/connections.js`) can point at a non-OpenAI
  `baseUrl`. Reused `responsesUrl()` from
  `src/main/music-discovery/openai-compatible.js` to normalize a connection's
  `baseUrl` into the Responses endpoint, exactly as `createOpenAICompatibleAdapter`
  does for discovery's reviewer.
- No settings UI for assistant-specific provider selection — it reuses
  whatever discovery already has configured. `providerId` is accepted end to
  end (preload → IPC → service) for forward compatibility but nothing in the
  renderer sends one today; omitted, it picks `openai` then `provider`.
- Rate limiting explicitly not implemented, per brief item B — commented in
  `src/main/daw-assistant.js`.

## Deferred / left undone

- Nothing from phase 3's scope. Phase 4 (conversation, follow-ups,
  audio-aware suggestions) remains deferred by design, unchanged.
