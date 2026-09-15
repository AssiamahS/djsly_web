#!/opt/homebrew/opt/python@3.14/bin/python3.14
"""djsly stem server — runs on the Mac, splits tracks with Demucs so the web app can auto-analyse stems.

  GET  /health          → {"ok":true,"model":"htdemucs","busy":n}
  POST /stems           body = audio file bytes, header X-Filename → {"id":sha1,"status":"queued|working|done"}
  GET  /stems/<id>      → {"id","status","error?"}           (poll every few seconds; the job keeps running if the phone leaves)
  GET  /stems/<id>/<stem> → the mp3 (vocals|other|bass|drums), 404 until done
Also runs the CLOUD AGENT: polls the djsly-stems Worker (KV job queue) for tracks the iPhone dropped there,
separates them and uploads the stems. That needs no tunnel, so it works on networks that block everything but 443.
Token in ~/.djsly-stems-token (same value as the Worker's AGENT_TOKEN secret).
  GET  /<static>        serves the djsly web app itself (so a phone on the same Wi-Fi can use http://<mac-ip>:8813/)

Results are cached by content hash in ~/djsly-stems/cache/<sha1>/ so a track is only split once.
"""
import hashlib, json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get("DJSLY_STEMS_PORT", "8813"))
MODEL = os.environ.get("DJSLY_STEMS_MODEL", "htdemucs")
CACHE = os.path.expanduser(os.environ.get("DJSLY_STEMS_DIR", "~/djsly-stems")) + "/cache"
WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMUCS = shutil.which("demucs") or "/opt/homebrew/bin/demucs"
# Keep the Mac usable while separating: run on the Apple GPU (Metal/MPS) instead of pegging all 8 CPU cores,
# one worker, short segments (htdemucs max 7 s, int), low priority. djay Pro's Neural Mix works the same way —
# a small model on the GPU / Neural Engine — which is why it never freezes the machine.
NICE = os.environ.get("DJSLY_STEMS_NICE", "15")
def pick_device():
    want = os.environ.get("DJSLY_STEMS_DEVICE")
    if want: return want
    try:
        r = subprocess.run([sys.executable, "-c", "import torch;print('mps' if torch.backends.mps.is_available() else 'cpu')"], capture_output=True, text=True, timeout=120)
        if r.stdout.strip() in ("mps", "cpu"): return r.stdout.strip()
    except Exception as e: print("device probe: " + str(e), flush=True)
    return "cpu"
DEVICE = pick_device()
ENV = {**os.environ, "PYTORCH_ENABLE_MPS_FALLBACK": "1", "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS", "4"), "MKL_NUM_THREADS": "4"}
def demucs_cmd(device, out_dir, src):
    return ["nice", "-n", NICE, DEMUCS, "-n", MODEL, "-d", device, "-j", "1", "--segment", "7", "--mp3", "--mp3-bitrate", "192", "-o", out_dir, src]
CLOUD = os.environ.get("DJSLY_CLOUD_URL", "https://djsly-stems.sylvesterassiamahpm.workers.dev")
TOKEN_FILE = os.path.expanduser("~/.djsly-stems-token")
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
                t0 = time.time()
                try: subprocess.run(demucs_cmd(DEVICE, tmp, src), check=True, capture_output=True, env=ENV)
                except subprocess.CalledProcessError as e:
                    if DEVICE == "cpu": raise
                    print("demucs on %s failed, retrying on cpu: %s" % (DEVICE, e.stderr.decode(errors="ignore")[-300:]), flush=True)
                    subprocess.run(demucs_cmd("cpu", tmp, src), check=True, capture_output=True, env=ENV)
                print("separated %s (%s) in %.0fs on %s" % (name, h[:8], time.time() - t0, DEVICE), flush=True)
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

def stem_path(h, s): return os.path.join(CACHE, h, s + ".mp3")

# ---------------- cloud agent ----------------
def cloud_agent():
    token = open(TOKEN_FILE).read().strip() if os.path.exists(TOKEN_FILE) else ""
    if not token: print("cloud agent: no token at " + TOKEN_FILE + " — iPhone-from-anywhere disabled", flush=True); return
    def call(method, path, data=None, timeout=120):
        req = urllib.request.Request(CLOUD + path, data=data, method=method, headers={"Authorization": "Bearer " + token, "Content-Type": "application/octet-stream", "User-Agent": "djsly-stems-agent/1 (mac)"})
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.read()
    print("cloud agent: polling " + CLOUD, flush=True)
    last_ping = 0
    while True:
        try:
            if time.time() - last_ping > 240: call("POST", "/agent/ping", b""); last_ping = time.time()
            job = json.loads(call("GET", "/agent/next"))
            if not job.get("id"): time.sleep(5); continue
            h, name = job["id"], job.get("name", "track.mp3")
            print("cloud job " + h[:8] + " " + name, flush=True)
            if not done_on_disk(h):
                data = call("GET", "/agent/in/" + h, timeout=300)
                if hashlib.sha1(data).hexdigest() != h: raise RuntimeError("hash mismatch")
                with jobs_lock: jobs[h] = {"status": "queued"}
                run_job(h, data, name)
                with jobs_lock: st = jobs.get(h, {})
                if st.get("status") == "error": call("POST", "/agent/done/" + h, json.dumps({"error": st.get("error")}).encode()); continue
            for s in STEMS:
                with open(stem_path(h, s), "rb") as f: call("PUT", "/agent/out/" + h + "/" + s, f.read(), timeout=300)
            call("POST", "/agent/done/" + h, b"{}")
            print("cloud job " + h[:8] + " done", flush=True)
        except Exception as e:
            print("cloud agent: " + str(e), flush=True); time.sleep(15)

def busy_count():
    with jobs_lock: return sum(1 for j in jobs.values() if j["status"] in ("queued", "working"))

class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=WEB, **k)
    def log_message(self, fmt, *args): sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Hash")
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
        if self.path == "/health": return self._json(200, {"ok": True, "model": MODEL, "device": DEVICE, "busy": busy_count(), "server": "djsly-stems"})
        parts = self.path.strip("/").split("/")
        if parts[0] == "stems" and len(parts) >= 2 and len(parts[1]) == 40:
            if len(parts) == 2: return self._json(200, status(parts[1]))
            if parts[2] in STEMS:
                if not done_on_disk(parts[1]): return self._json(404, status(parts[1]))
                with open(stem_path(parts[1], parts[2]), "rb") as f: body = f.read()
                self.send_response(200); self.send_header("Content-Type", "audio/mpeg"); self.send_header("Content-Length", str(len(body))); self.end_headers()
                try: self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError): pass
                return
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
    threading.Thread(target=cloud_agent, daemon=True).start()
    print(f"djsly stem server on http://0.0.0.0:{PORT}  model={MODEL}  device={DEVICE}  app={WEB}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
