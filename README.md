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
- **Drumpad**: 16 slots = the SB3 **PAD SCRATCH** button on both decks (remapped on purpose). Ships with a synthesized kit; long‑press a pad to load your own sample.
- **Stems** (SB3 **SAMPLER** button): pads 1–4 = Vocal / Melody / Bass / Drums on‑off, 5 = Acapella, 6 = Instrumental, 7–8 = vocal / drums echo throw.
  Stems are **analysed automatically on import**, rekordbox‑style: the Mac runs a small Demucs server (`server/install.sh`, launchd,
  port 8813) and the app uploads each new track to it and stores the four stems on the device. The iPhone uses the same server:
  on home Wi‑Fi open `http://<mac-ip>:8813/`, anywhere else the app drops the track into the `djsly-stems` Cloudflare Worker
  (a KV job queue, `infra/relay`) and the Mac server picks it up over plain HTTPS, so it works even on networks that block tunnels.
  Token: `~/.djsly-stems-token` on the Mac = the Worker's `AGENT_TOKEN` secret. Without any server the pads run a 4‑band "lite" split
  and `tools/make-stems.sh` + the Stems button attach files by hand.
- **Quantize** (Q button, on by default): cue, hot cues and loop in/out snap to the beat grid, and a loaded track sits on its first downbeat, so cue → play always lands on the 1.
- **Key detection** (Camelot, coloured like Mixed In Key) in the library and deck headers.
- Library stored on the device (IndexedDB): add MP3/M4A/WAV/FLAC from Files/iCloud/drag‑drop; BPM + beat grid analysed in a worker.
- Rec button records the master straight to **MP3** (192k, lamejs in-browser; share sheet on iPhone).
- Colored scrolling waveform + overviews, beat markers, cue/loop/hot‑cue markers.
- Web MIDI: the SB3 is auto‑detected (Chrome/Edge). LEDs light up (play/cue/sync/loop/vinyl/keylock/pad modes/pads).
- Keyboard = the Serato DJ default layout (press `?` in the app for the picture): left deck on the Q row, right deck on the A row — REV / PLAY / PITCH− / PITCH+ / BEND− / BEND+ / CENSOR / JUMP CUE / LOOP IN / LOOP OUT / LOOP ON-OFF (Q W E R T Y U I O P [ and A S D F G H J K L ; '); ⇧Q/⇧W prev/next track, ⇧E/⇧R rewind/fast-forward, 1–5 / 6–0 hot cues (⇧ = set, ⌥ = clear), Z–N sampler 1–6, `,` `.` set cue, Tab browser, ← → load A/B, ↑↓ browse, F5/F10 key lock, Space = both decks.
- Pitch readout like every other DJ app: each deck shows BPM **and** the tempo change in % (e.g. 126 → 130 = +3.17%), and the key badge follows the pitch when key lock is off (+7 on the Camelot wheel per semitone).
- PWA: add to Home Screen on iPhone for full screen; works offline after first load.

## DDJ‑SB3 mapping
`controllers/ddj-sb3.js` — notes/CCs from Pioneer's MIDI list (as captured in the Mixxx preset). The app exposes a tiny API
(`act / pad / knob / mixer / jog / fx / browse / load`) so the **DDJ‑FLX4** mapping (v2) is one more file in `controllers/`.

## Not yet
Slip mode, decks 3/4, photo‑real controller skin (v3), streaming sources (YouTube/Spotify audio can't be routed into Web Audio).

## Dev
Any static server: `python3 -m http.server 8811` then open http://127.0.0.1:8811/. Web MIDI needs Chrome/Edge (not Safari).
