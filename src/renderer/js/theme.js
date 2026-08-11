export const THEME_KEY = 'synth_theme'
export const THEMES = new Set(['dark', 'light', 'rainbow'])

export function applyTheme(theme, root = document.documentElement) {
  const next = THEMES.has(theme) ? theme : 'dark'
  root.dataset.theme = next
  localStorage.setItem(THEME_KEY, next)
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }))
  return next
}

export function savedTheme() {
  return THEMES.has(localStorage.getItem(THEME_KEY)) ? localStorage.getItem(THEME_KEY) : 'dark'
}
