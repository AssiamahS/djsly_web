/* djsly deck engine — AudioWorkletProcessor
 * One instance per deck. Holds the decoded track in memory and renders it at a
 * variable rate (tempo, pitch-bend nudges, scratch, reverse, brake/backspin),
 * with sample-accurate cue/loop handling and an OLA keylock stretcher.
 * Messages in:  load, play, pause, seek, rate, bend, scratch, jogTick, loop,
 *               keylock, brake, backspin, cuePreview
 * Messages out: pos (every ~1/40s), ended
 */
class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null; this.R = null; this.len = 0;
    this.pos = 0;            // playhead in frames (float)
    this.playing = false;
    this.tempo = 1;          // from tempo fader
    this.bend = 0;           // transient nudge (decays)
    this.reverse = false;
    // scratch
    this.scratching = false;
    this.scratchRate = 0;    // smoothed platter velocity in x-realtime
    this.ticks = 0;          // accumulated jog ticks since last block
    this.ticksPerSec = 400;  // 720 ticks/rev @ 33.33rpm
    this.scratchIdle = 0;
    // brake / backspin
    this.fx = null;          // {type:'brake'|'backspin', t, dur, from}
    // loop
    this.loopIn = -1; this.loopOut = -1; this.loopOn = false;
    // keylock (grain OLA)
    this.keylock = false;
    this.grain = 2048; this.overlap = 512;
    this.gA = { start: 0, read: 0, age: 0 }; this.gB = null;
    this.reportEvery = Math.round(sampleRate / 40); this.sinceReport = 0;
    this.port.onmessage = e => this.onMsg(e.data);
  }
  onMsg(m) {
    switch (m.type) {
      case 'load':
        this.L = m.L; this.R = m.R || m.L; this.len = this.L.length;
        this.pos = 0; this.playing = false; this.loopOn = false; this.loopIn = this.loopOut = -1; this.fx = null;
        this.report(true); break;
      case 'play': this.playing = true; this.fx = null; break;
      case 'pause': this.playing = false; this.fx = null; break;
      case 'seek': this.pos = Math.max(0, Math.min(this.len - 1, m.pos)); this.resetGrains(); this.report(true); break;
      case 'tempo': this.tempo = m.value; break;
      case 'bend': this.bend = m.value; break;               // held nudge, caller sends 0 on release
      case 'nudge': this.bend += m.value; break;             // one-shot impulse, decays
      case 'reverse': this.reverse = !!m.value; break;
      case 'scratch':
        this.scratching = !!m.value;
        if (this.scratching) { this.scratchRate = 0; this.ticks = 0; this.scratchIdle = 0; }
        break;
      case 'jogTick': this.ticks += m.delta; this.scratchIdle = 0; break;
      case 'loop':
        this.loopIn = m.in ?? this.loopIn; this.loopOut = m.out ?? this.loopOut;
        if (m.on != null) this.loopOn = m.on; break;
      case 'keylock': this.keylock = !!m.value; this.resetGrains(); break;
      case 'brake': this.fx = { type: 'brake', t: 0, dur: (m.sec || 1) * sampleRate, from: this.curRate() }; break;
      case 'backspin': this.fx = { type: 'backspin', t: 0, dur: (m.sec || 1.2) * sampleRate }; break;
    }
  }
  resetGrains() { this.gA = { start: this.pos, read: this.pos, age: 0 }; this.gB = null; }
  curRate() { return (this.reverse ? -1 : 1) * this.tempo + this.bend; }
  report(force) {
    this.port.postMessage({ type: 'pos', pos: this.pos, playing: this.playing, rate: this.lastRate || 0 });
  }
  // linear-interpolated read at fractional frame p
  read(buf, p) {
    if (p < 0 || p >= this.len - 1) return 0;
    const i = p | 0, f = p - i;
    return buf[i] + (buf[i + 1] - buf[i]) * f;
  }
  process(_inputs, outputs) {
    const out = outputs[0]; const oL = out[0], oR = out[1] || out[0]; const N = oL.length;
    if (!this.L) return true;
    // ---- decide rate for this block ----
    let rate;
    if (this.scratching) {
      // velocity estimate from accumulated ticks, smoothed; decays when the platter stops
      const blockSec = N / sampleRate;
      const target = this.ticks / blockSec / this.ticksPerSec;
      this.ticks = 0;
      this.scratchIdle += blockSec;
      const a = 0.35;
      this.scratchRate = this.scratchRate * (1 - a) + target * a;
      if (this.scratchIdle > 0.08 && Math.abs(target) < 1e-6) this.scratchRate *= 0.6;
      rate = this.scratchRate;
    } else if (this.fx) {
      const k = Math.min(1, this.fx.t / this.fx.dur); this.fx.t += N;
      if (this.fx.type === 'brake') rate = this.fx.from * (1 - k) ** 2;
      else rate = -6 * (1 - k) ** 1.5;            // backspin: fast reverse, slowing to stop
      if (k >= 1) { this.fx = null; this.playing = false; rate = 0; this.port.postMessage({ type: 'fxdone' }); }
    } else if (this.playing) {
      rate = this.curRate();
      if (!this.scratching && this.tempo !== 0) this.bend *= 0.94;   // impulses decay
      if (Math.abs(this.bend) < 1e-4) this.bend = 0;
    } else {
      rate = 0;
    }
    this.lastRate = rate;
    if (rate === 0) { oL.fill(0); oR.fill(0); this.tick(N); return true; }

    const useKL = this.keylock && !this.scratching && !this.fx && rate > 0.5 && rate < 2 && Math.abs(rate - 1) > 0.002;
    if (!useKL) {
      for (let n = 0; n < N; n++) {
        oL[n] = this.read(this.L, this.pos); oR[n] = this.read(this.R, this.pos);
        this.pos += rate;
        this.wrap();
      }
    } else {
      // Overlap-add granular: grains read at rate 1 (pitch preserved), grain starts follow this.pos at `rate`
      const G = this.grain, O = this.overlap;
      for (let n = 0; n < N; n++) {
        let a = this.gA, l = this.read(this.L, a.read), r = this.read(this.R, a.read);
        if (this.gB) {
          const b = this.gB, w = Math.min(1, b.age / O);
          l = l * (1 - w) + this.read(this.L, b.read) * w;
          r = r * (1 - w) + this.read(this.R, b.read) * w;
          b.read += 1; b.age += 1;
          if (b.age >= O) { this.gA = b; this.gB = null; }
        }
        a.read += 1; a.age += 1;
        if (!this.gB && a.age >= G - O) this.gB = { start: this.pos, read: this.pos, age: 0 };
        oL[n] = l; oR[n] = r;
        this.pos += rate;
        this.wrap();
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
  tick(N) {
    this.sinceReport += N;
    if (this.sinceReport >= this.reportEvery) { this.sinceReport = 0; this.report(); }
  }
}
registerProcessor('deck-processor', DeckProcessor);
