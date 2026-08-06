// Clear every household's data EXCEPT the ones you want to keep.
//
// Why this exists: before the client-side guard was added, signing a new
// household into a browser that still held another household's localStorage
// could push that data up into the new household's server store — so a test
// account ended up with Andrew-Katie's calendar, plan, etc. This wipes those
// stray household namespaces while leaving the real one (and all global caches
// and legacy backups) untouched.
//
// It is DRY-RUN by default — it only lists what it *would* delete. Add --apply
// to actually delete. Always run scripts/backup-data.mjs first.
//
//     node scripts/backup-data.mjs                 # snapshot everything
//     node scripts/clear-other-households.mjs       # preview (deletes nothing)
//     node scripts/clear-other-households.mjs --apply
//
// Keep-list: hh:<id>:* for each id in KEEP (default "andrew-katie,local"),
// override with KEEP_HOUSEHOLDS="andrew-katie,local,smiths". Global keys that
// aren't household-scoped (recipe:*, pool:*, hh:migrated:*, meal:* legacy
// backups) are ALWAYS kept.
import dotenv from "dotenv";
dotenv.config();

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!REDIS_URL || !REDIS_TOKEN) {
  console.error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in .env — nothing to do.");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const KEEP = new Set(
  (process.env.KEEP_HOUSEHOLDS || "andrew-katie,local")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

async function redisCmd(command) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Redis ${r.status}: ${await r.text()}`);
  return (await r.json()).result;
}

// A household key looks like "hh:<id>:<name>". Anything else (hh:migrated:v1,
// recipe:v1:*, pool:v1, meal:*) is a global/legacy key we never touch here.
function householdIdOf(key) {
  if (!key.startsWith("hh:")) return null;
  const rest = key.slice(3);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const id = rest.slice(0, i);
  if (id === "migrated") return null; // hh:migrated:* is the migration marker, not a household
  return id;
}

async function main() {
  const keys = (await redisCmd(["KEYS", "hh:*"])) || [];
  const byHousehold = new Map(); // id -> [keys]
  for (const key of keys) {
    const id = householdIdOf(key);
    if (!id) continue;
    if (!byHousehold.has(id)) byHousehold.set(id, []);
    byHousehold.get(id).push(key);
  }

  const keepIds = [...byHousehold.keys()].filter((id) => KEEP.has(id)).sort();
  const dropIds = [...byHousehold.keys()].filter((id) => !KEEP.has(id)).sort();

  console.log(`Households found: ${byHousehold.size}`);
  console.log(`  Keeping (${keepIds.length}): ${keepIds.join(", ") || "(none)"}`);
  console.log(`  Clearing (${dropIds.length}): ${dropIds.join(", ") || "(none)"}`);

  const toDelete = dropIds.flatMap((id) => byHousehold.get(id));
  if (!toDelete.length) {
    console.log("\nNothing to clear. ✅");
    return;
  }

  console.log(`\n${APPLY ? "Deleting" : "Would delete"} ${toDelete.length} key(s):`);
  toDelete.forEach((k) => console.log(`  ${k}`));

  if (!APPLY) {
    console.log("\nDry run — nothing deleted. Re-run with --apply to remove these.");
    return;
  }

  await redisCmd(["DEL", ...toDelete]);
  console.log(`\nDeleted ${toDelete.length} key(s). ✅`);
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
