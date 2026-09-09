/* djsly analysis worker — BPM + beat-grid phase + waveform peaks, off the UI thread.
 * in : { id, L, R, sampleRate, cols }    (Float32Arrays, transferred)
 * out: { id, bpm, firstBeat (sec, a downbeat), key, camelot, overview, bands, detail }
 */
self.onmessage = e => {
  const { id, L, R, sampleRate: sr, cols } = e.data;
  const n = L.length;
  // ---------- mono + onset envelope ----------
  const hop = 512;
  const frames = Math.floor(n / hop);
  const env = new Float32Array(frames);
  const lowE = new Float32Array(frames), midE = new Float32Array(frames), hiE = new Float32Array(frames);
  // crude 3-band split with one-pole filters (cheap, good enough for a colored waveform)
  let lp = 0, lp2 = 0, hp = 0, prev = 0;
  const aL = Math.exp(-2 * Math.PI * 200 / sr), aH = Math.exp(-2 * Math.PI * 3000 / sr);
  for (let f = 0; f < frames; f++) {
    let s = 0, l = 0, m = 0, h = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) {
      const x = (L[base + i] + (R ? R[base + i] : L[base + i])) * 0.5;
      lp = aL * lp + (1 - aL) * x;            // <200 Hz
      lp2 = aH * lp2 + (1 - aH) * x;          // <3 kHz
      const lo = lp, mi = lp2 - lp, hi = x - lp2;
      s += x * x; l += lo * lo; m += mi * mi; h += hi * hi;
    }
    env[f] = Math.sqrt(s / hop); lowE[f] = Math.sqrt(l / hop); midE[f] = Math.sqrt(m / hop); hiE[f] = Math.sqrt(h / hop);
  }
  // onset strength = positive flux of log energy, smoothed
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const d = Math.log(1e-6 + env[f]) - Math.log(1e-6 + env[f - 1]);
    onset[f] = d > 0 ? d : 0;
  }
  // remove local mean
  const W = 16; const ons2 = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0, c = 0; for (let k = -W; k <= W; k++) { const j = f + k; if (j >= 0 && j < frames) { s += onset[j]; c++; } }
    ons2[f] = Math.max(0, onset[f] - s / c);
  }
  // ---------- tempo via autocorrelation over 60..200 BPM ----------
  const fps = sr / hop;
  const minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 60);
  const ac = new Float32Array(maxLag + 1);
  const span = Math.min(frames, Math.floor(fps * 120)); // analyse up to 2 min
  const start = Math.max(0, Math.floor((frames - span) / 2));
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0; for (let f = start; f < start + span - lag; f++) s += ons2[f] * ons2[f + lag];
    ac[lag] = s / (span - lag);
  }
  // score each candidate lag with its harmonics (2x and 0.5x) to fight octave errors, prefer 80-160
  let best = minLag, bestS = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 * fps / lag;
    let s = ac[lag];
    const l2 = lag * 2, lh = Math.round(lag / 2);
    if (l2 <= maxLag) s += 0.5 * ac[l2];
    if (lh >= minLag) s += 0.5 * ac[lh];
    if (bpm < 80 || bpm > 160) s *= 0.7;
    if (s > bestS) { bestS = s; best = lag; }
  }
  // refine lag with parabolic interpolation
  let lag = best;
  if (best > minLag && best < maxLag) {
    const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1];
    const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
    if (Math.abs(d) < 1) lag = best + d;
  }
  let bpm = 60 * fps / lag;
  // fine refinement: score bpm candidates ±2% at 0.01 steps by summing onset energy on a beat comb (best phase each)
  const combScore = b => {
    const per = 60 / b * fps; let bestS = 0; const nph = 24;
    for (let k = 0; k < nph; k++) { let s = 0; for (let t = k * per / nph; t < span; t += per) s += ons2[start + Math.round(t)] || 0; if (s > bestS) bestS = s; }
    return bestS;
  };
  let fineBest = bpm, fineS = -1;
  for (let b = bpm * 0.98; b <= bpm * 1.02; b += 0.01) { const s = combScore(b); if (s > fineS) { fineS = s; fineBest = b; } }
  bpm = fineBest;
  // snap near-integers (most produced music is on an integer bpm)
  if (Math.abs(bpm - Math.round(bpm)) < 0.06) bpm = Math.round(bpm);
  bpm = Math.round(bpm * 100) / 100;
  const period = 60 / bpm * fps; // frames per beat
  // ---------- phase: comb filter over the onset function ----------
  let bestPh = 0, bestPS = -1;
  const steps = Math.max(16, Math.round(period));
  for (let k = 0; k < steps; k++) {
    const ph = k * period / steps;
    let s = 0, c = 0;
    for (let t = ph; t < span && c < 400; t += period) { const f = Math.round(start + t); if (f < frames) { s += ons2[f]; c++; } }
    if (s > bestPS) { bestPS = s; bestPh = ph; }
  }
  // walk the phase back to the first beat of the file, then pick which of the 4 beats is the downbeat:
  // the "1" carries the most low-frequency onset energy (kick + bass hits) across the track
  let firstFrame = start + bestPh; while (firstFrame - period >= 0) firstFrame -= period;
  const lowOn = new Float32Array(frames); for (let f = 1; f < frames; f++) { const d = Math.log(1e-6 + lowE[f]) - Math.log(1e-6 + lowE[f - 1]); lowOn[f] = d > 0 ? d : 0; }
  let bestBar = 0, bestBarS = -1;
  for (let k = 0; k < 4; k++) { let s = 0; for (let t = firstFrame + k * period; t < frames; t += 4 * period) s += lowOn[Math.round(t)] + 0.5 * ons2[Math.round(t)]; if (s > bestBarS) { bestBarS = s; bestBar = k; } }
  firstFrame += bestBar * period; while (firstFrame - 4 * period >= 0) firstFrame -= 4 * period;
  const firstBeat = firstFrame * hop / sr;
  // ---------- key: chroma via FFT + Krumhansl profiles ----------
  const { key, camelot } = detectKey(L, R, sr);
  // ---------- waveform peaks ----------
  const overview = new Uint8Array(cols * 2); // min,max per column (0..255 around 128)
  const bands = new Uint8Array(cols * 3);
  const per = n / cols;
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * per), b = Math.min(n, Math.floor((c + 1) * per));
    let mn = 0, mx = 0;
    for (let i = a; i < b; i += 2) { const v = L[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    overview[c * 2] = Math.max(0, Math.min(255, 128 + mn * 127)); overview[c * 2 + 1] = Math.max(0, Math.min(255, 128 + mx * 127));
    const fa = Math.floor(a / hop), fb = Math.max(fa + 1, Math.floor(b / hop));
    let lo = 0, mi = 0, hi = 0; for (let f = fa; f < fb && f < frames; f++) { lo = Math.max(lo, lowE[f]); mi = Math.max(mi, midE[f]); hi = Math.max(hi, hiE[f]); }
    bands[c * 3] = Math.min(255, lo * 600); bands[c * 3 + 1] = Math.min(255, mi * 900); bands[c * 3 + 2] = Math.min(255, hi * 1400);
  }
  // detail envelope at 100 fps for the scrolling waveform (band-colored)
  const dfps = 100, dn = Math.floor(n / sr * dfps);
  const detail = new Uint8Array(dn * 3);
  for (let i = 0; i < dn; i++) {
    const fa = Math.floor(i / dfps * fps), fb = Math.max(fa + 1, Math.floor((i + 1) / dfps * fps));
    let lo = 0, mi = 0, hi = 0; for (let f = fa; f < fb && f < frames; f++) { lo = Math.max(lo, lowE[f]); mi = Math.max(mi, midE[f]); hi = Math.max(hi, hiE[f]); }
    detail[i * 3] = Math.min(255, lo * 600); detail[i * 3 + 1] = Math.min(255, mi * 900); detail[i * 3 + 2] = Math.min(255, hi * 1400);
  }
  self.postMessage({ id, bpm, firstBeat, key, camelot, overview, bands, detail }, [overview.buffer, bands.buffer, detail.buffer]);
};

function fft(re, im) { // in-place radix-2
  const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const a = i + j, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } }
}
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const CAMELOT_MAJ = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MIN = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function detectKey(L, R, sr) {
  const N = 8192, chroma = new Float64Array(12), re = new Float32Array(N), im = new Float32Array(N), win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const n = L.length, step = Math.max(N, Math.floor(n / 160)); // ≤160 frames across the track
  const binPc = new Int8Array(N / 2); for (let b = 1; b < N / 2; b++) { const f = b * sr / N; binPc[b] = f < 55 || f > 2200 ? -1 : ((Math.round(12 * Math.log2(f / 440)) % 12) + 21) % 12; }
  for (let s = 0; s + N <= n; s += step) {
    for (let i = 0; i < N; i++) { re[i] = (L[s + i] + (R ? R[s + i] : L[s + i])) * 0.5 * win[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 1; b < N / 2; b++) { const pc = binPc[b]; if (pc >= 0) chroma[pc] += Math.sqrt(re[b] * re[b] + im[b] * im[b]); }
  }
  const corr = (p, rot) => { let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0; for (let i = 0; i < 12; i++) { const x = chroma[(i + rot) % 12], y = p[i]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; } return (12 * sxy - sx * sy) / Math.sqrt((12 * sxx - sx * sx) * (12 * syy - sy * sy) || 1); };
  let best = { s: -2 }; for (let r = 0; r < 12; r++) { const cM = corr(MAJ, r), cm = corr(MIN, r); if (cM > best.s) best = { s: cM, r, minor: false }; if (cm > best.s) best = { s: cm, r, minor: true }; }
  return { key: NAMES[best.r] + (best.minor ? 'm' : ''), camelot: best.minor ? CAMELOT_MIN[best.r] : CAMELOT_MAJ[best.r] };
}
