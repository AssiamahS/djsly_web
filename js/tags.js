/* djsly tags — read what Serato / Mixed In Key / rekordbox / iTunes already wrote into the file, so the library doesn't guess.
 *   MP3 / AIFF / WAV : ID3v2.2–2.4 — TIT2 TPE1 TALB TCON TYER/TDRC TBPM TKEY APIC
 *                      + Serato GEOB frames: Autotags (bpm), BeatGrid (exact grid), Markers2 (hot cues)
 *   M4A / MP4       : ilst atoms — ©nam ©ART ©alb ©gen ©day tmpo covr ----:initialkey
 *   FLAC            : Vorbis comments TITLE ARTIST ALBUM GENRE DATE BPM INITIALKEY + PICTURE block
 * out: { title, artist, album, genre, year, bpm, key, camelot, art (Blob), firstBeat, hotcues[8] (sec), source }
 * Only fields that were actually found are set. Never throws on a bad tag — returns what it got.
 */
import { normKey } from './keys.js';

const latin1 = new TextDecoder('latin1'), utf8 = new TextDecoder('utf-8'), u16le = new TextDecoder('utf-16le'), u16be = new TextDecoder('utf-16be');
const ascii = (b, o, n) => latin1.decode(b.subarray(o, o + n));
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const synch = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const read = async (blob, start, len) => new Uint8Array(await blob.slice(start, start + len).arrayBuffer());

export async function readTags(file) {
  const out = {};
  try {
    const head = await read(file, 0, 12), magic = ascii(head, 0, 4);
    if (magic.startsWith('ID3')) await id3At(file, 0, out);
    else if (magic === 'fLaC') await flac(file, out);
    else if (ascii(head, 4, 4) === 'ftyp') await mp4(file, out);
    else if (magic === 'FORM' || magic === 'RIFF') await chunkedId3(file, magic === 'FORM', out);
  } catch (e) { console.warn('tags', file.name, e); }
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  return out;
}

/* ------------------------------------------------------------------ ID3v2 */
async function id3At(file, at, out) {
  const h = await read(file, at, 10); if (ascii(h, 0, 3) !== 'ID3') return;
  const ver = h[3], flags = h[5], size = synch(h, 6);
  let b = await read(file, at + 10, size);
  if (ver < 4 && flags & 0x80) b = unsync(b);                       // v2.2/2.3: whole-tag unsynchronisation
  let o = 0;
  if (flags & 0x40) o = ver === 4 ? synch(b, 0) : u32(b, 0) + 4;    // extended header
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  while (o + hdr <= b.length) {
    const id = ascii(b, o, idLen); if (!/^[A-Z0-9]+$/.test(id)) break;
    let len = ver === 2 ? (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5] : ver === 4 ? synch(b, o + 4) : u32(b, o + 4);
    if (ver === 4 && !validNext(b, o + hdr + len) && validNext(b, o + hdr + u32(b, o + 4))) len = u32(b, o + 4); // iTunes writes plain sizes in v2.4
    const fflags = ver === 2 ? 0 : b[o + 9];
    let d = b.subarray(o + hdr, o + hdr + len); o += hdr + len;
    if (ver === 4) { if (fflags & 0x01) d = d.subarray(4); if (fflags & 0x02) d = unsync(d); }
    if (ver === 3 && fflags & 0xC0 || ver === 4 && fflags & 0x0C) continue;                     // compressed / encrypted
    frame(ver === 2 ? V22[id] || id : id, d, out);
  }
}
const V22 = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TCO: 'TCON', TYE: 'TYER', TBP: 'TBPM', TKE: 'TKEY', PIC: 'PIC', GEO: 'GEOB' };
const validNext = (b, o) => o === b.length || o + 4 <= b.length && (b[o] === 0 || /^[A-Z0-9]{4}$/.test(ascii(b, o, 4)));
function unsync(b) { const r = new Uint8Array(b.length); let n = 0; for (let i = 0; i < b.length; i++) { r[n++] = b[i]; if (b[i] === 0xFF && b[i + 1] === 0) i++; } return r.subarray(0, n); }

/** Split off one encoded, NUL-terminated string. Returns [text, bytes consumed]. */
function str(d, enc, o = 0) {
  const wide = enc === 1 || enc === 2; let e = o;
  if (wide) { while (e + 1 < d.length && (d[e] || d[e + 1])) e += 2; } else { while (e < d.length && d[e]) e++; }
  const raw = d.subarray(o, e), end = Math.min(d.length, e + (wide ? 2 : 1)) - o;
  if (enc === 3) return [utf8.decode(raw), end];
  if (enc === 2) return [u16be.decode(raw), end];
  if (enc === 1) { const be = raw[0] === 0xFE && raw[1] === 0xFF, le = raw[0] === 0xFF && raw[1] === 0xFE; return [(be ? u16be : u16le).decode(be || le ? raw.subarray(2) : raw), end]; }
  return [latin1.decode(raw), end];
}
const text = d => str(d.subarray(1), d[0])[0].trim();

function frame(id, d, out) {
  if (!d.length) return;
  switch (id) {
    case 'TIT2': out.title = text(d); break;
    case 'TPE1': out.artist = text(d); break;
    case 'TALB': out.album = text(d); break;
    case 'TCON': out.genre = text(d).replace(/^\((\d+)\)$/, '').replace(/^\(\d+\)/, ''); break;
    case 'TYER': case 'TDRC': out.year = text(d).slice(0, 4); break;
    case 'TBPM': setBpm(out, parseFloat(text(d)), 'tag'); break;
    case 'TKEY': setKey(out, text(d)); break;
    case 'APIC': case 'PIC': {
      if (out.art) break;
      const enc = d[0]; let o = 1, mime;
      if (id === 'PIC') { mime = 'image/' + ascii(d, 1, 3).toLowerCase().replace('jpg', 'jpeg'); o = 4; }
      else { const [m, n] = str(d, 0, 1); mime = m || 'image/jpeg'; o = 1 + n; }
      o += 1; o += str(d, enc, o)[1];                                    // picture type, description
      if (o < d.length) out.art = new Blob([d.slice(o)], { type: mime.includes('/') ? mime : 'image/' + mime });
      break;
    }
    case 'GEOB': {
      const enc = d[0]; let o = 1;
      o += str(d, 0, o)[1];                                               // mime
      o += str(d, enc, o)[1];                                             // filename
      const [desc, n] = str(d, enc, o); serato(desc, d.subarray(o + n), out);
      break;
    }
  }
}

/* ------------------------------------------------------------------ Serato (GEOB payloads) */
function serato(desc, d, out) {
  if (desc === 'Serato Autotags' && d.length > 2) {                       // 01 01 "128.00\0" "-3.21\0" "0.000\0"
    setBpm(out, parseFloat(str(d, 0, 2)[0]), 'tag');
  } else if (desc === 'Serato BeatGrid' && d.length >= 14) {             // 01 00, u32 count, markers (f32 pos, u32 beats | f32 bpm)
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength), count = v.getUint32(2);
    if (!count || 6 + count * 8 > d.length) return;
    const pos0 = v.getFloat32(6);
    const bpm = count === 1 ? v.getFloat32(10) : v.getUint32(10) * 60 / (v.getFloat32(14) - pos0);
    if (pos0 >= 0 && bpm > 40 && bpm < 250) { out.firstBeat = pos0; setBpm(out, Math.round(bpm * 100) / 100, 'serato'); }
  } else if (desc === 'Serato Markers2' && d.length > 2) {               // 01 01 + base64( 01 01 {name\0 u32 len data}* )
    let b64 = latin1.decode(d.subarray(2)).replace(/[^A-Za-z0-9+/]/g, '');
    b64 = b64.slice(0, b64.length - (b64.length % 4 === 1 ? 1 : 0)); b64 += '='.repeat((4 - b64.length % 4) % 4);
    let b; try { b = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch { return; }
    let o = 2;
    while (o < b.length) {
      let e = o; while (e < b.length && b[e]) e++;
      const name = ascii(b, o, e - o); if (!name || e + 5 > b.length) break;
      const len = u32(b, e + 1), p = e + 5; o = p + len;
      if (name === 'CUE' && len >= 6) {                                   // 00, index, u32 ms, 00, rgb, 00 00, name\0
        const idx = b[p + 1], ms = u32(b, p + 2);
        if (idx < 8) { out.hotcues ||= Array(8).fill(null); out.hotcues[idx] = ms / 1000; }
      }
    }
  }
}
function setBpm(out, bpm, source) {
  if (!(bpm > 40 && bpm < 250)) return;
  if (out.source === 'serato' && source !== 'serato') return;            // the beatgrid beats a text tag
  out.bpm = bpm; out.source = source;
}
function setKey(out, raw) { const k = normKey(raw); if (k) { out.key = k.key; out.camelot = k.camelot; } }

/* ------------------------------------------------------------------ AIFF / WAV ("ID3 " / "id3 " chunk) */
async function chunkedId3(file, aiff, out) {
  let o = 12;
  while (o + 8 <= file.size) {
    const h = await read(file, o, 8), id = ascii(h, 0, 4).toLowerCase();
    const len = aiff ? u32(h, 4) : (h[4] | (h[5] << 8) | (h[6] << 16) | (h[7] << 24)) >>> 0;
    if (id === 'id3 ') return id3At(file, o + 8, out);
    o += 8 + len + (len & 1);
  }
}

/* ------------------------------------------------------------------ MP4 / M4A */
async function mp4(file, out) {
  let o = 0, moov = null;
  while (o + 8 <= file.size) {                                          // top level: find moov without reading mdat
    const h = await read(file, o, 16); let len = u32(h, 0); const type = ascii(h, 4, 4);
    if (len === 1) len = u32(h, 8) * 2 ** 32 + u32(h, 12); else if (len === 0) len = file.size - o;
    if (type === 'moov') { moov = await read(file, o + 8, len - 8); break; }
    if (len < 8) return; o += len;
  }
  if (!moov) return;
  const ilst = path(moov, ['udta', 'meta', 'ilst']); if (!ilst) return;
  for (const [type, item] of atoms(ilst)) {
    if (type === '----') {
      let name = '', data = null;
      for (const [t, a] of atoms(item)) { if (t === 'name') name = utf8.decode(a.subarray(4)); if (t === 'data') data = a; }
      if (data && /^(initialkey|key)$/i.test(name)) setKey(out, utf8.decode(data.subarray(8)));
      continue;
    }
    const data = atoms(item).find(([t]) => t === 'data')?.[1]; if (!data || data.length < 8) continue;
    const kind = u32(data, 0) & 0xFFFFFF, val = data.subarray(8), s = () => utf8.decode(val).trim();
    switch (type) {
      case '\xA9nam': out.title = s(); break;
      case '\xA9ART': out.artist = s(); break;
      case '\xA9alb': out.album = s(); break;
      case '\xA9gen': out.genre = s(); break;
      case '\xA9day': out.year = s().slice(0, 4); break;
      case 'tmpo': setBpm(out, (val[0] << 8) | val[1], 'tag'); break;
      case 'covr': if (!out.art) out.art = new Blob([val.slice()], { type: kind === 14 ? 'image/png' : 'image/jpeg' }); break;
    }
  }
}
function atoms(b) {
  const r = []; let o = 0;
  while (o + 8 <= b.length) { const len = u32(b, o); if (len < 8 || o + len > b.length) break; r.push([ascii(b, o + 4, 4), b.subarray(o + 8, o + len)]); o += len; }
  return r;
}
function path(b, names) {
  for (const n of names) {
    const hit = atoms(b).find(([t]) => t === n); if (!hit) return null;
    b = n === 'meta' ? hit[1].subarray(4) : hit[1];                      // meta is a full box (version + flags)
  }
  return b;
}

/* ------------------------------------------------------------------ FLAC */
async function flac(file, out) {
  let o = 4;
  for (let last = false; !last && o + 4 <= file.size;) {
    const h = await read(file, o, 4); last = !!(h[0] & 0x80);
    const type = h[0] & 0x7F, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) vorbis(await read(file, o + 4, len), out);
    else if (type === 6 && !out.art) {
      const b = await read(file, o + 4, len); let p = 4;
      const ml = u32(b, p); const mime = ascii(b, p + 4, ml); p += 4 + ml;
      p += 4 + u32(b, p) + 16; const dl = u32(b, p);
      out.art = new Blob([b.slice(p + 4, p + 4 + dl)], { type: mime || 'image/jpeg' });
    }
    o += 4 + len;
  }
}
function vorbis(b, out) {
  const le = o => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  let o = 4 + le(0); const n = le(o); o += 4;
  for (let i = 0; i < n && o + 4 <= b.length; i++) {
    const len = le(o), s = utf8.decode(b.subarray(o + 4, o + 4 + len)); o += 4 + len;
    const eq = s.indexOf('='); if (eq < 0) continue;
    const k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1).trim();
    if (k === 'TITLE') out.title = v; else if (k === 'ARTIST') out.artist = v; else if (k === 'ALBUM') out.album = v;
    else if (k === 'GENRE') out.genre = v; else if (k === 'DATE') out.year = v.slice(0, 4);
    else if (k === 'BPM' || k === 'TEMPO') setBpm(out, parseFloat(v), 'tag');
    else if (k === 'INITIALKEY' || k === 'KEY') setKey(out, v);
  }
}
