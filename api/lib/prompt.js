export function buildPrompt({ resumeText, role }) {
  const roleLine =
    role && role.trim()
      ? `The applicant is targeting this role: "${role.trim()}". Judge how well this resume fits that specific role and industry.`
      : `No target role was given. Judge the resume on its own terms, for whatever field it is written for. Do not assume it should be a tech or software resume, and do not penalize it for lacking programming or technical skills.`;

  return `You are an experienced recruiter who has screened resumes across many industries: tech, healthcare, education, sales, finance, skilled trades, hospitality, logistics, creative work, and more.

${roleLine}

Score the resume from 0 to 100 based on how strong it is for that field: clarity, structure, evidence of real impact, relevant skills, and how convincing it would be to a recruiter in that specific industry. A well-written nurse's resume and a well-written developer's resume can both score highly. Judge each on its own field's standards.

Evaluate only the text below. Do not add or invent details. Do not explain your reasoning outside the JSON.

Use exactly this JSON format:
{
  "score": <integer 0-100>,
  "verdict": "<one blunt sentence, max 20 words>",
  "findings": [
    {"severity": "critical" | "warning" | "good", "point": "<one specific observation, max 25 words>"}
  ]
}

Return 5 to 8 findings. Include at least one critical finding for any major issue and at least one good finding when the resume deserves it.

Write findings like a real recruiter, citing exact resume evidence when possible. Avoid generic language such as "strong skills" unless the text directly supports it.

If this text is not clearly a real resume, return score 0 with critical findings explaining why.

RESUME TEXT:
${resumeText}`;
}

// Pulls the {score, verdict, findings} object out of a model's raw text
// response, stripping markdown fences if the model added them.
export function extractScoreJson(text) {
  if (!text || typeof text !== "string") return null;
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.score === "number" && parsed.verdict && Array.isArray(parsed.findings)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
