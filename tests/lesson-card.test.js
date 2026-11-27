// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createLessonCard } from '../src/renderer/js/components/lesson-card.js'
import { LESSONS, emptyProgress, markDone } from '../src/renderer/js/pads/lessons.js'

function setup(progress = emptyProgress()) {
  document.body.innerHTML = '<dialog id="lesson-dialog" data-nonmodal><div id="lesson-body"></div></dialog>'
  const d = document.getElementById('lesson-dialog')
  d.show = () => { d.open = true }
  d.showModal = () => { d.open = true }
  d.close = () => { d.open = false; d.dispatchEvent(new Event('close')) }
  const session = { progress: () => progress, nextAfter: id => LESSONS[LESSONS.findIndex(l => l.id === id) + 1] ?? null }
  const onStart = vi.fn()
  const onStop = vi.fn()
  return { card: createLessonCard({ session, onStart, onStop }), onStart, onStop, d }
}
const model = (lesson, done = false) => ({
  lesson, result: { done, progress: 0.5, label: '3/10 good' }, score: null, hints: ['a', 'b', 'c'], taps: 4,
  calibration: null, progress: emptyProgress(), done
})

describe('lesson card', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('picker lists lessons, marks done, start fires onStart', () => {
    const { card, onStart, d } = setup(markDone(emptyProgress(), 'l1', 'x'))
    card.open()
    expect(d.open).toBe(true)
    const rows = document.querySelectorAll('button[data-lesson]')
    expect(rows.length).toBe(LESSONS.length)
    expect(document.querySelector('[data-lesson="l1"] .lesson-tick')).toBeTruthy()
    expect(document.querySelector('[data-lesson="l2"] .lesson-tick')).toBeNull()
    rows[3].click()
    expect(onStart).toHaveBeenCalledWith('l3')
  })

  it('active view shows steps, max 2 hints, and Next only when done', () => {
    const { card } = setup()
    card.open()
    card.render(model(LESSONS[2]))
    expect(document.querySelectorAll('.lesson-steps li').length).toBe(LESSONS[2].steps.length)
    expect(document.querySelectorAll('.lesson-hints li').length).toBe(2)
    expect(document.querySelector('[data-lesson-next]')).toBeNull()
    card.render(model(LESSONS[2], true))
    expect(document.querySelector('[data-lesson-next]').dataset.lessonNext).toBe('l3')
  })

  it('live updates keep the same DOM nodes and only change text', () => {
    const { card } = setup()
    card.open()
    card.render(model(LESSONS[2]))
    const stop = document.querySelector('[data-lesson-act="stop"]')
    card.render({ ...model(LESSONS[2]), result: { done: false, progress: 0.6, label: '5/10 good' }, hints: ['x'] })
    expect(document.querySelector('[data-lesson-act="stop"]')).toBe(stop)
    expect(document.querySelector('.lesson-live').textContent).toBe('5/10 good')
    expect(document.querySelectorAll('.lesson-hints li').length).toBe(1)
  })

  it('does not render while the dialog is closed', () => {
    const { card } = setup()
    card.render(model(LESSONS[2]))
    expect(document.querySelector('.lesson-live')).toBeNull()
  })

  it('Escape closes the card and stops the lesson; open focuses the body, not the close button', () => {
    const { card, onStop, d } = setup()
    card.open()
    expect(document.activeElement).toBe(document.getElementById('lesson-body'))
    d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(d.open).toBe(false)
    expect(onStop).toHaveBeenCalled()
  })

  it('notice shows in the active card', () => {
    const { card } = setup()
    card.open()
    card.render(model(LESSONS[2]))
    card.setNotice('No Pads track')
    expect(document.querySelector('.lesson-notice').textContent).toBe('No Pads track')
  })

  it('Stop calls onStop and returns to the picker', () => {
    const { card, onStop } = setup()
    card.open()
    card.render(model(LESSONS[2]))
    document.querySelector('[data-lesson-act="stop"]').click()
    expect(onStop).toHaveBeenCalled()
    expect(document.querySelector('[data-lesson]')).toBeTruthy()
  })
})
