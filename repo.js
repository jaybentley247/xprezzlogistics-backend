// SQL for shipments, stops, tracking history, quotes and messages.
// Every function takes `q` (the db, or a transaction from db.tx) and returns
// objects in the same JSON shape the frontend has always received.

// API field -> shipments column, for fields an admin may edit.
const SHIPMENT_COLUMNS = {
  status: "status",
  service: "service",
  from: "from_location",
  to: "to_location",
  eta: "eta",
  weight: "weight",
  description: "description",
  metrics: "metrics",
  customer: "customer",
  details: "details",
  imageData: "image_data",
};
const JSON_COLUMNS = new Set(["metrics", "customer", "details"]);

const STOP_COLUMNS = {
  location: "location",
  note: "note",
  eta: "eta",
  status: "status",
  arrivedAt: "arrived_at",
  departedAt: "departed_at",
};

const iso = (v) => (v ? new Date(v).toISOString() : null);

function toStop(r) {
  return {
    id: r.id,
    location: r.location,
    note: r.note,
    eta: r.eta,
    status: r.status,
    arrivedAt: iso(r.arrived_at),
    departedAt: iso(r.departed_at),
  };
}

function toEvent(r) {
  return {
    id: r.id,
    time: iso(r.time),
    type: r.type,
    title: r.title,
    location: r.location,
    description: r.description,
    ...(r.status ? { status: r.status } : {}),
    ...(r.stop_id ? { stopId: r.stop_id } : {}),
  };
}

function toShipment(r, stops, events) {
  return {
    trackingNumber: r.tracking_number,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    status: r.status,
    service: r.service,
    from: r.from_location,
    to: r.to_location,
    eta: r.eta,
    weight: r.weight,
    description: r.description,
    metrics: r.metrics,
    customer: r.customer,
    details: r.details,
    imageData: r.image_data,
    stops: stops.map(toStop),
    trackingEvents: events.map(toEvent),
  };
}

// Builds "col = $n, ..." for an UPDATE from an { apiField: value } object.
function setClause(fields, columns, startIndex) {
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    const col = columns[key];
    if (!col || value === undefined) continue;
    values.push(JSON_COLUMNS.has(key) ? JSON.stringify(value ?? {}) : value);
    sets.push(`${col} = $${startIndex + values.length - 1}`);
  }
  return { sets, values };
}

async function loadShipments(q, where = "", params = []) {
  const { rows } = await q.query(
    `select * from shipments ${where} order by created_at`,
    params,
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.tracking_number);
  const stops = await q.query(
    "select * from shipment_stops where tracking_number = any($1) order by position",
    [ids],
  );
  const events = await q.query(
    "select * from tracking_events where tracking_number = any($1) order by seq",
    [ids],
  );
  return rows.map((r) =>
    toShipment(
      r,
      stops.rows.filter((s) => s.tracking_number === r.tracking_number),
      events.rows.filter((e) => e.tracking_number === r.tracking_number),
    ),
  );
}

// ---------- Shipments ----------

const listShipments = (q) => loadShipments(q);

async function getShipment(q, trackingNumber) {
  const [shipment] = await loadShipments(q, "where tracking_number = $1", [
    String(trackingNumber).trim().toUpperCase(),
  ]);
  return shipment || null;
}

// Locks the shipment row for the rest of the transaction. Returns its status, or null.
async function lockShipment(q, trackingNumber) {
  const { rows } = await q.query(
    "select status from shipments where tracking_number = $1 for update",
    [String(trackingNumber).trim().toUpperCase()],
  );
  return rows[0] || null;
}

async function shipmentExists(q, trackingNumber) {
  const { rows } = await q.query("select 1 from shipments where tracking_number = $1", [
    trackingNumber,
  ]);
  return rows.length > 0;
}

async function insertShipment(q, trackingNumber, fields, createdAt) {
  const cols = ["tracking_number", "created_at", "updated_at"];
  const values = [trackingNumber, createdAt, createdAt];
  for (const [key, col] of Object.entries(SHIPMENT_COLUMNS)) {
    if (fields[key] === undefined) continue;
    cols.push(col);
    values.push(JSON_COLUMNS.has(key) ? JSON.stringify(fields[key] ?? {}) : fields[key]);
  }
  await q.query(
    `insert into shipments (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    values,
  );
}

async function updateShipment(q, trackingNumber, fields, updatedAt) {
  const { sets, values } = setClause(fields, SHIPMENT_COLUMNS, 3);
  await q.query(
    `update shipments set ${["updated_at = $2", ...sets].join(", ")} where tracking_number = $1`,
    [trackingNumber, updatedAt, ...values],
  );
}

async function deleteShipment(q, trackingNumber) {
  const { rowCount } = await q.query("delete from shipments where tracking_number = $1", [
    trackingNumber,
  ]);
  return rowCount > 0;
}

// ---------- Tracking history (insert only) ----------

async function insertEvent(q, trackingNumber, e) {
  await q.query(
    `insert into tracking_events
       (id, tracking_number, time, type, title, location, description, status, stop_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.id,
      trackingNumber,
      e.time,
      e.type,
      e.title,
      e.location || "",
      e.description || "",
      e.status || null,
      e.stopId || null,
    ],
  );
}

// ---------- Stops ----------

async function getStop(q, trackingNumber, stopId) {
  if (!/^[0-9a-f-]{36}$/i.test(stopId)) return null; // not a uuid: can't exist
  const { rows } = await q.query(
    "select * from shipment_stops where tracking_number = $1 and id = $2",
    [trackingNumber, stopId],
  );
  return rows[0] ? toStop(rows[0]) : null;
}

async function stopIds(q, trackingNumber) {
  const { rows } = await q.query(
    "select id from shipment_stops where tracking_number = $1 order by position",
    [trackingNumber],
  );
  return rows.map((r) => r.id);
}

async function insertStop(q, trackingNumber, stop) {
  await q.query(
    `insert into shipment_stops (id, tracking_number, position, location, note, eta, status)
     values ($1, $2,
       (select coalesce(max(position), -1) + 1 from shipment_stops where tracking_number = $2),
       $3, $4, $5, 'upcoming')`,
    [stop.id, trackingNumber, stop.location, stop.note, stop.eta],
  );
}

async function updateStop(q, stopId, fields) {
  const { sets, values } = setClause(fields, STOP_COLUMNS, 2);
  if (sets.length === 0) return;
  await q.query(`update shipment_stops set ${sets.join(", ")} where id = $1`, [
    stopId,
    ...values,
  ]);
}

async function deleteStop(q, stopId) {
  await q.query("delete from shipment_stops where id = $1", [stopId]);
}

async function reorderStops(q, trackingNumber, order) {
  for (const [position, id] of order.entries()) {
    await q.query(
      "update shipment_stops set position = $3 where tracking_number = $1 and id = $2",
      [trackingNumber, id, position],
    );
  }
}

// ---------- Quotes ----------

function toQuote(r) {
  return {
    id: r.id,
    createdAt: iso(r.created_at),
    status: r.status,
    service: r.service,
    notes: r.notes,
    from: r.sender,
    to: r.recipient,
    package: r.package,
    ...(r.tracking_number ? { trackingNumber: r.tracking_number } : {}),
  };
}

async function insertQuote(q, quote) {
  await q.query(
    `insert into quotes (id, created_at, status, service, notes, sender, recipient, package, tracking_number)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      quote.id,
      quote.createdAt,
      quote.status,
      quote.service,
      quote.notes,
      JSON.stringify(quote.from),
      JSON.stringify(quote.to),
      JSON.stringify(quote.package),
      quote.trackingNumber || null,
    ],
  );
}

async function listQuotes(q) {
  const { rows } = await q.query("select * from quotes order by created_at");
  return rows.map(toQuote);
}

async function lockQuote(q, id) {
  const { rows } = await q.query("select * from quotes where id = $1 for update", [id]);
  return rows[0] ? toQuote(rows[0]) : null;
}

async function markQuoteConverted(q, id, trackingNumber) {
  await q.query("update quotes set status = 'converted', tracking_number = $2 where id = $1", [
    id,
    trackingNumber,
  ]);
}

// ---------- Contact messages ----------

async function insertMessage(q, m) {
  await q.query(
    `insert into messages (id, created_at, first_name, last_name, email, phone, topic, message)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [m.id, m.createdAt, m.firstName, m.lastName, m.email, m.phone, m.topic, m.message],
  );
}

async function listMessages(q) {
  const { rows } = await q.query("select * from messages order by created_at");
  return rows.map((r) => ({
    id: r.id,
    createdAt: iso(r.created_at),
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    topic: r.topic,
    message: r.message,
  }));
}

module.exports = {
  listShipments,
  getShipment,
  lockShipment,
  shipmentExists,
  insertShipment,
  updateShipment,
  deleteShipment,
  insertEvent,
  getStop,
  stopIds,
  insertStop,
  updateStop,
  deleteStop,
  reorderStops,
  insertQuote,
  listQuotes,
  lockQuote,
  markQuoteConverted,
  insertMessage,
  listMessages,
};
