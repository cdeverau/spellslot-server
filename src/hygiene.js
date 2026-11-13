// Encounter-referenced signals from the player who was served a ghost. Both endpoints accept a report only from the
// account that was served that encounter, and record it at most once per (reporter, run, ghost row): the client's
// retry path can serve the same row twice in one run, and a resent report must not count twice.
// rebuild-failed quarantines a row after QUARANTINE_REPORTERS distinct accounts since its last submission;
// a player report is stored for review and never touches serving.

export async function rebuildFailed(env, body, now) {
  const threshold = Number.parseInt(env.QUARANTINE_REPORTERS, 10) || 2;
  const encounter = await servedEncounter(env, body);
  if (!encounter) return { status: "ok", recorded: false };
  if (await alreadyRecorded(env, "rebuild_failures", body, encounter)) return { status: "ok", recorded: false };

  await env.DB.prepare(
    `INSERT OR IGNORE INTO rebuild_failures (encounter_id, run_id, reason, received_at) VALUES (?1, ?2, ?3, ?4)`
  ).bind(body.encounter_id, body.run_id, body.reason, now).run();

  const count = await env.DB.prepare(
    `SELECT COUNT(DISTINCT e.requester_uuid) AS reporters
     FROM rebuild_failures f
     JOIN encounters e ON e.id = f.encounter_id
     JOIN submissions s ON s.account_uuid = e.ghost_uuid AND s.floor = e.floor
     WHERE e.ghost_uuid = ?1 AND e.floor = ?2 AND f.received_at >= s.received_at`
  ).bind(encounter.ghost_uuid, encounter.floor).first();

  let quarantined = false;
  if ((count?.reporters ?? 0) >= threshold) {
    const result = await env.DB.prepare(
      `UPDATE submissions SET quarantined_at = ?1 WHERE account_uuid = ?2 AND floor = ?3 AND quarantined_at IS NULL`
    ).bind(now, encounter.ghost_uuid, encounter.floor).run();
    quarantined = (result.meta?.changes ?? 0) > 0;
  }
  return { status: "ok", recorded: true, quarantined };
}

export async function report(env, body, now) {
  const encounter = await servedEncounter(env, body);
  if (!encounter) return { status: "ok", recorded: false };
  if (await alreadyRecorded(env, "reports", body, encounter)) return { status: "ok", recorded: false };

  await env.DB.prepare(
    `INSERT OR IGNORE INTO reports (encounter_id, run_id, received_at) VALUES (?1, ?2, ?3)`
  ).bind(body.encounter_id, body.run_id, now).run();
  return { status: "ok", recorded: true };
}

// the encounter, if it exists, served a ghost, and was served to the account now talking
async function servedEncounter(env, body) {
  const encounter = await env.DB.prepare(
    `SELECT requester_uuid, ghost_uuid, floor FROM encounters WHERE id = ?1`
  ).bind(body.encounter_id).first();
  if (!encounter || encounter.requester_uuid !== body.account_uuid || !encounter.ghost_uuid) return null;
  return encounter;
}

// table is one of two literals from the callers above, never request data
async function alreadyRecorded(env, table, body, encounter) {
  const row = await env.DB.prepare(
    `SELECT 1 AS hit FROM ${table} r
     JOIN encounters e ON e.id = r.encounter_id
     WHERE e.requester_uuid = ?1 AND r.run_id = ?2 AND e.ghost_uuid = ?3 AND e.floor = ?4
     LIMIT 1`
  ).bind(body.account_uuid, body.run_id, encounter.ghost_uuid, encounter.floor).first();
  return row !== null;
}
