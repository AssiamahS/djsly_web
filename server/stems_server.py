#!/opt/homebrew/opt/python@3.14/bin/python3.14
"""djsly stem server — runs on the Mac, splits tracks with Demucs so the web app can auto-analyse stems.

  GET  /health          → {"ok":true,"model":"htdemucs","busy":n}
  POST /stems           body = audio file bytes, header X-Filename → {"id":sha1,"status":"queued|working|done"}
  GET  /stems/<id>      → {"id","status","error?"}           (poll every few seconds; the job keeps running if the phone leaves)
  GET  /stems/<id>/result → {"vocals":b64,"other":b64,"bass":b64,"drums":b64}   (409 until done)
Jobs are async so no single HTTP call outlives Cloudflare's 100 s edge timeout on the iPhone path.
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
jobs = {}                 # sha1 → {"status": queued|working|done|error, "error": str}
jobs_lock = threading.Lock()

def done_on_disk(h): return all(os.path.exists(os.path.join(CACHE, h, s + ".mp3")) for s in STEMS)

def run_job(h, data, name):
    ext = os.path.splitext(name)[1] or ".mp3"
    try:
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "track" + ext)
            with open(src, "wb") as f: f.write(data)
            with lock:
                with jobs_lock: jobs[h]["status"] = "working"
                subprocess.run([DEMUCS, "-n", MODEL, "--mp3", "--mp3-bitrate", "192", "-o", tmp, src], check=True, capture_output=True)
            out = os.path.join(CACHE, h); os.makedirs(out, exist_ok=True)
            for s in STEMS: shutil.move(os.path.join(tmp, MODEL, "track", s + ".mp3"), os.path.join(out, s + ".mp3"))
        with jobs_lock: jobs[h] = {"status": "done"}
    except subprocess.CalledProcessError as e:
        with jobs_lock: jobs[h] = {"status": "error", "error": "demucs failed: " + e.stderr.decode(errors="ignore")[-400:]}
    except Exception as e:
        with jobs_lock: jobs[h] = {"status": "error", "error": str(e)}

def submit(data: bytes, name: str) -> dict:
    h = hashlib.sha1(data).hexdigest()
    if done_on_disk(h): return {"id": h, "status": "done"}
    with jobs_lock:
        j = jobs.get(h)
        if j and j["status"] in ("queued", "working"): return {"id": h, **j}
        jobs[h] = {"status": "queued"}
    threading.Thread(target=run_job, args=(h, data, name), daemon=True).start()
    return {"id": h, "status": "queued"}

def status(h):
    if done_on_disk(h): return {"id": h, "status": "done"}
    with jobs_lock: return {"id": h, **jobs.get(h, {"status": "unknown"})}

def result(h):
    res = {}
    for s in STEMS:
        with open(os.path.join(CACHE, h, s + ".mp3"), "rb") as f: res[s] = base64.b64encode(f.read()).decode()
    return res

def busy_count():
    with jobs_lock: return sum(1 for j in jobs.values() if j["status"] in ("queued", "working"))

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
        try:
            self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass   # client went away; the job keeps running
    def do_GET(self):
        if self.path == "/health": return self._json(200, {"ok": True, "model": MODEL, "busy": busy_count(), "server": "djsly-stems"})
        parts = self.path.strip("/").split("/")
        if parts[0] == "stems" and len(parts) >= 2 and len(parts[1]) == 40:
            if len(parts) == 2: return self._json(200, status(parts[1]))
            if parts[2] == "result": return self._json(200, result(parts[1])) if done_on_disk(parts[1]) else self._json(409, status(parts[1]))
        return super().do_GET()
    def do_POST(self):
        if self.path != "/stems": return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", "0"))
        if n <= 0 or n > 200 * 1024 * 1024: return self._json(400, {"error": "bad length"})
        data = self.rfile.read(n); name = self.headers.get("X-Filename", "track.mp3")
        try: self._json(202, submit(data, name))
        except Exception as e: self._json(500, {"error": str(e)})

if __name__ == "__main__":
    os.makedirs(CACHE, exist_ok=True)
    print(f"djsly stem server on http://0.0.0.0:{PORT}  model={MODEL}  app={WEB}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
