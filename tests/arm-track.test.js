import { describe, expect, it } from 'vitest'
import { armPlan } from '../src/renderer/js/instruments/arm-track.js'
import ProjectStore, { AddTrack } from '../src/renderer/js/store/ProjectStore.js'

describe('armPlan', () => {
  it('provisions when the project has no MIDI track', () => {
    expect(armPlan([], null)).toEqual({ trackId: null, provision: true })
    expect(armPlan([{ id: 'a1', type: 'audio' }], null)).toEqual({ trackId: null, provision: true })
  })

  it('prefers the armed track, then the first MIDI track', () => {
    const tracks = [{ id: 'a1', type: 'audio' }, { id: 'm1', type: 'midi' }, { id: 'm2', type: 'midi' }]
    expect(armPlan(tracks, 'm2')).toEqual({ trackId: 'm2', provision: false })
    expect(armPlan(tracks, null)).toEqual({ trackId: 'm1', provision: false })
    expect(armPlan(tracks, 'gone')).toEqual({ trackId: 'm1', provision: false })
  })

  it('creates exactly one track across two notes', () => {
    ProjectStore.reset()
    let armed = null
    // The three lines app.js's ensureMidiTrack() runs per note.
    const note = () => {
      const plan = armPlan(ProjectStore.getState().tracks, armed)
      if (plan.provision) ProjectStore.dispatch(AddTrack('midi', 'MIDI'))
      armed = plan.trackId || ProjectStore.getState().tracks.at(-1).id
    }
    note()
    note()
    expect(ProjectStore.getState().tracks.filter(track => track.type === 'midi')).toHaveLength(1)
    ProjectStore.reset()
  })
})
