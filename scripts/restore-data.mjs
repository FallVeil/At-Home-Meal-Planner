// Restore Homebase Redis data from a snapshot made by backup-data.mjs.
// Writes each saved key back verbatim (SET). Use this to roll back a bad migration.
//     node scripts/restore-data.mjs backups/homebase-backup-<stamp>.json
// Add --dry-run to preview without writing.
import dotenv from "dotenv";
import fs from "node:fs";

dotenv.config();

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!REDIS_URL || !REDIS_TOKEN) {
  console.error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in .env.");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("Usage: node scripts/restore-data.mjs <snapshot.json> [--dry-run]");
  process.exit(1);
}

async function redisCmd(command) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Redis ${r.status}: ${await r.text()}`);
  return (await r.json()).result;
}

async function main() {
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = Object.entries(snap.keys || {});
  if (!entries.length) {
    console.error("Snapshot has no keys.");
    process.exit(1);
  }
  console.log(`${dryRun ? "[dry-run] " : ""}Restoring ${entries.length} key(s) from ${file} (taken ${snap.takenAt}):`);
  for (const [key, value] of entries) {
    if (value == null) {
      console.log(`  skip ${key} (was null)`);
      continue;
    }
    if (!dryRun) await redisCmd(["SET", key, value]);
    console.log(`  ${dryRun ? "would set" : "set"} ${key}`);
  }
  console.log(dryRun ? "Dry run complete — nothing written." : "Restore complete.");
}

main().catch((e) => {
  console.error("Restore failed:", e.message);
  process.exit(1);
});
