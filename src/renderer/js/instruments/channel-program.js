export const DEFAULT_CHANNEL_PROGRAM = { bankMsb: 0, bankLsb: 0, program: 0 }

const isByte = value => Number.isInteger(value) && value >= 0 && value <= 127
const isChannel = value => Number.isInteger(value) && value >= 0 && value < 16

function initialState() {
  return Array.from({ length: 16 }, () => ({ ...DEFAULT_CHANNEL_PROGRAM }))
}

export function applyChannelMidi(stateByChannel, event, resolvePatch) {
  if (!event || !isChannel(event.channel)) return { stateByChannel, change: null }

  const isBankSelect = event.kind === 'cc' && (event.controller === 0 || event.controller === 32)
  const isProgramChange = event.kind === 'program-change'
  if ((!isBankSelect || !isByte(event.value)) && (!isProgramChange || !isByte(event.program))) {
    return { stateByChannel, change: null }
  }

  const next = (Array.isArray(stateByChannel) && stateByChannel.length === 16 ? stateByChannel : initialState()).slice()
  const current = next[event.channel] || DEFAULT_CHANNEL_PROGRAM
  const channelProgram = { ...current }
  next[event.channel] = channelProgram

  if (isBankSelect) {
    channelProgram[event.controller === 0 ? 'bankMsb' : 'bankLsb'] = event.value
    return { stateByChannel: next, change: null }
  }

  channelProgram.program = event.program
  const { bankMsb, bankLsb, program } = channelProgram
  return {
    stateByChannel: next,
    change: { channel: event.channel, bankMsb, bankLsb, program, patch: resolvePatch?.(bankMsb, bankLsb, program, event.channel) ?? null }
  }
}
