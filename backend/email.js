const RESEND_API_URL = "https://api.resend.com/emails";

function emailConfig() {
  return {
    apiKey: String(process.env.RESEND_API_KEY || "").trim(),
    from: String(process.env.RESEND_FROM_EMAIL || "").trim()
  };
}

/**
 * Send a transactional customer email through Resend.
 * This helper is intentionally isolated: importing it has no side effects,
 * and no email is sent until a caller explicitly invokes sendCustomerEmail.
 */
export async function sendCustomerEmail({ to, subject, html, text = "" }) {
  const recipient = String(to || "").trim();
  const config = emailConfig();

  if (!recipient || !subject || !html || !config.apiKey || !config.from) {
    return { ok: false, skipped: true };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: config.from,
        to: [recipient],
        subject: String(subject),
        html: String(html),
        ...(text ? { text: String(text) } : {})
      })
    });

    const body = await response.text();
    if (!response.ok) {
      console.error("RESEND_EMAIL_ERROR", response.status, body.slice(0, 500));
      return { ok: false, skipped: false };
    }

    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch {}
    return { ok: true, id: data.id || null };
  } catch (error) {
    console.error("RESEND_EMAIL_ERROR", error?.message || error);
    return { ok: false, skipped: false };
  }
}
