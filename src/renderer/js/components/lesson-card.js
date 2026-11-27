// lesson-card.js — the non-modal Lessons card: a picker when no lesson runs,
// the active lesson's steps + live feedback otherwise. Thin DOM shell; the
// numbers come from lesson-session's view model.

import { openDialog } from '../ui/dialog.js'
import { LESSONS } from '../pads/lessons.js'

export const LESSON_DIALOG_ID = 'lesson-dialog'

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export function createLessonCard({ session, root = document, onStart = () => {}, onStop = () => {} }) {
  const body = root.getElementById('lesson-body')
  let model = null

  function picker() {
    const done = session.progress().done
    return `<ol class="lesson-list">${LESSONS.map(l =>
      `<li><button type="button" class="btn lesson-row" data-lesson="${l.id}">` +
      `<span class="lesson-n">${l.n}</span> <b>${esc(l.title)}</b>` +
      `${done[l.id] ? ' <span class="lesson-tick" aria-label="done">✓</span>' : ''}` +
      `<br><span class="lesson-concept">${esc(l.concept)}</span></button></li>`).join('')}</ol>`
  }

  function active(m) {
    const { lesson, result, score, hints } = m
    const next = m.done && session.nextAfter(lesson.id)
    const counts = score ? `<p class="lesson-counts">${['perfect', 'good', 'ok', 'miss'].map(k => `${k} ${score.counts[k]}`).join(' · ')}</p>` : ''
    let cal = ''
    if (lesson.pass.type === 'calibration') {
      const c = m.calibration?.ok ? m.calibration : m.progress.calibration
      cal = c?.offsetMs != null
        ? `<p class="lesson-cal">Offset ${c.offsetMs} ms, spread ${c.spreadMs} ms</p>`
        : `<p class="lesson-cal">Tap any pad on the click: ${m.taps}/16</p>`
    }
    return `<h3 class="lesson-title">${lesson.n}. ${esc(lesson.title)}</h3>` +
      `<p class="lesson-concept">${esc(lesson.concept)}</p>` +
      `<ol class="lesson-steps">${lesson.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` +
      `<p class="lesson-live" role="status">${esc(result.label)}${m.done ? ' ✓ done' : ''}</p>` +
      cal + counts +
      (hints.length ? `<ul class="lesson-hints">${hints.slice(0, 2).map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : '') +
      `<div class="dlg-row"><button type="button" class="btn" data-lesson-act="list">BACK TO LIST</button>` +
      `<button type="button" class="btn" data-lesson-act="stop">STOP</button>` +
      (next ? `<button type="button" class="btn" data-lesson-next="${next.id}">NEXT LESSON</button>` : '') + `</div>`
  }

  function render(m = model) {
    model = m
    if (!body) return
    body.innerHTML = m ? active(m) : picker()
  }

  body?.addEventListener('click', e => {
    const row = e.target.closest?.('[data-lesson]')
    const nextBtn = e.target.closest?.('[data-lesson-next]')
    const act = e.target.closest?.('[data-lesson-act]')?.dataset.lessonAct
    if (row) onStart(row.dataset.lesson)
    else if (nextBtn) onStart(nextBtn.dataset.lessonNext)
    else if (act === 'stop' || act === 'list') { onStop(); render(null) }
  })

  return {
    open() { render(model); openDialog(LESSON_DIALOG_ID, { modal: false }) },
    render
  }
}
