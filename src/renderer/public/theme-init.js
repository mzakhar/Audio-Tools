// Must run before style.css so a saved theme never flashes the wrong one.
try {
  const theme = localStorage.getItem('synth_theme')
  document.documentElement.dataset.theme = ['dark', 'rainbow'].includes(theme) ? theme : 'light'
} catch {}
