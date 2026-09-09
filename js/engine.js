/* djsly audio engine — decks, mixer, sampler, fx, recorder (Web Audio) */
export const PAD_MODES = ['hotcue', 'fxfade', 'padscratch', 'sampler', 'beatjump', 'roll', 'slicer', 'trans'];
export const ROLL_SIZES = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dB = g => Math.pow(10, g / 20);

class Emitter {
  constructor() { this.h = {}; }
  on(ev, fn) { (this.h[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { (this.h[ev] || []).forEach(f => f(...a)); }
}

/* ------------------------------------------------------------------ Deck */
export class Deck extends Emitter {
  constructor(engine, index) {
    super();
    this.engine = engine; this.ctx = engine.ctx; this.index = index;
    this.track = null; this.buffer = null;
    this.playing = false; this.posFrames = 0; this.posAt = 0; this.rate = 0;
    this.cuePoint = 0; this.hotcues = Array(8).fill(null); this.previewing = false;
    this.tempoRange = 0.08; this.tempoSlider = 0; this.keylock = false; this.vinyl = true; this.slip = false;
    this.jogTouched = false; this.reverse = false;
    this.loop = { in: -1, out: -1, on: false }; this.roll = null; this.slicer = null; this.trans = null;
    this.padMode = 'hotcue'; this.jumpSize = 4; this.cueOn = false;
    this.knobs = { trim: 0.5, hi: 0.5, mid: 0.5, low: 0.5, cfx: 0.5, fader: 1 };
    this.level = 0;
    this._buildGraph();
  }
  _buildGraph() {
    const c = this.ctx;
    this.node = new AudioWorkletNode(c, 'deck-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = e => this._onWorklet(e.data);
    this.trim = c.createGain();
    this.eqLow = c.createBiquadFilter(); this.eqLow.type = 'lowshelf'; this.eqLow.frequency.value = 120;
    this.eqMid = c.createBiquadFilter(); this.eqMid.type = 'peaking'; this.eqMid.frequency.value = 1200; this.eqMid.Q.value = 0.8;
    this.eqHi = c.createBiquadFilter(); this.eqHi.type = 'highshelf'; this.eqHi.frequency.value = 8000;
    this.lpf = c.createBiquadFilter(); this.lpf.type = 'lowpass'; this.lpf.frequency.value = 22000; this.lpf.Q.value = 1.2;
    this.hpf = c.createBiquadFilter(); this.hpf.type = 'highpass'; this.hpf.frequency.value = 10; this.hpf.Q.value = 1.2;
    this.transGain = c.createGain();
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 512; this._vu = new Float32Array(512);
    this.fader = c.createGain();
    this.fx = new FxUnit(this.engine, this);
    this.xfGain = c.createGain();
    this.cueTap = c.createGain();
    this.node.connect(this.trim); this.trim.connect(this.eqLow); this.eqLow.connect(this.eqMid); this.eqMid.connect(this.eqHi);
    this.eqHi.connect(this.lpf); this.lpf.connect(this.hpf); this.hpf.connect(this.transGain);
    this.transGain.connect(this.analyser); this.transGain.connect(this.fader); this.transGain.connect(this.cueTap);
    this.fader.connect(this.fx.input); this.fx.output.connect(this.xfGain);
    this.xfGain.connect(this.engine.masterIn); this.cueTap.connect(this.engine.cueBus);
    this.cueTap.gain.value = 0;
  }
  _onWorklet(m) {
    if (m.type === 'pos') { this.posFrames = m.pos; this.posAt = this.ctx.currentTime; this.rate = m.rate; if (this.playing !== m.playing) { this.playing = m.playing; this.emit('change'); } }
    else if (m.type === 'ended') { this.playing = false; this.emit('change'); }
    else if (m.type === 'fxdone') { this.playing = false; this.emit('change'); }
  }
  /* ---- track ---- */
  async load(track) {
    this.track = track; this.buffer = track.buffer;
    const L = this.buffer.getChannelData(0), R = this.buffer.numberOfChannels > 1 ? this.buffer.getChannelData(1) : L;
    this.node.port.postMessage({ type: 'load', L: L.slice(0), R: R.slice(0) });
    this.playing = false; this.posFrames = 0; this.cuePoint = 0; this.hotcues = (track.hotcues || Array(8).fill(null)).slice();
    this.loop = { in: -1, out: -1, on: false }; this.roll = null; this.slicer = null;
    this.emit('load'); this.emit('change');
  }
  get sr() { return this.buffer ? this.buffer.sampleRate : this.ctx.sampleRate; }
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get bpm() { return this.track?.bpm || 0; }
  get effBpm() { return this.bpm * this.tempoRate; }
  get tempoRate() { return 1 + this.tempoSlider * this.tempoRange; }
  get pos() { // seconds, extrapolated between worklet reports
    if (!this.buffer) return 0;
    const dt = this.playing || this.jogTouched ? this.ctx.currentTime - this.posAt : 0;
    return clamp((this.posFrames + dt * this.rate * this.sr) / this.sr, 0, this.duration);
  }
  get remaining() { return this.duration - this.pos; }
  beatLen() { return this.bpm ? 60 / this.bpm : 0.5; }
  beatIndex(t = this.pos) { return (t - (this.track?.firstBeat || 0)) / this.beatLen(); }
  beatTime(i) { return (this.track?.firstBeat || 0) + i * this.beatLen(); }
  /* ---- transport ---- */
  seek(sec) { this.posFrames = clamp(sec, 0, this.duration) * this.sr; this.posAt = this.ctx.currentTime; this.node.port.postMessage({ type: 'seek', pos: this.posFrames }); this.emit('change'); }
  play() { if (!this.buffer) return; this.engine.resume(); this.playing = true; this.posAt = this.ctx.currentTime; this.rate = this.tempoRate; this.node.port.postMessage({ type: 'play' }); this.emit('change'); }
  pause() { this.playing = false; this.rate = 0; this.node.port.postMessage({ type: 'pause' }); this.emit('change'); }
  togglePlay() { this.playing ? this.pause() : this.play(); }
  cue(pressed) {
    if (!this.buffer) return;
    if (pressed) {
      if (this.playing) { this.pause(); this.seek(this.cuePoint); }
      else {
        if (Math.abs(this.pos - this.cuePoint) > 0.005) { this.cuePoint = this.pos; this.emit('change'); }
        this.previewing = true; this.play();
      }
    } else if (this.previewing) { this.previewing = false; this.pause(); this.seek(this.cuePoint); }
  }
  shiftCue() { this.seek(0); if (this.playing) this.play(); }
  hotcue(i, pressed, shift) {
    if (!this.buffer) return;
    if (shift) { if (pressed) { this.hotcues[i] = null; this._saveCues(); this.emit('change'); } return; }
    if (!pressed) { if (this._hcPreview === i && !this._hcWasPlaying) { this.pause(); this.seek(this.hotcues[i]); } this._hcPreview = null; return; }
    if (this.hotcues[i] == null) { this.hotcues[i] = this.pos; this._saveCues(); this.emit('change'); return; }
    this._hcWasPlaying = this.playing; this._hcPreview = i;
    this.seek(this.hotcues[i]); if (!this.playing) this.play();
  }
  _saveCues() { if (this.track?.id) this.engine.emit('savecues', this.track.id, this.hotcues.slice()); }
  setTempo(slider) { this.tempoSlider = clamp(slider, -1, 1); this.node.port.postMessage({ type: 'tempo', value: this.tempoRate }); if (this.playing) this.rate = this.tempoRate; this.emit('change'); }
  cycleTempoRange() { const r = [0.08, 0.16, 0.5]; this.tempoRange = r[(r.indexOf(this.tempoRange) + 1) % r.length]; this.setTempo(this.tempoSlider); }
  setKeylock(v) { this.keylock = v; this.node.port.postMessage({ type: 'keylock', value: v }); this.emit('change'); }
  setVinyl(v) { this.vinyl = v; this.emit('change'); }
  setReverse(v) { this.reverse = v; this.node.port.postMessage({ type: 'reverse', value: v }); }
  /* ---- jog ---- */
  jogTouch(on) {
    if (!this.buffer) return;
    if (on && this.vinyl) { this.jogTouched = true; this._jogWasPlaying = this.playing; this.node.port.postMessage({ type: 'scratch', value: true }); }
    else if (this.jogTouched) { this.jogTouched = false; this.node.port.postMessage({ type: 'scratch', value: false }); if (this._jogWasPlaying) this.play(); else this.pause(); }
  }
  jogTick(delta, shift) {
    if (!this.buffer) return;
    if (this.jogTouched) this.node.port.postMessage({ type: 'jogTick', delta: shift ? delta * 20 : delta });
    else if (this.playing) this.node.port.postMessage({ type: 'nudge', value: delta * (shift ? 0.02 : 0.0025) });
    else this.seek(this.pos + delta * (shift ? 0.25 : 0.01));
  }
  bend(v) { this.node.port.postMessage({ type: 'bend', value: v }); }
  /* ---- loops ---- */
  _setLoop(inSec, outSec, on) {
    this.loop = { in: inSec, out: outSec, on };
    this.node.port.postMessage({ type: 'loop', in: inSec * this.sr, out: outSec * this.sr, on });
    this.emit('change');
  }
  autoLoop(beats = 4) {
    if (!this.buffer) return;
    if (this.loop.on) return this._setLoop(this.loop.in, this.loop.out, false);
    const b = Math.floor(this.beatIndex()); const a = this.beatTime(b);
    this._setLoop(a, a + beats * this.beatLen(), true);
  }
  loopIn() { if (this.buffer) this._setLoop(this.pos, -1, false); }
  loopOut() { if (this.buffer && this.loop.in >= 0 && this.pos > this.loop.in) this._setLoop(this.loop.in, this.pos, true); }
  reloop() { if (this.loop.in >= 0 && this.loop.out > this.loop.in) { this._setLoop(this.loop.in, this.loop.out, !this.loop.on); if (this.loop.on && this.pos > this.loop.out) this.seek(this.loop.in); } }
  loopHalve() { if (this.loop.out > this.loop.in) { const len = (this.loop.out - this.loop.in) / 2; if (len * this.bpm / 60 >= 1 / 32) this._setLoop(this.loop.in, this.loop.in + len, this.loop.on); } }
  loopDouble() { if (this.loop.out > this.loop.in) this._setLoop(this.loop.in, this.loop.in + (this.loop.out - this.loop.in) * 2, this.loop.on); }
  loopRoll(beats, pressed) {
    if (!this.buffer) return;
    if (pressed) {
      if (!this.roll) this.roll = { start: this.pos, at: this.ctx.currentTime, prev: { ...this.loop } };
      const a = this.beatTime(Math.floor(this.beatIndex() / beats) * beats);
      this._setLoop(a, a + beats * this.beatLen(), true);
    } else if (this.roll) {
      const r = this.roll; this.roll = null;
      this._setLoop(r.prev.in, r.prev.out, false);
      if (this.playing) this.seek(r.start + (this.ctx.currentTime - r.at) * this.tempoRate);
    }
  }
  beatJump(beats) { if (this.buffer) this.seek(this.pos + beats * this.beatLen()); }
  /* ---- slicer ---- */
  slicerPad(i, pressed) {
    if (!this.buffer) return;
    if (pressed) {
      if (!this.slicer) this.slicer = { domain: Math.floor(this.beatIndex() / 8) * 8, prev: { ...this.loop }, start: this.pos, at: this.ctx.currentTime };
      const s = this.slicer; const b = this.beatTime(s.domain + i);
      this._setLoop(b, b + this.beatLen(), true); this.seek(b); if (!this.playing) this.play();
    } else if (this.slicer) {
      const s = this.slicer; this.slicer = null; this._setLoop(s.prev.in, s.prev.out, false);
      this.seek(s.start + (this.ctx.currentTime - s.at) * this.tempoRate);
    }
  }
  /* ---- trans (beat gate) ---- */
  transPad(i, pressed) { this.trans = pressed ? ROLL_SIZES[i] : null; if (!pressed) this.transGain.gain.value = 1; }
  /* ---- pad fx ---- */
  padFx(i, pressed) {
    if (!this.buffer) return;
    const now = this.ctx.currentTime;
    if (i < 4) { // filter fade over 1/2/4/8 beats, then stop
      if (!pressed) return;
      const dur = [1, 2, 4, 8][i] * this.beatLen();
      this.lpf.frequency.cancelScheduledValues(now); this.lpf.frequency.setValueAtTime(this.lpf.frequency.value, now);
      this.lpf.frequency.exponentialRampToValueAtTime(120, now + dur);
      setTimeout(() => { this.pause(); this._applyCfx(); }, dur * 1000);
    } else if (i === 4) { if (pressed) this.node.port.postMessage({ type: 'brake', sec: 0.9 }); }
    else if (i === 5) { if (pressed) this.node.port.postMessage({ type: 'backspin', sec: 1.3 }); }
    else if (i === 6) { // echo out
      if (!pressed) return; this.fx.echoOut(this.beatLen()); const dur = 4 * this.beatLen();
      this.fader.gain.cancelScheduledValues(now); this.fader.gain.setValueAtTime(this.fader.gain.value, now); this.fader.gain.linearRampToValueAtTime(0, now + dur);
      setTimeout(() => { this.pause(); this.setKnob('fader', this.knobs.fader); this.fx.echoOutRelease(); }, dur * 1000 + 50);
    } else if (i === 7) { this.setReverse(pressed); }
  }
  padScratch(i, pressed) { // canned scratch gestures: baby / chirp / stab
    if (!pressed || !this.buffer) return;
    const seq = [[0.15, 3, 0.15, -3], [0.1, 4, 0.1, -4, 0.1, 4], [0.08, 6, 0.12, -2], [0.2, 2, 0.2, -2, 0.1, 4], [0.05, 8], [0.3, -3], [0.1, 2, 0.1, -2, 0.1, 2, 0.1, -2], [0.25, 5, 0.25, -5]][i];
    this.jogTouch(true); let t = 0;
    for (let k = 0; k < seq.length; k += 2) { const dur = seq[k], v = seq[k + 1]; const n = Math.round(dur * 50);
      for (let j = 0; j < n; j++) setTimeout(() => this.node.port.postMessage({ type: 'jogTick', delta: v }), (t + j * 0.02) * 1000); t += dur; }
    setTimeout(() => this.jogTouch(false), t * 1000 + 30);
  }
  /* ---- sync ---- */
  sync(other) {
    if (!this.buffer || !other?.buffer || !this.bpm || !other.bpm) return;
    let rate = other.effBpm / this.bpm;
    let slider = (rate - 1) / this.tempoRange;
    if (Math.abs(slider) > 1) { this.tempoRange = Math.abs(rate - 1) > 0.16 ? 0.5 : 0.16; slider = (rate - 1) / this.tempoRange; }
    this.setTempo(clamp(slider, -1, 1));
    // phase align to the other deck's beat fraction
    const fo = other.beatIndex() % 1, bi = this.beatIndex(); const fi = ((bi % 1) + 1) % 1;
    let d = fo - fi; if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
    if (Math.abs(d) > 0.01 && this.playing) this.seek(this.pos + d * this.beatLen());
  }
  /* ---- mixer knobs (0..1) ---- */
  setKnob(k, v) {
    v = clamp(v, 0, 1); this.knobs[k] = v; const now = this.ctx.currentTime;
    switch (k) {
      case 'trim': this.trim.gain.setTargetAtTime(v <= 0.5 ? (v / 0.5) ** 2 : dB((v - 0.5) / 0.5 * 9), now, 0.01); break;
      case 'hi': this.eqHi.gain.setTargetAtTime(eqDb(v), now, 0.01); break;
      case 'mid': this.eqMid.gain.setTargetAtTime(eqDb(v), now, 0.01); break;
      case 'low': this.eqLow.gain.setTargetAtTime(eqDb(v), now, 0.01); break;
      case 'cfx': this._applyCfx(); break;
      case 'fader': this.fader.gain.cancelScheduledValues(now); this.fader.gain.setTargetAtTime(v * v, now, 0.005); break;
    }
    this.emit('knob', k, v);
  }
  _applyCfx() {
    const v = this.knobs.cfx, now = this.ctx.currentTime;
    const lp = v < 0.48 ? 22000 * Math.pow(120 / 22000, (0.48 - v) / 0.48) : 22000;
    const hp = v > 0.52 ? 20 * Math.pow(9000 / 20, (v - 0.52) / 0.48) : 10;
    this.lpf.frequency.cancelScheduledValues(now); this.lpf.frequency.setTargetAtTime(lp, now, 0.01);
    this.hpf.frequency.setTargetAtTime(hp, now, 0.01);
  }
  setCue(on) { this.cueOn = on; this.cueTap.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01); this.emit('change'); }
  tick() { // called from engine rAF/interval: VU + trans gate
    this.analyser.getFloatTimeDomainData(this._vu); let s = 0; for (let i = 0; i < this._vu.length; i += 4) s += this._vu[i] * this._vu[i];
    const rms = Math.sqrt(s / (this._vu.length / 4)); this.level = Math.max(rms * 1.6, this.level * 0.85);
    if (this.trans) { const ph = (this.beatIndex() / this.trans) % 1; this.transGain.gain.value = ph < 0.5 ? 1 : 0; }
  }
}
const eqDb = v => v <= 0.5 ? -26 * (1 - v / 0.5) : 6 * ((v - 0.5) / 0.5);

/* ------------------------------------------------------------------ FX unit (per deck: echo / flanger / reverb) */
class FxUnit {
  constructor(engine, deck) {
    const c = engine.ctx; this.ctx = c; this.deck = deck; this.engine = engine;
    this.input = c.createGain(); this.output = c.createGain(); this.dry = c.createGain();
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.on = [false, false, false]; this.depth = 0.5;
    // 1: echo
    this.echo = c.createDelay(2); this.echoFb = c.createGain(); this.echoWet = c.createGain(); this.echoHp = c.createBiquadFilter(); this.echoHp.type = 'highpass'; this.echoHp.frequency.value = 300;
    this.input.connect(this.echoWet); this.echoWet.connect(this.echo); this.echo.connect(this.echoHp); this.echoHp.connect(this.echoFb); this.echoFb.connect(this.echo); this.echoHp.connect(this.output);
    this.echoWet.gain.value = 0; this.echoFb.gain.value = 0.45; this.echo.delayTime.value = 0.25;
    // 2: flanger
    this.fl = c.createDelay(0.05); this.flWet = c.createGain(); this.flFb = c.createGain(); this.lfo = c.createOscillator(); this.lfoG = c.createGain();
    this.lfo.frequency.value = 0.35; this.lfoG.gain.value = 0.002; this.lfo.connect(this.lfoG); this.lfoG.connect(this.fl.delayTime); this.fl.delayTime.value = 0.004; this.lfo.start();
    this.input.connect(this.flWet); this.flWet.connect(this.fl); this.fl.connect(this.flFb); this.flFb.connect(this.fl); this.fl.connect(this.output); this.flWet.gain.value = 0; this.flFb.gain.value = 0.5;
    // 3: reverb
    this.rv = c.createConvolver(); this.rvWet = c.createGain(); this.rv.buffer = engine.impulse; this.input.connect(this.rvWet); this.rvWet.connect(this.rv); this.rv.connect(this.output); this.rvWet.gain.value = 0;
  }
  set(i, on) { this.on[i] = on; this.apply(); }
  setDepth(v) { this.depth = v; this.apply(); }
  apply() {
    const now = this.ctx.currentTime, d = this.depth;
    const bl = this.deck.beatLen() / this.deck.tempoRate;
    this.echo.delayTime.setTargetAtTime(bl * (d < 0.33 ? 0.25 : d < 0.66 ? 0.5 : 0.75), now, 0.05);
    this.echoWet.gain.setTargetAtTime(this.on[0] ? 0.3 + d * 0.5 : 0, now, 0.02); this.echoFb.gain.setTargetAtTime(0.3 + d * 0.5, now, 0.02);
    this.flWet.gain.setTargetAtTime(this.on[1] ? 0.7 : 0, now, 0.02); this.lfoG.gain.setTargetAtTime(0.0005 + d * 0.004, now, 0.02); this.flFb.gain.setTargetAtTime(0.3 + d * 0.55, now, 0.02);
    this.rvWet.gain.setTargetAtTime(this.on[2] ? d * 1.2 : 0, now, 0.02);
    this.engine.emit('fx', this.deck.index);
  }
  echoOut(beatLen) { const now = this.ctx.currentTime; this.echo.delayTime.setTargetAtTime(beatLen * 0.75, now, 0.02); this.echoWet.gain.setTargetAtTime(0.8, now, 0.02); this.echoFb.gain.setTargetAtTime(0.7, now, 0.02); }
  echoOutRelease() { setTimeout(() => this.apply(), 2500); }
}

/* ------------------------------------------------------------------ Sampler (finger drum pads) */
export class Sampler extends Emitter {
  constructor(engine) {
    super(); this.engine = engine; this.ctx = engine.ctx;
    this.out = this.ctx.createGain(); this.out.gain.value = 0.9; this.out.connect(engine.masterIn); this.out.connect(engine.cueBus);
    this.slots = Array.from({ length: 16 }, (_, i) => ({ name: '', buffer: null, playing: null, color: i % 8 < 4 ? 'a' : 'b' }));
  }
  async loadKit() {
    const kit = await synthKit(this.ctx.sampleRate);
    kit.forEach((k, i) => { this.slots[i].name = k.name; this.slots[i].buffer = k.buffer; this.slots[i].builtin = true; });
    this.emit('change');
  }
  async loadFile(i, file) {
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    this.slots[i] = { ...this.slots[i], name: file.name.replace(/\.[^.]+$/, ''), buffer: buf, builtin: false }; this.emit('change');
  }
  play(i, vel = 1) {
    const s = this.slots[i]; if (!s?.buffer) return; this.engine.resume();
    if (s.playing) { try { s.playing.stop(); } catch { } }
    const src = this.ctx.createBufferSource(); src.buffer = s.buffer; const g = this.ctx.createGain(); g.gain.value = 0.3 + 0.7 * vel;
    src.connect(g); g.connect(this.out); src.start(); s.playing = src; src.onended = () => { if (s.playing === src) s.playing = null; this.emit('pad', i, false); };
    this.emit('pad', i, true);
  }
  stop(i) { const s = this.slots[i]; if (s?.playing) { try { s.playing.stop(); } catch { } s.playing = null; } }
  setVolume(v) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }
}

/* synthesized 16-piece kit rendered offline so the drumpad works with zero downloads */
async function synthKit(sr) {
  const mk = async (name, dur, build) => {
    const oc = new OfflineAudioContext(1, Math.ceil(sr * dur), sr); build(oc); return { name, buffer: await oc.startRendering() };
  };
  const noise = (oc, dur) => { const b = oc.createBuffer(1, Math.ceil(oc.sampleRate * dur), oc.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const s = oc.createBufferSource(); s.buffer = b; return s; };
  const env = (oc, g, a, d, peak = 1) => { g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(peak, a); g.gain.exponentialRampToValueAtTime(0.001, a + d); };
  const kick = (f0, dur, punch) => oc => { const o = oc.createOscillator(), g = oc.createGain(); o.frequency.setValueAtTime(f0, 0); o.frequency.exponentialRampToValueAtTime(40, 0.12 * punch); env(oc, g, 0.002, dur); o.connect(g); g.connect(oc.destination); o.start(); };
  const snare = (tone, dur) => oc => { const n = noise(oc, dur), f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500; const g = oc.createGain(); env(oc, g, 0.001, dur, 0.8); n.connect(f); f.connect(g); g.connect(oc.destination); n.start(); const o = oc.createOscillator(), g2 = oc.createGain(); o.frequency.setValueAtTime(tone, 0); o.frequency.exponentialRampToValueAtTime(tone * 0.6, 0.1); env(oc, g2, 0.001, 0.12, 0.7); o.connect(g2); g2.connect(oc.destination); o.start(); };
  const hat = (dur, hp) => oc => { const n = noise(oc, dur), f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; const g = oc.createGain(); env(oc, g, 0.001, dur, 0.6); n.connect(f); f.connect(g); g.connect(oc.destination); n.start(); };
  const clap = oc => { for (let k = 0; k < 4; k++) { const n = noise(oc, 0.25), f = oc.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8; const g = oc.createGain(); const t = k * 0.012; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.8, t + 0.002); g.gain.exponentialRampToValueAtTime(0.001, t + (k === 3 ? 0.22 : 0.03)); n.connect(f); f.connect(g); g.connect(oc.destination); n.start(t); } };
  const tom = (f0, dur) => oc => { const o = oc.createOscillator(), g = oc.createGain(); o.frequency.setValueAtTime(f0, 0); o.frequency.exponentialRampToValueAtTime(f0 * 0.5, dur); env(oc, g, 0.002, dur); o.connect(g); g.connect(oc.destination); o.start(); };
  const rim = oc => { const o = oc.createOscillator(), g = oc.createGain(); o.type = 'square'; o.frequency.value = 900; env(oc, g, 0.001, 0.04, 0.5); o.connect(g); g.connect(oc.destination); o.start(); };
  const cow = oc => { [560, 845].forEach(f => { const o = oc.createOscillator(), g = oc.createGain(); o.type = 'square'; o.frequency.value = f; env(oc, g, 0.001, 0.25, 0.3); o.connect(g); g.connect(oc.destination); o.start(); }); };
  const shaker = oc => { const n = noise(oc, 0.12), f = oc.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 6000; f.Q.value = 1.5; const g = oc.createGain(); env(oc, g, 0.01, 0.1, 0.5); n.connect(f); f.connect(g); g.connect(oc.destination); n.start(); };
  const bass = (f, dur) => oc => { const o = oc.createOscillator(), g = oc.createGain(), fl = oc.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.setValueAtTime(1200, 0); fl.frequency.exponentialRampToValueAtTime(120, dur); o.type = 'sawtooth'; o.frequency.value = f; env(oc, g, 0.005, dur, 0.6); o.connect(fl); fl.connect(g); g.connect(oc.destination); o.start(); };
  const stab = (fs, dur) => oc => fs.forEach(f => { const o = oc.createOscillator(), g = oc.createGain(); o.type = 'sawtooth'; o.frequency.value = f; env(oc, g, 0.005, dur, 0.18); o.connect(g); g.connect(oc.destination); o.start(); });
  return Promise.all([
    mk('Kick', 0.5, kick(150, 0.45, 1)), mk('Snare', 0.3, snare(180, 0.25)), mk('Clap', 0.3, clap), mk('Hat', 0.08, hat(0.06, 7000)),
    mk('Open Hat', 0.4, hat(0.35, 6000)), mk('Rim', 0.06, rim), mk('Tom Lo', 0.4, tom(110, 0.35)), mk('Tom Hi', 0.3, tom(200, 0.25)),
    mk('808', 0.9, kick(90, 0.85, 3)), mk('Snare 2', 0.35, snare(240, 0.3)), mk('Shaker', 0.15, shaker), mk('Cowbell', 0.3, cow),
    mk('Bass C', 0.5, bass(65.4, 0.45)), mk('Bass G', 0.5, bass(98, 0.45)), mk('Stab Am', 0.4, stab([220, 261.6, 329.6], 0.35)), mk('Stab F', 0.4, stab([174.6, 220, 261.6], 0.35)),
  ]);
}

/* ------------------------------------------------------------------ Engine */
export class Engine extends Emitter {
  constructor() {
    super();
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.ready = false;
  }
  async init() {
    const c = this.ctx;
    await c.audioWorklet.addModule(new URL('./deck-processor.js', import.meta.url));
    this.impulse = makeImpulse(c);
    this.masterIn = c.createGain(); this.master = c.createGain(); this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -3; this.limiter.knee.value = 2; this.limiter.ratio.value = 12; this.limiter.attack.value = 0.002; this.limiter.release.value = 0.15;
    this.masterAn = c.createAnalyser(); this.masterAn.fftSize = 512; this._mv = new Float32Array(512); this.masterLevel = 0;
    this.cueBus = c.createGain(); this.cueGain = c.createGain(); this.cueGain.gain.value = 0.8;
    this.masterIn.connect(this.master); this.master.connect(this.limiter); this.limiter.connect(this.masterAn);
    // output routing: normal = master stereo; split = master L / cue R
    this.splitter = c.createChannelSplitter(2); this.merger = c.createChannelMerger(2);
    this.mainOut = c.createGain(); this.splitOutM = c.createGain(); this.splitOutC = c.createGain();
    this.limiter.connect(this.mainOut); this.mainOut.connect(c.destination);
    this.limiter.connect(this.splitOutM); this.cueBus.connect(this.cueGain); this.cueGain.connect(this.splitOutC);
    this.splitOutM.connect(this.merger, 0, 0); this.splitOutC.connect(this.merger, 0, 1); this.merger.connect(c.destination);
    this.splitOutM.gain.value = 0; this.splitOutC.gain.value = 0; this.splitCue = false;
    this.recDest = c.createMediaStreamDestination(); this.limiter.connect(this.recDest);
    this.decks = [new Deck(this, 0), new Deck(this, 1)];
    this.sampler = new Sampler(this); this.sampler.loadKit();
    this.crossfader = 0.5; this.setCrossfader(0.5); this.setMaster(0.8);
    this.worker = new Worker(new URL('./analysis-worker.js', import.meta.url)); this._jobs = {}; this._jobId = 0;
    this.worker.onmessage = e => { const j = this._jobs[e.data.id]; if (j) { delete this._jobs[e.data.id]; j(e.data); } };
    setInterval(() => this.tick(), 33);
    this.ready = true;
  }
  resume() { if (this.ctx.state !== 'running') this.ctx.resume(); }
  setCrossfader(v) { this.crossfader = clamp(v, 0, 1); const now = this.ctx.currentTime;
    // smooth constant-power curve with a flat top so faders at center are both at full
    const t = (this.crossfader - 0.5) * 2; const gA = t <= 0 ? 1 : Math.cos(t * Math.PI / 2); const gB = t >= 0 ? 1 : Math.cos(-t * Math.PI / 2);
    this.decks[0].xfGain.gain.setTargetAtTime(gA, now, 0.005); this.decks[1].xfGain.gain.setTargetAtTime(gB, now, 0.005); this.emit('mixer'); }
  setMaster(v) { this.masterVol = clamp(v, 0, 1); this.master.gain.setTargetAtTime(this.masterVol ** 2 * 1.2, this.ctx.currentTime, 0.01); this.emit('mixer'); }
  setHeadphone(v) { this.cueGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }
  setSplitCue(on) { this.splitCue = on; const now = this.ctx.currentTime; this.mainOut.gain.setTargetAtTime(on ? 0 : 1, now, 0.01); this.splitOutM.gain.setTargetAtTime(on ? 1 : 0, now, 0.01); this.splitOutC.gain.setTargetAtTime(on ? 1 : 0, now, 0.01); this.emit('mixer'); }
  tick() { this.decks.forEach(d => d.tick()); this.masterAn.getFloatTimeDomainData(this._mv); let s = 0; for (let i = 0; i < 512; i += 4) s += this._mv[i] ** 2; this.masterLevel = Math.max(Math.sqrt(s / 128) * 1.6, this.masterLevel * 0.85); }
  async decode(arrayBuffer) { return this.ctx.decodeAudioData(arrayBuffer); }
  analyze(buffer, cols = 600) {
    return new Promise(res => {
      const id = ++this._jobId; this._jobs[id] = res;
      const L = buffer.getChannelData(0).slice(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice(0) : null;
      this.worker.postMessage({ id, L, R, sampleRate: buffer.sampleRate, cols }, R ? [L.buffer, R.buffer] : [L.buffer]);
    });
  }
  /* recorder */
  startRec() {
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(m => window.MediaRecorder?.isTypeSupported(m)) || '';
    this.rec = new MediaRecorder(this.recDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    this.recChunks = []; this.rec.ondataavailable = e => e.data.size && this.recChunks.push(e.data);
    this.rec.start(1000); this.recStart = Date.now(); this.emit('rec', true);
  }
  stopRec() {
    return new Promise(res => { const r = this.rec; if (!r) return res(null); r.onstop = () => { const blob = new Blob(this.recChunks, { type: r.mimeType }); this.rec = null; this.emit('rec', false); res(blob); }; r.stop(); });
  }
}
function makeImpulse(c) {
  const dur = 2.2, b = c.createBuffer(2, Math.ceil(c.sampleRate * dur), c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.2); }
  return b;
}
