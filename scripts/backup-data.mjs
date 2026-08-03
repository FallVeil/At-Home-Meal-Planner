// Read-only backup of Homebase's Redis data (Upstash REST).
// Exports every `meal:*` and `hh:*` key to a timestamped JSON snapshot under backups/.
// NEVER writes to Redis. Run before any migration/deploy:
//     node scripts/backup-data.mjs
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!REDIS_URL || !REDIS_TOKEN) {
  console.error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in .env — nothing to back up.");
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "backups");

async function main() {
  // Collect keys for both the legacy and the new namespaces.
  const patterns = ["meal:*", "hh:*"];
  const keys = [];
  for (const p of patterns) {
    const found = await redisCmd(["KEYS", p]);
    if (Array.isArray(found)) keys.push(...found);
  }
  const unique = [...new Set(keys)].sort();

  // Store raw string values exactly as Redis holds them, so restore is verbatim.
  const data = {};
  for (const key of unique) {
    data[key] = await redisCmd(["GET", key]); // string | null
  }

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `homebase-backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), keys: data }, null, 2));

  console.log(`Backed up ${unique.length} key(s) → ${file}`);
  unique.forEach((k) => console.log(`  ${k}`));
}

main().catch((e) => {
  console.error("Backup failed:", e.message);
  process.exit(1);
});
