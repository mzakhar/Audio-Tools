# DAW Assistant -- phases 5/6/7 implementation brief

Source spec: specs/daw-assistant.md (phases 5 pp.414-436, 6 pp.438-464, 7
pp.466-489; contracts at pp.139-288). Phases 0-2 are shipped and read below as
the pattern to copy. This is a pointer brief, not a design doc -- no fixes
proposed.

## 1. src/shared/daw-assistant/digest.js (212 lines)

- Constants: MAX_TRACKS=32(4) MAX_CLIPS=32(5) MAX_MODULES=64(6)
  MAX_CABLES=64(7) MAX_BARS=8(8) MAX_NAME=64(9) STEPS=16(10).
- text(value, max) sanitizer: 16-18.
- scalars(params) -- module/effect param bag, drops non-scalars and unsafe
  keys: 25-35.
- instrument(value) projector (track.instrument -> digest shape): 37-45.
  Phase 5 note: this has no params field -- phase 5 needs
  instrument.params added here, capped like scalars().
- buildDigest(state): 51-128. Per-section line ranges inside it:
  - drop/cap helper: 54-58
  - tracks projection: 60-76
  - mixer projection: 78-84
  - racks/modules/cables projection: 86-99
  - lane(steps) 16-char collapse: 103
  - patterns/bars projection: 105-121
  - return shape: 123-127
- clampDigest(digest) (server-side re-clamp, same shape, coerces bad input
  instead of throwing): 138-212. Mirrors buildDigest section-for-section:
  tracks 148-161, mixer 163-169, racks 171-187, patterns 189-205, return
  207-211.
- Phase 7 note: instrument() (37-45) already carries packId; it has no
  patchId or patch name. Phase 7 needs the digest to expose pack id, patch
  id and patch name per armed track (spec p.485-486), added to both
  buildDigest's instrument() call site and clampDigest's mirror.

## 2. src/shared/daw-assistant/plan.js (641 lines)

Exports: MAX_SUMMARY, MAX_ACTIONS, MAX_NOTES, MAX_CHAIN, MAX_PARAM_ENTRIES
(7-11), ALLOWLIST (201), validatePlanShape (234-279), validatePlan
(361-498), describeAction (512-560), planToCommands (622-641).

### The allowlist data structure (verbatim, 141-199)

SPECS is a plain object keyed by action name. A value is either a field
map { argName: checkFn } (each check returns the coerced value or null to
reject) or a function args => resultOrNull for cross-field rules
(SetMixerParam 161-169, SetBarParam 177-186). ALLOWLIST = Object.freeze(
Object.keys(SPECS)) (201) -- this is the literal table validatePlanShape
looks up against (line 250), never a dynamic lookup into a command module.

Field-check primitives (22-51): num(min,max), int(min,max), bool,
str(max), oneOf(set), optional(check, fallback), id, slug,
idOrRef, objectKey (prototype-pollution-safe key check, 42-45), scalar
(number/bool/short string, 47-51), paramBag (bounded object of objectKey ->
scalar, 53-66).

### One action end to end -- SetModuleParam (closest existing analogue for
phase 5's SetInstrumentParam, since both resolve a key against a
capability-injected function rather than a static list)

1. Arg schema (194): SetModuleParam: { rackId: id, moduleId: idOrRef, key: objectKey, value: scalar }
2. Shape validation: no bespoke code needed -- the generic field-map loop
   in validatePlanShape (268-275) walks the spec.
3. Live validation (validatePlan switch, case at 468-476):
   case 'SetModuleParam': {
     const rack = rackOf(state, args.rackId)
     if (!rack) { errors.push(where + ": rack not found"); break }
     const mod = moduleOf(rack, args.moduleId)
     if (!mod) { errors.push(where + ": module not found"); break }
     if (typeof caps.moduleParamKeys !== 'function') break
     if (has(caps.moduleParamKeys(mod.type), args.key) === false) errors.push(where + ": param not on module")
     break
   }
   Capability-missing = check skipped, never assumed to pass (359, 473).
4. describeAction (553): Set KEY to VALUE on MODULE -- mod() helper defined
   518-521 resolves a real name or falls back to the raw id/$ref phrase.
5. planToCommands: CALLS.SetModuleParam (593):
   a => ['SetModuleParam', a.rackId, a.moduleId, a.key, a.value]. No entry in
   MINTED (602-608) or MINTS_IDS (611) because it creates no id.

To add a new action: add one SPECS entry, one switch case in
validatePlan (only if it needs an existence/capability check beyond "args
already validated"), one describeAction case, one CALLS entry, and -- if it
creates an id -- one REF_SLOTS/MINTED/project() entry (see below). Then
wire it into src/web-discovery/index.js's ASSISTANT_INSTRUCTIONS/
ASSISTANT_PLAN_SCHEMA (ALLOWLIST is imported there so the enum updates
itself) and into the renderer's FACTORIES/ASSISTANT_CAPABILITIES map in
assistant-dialog.js.

### capabilities threading

Optional 4th param of validatePlan(plan, state, capabilities = {}) (361).
Normalized at 364 (plainObject(capabilities) ? capabilities : {}). Used at
three call sites: caps.moduleTypes (458, AddModule),
caps.moduleParamKeys (473-474, SetModuleParam), caps.canConnect
(481-485, Connect). has(set, value) (288) accepts a Set or an array so a
capability can return either. Phase 5 adds a fourth:
capabilities.paletteParamKeys(paletteKey) (spec p.428), same pattern as
moduleParamKeys. The renderer's concrete capability object is
ASSISTANT_CAPABILITIES in assistant-dialog.js:43-48.

### $ref / forward references

- REF_SLOTS (208-215): maps slot name -> { CreatingAction: idKeyItFills }.
  channelId maps to AddTrack: 'channelId' -- the special case where a track
  ref in a channel slot resolves to that track's mixer channel (spec
  p.223,291-293).
- CREATING (216) = every action name appearing as a key anywhere in
  REF_SLOTS's values.
- resolveRefs(args, lookup) (220-231): pure rewrite of every { $ref } in an
  id slot (including nested from/to endpoints for Connect) through a
  caller-supplied lookup(slot, slug).
- stubIds(ref) (328) and project(state, action, args, ref) (334-354):
  build a placeholder projected state so live checks (existence,
  canConnect, moduleParamKeys) run against a shape that includes what a
  creating action is about to make. Only AddTrack, AddClip,
  AddMidiNote, AddEffect, AddModule have project() cases (336-350);
  phase 5/6/7's new actions do not create ids, so none of REF_SLOTS,
  CREATING, project(), MINTED needs a new entry for them.
- In planToCommands (622-641), refs resolve to pre-minted ids via
  MINTED[action](makeId) (602-608) before any command executes (line 636),
  so two applies of one plan never collide (tested in
  tests/daw-assistant.test.js:258-266).

## 3. Renderer dialog -- src/renderer/js/components/assistant-dialog.js (177 lines)

- ASSISTANT_ROUTE = '/api/assistant' (27).
- postPlan(prompt, digest, signal) (83-94): the actual fetch POST,
  { prompt, digest } body, throws data.error on non-2xx or missing
  data.plan.
- ASSISTANT_CAPABILITIES (43-48): moduleTypes: Object.keys(MODULES),
  moduleParamKeys: type => Object.keys(paramDefaults(type)),
  canConnect: (rack, from, to) => canConnect(rack, from, to) -- all three
  imported from ../rack/modules/index.js:24.
- FACTORIES (31-40): literal name->function map, every allowlisted action
  present; bindCommands (54-61) throws TypeError on any name not in this
  object (never FACTORIES[name] trusted blind -- hasOwnProperty check at 56).
- applyPlan(plan, store) (67-80): re-runs validatePlan against
  store.getState() (69), on failure returns { ok:false, errors } without
  dispatching anything; on success calls planToCommands then bindCommands
  then store.dispatchBatch(commands, "Assistant: " + summary) (78) -- this is
  the one-undo-per-plan path.
- makeId (52): kind + "-asst-" + (++_minted) + "-" + Date.now().
- showPlan(plan) (125-141): renders plan.summary as a <p> and one <div
  class="asst-action"> per action via describeAction(action, state,
  plan.actions || []) (138).
- runPropose() (143-164) / runApply() (166-175): Propose calls
  this.propose(prompt, buildDigest(this.store.getState()), signal) (153,
  default this.propose = postPlan); Apply calls applyPlan(this.plan,
  this.store) (168) then showPlan(null) to clear on success (174).
- Dialog wiring / DOM ids: ASSISTANT_DIALOG_ID = 'assistant-dialog' (26),
  #asst-prompt, #asst-status, #asst-plan, #asst-propose-btn,
  #asst-apply-btn, #asst-discard-btn (105-112). Abort on dialog close
  event (114).

Phase 6 ("ask mode") is not implemented here at all -- no mode field
anywhere in this file, postPlan always sends { prompt, digest }. Adding it
means a new response shape ({ answer, cited }, no plan/actions) that
postPlan/showPlan do not currently branch on.

## 4. src/web-discovery/index.js (278 lines)

- Route allowlist: line 207 --
  ['/api/music-discovery', '/api/music-discovery/leads', '/api/assistant'].
- Rate limiter: withinLimit(identity, path) 184-192, keyed by
  identity + "::" + path; assistantLimit (default 4, option at 178)
  vs. limit (default 12, option at 176) chosen at 185 by
  path === '/api/assistant'. Applied for every route at 210 before any
  branch runs.
- Assistant handler: 216-253, inside the route dispatch that starts at 205.
  - prompt validation: 219-222 (ASSISTANT_MAX_PROMPT = 2000, line 18).
  - digest type-check then clampDigest(rawDigest): 223-227.
  - OpenAI request build: 231-245, inline fetchFn(OPENAI_URL, ...), not
    routed through openai-compatible.js (see item 5 -- spec p.307-308 says
    "preferably by extracting that call"; this was not done, it is a second,
    slightly different copy of the Responses-API call shape).
  - json_schema / ASSISTANT_PLAN_SCHEMA: defined 24-42, referenced at 243
    (strict: false deliberately, per spec p.310-316).
  - ASSISTANT_INSTRUCTIONS (system-role instructions string, imports
    ALLOWLIST from plan.js): 21-23.
  - validatePlanShape call: line 249, right after JSON.parse(outputText(...))
    (line 248); on failure throws, caught by the outer try/catch (269-276)
    which maps to a 424 (271-274, comment explains why not 502).
  - Timeout: ASSISTANT_TIMEOUT_MS = 20000 (line 20), setTimeout at 229,
    clearTimeout in finally at 252.
  - Success response: send(res, 200, { plan }) at 253.
- mode (phase 6) is not present anywhere in this file -- no branch reads
  payload.mode; adding ask mode means a new field check alongside the
  prompt/digest checks (219-227) and a second OpenAI schema/instructions
  pair with no actions field, per spec p.444-455 ("mode is validated
  server-side against a literal pair; anything else is a 400").

## 5. OpenAI call helper -- src/main/music-discovery/openai-compatible.js (75 lines)

createOpenAICompatibleAdapter(connection, { fetchFn }) (32-75) -- returns
{ async review({ brief, candidates, signal }) } (36-73). Not generic across
"ranking" vs. "plan" response shapes: it hardcodes the ranking schema (5-16),
instructions string (52), and response parsing (outputText, 18-20, plus
the ranked array unpacking at 66-72). responsesUrl(baseUrl) (22-29) is the
one reusable, response-shape-agnostic piece (URL normalization to
.../v1/responses).

The assistant route does not call this helper at all -- it is Electron-side
(src/main/), and src/web-discovery/index.js is the Node proxy service; it
duplicates the fetch/timeout/schema-request shape inline (index.js:231-245)
rather than importing from here. There is no existing "OpenAI Responses request
w/ json_schema" helper shared between the two other than the outputText
extractor pattern, which is copy-pasted three times: openai-compatible.js:18-20,
index.js:92-94 (discovery's review()), index.js:248 (assistant, inlined
without a named helper).

## 6. Instrument packs / pack program

- Pack manifest read (renderer): src/renderer/js/app.js:307-328
  (refreshPackCatalog()), reads from both window.electronFS.listInstrumentPacks
  and IndexedDB (webPackStore()), then compilePackManifest(entry.manifest)
  (321) from src/renderer/js/instruments/pack-registry.js:77-93. One bad
  manifest is skipped, not fatal (318-323).
- pack-registry.js also has patchAddressKey (16-19), validatePackManifest
  (25-75), resolvePatch(pack, address, {channel, channelProfile}) (99-108,
  returns { patch, source, selection } where selection is exactly the
  { packId, packVersion, patchId, bankMsb, bankLsb, program, source, unresolved }
  shape SetTrackInstrumentProgram consumes), packPatchState (135-138).
- Patch id shape: minted at src/shared/sf2-import.js:192 as
  id: "sf2-" + p where p is the phdr preset index (per AGENTS.md: "A
  bank's presets array position is the phdr index and the patch id").
- SetTrackInstrumentProgram -- src/renderer/js/store/ProjectStore.js:153-185,
  verbatim:

  export function SetTrackInstrumentProgram(trackId, selection) {
    return {
      label: 'MIDI program change',
      execute(state) {
        const next = JSON.parse(JSON.stringify(state))
        const track = next.tracks.find(t => t.id === trackId)
        if (!track || track.type !== 'midi' || !selection?.packId || !selection?.packVersion) return next
        if (track.instrument?.programFollow === 'pinned') return next
        const patchId = selection.patchId || track.instrument?.patchId
        if (!patchId) return next
        const { bendRange, modDest } = track.instrument || {}
        track.instrument = {
          type: 'pack',
          packId: selection.packId,
          packVersion: selection.packVersion,
          patchId,
          programFollow: 'midi',
          ...(bendRange === undefined ? {} : { bendRange }),
          ...(modDest === undefined ? {} : { modDest }),
          received: {
            bankMsb: selection.bankMsb,
            bankLsb: selection.bankLsb,
            program: selection.program
          },
          ...(selection.unresolved ? { unresolved: true } : {})
        }
        return next
      },
      undo(state) { return state }
    }
  }

  The pinned short-circuit is line 160 (spec's "ProjectStore.js:151" is the
  blank line just above this function's leading comment at 152 -- same
  function). Phase 7's requirement "a programFollow:'pinned' instrument is
  not silently overridden -- the assistant must refuse rather than emit an
  action it knows will be ignored" (spec p.482-483) means the new
  SetTrackInstrumentProgram allowlist action's live-validation case in
  plan.js must check track.instrument?.programFollow === 'pinned' itself
  and error, since plan.js never dispatches this store command and so never
  hits the guard above at apply time through the normal path -- planToCommands
  only ever builds descriptors, the guard at 160 runs inside the store command
  the assistant would be constructing.
- programFollow/migration note: ProjectStore.js:61-67 (migrate(), "<
  version 5" step) backfills programFollow = 'midi' on old pack instruments
  that lack it. CURRENT_VERSION is at ProjectStore.js:15 per AGENTS.md.
- SetTrackInstrumentProgram is explicitly in the phase-0 exclusion list
  (spec p.257, "Deliberately excluded"), so it does not currently appear in
  plan.js SPECS, ALLOWLIST, assistant-dialog.js FACTORIES, or
  anywhere in the digest's instrument() projector.

## 7. Tests

### tests/daw-assistant.test.js (482 lines) -- pure src/shared/ unit tests

- Imports buildDigest, clampDigest + caps from digest.js (2),
  validatePlanShape, validatePlan, describeAction, planToCommands, ALLOWLIST
  from plan.js (3), and ProjectStore, { AddTrack, AddEffect, SetBpm } (4)
  -- the only test file importing the real store, used for the
  dispatchBatch describe block (420-481).
- Fixture builder pattern: state() factory (9-34) returns a full plain-object
  project shape by hand (no mocks/fakes beyond plain data); plan(...actions)
  helper (36) wraps actions in { summary, actions }.
- Style: flat describe/it, no beforeEach except for the
  ProjectStore.dispatchBatch block (421, ProjectStore.reset()), heavy use
  of table-driven cases via for (const [...] of [...]) (e.g. 193-209).
  Capability functions are vi.fn() when the test needs a call-count/args
  assertion (168, 189).
- Verbatim example (94-100):

  it('exposes only the specced action vocabulary', () => {
    expect(ALLOWLIST).toContain('SetBpm')
    for (const excluded of ['AddRack', 'RemoveRack', 'LoadRackPatch', 'SetCurrentBar', 'SetBusReturn', 'SetCableColor']) {
      expect(ALLOWLIST).not.toContain(excluded)
    }
  })

  A phase-5/7 test would add SetInstrumentParam/SetTrackInstrumentProgram
  to the "contained" side once added, and this negative list needs no change
  (still excludes wholesale commands).

### tests/daw-assistant-route.test.js (144 lines) -- Node HTTP handler tests

- Imports only createWebDiscoveryHandler from src/web-discovery/index.js (3).
- Builds a real RS256 keypair with node:crypto (5) and signs its own Access
  JWTs via a token(claims) helper (9-13) -- no mocking of jsonwebtoken,
  the whole verification path runs for real against a self-issued cert served
  by a stubbed fetchFn.
- fetchFn is a vi.fn(async url => ...) that branches on the exact URL
  string (certs endpoint vs. https://api.openai.com/v1/responses) -- see
  planFetch(plan) (25-31). Request objects are plain objects implementing
  Symbol.asyncIterator to satisfy for await (const chunk of req) in the
  handler's body() (index.js:81-90); see assistantRequest (15).
- response() helper (17): { writeHead: vi.fn(), end: vi.fn() }, asserted
  against directly (res.writeHead).toHaveBeenCalledWith(200, ...)).
- Verbatim example (67-73):

  it('returns the plan for a shape-valid response', async () => {
    const fetchFn = planFetch(validPlan)
    const res = response()
    await handler(fetchFn)(assistantRequest({ prompt: 'set bpm to 128', digest: validDigest }), res)
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    expect(JSON.parse(res.end.mock.calls[0][0]).plan).toMatchObject(validPlan)
  })

  A phase-6 mode: 'ask' test would add a second assistantRequest payload
  variant and assert on { answer, cited } instead of { plan }, following
  this exact shape.

### tests/daw-assistant-dialog.test.js (167 lines) -- renderer glue tests

- Imports validatePlan from shared plan.js (4), ProjectStore, {
  AddTrack } from the real store (5), and ASSISTANT_CAPABILITIES,
  bindCommands, applyPlan from assistant-dialog.js (6) -- tests the real
  capability adapter against the real canConnect/MODULES registry, no
  mocking of rack internals.
- spyStore() helper (60-63) wraps the real ProjectStore so
  dispatchBatch calls can be counted while state still really changes:

  const spyStore = () => ({
    getState: () => ProjectStore.getState(),
    dispatchBatch: vi.fn((commands, label) => ProjectStore.dispatchBatch(commands, label)),
  })

  (60-63) -- a real store, a wrapped method, not a full mock. This is the
  idiom to reuse for a phase-5/6/7 apply-path test.
- beforeEach(() => { ProjectStore.reset() }) (58).
- Verbatim example (65-77):

  it('refuses a plan whose track was deleted after propose, and dispatches nothing', () => {
    ProjectStore.dispatch(AddTrack('midi', 'Kick'))
    const trackId = ProjectStore.getState().tracks[0].id
    const pending = plan({ action: 'SetTrackMidiChannel', args: { trackId, channel: 3 } })
    ProjectStore.dispatch({ label: 'Remove track', execute: state => ({ ...state, tracks: [] }) })
    const store = spyStore()
    const result = applyPlan(pending, store)
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('track not found')
    expect(store.dispatchBatch).not.toHaveBeenCalled()
  })

## Cross-cutting facts for phases 5/6/7

- Phase 5 blocked on specs/palette-state.md landing (status: proposed, not
  present as store fields today -- palette knob values are not in
  ProjectStore state; confirmed no paletteParamKeys capability exists
  anywhere in rack/modules/index.js or assistant-dialog.js).
- Phase 6 route/schema is entirely unbuilt: no mode handling in
  web-discovery/index.js, no ask-mode UI in assistant-dialog.js.
- Phase 7's SetTrackInstrumentProgram allowlist action does not exist in
  plan.js SPECS/ALLOWLIST/REF_SLOTS and the digest's instrument() projector
  (digest.js:37-45) does not expose patch name or pack patch list -- both
  need additions per spec p.485-486.
- Deploy-side phase-1 items (ingress Prefix /api, rate limiter keyed by
  route) are already shipped -- verified at
  deploy/k8s/discovery-ingress.yaml:11 (path: /api) and
  src/web-discovery/index.js:184-192.
