import { sendCustomerEmail } from "./email.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Challenge approval notification.
 * Deliberately does not email terminal passwords or other credential secrets.
 * The user can access account credentials through the authenticated dashboard.
 */
export async function sendChallengeApprovedEmail({ to, name, challenge, accountId }) {
  const safeName = escapeHtml(name || "Trader");
  const safeChallenge = escapeHtml(challenge || "Challenge account");
  const safeAccountId = escapeHtml(accountId || "");

  return sendCustomerEmail({
    to,
    subject: "Your Aura Farming challenge has been approved",
    text: `Hi ${name || "Trader"}, your ${challenge || "challenge"} has been approved. Trading account: ${accountId || "created"}. Please log in to your Aura Farming dashboard to access your account details.`,
    html: `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#050505;color:#fff;padding:24px"><div style="max-width:620px;margin:auto;border:1px solid #302713;border-radius:16px;padding:24px;background:#0a0a0a"><h1 style="color:#f1d98a">Challenge Approved</h1><p>Hi ${safeName},</p><p>Your <strong>${safeChallenge}</strong> challenge payment has been approved and your trading account has been created.</p><p><strong>Account ID:</strong> ${safeAccountId}</p><p>Log in to your Aura Farming dashboard to access your account details and terminal access.</p><p style="color:#9b8552;font-size:13px">For security, passwords and credential secrets are not included in this email.</p></div></body></html>`
  });
}
