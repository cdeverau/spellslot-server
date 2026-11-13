// Front door: routing, CORS, body parsing and size cap. Game logic lives in exchange.js / hygiene.js.
import { validateExchange, validateHygiene, validateEncounterRef } from "./validate.js";
import { exchange } from "./exchange.js";
import { rebuildFailed, report } from "./hygiene.js";

const PROTOCOL = 1;
const MAX_BODY_BYTES = 64 * 1024;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    const path = new URL(request.url).pathname;
    if (path === "/v1/health" && request.method === "GET") {
      // the limits are exposed so test clients can size themselves to the deployment
      return json({
        status: "ok",
        protocol: PROTOCOL,
        pool_cap: Number.parseInt(env.POOL_CAP, 10) || 300,
        quarantine_reporters: Number.parseInt(env.QUARANTINE_REPORTERS, 10) || 2,
      }, 200, cors);
    }
    if (request.method !== "POST") {
      return json({ status: "invalid", reason: "method" }, 405, cors);
    }

    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) {
        return json({ status: "invalid", reason: "too_large" }, 200, cors);
      }
      body = JSON.parse(text);
    } catch {
      return json({ status: "invalid", reason: "bad_json" }, 400, cors);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json({ status: "invalid", reason: "bad_shape" }, 200, cors);
    }
    if (body.protocol !== PROTOCOL) {
      return json({ status: "incompatible", protocol: PROTOCOL }, 200, cors);
    }

    const now = Math.floor(Date.now() / 1000);
    try {
      switch (path) {
        case "/v1/exchange": {
          const reason = validateExchange(body);
          if (reason) return json({ status: "invalid", reason }, 200, cors);
          return json(await exchange(env, body, now), 200, cors);
        }
        case "/v1/rebuild-failed": {
          const reason = validateHygiene(body);
          if (reason) return json({ status: "invalid", reason }, 200, cors);
          return json(await rebuildFailed(env, body, now), 200, cors);
        }
        case "/v1/report": {
          const reason = validateEncounterRef(body);
          if (reason) return json({ status: "invalid", reason }, 200, cors);
          return json(await report(env, body, now), 200, cors);
        }
        default:
          return json({ status: "invalid", reason: "not_found" }, 404, cors);
      }
    } catch (err) {
      console.error(path, err);
      return json({ status: "invalid", reason: "server_error" }, 500, cors);
    }
  },
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// browsers only let a page read a cross-origin response if the server names that page's origin
function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("origin");
  const headers = {
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
  if (allowed.includes("*")) {
    headers["access-control-allow-origin"] = "*";
  } else if (origin && allowed.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "origin";
  }
  return headers;
}
