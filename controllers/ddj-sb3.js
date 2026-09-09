/* Pioneer DDJ-SB3 mapping (from the official MIDI list as captured in Mixxx's Pioneer-DDJ-SB3 preset).
 * Input: note-on/off on ch 1/2 (deck buttons), ch 7 (mixer buttons), ch 8/9 (deck 1/2 pads), ch 5/6 (fx units);
 *        14-bit CC on ch 1/2 (deck knobs/faders), ch 7 (mixer), ch 5/6 (fx knobs); jog ticks CC 0x21..0x23 (0x40 = rest).
 * Output: same note numbers light the LEDs (0x7F on / 0x00 off); pads on 0x97/0x98 with group base + pad.
 */
export const name = 'DDJ-SB3';
export const match = /DDJ-SB3/i;
export const PAD_BASE = { hotcue: 0x00, fxfade: 0x10, sampler: 0x20, stems: 0x30, beatjump: 0x40, roll: 0x50, slicer: 0x60, trans: 0x70 };
const MODE_NOTE = { hotcue: 0x1B, fxfade: 0x1E, sampler: 0x20, stems: 0x22, beatjump: 0x69, roll: 0x6B, slicer: 0x6D, trans: 0x6E };
const BTN = { // deck note → [action, shifted]
  0x0B: ['play'], 0x47: ['play', true], 0x0C: ['cue'], 0x48: ['cue', true], 0x58: ['sync'], 0x5C: ['sync', true],
  0x14: ['autoloop'], 0x50: ['reloop'], 0x12: ['loopHalve'], 0x13: ['loopDouble'], 0x61: ['loopIn'], 0x62: ['loopOut'],
  0x17: ['vinyl'], 0x40: ['slip'], 0x1A: ['keylock'], 0x60: ['tempoRange'], 0x54: ['headCue'], 0x68: ['headCue', true], 0x72: ['deckSelect'],
};
const DECK_CC = { 0x00: 'tempo', 0x04: 'trim', 0x07: 'hi', 0x0B: 'mid', 0x0F: 'low', 0x13: 'fader' };
const MIX_CC = { 0x08: 'master', 0x0D: 'headphone', 0x17: 'cfx0', 0x18: 'cfx1', 0x1F: 'crossfader' };

export function create(app, out) {
  const shift = [false, false]; const msb = {};
  const send = (st, n, v) => { try { out?.send([st, n, v]); } catch { } };
  const val14 = (chanKey, cc, v) => { // combine MSB (cc) + LSB (cc+0x20); returns 0..1 or null while waiting
    if (cc < 0x20) { msb[chanKey + cc] = v; return (v << 7) / 16383; }
    const m = msb[chanKey + (cc - 0x20)]; if (m == null) return null; return ((m << 7) | v) / 16383;
  };
  const ctl = {
    onMessage(d) {
      const st = d[0], n = d[1], v = d[2], type = st & 0xF0, ch = st & 0x0F;
      if (type === 0x90 || type === 0x80) {
        const on = type === 0x90 && v > 0;
        if (ch === 0 || ch === 1) return deckNote(ch, n, on);
        if (ch === 6) return mixerNote(n, on);
        if (ch === 7 || ch === 8) return app.pad(ch - 7, n & 0x07, on, v / 127, (n & 0x08) !== 0 || shift[ch - 7], padMode(n));
        if (ch === 4 || ch === 5) return fxNote(ch - 4, n, on);
        return;
      }
      if (type === 0xB0) {
        if (ch === 0 || ch === 1) return deckCC(ch, n, v);
        if (ch === 6) return mixerCC(n, v);
        if (ch === 4 || ch === 5) { const x = val14('fx' + ch, n === 0x12 ? 0x06 : n === 0x32 ? 0x26 : n, v); if (x != null) app.fxKnob(ch - 4, x); }
      }
    },
    init() { try { out?.send([0xF0, 0x00, 0x20, 0x7F, 0x03, 0x01, 0xF7]); } catch { } ctl.refreshLeds(); },
    refreshLeds() {
      if (!out) return;
      app.engine.decks.forEach((dk, i) => {
        const st = 0x90 + i;
        send(st, 0x0B, dk.playing ? 0x7F : 0); send(st, 0x0C, dk.buffer && !dk.playing ? 0x7F : 0);
        send(st, 0x14, dk.loop.on ? 0x7F : 0); send(st, 0x17, dk.vinyl ? 0x7F : 0); send(st, 0x1A, dk.keylock ? 0x7F : 0);
        send(st, 0x54, dk.cueOn ? 0x7F : 0); send(st, 0x58, dk.synced ? 0x7F : 0); send(st, 0x72, 0x7F);
        for (const m in MODE_NOTE) send(st, MODE_NOTE[m], dk.padMode === m ? 0x7F : 0);
        const ps = 0x97 + i;
        for (let p = 0; p < 8; p++) {
          send(ps, PAD_BASE.hotcue + p, dk.hotcues[p] != null ? 0x7F : 0);
          send(ps, PAD_BASE.sampler + p, app.engine.sampler.slots[i * 8 + p]?.buffer ? 0x7F : 0);
          send(ps, PAD_BASE.stems + p, p < 4 ? (dk.stemOn[p] ? 0x7F : 0) : 0x7F);
          for (const m of ['fxfade', 'beatjump', 'roll', 'slicer', 'trans']) send(ps, PAD_BASE[m] + p, 0x7F);
        }
        [0x47, 0x48, 0x49].forEach((nn, k) => send(0x94 + i, nn, dk.fx.on[k] ? 0x7F : 0));
      });
    },
    padLed(deck, mode, p, on) { send(0x97 + deck, PAD_BASE[mode] + p, on ? 0x7F : 0); },
  };
  const padMode = n => Object.keys(PAD_BASE).find(m => (n & 0x70) === PAD_BASE[m]) || 'hotcue';
  function deckNote(deck, n, on) {
    if (n === 0x3F) { shift[deck] = on; return; }
    if (n === 0x35 || n === 0x36 || n === 0x67) return app.jog(deck, 'touch', on, shift[deck]);
    const mode = Object.keys(MODE_NOTE).find(m => MODE_NOTE[m] === n);
    if (mode) { if (on) app.setPadMode(deck, mode); return; }
    const b = BTN[n]; if (b) app.act(deck, b[0], on, b[1] || shift[deck]);
  }
  function deckCC(deck, cc, v) {
    if (cc === 0x22 || cc === 0x23 || cc === 0x21 || cc === 0x1F || cc === 0x26) return app.jog(deck, 'tick', v - 0x40, cc === 0x1F || cc === 0x26 || shift[deck]);
    const base = cc >= 0x20 ? cc - 0x20 : cc; const k = DECK_CC[base]; if (!k) return;
    const x = val14('d' + deck, cc, v); if (x == null) return;
    if (k === 'tempo') app.knob(deck, 'tempo', x * 2 - 1); // top (0) = slower, bottom = faster, matching the +/- print
    else app.knob(deck, k, x);
  }
  function mixerNote(n, on) {
    if (n === 0x46 || n === 0x47) { if (on) app.load(n - 0x46); return; }
    if (n === 0x41) { if (on) app.browseClick(false); return; }
    if (n === 0x42) { if (on) app.browseClick(true); return; }
    if (n === 0x5B || n === 0x78) { if (on) app.act(0, 'masterCue', true, n === 0x78); return; }
    if (n === 0x58 || n === 0x60) { if (on) app.toggleView('fx'); return; }
    if (n === 0x59 || n === 0x61) { if (on) app.toggleView('pads'); return; }
  }
  function mixerCC(cc, v) {
    if (cc === 0x40 || cc === 0x64) return app.browse(v < 0x40 ? v : v - 0x80, cc === 0x64);
    const base = cc >= 0x20 ? cc - 0x20 : cc; const k = MIX_CC[base]; if (!k) return;
    const x = val14('m', cc, v); if (x == null) return;
    if (k === 'cfx0') app.knob(0, 'cfx', x); else if (k === 'cfx1') app.knob(1, 'cfx', x); else app.mixer(k, x);
  }
  function fxNote(unit, n, on) {
    const i = { 0x47: 0, 0x48: 1, 0x49: 2 }[n]; if (i != null) return app.fx(unit, i, on, false);
    const s = { 0x63: 0, 0x64: 1, 0x65: 2 }[n]; if (s != null) return app.fx(unit, s, on, true);
    if (n === 0x58 || n === 0x59) return app.fxBeat(unit, n === 0x59 ? 1 : -1);
  }
  return ctl;
}
