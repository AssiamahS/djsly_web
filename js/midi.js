/* djsly Web MIDI bridge — finds a known controller by port name and hands it the app */
import * as SB3 from '../controllers/ddj-sb3.js';
const REGISTRY = [SB3];
export class Midi {
  constructor(app) { this.app = app; this.access = null; this.active = new Map(); this.monitor = null; this.available = !!navigator.requestMIDIAccess; }
  async init() {
    if (!this.available) return false;
    try { this.access = await navigator.requestMIDIAccess({ sysex: true }); }
    catch { try { this.access = await navigator.requestMIDIAccess(); } catch { return false; } }
    this.access.onstatechange = () => this.bind();
    this.bind(); return true;
  }
  bind() {
    const outs = [...this.access.outputs.values()];
    for (const inp of this.access.inputs.values()) {
      if (this.active.has(inp.id)) continue;
      const def = REGISTRY.find(d => d.match.test(inp.name || ''));
      const out = outs.find(o => def ? def.match.test(o.name || '') : o.name === inp.name) || null;
      const ctl = def ? def.create(this.app, out) : null;
      inp.onmidimessage = e => {
        const d = e.data; if (this.monitor) this.monitor(inp.name, d);
        if (ctl) ctl.onMessage(d); else this.app.genericMidi?.(d, inp.name);
      };
      this.active.set(inp.id, { inp, ctl, name: inp.name });
      if (ctl) { ctl.init?.(); this.app.toast(`${def.name} connected`); }
    }
    for (const [id, a] of this.active) if (![...this.access.inputs.values()].some(i => i.id === id)) { this.active.delete(id); this.app.toast(`${a.name} disconnected`); }
    this.app.emit?.('midi', [...this.active.values()].map(a => a.name));
  }
  refreshLeds() { for (const a of this.active.values()) a.ctl?.refreshLeds?.(); }
  get controllers() { return [...this.active.values()].map(a => ({ name: a.name, mapped: !!a.ctl })); }
}
