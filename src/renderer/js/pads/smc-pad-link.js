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

  async function readMode() {
    const reply = await request(readRequest(MODE_REGION, 0, 12), CMD.READ)
    return reply && parseMode(readPayload(reply))
  }

  async function readRecords(profile) {
    const bytes = []
    for (const { addr, len } of recordReads(profile)) {
      const reply = await request(readRequest(CONFIG_REGION, addr, len), CMD.READ)
      if (!reply) return null
      bytes.push(...readPayload(reply))
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
    if (!mode?.user) return null    // Performance/DAW presets: fixed colours, notes already 36–51
    if (cached?.profile !== mode.profile) {
      const records = await readRecords(mode.profile)
      if (!records) return null
      cached = { profile: mode.profile, records }
    }
    for (const write of paintPlan(cached.profile, cached.records, colours)) {
      const ack = await request(rgbWrite(write.addr, write.rgb), CMD.ACK)
      if (ack) cached.records[write.rec].rgb = write.rgb
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
    running ??= refreshOnce(colours).finally(() => { running = null })
    return running
  }

  return { refresh, onSysex }
}
