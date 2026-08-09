const COLORS = { audio: '#00e5ff', cv: '#ff00aa', gate: '#39ff14' }

export class RackCables {
  constructor(canvas, root) { this.canvas = canvas; this.root = root; this.ctx = canvas.getContext('2d'); this.cables = []; this.preview = null; this.resize = () => this.draw(); new ResizeObserver(this.resize).observe(root) }
  // The rails are CSS-scaled by --rack-zoom, so client rects come back in screen px.
  // Everything here works in unscaled layout px; divide the deltas by the live scale.
  zoom() { const w = this.root.offsetWidth; return w ? this.root.getBoundingClientRect().width / w : 1 }
  point(moduleId, port) { const jack = this.root.querySelector(`[data-module-id="${moduleId}"] [data-port="${port}"]`); if (!jack) return null; const z = this.zoom(), a = jack.getBoundingClientRect(), b = this.canvas.getBoundingClientRect(); return { x: (a.left - b.left + a.width / 2) / z, y: (a.top - b.top + a.height / 2) / z, kind: [...jack.classList].find(x => COLORS[x]) } }
  setCables(cables) { this.cables = cables; this.draw() }
  setPreview(from, to) { this.preview = from && to ? { from, to } : null; this.draw() }
  draw() {
    const w = this.root.offsetWidth, h = this.root.offsetHeight, dpr = devicePixelRatio || 1
    this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.ctx.clearRect(0, 0, w, h)
    for (const cable of this.cables) this.line(this.point(cable.from.moduleId, cable.from.port), this.point(cable.to.moduleId, cable.to.port), cable.color)
    if (this.preview) this.line(this.preview.from, this.preview.to, '#eee')
  }
  line(a, b, color) { if (!a || !b) return; const sag = Math.max(28, Math.abs(b.y - a.y) + 20); this.ctx.strokeStyle = color || COLORS[a.kind] || '#aaa'; this.ctx.lineWidth = 3; this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.bezierCurveTo(a.x, a.y + sag, b.x, b.y + sag, b.x, b.y); this.ctx.stroke() }
  // Nearest point on the drawn curve, not a bounding box: adjacent modules give a box
  // barely taller than a jack, while the cable itself sags well below both endpoints.
  hitTest(x, y, tolerance = 7) {
    let hit = null, best = tolerance
    for (const cable of this.cables) {
      const a = this.point(cable.from.moduleId, cable.from.port), b = this.point(cable.to.moduleId, cable.to.port)
      if (!a || !b) continue
      const sag = Math.max(28, Math.abs(b.y - a.y) + 20)
      for (let i = 0; i <= 32; i++) {
        const t = i / 32, u = 1 - t
        const px = u * u * u * a.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t * t * t * b.x
        const py = u * u * u * a.y + 3 * u * u * t * (a.y + sag) + 3 * u * t * t * (b.y + sag) + t * t * t * b.y
        const distance = Math.hypot(px - x, py - y)
        if (distance < best) { best = distance; hit = cable }
      }
    }
    return hit
  }
}
