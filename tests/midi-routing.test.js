import { describe, it, expect } from 'vitest'
import { routeChannel } from '../src/renderer/js/midi/midi-routing.js'

function track(id, midiChannel) {
  return midiChannel === undefined ? { id } : { id, midiChannel }
}

describe('routeChannel', () => {
  it('returns all tracks declared on the channel', () => {
    const tracks = [track('a', 0), track('b', 0), track('c', 1)]
    expect(routeChannel(tracks, 0, null)).toEqual(['a', 'b'])
  })

  it('channel 0 counts as declared', () => {
    const tracks = [track('a', 0)]
    expect(routeChannel(tracks, 5, 'armed')).toEqual([])
  })

  it('falls back to armed track when nothing declares a channel', () => {
    const tracks = [track('a'), track('b')]
    expect(routeChannel(tracks, 3, 'a')).toEqual(['a'])
  })

  it('routes a single Omni track without requiring arming', () => {
    expect(routeChannel([track('a')], 3, null)).toEqual(['a'])
  })

  it('does not guess between multiple Omni tracks', () => {
    expect(routeChannel([track('a'), track('b')], 3, null)).toEqual([])
  })

  it('returns empty when a routing map exists but channel is unmapped', () => {
    const tracks = [track('a', 0), track('b')]
    expect(routeChannel(tracks, 5, 'armed')).toEqual([])
  })
})
