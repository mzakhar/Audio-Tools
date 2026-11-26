// Canvas colours come from the theme tokens in styles/tokens.css, not from JS.
// readThemeColors is pure over any { getPropertyValue } so tests pass a fake.
//
//   const c = readThemeColors(['canvas-bg', 'canvas-playhead'], themeStyle())
//   ctx.fillStyle = c['canvas-bg']
//
// Read once per paint (one getComputedStyle is cheap) or cache and refresh in
// onThemeChange. Either way a theme switch must repaint without a reload.

export function readThemeColors(names, style) {
  return Object.fromEntries(names.map(n => [n, style.getPropertyValue(`--${n}`).trim()]))
}

export const themeStyle = (el = document.documentElement) => getComputedStyle(el)

export function onThemeChange(fn) {
  window.addEventListener('themechange', fn)
  return () => window.removeEventListener('themechange', fn)
}
