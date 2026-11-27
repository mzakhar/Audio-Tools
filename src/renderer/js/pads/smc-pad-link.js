// smc-pad-link.js — shell: one request/response conversation with an SMC-PAD.
// The codec and every decision live in smc-pad-sysex.js; this only sends,
// waits for the matching reply, and caches what it read.

import {
  CMD, MODE_REGION, CONFIG_REGION, identityRequest, readRequest, rgbWrite,
  parseReply, readPayload, isIdentity, parseMode, recordReads, parseRecords, paintPlan, padNoteMap
} from './smc-pad-sysex.js'

/**
 * `send(bytes)` writes to the device's out port; feed every incoming SysEx to
 * `onSysex`. Nothing here throws: a silent or foreign device just yields null.
 */
export function createSmcPadLink({ send, timeoutMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null            // { cmd, resolve, timer } — one request in flight
  let identified = false
  let cached = null             // { profile, records } for the last profile read
  let running = null            // the refresh in progress, shared by overlapping callers
  let latest = null             // colours most recently asked for
  let painting = null           // the paint() in progress; refresh waits for it

  function request(bytes, cmd) {
    return new Promise(resolve => {
      const timer = setTimer(() => { pending = null; resolve(null) }, timeoutMs)
      pending = { cmd, resolve, timer }
      send(bytes)
    })
  }

  function onSysex(bytes) {
    const reply = parseReply(Array.from(bytes))
    if (!reply || !pending || reply.cmd !== pending.cmd) return
    const { resolve, timer } = pending
    pending = null
    clearTimer(timer)
    resolve(reply)
  }

  // A reply of the wrong size answers some other read (a late one after a
  // timeout), so it counts as no reply.
  async function read(region, addr, len) {
    const reply = await request(readRequest(region, addr, len), CMD.READ)
    const payload = reply && readPayload(reply)
    return payload?.length === len ? payload : null
  }

  async function readMode() {
    const payload = await read(MODE_REGION, 0, 12)
    return payload && parseMode(payload)
  }

  async function readRecords(profile) {
    const bytes = []
    for (const { addr, len } of recordReads(profile)) {
      const payload = await read(CONFIG_REGION, addr, len)
      if (!payload) return null
      bytes.push(...payload)
    }
    return parseRecords(bytes)
  }

  async function refreshOnce(colours) {
    if (!identified) {
      const reply = await request(identityRequest(), CMD.IDENTITY)
      if (!reply || !isIdentity(reply)) return null
      identified = true
    }
    const mode = await readMode()
    if (!mode?.user) {              // Performance/DAW presets: fixed colours, notes already 36–51
      cached = null                 // records may be edited while away; re-read on return
      return null
    }
    if (cached?.profile !== mode.profile) {
      const records = await readRecords(mode.profile)
      if (!records) return null
      cached = { profile: mode.profile, records }
    }
    for (const write of paintPlan(cached.profile, cached.records, colours)) {
      const ack = await request(rgbWrite(write.addr, write.rgb), CMD.ACK)
      if (!ack) return null         // a silent device must not hold the link for 128 timeouts
      cached.records[write.rec].rgb = write.rgb
    }
    return padNoteMap(cached.records)
  }

  /**
   * Paint pad i of every bank with colours[i] (working memory only) and return
   * the device-note → kit-note map, or null when the device is not in a user
   * preset or does not answer. Cheap to repeat: one mode read, then only the
   * records whose colour differs are written.
   */
  function refresh(colours) {
    latest = colours
    running ??= (async () => {
      await painting
      let used, result
      do {                          // a kit change mid-run paints again with the new colours
        used = latest
        result = await refreshOnce(used)
      } while (JSON.stringify(used) !== JSON.stringify(latest))
      return result
    })().finally(() => { running = null })
    return running
  }

  /**
   * LED mirror: write colours[pad] (null = leave) to every bank's record for that pad,
   * using the records the last refresh cached. Resolves true when every write was
   * acknowledged; false when idle, not in a user preset, or the device went quiet.
   */
  function paint(colours) {
    if (running || painting || !cached) return Promise.resolve(false)
    painting = (async () => {
      for (const write of paintPlan(cached.profile, cached.records, colours)) {
        const ack = await request(rgbWrite(write.addr, write.rgb), CMD.ACK)
        if (!ack) return false
        cached.records[write.rec].rgb = write.rgb
      }
      return true
    })().finally(() => { painting = null })
    return painting
  }

  /** True while the last mode read found a user preset (cached is dropped otherwise). */
  const isUserMode = () => cached !== null

  return { refresh, onSysex, paint, isUserMode }
}
