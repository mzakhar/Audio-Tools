// A fake fm1-web exports object: records MIDI bytes / keys with the render index they arrived
// before, renders constant L=0.5 / R=-0.5 so audio is non-zero. silentFor: the first N renders
// produce nothing (have 0, zero output), as a booting firmware does. budgets: each render budget.
export function fakeFm1Exports({ halted = () => 0, silentFor = 0, ms = () => 0 } = {}) {
  const buffer = new ArrayBuffer(1 << 18)
  const x = {
    memory: { buffer },
    rendered: [], budgets: [], midi: [], keys: [], encs: [], pots: [], lcdRev: 1,
    fm1_jit() {}, fm1_flash_part() {}, fm1_ahead() {},
    fm1_alloc: () => 200000,
    fm1_boot_fwsc: () => 0,
    fm1_out_l: () => 0,
    fm1_out_r: () => 4096,
    fm1_leds: () => 8192,
    fm1_lcd: () => 16384,
    fm1_lcd_revision: () => x.lcdRev,
    fm1_render(n, budget) {
      const l = new Float32Array(buffer, 0, n), r = new Float32Array(buffer, 4096, n)
      const silent = x.rendered.length < silentFor
      for (let i = 0; i < n; i++) { l[i] = silent ? 0 : 0.5; r[i] = silent ? 0 : -0.5 }
      x.rendered.push(n)
      x.budgets.push(budget)
      return silent ? 0 : n
    },
    fm1_midi(b) { x.midi.push({ b, at: x.rendered.length }) },
    fm1_key(id, down) { x.keys.push({ id, down, at: x.rendered.length }) },
    fm1_enc(id, clicks) { x.encs.push([id, clicks]) },
    fm1_pot(v) { x.pots.push(v) },
    fm1_halted: halted,
    fm1_starved: () => 0,
    fm1_ms: ms,
  }
  return x
}
