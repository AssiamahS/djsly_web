/**
 * djsly-stems cloud queue. The phone can't reach the Mac directly (no tunnel, no Tailscale on
 * locked-down networks), so jobs go through Cloudflare KV:
 *   phone  → POST /stems (track bytes, X-Hash sha1, X-Filename) → queued
 *   mac    → GET /agent/next → GET /agent/in/:id → demucs → PUT /agent/out/:id/:stem ×4 → POST /agent/done/:id
 *   phone  → GET /stems/:id (poll) → GET /stems/:id/{vocals,other,bass,drums}
 * Inputs expire after a day, outputs after two; the Mac keeps its own cache so re-asking is instant.
 */
export interface Env { KV: KVNamespace; AGENT_TOKEN: string; }
const STEMS = ["vocals", "other", "bass", "drums"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Filename, X-Hash, Authorization", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS" };
const json = (obj: unknown, status = 200) => Response.json(obj, { status, headers: CORS });
const DAY = 86400;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url); const p = url.pathname.split("/").filter(Boolean);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/health") {
      const seen = Number(await env.KV.get("agent:seen")) || 0; const q = JSON.parse((await env.KV.get("queue")) || "[]");
      return json({ ok: true, server: "djsly-stems", model: "cloud", agent: Date.now() - seen < 8 * 60_000 ? "online" : "offline", busy: q.length });
    }

    // ---------------- phone side ----------------
    if (p[0] === "stems" && request.method === "POST" && p.length === 1) {
      const id = (request.headers.get("X-Hash") || "").toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(id)) return json({ error: "X-Hash (sha1 hex) required" }, 400);
      const job = await env.KV.get(`job:${id}`, "json") as any;
      if (job?.status === "done" || job?.status === "queued" || job?.status === "working") return json({ id, ...job }, 202);
      const body = await request.arrayBuffer(); if (body.byteLength < 1000) return json({ error: "empty body" }, 400);
      await env.KV.put(`in:${id}`, body, { expirationTtl: DAY });
      await env.KV.put(`job:${id}`, JSON.stringify({ status: "queued", name: request.headers.get("X-Filename") || "track.mp3", t: Date.now() }), { expirationTtl: 2 * DAY });
      const q: string[] = JSON.parse((await env.KV.get("queue")) || "[]"); if (!q.includes(id)) q.push(id); await env.KV.put("queue", JSON.stringify(q));
      return json({ id, status: "queued" }, 202);
    }
    if (p[0] === "stems" && p.length === 2 && request.method === "GET") {
      const job = await env.KV.get(`job:${p[1]}`, "json"); return json({ id: p[1], ...(job || { status: "unknown" }) });
    }
    if (p[0] === "stems" && p.length === 3 && STEMS.includes(p[2]) && request.method === "GET") {
      const s = await env.KV.get(`out:${p[1]}:${p[2]}`, "stream"); if (!s) return json({ error: "not ready" }, 404);
      return new Response(s, { headers: { ...CORS, "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" } });
    }

    // ---------------- mac agent side ----------------
    if (p[0] === "agent") {
      if (request.headers.get("Authorization") !== `Bearer ${env.AGENT_TOKEN}`) return json({ error: "unauthorized" }, 401);
      if (p[1] === "ping") { await env.KV.put("agent:seen", String(Date.now())); return json({ ok: true }); }
      if (p[1] === "next") {
        const q: string[] = JSON.parse((await env.KV.get("queue")) || "[]");
        for (const id of q) { const job = await env.KV.get(`job:${id}`, "json") as any; if (job?.status === "queued") { await env.KV.put(`job:${id}`, JSON.stringify({ ...job, status: "working" }), { expirationTtl: 2 * DAY }); return json({ id, ...job, status: "working" }); } }
        return json({ id: null });
      }
      if (p[1] === "in" && p[2]) { const s = await env.KV.get(`in:${p[2]}`, "stream"); return s ? new Response(s, { headers: CORS }) : json({ error: "gone" }, 404); }
      if (p[1] === "out" && p[2] && STEMS.includes(p[3]) && request.method === "PUT") { await env.KV.put(`out:${p[2]}:${p[3]}`, await request.arrayBuffer(), { expirationTtl: 2 * DAY }); return json({ ok: true }); }
      if (p[1] === "done" && p[2] && request.method === "POST") {
        const body = await request.json().catch(() => ({})) as any; const job = (await env.KV.get(`job:${p[2]}`, "json") as any) || {};
        await env.KV.put(`job:${p[2]}`, JSON.stringify({ ...job, status: body.error ? "error" : "done", error: body.error, done: Date.now() }), { expirationTtl: 2 * DAY });
        const q: string[] = JSON.parse((await env.KV.get("queue")) || "[]"); await env.KV.put("queue", JSON.stringify(q.filter(x => x !== p[2])));
        await env.KV.delete(`in:${p[2]}`); return json({ ok: true });
      }
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
