// Roll production back N minutes with D1 Time Travel (30-day window). Everything written after that moment is
// lost; the pool refills itself as people play. Wrangler asks for confirmation before restoring.
//   npm run rollback -- 30
import { execSync } from "node:child_process";

const DB = "spellslot-pool";
const MAX_MINUTES = 30 * 24 * 60;

const minutes = Number(process.argv[2]);
if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
  console.error(`usage: npm run rollback -- <minutes>   (1 to ${MAX_MINUTES})`);
  process.exit(2);
}
const target = new Date(Date.now() - minutes * 60_000);
console.log(`Restoring ${DB} to ${target.toISOString()} (${target.toLocaleString()}), ${minutes} minute(s) ago.`);
execSync(`npx wrangler d1 time-travel restore ${DB} --timestamp=${target.toISOString()}`, { stdio: "inherit" });
