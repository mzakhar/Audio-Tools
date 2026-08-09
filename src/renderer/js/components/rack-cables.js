const COLORS = { audio: '#00e5ff', cv: '#ff00aa', gate: '#39ff14' }

export class RackCables {
  constructor(canvas, root) { this.canvas = canvas; this.root = root; this.ctx = canvas.getContext('2d'); this.cables = []; this.preview = null; this.resize = () => this.draw(); new ResizeObserver(this.resize).observe(root) }
  point(moduleId, port) { const jack = this.root.querySelector(`[data-module-id="${moduleId}"] [data-port="${port}"]`); if (!jack) return null; const a = jack.getBoundingClientRect(), b = this.canvas.getBoundingClientRect(); return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2, kind: [...jack.classList].find(x => COLORS[x]) } }
  setCables(cables) { this.cables = cables; this.draw() }
  setPreview(from, to) { this.preview = from && to ? { from, to } : null; this.draw() }
  draw() {
    const r = this.root.getBoundingClientRect(), dpr = devicePixelRatio || 1
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr; this.canvas.style.width = `${r.width}px`; this.canvas.style.height = `${r.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.ctx.clearRect(0, 0, r.width, r.height)
    for (const cable of this.cables) this.line(this.point(cable.from.moduleId, cable.from.port), this.point(cable.to.moduleId, cable.to.port), cable.color)
    if (this.preview) this.line(this.preview.from, this.preview.to, '#eee')
  }
  line(a, b, color) { if (!a || !b) return; const sag = Math.max(28, Math.abs(b.y - a.y) + 20); this.ctx.strokeStyle = color || COLORS[a.kind] || '#aaa'; this.ctx.lineWidth = 3; this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.bezierCurveTo(a.x, a.y + sag, b.x, b.y + sag, b.x, b.y); this.ctx.stroke() }
  hitTest(x, y) { return this.cables.find(c => { const a = this.point(c.from.moduleId, c.from.port), b = this.point(c.to.moduleId, c.to.port); return a && b && x >= Math.min(a.x,b.x)-8 && x <= Math.max(a.x,b.x)+8 && y >= Math.min(a.y,b.y)-8 && y <= Math.max(a.y,b.y)+8 }) }
}
