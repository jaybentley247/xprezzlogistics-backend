// Emails the shipment's recipient when its tracking changes, via Resend.
// Sending happens after the update is saved and never fails the request:
// a missing key or a Resend error is logged and the update still succeeds.

const RESEND_URL = "https://api.resend.com/emails";

// History entries customers are told about. Route edits (stop added,
// renamed, removed) are internal and don't trigger an email.
const NOTIFY_TYPES = new Set(["status", "stop", "update"]);

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const titleCase = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const formatTime = (iso) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  });

const isEmail = (s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

function buildEmail(shipment, events, siteUrl) {
  const tn = shipment.trackingNumber;
  const status = titleCase(shipment.status);
  const name = shipment.customer?.toName;
  const link = siteUrl ? `${siteUrl.replace(/\/+$/, "")}/shipment/${encodeURIComponent(tn)}` : null;
  const latest = events[events.length - 1];
  const subject =
    events.length === 1 && latest.type === "status" && latest.description === "Shipment created"
      ? `Your shipment ${tn} has been accepted`
      : `Shipment ${tn} update: ${latest.title}`;

  const items = events.map((e) => ({
    title: e.title,
    lines: [e.location, e.description].filter(Boolean),
    time: formatTime(e.time),
  }));

  const text = [
    `Hello${name ? ` ${name}` : ""},`,
    "",
    `There's a new update on your shipment ${tn}.`,
    "",
    ...items.flatMap((i) => [`- ${i.title}`, ...i.lines.map((l) => `  ${l}`), `  ${i.time}`]),
    "",
    `Current status: ${status}`,
    `Estimated delivery: ${shipment.eta || "TBD"}`,
    ...(link ? ["", `Track your shipment: ${link}`] : []),
    "",
    "Xprezz Logistics",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
    <tr><td style="background:#0f1b2b;padding:20px 28px;color:#fff">
      <div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#E85C1A;font-weight:bold">Xprezz Logistics</div>
      <div style="font-size:20px;font-weight:bold;margin-top:6px">Shipment update</div>
    </td></tr>
    <tr><td style="padding:24px 28px">
      <p style="margin:0 0 16px">Hello${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p style="margin:0 0 20px">There's a new update on your shipment <strong>${escapeHtml(tn)}</strong>.</p>
      ${items
        .map(
          (i) => `<div style="border-left:3px solid #E85C1A;padding:4px 0 4px 14px;margin-bottom:14px">
        <div style="font-weight:bold">${escapeHtml(i.title)}</div>
        ${i.lines.map((l) => `<div style="color:#555;font-size:14px">${escapeHtml(l)}</div>`).join("")}
        <div style="color:#888;font-size:13px">${escapeHtml(i.time)}</div>
      </div>`,
        )
        .join("")}
      <table role="presentation" style="margin:20px 0;font-size:14px">
        <tr><td style="color:#888;padding-right:16px">Current status</td><td style="font-weight:bold">${escapeHtml(status)}</td></tr>
        <tr><td style="color:#888;padding-right:16px">Estimated delivery</td><td style="font-weight:bold">${escapeHtml(shipment.eta || "TBD")}</td></tr>
      </table>
      ${
        link
          ? `<a href="${escapeHtml(link)}" style="display:inline-block;background:#E85C1A;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">Track your shipment</a>`
          : ""
      }
    </td></tr>
    <tr><td style="padding:16px 28px;background:#fafafa;color:#888;font-size:12px">
      You're receiving this because a shipment was sent to you with Xprezz Logistics.
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

function createNotifier({ apiKey, from, siteUrl, fetchImpl = fetch, log = console } = {}) {
  if (!apiKey || !from) {
    log.warn?.("Email notifications are off (set RESEND_API_KEY and EMAIL_FROM to enable).");
  }

  // Resolves when the email is sent or skipped; never rejects.
  async function shipmentUpdated(shipment, events) {
    if (!apiKey || !from || !shipment) return { skipped: "disabled" };
    const notify = (events || []).filter((e) => e && NOTIFY_TYPES.has(e.type));
    if (notify.length === 0) return { skipped: "no customer-facing changes" };
    const to = shipment.customer?.email?.trim();
    if (!isEmail(to)) return { skipped: "no recipient email" };

    const { subject, text, html } = buildEmail(shipment, notify, siteUrl);
    try {
      const res = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        log.error?.(`Resend rejected email for ${shipment.trackingNumber} (${res.status}): ${detail}`);
        return { error: res.status };
      }
      return { sent: true };
    } catch (err) {
      log.error?.(`Could not send email for ${shipment.trackingNumber}: ${err.message}`);
      return { error: err.message };
    }
  }

  return { shipmentUpdated };
}

module.exports = { createNotifier, buildEmail };
