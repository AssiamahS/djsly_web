/* djsly deck engine — AudioWorkletProcessor
 * One instance per deck. Holds the decoded track (or up to 4 stems) in memory and renders it at a
 * variable rate (tempo, pitch-bend nudges, scratch, reverse, brake/backspin), with sample-accurate
 * cue/loop handling and an OLA keylock stretcher. Output k = stem k (single track → output 0 only).
 * Messages in:  load, play, pause, seek, tempo, bend, nudge, reverse, scratch, jogTick, loop, keylock, brake, backspin
 * Messages out: pos (every ~1/40s), ended, fxdone
 */
class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.st = []; this.len = 0;   // stems: [{L,R}]
    this.pos = 0; this.playing = false;
    this.tempo = 1; this.bend = 0; this.reverse = false;
    this.scratching = false; this.scratchRate = 0; this.ticks = 0; this.ticksPerSec = 400; this.scratchIdle = 0;
    this.fx = null;
    this.loopIn = -1; this.loopOut = -1; this.loopOn = false;
    this.keylock = false; this.grain = 2048; this.overlap = 512; this.gA = { read: 0, age: 0 }; this.gB = null;
    this.reportEvery = Math.round(sampleRate / 40); this.sinceReport = 0; this.lastRate = 0;
    this.port.onmessage = e => this.onMsg(e.data);
  }
  onMsg(m) {
    switch (m.type) {
      case 'load':
        this.st = m.stems.map(s => ({ L: s.L, R: s.R || s.L })); this.len = this.st.length ? this.st[0].L.length : 0;
        this.pos = m.pos || 0; this.playing = false; this.loopOn = false; this.loopIn = this.loopOut = -1; this.fx = null; this.resetGrains(); this.report(); break;
      case 'play': this.playing = true; this.fx = null; break;
      case 'pause': this.playing = false; this.fx = null; break;
      case 'seek': this.pos = Math.max(0, Math.min(this.len - 1, m.pos)); this.resetGrains(); this.report(); break;
      case 'tempo': this.tempo = m.value; break;
      case 'bend': this.bend = m.value; break;
      case 'nudge': this.bend += m.value; break;
      case 'reverse': this.reverse = !!m.value; break;
      case 'scratch': this.scratching = !!m.value; if (this.scratching) { this.scratchRate = 0; this.ticks = 0; this.scratchIdle = 0; } break;
      case 'jogTick': this.ticks += m.delta; this.scratchIdle = 0; break;
      case 'loop': this.loopIn = m.in ?? this.loopIn; this.loopOut = m.out ?? this.loopOut; if (m.on != null) this.loopOn = m.on; break;
      case 'keylock': this.keylock = !!m.value; this.resetGrains(); break;
      case 'brake': this.fx = { type: 'brake', t: 0, dur: (m.sec || 1) * sampleRate, from: this.curRate() }; break;
      case 'backspin': this.fx = { type: 'backspin', t: 0, dur: (m.sec || 1.2) * sampleRate }; break;
    }
  }
  resetGrains() { this.gA = { read: this.pos, age: 0 }; this.gB = null; }
  curRate() { return (this.reverse ? -1 : 1) * this.tempo + this.bend; }
  report() { this.port.postMessage({ type: 'pos', pos: this.pos, playing: this.playing, rate: this.lastRate }); }
  read(buf, p) { if (p < 0 || p >= this.len - 1) return 0; const i = p | 0, f = p - i; return buf[i] + (buf[i + 1] - buf[i]) * f; }
  process(_inputs, outputs) {
    const N = outputs[0][0].length;
    if (!this.st.length) return true;
    let rate;
    if (this.scratching) {
      const blockSec = N / sampleRate; const target = this.ticks / blockSec / this.ticksPerSec; this.ticks = 0; this.scratchIdle += blockSec;
      this.scratchRate = this.scratchRate * 0.65 + target * 0.35;
      if (this.scratchIdle > 0.08 && Math.abs(target) < 1e-6) this.scratchRate *= 0.6;
      rate = this.scratchRate;
    } else if (this.fx) {
      const k = Math.min(1, this.fx.t / this.fx.dur); this.fx.t += N;
      rate = this.fx.type === 'brake' ? this.fx.from * (1 - k) ** 2 : -6 * (1 - k) ** 1.5;
      if (k >= 1) { this.fx = null; this.playing = false; rate = 0; this.port.postMessage({ type: 'fxdone' }); }
    } else if (this.playing) {
      rate = this.curRate(); this.bend *= 0.94; if (Math.abs(this.bend) < 1e-4) this.bend = 0;
    } else rate = 0;
    this.lastRate = rate;
    if (rate === 0) { this.tick(N); return true; }
    const ns = this.st.length;
    const useKL = this.keylock && !this.scratching && !this.fx && rate > 0.5 && rate < 2 && Math.abs(rate - 1) > 0.002;
    if (!useKL) {
      for (let n = 0; n < N; n++) {
        for (let k = 0; k < ns; k++) { const o = outputs[k]; const s = this.st[k]; o[0][n] = this.read(s.L, this.pos); (o[1] || o[0])[n] = this.read(s.R, this.pos); }
        this.pos += rate; this.wrap();
      }
    } else {
      const G = this.grain, O = this.overlap;
      for (let n = 0; n < N; n++) {
        const a = this.gA, b = this.gB, w = b ? Math.min(1, b.age / O) : 0;
        for (let k = 0; k < ns; k++) {
          const o = outputs[k], s = this.st[k];
          let l = this.read(s.L, a.read), r = this.read(s.R, a.read);
          if (b) { l = l * (1 - w) + this.read(s.L, b.read) * w; r = r * (1 - w) + this.read(s.R, b.read) * w; }
          o[0][n] = l; (o[1] || o[0])[n] = r;
        }
        a.read += 1; a.age += 1;
        if (b) { b.read += 1; b.age += 1; if (b.age >= O) { this.gA = b; this.gB = null; } }
        if (!this.gB && this.gA.age >= G - O) this.gB = { read: this.pos, age: 0 };
        this.pos += rate; this.wrap();
      }
    }
    this.tick(N);
    return true;
  }
  wrap() {
    if (this.loopOn && this.loopOut > this.loopIn) {
      if (this.pos >= this.loopOut) { this.pos -= (this.loopOut - this.loopIn); this.resetGrains(); }
      else if (this.pos < this.loopIn && this.lastRate < 0) { this.pos += (this.loopOut - this.loopIn); this.resetGrains(); }
    }
    if (this.pos >= this.len - 1) { this.pos = this.len - 1; this.playing = false; this.port.postMessage({ type: 'ended' }); }
    if (this.pos < 0) { this.pos = 0; if (this.lastRate < 0 && !this.scratching) this.playing = false; }
  }
  tick(N) { this.sinceReport += N; if (this.sinceReport >= this.reportEvery) { this.sinceReport = 0; this.report(); } }
}
registerProcessor('deck-processor', DeckProcessor);
