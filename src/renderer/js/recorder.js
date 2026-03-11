/**
 * recorder.js
 * Taps the compressor output via AudioWorkletNode to capture stereo WAV.
 */
import { encodeWAV } from './utils/wav-encoder.js'

let workletNode = null
let chunksL = []
let chunksR = []
let _ctx = null
let _compressor = null

function start(ctx, compressor) {
  if (workletNode) return // already recording

  _ctx = ctx
  _compressor = compressor
  chunksL = []
  chunksR = []

  // The worklet module was pre-loaded by AudioEngine.init()
  workletNode = new AudioWorkletNode(ctx, 'recorder-processor')

  workletNode.port.onmessage = (e) => {
    if (e.data.type === 'data') {
      const { channels } = e.data
      chunksL.push(channels[0])
      chunksR.push(channels[1])
    }
  }

  // Post start message to worklet
  workletNode.port.postMessage({ type: 'start' })

  // Reroute: compressor → workletNode → destination
  compressor.disconnect(ctx.destination)
  compressor.connect(workletNode)
  workletNode.connect(ctx.destination)
}

function stop(filename) {
  if (!workletNode) return

  // Tell worklet to stop recording
  workletNode.port.postMessage({ type: 'stop' })

  // Restore original routing
  _compressor.disconnect(workletNode)
  workletNode.disconnect(_ctx.destination)
  _compressor.connect(_ctx.destination)
  workletNode.port.onmessage = null
  workletNode = null

  const sampleRate = _ctx.sampleRate
  const totalSamples = chunksL.reduce((n, c) => n + c.length, 0)

  // Interleave L/R into Int16
  const pcm = new Int16Array(totalSamples * 2)
  let offset = 0
  for (let i = 0; i < chunksL.length; i++) {
    const L = chunksL[i]
    const R = chunksR[i]
    for (let j = 0; j < L.length; j++) {
      pcm[offset++] = Math.max(-1, Math.min(1, L[j])) * 0x7FFF
      pcm[offset++] = Math.max(-1, Math.min(1, R[j])) * 0x7FFF
    }
  }

  const wav = encodeWAV(pcm, sampleRate, 2)
  download(wav, filename || 'recording.wav')

  chunksL = []
  chunksR = []
  _ctx = null
  _compressor = null
}

function download(arrayBuffer, filename) {
  const blob = new Blob([arrayBuffer], { type: 'audio/wav' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

const Recorder = { start, stop }
export default Recorder
