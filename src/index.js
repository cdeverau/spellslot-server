// Front door: routing, CORS, body parsing and size cap. Game logic lives in exchange.js / hygiene.js.
import { validateExchange, validateHygiene, validateEncounterRef } from "./validate.js";
import { exchange } from "./exchange.js";
import { rebuildFailed, report } from "./hygiene.js";

const PROTOCOL = 1;
const MAX_BODY_BYTES = 64 * 1024;

export default {
  async fetch(request, env) {
    const started = Date.now();
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
        return reply(path, {}, { status: "invalid", reason: "too_large" }, started, cors);
      }
      body = JSON.parse(text);
    } catch {
      return json({ status: "invalid", reason: "bad_json" }, 400, cors);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply(path, {}, { status: "invalid", reason: "bad_shape" }, started, cors);
    }
    if (body.protocol !== PROTOCOL) {
      return reply(path, body, { status: "incompatible", protocol: PROTOCOL }, started, cors);
    }

    const now = Math.floor(Date.now() / 1000);
    try {
      let result;
      switch (path) {
        case "/v1/exchange": {
          const reason = validateExchange(body);
          result = reason ? { status: "invalid", reason } : await exchange(env, body, now);
          break;
        }
        case "/v1/rebuild-failed": {
          const reason = validateHygiene(body);
          result = reason ? { status: "invalid", reason } : await rebuildFailed(env, body, now);
          break;
        }
        case "/v1/report": {
          const reason = validateEncounterRef(body);
          result = reason ? { status: "invalid", reason } : await report(env, body, now);
          break;
        }
        default:
          return json({ status: "invalid", reason: "not_found" }, 404, cors);
      }
      return reply(path, body, result, started, cors);
    } catch (err) {
      console.error(path, err);
      return json({ status: "invalid", reason: "server_error" }, 500, cors);
    }
  },
};

// one structured line per app-level outcome: Workers Logs indexes the object's keys as filterable fields.
// Never the account uuid or run id - those are the player's secret and this log is forever.
function reply(path, body, result, started, cors) {
  console.log(compact({
    message: `${path} ${result.status}${result.reason ? " " + result.reason : ""}`,
    route: path,
    status: result.status,
    reason: result.reason,
    floor: body.floor,
    compat_key: body.compat_key,
    game_version: body.game_version,
    encounter_id: result.encounter_id ?? body.encounter_id,
    served: result.status === "ok" && result.ghost !== undefined ? true : undefined,
    ghost_name: result.ghost?.display_name,
    hygiene_reason: body.reason,
    recorded: result.recorded,
    quarantined: result.quarantined,
    ms: Date.now() - started,
  }));
  return json(result, 200, cors);
}

function compact(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

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
