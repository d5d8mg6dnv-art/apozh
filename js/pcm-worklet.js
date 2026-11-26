/**
 * AudioWorklet: отдаёт сырые PCM-семплы в основной поток.
 * Используется вместо MediaRecorder — нам нужен именно несжатый звук для реверса.
 */
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._len = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];

    // копим по ~2048 семплов, чтобы не дёргать поток на каждый кадр
    const copy = new Float32Array(ch.length);
    copy.set(ch);
    this._buf.push(copy);
    this._len += copy.length;

    if (this._len >= 2048) {
      const merged = new Float32Array(this._len);
      let off = 0;
      for (const b of this._buf) { merged.set(b, off); off += b.length; }
      this._buf = [];
      this._len = 0;

      let sum = 0;
      for (let i = 0; i < merged.length; i++) sum += merged[i] * merged[i];
      const rms = Math.sqrt(sum / merged.length);

      this.port.postMessage({ samples: merged, rms }, [merged.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
