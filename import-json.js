// One-off: copy data from the old JSON file store into Postgres.
// Usage: npm run import-json [-- path/to/db.json]   (default: data/db.json)
// Safe to re-run: records that already exist are skipped.
const fs = require("node:fs");
const path = require("node:path");
const repo = require("./repo");
const { connect, migrate } = require("./db");

async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, "data", "db.json"));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (!fs.existsSync(file)) throw new Error(`No file at ${file}`);

  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const db = connect(process.env.DATABASE_URL);
  await migrate(db);
  const counts = { shipments: 0, quotes: 0, messages: 0, skipped: 0 };

  for (const s of data.shipments || []) {
    const imported = await db.tx(async (q) => {
      if (await repo.shipmentExists(q, s.trackingNumber)) return false;
      await repo.insertShipment(q, s.trackingNumber, { ...s, status: s.status || "ACCEPTED" }, s.createdAt);
      await repo.updateShipment(q, s.trackingNumber, {}, s.updatedAt || s.createdAt);
      for (const stop of s.stops || []) {
        await repo.insertStop(q, s.trackingNumber, stop);
        await repo.updateStop(q, stop.id, {
          status: stop.status,
          arrivedAt: stop.arrivedAt,
          departedAt: stop.departedAt,
        });
      }
      const events = [...(s.trackingEvents || [])].sort((a, b) => new Date(a.time) - new Date(b.time));
      for (const e of events) await repo.insertEvent(q, s.trackingNumber, e);
      return true;
    });
    imported ? counts.shipments++ : counts.skipped++;
  }

  for (const quote of data.quotes || []) {
    const { rowCount } = await db.query("select 1 from quotes where id = $1", [quote.id]);
    if (rowCount) { counts.skipped++; continue; }
    await repo.insertQuote(db, quote);
    counts.quotes++;
  }

  for (const m of data.messages || []) {
    const { rowCount } = await db.query("select 1 from messages where id = $1", [m.id]);
    if (rowCount) { counts.skipped++; continue; }
    await repo.insertMessage(db, m);
    counts.messages++;
  }

  await db.close();
  console.log(
    `Imported ${counts.shipments} shipments, ${counts.quotes} quotes, ${counts.messages} messages` +
      ` (${counts.skipped} already present, skipped).`,
  );
}

main().catch((err) => {
  console.error("Import failed:", err.message);
  process.exit(1);
});
