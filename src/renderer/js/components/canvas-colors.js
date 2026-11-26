// Pure colour helpers for canvas drawing. Tokens arrive as strings from
// readThemeColors; canvases need translucent variants of them.

const rgba = (r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`

// Returns rgba() for `color` at `alpha` (0-1, multiplied into any alpha the
// colour already has). Accepts #rgb #rgba #rrggbb #rrggbbaa rgb() rgba();
// anything else is returned unchanged so a bad token degrades, not throws.
export function withAlpha(color, alpha) {
  const s = String(color ?? '').trim()
  let m = /^#([0-9a-f]{3,8})$/i.exec(s)
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    let h = m[1]
    if (h.length <= 4) h = [...h].map(c => c + c).join('')
    const n = i => parseInt(h.slice(i, i + 2), 16)
    const a = h.length === 8 ? n(6) / 255 : 1
    return rgba(n(0), n(2), n(4), a * alpha)
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(s)
  if (m) return rgba(+m[1], +m[2], +m[3], (m[4] === undefined ? 1 : +m[4]) * alpha)
  return s
}

// Every token the arrangement and piano roll canvases read.
export const ARRANGE_TOKENS = [
  'canvas-bg', 'canvas-ruler-bg', 'canvas-ruler-ink', 'canvas-grid-bar', 'canvas-grid-beat',
  'canvas-grid-sub', 'canvas-playhead', 'canvas-selection', 'canvas-clip', 'canvas-clip-ink',
  'canvas-note', 'canvas-note-selected', 'surface-inset', 'text-dim', 'font-ui', 'font-mono',
  ...Array.from({ length: 8 }, (_, i) => `track-${i + 1}`),
]

// Neutral black shade for name bands / label backing; not a theme colour.
export const shade = a => withAlpha('#000', a)

export const trackToken = i => `track-${(((i % 8) + 8) % 8) + 1}`

// "10px" + the computed family; fall back so ctx.font is never invalid.
export const canvasFont = (px, family, weight = '') =>
  `${weight ? weight + ' ' : ''}${px}px ${family || 'sans-serif'}`
