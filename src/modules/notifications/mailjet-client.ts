import "server-only";

type MailjetMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  customId: string;
};

type MailjetResult = {
  messageId?: string;
  status: "accepted";
};

function getMailjetConfig() {
  const apiKey = process.env.MAILJET_API_KEY?.trim();
  const apiSecret = process.env.MAILJET_API_SECRET?.trim();
  const senderEmail = process.env.MAILJET_SENDER_EMAIL?.trim();
  const senderName = process.env.MAILJET_SENDER_NAME?.trim() || "SmartRoad Alerts";
  if (!apiKey || !apiSecret || !senderEmail) return null;
  return { apiKey, apiSecret, senderEmail, senderName };
}

export function isMailjetConfigured() {
  return Boolean(getMailjetConfig());
}

export async function sendMailjetMessage(message: MailjetMessage): Promise<MailjetResult> {
  const config = getMailjetConfig();
  if (!config) throw new Error("Mailjet is not configured.");

  const response = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      Messages: [
        {
          From: { Email: config.senderEmail, Name: config.senderName },
          To: [{ Email: message.to }],
          Subject: message.subject,
          TextPart: message.text,
          HTMLPart: message.html,
          CustomID: message.customId,
        },
      ],
    }),
  });

  const payload = (await response.json().catch(() => null)) as {
    Messages?: Array<{ Status?: string; To?: Array<{ MessageUUID?: string }> }>;
  } | null;
  const providerMessage = payload?.Messages?.[0];
  if (!response.ok || providerMessage?.Status !== "success") {
    throw new Error(`Mailjet request failed (${response.status}).`);
  }

  return { status: "accepted", messageId: providerMessage.To?.[0]?.MessageUUID };
}
