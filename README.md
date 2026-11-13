# spellslot-server

Cloudflare Worker + D1 backend for AutoMagic's async PvP ("Fallen Challenger"). One stateless HTTPS endpoint: the client POSTs its build and gets a random other player's build back. Design: `ObsidianVault/Central Design Documentation (lmao)/Multiplayer Integrity.md` in the game repo.

The server stores builds as opaque blobs and knows no game rules. Every integrity verdict is a trust-score move, never a rejection.

## Layout

- `wrangler.toml` project config: name, entry point, D1 binding, `POOL_CAP`, `QUARANTINE_REPORTERS`, prod `ALLOWED_ORIGINS`
- `.dev.vars` overrides for `wrangler dev` (`ALLOWED_ORIGINS="*"`)
- `schema.sql` tables; additive, safe to re-run
- `src/index.js` routing, CORS, body parsing, size cap, and one structured log line per outcome (route, status, floor, compat key, encounter id, served, ghost name, hygiene result, ms - never an account uuid or run id). Filter on these fields in the dashboard's Workers Logs view
- `src/validate.js` envelope checks (shape, ranges, id formats)
- `src/exchange.js` account upsert, submission upsert, pool trim, serve by trust tier, encounter row
- `src/hygiene.js` rebuild-failed reports (quarantine) and player reports (stored for review)
- `scripts/smoke.mjs` quick end-to-end check against a running dev server. The full pressure suite is the game's `Tests/ServerTest.tscn` (see Testing)

## Protocol v1

Every app-level outcome is HTTP 200 with a `status`: `ok`, `empty`, `incompatible` (protocol mismatch), `invalid` (bad envelope, nothing stored). Malformed JSON is 400, wrong method 405, unknown path 404. The client falls back to its default ghost on anything but `ok`.

`POST /v1/exchange`
```json
{
  "protocol": 1, "compat_key": "a0.9", "game_version": "a0.9.0",
  "account_uuid": "...", "run_id": "...", "floor": 3, "display_name": "Example",
  "player": { "playerdata": {}, "inventorydata": {}, "skindata": {} },
  "log": [], "log_version": 0
}
```
Response: `{ "status": "ok", "encounter_id": "...", "ghost": { "display_name": "...", "playerdata": {}, "inventorydata": {}, "skindata": {} } }`. The ghost's account uuid is never returned.

`POST /v1/rebuild-failed`: `{ "protocol": 1, "account_uuid", "run_id", "encounter_id", "reason": "unknown_drag" | "bad_shape" }`. Only the account that was served that encounter is counted, and at most once per (account, run, ghost row): resends and the client's retry path answer `recorded: false`. A row is quarantined (not served) once `QUARANTINE_REPORTERS` distinct accounts report it since its last submission; resubmitting clears it.

`POST /v1/report`: `{ "protocol": 1, "account_uuid", "run_id", "encounter_id" }`. A player flagging the ghost they fought. Same acceptance and once-per-run-per-ghost rule as above; stored for review only and never affects serving.

`GET /v1/health` returns `{ "status": "ok", "protocol": 1, "pool_cap", "quarantine_reporters" }` so test clients can size themselves to the deployment.

## First-time setup

1. Create a free Cloudflare account at https://dash.cloudflare.com (Workers and D1 free tiers).
2. `npm install`
3. `npx wrangler login` (opens the browser)
4. `npx wrangler d1 create spellslot-pool` and paste the printed `database_id` into `wrangler.toml`
5. `npm run db:local` then `npm run db:remote` to create the tables
6. `npm run dev` serves on http://localhost:8787; in another shell `npm run smoke`
7. `npm run deploy` prints the `https://spellslot-server.<account>.workers.dev` URL; paste it into `GlobalConfig.SERVER_URL` in the game

## Day to day

- `npm run dev` + point the game at the dev server (`GlobalConfig.USE_LOCAL_SERVER`; `USE_DEV_SERVER` targets staging instead; the game uses `127.0.0.1`, not `localhost`, because Godot resolves `localhost` to `::1` and wrangler dev listens on IPv4 only). Localhost is exempt from the browser's mixed-content rule, so the web build can test against it too.
- `npm run deploy` after any server change. Schema changes: edit `schema.sql` additively, run `db:local` and `db:remote`.
- Inspect data: `npx wrangler d1 execute spellslot-pool --local --command "select account_uuid, floor, display_name, received_at, quarantined_at from submissions"` (drop `--local` for prod).
- Logs: `npx wrangler tail`.

## Staging

A second Worker (`spellslot-server-staging`) with its own D1 database, defined as the `staging` environment in
`wrangler.toml`. Code reaches it from the `staging` branch; production only ever gets code staging has already run.
One-time setup:

1. `npx wrangler d1 create spellslot-pool-staging` and paste the id into the `[[env.staging.d1_databases]]` block.
2. `npm run db:staging` to create the tables.
3. Dashboard: Workers & Pages > Create > import this repo again as a new Worker, production branch `staging`,
   deploy command `npx wrangler deploy --env staging`. Or deploy by hand with `npm run deploy:staging`.

Schema changes go to staging first (`npm run db:staging`), production second (`npm run db:remote`).
The game targets it with `GlobalConfig.USE_DEV_SERVER`; the test suite with `--staging` or the Test Staging button.

## Testing

- `npm run smoke`: ~30 quick checks from Node, a few seconds.
- Pressure suite: the game repo's `Tests/ServerTest.tscn` (87 checks: transport, validation, exchange, rebuild-failed and report dedupe, quarantine thresholds, 25-way concurrency, pool trim at `POOL_CAP`, plus the client's dry-run validator on a served ghost). Run it in the editor, or headless from the game folder - exit code 1 on any failure:

  ```
  Godot_console.exe --headless --path . res://Tests/ServerTest.tscn ++ --server=http://127.0.0.1:8787
  ```

  Each run uses a fresh compat key, so its rows never meet the game's. Takes a minute or two (the capacity test writes `POOL_CAP` + 60 rows).

## Not here yet (integrity plan)

Ingest consistency check (`checkSubmission` stub in `exchange.js`), `verdicts` table, probation default, report button in the game (the `/v1/report` endpoint exists), suspicion scoring over reports, retention jobs, per-IP caps (only if a full-release web build ever happens).
