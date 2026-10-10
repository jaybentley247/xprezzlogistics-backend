const crypto = require("node:crypto");
const express = require("express");
const cors = require("cors");
const repo = require("./repo");
const { issueToken, requireAdmin, safeEqual } = require("./auth");

// Shipment fields an admin may set on create/update. Tracking history and
// stops only change through their own endpoints, and history entries are
// never edited or removed (the database enforces this too).
const TEXT_FIELDS = ["service", "from", "to", "eta", "weight", "description", "imageData"];
const JSON_FIELDS = ["metrics", "customer", "details"];

const STOP_STATUSES = ["upcoming", "arrived", "departed"];

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clean = (v) => (typeof v === "string" ? v.trim() : "");

const titleCase = (s) =>
  clean(s)
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Copies the editable fields present in `body`, coerced to the stored types.
function shipmentFields(body) {
  const out = {};
  for (const k of TEXT_FIELDS) if (body[k] !== undefined) out[k] = String(body[k] ?? "");
  for (const k of JSON_FIELDS) if (body[k] !== undefined) out[k] = isObject(body[k]) ? body[k] : {};
  return out;
}

const normalizeTn = (id) => String(id).trim().toUpperCase();

const NO_NOTIFIER = { shipmentUpdated: async () => {} };

function createApp({ db, adminUsername, adminPassword, tokenSecret, corsOrigin, notifier = NO_NOTIFIER }) {
  const app = express();

  // Emails the customer after a change is saved. Not awaited: email
  // delivery never slows down or fails the admin's request.
  const notifyCustomer = (shipment, events) => {
    if (shipment && events.length) notifier.shipmentUpdated(shipment, events).catch(() => {});
  };

  app.use(cors(corsOrigin ? { origin: corsOrigin.split(",").map((o) => o.trim()) } : {}));
  app.use(express.json({ limit: "15mb" })); // shipment photos arrive as data URLs

  const admin = requireAdmin(tokenSecret);

  const notFound = (res, what = "Shipment") => res.status(404).json({ error: `${what} not found` });

  const statusEvent = (status, description) => ({
    id: newId(),
    time: now(),
    type: "status",
    status,
    title: titleCase(status),
    description,
  });

  async function generateTrackingNumber(q) {
    for (;;) {
      const tn = "AWB" + crypto.randomInt(100000000, 999999999) + crypto.randomInt(100, 999);
      if (!(await repo.shipmentExists(q, tn))) return tn;
    }
  }

  // Inserts a shipment and its first history entry.
  async function createShipment(q, trackingNumber, body) {
    const status = clean(body.status).toUpperCase() || "ACCEPTED";
    const event = statusEvent(status, "Shipment created");
    await repo.insertShipment(q, trackingNumber, { ...shipmentFields(body), status }, event.time);
    await repo.insertEvent(q, trackingNumber, event);
    return event;
  }

  // Changes status and appends it to the history. Returns the new history
  // entry, or null if the status didn't change.
  async function changeStatus(q, trackingNumber, currentStatus, nextStatus, description) {
    const next = clean(nextStatus).toUpperCase();
    if (!next || next === currentStatus) return null;
    const event = statusEvent(next, clean(description));
    await repo.updateShipment(q, trackingNumber, { status: next }, event.time);
    await repo.insertEvent(q, trackingNumber, event);
    return event;
  }

  // ---------- Health ----------
  app.get("/api/health", async (req, res) => {
    await db.query("select 1");
    res.json({ ok: true });
  });

  // ---------- Auth ----------
  app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body || {};
    if (
      !adminPassword ||
      !safeEqual(clean(username), adminUsername) ||
      !safeEqual(String(password ?? ""), adminPassword)
    ) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    res.json({ token: issueToken(adminUsername, tokenSecret) });
  });

  // ---------- Public tracking ----------
  app.get("/api/tracking/:id", async (req, res) => {
    const shipment = await repo.getShipment(db, req.params.id);
    if (!shipment) return notFound(res);
    res.json(shipment);
  });

  // ---------- Shipments (admin) ----------
  app.get("/api/shipments", admin, async (req, res) => {
    res.json(await repo.listShipments(db));
  });

  // Create a shipment from the admin form.
  app.post("/api/shipments/direct", admin, async (req, res) => {
    const body = req.body || {};
    const requested = normalizeTn(clean(body.trackingNumber));
    let created;
    const shipment = await db.tx(async (q) => {
      if (requested && (await repo.shipmentExists(q, requested))) return null;
      const tn = requested || (await generateTrackingNumber(q));
      created = await createShipment(q, tn, body);
      return repo.getShipment(q, tn);
    });
    if (!shipment) return res.status(409).json({ error: "Tracking number already exists" });
    notifyCustomer(shipment, [created]);
    res.status(201).json({ success: true, trackingNumber: shipment.trackingNumber, shipment });
  });

  // Create a shipment from a customer quote request.
  app.post("/api/shipments", admin, async (req, res) => {
    const { quoteId, eta } = req.body || {};
    const result = await db.tx(async (q) => {
      const quote = await repo.lockQuote(q, String(quoteId ?? ""));
      if (!quote) return { error: 404 };
      if (quote.status !== "pending") return { error: 409 };

      const tn = await generateTrackingNumber(q);
      const created = await createShipment(q, tn, {
        service: titleCase(quote.service) || "Standard Shipping",
        from: quote.from.city || quote.from.address || "",
        to: quote.to.city || quote.to.address || "",
        eta: clean(eta) || "TBD",
        weight: `${quote.package.weight || 0} kg`,
        description: quote.notes,
        customer: {
          name: quote.from.name,
          phone: quote.from.phone,
          toName: quote.to.name,
          toPhone: quote.to.phone,
          email: quote.to.email,
        },
        details: {
          senderAddress: [quote.from.address, quote.from.city, quote.from.zip].filter(Boolean).join(", "),
          recipientAddress: [quote.to.address, quote.to.city, quote.to.zip].filter(Boolean).join(", "),
        },
      });
      await repo.markQuoteConverted(q, quote.id, tn);
      return { shipment: await repo.getShipment(q, tn), created };
    });

    if (result.error === 404) return notFound(res, "Quote");
    if (result.error === 409) return res.status(409).json({ error: "Quote already converted" });
    const { shipment } = result;
    notifyCustomer(shipment, [result.created]);
    res.status(201).json({ success: true, trackingNumber: shipment.trackingNumber, shipment });
  });

  // Edit shipment details. A status change is appended to the history;
  // nothing already in the history is touched.
  app.patch("/api/shipments/:id", admin, async (req, res) => {
    const body = req.body || {};
    const tn = normalizeTn(req.params.id);
    let changed = null;
    const shipment = await db.tx(async (q) => {
      const current = await repo.lockShipment(q, tn);
      if (!current) return null;
      await repo.updateShipment(q, tn, shipmentFields(body), now());
      if (body.status) changed = await changeStatus(q, tn, current.status, body.status);
      return repo.getShipment(q, tn);
    });
    if (!shipment) return notFound(res);
    if (changed) notifyCustomer(shipment, [changed]);
    res.json({ success: true, shipment });
  });

  app.patch("/api/shipments/:id/status", admin, async (req, res) => {
    const status = clean(req.body?.status);
    if (!status) return res.status(400).json({ error: "Status is required" });
    const tn = normalizeTn(req.params.id);
    let changed = null;
    const shipment = await db.tx(async (q) => {
      const current = await repo.lockShipment(q, tn);
      if (!current) return null;
      changed = await changeStatus(q, tn, current.status, status, req.body?.description);
      return repo.getShipment(q, tn);
    });
    if (!shipment) return notFound(res);
    if (changed) notifyCustomer(shipment, [changed]);
    res.json({ success: true, shipment });
  });

  app.delete("/api/shipments/:id", admin, async (req, res) => {
    const deleted = await repo.deleteShipment(db, normalizeTn(req.params.id));
    if (!deleted) return notFound(res);
    res.json({ success: true });
  });

  // ---------- Tracking history (append-only) ----------
  app.post("/api/shipments/:id/events", admin, async (req, res) => {
    const title = clean(req.body?.title);
    if (!title) return res.status(400).json({ error: "Title is required" });
    const tn = normalizeTn(req.params.id);
    let added;
    const shipment = await db.tx(async (q) => {
      if (!(await repo.lockShipment(q, tn))) return null;
      const time = now();
      added = {
        id: newId(),
        time,
        type: "update",
        title,
        location: clean(req.body.location),
        description: clean(req.body.description),
      };
      await repo.insertEvent(q, tn, added);
      await repo.updateShipment(q, tn, {}, time);
      return repo.getShipment(q, tn);
    });
    if (!shipment) return notFound(res);
    notifyCustomer(shipment, [added]);
    res.status(201).json({ success: true, shipment });
  });

  // ---------- Stops along the route (editable) ----------
  const routeEvent = (title, location, stopId, extra = {}) => ({
    id: newId(),
    time: now(),
    type: "route",
    title,
    location,
    stopId,
    ...extra,
  });

  app.post("/api/shipments/:id/stops", admin, async (req, res) => {
    const location = clean(req.body?.location);
    if (!location) return res.status(400).json({ error: "Location is required" });
    const tn = normalizeTn(req.params.id);
    const shipment = await db.tx(async (q) => {
      if (!(await repo.lockShipment(q, tn))) return null;
      const stop = { id: newId(), location, note: clean(req.body.note), eta: clean(req.body.eta) };
      await repo.insertStop(q, tn, stop);
      const event = routeEvent("Stop added to route", location, stop.id);
      await repo.insertEvent(q, tn, event);
      await repo.updateShipment(q, tn, {}, event.time);
      return repo.getShipment(q, tn);
    });
    if (!shipment) return notFound(res);
    res.status(201).json({ success: true, shipment });
  });

  app.patch("/api/shipments/:id/stops/:stopId", admin, async (req, res) => {
    const body = req.body || {};
    const tn = normalizeTn(req.params.id);

    if (body.location !== undefined && !clean(body.location)) {
      return res.status(400).json({ error: "Location cannot be empty" });
    }
    if (body.status !== undefined && !STOP_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: "Invalid stop status" });
    }

    const result = await db.tx(async (q) => {
      if (!(await repo.lockShipment(q, tn))) return { missing: "Shipment" };
      const stop = await repo.getStop(q, tn, req.params.stopId);
      if (!stop) return { missing: "Stop" };

      const at = now();
      const changes = {};
      const events = [];

      if (body.note !== undefined) changes.note = clean(body.note);
      if (body.eta !== undefined) changes.eta = clean(body.eta);
      const note = changes.note ?? stop.note;

      let location = stop.location;
      if (body.location !== undefined && clean(body.location) !== stop.location) {
        location = clean(body.location);
        changes.location = location;
        events.push(
          routeEvent("Stop updated", location, stop.id, { description: `Previously: ${stop.location}` }),
        );
      }

      if (body.status !== undefined && body.status !== stop.status) {
        changes.status = body.status;
        if (body.status === "arrived") {
          Object.assign(changes, { arrivedAt: at, departedAt: null });
          events.push({ id: newId(), time: at, type: "stop", title: `Arrived at ${location}`, location, description: note, stopId: stop.id });
        } else if (body.status === "departed") {
          Object.assign(changes, { arrivedAt: stop.arrivedAt || at, departedAt: at });
          events.push({ id: newId(), time: at, type: "stop", title: `Departed ${location}`, location, description: note, stopId: stop.id });
        } else {
          Object.assign(changes, { arrivedAt: null, departedAt: null });
          events.push(routeEvent("Stop reset to upcoming", location, stop.id));
        }
      }

      await repo.updateStop(q, stop.id, changes);
      for (const event of events) await repo.insertEvent(q, tn, event);
      await repo.updateShipment(q, tn, {}, at);
      return { shipment: await repo.getShipment(q, tn), events };
    });

    if (result.missing) return notFound(res, result.missing);
    notifyCustomer(result.shipment, result.events);
    res.json({ success: true, shipment: result.shipment });
  });

  app.delete("/api/shipments/:id/stops/:stopId", admin, async (req, res) => {
    const tn = normalizeTn(req.params.id);
    const result = await db.tx(async (q) => {
      if (!(await repo.lockShipment(q, tn))) return { missing: "Shipment" };
      const stop = await repo.getStop(q, tn, req.params.stopId);
      if (!stop) return { missing: "Stop" };
      await repo.deleteStop(q, stop.id);
      const event = routeEvent("Stop removed from route", stop.location, stop.id);
      await repo.insertEvent(q, tn, event);
      await repo.updateShipment(q, tn, {}, event.time);
      return { shipment: await repo.getShipment(q, tn) };
    });
    if (result.missing) return notFound(res, result.missing);
    res.json({ success: true, shipment: result.shipment });
  });

  // Reorder stops: body { order: [stopId, ...] } containing every stop id.
  app.put("/api/shipments/:id/stops/order", admin, async (req, res) => {
    const order = req.body?.order;
    const tn = normalizeTn(req.params.id);
    const result = await db.tx(async (q) => {
      if (!(await repo.lockShipment(q, tn))) return { missing: true };
      const ids = await repo.stopIds(q, tn);
      if (
        !Array.isArray(order) ||
        order.length !== ids.length ||
        new Set(order).size !== ids.length ||
        !ids.every((id) => order.includes(id))
      ) {
        return { invalid: true };
      }
      await repo.reorderStops(q, tn, order);
      await repo.updateShipment(q, tn, {}, now());
      return { shipment: await repo.getShipment(q, tn) };
    });
    if (result.missing) return notFound(res);
    if (result.invalid) return res.status(400).json({ error: "Order must list every stop id once" });
    res.json({ success: true, shipment: result.shipment });
  });

  // ---------- Quotes ----------
  app.post("/api/quotes", async (req, res) => {
    const b = req.body || {};
    if (!clean(b.fromName) || !clean(b.toName)) {
      return res.status(400).json({ error: "Sender and recipient names are required" });
    }
    const party = (prefix) => ({
      name: clean(b[`${prefix}Name`]),
      address: clean(b[`${prefix}Address`]),
      city: clean(b[`${prefix}City`]),
      zip: clean(b[`${prefix}Zip`]),
      phone: clean(b[`${prefix}Phone`]),
      email: clean(b[`${prefix}Email`]),
    });
    const quote = {
      id: "QT" + Date.now().toString(36).toUpperCase() + crypto.randomInt(10, 99),
      createdAt: now(),
      status: "pending",
      service: clean(b.service) || "standard",
      notes: clean(b.notes),
      from: party("from"),
      to: party("to"),
      package: {
        weight: clean(b.weight),
        length: clean(b.length),
        width: clean(b.width),
        height: clean(b.height),
      },
    };
    await repo.insertQuote(db, quote);
    res.status(201).json({ success: true, id: quote.id });
  });

  app.get("/api/quotes", admin, async (req, res) => res.json(await repo.listQuotes(db)));

  // ---------- Contact messages ----------
  app.post("/api/contact", async (req, res) => {
    const b = req.body || {};
    if (!clean(b.email) || !clean(b.message)) {
      return res.status(400).json({ error: "Email and message are required" });
    }
    await repo.insertMessage(db, {
      id: newId(),
      createdAt: now(),
      firstName: clean(b.firstName),
      lastName: clean(b.lastName),
      email: clean(b.email),
      phone: clean(b.phone),
      topic: clean(b.topic),
      message: clean(b.message),
    });
    res.status(201).json({ success: true });
  });

  app.get("/api/contact", admin, async (req, res) => res.json(await repo.listMessages(db)));

  // ---------- Errors ----------
  app.use((req, res) => res.status(404).json({ error: "Not found" }));
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: "Upload too large" });
    }
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Invalid JSON" });
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  });

  return app;
}

module.exports = { createApp };
