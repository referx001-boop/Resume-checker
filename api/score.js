import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

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
  const envFallbacks = (process.env.NVIDIA_MODEL_FALLBACKS?.split(",").map((item) => item.trim()).filter(Boolean)) || [];
  const defaults = ["microsoft/phi-4-mini-instruct", "nvidia/nemotron-mini-4b-instruct", "minimaxai/minimax-m3"];
  return Array.from(new Set([NVIDIA_MODEL, ...(envFallbacks.length ? envFallbacks : defaults)]));
})();
const MOCK_FALLBACK = process.env.MOCK_FALLBACK === "true";
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || "12000");
const MAX_RESPONSE_TOKENS = Number(process.env.MAX_RESPONSE_TOKENS || "700");
const NVIDIA_REQUEST_TIMEOUT_MS = Number(process.env.NVIDIA_REQUEST_TIMEOUT_MS || "12000");

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

if (PROVIDER === "anthropic" && !ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Add it to server/.env before starting.");
  process.exit(1);
}

if (PROVIDER === "huggingface" && !HUGGINGFACE_API_KEY) {
  console.error("Missing HUGGINGFACE_API_KEY. Add it to server/.env before starting.");
  process.exit(1);
}

if (PROVIDER === "nvidia" && !NVIDIA_API_KEY) {
  console.error("Missing NVIDIA_API_KEY. Add it to server/.env before starting.");
  process.exit(1);
}

if (!["anthropic", "huggingface", "nvidia", "mock"].includes(PROVIDER)) {
  console.error("Unsupported MODEL_PROVIDER. Set MODEL_PROVIDER=anthropic, huggingface, nvidia, or mock in server/.env.");
  process.exit(1);
}

const SYSTEM_PROMPT =
  "You score resumes like an experienced recruiter. Read the resume text and return ONLY valid JSON in this exact shape, no markdown, no extra text: " +
  '{"score": number 0-100, "verdict": one direct sentence, "findings": array of objects with severity (good, warning, or critical) and point (one specific sentence), "rewriteSuggestions": array of objects with original (a weak line from the resume) and rewrite (a stronger version of that line)}. ' +
  "Give 4 to 8 findings. Give 2 to 5 rewriteSuggestions, only for lines that genuinely need work. Base every finding on the actual resume content provided.";

function buildPrompt(resumeText, role) {
  const roleLine = role ? `Target role: ${role}\n\n` : "";
  return `${roleLine}Resume:\n${resumeText}`;
}

function buildMockScore(resumeText, tier) {
  const score = 70 + Math.floor(Math.random() * 21) - 10;
  const full = {
    score: Math.max(0, Math.min(100, score)),
    verdict: "Looks solid overall. Tighten formatting and add more metrics.",
    findings: [
      { severity: "good", point: "Clear technical experience and relevant frontend skills." },
      { severity: "warning", point: "Some bullet points are vague. Add measurable impact." },
      { severity: "warning", point: "Resume could use stronger action verbs and quantifiable results." },
      { severity: "warning", point: "Spacing and section ordering would be easier to scan." },
      { severity: "critical", point: "Missing a clear headline or summary statement for the role." },
    ],
    rewriteSuggestions: [
      { original: "Responsible for building features", rewrite: "Built and shipped 6 customer-facing features used by 10,000+ users" },
    ],
  };
  return tier === "free" ? { score: full.score, verdict: full.verdict } : full;
}

function stripForTier(data, tier) {
  if (tier === "free") {
    return { score: data.score, verdict: data.verdict };
  }
  return data;
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function validateCode(code) {
  if (!code) return false;

  const { data, error } = await supabase
    .from("access_codes")
    .select("code, expires_at")
    .eq("code", code)
    .maybeSingle();

  if (error || !data) return false;

  return new Date(data.expires_at) > new Date();
}

async function markCodeUsed(code) {
  await supabase
    .from("access_codes")
    .update({ used: true, used_at: new Date().toISOString() })
    .eq("code", code)
    .eq("used", false);
}

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://resume-checker2-tau.vercel.app";
const PRICE_NGN = Number(process.env.PRICE_NGN || "1500");

function generateAccessCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

app.post("/api/pay/initialize", async (req, res) => {
  const { email } = req.body || {};

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Enter a valid email." });
  }

  if (!PAYSTACK_SECRET_KEY) {
    return res.status(500).json({ error: "Payment is not configured on the server." });
  }

  try {
    const paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: PRICE_NGN * 100,
        callback_url: `${FRONTEND_URL}/app`,
      }),
    });

    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status) {
      return res.status(400).json({ error: paystackData.message || "Could not start payment." });
    }

    const { authorization_url: authorizationUrl, reference } = paystackData.data;

    let code = generateAccessCode();
    let insertError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error } = await supabase.from("access_codes").insert({ code, reference, email });
      if (!error) {
        insertError = null;
        break;
      }
      insertError = error;
      code = generateAccessCode();
    }
    if (insertError) {
      return res.status(500).json({ error: "Could not create an access code. Try again." });
    }

    return res.json({ authorizationUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not reach Paystack. Try again." });
  }
});

app.post("/api/pay/verify", async (req, res) => {
  const { reference } = req.body || {};

  if (!reference) {
    return res.status(400).json({ error: "Missing payment reference." });
  }

  if (!PAYSTACK_SECRET_KEY) {
    return res.status(500).json({ error: "Payment is not configured on the server." });
  }

  try {
    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });

    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || paystackData.data?.status !== "success") {
      return res.status(400).json({ error: "Payment could not be verified." });
    }

    const { data, error } = await supabase
      .from("access_codes")
      .select("code")
      .eq("reference", reference)
      .maybeSingle();

    if (error || !data) {
      return res.status(404).json({ error: "No access code found for this payment." });
    }

    return res.json({ code: data.code });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not verify payment. Try again." });
  }
});

app.post("/api/verify-code", async (req, res) => {
  const { code } = req.body || {};
  const cleaned = (code || "").trim().toUpperCase();

  if (!cleaned) {
    return res.status(400).json({ error: "Enter your access code." });
  }

  const valid = await validateCode(cleaned);
  if (!valid) {
    return res.status(403).json({ error: "That code doesn't match or has expired." });
  }

  return res.json({ ok: true });
});

app.post("/api/score", async (req, res) => {
  const { resumeText, role, code, tier } = req.body || {};

  if (!resumeText || typeof resumeText !== "string" || resumeText.trim().length < 100) {
    return res.status(400).json({ error: "Resume text is too short to score." });
  }

  if (tier !== "free") {
    const valid = await validateCode(code);
    if (!valid) {
      return res.status(403).json({ error: "That code is no longer valid." });
    }
    markCodeUsed(code).catch((err) => console.error("Failed to mark code used:", err));
  }

  const prompt = buildPrompt(resumeText, role);

  try {
    if (PROVIDER === "mock") {
      return res.json(buildMockScore(resumeText, tier));
    }

    if (PROVIDER === "nvidia") {
      let lastError = null;
      let data = null;
      let response = null;
      let textBody = "";

      for (const model of NVIDIA_MODEL_FALLBACKS) {
        try {
          const modelTimeout = NVIDIA_MODEL_TIMEOUTS[model] || NVIDIA_REQUEST_TIMEOUT_MS;
          response = await fetchWithTimeout(
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
                  { role: "system", content: SYSTEM_PROMPT },
                  { role: "user", content: truncatePrompt(prompt) },
                ],
                max_tokens: MAX_RESPONSE_TOKENS,
                temperature: 0.15,
                top_p: 0.9,
              }),
            },
            modelTimeout
          );

          textBody = await response.text();

          if (!response.ok) {
            lastError = { model, status: response.status, body: textBody };
            continue;
          }

          try {
            data = JSON.parse(textBody);
          } catch {
            lastError = { model, error: "Invalid JSON", body: textBody };
            continue;
          }

          const text =
            typeof data === "string" ? data : data.choices?.[0]?.message?.content || data.output?.[0]?.content || JSON.stringify(data);

          if (text && text.trim()) {
            const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
            try {
              const parsed = JSON.parse(cleaned);
              if (typeof parsed.score === "number" && parsed.verdict && Array.isArray(parsed.findings)) {
                if (!Array.isArray(parsed.rewriteSuggestions)) parsed.rewriteSuggestions = [];
                return res.json(stripForTier(parsed, tier));
              }
              lastError = { model, error: "Response missing score, verdict, or findings", body: cleaned };
              continue;
            } catch {
              lastError = { model, error: "Response was not valid JSON", body: cleaned };
              continue;
            }
          }

          lastError = { model, status: response.status, body: textBody, info: "Empty or missing assistant text" };
        } catch (err) {
          lastError = { model, error: err.message, timeout: err.name === "AbortError" };
          continue;
        }
      }

      if (MOCK_FALLBACK) {
        return res.json(buildMockScore(resumeText, tier));
      }

      return res.status(502).json({
        error: "All NVIDIA models failed to produce a valid response.",
        attempts: NVIDIA_MODEL_FALLBACKS,
        lastError,
      });
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
          max_tokens: 1500,
          messages: [{ role: "user", content: `${SYSTEM_PROMPT}\n\n${prompt}` }],
        }),
      });

      const raw = await response.json();
      const text = raw.content?.[0]?.text?.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.rewriteSuggestions)) parsed.rewriteSuggestions = [];
      return res.json(stripForTier(parsed, tier));
    }

    if (PROVIDER === "huggingface") {
      const response = await fetch(`https://api-inference.huggingface.co/models/${encodeURIComponent(HUGGINGFACE_MODEL)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${HUGGINGFACE_API_KEY}`,
        },
        body: JSON.stringify({
          inputs: `${SYSTEM_PROMPT}\n\n${prompt}`,
          options: { wait_for_model: true },
          parameters: { max_new_tokens: MAX_RESPONSE_TOKENS, temperature: 0.2, return_full_text: false },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (MOCK_FALLBACK) return res.json(buildMockScore(resumeText, tier));
        return res.status(response.status).json(data);
      }

      const text = typeof data === "string" ? data : data.generated_text || data[0]?.generated_text || "";
      const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed.rewriteSuggestions)) parsed.rewriteSuggestions = [];
      return res.json(stripForTier(parsed, tier));
    }

    return res.status(500).json({ error: "Unsupported provider configuration." });
  } catch (err) {
    console.error(err);
    if (MOCK_FALLBACK) {
      return res.json(buildMockScore(resumeText, tier));
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
