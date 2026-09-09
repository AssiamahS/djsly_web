/* djsly — UI + glue. The controller mapping and the on-screen skin both talk to the small `app` API below. */
import { Engine, PAD_MODES, ROLL_SIZES } from './engine.js';
import { Library } from './library.js';
import { Midi } from './midi.js';

const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const fmtT = t => { const s = Math.abs(t); const m = Math.floor(s / 60), r = s - m * 60; return `${t < 0 ? '-' : ''}${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`; };
let toastT; const toast = m => { const t = $('.toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); };
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const app = {
  engine: null, midi: null, tracks: new Map(), lib: [], sel: 0, view: 'mix', shift: false, deckAn: [null, null], handlers: {},
  toast,
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }, emit(ev, ...a) { (this.handlers[ev] || []).forEach(f => f(...a)); },
  /* ---- API used by controller mappings + on-screen controls ---- */
  act(d, action, pressed, shift) {
    const dk = this.engine.decks[d], other = this.engine.decks[1 - d];
    switch (action) {
      case 'play': if (!pressed) return; if (shift) { dk.seek(dk.cuePoint); dk.play(); } else dk.togglePlay(); break;
      case 'cue': if (shift) { if (pressed) dk.shiftCue(); } else dk.cue(pressed); break;
      case 'sync': if (!pressed) return; if (shift) { dk.synced = false; } else { dk.synced = !dk.synced; if (dk.synced) dk.sync(other); } break;
      case 'autoloop': if (pressed) shift ? dk.reloop() : dk.autoLoop(4); break;
      case 'reloop': if (pressed) dk.reloop(); break;
      case 'loopIn': if (pressed) dk.loopIn(); break;
      case 'loopOut': if (pressed) dk.loopOut(); break;
      case 'loopHalve': if (pressed) dk.loopHalve(); break;
      case 'loopDouble': if (pressed) dk.loopDouble(); break;
      case 'vinyl': if (pressed) shift ? (dk.slip = !dk.slip, toast(`Slip ${dk.slip ? 'on' : 'off'} (v2)`)) : dk.setVinyl(!dk.vinyl); break;
      case 'slip': if (pressed) toast('Slip mode lands in v2'); break;
      case 'keylock': if (pressed) shift ? dk.cycleTempoRange() : dk.setKeylock(!dk.keylock); break;
      case 'tempoRange': if (pressed) { dk.cycleTempoRange(); toast(`Tempo range ±${Math.round(dk.tempoRange * 100)}%`); } break;
      case 'headCue': if (pressed) dk.setCue(!dk.cueOn); break;
      case 'deckSelect': if (pressed) toast('Decks 3/4 are not in v1'); break;
      case 'masterCue': if (pressed) this.setSplit(!this.engine.splitCue); break;
    }
    this.render();
  },
  pad(d, i, pressed, vel = 1, shift = false, mode) {
    const dk = this.engine.decks[d]; mode = mode || dk.padMode;
    switch (mode) {
      case 'hotcue': dk.hotcue(i, pressed, shift); break;
      case 'fxfade': dk.padFx(i, pressed); break;
      case 'padscratch': dk.padScratch(i, pressed); break;
      case 'sampler': if (shift) this.engine.sampler.stop(d * 8 + i); else if (pressed) this.engine.sampler.play(d * 8 + i, vel); break;
      case 'beatjump': if (pressed) dk.beatJump([-1, 1, -2, 2, -4, 4, -8, 8][i] * (shift ? 4 : 1)); break;
      case 'roll': dk.loopRoll(ROLL_SIZES[i], pressed); break;
      case 'slicer': dk.slicerPad(i, pressed); break;
      case 'trans': dk.transPad(i, pressed); break;
    }
    this.padDom[d][i]?.classList.toggle('on', pressed);
    if (mode === 'hotcue' || mode === 'sampler') this.render();
  },
  setPadMode(d, mode) { this.engine.decks[d].padMode = mode; this.render(); },
  knob(d, k, x) { const dk = this.engine.decks[d]; if (k === 'tempo') dk.setTempo(x); else dk.setKnob(k, x); },
  mixer(k, x) { const e = this.engine; if (k === 'master') e.setMaster(x); else if (k === 'headphone') e.setHeadphone(x); else if (k === 'crossfader') e.setCrossfader(x); },
  jog(d, kind, v, shift) { const dk = this.engine.decks[d]; if (kind === 'touch') { dk.jogTouch(v); this.jogDom[d]?.classList.toggle('touch', v && dk.vinyl); } else dk.jogTick(v, shift); },
  fx(unit, i, pressed, shift) { if (!pressed) return; const f = this.engine.decks[unit].fx; f.set(i, !f.on[i]); this.render(); },
  fxKnob(unit, x) { this.engine.decks[unit].fx.setDepth(x); },
  fxBeat() { },
  browse(delta, shift) { if (!this.lib.length) return; this.sel = (this.sel + (delta > 0 ? 1 : -1) + this.lib.length) % this.lib.length; this.renderLib(); if (this.view !== 'library' && !shift) this.showView('library'); },
  browseClick(shift) { if (shift) return this.toggleView('library'); const free = this.engine.decks.findIndex(d => !d.playing); this.load(free < 0 ? 0 : free); },
  load(d) { const t = this.lib[this.sel]; if (t) this.loadToDeck(d, t.id); },
  toggleView(v) { this.showView(this.view === v ? 'mix' : v); },
  setSplit(on) { this.engine.setSplitCue(on); $('#split').classList.toggle('on', on); localStorage.setItem('djsly.split', on ? 1 : 0); },
  /* ---- tracks ---- */
  async addFiles(files) {
    for (const f of files) {
      if (!/audio|mp3|m4a|wav|flac|aac|ogg/i.test(f.type + f.name)) continue;
      const meta = await Library.add(f); this.lib.push(meta); this.renderLib(); toast(`Added ${meta.name}`);
      this.analyzeTrack(meta.id).catch(e => console.warn(e));
    }
  },
  async getBuffer(id) {
    if (this.tracks.has(id)) return this.tracks.get(id);
    const row = await Library.get(id); if (!row) throw new Error('missing');
    const buffer = await this.engine.decode(await row.blob.arrayBuffer());
    const t = { buffer, an: null }; this.tracks.set(id, t); return t;
  },
  async analyzeTrack(id) {
    const t = await this.getBuffer(id); if (t.an) return t.an;
    t.an = await this.engine.analyze(t.buffer, 600);
    const patch = { bpm: t.an.bpm, firstBeat: t.an.firstBeat, duration: t.buffer.duration };
    Object.assign(this.lib.find(x => x.id === id) || {}, patch); await Library.update(id, patch); this.renderLib();
    return t.an;
  },
  async loadToDeck(d, id) {
    const dk = this.engine.decks[d]; if (dk.playing && !confirm('Deck is playing. Load anyway?')) return;
    const meta = this.lib.find(x => x.id === id); toast(`Loading ${meta.name}…`);
    const t = await this.getBuffer(id); const an = await this.analyzeTrack(id);
    this.deckAn[d] = an; this.buildOverview(d, an);
    await dk.load({ ...meta, bpm: an.bpm, firstBeat: an.firstBeat, buffer: t.buffer });
    this.renderInfo(d); this.render(); toast(`${d ? 'B' : 'A'}: ${meta.name} · ${an.bpm} BPM`);
  },
  showView(v) { this.view = v; $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v)); $$('.view').forEach(s => s.classList.toggle('on', s.dataset.view === v)); },
  /* ---- rendering ---- */
  padDom: [[], []], jogDom: [], btn: [{}, {}], knobDom: [{}, {}], mixDom: {},
  render() { clearTimeout(this._rt); this._rt = setTimeout(() => this._render(), 8); },
  _render() {
    this.engine.decks.forEach((dk, d) => {
      const b = this.btn[d]; const set = (k, on) => b[k]?.classList.toggle('on', !!on);
      set('play', dk.playing); set('cue', dk.buffer && !dk.playing); set('sync', dk.synced); set('autoloop', dk.loop.on); set('vinyl', dk.vinyl); set('keylock', dk.keylock); set('headCue', dk.cueOn); set('shift', this.shift);
      b.tempoRange && (b.tempoRange.textContent = `±${Math.round(dk.tempoRange * 100)}%`);
      $$('.padmodes .btn', this.deckEl[d]).forEach(x => x.classList.toggle('on', x.dataset.mode === dk.padMode));
      this.padDom[d].forEach((p, i) => {
        const m = dk.padMode; let label = '', lit = false, sub = '';
        if (m === 'hotcue') { lit = dk.hotcues[i] != null; label = `HC ${i + 1}`; sub = lit ? fmtT(dk.hotcues[i]) : 'set'; }
        else if (m === 'sampler') { const s = this.engine.sampler.slots[d * 8 + i]; lit = !!s?.buffer; label = s?.name || '—'; sub = `S${d * 8 + i + 1}`; }
        else if (m === 'beatjump') { label = ['◀ 1', '1 ▶', '◀ 2', '2 ▶', '◀ 4', '4 ▶', '◀ 8', '8 ▶'][i]; lit = true; sub = 'beats'; }
        else if (m === 'roll') { label = ROLL_SIZES[i] < 1 ? `1/${1 / ROLL_SIZES[i]}` : `${ROLL_SIZES[i]}`; lit = true; sub = 'roll'; }
        else if (m === 'slicer') { label = `slice ${i + 1}`; lit = true; }
        else if (m === 'trans') { label = ROLL_SIZES[i] < 1 ? `1/${1 / ROLL_SIZES[i]}` : `${ROLL_SIZES[i]}`; lit = true; sub = 'gate'; }
        else if (m === 'fxfade') { label = ['filter 1', 'filter 2', 'filter 4', 'filter 8', 'brake', 'backspin', 'echo out', 'reverse'][i]; lit = true; }
        else if (m === 'padscratch') { label = ['baby', 'chirp', 'stab', 'drag', 'flick', 'pull', 'crab', 'tear'][i]; lit = true; }
        p.classList.toggle('lit', lit); p.classList.toggle('b', d === 1); p.innerHTML = `<b>${label}</b><span>${sub}</span>`;
      });
      [0, 1, 2].forEach(i => this.fxDom?.[d]?.[i]?.classList.toggle('on', dk.fx.on[i]));
    });
    this.engine.sampler.slots.forEach((s, i) => { const p = this.drumDom?.[i]; if (p) { p.classList.toggle('lit', !!s.buffer); p.innerHTML = `<b>${s.name || '—'}</b><small>${i + 1} · ${'1234qwerasdfzxcv'[i].toUpperCase()}</small>`; } });
    this.midi?.refreshLeds();
  },
  renderInfo(d) {
    const dk = this.engine.decks[d], info = $(`#info${d}`);
    $('.title', info).textContent = dk.track ? (dk.track.title || dk.track.name) : 'No track';
    $('.artist', info).textContent = dk.track ? (dk.track.artist || '') : (d ? 'Load B' : 'Load A');
  },
  renderLib() {
    const list = $('#libList'); list.innerHTML = '';
    if (!this.lib.length) { list.append(el('div', 'empty', 'No tracks yet. Tap “+ Add tracks”.')); return; }
    this.lib.forEach((t, i) => {
      const row = el('div', 'track' + (i === this.sel ? ' sel' : ''));
      row.innerHTML = `<div class="nm">${t.title || t.name}<small>${t.artist || ''}</small></div><div class="bpm">${t.bpm ? t.bpm.toFixed(1) : '…'}</div><div class="dur">${t.duration ? fmtT(t.duration) : ''}</div>`;
      const a = el('button', 'btn', 'A'), b = el('button', 'btn blue', 'B'), x = el('button', 'del', '✕');
      a.onclick = e => { e.stopPropagation(); this.loadToDeck(0, t.id); }; b.onclick = e => { e.stopPropagation(); this.loadToDeck(1, t.id); };
      x.onclick = async e => { e.stopPropagation(); if (!confirm(`Remove ${t.name}?`)) return; await Library.remove(t.id); this.lib = this.lib.filter(z => z.id !== t.id); this.tracks.delete(t.id); this.renderLib(); };
      row.append(a, b, x); row.onclick = () => { this.sel = i; this.renderLib(); }; list.append(row);
    });
    const s = $('.track.sel', list); s?.scrollIntoView?.({ block: 'nearest' });
  },
  /* overview canvases (pre-rendered per track) */
  ovCache: [null, null],
  buildOverview(d, an) {
    const c = document.createElement('canvas'); const W = 600, H = 88; c.width = W; c.height = H; const g = c.getContext('2d');
    g.fillStyle = '#0e1219'; g.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x++) {
      const lo = an.bands[x * 3] / 255, mi = an.bands[x * 3 + 1] / 255, hi = an.bands[x * 3 + 2] / 255;
      const h = Math.max(lo, mi, hi) * H * 0.95;
      g.fillStyle = '#3b82f6'; g.fillRect(x, H / 2 - lo * H * 0.47, 1, lo * H * 0.94);
      g.fillStyle = '#f59e0b'; g.fillRect(x, H / 2 - mi * H * 0.4, 1, mi * H * 0.8);
      g.fillStyle = '#e2e8f0'; g.fillRect(x, H / 2 - hi * H * 0.3, 1, hi * H * 0.6);
    }
    this.ovCache[d] = c;
  },
};
window.app = app;

/* ================================================================== widgets */
function knob(node, get, set, opts = {}) {
  node.style.touchAction = 'none'; const ind = el('i'); node.append(ind);
  const draw = () => { const v = get(); node.style.setProperty('--rot', `${(v - 0.5) * 270}deg`); };
  let y0, v0; node.addEventListener('pointerdown', e => { y0 = e.clientY; v0 = get(); node.setPointerCapture(e.pointerId); e.preventDefault(); });
  node.addEventListener('pointermove', e => { if (y0 == null) return; set(Math.max(0, Math.min(1, v0 + (y0 - e.clientY) / 160))); draw(); });
  node.addEventListener('pointerup', () => y0 = null); node.addEventListener('pointercancel', () => y0 = null);
  node.addEventListener('dblclick', () => { set(opts.reset ?? 0.5); draw(); });
  node.addEventListener('wheel', e => { e.preventDefault(); set(Math.max(0, Math.min(1, get() - Math.sign(e.deltaY) * 0.02))); draw(); }, { passive: false });
  draw(); return { draw };
}
function fader(node, get, set, horizontal = false) {
  node.style.touchAction = 'none'; const cap = el('div', 'cap'); node.append(cap);
  const draw = () => node.style.setProperty('--v', get());
  const from = e => { const r = node.getBoundingClientRect(); return horizontal ? Math.max(0, Math.min(1, (e.clientX - r.left - 13) / (r.width - 26))) : Math.max(0, Math.min(1, 1 - (e.clientY - r.top - 11) / (r.height - 22))); };
  let on = false; node.addEventListener('pointerdown', e => { on = true; node.setPointerCapture(e.pointerId); set(from(e)); draw(); e.preventDefault(); });
  node.addEventListener('pointermove', e => { if (on) { set(from(e)); draw(); } }); node.addEventListener('pointerup', () => on = false); node.addEventListener('pointercancel', () => on = false);
  node.addEventListener('dblclick', () => { set(horizontal ? 0.5 : 1); draw(); });
  draw(); return { draw };
}
function jog(node, d) {
  node.style.touchAction = 'none'; let last = null, id = null;
  const ang = e => { const r = node.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)); };
  node.addEventListener('pointerdown', e => { id = e.pointerId; node.setPointerCapture(id); last = ang(e); app.jog(d, 'touch', true, app.shift); e.preventDefault(); });
  node.addEventListener('pointermove', e => { if (e.pointerId !== id) return; const a = ang(e); let da = a - last; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI; last = a; app.jog(d, 'tick', da / (2 * Math.PI) * 720, app.shift); });
  const up = () => { if (id == null) return; id = null; app.jog(d, 'touch', false, app.shift); };
  node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
  node.addEventListener('wheel', e => { e.preventDefault(); app.jog(d, 'tick', -Math.sign(e.deltaY) * 3, app.shift); }, { passive: false });
}
const hold = (node, fn) => { // press/release helper for buttons & pads (pointer + keyboard-safe)
  node.style.touchAction = 'none'; let down = false;
  node.addEventListener('pointerdown', e => { down = true; node.setPointerCapture(e.pointerId); fn(true, e); e.preventDefault(); });
  const up = e => { if (down) { down = false; fn(false, e); } }; node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
  node.addEventListener('contextmenu', e => e.preventDefault());
};

/* ================================================================== build the skin */
function buildDeck(d) {
  const dk = app.engine.decks[d], root = $(`#deck${d}`); root.innerHTML = ''; app.deckEl ||= []; app.deckEl[d] = root;
  const B = (key, label, cls = '', action = key) => { const b = el('button', `btn ${cls}`, label); hold(b, on => app.act(d, action, on, app.shift)); app.btn[d][key] = b; return b; };
  const loop = el('div', 'looprow');
  loop.append(B('loopIn', 'In', 'orange'), B('loopOut', 'Out', 'orange'), B('autoloop', '4 beat<br>/exit', 'tiny'), B('loopHalve', '½', 'tiny'), B('loopDouble', '2×', 'tiny'), B('reloop', 'reloop', 'tiny'), el('span', 'sp'), B('sync', 'Beat<br>sync', 'blue'), B('keylock', 'Key<br>lock', 'tiny green'));
  const tr = el('div', 'transport');
  const shiftB = el('button', 'btn shift', 'Shift'); hold(shiftB, on => { app.shift = on; app.render(); }); app.btn[d].shift = shiftB;
  tr.append(shiftB, B('cue', 'Cue', 'round orange'), B('play', '▶ ❚❚', 'big green'));
  const jw = el('div', 'jogwrap'); const j = el('div', 'jog'); j.innerHTML = '<div class="platter"></div><div class="lbl">SEARCH</div>'; jw.append(j); jog(j, d); app.jogDom[d] = j;
  const tw = el('div', 'tempowrap'); const tf = el('div', 'fader tall'); fader(tf, () => (dk.tempoSlider + 1) / 2 * -1 + 1, v => dk.setTempo((1 - v) * 2 - 1)); // top = slower, matching hardware print
  const tl = el('div', 'klabel', 'Tempo'); const tRange = el('button', 'btn tiny', '±8%'); hold(tRange, on => app.act(d, 'tempoRange', on)); app.btn[d].tempoRange = tRange;
  tw.append(B('vinyl', 'Vinyl', 'tiny'), tf, tl, tRange, B('headCue', '🎧 Cue', 'tiny blue'));
  const ps = el('div', 'padsec'); const modes = el('div', 'padmodes');
  [['hotcue', 'Hot cue', 'beat jump'], ['fxfade', 'FX fade', 'roll'], ['padscratch', 'Pad scratch', 'slicer'], ['sampler', 'Sampler', 'trans']].forEach(([m, l, s]) => {
    const b = el('button', 'btn', `${l}<small>${s}</small>`); b.dataset.mode = m; hold(b, on => { if (on) app.setPadMode(d, app.shift ? { hotcue: 'beatjump', fxfade: 'roll', padscratch: 'slicer', sampler: 'trans' }[m] : m); }); modes.append(b);
  });
  const grid = el('div', 'padgrid');
  for (let i = 0; i < 8; i++) { const p = el('div', 'pad'); hold(p, (on, e) => app.pad(d, i, on, e?.pressure ? Math.max(0.4, e.pressure) : 1, app.shift)); grid.append(p); app.padDom[d][i] = p; }
  ps.append(modes, grid);
  root.append(loop, tr, jw, tw, ps);
  dk.on('change', () => app.render()); dk.on('load', () => app.renderInfo(d));
}
function buildMixer() {
  const root = $('#mixer'), e = app.engine; root.innerHTML = '';
  const K = (label, get, set, cls = '') => { const w = el('div'); const k = el('div', `knob ${cls}`); knob(k, get, set); w.append(k, el('div', 'klabel', label)); return w; };
  const browse = el('div', 'browse'); const la = el('button', 'btn', 'Load A'), lb = el('button', 'btn blue', 'Load B');
  hold(la, on => on && app.load(0)); hold(lb, on => on && app.load(1));
  const bk = el('div', 'knob'); let acc = 0, lastV = 0.5; knob(bk, () => 0.5, v => { acc += v - lastV; lastV = v; if (Math.abs(acc) > 0.08) { app.browse(-Math.sign(acc)); acc = 0; } });
  bk.addEventListener('pointerdown', () => { lastV = 0.5; acc = 0; }); bk.addEventListener('pointerup', () => bk.style.setProperty('--rot', '0deg'));
  bk.addEventListener('dblclick', () => app.browseClick(false));
  browse.append(la, bk, lb);
  const dk = e.decks;
  const row = (label, k) => { const r = el('div', 'row'); r.append(K(label, () => dk[0].knobs[k], v => dk[0].setKnob(k, v)), el('div', 'sec', label), K(label, () => dk[1].knobs[k], v => dk[1].setKnob(k, v))); return r; };
  const top = el('div', 'row'); top.append(K('Trim', () => dk[0].knobs.trim, v => dk[0].setKnob('trim', v)), K('Master', () => e.masterVol, v => e.setMaster(v)), K('Trim', () => dk[1].knobs.trim, v => dk[1].setKnob('trim', v)));
  const cfx = el('div', 'row'); cfx.append(K('Filter', () => dk[0].knobs.cfx, v => dk[0].setKnob('cfx', v)), K('🎧 Level', () => 0.8, v => e.setHeadphone(v)), K('Filter', () => dk[1].knobs.cfx, v => dk[1].setKnob('cfx', v)));
  const faders = el('div', 'faders');
  const vu0 = el('div', 'vu', '<i></i>'), vu1 = el('div', 'vu', '<i></i>'); const f0 = el('div', 'fader'), f1 = el('div', 'fader');
  fader(f0, () => dk[0].knobs.fader, v => dk[0].setKnob('fader', v)); fader(f1, () => dk[1].knobs.fader, v => dk[1].setKnob('fader', v));
  faders.append(vu0, f0, f1, vu1); app.mixDom = { vu0, vu1 };
  const xf = el('div', 'xfader'); fader(xf, () => e.crossfader, v => e.setCrossfader(v), true);
  const fx = el('div', 'fxrow'); app.fxDom = [[], []];
  [0, 1].forEach(u => { const un = el('div', 'fxunit'); const bs = el('div', 'fxb'); ['Echo', 'Flange', 'Verb'].forEach((n, i) => { const b = el('button', 'btn', n); hold(b, on => app.fx(u, i, on)); bs.append(b); app.fxDom[u][i] = b; });
    un.append(el('div', 'klabel', `FX ${u + 1}`), bs, K('Depth', () => dk[u].fx.depth, v => dk[u].fx.setDepth(v))); fx.append(un); });
  root.append(browse, top, row('Hi', 'hi'), row('Mid', 'mid'), row('Low', 'low'), cfx, faders, el('div', 'klabel', 'Crossfader'), xf, el('div', 'sec', 'FX'), fx);
}
function buildDrumpad() {
  const root = $('#drumpad'); root.innerHTML = ''; app.drumDom = [];
  for (let i = 0; i < 16; i++) {
    const p = el('div', 'pad' + (i >= 8 ? ' b' : '')); let lp;
    hold(p, (on, e) => { if (on) { app.engine.sampler.play(i, e?.pressure ? Math.max(0.4, e.pressure) : 1); lp = setTimeout(() => pickSample(i), 600); } else clearTimeout(lp); });
    p.addEventListener('contextmenu', e => { e.preventDefault(); pickSample(i); });
    root.append(p); app.drumDom[i] = p;
  }
  app.engine.sampler.on('pad', (i, on) => { app.drumDom[i]?.classList.toggle('on', on); [0, 1].forEach(d => { if (app.engine.decks[d].padMode === 'sampler' && Math.floor(i / 8) === d) app.padDom[d][i % 8]?.classList.toggle('on', on); }); });
  app.engine.sampler.on('change', () => app.render());
  $('#samplerVol').oninput = e => app.engine.sampler.setVolume(+e.target.value);
  $('#kitReset').onclick = () => app.engine.sampler.loadKit();
}
function pickSample(i) { const inp = $('#padFile'); inp.onchange = async () => { if (inp.files[0]) { await app.engine.sampler.loadFile(i, inp.files[0]); toast(`Pad ${i + 1}: ${inp.files[0].name}`); } inp.value = ''; }; inp.click(); }

/* ================================================================== waveforms */
const scroll = $('#scroll'); const ov = [$('#ov0'), $('#ov1')]; const PPS = 90;
function fitCanvas(c) { const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight; if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; } return { g: c.getContext('2d'), w, h, dpr }; }
function drawFrame() {
  const e = app.engine; if (!e?.ready) return;
  const { g, w, h, dpr } = fitCanvas(scroll); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#05070b'; g.fillRect(0, 0, w, h);
  e.decks.forEach((dk, d) => {
    const y0 = d * h / 2, H = h / 2; const an = app.deckAn[d]; const pos = dk.pos;
    if (an && dk.buffer) {
      const dn = an.detail.length / 3; const i0 = Math.floor((pos - w / 2 / PPS) * 100), i1 = Math.ceil((pos + w / 2 / PPS) * 100);
      for (let i = Math.max(0, i0); i < Math.min(dn, i1); i++) {
        const x = w / 2 + (i / 100 - pos) * PPS; const lo = an.detail[i * 3] / 255, mi = an.detail[i * 3 + 1] / 255, hi = an.detail[i * 3 + 2] / 255;
        g.fillStyle = '#3b82f6'; g.fillRect(x, y0 + H / 2 - lo * H * 0.47, PPS / 100 + 0.5, lo * H * 0.94);
        g.fillStyle = '#f59e0b'; g.fillRect(x, y0 + H / 2 - mi * H * 0.4, PPS / 100 + 0.5, mi * H * 0.8);
        g.fillStyle = '#e2e8f0'; g.fillRect(x, y0 + H / 2 - hi * H * 0.28, PPS / 100 + 0.5, hi * H * 0.56);
      }
      if (dk.bpm) { const bl = dk.beatLen(); const b0 = Math.floor(dk.beatIndex(pos - w / 2 / PPS)); for (let b = b0; ; b++) { const t = dk.beatTime(b); const x = w / 2 + (t - pos) * PPS; if (x > w) break; if (x < 0 || t < 0) continue; g.fillStyle = b % 4 === 0 ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.18)'; g.fillRect(x, y0, 1, b % 4 === 0 ? H : H * 0.5); } }
      if (dk.loop.in >= 0 && dk.loop.out > dk.loop.in) { const x1 = w / 2 + (dk.loop.in - pos) * PPS, x2 = w / 2 + (dk.loop.out - pos) * PPS; g.fillStyle = dk.loop.on ? 'rgba(74,222,128,.18)' : 'rgba(74,222,128,.07)'; g.fillRect(x1, y0, x2 - x1, H); }
      dk.hotcues.forEach((c, i) => { if (c == null) return; const x = w / 2 + (c - pos) * PPS; g.fillStyle = d ? '#38bdf8' : '#ff8c1a'; g.fillRect(x - 1, y0, 2, H); g.font = 'bold 10px sans-serif'; g.fillText(i + 1, x + 3, y0 + 11); });
      const cx = w / 2 + (dk.cuePoint - pos) * PPS; g.fillStyle = '#f43f5e'; g.fillRect(cx - 1, y0 + H - 6, 2, 6);
    }
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, y0 + H - 1, w, 1);
    // time / bpm readouts
    const info = $(`#info${d}`); $('.time', info).textContent = dk.buffer ? fmtT(-dk.remaining) : '-00:00.0'; $('.elapsed', info).textContent = dk.buffer ? fmtT(pos) : '00:00.0';
    $('.bpm', info).textContent = dk.bpm ? dk.effBpm.toFixed(1) : '--.-';
    // overview
    const o = fitCanvas(ov[d]); o.g.setTransform(o.dpr, 0, 0, o.dpr, 0, 0); o.g.fillStyle = '#0e1219'; o.g.fillRect(0, 0, o.w, o.h);
    if (app.ovCache[d] && dk.buffer) { o.g.drawImage(app.ovCache[d], 0, 0, o.w, o.h); const x = pos / dk.duration * o.w; o.g.fillStyle = 'rgba(0,0,0,.45)'; o.g.fillRect(0, 0, x, o.h); o.g.fillStyle = '#fff'; o.g.fillRect(x - 1, 0, 2, o.h);
      dk.hotcues.forEach(c => { if (c != null) { o.g.fillStyle = d ? '#38bdf8' : '#ff8c1a'; o.g.fillRect(c / dk.duration * o.w - 1, 0, 2, 6); } }); }
    // platter spin + VU
    const pl = app.jogDom[d]?.firstElementChild; if (pl) pl.style.transform = `rotate(${(pos * 33.333 / 60 * 360) % 360}deg)`;
    app.mixDom[`vu${d}`]?.style.setProperty('--v', Math.min(1, dk.level));
  });
  g.fillStyle = '#ff3b3b'; g.fillRect(w / 2 - 1, 0, 2, h);
}
ov.forEach((c, d) => c.addEventListener('pointerdown', e => { const dk = app.engine?.decks[d]; if (!dk?.buffer) return; const r = c.getBoundingClientRect(); dk.seek((e.clientX - r.left) / r.width * dk.duration); }));
(function loop() { try { drawFrame(); } catch (e) { console.error(e); } requestAnimationFrame(loop); })();

/* ================================================================== keyboard */
const KEYS = { KeyQ: [0, 'play'], KeyW: [0, 'cue'], KeyE: [0, 'sync'], KeyR: [0, 'autoloop'], KeyT: [0, 'loopIn'], KeyY: [0, 'loopOut'], KeyP: [1, 'play'], KeyO: [1, 'cue'], KeyI: [1, 'sync'], KeyU: [1, 'autoloop'], BracketLeft: [1, 'loopIn'], BracketRight: [1, 'loopOut'] };
const PADS_A = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma'], PADS_B = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];
const DRUM = '1234qwerasdfzxcv';
const held = new Set();
window.addEventListener('keydown', e => {
  if (!app.engine?.ready || e.target.tagName === 'INPUT' || e.repeat) return;
  if (e.key === 'Shift') { app.shift = true; app.render(); return; }
  if (app.view === 'pads') { const i = DRUM.indexOf(e.key.toLowerCase()); if (i >= 0) { app.engine.sampler.play(i); e.preventDefault(); } return; }
  if (e.code === 'ArrowDown' || e.code === 'ArrowUp') { app.browse(e.code === 'ArrowDown' ? 1 : -1, true); e.preventDefault(); return; }
  if (e.code === 'Enter') { app.load(e.shiftKey ? 1 : 0); return; }
  if (e.code === 'Space') { e.preventDefault(); app.engine.decks.forEach(d => d.togglePlay()); return; }
  const k = KEYS[e.code]; if (k) { held.add(e.code); app.act(k[0], k[1], true, e.shiftKey); e.preventDefault(); return; }
  let i = PADS_A.indexOf(e.code); if (i >= 0) { held.add(e.code); app.pad(0, i, true, 1, e.shiftKey); return; }
  i = PADS_B.indexOf(e.code); if (i >= 0) { held.add(e.code); app.pad(1, i, true, 1, e.shiftKey); }
});
window.addEventListener('keyup', e => {
  if (e.key === 'Shift') { app.shift = false; app.render(); return; }
  if (!held.has(e.code)) return; held.delete(e.code);
  const k = KEYS[e.code]; if (k) return app.act(k[0], k[1], false, e.shiftKey);
  let i = PADS_A.indexOf(e.code); if (i >= 0) return app.pad(0, i, false, 1, e.shiftKey);
  i = PADS_B.indexOf(e.code); if (i >= 0) app.pad(1, i, false, 1, e.shiftKey);
});

/* ================================================================== boot */
async function start() {
  const btn = $('#start'); btn.disabled = true; btn.textContent = 'Loading…';
  try {
    app.engine = new Engine(); await app.engine.init(); app.engine.resume();
    app.engine.on('savecues', (id, hc) => Library.update(id, { hotcues: hc }));
    buildDeck(0); buildDeck(1); buildMixer(); buildDrumpad();
    app.lib = await Library.list(); app.renderLib();
    app.midi = new Midi(app); const ok = await app.midi.init();
    const ms = $('#midiStatus');
    app.on('midi', names => { ms.textContent = names.length ? names.join(', ') : (app.midi.available ? 'no controller' : 'no Web MIDI (use screen)'); ms.classList.toggle('on', names.length > 0); });
    if (!ok) ms.textContent = isIOS ? 'iPhone: touch mode' : 'no Web MIDI';
    if (localStorage.getItem('djsly.split') === '1') app.setSplit(true);
    $('#gate').classList.add('hide'); app.render();
    if (!app.lib.length) app.showView('library');
  } catch (err) { console.error(err); $('#gateNote').textContent = 'Could not start audio: ' + err.message; btn.disabled = false; btn.textContent = 'Retry'; }
}
$('#start').onclick = start;
$('#gateNote').textContent = isIOS ? 'Tip: add to Home Screen for full-screen. Silent switch must be off.' : (navigator.requestMIDIAccess ? 'Chrome/Edge: allow MIDI when asked.' : 'Safari/Firefox have no Web MIDI — on-screen controls still work.');
$$('#tabs button').forEach(b => b.onclick = () => app.showView(b.dataset.view));
$$('#mobileTabs button').forEach(b => b.onclick = () => { $$('#mobileTabs button').forEach(x => x.classList.toggle('on', x === b)); $$('.controller .part').forEach(p => p.classList.toggle('on', p.dataset.part === b.dataset.part)); });
const fileIn = $('#fileIn'); fileIn.onchange = () => { app.addFiles([...fileIn.files]); fileIn.value = ''; };
$('#addBtn').onclick = $('#addBtn2').onclick = () => fileIn.click();
$('#split').onclick = () => app.setSplit(!app.engine.splitCue);
let recOn = false; $('#rec').onclick = async () => {
  if (!recOn) { app.engine.startRec(); recOn = true; $('#rec').classList.add('on'); $('#rec').textContent = '■ Stop'; toast('Recording master'); return; }
  const blob = await app.engine.stopRec(); recOn = false; $('#rec').classList.remove('on'); $('#rec').textContent = '● Rec'; if (!blob) return;
  const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'; const d = new Date(), p = n => String(n).padStart(2, '0');
  const name = `djsly-set-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`; const file = new File([blob], name, { type: blob.type });
  if (isIOS && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch { } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast(`Saved ${name}`);
};
// drag & drop
const drop = $('#drop'); let dragN = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragN++; drop.classList.add('on'); });
window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; drop.classList.remove('on'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragN = 0; drop.classList.remove('on'); if (app.engine?.ready) app.addFiles([...e.dataTransfer.files]); else toast('Press Start first'); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
