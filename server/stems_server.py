#!/opt/homebrew/opt/python@3.14/bin/python3.14
"""djsly stem server — runs on the Mac, splits tracks with Demucs so the web app can auto-analyse stems.

  GET  /health          → {"ok":true,"model":"htdemucs","busy":n}
  POST /stems           body = audio file bytes, header X-Filename → {"vocals":b64,"other":b64,"bass":b64,"drums":b64}
  GET  /<static>        serves the djsly web app itself (so a phone on the same Wi-Fi can use http://<mac-ip>:8813/)

Results are cached by content hash in ~/djsly-stems/cache/<sha1>/ so a track is only split once.
"""
import base64, hashlib, json, os, shutil, subprocess, sys, tempfile, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get("DJSLY_STEMS_PORT", "8813"))
MODEL = os.environ.get("DJSLY_STEMS_MODEL", "htdemucs")
CACHE = os.path.expanduser(os.environ.get("DJSLY_STEMS_DIR", "~/djsly-stems")) + "/cache"
WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMUCS = shutil.which("demucs") or "/opt/homebrew/bin/demucs"
STEMS = ["vocals", "other", "bass", "drums"]
lock = threading.Lock()   # demucs eats every core; one job at a time
busy = 0

def separate(data: bytes, name: str) -> dict:
    global busy
    h = hashlib.sha1(data).hexdigest()
    out = os.path.join(CACHE, h)
    if not all(os.path.exists(os.path.join(out, s + ".mp3")) for s in STEMS):
        ext = os.path.splitext(name)[1] or ".mp3"
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "track" + ext)
            with open(src, "wb") as f: f.write(data)
            with lock:
                busy += 1
                try:
                    subprocess.run([DEMUCS, "-n", MODEL, "--mp3", "--mp3-bitrate", "192", "-o", tmp, src], check=True, capture_output=True)
                finally:
                    busy -= 1
            os.makedirs(out, exist_ok=True)
            for s in STEMS:
                shutil.move(os.path.join(tmp, MODEL, "track", s + ".mp3"), os.path.join(out, s + ".mp3"))
    res = {}
    for s in STEMS:
        with open(os.path.join(out, s + ".mp3"), "rb") as f: res[s] = base64.b64encode(f.read()).decode()
    return res

class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=WEB, **k)
    def log_message(self, fmt, *args): sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    def end_headers(self):
        self._cors(); super().end_headers()
    def do_OPTIONS(self):
        self.send_response(204); self.end_headers()
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/health": return self._json(200, {"ok": True, "model": MODEL, "busy": busy, "server": "djsly-stems"})
        return super().do_GET()
    def do_POST(self):
        if self.path != "/stems": return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", "0"))
        if n <= 0 or n > 200 * 1024 * 1024: return self._json(400, {"error": "bad length"})
        data = self.rfile.read(n); name = self.headers.get("X-Filename", "track.mp3")
        try: self._json(200, separate(data, name))
        except subprocess.CalledProcessError as e: self._json(500, {"error": "demucs failed", "detail": e.stderr.decode(errors="ignore")[-800:]})
        except Exception as e: self._json(500, {"error": str(e)})

if __name__ == "__main__":
    os.makedirs(CACHE, exist_ok=True)
    print(f"djsly stem server on http://0.0.0.0:{PORT}  model={MODEL}  app={WEB}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
