/* djsly analysis worker — BPM + beat-grid phase + waveform peaks, off the UI thread.
 * in : { id, L, R, sampleRate, cols }    (Float32Arrays, transferred)
 * out: { id, bpm, firstBeat (sec), peaks: {overview: Uint8Array(cols*2), bands: Uint8Array(cols*3)}, detail: Float32Array (per 1/100s energy) }
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
  // walk the phase back to the first beat of the file
  let firstFrame = start + bestPh; while (firstFrame - period >= 0) firstFrame -= period;
  const firstBeat = firstFrame * hop / sr;
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
  self.postMessage({ id, bpm, firstBeat, overview, bands, detail }, [overview.buffer, bands.buffer, detail.buffer]);
};
