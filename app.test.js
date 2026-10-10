const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("./app");
const { fromPGlite, migrate } = require("./db");

let db;
let server;
// Records what the API asks to email instead of sending anything.
const notified = [];
const notifier = {
  shipmentUpdated: async (shipment, events) => {
    notified.push({ tn: shipment.trackingNumber, titles: events.map((e) => e.title) });
  },
};
let base;
let token;

async function api(method, url, body, auth = true) {
  const res = await fetch(base + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  // In-memory Postgres: same SQL as Neon, nothing to install or clean up.
  const { PGlite } = await import("@electric-sql/pglite");
  db = fromPGlite(new PGlite());
  await migrate(db);
  await migrate(db); // startup migration must be safe to repeat

  const app = createApp({
    db,
    notifier,
    adminUsername: "admin",
    adminPassword: "secret-pass",
    tokenSecret: "test-secret",
  });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await api("POST", "/api/admin/login", { username: "admin", password: "secret-pass" }, false)).body.token;
});

after(async () => {
  server.close();
  await db.close();
});

test("login rejects a wrong password and admin routes need a token", async () => {
  const bad = await api("POST", "/api/admin/login", { username: "admin", password: "nope" }, false);
  assert.equal(bad.status, 401);
  const noAuth = await api("GET", "/api/shipments", undefined, false);
  assert.equal(noAuth.status, 401);
  assert.ok(token);
});

test("updates append to tracking history and never erase it", async () => {
  const created = await api("POST", "/api/shipments/direct", {
    trackingNumber: "AWB100",
    from: "Lagos",
    to: "London",
    // Clients cannot inject or replace history.
    trackingEvents: [{ title: "fake" }],
  });
  assert.equal(created.status, 201);
  let s = created.body.shipment;
  assert.equal(s.status, "ACCEPTED");
  assert.deepEqual(s.trackingEvents.map((e) => e.title), ["Accepted"]);

  s = (await api("PATCH", "/api/shipments/AWB100/status", { status: "PROCESSING" })).body.shipment;
  s = (await api("PATCH", "/api/shipments/AWB100", { status: "IN TRANSIT", eta: "2026-11-01", trackingEvents: [] })).body.shipment;
  assert.equal(s.eta, "2026-11-01");

  const stop = (await api("POST", "/api/shipments/AWB100/stops", { location: "Accra Hub" })).body.shipment.stops[0];
  s = (await api("PATCH", `/api/shipments/AWB100/stops/${stop.id}`, { status: "arrived" })).body.shipment;
  s = (await api("PATCH", `/api/shipments/AWB100/stops/${stop.id}`, { status: "departed" })).body.shipment;
  s = (await api("POST", "/api/shipments/AWB100/events", { title: "Cleared customs", location: "Accra" })).body.shipment;
  // Editing and removing the stop must not remove the arrival/departure records.
  s = (await api("PATCH", `/api/shipments/AWB100/stops/${stop.id}`, { location: "Accra Main Hub" })).body.shipment;
  s = (await api("DELETE", `/api/shipments/AWB100/stops/${stop.id}`)).body.shipment;

  assert.equal(s.stops.length, 0);
  assert.deepEqual(
    s.trackingEvents.map((e) => e.title),
    [
      "Accepted",
      "Processing",
      "In Transit",
      "Stop added to route",
      "Arrived at Accra Hub",
      "Departed Accra Hub",
      "Cleared customs",
      "Stop updated",
      "Stop removed from route",
    ],
  );

  // Public tracking returns the same full history.
  const tracked = await api("GET", "/api/tracking/awb100", undefined, false);
  assert.equal(tracked.body.trackingEvents.length, 9);
});

test("the database itself refuses to edit or delete tracking history", async () => {
  await assert.rejects(
    db.query("update tracking_events set title = 'changed' where tracking_number = 'AWB100'"),
    /append-only/,
  );
  await assert.rejects(
    db.query("delete from tracking_events where tracking_number = 'AWB100'"),
    /append-only/,
  );
  const { rows } = await db.query(
    "select count(*)::int as n from tracking_events where tracking_number = 'AWB100'",
  );
  assert.equal(rows[0].n, 9);
});

test("deleting a whole shipment removes its history with it", async () => {
  await api("POST", "/api/shipments/direct", { trackingNumber: "AWB900" });
  await api("POST", "/api/shipments/AWB900/stops", { location: "Hub" });
  assert.equal((await api("DELETE", "/api/shipments/AWB900")).status, 200);
  assert.equal((await api("GET", "/api/tracking/AWB900", undefined, false)).status, 404);
  const { rows } = await db.query(
    "select count(*)::int as n from tracking_events where tracking_number = 'AWB900'",
  );
  assert.equal(rows[0].n, 0);
});

test("unknown shipments and stops return 404", async () => {
  assert.equal((await api("GET", "/api/tracking/NOPE", undefined, false)).status, 404);
  assert.equal((await api("PATCH", "/api/shipments/NOPE/status", { status: "DELIVERED" })).status, 404);
  assert.equal((await api("PATCH", "/api/shipments/AWB100/stops/not-a-uuid", { status: "arrived" })).status, 404);
});

test("setting the same status again does not add a duplicate entry", async () => {
  await api("POST", "/api/shipments/direct", { trackingNumber: "AWB200" });
  await api("PATCH", "/api/shipments/AWB200/status", { status: "ACCEPTED" });
  const s = (await api("GET", "/api/tracking/AWB200", undefined, false)).body;
  assert.equal(s.trackingEvents.length, 1);
});

test("stops can be reordered and validate input", async () => {
  await api("POST", "/api/shipments/direct", { trackingNumber: "AWB300" });
  await api("POST", "/api/shipments/AWB300/stops", { location: "A" });
  const s = (await api("POST", "/api/shipments/AWB300/stops", { location: "B" })).body.shipment;
  const [a, b] = s.stops.map((x) => x.id);

  const reordered = await api("PUT", "/api/shipments/AWB300/stops/order", { order: [b, a] });
  assert.deepEqual(reordered.body.shipment.stops.map((x) => x.location), ["B", "A"]);

  assert.equal((await api("PUT", "/api/shipments/AWB300/stops/order", { order: [a] })).status, 400);
  assert.equal((await api("POST", "/api/shipments/AWB300/stops", { location: " " })).status, 400);
  assert.equal((await api("PATCH", `/api/shipments/AWB300/stops/${a}`, { status: "lost" })).status, 400);
});

test("quotes convert into shipments once", async () => {
  const q = await api("POST", "/api/quotes", { fromName: "Ann", fromCity: "Lagos", toName: "Bo", toCity: "Paris", weight: "4" }, false);
  assert.equal(q.status, 201);
  const made = await api("POST", "/api/shipments", { quoteId: q.body.id, eta: "2026-12-01" });
  assert.equal(made.status, 201);
  assert.equal(made.body.shipment.from, "Lagos");
  assert.equal(made.body.shipment.weight, "4 kg");
  assert.equal((await api("POST", "/api/shipments", { quoteId: q.body.id })).status, 409);
});

test("customer-facing changes trigger a notification; route edits and no-ops don't", async () => {
  notified.length = 0;
  await api("POST", "/api/shipments/direct", { trackingNumber: "AWB500", customer: { email: "c@example.com" } });
  await api("PATCH", "/api/shipments/AWB500", { status: "IN TRANSIT" });
  await api("PATCH", "/api/shipments/AWB500", { eta: "2026-12-24" }); // details only
  await api("PATCH", "/api/shipments/AWB500/status", { status: "IN TRANSIT" }); // unchanged
  const stop = (await api("POST", "/api/shipments/AWB500/stops", { location: "Hub" })).body.shipment.stops[0];
  await api("PATCH", `/api/shipments/AWB500/stops/${stop.id}`, { status: "arrived" });
  await api("POST", "/api/shipments/AWB500/events", { title: "Cleared customs" });

  assert.deepEqual(notified, [
    { tn: "AWB500", titles: ["Accepted"] },
    { tn: "AWB500", titles: ["In Transit"] },
    { tn: "AWB500", titles: ["Arrived at Hub"] },
    { tn: "AWB500", titles: ["Cleared customs"] },
  ]);
});
