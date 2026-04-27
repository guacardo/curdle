// Audio worklet runs in a separate global scope. Plain JS to avoid TS-in-worklet ceremony.
// Receives s16le interleaved stereo PCM via port.postMessage(ArrayBuffer)
// and pushes deinterleaved Float32 samples to the Web Audio graph.

const RING_SECONDS = 1;

class CurdlePCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const ringSize = sampleRate * 2 * RING_SECONDS;
    this.ring = new Float32Array(ringSize);
    this.size = ringSize;
    this.writeIdx = 0;
    this.readIdx = 0;
    this.filled = 0;
    this.port.onmessage = (e) => this._enqueue(e.data);
  }

  _enqueue(buf) {
    const view = new DataView(buf);
    const samples = buf.byteLength >> 1; // 2 bytes per sample
    for (let i = 0; i < samples; i++) {
      this.ring[this.writeIdx] = view.getInt16(i * 2, true) / 32768;
      this.writeIdx = (this.writeIdx + 1) % this.size;
      if (this.filled < this.size) {
        this.filled++;
      } else {
        this.readIdx = (this.readIdx + 1) % this.size;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];
    const n = left.length; // 128 frames per quantum
    const need = n * 2;

    if (this.filled < need) {
      left.fill(0);
      right.fill(0);
      return true;
    }

    for (let i = 0; i < n; i++) {
      left[i] = this.ring[this.readIdx];
      this.readIdx = (this.readIdx + 1) % this.size;
      right[i] = this.ring[this.readIdx];
      this.readIdx = (this.readIdx + 1) % this.size;
    }
    this.filled -= need;
    return true;
  }
}

registerProcessor("curdle-pcm", CurdlePCMProcessor);
