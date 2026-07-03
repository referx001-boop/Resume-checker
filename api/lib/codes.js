import crypto from "crypto";
import { supabase } from "./supabase.js";

function randomCode() {
  const bytes = crypto.randomBytes(5).toString("hex").toUpperCase();
  return `RC-${bytes.slice(0, 4)}-${bytes.slice(4, 8)}`;
}

// Creates one code tied to one paid reference, valid for 30 days.
// Idempotent: a second call for the same reference returns the same code.
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
    });
    if (!error) return code;
    if (error.code !== "23505") throw error;
  }
  throw new Error("Could not generate a unique code after 5 attempts.");
}

// Checks a code exists and hasn't expired. Does not mark it used, since
// codes now allow unlimited checks until expires_at.
export async function validateCode(code) {
  const { data, error } = await supabase
    .from("access_codes")
    .select("code, expires_at")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { valid: false, reason: "not_found" };
  if (new Date(data.expires_at) < new Date()) return { valid: false, reason: "expired" };
  return { valid: true };
}
