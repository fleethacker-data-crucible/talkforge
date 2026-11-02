/* TalkForge STT AudioWorklet: hands microphone frames to the STT page in batches.
   Runs only while the microphone is open. Adapted from PacketRat Web/voice-worklet.js,
   processor renamed so the two tools do not collide if both pages are open. */
class TalkForgeCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('talkforge-capture', TalkForgeCapture);
