/**
 * recorder-processor.js
 * AudioWorkletProcessor that captures stereo audio data and posts it to the main thread.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._recording = false
    this.port.onmessage = (e) => {
      if (e.data.type === 'start') {
        this._recording = true
      } else if (e.data.type === 'stop') {
        this._recording = false
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]

    if (this._recording && input && input.length >= 2) {
      // Copy channel data so we own the buffers before transferring
      const channelL = input[0] ? new Float32Array(input[0]) : new Float32Array(128)
      const channelR = input[1] ? new Float32Array(input[1]) : new Float32Array(128)
      const channels = [channelL, channelR]
      this.port.postMessage({ type: 'data', channels }, [channelL.buffer, channelR.buffer])
    }

    // Pass audio through to outputs
    if (output) {
      for (let ch = 0; ch < output.length; ch++) {
        if (input && input[ch] && output[ch]) {
          output[ch].set(input[ch])
        }
      }
    }

    return true
  }
}

registerProcessor('recorder-processor', RecorderProcessor)
