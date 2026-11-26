import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const STYLES = join(__dirname, '../src/renderer/styles')
const JS = join(__dirname, '../src/renderer/js')
const tokensCss = readFileSync(join(STYLES, 'tokens.css'), 'utf8')

// Pure: { blockSelector: { '--name': 'value' } } for each top-level :root block.
export function parseThemes(css) {
  const themes = {}
  for (const m of css.matchAll(/(:root(?:\[data-theme="(\w+)"\])?)\s*\{([^}]*)\}/g)) {
    const vars = {}
    for (const d of m[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim()
    themes[m[2] ?? 'light'] = vars
  }
  return themes
}

// Pure WCAG 2.x contrast for #rgb / #rrggbb (alpha ignored: opaque tokens only).
export function contrast(a, b) {
  const lum = hex => {
    let h = hex.replace('#', '')
    if (h.length === 3) h = [...h].map(c => c + c).join('')
    const [r, g, bl] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const themes = parseThemes(tokensCss)
const base = themes.light
const resolve = (theme, name) => themes[theme][name] ?? base[name]
const isColour = v => /^#[0-9a-f]{3,8}$/i.test(v)

// [foreground, background, minimum ratio]
const PAIRS = [
  ['--text', '--bg', 4.5], ['--text', '--bg2', 4.5], ['--text', '--bg3', 4.5],
  ['--text', '--surface-control', 4.5], ['--text', '--surface-panel', 4.5],
  ['--text-dim', '--bg', 4.5], ['--text-dim', '--bg2', 4.5],
  ['--text-bright', '--bg2', 4.5],
  ['--accent', '--bg2', 4.5], ['--accent', '--bg', 3],
  ['--text-rack-label', '--surface-panel', 4.5], ['--text-rack-muted', '--surface-panel', 4.5],
  ['--danger-on', '--danger', 4.5], ['--danger', '--bg2', 3],
  ['--state-record', '--bg2', 3],
  ['--focus', '--bg', 3], ['--focus', '--bg2', 3],
  ['--border-strong', '--bg2', 3],
  ['--lcd-ink', '--lcd-bg', 4.5], ['--lcd-dim', '--lcd-bg', 4.5], ['--lcd-accent', '--lcd-bg', 4.5],
  ['--canvas-ruler-ink', '--canvas-ruler-bg', 4.5],
  ['--canvas-clip-ink', '--canvas-clip', 4.5],
  ['--canvas-playhead', '--canvas-bg', 3],
  ['--canvas-grid-bar', '--canvas-bg', 1.5],
]

describe('theme tokens', () => {
  it('has the three themes', () => {
    expect(Object.keys(themes).sort()).toEqual(['dark', 'light', 'rainbow'])
  })

  for (const theme of ['dark', 'rainbow']) {
    it(`${theme} defines every colour token the default defines`, () => {
      const missing = Object.keys(base).filter(k => isColour(base[k]) && !(k in themes[theme]))
      expect(missing).toEqual([])
    })
  }

  for (const theme of ['light', 'dark', 'rainbow']) {
    it(`${theme} meets contrast minimums`, () => {
      const failures = PAIRS
        .map(([fg, bg, min]) => [fg, bg, min, contrast(resolve(theme, fg), resolve(theme, bg))])
        .filter(([, , min, ratio]) => ratio < min)
        .map(([fg, bg, min, ratio]) => `${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`)
      expect(failures).toEqual([])
    })
  }

  it('contrast() matches known WCAG values', () => {
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 1)
    expect(contrast('#777', '#fff')).toBeCloseTo(4.48, 1)
  })
})

// Colour literals outside tokens.css. Ratchet: counts may only go down; phase 2
// of specs/retro-instrument-ui.md drives every entry to 0. Lower the number when
// you remove literals; never raise it — add a token instead.
const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(/g
const ALLOW = {
  'styles/base.css': 0, 'styles/rack.css': 44, 'styles/synth.css': 12, 'styles/tr909.css': 20,
  'styles/sequencer.css': 17, 'styles/util.css': 0, 'styles/shell.css': 1, 'styles/arrange.css': 8,
  'styles/dialogs.css': 7, 'styles/piano-roll.css': 0, 'styles/assistant.css': 0,
  'js/components/arrangement-view.js': 20, 'js/components/piano-roll.js': 25,
  'js/components/rack-cables.js': 5, 'js/rack/modules/meter.js': 8, 'js/rack/modules/scope.js': 6,
}

describe('no colour literals outside tokens', () => {
  const count = path => (readFileSync(join(__dirname, '../src/renderer', path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').match(LITERAL) ?? []).length
  it('covers every stylesheet', () => {
    const sheets = readdirSync(STYLES).filter(f => f !== 'tokens.css').map(f => `styles/${f}`)
    expect(sheets.filter(s => !(s in ALLOW))).toEqual([])
    expect(JS).toBeTruthy()
  })
  for (const [path, max] of Object.entries(ALLOW)) {
    it(`${path} has at most ${max}`, () => expect(count(path)).toBeLessThanOrEqual(max))
  }
})
