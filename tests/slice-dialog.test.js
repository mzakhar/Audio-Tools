import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSliceDialog, peaks, regionAt } from '../src/renderer/js/components/slice-dialog.js'

const SR = 8000
// 2 s of low noise with a decaying burst every quarter second: 8 clean onsets.
function loop() {
  const data = new Float32Array(SR * 2)
  for (let i = 0; i < data.length; i++) data[i] = ((i * 7919) % 100 - 50) / 50 * 0.002
  for (let k = 0; k < 8; k++) {
    const at = k * SR / 4 + 100
    for (let i = 0; i < 800; i++) data[at + i] += Math.sin(i * 0.6) * Math.exp(-i / 200) * 0.8
    for (let i = 0; i < 800; i++) data[at + 1000 + i] += Math.sin(i * 0.6) * Math.exp(-i / 200) * 0.06   // weak: only picked at sensitivity > 0
  }
  return data
}
const fakeBuffer = data => ({ sampleRate: SR, length: data.length, numberOfChannels: 1, duration: data.length / SR, getChannelData: () => data })

let el
beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = `<dialog id="slice-dialog"><canvas class="slice-canvas"></canvas><output class="slice-info"></output>
    <input class="slice-sens" type="range" min="0" max="100" value="50"><p class="slice-msg"></p>
    <button class="slice-setbpm" hidden></button><button class="slice-apply"></button></dialog>`
  el = sel => document.querySelector(`#slice-dialog ${sel}`)
})
afterEach(() => vi.useRealTimers())

describe('slice dialog', () => {
  it('open slices to exactly 16 contiguous regions and offers the BPM suggestion', () => {
    const d = createSliceDialog()
    d.open({ name: 'loop', buffer: fakeBuffer(loop()), bytes: new ArrayBuffer(4) })
    const r = d.regions()
    expect(r).toHaveLength(16)
    expect(el('.slice-canvas').dataset.regions).toBe('16')
    expect(r[0].start).toBe(0)
    for (let i = 1; i < 16; i++) expect(r[i].start).toBe(r[i - 1].end)
    expect(el('.slice-info').textContent).toContain('loop')
    expect(el('.slice-setbpm').hidden).toBe(false)
    expect(el('.slice-setbpm').textContent).toMatch(/^SET BPM TO \d/)
  })

  it('changing sensitivity re-slices after the debounce', () => {
    const d = createSliceDialog()
    d.open({ name: 'loop', buffer: fakeBuffer(loop()), bytes: new ArrayBuffer(4) })
    const before = JSON.stringify(d.regions())
    el('.slice-sens').value = '0'
    el('.slice-sens').dispatchEvent(new Event('input'))
    expect(JSON.stringify(d.regions())).toBe(before)   // not yet
    vi.advanceTimersByTime(200)
    expect(d.regions()).toHaveLength(16)
    expect(JSON.stringify(d.regions())).not.toBe(before)
  })

  it('Set BPM and Apply hand over their payloads', () => {
    const onApply = vi.fn(), onSetBpm = vi.fn()
    const bytes = new ArrayBuffer(4)
    const d = createSliceDialog({ onApply, onSetBpm })
    d.open({ name: 'loop', buffer: fakeBuffer(loop()), bytes })
    el('.slice-setbpm').click()
    expect(onSetBpm).toHaveBeenCalledWith(expect.any(Number))
    el('.slice-apply').click()
    expect(onApply).toHaveBeenCalledWith({ regions: d.regions(), sampleRate: SR, name: 'loop', bytes })
  })

  it('clicking a region auditions it', () => {
    const audition = vi.fn()
    const buffer = fakeBuffer(loop())
    const d = createSliceDialog({ audition })
    d.open({ name: 'loop', buffer, bytes: new ArrayBuffer(4) })
    el('.slice-canvas').getBoundingClientRect = () => ({ left: 0, width: 100 })
    el('.slice-canvas').dispatchEvent(new MouseEvent('click', { clientX: 1 }))
    const r0 = d.regions()[0]
    expect(audition).toHaveBeenCalledWith(buffer, r0.start / SR, r0.end / SR)
  })
})

describe('helpers', () => {
  it('peaks gives min/max per column', () => {
    const p = peaks(Float32Array.from([0, 1, 0, 0.5]), 2)
    expect(Array.from(p)).toEqual([0, 1, 0, 0.5])
  })
  it('regionAt finds the containing region or -1', () => {
    const r = [{ start: 0, end: 10 }, { start: 10, end: 20 }]
    expect([regionAt(r, 0), regionAt(r, 10), regionAt(r, 25)]).toEqual([0, 1, -1])
  })
})

describe('slice dialog close', () => {
  it('calls onClose when the dialog closes', () => {
    const onClose = vi.fn()
    createSliceDialog({ onClose })
    document.querySelector('#slice-dialog').dispatchEvent(new Event('close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
