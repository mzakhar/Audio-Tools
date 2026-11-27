// lesson-card.js — the non-modal Lessons card: a picker when no lesson runs,
// the active lesson's steps + live feedback otherwise. Thin DOM shell; the
// numbers come from lesson-session's view model.
// The static shell renders once per (lesson, done, view); the 10 Hz updates only
// touch text nodes, so clicks, focus and the live region survive.

import { openDialog, closeDialog } from '../ui/dialog.js'
import { LESSONS } from '../pads/lessons.js'

export const LESSON_DIALOG_ID = 'lesson-dialog'

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const COUNT_KEYS = ['perfect', 'good', 'ok', 'miss']

export function createLessonCard({ session, root = document, onStart = () => {}, onStop = () => {} }) {
  const body = root.getElementById('lesson-body')
  const dialog = root.getElementById(LESSON_DIALOG_ID)
  let model = null
  let shellKey = null
  let notice = ''

  function picker() {
    const done = session.progress().done
    return `<ol class="lesson-list">${LESSONS.map(l =>
      `<li><button type="button" class="btn lesson-row" data-lesson="${l.id}">` +
      `<span class="lesson-n">${l.n}</span> <b>${esc(l.title)}</b>` +
      `${done[l.id] ? ' <span class="lesson-tick" aria-label="done">✓</span>' : ''}` +
      `<br><span class="lesson-concept micro-label">${esc(l.concept)}</span></button></li>`).join('')}</ol>`
  }

  function shell(m) {
    const { lesson } = m
    const next = m.done && session.nextAfter(lesson.id)
    return `<h3 class="lesson-title">${lesson.n}. ${esc(lesson.title)}</h3>` +
      `<p class="lesson-concept micro-label">${esc(lesson.concept)}</p>` +
      `<ol class="lesson-steps">${lesson.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` +
      `<p class="lesson-notice" hidden></p>` +
      `<p class="lesson-live lcd" role="status"></p>` +
      (lesson.pass.type === 'calibration' ? `<p class="lesson-cal lcd"></p>` : '') +
      (lesson.targets.length ? `<p class="lesson-counts lcd"></p>` : '') +
      `<ul class="lesson-hints" hidden></ul>` +
      `<div class="dlg-row"><button type="button" class="btn" data-lesson-act="list">BACK TO LIST</button>` +
      `<button type="button" class="btn" data-lesson-act="stop">STOP</button>` +
      (next ? `<button type="button" class="btn" data-lesson-next="${next.id}">NEXT LESSON</button>` : '') + `</div>`
  }

  const setText = (sel, text) => {
    const el = body.querySelector(sel)
    if (el && el.textContent !== text) el.textContent = text
  }

  function live(m) {
    setText('.lesson-live', m.result.label + (m.done ? ' ✓ done' : ''))
    const n = body.querySelector('.lesson-notice')
    if (n) { n.textContent = notice; n.hidden = !notice }
    if (m.score) setText('.lesson-counts', COUNT_KEYS.map(k => `${k} ${m.score.counts[k]}`).join(' · '))
    if (m.lesson.pass.type === 'calibration') {
      const c = m.calibration?.ok ? m.calibration : m.progress.calibration
      setText('.lesson-cal', c?.offsetMs != null ? `Offset ${c.offsetMs} ms, spread ${c.spreadMs} ms` : `Tap any pad on the click: ${m.taps}/16`)
    }
    const ul = body.querySelector('.lesson-hints')
    const hints = m.hints.slice(0, 2)
    if (ul && ul.dataset.key !== hints.join('\n')) {
      ul.dataset.key = hints.join('\n')
      ul.replaceChildren(...hints.map(h => { const li = root.createElement('li'); li.textContent = h; return li }))
      ul.hidden = !hints.length
    }
  }

  function render(m = model) {
    model = m
    if (!body || (dialog && !dialog.open)) return
    const key = m ? `${m.lesson.id}|${m.done}|${m.completed}` : `picker|${Object.keys(session.progress().done).sort().join(',')}`
    if (key !== shellKey) {
      shellKey = key
      body.innerHTML = m ? shell(m) : picker()
    }
    if (m) live(m)
  }

  body?.addEventListener('click', e => {
    const row = e.target.closest?.('[data-lesson]')
    const nextBtn = e.target.closest?.('[data-lesson-next]')
    const act = e.target.closest?.('[data-lesson-act]')?.dataset.lessonAct
    if (row) onStart(row.dataset.lesson)
    else if (nextBtn) onStart(nextBtn.dataset.lessonNext)
    else if (act === 'stop' || act === 'list') { onStop(); render(null) }
  })
  // Non-modal: Esc is not native. Closing the card ends the lesson.
  dialog?.addEventListener('keydown', e => { if (e.key === 'Escape') closeDialog(LESSON_DIALOG_ID) })
  dialog?.addEventListener('close', () => { notice = ''; onStop() })

  return {
    open() {
      openDialog(LESSON_DIALOG_ID, { modal: false })
      shellKey = null
      render(model)
      // show() focuses the ✕; Space on a focused button would close the card mid-play.
      if (body) { body.tabIndex = -1; body.focus({ preventScroll: true }) }
    },
    /** Short message in the active lesson card (e.g. nothing to play). */
    setNotice(text) { notice = text || ''; if (model) render(model) },
    render
  }
}
