// Must run before style.css so a saved light theme never flashes dark.
try {
  const theme = localStorage.getItem('synth_theme')
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
} catch {}
