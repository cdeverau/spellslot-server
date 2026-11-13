// Envelope validation only: shapes, ranges, id formats. No game rules - the player payload is opaque past its three top-level dicts.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPAT_KEY_RE = /^[a-z]?\d+\.\d+$/;
const MIN_FLOOR = 1;
const MAX_FLOOR = 6;
const MAX_NAME_LENGTH = 40;
const MAX_VERSION_LENGTH = 32;
const REASONS = new Set(["unknown_drag", "bad_shape"]);

const isDict = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);
const isInt = (v) => Number.isInteger(v);

// returns null when valid, else a short reason code
export function validateExchange(body) {
  if (!isUuid(body.account_uuid)) return "account_uuid";
  if (!isUuid(body.run_id)) return "run_id";
  if (typeof body.compat_key !== "string" || !COMPAT_KEY_RE.test(body.compat_key)) return "compat_key";
  if (typeof body.game_version !== "string" || body.game_version.length > MAX_VERSION_LENGTH) return "game_version";
  if (!isInt(body.floor) || body.floor < MIN_FLOOR || body.floor > MAX_FLOOR) return "floor";
  if (typeof body.display_name !== "string" || body.display_name.length === 0 || body.display_name.length > MAX_NAME_LENGTH) return "display_name";
  if (!isDict(body.player)) return "player";
  for (const key of ["playerdata", "inventorydata", "skindata"]) {
    if (!isDict(body.player[key])) return `player.${key}`;
  }
  if (!Array.isArray(body.log)) return "log";
  if (!isInt(body.log_version) || body.log_version < 0) return "log_version";
  return null;
}

// shared by rebuild-failed and report: who is talking, from which run, about which encounter
export function validateEncounterRef(body) {
  if (!isUuid(body.account_uuid)) return "account_uuid";
  if (!isUuid(body.run_id)) return "run_id";
  if (!isUuid(body.encounter_id)) return "encounter_id";
  return null;
}

export function validateHygiene(body) {
  return validateEncounterRef(body) ?? (REASONS.has(body.reason) ? null : "reason");
}
