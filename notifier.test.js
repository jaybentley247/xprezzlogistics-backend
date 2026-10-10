const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createNotifier } = require("./notifier");

const quietLog = { warn() {}, error() {} };

const shipment = {
  trackingNumber: "AWB1",
  status: "IN TRANSIT",
  eta: "2026-11-01",
  customer: { toName: "Ada <b>", email: "ada@example.com" },
};
const event = (type, title, extra = {}) => ({
  id: title,
  time: "2026-10-10T12:00:00.000Z",
  type,
  title,
  location: "",
  description: "",
  ...extra,
});

function fakeFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (response instanceof Error) throw response;
    return { ok: response.ok, status: response.status, text: async () => "detail" };
  };
  fn.calls = calls;
  return fn;
}

const notifierWith = (fetchImpl, extra = {}) =>
  createNotifier({
    apiKey: "re_test",
    from: "Xprezz <updates@example.com>",
    siteUrl: "https://xprezz.example/",
    fetchImpl,
    log: quietLog,
    ...extra,
  });

test("sends one email to the recipient with the update and a tracking link", async () => {
  const fetchImpl = fakeFetch();
  const result = await notifierWith(fetchImpl).shipmentUpdated(shipment, [
    event("stop", "Arrived at Dubai Hub", { location: "Dubai" }),
  ]);

  assert.deepEqual(result, { sent: true });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init, body } = fetchImpl.calls[0];
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(init.headers.Authorization, "Bearer re_test");
  assert.deepEqual(body.to, ["ada@example.com"]);
  assert.equal(body.from, "Xprezz <updates@example.com>");
  assert.equal(body.subject, "Shipment AWB1 update: Arrived at Dubai Hub");
  assert.match(body.text, /Track your shipment: https:\/\/xprezz\.example\/shipment\/AWB1/);
  assert.match(body.html, /Arrived at Dubai Hub/);
  // Customer-supplied text is escaped, not injected as HTML.
  assert.match(body.html, /Ada &lt;b&gt;/);
});

test("new shipments get an 'accepted' subject", async () => {
  const fetchImpl = fakeFetch();
  await notifierWith(fetchImpl).shipmentUpdated(shipment, [
    event("status", "Accepted", { status: "ACCEPTED", description: "Shipment created" }),
  ]);
  assert.equal(fetchImpl.calls[0].body.subject, "Your shipment AWB1 has been accepted");
});

test("route edits, missing emails and missing config send nothing", async () => {
  const fetchImpl = fakeFetch();
  const n = notifierWith(fetchImpl);

  assert.equal((await n.shipmentUpdated(shipment, [event("route", "Stop added to route")])).skipped, "no customer-facing changes");
  assert.equal(
    (await n.shipmentUpdated({ ...shipment, customer: { email: "not-an-email" } }, [event("update", "x")])).skipped,
    "no recipient email",
  );
  const off = createNotifier({ fetchImpl, log: quietLog });
  assert.equal((await off.shipmentUpdated(shipment, [event("update", "x")])).skipped, "disabled");
  assert.equal(fetchImpl.calls.length, 0);
});

test("Resend errors and network failures are reported, never thrown", async () => {
  const rejected = await notifierWith(fakeFetch({ ok: false, status: 422 })).shipmentUpdated(shipment, [
    event("update", "x"),
  ]);
  assert.deepEqual(rejected, { error: 422 });

  const offline = await notifierWith(fakeFetch(new Error("ECONNRESET"))).shipmentUpdated(shipment, [
    event("update", "x"),
  ]);
  assert.deepEqual(offline, { error: "ECONNRESET" });
});
