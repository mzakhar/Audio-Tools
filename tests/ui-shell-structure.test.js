/**
 * Structural guard for the shell. No test covered the app chrome before the
 * rewrite, which is exactly why a stray bar could come back unnoticed.
 * Reads the real index.html — no boot, no audio, no DOM APIs beyond parsing.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// jsdom rewrites import.meta.url to an http URL, so resolve from the repo root.
const html = readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8')
const doc = new DOMParser().parseFromString(html, 'text/html')

describe('ui shell structure', () => {
  it('has exactly one command bar above the view body', () => {
    expect(doc.querySelectorAll('#command-bar')).toHaveLength(1)
    expect(doc.querySelector('#command-bar').getAttribute('role')).toBe('toolbar')
  })

  it('keeps the bars and rails that were removed removed', () => {
    for (const id of ['global-header', 'project-bar', 'arrange-toolbar', 'instrument-inspector', 'palette-tabs', 'header-view-slot', 'app-title', 'piano-roll-drawer']) {
      expect(doc.getElementById(id), `#${id} is back`).toBeNull()
    }
  })

  it('puts occasional controls in native dialogs', () => {
    for (const id of ['piano-roll-dialog', 'midi-setup-dialog']) {
      const el = doc.getElementById(id)
      expect(el, `#${id} missing`).not.toBeNull()
      expect(el.tagName.toLowerCase()).toBe('dialog')
    }
    expect(doc.querySelector('#app-menu[popover]')).not.toBeNull()
  })

  it('switches four views from the sidebar, driven by data-view', () => {
    const tools = [...doc.querySelectorAll('.tool-btn')].map(btn => btn.dataset.tool)
    expect(tools).toEqual(['synth', 'arrange', 'rack', 'tr909'])
    expect(doc.getElementById('main').dataset.view).toBe('synth')
  })

  it('never inlines display on the views CSS owns', () => {
    for (const id of ['app', 'arrange-view']) {
      expect(doc.getElementById(id).getAttribute('style') || '').not.toContain('display')
    }
  })
})
