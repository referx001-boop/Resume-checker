import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { buildPrompt, extractScoreJson } from "./lib/prompt.js";
import { initializeTransaction, verifyTransaction, isValidWebhookSignature } from "./lib/paystack.js";
import { createCodeForReference, validateCode } from "./lib/codes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(cors());

const PROVIDER = (process.env.MODEL_PROVIDER || "mock").trim().toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;
const HUGGINGFACE_MODEL = process.env.HUGGINGFACE_MODEL || "nvidia_nim/minimaxai/minimax-m3";
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY?.trim();
const NVIDIA_API_URL = process.env.NVIDIA_API_URL?.trim() || "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL?.trim() || "microsoft/phi-4-mini-instruct";
const NVIDIA_MODEL_TIMEOUTS = {
  "microsoft/phi-4-mini-instruct": 20000,
  "nvidia/nemotron-mini-4b-instruct": 12000,
  "minimaxai/minimax-m3": 90000,
};
const NVIDIA_MODEL_FALLBACKS = (() => {
  const envFallbacks = process.env.NVIDIA_MODEL_FALLBACKS?.split(",").map((item) => item.trim()).filter(Boolean);
  const defaults = ["microsoft/phi-4-mini-instruct", "nvidia/nemotron-mini-4b-instruct", "minimaxai/minimax-m3"];
  return Array.from(new Set([NVIDIA_MODEL, ...(envFallbacks.length ? envFallbacks : defaults)]));
})();
const MOCK_FALLBACK = process.env.MOCK_FALLBACK === "true";
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || "12000");
const MAX_RESPONSE_TOKENS = Number(process.env.MAX_RESPONSE_TOKENS || "450");
const NVIDIA_REQUEST_TIMEOUT_MS = Number(process.env.NVIDIA_REQUEST_TIMEOUT_MS || "12000");

const PRICE_NGN = Number(process.env.PRICE_NGN || "1500");
const APP_URL = (process.env.APP_URL || "http://localhost:5173").replace(/\/$/, "");

if (PROVIDER === "anthropic" && !ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Add it to api/.env before starting.");
  process.exit(1);
}
if (PROVIDER === "huggingface" && !HUGGINGFACE_API_KEY) {
  console.error("Missing HUGGINGFACE_API_KEY. Add it to api/.env before starting.");
  process.exit(1);
}
if (PROVIDER === "nvidia" && !NVIDIA_API_KEY) {
  console.error("Missing NVIDIA_API_KEY. Add it to api/.env before starting.");
  process.exit(1);
}
if (!["anthropic", "huggingface", "nvidia", "mock"].includes(PROVIDER)) {
  console.error("Unsupported MODEL_PROVIDER. Set MODEL_PROVIDER=anthropic, huggingface, nvidia, or mock in api/.env.");
  process.exit(1);
}

async function fetchWithTimeout(url, options = {}, timeout = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function truncatePrompt(text) {
  if (typeof text !== "string") return text;
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return `${text.slice(0, MAX_PROMPT_CHARS)}\n\n[Resume text truncated to ${MAX_PROMPT_CHARS} characters for faster scoring.]`;
}

function buildMockScore() {
  const score = 70 + Math.floor(Math.random() * 21) - 10;
  return {
    score: Math.max(0, Math.min(100, score)),
    verdict: "Looks solid overall; tighten formatting and add more metrics.",
    findings: [
      { severity: "good", point: "Clear structure and relevant experience for the stated field." },
      { severity: "warning", point: "Some bullet points are vague; add measurable impact." },
      { severity: "warning", point: "Resume could use stronger action verbs and quantifiable results." },
      { severity: "warning", point: "Spacing and section ordering would be easier to scan." },
      { severity: "critical", point: "Missing a clear headline or summary statement for the role." },
    ],
  };
}

// Runs the prompt against whichever provider is configured and always
// returns the same {score, verdict, findings} shape (or throws).
async function scoreWithProvider(prompt) {
  if (PROVIDER === "mock") {
    return buildMockScore();
  }

  if (PROVIDER === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Anthropic request failed.");
    const text = Array.isArray(data.content) ? data.content.find((b) => b.type === "text")?.text : "";
    const parsed = extractScoreJson(text);
    if (!parsed) throw new Error("Anthropic response was not in the expected JSON shape.");
    return parsed;
  }

  if (PROVIDER === "huggingface") {
    const response = await fetch(`https://api-inference.huggingface.co/models/${encodeURIComponent(HUGGINGFACE_MODEL)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HUGGINGFACE_API_KEY}`,
      },
      body: JSON.stringify({
        inputs: prompt,
        options: { wait_for_model: true },
        parameters: { max_new_tokens: 1200, temperature: 0.2, return_full_text: false },
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Hugging Face request failed.");
    const text = typeof data === "string" ? data : data.generated_text || data[0]?.generated_text || "";
    const parsed = extractScoreJson(text);
    if (!parsed) throw new Error("Hugging Face response was not in the expected JSON shape.");
    return parsed;
  }

  if (PROVIDER === "nvidia") {
    let lastError = null;
    for (const model of NVIDIA_MODEL_FALLBACKS) {
      try {
        const modelTimeout = NVIDIA_MODEL_TIMEOUTS[model] || NVIDIA_REQUEST_TIMEOUT_MS;
        const response = await fetchWithTimeout(
          NVIDIA_API_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Authorization: `Bearer ${NVIDIA_API_KEY}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "system",
                  content:
                    'You score resumes for any industry. Return ONLY valid JSON in this exact shape, no markdown, no extra text: {"score": number 0-100, "verdict": one sentence summary, "findings": array of objects with severity (good, warning, or critical) and point (one sentence)}. Give 3 to 6 findings. Base every finding on the actual resume content provided. Never assume the resume should be for a tech or software role.',
                },
                { role: "user", content: truncatePrompt(prompt) },
              ],
              max_tokens: MAX_RESPONSE_TOKENS,
              temperature: 0.15,
              top_p: 0.9,
            }),
          },
          modelTimeout
        );

        const textBody = await response.text();
        if (!response.ok) {
          lastError = { model, status: response.status, body: textBody };
          continue;
        }

        const data = JSON.parse(textBody);
        const text = data.choices?.[0]?.message?.content || data.output?.[0]?.content || "";
        const parsed = extractScoreJson(text);
        if (parsed) return parsed;
        lastError = { model, error: "Response missing score, verdict, or findings", body: text };
      } catch (err) {
        lastError = { model, error: err.message, timeout: err.name === "AbortError" };
      }
    }
    throw new Error(`All NVIDIA models failed: ${JSON.stringify(lastError)}`);
  }

  throw new Error("Unsupported provider configuration.");
}

// --- Paystack webhook needs the raw request body to check the signature,
// so it's registered before the global express.json() middleware below. ---
app.post("/api/pay/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  if (!isValidWebhookSignature(req.body, signature)) {
    return res.status(401).json({ error: "Invalid signature." });
  }

  try {
    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event === "charge.success") {
      const { reference, customer } = event.data;
      await createCodeForReference({ reference, email: customer?.email });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handling failed:", err);
    res.sendStatus(200); // Ack anyway so Paystack doesn't hammer retries; we log and move on.
  }
});

app.use(express.json({ limit: "15mb" }));

// Starts a payment. Frontend redirects the browser to the returned URL.
app.post("/api/pay/initialize", async (req, res) => {
  try {
    const email = (req.body?.email || "").trim();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "A valid email is required." });
    }
    const reference = `rc_${crypto.randomUUID()}`;
    const data = await initializeTransaction({
      email,
      amountKobo: PRICE_NGN * 100,
      callbackUrl: APP_URL,
      reference,
    });
    res.json({ authorizationUrl: data.authorization_url, reference: data.reference });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Could not start payment." });
  }
});

// Called by the frontend right after Paystack redirects back with
// ?reference=... in the URL. Confirms payment, then hands back the code.
app.post("/api/pay/verify", async (req, res) => {
  try {
    const reference = (req.body?.reference || "").trim();
    if (!reference) return res.status(400).json({ error: "Missing reference." });

    const transaction = await verifyTransaction(reference);
    if (transaction.status !== "success") {
      return res.status(402).json({ error: "Payment was not successful." });
    }

    const code = await createCodeForReference({ reference, email: transaction.customer?.email });
    res.json({ code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Could not verify payment." });
  }
});

// Lets the frontend check a code is real and unused before letting someone
// into the tool, without spending it yet. Spending happens in /api/score.
app.post("/api/verify-code", async (req, res) => {
  try {
    const code = (req.body?.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ error: "Missing code." });

    const result = await validateCode(code);
    if (!result.valid) {
      const message = result.reason === "expired" ? "This code has expired. Pay again for a new one." : "That code doesn't match. Check with whoever sent you here.";
      return res.status(403).json({ error: message });
    }
    res.json({ valid: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not check that code." });
  }
});

app.post("/api/score", async (req, res) => {
  const code = (req.body?.code || "").trim().toUpperCase();
  const resumeText = req.body?.resumeText;
  const role = req.body?.role;

  if (!code) return res.status(400).json({ error: "Missing access code." });
  if (!resumeText || typeof resumeText !== "string" || resumeText.trim().length < 100) {
    return res.status(400).json({ error: "Resume text is missing or too short to score fairly." });
  }

  const check = await validateCode(code).catch((err) => {
    console.error("validateCode failed:", err);
    return { valid: false, reason: "error" };
  });
  if (!check.valid) {
    const message = check.reason === "expired" ? "That code has expired. Pay again for a new one." : "That code is invalid.";
    return res.status(403).json({ error: message });
  }

  try {
    const prompt = buildPrompt({ resumeText, role });
    const result = await scoreWithProvider(prompt);
    return res.json(result);
  } catch (err) {
    console.error(err);
    if (MOCK_FALLBACK) {
      return res.json(buildMockScore());
    }
    return res.status(500).json({ error: "Server failed to reach the model provider." });
  }
});

const isVercel = process.env.VERCEL === "1";

if (!isVercel) {
  const distPath = path.resolve(__dirname, "..", "dist");
  const indexPath = path.join(distPath, "index.html");

  if (fs.existsSync(indexPath)) {
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(indexPath);
    });
  } else {
    app.get("/", (req, res) => {
      res.json({ status: "ok", message: "ResumeCheck API is running." });
    });
  }

  const PORT = process.env.PORT || 3001;
  app
    .listen(PORT, () => {
      console.log(`ResumeCheck backend running on http://localhost:${PORT} using provider ${PROVIDER}`);
    })
    .on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. Stop the existing server or set PORT to a free port before restarting.`);
      } else {
        console.error(err);
      }
      process.exit(1);
    });
}

export default app;
