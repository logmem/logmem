// middleware.js: a connector given the bare origin (https://logmem.si) POSTs
// JSON-RPC to /. Static files win over vercel.json rewrites, so a rewrite
// cannot catch it. This runs first and sends only POST to the MCP route.
// GET and every browser page load still get the homepage. See src/http/issuer.mjs.
export const config = { matcher: "/" };

export default function middleware(request) {
  if (request.method !== "POST") return;
  const url = new URL("/api/mcp", request.url);
  url.searchParams.set("_lm_path", "root");
  return new Response(null, { headers: { "x-middleware-rewrite": url.toString() } });
}
