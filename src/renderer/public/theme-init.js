// Must run before style.css so a saved theme never flashes dark.
try {
  const theme = localStorage.getItem('synth_theme')
  document.documentElement.dataset.theme = ['light', 'rainbow'].includes(theme) ? theme : 'dark'
} catch {}
