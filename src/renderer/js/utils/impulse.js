export function buildImpulseResponse(ctx, duration = 2.5, decay = 2) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration)), buf = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) { const data = buf.getChannelData(ch); for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay) }
  return buf
}
