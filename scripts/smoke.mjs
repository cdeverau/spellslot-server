// End-to-end smoke test against a running `wrangler dev` (or SMOKE_URL). Uses a fresh compat key per run so
// re-runs never see each other's rows. Exit code 1 on the first failed assertion.
import { randomUUID } from "node:crypto";

const BASE = process.env.SMOKE_URL ?? "http://localhost:8787";
const COMPAT = `z9.${Date.now() % 1000000}`;
let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

async function post(path, body, raw = false) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://smoke.test" },
    body: raw ? body : JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch { /* non-json body */ }
  return { status: response.status, data, headers: response.headers };
}

function account(name) {
  return { uuid: randomUUID(), run_id: randomUUID(), name };
}

function envelope(acct, floor, overrides = {}) {
  return {
    protocol: 1,
    compat_key: COMPAT,
    game_version: "a0.9.0",
    account_uuid: acct.uuid,
    run_id: acct.run_id,
    floor,
    display_name: acct.name,
    player: {
      playerdata: { health: 1000, mana: 100, current_level: 1, owner: acct.name },
      inventorydata: { backpack: [], equipment: [], brain: [], boons: [] },
      skindata: { Skin: "default" },
    },
    log: [],
    log_version: 0,
    ...overrides,
  };
}

async function exchangeUntil(acct, floor, predicate, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await post("/v1/exchange", envelope(acct, floor));
    if (predicate(r.data)) return r.data;
  }
  return null;
}

console.log(`smoke against ${BASE} with compat key ${COMPAT}`);

console.log("transport");
{
  const health = await fetch(`${BASE}/v1/health`);
  check("health 200", health.status === 200);
  const preflight = await fetch(`${BASE}/v1/exchange`, { method: "OPTIONS", headers: { origin: "http://smoke.test" } });
  check("preflight 204 with allow-origin", preflight.status === 204 && !!preflight.headers.get("access-control-allow-origin"));
  const badJson = await post("/v1/exchange", "{not json", true);
  check("malformed body -> 400", badJson.status === 400 && badJson.data?.status === "invalid");
  const wrongProtocol = await post("/v1/exchange", envelope(account("p"), 1, { protocol: 2 }));
  check("protocol 2 -> incompatible", wrongProtocol.data?.status === "incompatible");
  const notFound = await post("/v1/nope", { protocol: 1 });
  check("unknown path -> 404", notFound.status === 404);
}

console.log("validation");
{
  const a = account("v");
  check("floor 9 -> invalid", (await post("/v1/exchange", envelope(a, 9))).data?.reason === "floor");
  check("bad uuid -> invalid", (await post("/v1/exchange", envelope(a, 1, { account_uuid: "nope" }))).data?.reason === "account_uuid");
  check("bad compat key -> invalid", (await post("/v1/exchange", envelope(a, 1, { compat_key: "1.2.3" }))).data?.reason === "compat_key");
  check("empty name -> invalid", (await post("/v1/exchange", envelope(a, 1, { display_name: "" }))).data?.reason === "display_name");
  check("player not dict -> invalid", (await post("/v1/exchange", envelope(a, 1, { player: [] }))).data?.reason === "player");
  const big = envelope(a, 1);
  big.player.skindata.pad = "x".repeat(70 * 1024);
  check("oversize -> too_large", (await post("/v1/exchange", big)).data?.reason === "too_large");
}

console.log("exchange");
const A = account("Alice");
const B = account("Bob");
{
  const first = await post("/v1/exchange", envelope(A, 3));
  check("first submit on empty floor -> empty with encounter id", first.data?.status === "empty" && typeof first.data?.encounter_id === "string");

  const second = await post("/v1/exchange", envelope(B, 3));
  check("second account -> ok", second.data?.status === "ok", JSON.stringify(second.data));
  check("ghost is Alice's build", second.data?.ghost?.display_name === "Alice" && second.data?.ghost?.playerdata?.owner === "Alice");
  check("ghost carries no account uuid", second.data?.ghost && !("account_uuid" in second.data.ghost) && !("UUID" in second.data.ghost));
  check("ghost has the three payload dicts", ["playerdata", "inventorydata", "skindata"].every((k) => k in (second.data?.ghost ?? {})));

  let sawSelf = false;
  for (let i = 0; i < 8; i++) {
    const r = await post("/v1/exchange", envelope(A, 3));
    if (r.data?.ghost?.display_name === "Alice") sawSelf = true;
  }
  check("requester is never served itself", !sawSelf);

  const otherFloor = await post("/v1/exchange", envelope(B, 4));
  check("other floor is its own pool -> empty", otherFloor.data?.status === "empty");

  const otherKey = await post("/v1/exchange", envelope(account("Carol"), 3, { compat_key: `z8.${Date.now() % 1000000}` }));
  check("other compat key -> empty", otherKey.data?.status === "empty");

  const renamed = { ...A, name: "Alice2" };
  await post("/v1/exchange", envelope(renamed, 3));
  const afterRename = await exchangeUntil(B, 3, (d) => d?.ghost?.display_name?.startsWith("Alice"));
  check("resubmission replaces the row (one slot per account per floor)", afterRename?.ghost?.display_name === "Alice2");
}

console.log("hygiene");
{
  const floor = 5;
  const G = account("Ghost");
  const R1 = account("Rep1");
  const R2 = account("Rep2");
  await post("/v1/exchange", envelope(G, floor));

  const served1 = await post("/v1/exchange", envelope(R1, floor));
  check("reporter 1 served the ghost", served1.data?.ghost?.display_name === "Ghost");
  const stranger = await post("/v1/rebuild-failed", { protocol: 1, account_uuid: R2.uuid, run_id: R2.run_id, encounter_id: served1.data.encounter_id, reason: "bad_shape" });
  check("report from a different account than the served one is ignored", stranger.data?.recorded === false);
  const badReason = await post("/v1/rebuild-failed", { protocol: 1, account_uuid: R1.uuid, run_id: R1.run_id, encounter_id: served1.data.encounter_id, reason: "lol" });
  check("unknown reason -> invalid", badReason.data?.status === "invalid");
  const report1 = await post("/v1/rebuild-failed", { protocol: 1, account_uuid: R1.uuid, run_id: R1.run_id, encounter_id: served1.data.encounter_id, reason: "unknown_drag" });
  check("first report recorded, not yet quarantined", report1.data?.recorded === true && report1.data?.quarantined === false);
  const stillServed = await exchangeUntil(R2, floor, (d) => d?.ghost?.display_name === "Ghost");
  check("one reporter does not remove the row", stillServed !== null);

  const report2 = await post("/v1/rebuild-failed", { protocol: 1, account_uuid: R2.uuid, run_id: R2.run_id, encounter_id: stillServed.encounter_id, reason: "unknown_drag" });
  check("second distinct reporter quarantines", report2.data?.quarantined === true);
  let sawGhost = false;
  for (let i = 0; i < 10; i++) {
    const r = await post("/v1/exchange", envelope(R1, floor));
    if (r.data?.ghost?.display_name === "Ghost") sawGhost = true;
  }
  check("quarantined row is no longer served", !sawGhost);

  await post("/v1/exchange", envelope(G, floor));
  const back = await exchangeUntil(R1, floor, (d) => d?.ghost?.display_name === "Ghost");
  check("resubmission clears the quarantine", back !== null);
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
