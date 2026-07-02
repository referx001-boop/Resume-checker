import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

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
  const envFallbacks = process.env.NVIDIA_MODEL_FALLBACKS?.split(",").map((item) => item.trim()).filter(Boolean);
  const defaults = ["microsoft/phi-4-mini-instruct", "nvidia/nemotron-mini-4b-instruct", "minimaxai/minimax-m3"];
  return Array.from(new Set([NVIDIA_MODEL, ...(envFallbacks.length ? envFallbacks : defaults)]));
})();
const MOCK_FALLBACK = process.env.MOCK_FALLBACK === "true";
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || "12000");
const MAX_RESPONSE_TOKENS = Number(process.env.MAX_RESPONSE_TOKENS || "450");
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

function buildTextForHuggingFace(content) {
  const textBlock = Array.isArray(content)
    ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n")
    : typeof content === "string"
    ? content
    : "";

  if (!textBlock || !textBlock.trim()) {
    return null;
  }

  return textBlock;
}

function buildMockScore(text) {
  const score = 70 + Math.floor(Math.random() * 21) - 10;
  return {
    score: Math.max(0, Math.min(100, score)),
    verdict: "Looks solid overall; tighten formatting and add more metrics.",
    findings: [
      { severity: "good", point: "Clear technical experience and relevant frontend skills." },
      { severity: "warning", point: "Some bullet points are vague; add measurable impact." },
      { severity: "warning", point: "Resume could use stronger action verbs and quantifiable results." },
      { severity: "warning", point: "Spacing and section ordering would be easier to scan." },
      { severity: "critical", point: "Missing a clear headline or summary statement for the role." },
    ],
  };
}

app.post("/api/score", async (req, res) => {
  try {
    if (!req.body || !req.body.content) {
      return res.status(400).json({ error: "Request body must include content." });
    }

    const prompt = buildTextForHuggingFace(req.body.content);
    if (!prompt) {
      return res.status(400).json({ error: "Request body must include text content." });
    }

    if (PROVIDER === "mock") {
      return res.json(buildMockScore(prompt));
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
          messages: [{ role: "user", content: req.body.content }],
        }),
      });

      const data = await response.json();
      return res.status(response.status).json(data);
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
          parameters: {
            max_new_tokens: 1200,
            temperature: 0.2,
            return_full_text: false,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (MOCK_FALLBACK) {
          console.warn("Hugging Face request failed; returning mock result.");
          return res.json(buildMockScore(prompt));
        }
        return res.status(response.status).json(data);
      }

      const text = typeof data === "string" ? data : data.generated_text || data[0]?.generated_text || JSON.stringify(data);
      return res.json({ text, raw: data });
    }

    if (PROVIDER === "nvidia") {
      console.debug("NVIDIA API URL:", NVIDIA_API_URL);
      console.debug("NVIDIA model:", NVIDIA_MODEL);
      console.debug("NVIDIA fallback models:", NVIDIA_MODEL_FALLBACKS);

      let lastError = null;
      let data = null;
      let response = null;
      let textBody = "";

      for (const model of NVIDIA_MODEL_FALLBACKS) {
        try {
          console.debug("Trying NVIDIA model:", model);
          const modelTimeout = NVIDIA_MODEL_TIMEOUTS[model] || NVIDIA_REQUEST_TIMEOUT_MS;
          response = await fetchWithTimeout(NVIDIA_API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              Authorization: `Bearer ${NVIDIA_API_KEY}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: truncatePrompt(prompt) }],
              max_tokens: MAX_RESPONSE_TOKENS,
              temperature: 0.15,
              top_p: 0.9,
            }),
          }, modelTimeout);

          textBody = await response.text();
          console.debug("NVIDIA response status:", response.status);
          console.debug("NVIDIA response headers:", Object.fromEntries(response.headers.entries()));
          console.debug("NVIDIA response body:", textBody);

          if (!response.ok) {
            lastError = { model, status: response.status, body: textBody };
            console.warn(`NVIDIA model ${model} returned status ${response.status}. Trying next fallback if available.`);
            continue;
          }

          try {
            data = JSON.parse(textBody);
          } catch (parseError) {
            lastError = { model, error: "Invalid JSON", body: textBody };
            console.warn(`NVIDIA model ${model} returned invalid JSON. Trying next fallback if available.`);
            continue;
          }

          const text = typeof data === "string"
            ? data
            : data.choices?.[0]?.message?.content || data.output?.[0]?.content || JSON.stringify(data);

          if (text && text.trim()) {
            return res.json({ text, raw: data });
          }

          lastError = { model, status: response.status, body: textBody, info: "Empty or missing assistant text" };
          console.warn(`NVIDIA model ${model} returned no usable assistant text. Trying next fallback if available.`);
        } catch (err) {
          const isTimeout = err.name === "AbortError";
          lastError = { model, error: err.message, timeout: isTimeout };
          console.error(`NVIDIA call failed for model ${model}:`, err.message);
          if (isTimeout) {
            console.warn(`NVIDIA model ${model} timed out after ${NVIDIA_REQUEST_TIMEOUT_MS}ms. Trying next fallback.`);
          }
          continue;
        }
      }

      if (MOCK_FALLBACK) {
        console.warn("All NVIDIA models failed; returning mock result.");
        return res.json(buildMockScore(prompt));
      }

      return res.status(502).json({
        error: "All NVIDIA models failed to produce a valid response.",
        attempts: NVIDIA_MODEL_FALLBACKS,
        lastError,
      });
    }

    res.status(500).json({ error: "Unsupported provider configuration." });
  } catch (err) {
    console.error(err);
    if (MOCK_FALLBACK) {
      return res.json(buildMockScore(prompt));
    }
    res.status(500).json({ error: "Server failed to reach the model provider." });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "..", "dist");

app.use(express.static(distPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`ResumeCheck backend running on http://localhost:${PORT} using provider ${PROVIDER}`);
}).on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the existing server or set PORT to a free port before restarting.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
