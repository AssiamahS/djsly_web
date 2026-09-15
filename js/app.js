/* djsly — UI + glue. The controller mapping and the on-screen skin both talk to the small `app` API below. */
import { Engine, ROLL_SIZES, STEMS } from './engine.js';
import { Library } from './library.js';
import { Midi } from './midi.js';

const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const fmtPct = p => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(2)}%`;
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
      case 'quantize': if (pressed) { dk.quantize = !dk.quantize; toast(`Quantize ${dk.quantize ? 'on' : 'off'}`); } break;
      /* Serato-keyboard actions */
      case 'reverse': if (pressed) dk.setReverse(!dk.reverse); break;
      case 'pitchDown': if (pressed) dk.nudgeTempo(shift ? -0.01 : -0.0025); break;   // 0.25% per tap, 1% with shift
      case 'pitchUp': if (pressed) dk.nudgeTempo(shift ? 0.01 : 0.0025); break;
      case 'bendDown': dk.bendHold(pressed ? -0.04 : 0); break;                       // hold = temporary -4% (like a jog nudge)
      case 'bendUp': dk.bendHold(pressed ? 0.04 : 0); break;
      case 'censor': dk.censor(pressed); break;
      case 'jumpCue': if (pressed) dk.jumpCue(); break;
      case 'loopToggle': if (pressed) dk.reloop(); break;
      case 'setCue': if (pressed) { dk.setCuePoint(); toast(`${d ? 'B' : 'A'}: cue set ${fmtT(dk.cuePoint)}`); } break;
      case 'prevTrack': if (pressed) this.browse(-1, true); break;
      case 'nextTrack': if (pressed) this.browse(1, true); break;
      case 'rwd': case 'ff': { clearInterval(dk._scan); dk._scan = null; if (pressed && dk.buffer) { const dir = action === 'ff' ? 1 : -1; dk.seek(dk.pos + dir * 0.5); dk._scan = setInterval(() => dk.seek(dk.pos + dir * 0.5), 60); } break; }
    }
    this.render();
  },
  pad(d, i, pressed, vel = 1, shift = false, mode) {
    const dk = this.engine.decks[d]; mode = mode || dk.padMode;
    switch (mode) {
      case 'hotcue': dk.hotcue(i, pressed, shift); break;
      case 'fxfade': dk.padFx(i, pressed); break;
      case 'stems': dk.stemPad(i, pressed); break;
      case 'sampler': if (shift) this.engine.sampler.stop(d * 8 + i); else if (pressed) this.engine.sampler.play(d * 8 + i, vel); break;
      case 'beatjump': if (pressed) dk.beatJump([-1, 1, -2, 2, -4, 4, -8, 8][i] * (shift ? 4 : 1)); break;
      case 'roll': dk.loopRoll(ROLL_SIZES[i], pressed); break;
      case 'slicer': dk.slicerPad(i, pressed); break;
      case 'trans': dk.transPad(i, pressed); break;
    }
    this.padDom[d][i]?.classList.toggle('on', pressed);
    if (mode === 'hotcue' || mode === 'sampler' || mode === 'stems') this.render();
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
      this.analyzeTrack(meta.id).then(() => this.autoStems(meta.id)).catch(e => console.warn(e));
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
    const patch = { bpm: t.an.bpm, firstBeat: t.an.firstBeat, duration: t.buffer.duration, key: t.an.key, camelot: t.an.camelot };
    Object.assign(this.lib.find(x => x.id === id) || {}, patch); await Library.update(id, patch); this.renderLib();
    return t.an;
  },
  async loadToDeck(d, id) {
    const dk = this.engine.decks[d]; if (dk.playing && !confirm('Deck is playing. Load anyway?')) return;
    const meta = this.lib.find(x => x.id === id); toast(`Loading ${meta.name}…`);
    const t = await this.getBuffer(id); const an = await this.analyzeTrack(id);
    this.deckAn[d] = an; this.buildOverview(d, an);
    let stems = null;
    if (meta.hasStems) {
      if (!t.stems) { const row = await Library.get(id); t.stems = {}; for (const n of STEMS) t.stems[n] = await this.engine.decode(await row.stems[n].arrayBuffer()); }
      stems = t.stems;
    }
    await dk.load({ ...meta, bpm: an.bpm, firstBeat: an.firstBeat, key: an.key, camelot: an.camelot, buffer: t.buffer, stems });
    this.renderInfo(d); this.render(); toast(`${d ? 'B' : 'A'}: ${meta.name} · ${an.bpm} BPM`);
  },
  /* ---- stem server (Mac running server/stems_server.py; reachable direct, on the LAN, or through the relay) ---- */
  stemServer: null, stemJobs: new Set(),
  async findStemServer() {
    const cands = [localStorage.getItem('djsly.stemServer'), location.origin, 'http://127.0.0.1:8813', 'https://djsly-stems.sylvesterassiamahpm.workers.dev'].filter(Boolean);
    for (const u of [...new Set(cands)]) {
      try { const r = await fetch(u + '/health', { signal: AbortSignal.timeout(8000) }); const j = await r.json(); if (j.server === 'djsly-stems') { this.stemServer = u; this.stemAgent = j.agent || 'online'; break; } } catch { }
    }
    const s = $('#stemStatus'); if (s) { s.textContent = this.stemServer ? (this.stemAgent === 'offline' ? 'stems: mac offline' : 'stems: auto') : 'stems: manual'; s.classList.toggle('on', !!this.stemServer); s.title = this.stemServer || 'No stem server reachable — run server/install.sh on the Mac'; }
    return this.stemServer;
  },
  async autoStems(id) {
    if (!this.stemServer || this.stemJobs.has(id)) return false;
    const meta = this.lib.find(x => x.id === id); if (!meta || meta.hasStems) return false;
    this.stemJobs.add(id); meta.stemming = true; this.renderLib();
    try {
      const row = await Library.get(id);
      const bytes = await row.blob.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      const r = await fetch(this.stemServer + '/stems', { method: 'POST', headers: { 'X-Filename': row.name + '.' + (row.type.split('/')[1] || 'mp3'), 'X-Hash': hash, 'Content-Type': 'application/octet-stream' }, body: bytes });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      let job = await r.json();
      for (let n = 0; job.status !== 'done'; n++) {             // poll; the Mac keeps working even if this tab goes to sleep
        if (job.status === 'error') throw new Error(job.error || 'separation failed');
        if (n > 600) throw new Error('timed out');
        await new Promise(res => setTimeout(res, 3000));
        job = await fetch(`${this.stemServer}/stems/${job.id}`).then(x => x.json()).catch(() => job);
      }
      const stems = {};
      for (const n of STEMS) { const rr = await fetch(`${this.stemServer}/stems/${job.id}/${n}`); if (!rr.ok) throw new Error(`${n} ${rr.status}`); stems[n] = new Blob([await rr.arrayBuffer()], { type: 'audio/mpeg' }); }
      await Library.update(id, { stems }); meta.hasStems = true; const t = this.tracks.get(id); if (t) t.stems = null;
      toast(`Stems ready: ${meta.name}`); return true;
    } catch (e) { console.warn('stems', e); toast(`Stems failed: ${e.message}`); return false; }
    finally { this.stemJobs.delete(id); meta.stemming = false; this.renderLib(); }
  },
  importStems(id) {
    if (this.stemServer) return this.autoStems(id);
    const inp = $('#stemFile');
    inp.onchange = async () => {
      const files = [...inp.files]; inp.value = ''; const got = {};
      for (const f of files) { const n = STEMS.find(s => f.name.toLowerCase().includes(s)); if (n) got[n] = f; }
      const missing = STEMS.filter(s => !got[s]);
      if (missing.length) return toast(`Need vocals/other/bass/drums files — missing ${missing.join(', ')}`);
      await Library.update(id, { stems: got }); const m = this.lib.find(x => x.id === id); if (m) m.hasStems = true; const t = this.tracks.get(id); if (t) t.stems = null;
      this.renderLib(); toast('Stems attached — load the track again');
    };
    inp.click();
  },
  showView(v) { this.view = v; $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v)); $$('.view').forEach(s => s.classList.toggle('on', s.dataset.view === v)); },
  /* ---- rendering ---- */
  padDom: [[], []], jogDom: [], btn: [{}, {}], knobDom: [{}, {}], mixDom: {},
  render() { clearTimeout(this._rt); this._rt = setTimeout(() => this._render(), 8); },
  _render() {
    this.engine.decks.forEach((dk, d) => {
      const b = this.btn[d]; const set = (k, on) => b[k]?.classList.toggle('on', !!on);
      set('play', dk.playing); set('cue', dk.buffer && !dk.playing); set('quantize', dk.quantize); set('sync', dk.synced); set('autoloop', dk.loop.on); set('vinyl', dk.vinyl); set('keylock', dk.keylock); set('headCue', dk.cueOn); set('shift', this.shift);
      b.tempoRange && (b.tempoRange.textContent = `±${Math.round(dk.tempoRange * 100)}%`);
      b.tempoLabel && (b.tempoLabel.textContent = `Tempo ${fmtPct(dk.pitchPct)}`);
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
        else if (m === 'stems') { label = ['Vocal', 'Melody', 'Bass', 'Drums', 'Acapella', 'Instru', 'Vocal echo', 'Drums echo'][i]; sub = i < 4 ? (dk.hasStems ? 'stem' : 'lite') : i < 6 ? 'toggle' : 'hold';
          lit = i < 4 ? dk.stemOn[i] : i === 4 ? (dk.stemOn[0] && !dk.stemOn[1] && !dk.stemOn[2] && !dk.stemOn[3]) : i === 5 ? (!dk.stemOn[0] && dk.stemOn[1] && dk.stemOn[2] && dk.stemOn[3]) : true; }
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
    const k = $('.key', info); k.textContent = dk.effCamelot; k.dataset.c = dk.effCamelot; k.title = dk.effKey; dk._keyShown = dk.effCamelot;
    $('.bpm', info).title = dk.bpm ? `original ${dk.bpm.toFixed(1)} BPM` : '';
  },
  renderLib() {
    const list = $('#libList'); list.innerHTML = '';
    if (!this.lib.length) { list.append(el('div', 'empty', 'No tracks yet. Tap “+ Add tracks”.')); return; }
    this.lib.forEach((t, i) => {
      const row = el('div', 'track' + (i === this.sel ? ' sel' : ''));
      row.innerHTML = `<div class="nm">${t.title || t.name}<small>${t.artist || ''}${t.hasStems ? ' · <em>STEMS</em>' : t.stemming ? ' · <em class="busy">STEMS…</em>' : ''}</small></div><span class="key" data-c="${t.camelot || ''}" title="${t.key || ''}">${t.camelot || ''}</span><div class="bpm">${t.bpm ? t.bpm.toFixed(1) : '…'}</div><div class="dur">${t.duration ? fmtT(t.duration) : ''}</div>`;
      const a = el('button', 'btn', 'A'), b = el('button', 'btn blue', 'B'), st = el('button', 'btn tiny' + (t.hasStems ? ' on' : ''), 'Stems'), x = el('button', 'del', '✕');
      st.onclick = e => { e.stopPropagation(); this.importStems(t.id); };
      a.onclick = e => { e.stopPropagation(); this.loadToDeck(0, t.id); }; b.onclick = e => { e.stopPropagation(); this.loadToDeck(1, t.id); };
      x.onclick = async e => { e.stopPropagation(); if (!confirm(`Remove ${t.name}?`)) return; await Library.remove(t.id); this.lib = this.lib.filter(z => z.id !== t.id); this.tracks.delete(t.id); this.renderLib(); };
      row.append(a, b, st, x); row.onclick = () => { this.sel = i; this.renderLib(); }; list.append(row);
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
  loop.append(B('loopIn', 'In', 'orange'), B('loopOut', 'Out', 'orange'), B('autoloop', '4 beat<br>/exit', 'tiny'), B('loopHalve', '½', 'tiny'), B('loopDouble', '2×', 'tiny'), B('reloop', 'reloop', 'tiny'), el('span', 'sp'), B('quantize', 'Q', 'tiny green'), B('sync', 'Beat<br>sync', 'blue'), B('keylock', 'Key<br>lock', 'tiny green'));
  const tr = el('div', 'transport');
  const shiftB = el('button', 'btn shift', 'Shift'); hold(shiftB, on => { app.shift = on; app.render(); }); app.btn[d].shift = shiftB;
  tr.append(shiftB, B('cue', 'Cue', 'round orange'), B('play', '▶ ❚❚', 'big green'));
  const jw = el('div', 'jogwrap'); const j = el('div', 'jog'); j.innerHTML = '<div class="platter"></div><div class="lbl">SEARCH</div>'; jw.append(j); jog(j, d); app.jogDom[d] = j;
  const tw = el('div', 'tempowrap'); const tf = el('div', 'fader tall'); fader(tf, () => (dk.tempoSlider + 1) / 2 * -1 + 1, v => dk.setTempo((1 - v) * 2 - 1)); // top = slower, matching hardware print
  const tl = el('div', 'klabel', 'Tempo 0.00%'); app.btn[d].tempoLabel = tl; const tRange = el('button', 'btn tiny', '±8%'); hold(tRange, on => app.act(d, 'tempoRange', on)); app.btn[d].tempoRange = tRange;
  tw.append(B('vinyl', 'Vinyl', 'tiny'), tf, tl, tRange, B('headCue', '🎧 Cue', 'tiny blue'));
  const ps = el('div', 'padsec'); const modes = el('div', 'padmodes');
  [['hotcue', 'Hot cue', 'beat jump'], ['fxfade', 'FX fade', 'roll'], ['sampler', 'Sampler', 'slicer'], ['stems', 'Stems', 'trans']].forEach(([m, l, s]) => {
    const b = el('button', 'btn', `${l}<small>${s}</small>`); b.dataset.mode = m; hold(b, on => { if (on) app.setPadMode(d, app.shift ? { hotcue: 'beatjump', fxfade: 'roll', sampler: 'slicer', stems: 'trans' }[m] : m); }); modes.append(b);
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
    const pe = $('.pitch', info); const pt = dk.buffer ? fmtPct(dk.pitchPct) : ''; if (pe.textContent !== pt) { pe.textContent = pt; pe.classList.toggle('off', Math.abs(dk.pitchPct) > 0.005); }
    if (dk.buffer && dk._keyShown !== dk.effCamelot) { const k = $('.key', info); k.textContent = dk.effCamelot; k.dataset.c = dk.effCamelot; k.title = dk.effKey + (dk.semitoneShift ? ` (was ${dk.track?.key}, pitch ${dk.semitoneShift > 0 ? '+' : ''}${dk.semitoneShift} st)` : ''); dk._keyShown = dk.effCamelot; }
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

/* ================================================================== keyboard — Serato DJ default layout (see keys.png / press ?) */
// [deck, action, shift-action]. Left deck = Q row, right deck = A row, like Serato.
const KEYS = {
  KeyQ: [0, 'reverse', 'prevTrack'], KeyW: [0, 'play', 'nextTrack'], KeyE: [0, 'pitchDown', 'rwd'], KeyR: [0, 'pitchUp', 'ff'], KeyT: [0, 'bendDown'], KeyY: [0, 'bendUp'],
  KeyU: [0, 'censor'], KeyI: [0, 'jumpCue'], KeyO: [0, 'loopIn'], KeyP: [0, 'loopOut'], BracketLeft: [0, 'loopToggle'],
  KeyA: [1, 'reverse', 'prevTrack'], KeyS: [1, 'play', 'nextTrack'], KeyD: [1, 'pitchDown', 'rwd'], KeyF: [1, 'pitchUp', 'ff'], KeyG: [1, 'bendDown'], KeyH: [1, 'bendUp'],
  KeyJ: [1, 'censor'], KeyK: [1, 'jumpCue'], KeyL: [1, 'loopIn'], Semicolon: [1, 'loopOut'], Quote: [1, 'loopToggle'],
  Comma: [0, 'setCue'], Period: [1, 'setCue'], F5: [0, 'keylock'], F10: [1, 'keylock'],
};
const CUES_A = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'], CUES_B = ['Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0']; // 1-5 = deck A hot cues, 6-0 = deck B
const SAMPS = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN'];                                                            // Z–N = sampler 1-6
const DRUM = '1234qwerasdfzxcv';
const held = new Map();
const hotcueKey = (d, i, e) => { const dk = app.engine.decks[d]; if (!dk.buffer) return; if (e.altKey) { dk.hotcues[i] = null; dk._saveCues(); app.render(); } else if (e.shiftKey) { dk.hotcues[i] = dk.snap(dk.pos); dk._saveCues(); app.render(); } else app.pad(d, i, true, 1, false, 'hotcue'); };
window.addEventListener('keydown', e => {
  if (!app.engine?.ready || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey) return;
  if (e.key === 'Shift') { app.shift = true; app.render(); return; }
  if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) { e.preventDefault(); if (!e.repeat) toggleKeys(); return; }
  if (e.code === 'Escape') { $('#keysOverlay').classList.remove('on'); return; }
  if (app.view === 'pads') { if (e.repeat) return; const i = DRUM.indexOf(e.key.toLowerCase()); if (i >= 0) { app.engine.sampler.play(i); e.preventDefault(); } return; }
  if (e.code === 'ArrowDown' || e.code === 'ArrowUp') { app.browse(e.code === 'ArrowDown' ? 1 : -1, true); e.preventDefault(); return; }
  if (e.repeat) return;
  if (e.code === 'ArrowLeft') { app.load(0); e.preventDefault(); return; }   // LOAD ←
  if (e.code === 'ArrowRight') { app.load(1); e.preventDefault(); return; }  // LOAD →
  if (e.code === 'Enter') { app.load(e.shiftKey ? 1 : 0); return; }
  if (e.code === 'Tab') { e.preventDefault(); app.toggleView('library'); return; }   // BR.WINDOW
  if (e.code === 'Space') { e.preventDefault(); app.engine.decks.forEach(d => d.togglePlay()); return; }
  if (e.code === 'Slash') { toast('Swap decks: not in djsly (A is always left)'); return; }
  const k = KEYS[e.code];
  if (k) { const action = e.shiftKey && k[2] ? k[2] : k[1]; held.set(e.code, [k[0], action]); app.act(k[0], action, true, e.shiftKey && !k[2]); e.preventDefault(); return; }
  let i = CUES_A.indexOf(e.code); if (i >= 0) { held.set(e.code, ['cue', 0, i]); hotcueKey(0, i, e); e.preventDefault(); return; }
  i = CUES_B.indexOf(e.code); if (i >= 0) { held.set(e.code, ['cue', 1, i]); hotcueKey(1, i, e); e.preventDefault(); return; }
  i = SAMPS.indexOf(e.code); if (i >= 0) { e.shiftKey ? app.engine.sampler.stop(i) : app.engine.sampler.play(i); e.preventDefault(); }
});
window.addEventListener('keyup', e => {
  if (e.key === 'Shift') { app.shift = false; app.render(); return; }
  const h = held.get(e.code); if (!h) return; held.delete(e.code);
  if (h[0] === 'cue') return app.pad(h[1], h[2], false, 1, false, 'hotcue');
  app.act(h[0], h[1], false, false);
});
window.addEventListener('blur', () => { for (const [code, h] of held) { held.delete(code); if (h[0] === 'cue') app.pad(h[1], h[2], false, 1, false, 'hotcue'); else app.act(h[0], h[1], false, false); } });
function toggleKeys(force) { const o = $('#keysOverlay'); o.classList.toggle('on', force); }
$('#keysBtn').onclick = () => toggleKeys(); $('#keysOverlay').onclick = () => toggleKeys(false);

/* ================================================================== boot */
async function start() {
  const btn = $('#start'); btn.disabled = true; btn.textContent = 'Loading…';
  try {
    app.engine = new Engine(); await app.engine.init(); app.engine.resume();
    app.engine.on('savecues', (id, hc) => Library.update(id, { hotcues: hc }));
    buildDeck(0); buildDeck(1); buildMixer(); buildDrumpad();
    app.lib = await Library.list(); app.renderLib();
    app.findStemServer().then(ok => { if (ok) app.lib.filter(t => !t.hasStems && t.bpm).forEach(t => app.autoStems(t.id)); });
    app.midi = new Midi(app); const ok = await app.midi.init();
    const ms = $('#midiStatus');
    app.on('midi', names => { ms.textContent = names.length ? names.join(', ') : (app.midi.available ? 'no controller' : 'no Web MIDI (use screen)'); ms.classList.toggle('on', names.length > 0); });
    if (!ok) ms.textContent = isIOS ? 'iPhone: touch mode' : 'no Web MIDI';
    if (window.__djslyNative?.midi && !app.midi.controllers.length) ms.textContent = 'plug in the SB3';
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
  const ext = blob.type === 'audio/mpeg' ? 'mp3' : blob.type.includes('mp4') ? 'm4a' : 'webm'; const d = new Date(), p = n => String(n).padStart(2, '0');
  const name = `djsly-set-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`; const file = new File([blob], name, { type: blob.type });
  if (window.__djslyNative?.file) { // native app: write into Documents (visible in Files) + share sheet
    const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
    window.webkit.messageHandlers.file.postMessage({ name, b64 }); toast(`Saved ${name} to Files`); return;
  }
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
