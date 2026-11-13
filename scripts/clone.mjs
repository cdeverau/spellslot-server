// Copy production into staging: export prod, drop staging's tables, import the dump (schema + data, so staging
// becomes an exact copy), then re-apply schema.sql for anything staging has ahead of prod. The dump holds every
// account uuid, so it lives in the gitignored dumps/ folder and is deleted whether or not the copy succeeds.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const PROD = "spellslot-pool";
const STAGING = "spellslot-pool-staging";
const DUMP = "dumps/prod.sql";

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: "inherit" });
}

mkdirSync("dumps", { recursive: true });
try {
  run(`npx wrangler d1 export ${PROD} --remote --output=${DUMP}`);
  run(`npx wrangler d1 execute ${STAGING} --remote --env staging --yes --file=scripts/reset.sql`);
  run(`npx wrangler d1 execute ${STAGING} --remote --env staging --yes --file=${DUMP}`);
  run(`npx wrangler d1 execute ${STAGING} --remote --env staging --yes --file=schema.sql`);
  console.log("staging now mirrors production");
} finally {
  if (existsSync(DUMP)) {
    rmSync(DUMP);
    console.log(`deleted ${DUMP}`);
  }
}
