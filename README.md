# djsly — DDJ‑SB3 Web DJ

Browser DJ player for the Pioneer **DDJ‑SB3**, in the spirit of Tribe's web player but free and yours.
Static site, no build step, runs on GitHub Pages and on iPhone.

**Live:** https://assiamahs.github.io/djsly_web/

## What works (v1)
- Two decks with sample‑accurate playback engine (AudioWorklet): play/cue (Pioneer cue behaviour), 8 hot cues,
  auto/manual loops, ½ / 2× loop, loop roll, beat jump, slicer, trans (beat gate), key lock (granular), tempo ±8/16/50%,
  beat sync (tempo + phase), vinyl‑mode scratch, pitch bend, brake / backspin / echo‑out / reverse pad FX, pad‑scratch gestures.
- Mixer: trim, 3‑band EQ, filter (CFX), channel faders, crossfader, master + limiter, VU meters, headphone cue with **split cue**
  (master in the left ear, cue in the right) since browsers only have one output.
- FX per deck: echo (beat‑synced), flanger, reverb + depth knob.
- **Drumpad**: 16 slots = SB3 SAMPLER mode on both decks. Ships with a synthesized kit; long‑press a pad to load your own sample.
- Library stored on the device (IndexedDB): add MP3/M4A/WAV/FLAC from Files/iCloud/drag‑drop; BPM + beat grid analysed in a worker.
- Rec button records the master to a file (share sheet on iPhone).
- Colored scrolling waveform + overviews, beat markers, cue/loop/hot‑cue markers.
- Web MIDI: the SB3 is auto‑detected (Chrome/Edge). LEDs light up (play/cue/sync/loop/vinyl/keylock/pad modes/pads).
- Keyboard: Q/W/E/R = play/cue/sync/loop (deck A), P/O/I/U (deck B), Z–, pads A, 1–8 pads B, Space both, ↑↓ browse, Enter load A, ⇧Enter load B.
- PWA: add to Home Screen on iPhone for full screen; works offline after first load.

## DDJ‑SB3 mapping
`controllers/ddj-sb3.js` — notes/CCs from Pioneer's MIDI list (as captured in the Mixxx preset). The app exposes a tiny API
(`act / pad / knob / mixer / jog / fx / browse / load`) so the **DDJ‑FLX4** mapping (v2) is one more file in `controllers/`.

## Not yet
Slip mode, decks 3/4, key detection, streaming sources (YouTube/Spotify audio can't be routed into Web Audio).

## Dev
Any static server: `python3 -m http.server 8811` then open http://127.0.0.1:8811/. Web MIDI needs Chrome/Edge (not Safari).
