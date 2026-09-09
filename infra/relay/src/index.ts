/**
 * djsly-stems relay. Gives the Mac stem server (server/stems_server.py on :8813) a stable
 * public HTTPS URL while it sits behind a Cloudflare quick tunnel whose hostname changes on
 * every restart. `server/tunnel.sh` writes the current tunnel origin into KV.
 * Only /health and /stems are forwarded; the app itself lives on GitHub Pages.
 */
export interface Env { UPSTREAM_KV: KVNamespace; UPSTREAM_KEY?: string; }
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "host", "cf-connecting-ip", "cf-ray"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Filename", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const upstream = await env.UPSTREAM_KV.get(env.UPSTREAM_KEY ?? "upstream");
    if (url.pathname === "/relay-status") return Response.json({ ok: Boolean(upstream), upstream }, { headers: CORS });
    if (url.pathname !== "/health" && url.pathname !== "/stems") return Response.json({ error: "not found" }, { status: 404, headers: CORS });
    if (!upstream) return Response.json({ error: "Mac stem server is offline (relay has no upstream)" }, { status: 503, headers: CORS });
    const headers = new Headers(request.headers); for (const h of HOP_BY_HOP) headers.delete(h);
    const init: RequestInit = { method: request.method, headers, redirect: "manual" };
    if (request.method === "POST") init.body = await request.arrayBuffer();
    try {
      const res = await fetch(new URL(url.pathname + url.search, upstream), init);
      const out = new Headers(res.headers); for (const k in CORS) out.set(k, CORS[k as keyof typeof CORS]); out.set("x-djsly-relay", "1");
      return new Response(res.body, { status: res.status, headers: out });
    } catch (err) { return Response.json({ error: `Mac unreachable: ${(err as Error).message}` }, { status: 502, headers: CORS }); }
  },
} satisfies ExportedHandler<Env>;
