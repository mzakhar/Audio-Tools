/**
 * recorder.js
 * Taps the compressor output via ScriptProcessorNode to capture stereo WAV.
 */
const Recorder = (() => {
  let scriptNode = null;
  let chunksL = [];
  let chunksR = [];
  let _ctx = null;
  let _compressor = null;

  function start(ctx, compressor) {
    if (scriptNode) return; // already recording

    _ctx = ctx;
    _compressor = compressor;
    chunksL = [];
    chunksR = [];

    // bufferSize 4096, 2 inputs, 2 outputs
    scriptNode = ctx.createScriptProcessor(4096, 2, 2);

    scriptNode.onaudioprocess = (e) => {
      // Copy so the buffer isn't reused
      chunksL.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      chunksR.push(new Float32Array(e.inputBuffer.getChannelData(1)));
      // Pass audio through
      e.outputBuffer.copyToChannel(e.inputBuffer.getChannelData(0), 0);
      e.outputBuffer.copyToChannel(e.inputBuffer.getChannelData(1), 1);
    };

    // Reroute: compressor → scriptNode → destination
    compressor.disconnect(ctx.destination);
    compressor.connect(scriptNode);
    scriptNode.connect(ctx.destination);
  }

  function stop(filename) {
    if (!scriptNode) return;

    // Restore original routing
    _compressor.disconnect(scriptNode);
    scriptNode.disconnect(_ctx.destination);
    _compressor.connect(_ctx.destination);
    scriptNode.onaudioprocess = null;
    scriptNode = null;

    const sampleRate = _ctx.sampleRate;
    const totalSamples = chunksL.reduce((n, c) => n + c.length, 0);

    // Interleave L/R into Int16
    const pcm = new Int16Array(totalSamples * 2);
    let offset = 0;
    for (let i = 0; i < chunksL.length; i++) {
      const L = chunksL[i];
      const R = chunksR[i];
      for (let j = 0; j < L.length; j++) {
        pcm[offset++] = Math.max(-1, Math.min(1, L[j])) * 0x7FFF;
        pcm[offset++] = Math.max(-1, Math.min(1, R[j])) * 0x7FFF;
      }
    }

    const wav = encodeWAV(pcm, sampleRate, 2);
    download(wav, filename || 'recording.wav');

    chunksL = [];
    chunksR = [];
    _ctx = null;
    _compressor = null;
  }

  function encodeWAV(pcm, sampleRate, numChannels) {
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataLen = pcm.length * bytesPerSample;
    const buf = new ArrayBuffer(44 + dataLen);
    const view = new DataView(buf);

    function writeStr(off, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataLen, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);          // chunk size
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);          // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataLen, true);

    const dest = new Int16Array(buf, 44);
    dest.set(pcm);

    return buf;
  }

  function download(arrayBuffer, filename) {
    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  return { start, stop };
})();
