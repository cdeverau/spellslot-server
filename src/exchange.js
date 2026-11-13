// One ghost exchange: record the requester's build, trim the pool, serve a random build back, log the encounter.

export const TRUST = { PROBATION: 0, TRUSTED: 1, FLAGGED: 2 };

export async function exchange(env, body, now) {
  const poolCap = intVar(env.POOL_CAP, 300);
  const requester = body.account_uuid;
  const payload = JSON.stringify(body.player);
  const log = JSON.stringify(body.log);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO accounts (uuid, trust, first_seen, last_seen) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(uuid) DO UPDATE SET last_seen = excluded.last_seen`
    ).bind(requester, TRUST.TRUSTED, now),
    // a resubmission is a new build: it also clears any quarantine on the old one
    env.DB.prepare(
      `INSERT INTO submissions (account_uuid, floor, compat_key, run_id, display_name, payload, log, log_version, received_at, quarantined_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)
       ON CONFLICT(account_uuid, floor) DO UPDATE SET
         compat_key = excluded.compat_key, run_id = excluded.run_id, display_name = excluded.display_name,
         payload = excluded.payload, log = excluded.log, log_version = excluded.log_version,
         received_at = excluded.received_at, quarantined_at = NULL`
    ).bind(requester, body.floor, body.compat_key, body.run_id, body.display_name, payload, log, body.log_version, now),
    // keep the newest POOL_CAP rows per (floor, compat_key); the subquery is NULL below the cap so nothing matches
    env.DB.prepare(
      `DELETE FROM submissions WHERE floor = ?1 AND compat_key = ?2 AND received_at <
         (SELECT received_at FROM submissions WHERE floor = ?1 AND compat_key = ?2
          ORDER BY received_at DESC LIMIT 1 OFFSET ?3)`
    ).bind(body.floor, body.compat_key, poolCap - 1),
  ]);

  checkSubmission(env, body, now);

  const account = await env.DB.prepare(`SELECT trust FROM accounts WHERE uuid = ?1`).bind(requester).first();
  const serveTier = account?.trust === TRUST.FLAGGED ? TRUST.FLAGGED : TRUST.TRUSTED;
  const ghost = await env.DB.prepare(
    `SELECT s.account_uuid, s.display_name, s.payload FROM submissions s
     JOIN accounts a ON a.uuid = s.account_uuid
     WHERE s.floor = ?1 AND s.compat_key = ?2 AND s.account_uuid != ?3
       AND s.quarantined_at IS NULL AND a.trust = ?4
     ORDER BY RANDOM() LIMIT 1`
  ).bind(body.floor, body.compat_key, requester, serveTier).first();

  const encounterId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO encounters (id, requester_uuid, ghost_uuid, floor, compat_key, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(encounterId, requester, ghost?.account_uuid ?? null, body.floor, body.compat_key, now).run();

  if (!ghost) {
    return { status: "empty", encounter_id: encounterId };
  }
  return {
    status: "ok",
    encounter_id: encounterId,
    ghost: { display_name: ghost.display_name, ...JSON.parse(ghost.payload) },
  };
}

// ingest consistency check goes here (state log vs snapshot -> verdict row -> trust). Never blocks the response.
function checkSubmission(_env, _body, _now) {}

function intVar(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
