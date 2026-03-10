import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',      // provides DOM APIs (needed for Keyboard, Sequencer playhead)
    environmentOptions: {
      jsdom: {
        url: 'http://localhost'
      }
    },
    include: ['tests/**/*.test.js'],
    coverage: {
      include: [
        'src/renderer/js/sequencer.js',
        'src/renderer/js/store/ProjectStore.js',
        'src/renderer/js/io/FileAdapter.js',
      ],
      thresholds: {
        lines: 80
      }
    }
  },
  resolve: {
    alias: {
      '@store': '/src/renderer/js/store',
      '@io': '/src/renderer/js/io',
      '@js': '/src/renderer/js'
    }
  }
})
