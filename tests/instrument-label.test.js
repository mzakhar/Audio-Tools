import { describe, expect, it } from 'vitest'
import { trackInstrumentLabel } from '../src/renderer/js/instruments/instrument-label.js'

describe('trackInstrumentLabel', () => {
  it('uses friendly names for internal and installed pack instruments', () => {
    expect(trackInstrumentLabel({ type: 'palette', paletteKey: 'fm' }, [])).toBe('FM Synthesis')
    expect(trackInstrumentLabel({ type: 'pack', packId: 'gm', packVersion: '1', patchId: 'piano' }, [{
      id: 'gm', version: '1', manifest: { patches: [{ id: 'piano', name: 'Acoustic Grand' }] }
    }])).toBe('Acoustic Grand · gm')
  })
})
