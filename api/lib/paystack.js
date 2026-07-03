import crypto from "crypto";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = "https://api.paystack.co";

if (!PAYSTACK_SECRET_KEY) {
  console.error("Missing PAYSTACK_SECRET_KEY. Add it to api/.env.");
  process.exit(1);
}

export async function initializeTransaction({ email, amountKobo, callbackUrl, reference }) {
  const response = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      amount: amountKobo, // Paystack uses kobo, so multiply naira by 100
      currency: "NGN",
      callback_url: callbackUrl,
      reference,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.status) {
    throw new Error(data.message || "Paystack initialize failed.");
  }
  return data.data; // { authorization_url, access_code, reference }
}

export async function verifyTransaction(reference) {
  const response = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
  });
  const data = await response.json();
  if (!response.ok || !data.status) {
    throw new Error(data.message || "Paystack verify failed.");
  }
  return data.data; // { status: "success" | ..., amount, customer, reference }
}

// Paystack signs webhook bodies with your secret key. Confirm the signature
// before trusting anything in the payload, otherwise anyone could POST a
// fake "payment succeeded" event and mint free codes.
export function isValidWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  return hash === signatureHeader;
}
