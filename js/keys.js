/* djsly keys — Camelot tables + tag-string normalisation + harmonic matching (shared by the analysis worker and the library) */
export const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const CAMELOT_MAJ = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
export const CAMELOT_MIN = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Whatever a tagger wrote in TKEY / INITIALKEY ("Am", "A minor", "08A", "8a", "G#m", "Open Key 1m") → { key, camelot } or null. */
export function normKey(raw) {
  const s = String(raw || '').trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  if (!s) return null;
  let m = s.match(/^0?(1[0-2]|[1-9])\s*([AaBb])$/);                       // Camelot
  if (m) return fromCamelot(`${+m[1]}${m[2].toUpperCase()}`);
  m = s.match(/^0?(1[0-2]|[1-9])\s*([dDmM])$/);                            // Open Key: 1d = C = 8B
  if (m) return fromCamelot(`${(+m[1] + 6) % 12 + 1}${/m/i.test(m[2]) ? 'A' : 'B'}`);
  m = s.match(/^([A-Ga-g])\s*([#b]?)\s*(m|min|minor|-)?\s*(maj|major)?$/);  // musical
  if (!m) return null;
  const r = (PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? 11 : 0)) % 12, minor = !!m[3];
  return { key: NAMES[r] + (minor ? 'm' : ''), camelot: (minor ? CAMELOT_MIN : CAMELOT_MAJ)[r] };
}
function fromCamelot(c) {
  let r = CAMELOT_MIN.indexOf(c); if (r >= 0) return { key: NAMES[r] + 'm', camelot: c };
  r = CAMELOT_MAJ.indexOf(c); return r >= 0 ? { key: NAMES[r], camelot: c } : null;
}

/** Mixes cleanly from `a` into `b`: same key, ±1 on the wheel, or relative major/minor. */
export function camelotFits(a, b) {
  const pa = String(a || '').match(/^(\d+)([AB])$/), pb = String(b || '').match(/^(\d+)([AB])$/);
  if (!pa || !pb) return false;
  const d = Math.abs(+pa[1] - +pb[1]) % 12, step = Math.min(d, 12 - d);
  return pa[2] === pb[2] ? step <= 1 : step === 0;
}
/** Within ±pct of each other, also counting half/double time. */
export function bpmFits(a, b, pct = 6) {
  if (!a || !b) return false;
  return [b, b * 2, b / 2].some(x => Math.abs(a - x) / x * 100 <= pct);
}
