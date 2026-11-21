import nodemailer from "nodemailer";

/**
 * Optional SMTP transport. When SMTP_HOST / SMTP_USER / SMTP_PASS are missing
 * we log the notification instead of pretending an email was sent, so local
 * development stays usable without faking delivery.
 */
function createTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass },
  });
}

const transport = createTransport();
const fromAddress =
  process.env.MAIL_FROM || "SliceStack <no-reply@slicestack.app>";

const STATUS_COPY = {
  accepted: {
    subject: "Your SliceStack order was accepted",
    heading: "Your order is on the way",
    body: (itemName) =>
      `Good news — the shop accepted your order for ${itemName}. They will start preparing it for your delivery date.`,
  },
  rejected: {
    subject: "Your SliceStack order was rejected",
    heading: "Your order could not be accepted",
    body: (itemName) =>
      `The shop was unable to accept your order for ${itemName}. You have not been charged and can place a new order any time.`,
  },
};

function buildHtml({ heading, text, name }) {
  const safeName = name ? `Hi ${name},` : "Hello,";
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f7f4ef;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#2b1d16;">
    <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;">
      <tr><td>
        <p style="margin:0 0 8px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#b4441f;">SliceStack</p>
        <h1 style="margin:0 0 16px;font-size:22px;">${heading}</h1>
        <p style="margin:0 0 12px;line-height:1.6;">${safeName}</p>
        <p style="margin:0 0 20px;line-height:1.6;">${text}</p>
        <p style="margin:0;font-size:12px;color:#7a6a60;">This is an automated message from SliceStack.</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

async function sendMail({ to, subject, html }) {
  if (!to) return;

  if (!transport) {
    console.info(`[mail] SMTP not configured. Skipped "${subject}" to ${to}.`);
    return;
  }

  await transport.sendMail({ from: fromAddress, to, subject, html });
}

export async function sendOrderStatusEmail({ to, name, status, itemName }) {
  const copy = STATUS_COPY[status];
  if (!copy) return;

  await sendMail({
    to,
    subject: copy.subject,
    html: buildHtml({
      heading: copy.heading,
      text: copy.body(itemName || "your item"),
      name,
    }),
  });
}
