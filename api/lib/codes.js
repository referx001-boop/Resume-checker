import crypto from "crypto";
import { supabase } from "./supabase.js";

function randomCode() {
  const bytes = crypto.randomBytes(5).toString("hex").toUpperCase(); // 10 hex chars
  return `RC-${bytes.slice(0, 4)}-${bytes.slice(4, 8)}`;
}

// Creates one fresh code tied to one paid Paystack reference. Idempotent:
// if a code already exists for this reference (user refreshed the callback
// page, or the webhook and the browser redirect both fired), the existing
// code is returned instead of minting a second free code for one payment.
export async function createCodeForReference({ reference, email }) {
  const { data: existing, error: existingErr } = await supabase
    .from("access_codes")
    .select("code")
    .eq("reference", reference)
    .maybeSingle();

  if (existingErr) throw existingErr;
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    const { error } = await supabase.from("access_codes").insert({
      code,
      reference,
      email: email || null,
      used: false,
    });
    if (!error) return code;
    if (error.code !== "23505") throw error; // 23505 = unique_violation, retry on collision
  }
  throw new Error("Could not generate a unique code after 5 attempts.");
}

export async function codeExistsAndUnused(code) {
  const { data, error } = await supabase
    .from("access_codes")
    .select("code, used")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { valid: false, reason: "not_found" };
  if (data.used) return { valid: false, reason: "used" };
  return { valid: true };
}

// Atomically marks a code as used. The .eq("used", false) guard means this
// only succeeds once, even if two requests race each other with the same
// code at the same instant.
export async function claimCode(code) {
  const { data, error } = await supabase
    .from("access_codes")
    .update({ used: true, used_at: new Date().toISOString() })
    .eq("code", code)
    .eq("used", false)
    .select()
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// Best-effort rollback if scoring fails after the code was claimed, so a
// server or model error doesn't cost the user their payment.
export async function releaseCode(code) {
  await supabase.from("access_codes").update({ used: false, used_at: null }).eq("code", code);
}
