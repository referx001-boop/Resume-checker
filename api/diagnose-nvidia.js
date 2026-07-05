import dns from "dns";
import { promisify } from "util";

const lookup = promisify(dns.lookup);
const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

const HOST = "integrate.api.nvidia.com";
const URL = `https://${HOST}/v1/chat/completions`;

async function run() {
  console.log("=== DNS resolution ===");
  try {
    const v4 = await resolve4(HOST);
    console.log("IPv4 addresses:", v4);
  } catch (err) {
    console.log("IPv4 lookup failed:", err.code, err.message);
  }

  try {
    const v6 = await resolve6(HOST);
    console.log("IPv6 addresses:", v6);
  } catch (err) {
    console.log("IPv6 lookup failed:", err.code, err.message);
  }

  try {
    const def = await lookup(HOST);
    console.log("Default lookup (what Node picks):", def);
  } catch (err) {
    console.log("Default lookup failed:", err.code, err.message);
  }

  console.log("\n=== TCP/TLS connection test ===");
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: "nvidia/nemotron-3-nano-30b-a3b",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    console.log("Status:", res.status);
    console.log("Time:", Date.now() - start, "ms");
    const body = await res.text();
    console.log("Body:", body.slice(0, 300));
  } catch (err) {
    console.log("Request failed after", Date.now() - start, "ms");
    console.log("Error name:", err.name);
    console.log("Error message:", err.message);
    console.log("Error code:", err.code);
    console.log("Error cause:", err.cause);
  }
}

run();
