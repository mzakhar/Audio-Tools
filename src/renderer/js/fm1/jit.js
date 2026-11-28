// The host side of the FM-1 emulator's WebAssembly JIT, ported from fm1-emu web/jit.js
// (commit 69cb1ef, MIT, Copyright (c) 2026 Joakim Eriksson; see public/fm1/NOTICE).
// A hot block arrives as a small module, compiled here synchronously; its `run` goes into the
// emulator's exported function table and Rust calls it by that index. Returns the index, or 0
// when it cannot (the block stays interpreted). public/worklets/fm1-worklet.js carries a copy:
// an AudioWorklet does not import modules everywhere.
const now = globalThis.performance?.now ? () => performance.now() : () => Date.now()

export function jitImports(exports, stats) {
  let next
  return {
    fm1_jit_compile(ptr, len, hRead, hWrite, hOp) {
      const start = now()
      try {
        const x = exports()
        const bytes = new Uint8Array(x.memory.buffer, ptr, len).slice()
        const table = x.__indirect_function_table
        // helpers as function imports, not the table: importing the table copies it (40% slower)
        const env = { memory: x.memory, h_read: table.get(hRead), h_write: table.get(hWrite), h_op: table.get(hOp) }
        const run = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env }).exports.run
        if (next === undefined || next >= table.length) { next = table.length; table.grow(256) }
        const slot = next++
        table.set(slot, run)
        if (stats) { stats.regions++; stats.bytes += len }
        return slot
      } catch (e) {
        if (stats) { stats.failed++; stats.error = String(e) }
        return 0
      } finally {
        if (stats) {
          const elapsed = now() - start
          stats.compileMs += elapsed
          stats.compileMaxMs = Math.max(stats.compileMaxMs, elapsed)
        }
      }
    },
  }
}

export const newJitStats = () => ({ regions: 0, failed: 0, bytes: 0, compileMs: 0, compileMaxMs: 0, error: '' })
