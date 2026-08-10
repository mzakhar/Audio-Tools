// CLKDIV — counts incoming event-domain clock pulses.

export default {
  type: 'clkdiv',
  name: 'CLKDIV',
  group: 'seq',
  hp: 4,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'in', dir: 'in', kind: 'gate', label: 'IN' },
    { id: 'rst', dir: 'in', kind: 'gate', label: 'RST' },
    { id: 'div2', dir: 'out', kind: 'gate', label: '÷2' },
    { id: 'div3', dir: 'out', kind: 'gate', label: '÷3' },
    { id: 'div4', dir: 'out', kind: 'gate', label: '÷4' },
    { id: 'div8', dir: 'out', kind: 'gate', label: '÷8' },
    { id: 'div16', dir: 'out', kind: 'gate', label: '÷16' }
  ],
  params: [
    { key: 'resetMode', label: 'RESET', options: ['bar', 'manual'], def: 'bar' }
  ],

  create(ctx, { params = {}, emitEvent = () => {} } = {}) {
    const nodes = Object.fromEntries(['in', 'rst', 'div2', 'div3', 'div4', 'div8', 'div16'].map(id => [id, ctx.createGain()]))
    let count = 0
    const fire = (port, event) => emitEvent(port, { type: 'trig', time: event.time ?? ctx.currentTime })
    return {
      inputs: { in: [nodes.in], rst: [nodes.rst] },
      outputs: { div2: [nodes.div2], div3: [nodes.div3], div4: [nodes.div4], div8: [nodes.div8], div16: [nodes.div16] },
      setParam(key, value) { params[key] = value },
      onEvent(portId, event) {
        if (portId === 'rst' && event.type !== 'gate-off') { count = 0; return }
        if (portId !== 'in' || event.type === 'gate-off') return
        count += 1
        for (const division of [2, 3, 4, 8, 16]) if (count % division === 0) fire(`div${division}`, event)
      },
      dispose() { Object.values(nodes).forEach(node => node.disconnect()) }
    }
  }
}
