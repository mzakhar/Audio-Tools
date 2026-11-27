// Pass-through tap: per-quantum RMS crossing detector (latency), process() gap stalls, wasm compile probe (CSP in worklet scope).
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false; this.thr = 0.005; this.pre = 0; this.last = Date.now(); this.stalls = 0; this.maxGap = 0; this.calls = 0; this.lastRms = 0;
    this.port.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'arm') { this.armed = true; this.id = m.id; this.thr = m.thr || 0.005; this.pre = this.lastRms; }
      else if (m.type === 'stats') this.port.postMessage({ type: 'stats', stalls: this.stalls, maxGap: this.maxGap, calls: this.calls });
      else if (m.type === 'probe') {
        const r = {};
        try { await WebAssembly.compile(m.bytes); r.compile = 'ok'; } catch (err) { r.compile = String(err); }
        try { new WebAssembly.Module(m.tiny); r.syncTiny = 'ok'; } catch (err) { r.syncTiny = String(err); }
        this.port.postMessage({ type: 'probe', r });
      }
    };
  }
  process(inputs, outputs) {
    const a = inputs[0], b = outputs[0];
    let s = 0, n = 0;
    for (let c = 0; c < b.length; c++) if (a[c]) { b[c].set(a[c]); for (let i = 0; i < a[c].length; i++) { s += a[c][i] * a[c][i]; n++; } }
    const rms = n ? Math.sqrt(s / n) : 0;
    this.lastRms = rms;
    const t = Date.now(), gap = t - this.last; this.last = t;
    if (this.calls++ > 300) { if (gap > 25) this.stalls++; if (gap > this.maxGap) this.maxGap = gap; }
    if (this.armed && rms > this.thr) { this.armed = false; this.port.postMessage({ type: 'cross', id: this.id, t: currentTime, rms, pre: this.pre }); }
    return true;
  }
}
registerProcessor('fm1tap', Tap);
