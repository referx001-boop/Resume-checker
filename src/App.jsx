import React, { useState, useRef } from "react";
import { Lock, ArrowRight, CheckCircle2, AlertTriangle, XCircle, Copy, Upload, FileText } from "lucide-react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfjsWorker;

const ACCESS_CODE = "CLARITY2026";

const GAUGE_ZONES = [
  { max: 40, color: "#D9534F", label: "Fail" },
  { max: 70, color: "#E8A23D", label: "Borderline" },
  { max: 100, color: "#6B9080", label: "Pass" },
];

function zoneFor(score) {
  return GAUGE_ZONES.find((z) => score <= z.max) || GAUGE_ZONES[2];
}

function Gauge({ score }) {
  const pct = Math.max(0, Math.min(100, score));
  const zone = zoneFor(pct);
  return (
    <div style={{ width: "100%" }}>
      <div
        style={{
          height: 10,
          borderRadius: 999,
          background: "linear-gradient(90deg, #D9534F 0%, #D9534F 40%, #E8A23D 40%, #E8A23D 70%, #6B9080 70%, #6B9080 100%)",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `calc(${pct}% - 2px)`,
            top: -4,
            width: 4,
            height: 18,
            background: "#0F1B2D",
            borderRadius: 2,
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#8A93A0" }}>
        <span>0</span>
        <span>40</span>
        <span>70</span>
        <span>100</span>
      </div>
      <div style={{ marginTop: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700, color: zone.color }}>
        {zone.label.toUpperCase()}
      </div>
    </div>
  );
}

function SeverityIcon({ level }) {
  if (level === "critical") return <XCircle size={16} color="#D9534F" style={{ flexShrink: 0, marginTop: 2 }} />;
  if (level === "warning") return <AlertTriangle size={16} color="#E8A23D" style={{ flexShrink: 0, marginTop: 2 }} />;
  return <CheckCircle2 size={16} color="#6B9080" style={{ flexShrink: 0, marginTop: 2 }} />;
}

export default function ResumeCheck() {
  const [unlocked, setUnlocked] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState("");

  const [role, setRole] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [parsing, setParsing] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null); // { kind, mediaType, data }
  const fileInputRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = () => reject(new Error("Read failed"));
      reader.readAsDataURL(file);
    });
  }

  async function extractPdfText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await getDocument({ data: arrayBuffer }).promise;
    const pageTexts = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const strings = content.items.map((item) => (item.str || ""));
      pageTexts.push(strings.join(" "));
    }

    return pageTexts.join("\n\n");
  }

  async function handleFileUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setFileError("");
    setParsing(true);
    setUploadedFile(null);
    setResumeText("");

    const ext = file.name.split(".").pop().toLowerCase();

    try {
      if (ext === "txt") {
        const text = await file.text();
        setResumeText(text);
        setFileName(file.name);
      } else if (ext === "pdf") {
        const text = await extractPdfText(file);
        if (!text.trim()) {
          setFileError("Could not extract text from the PDF. Paste your resume text instead.");
        } else {
          setResumeText(text);
          setFileName(file.name);
        }
      } else if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
        setFileError("Image upload is not supported with this model. Use PDF or .txt, or paste text directly.");
      } else if (ext === "docx") {
        setFileError("Open the file in Word or Google Docs, select all, copy, and paste the text below.");
      } else {
        setFileError("Use a .pdf or .txt file, or paste your resume text directly below.");
      }
    } catch (err) {
      setFileError("Could not read that file. Paste your resume text directly instead.");
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleUnlock() {
    const cleaned = codeInput.trim().toUpperCase().replace(/\s+/g, "");
    if (cleaned === ACCESS_CODE) {
      setUnlocked(true);
      setCodeError("");
    } else {
      setCodeError("That code doesn't match. Check with whoever sent you here.");
    }
  }

  function handleCodeKeyDown(e) {
    if (e.key === "Enter") {
      handleUnlock();
    }
  }

  async function handleAnalyze() {
    const hasText = resumeText.trim().length >= 100;

    if (!hasText) {
      setError("Upload a PDF or .txt file, or paste the full resume text. That looks too short to score fairly.");
      return;
    }

    setError("");
    setLoading(true);
    setResult(null);

    const instructions = `You are a senior technical recruiter screening resumes for frontend/software roles. Score the resume content below from 0 to 100 for how likely it is to pass an initial recruiter or ATS screen${role ? ` for a "${role}" role` : ""}.

Evaluate only the text below. Do not add or invent details. Do not explain your reasoning outside the JSON.

Use exactly this JSON format:
{
  "score": <integer 0-100>,
  "verdict": "<one blunt sentence, max 20 words>",
  "findings": [
    {"severity": "critical" | "warning" | "good", "point": "<one specific observation, max 25 words>"}
  ]
}

Return 5 to 8 findings. Include at least one critical finding for any major resume problem and at least one good finding if the resume deserves it.

Focus on actual evidence in the resume text: relevance of skills, experience quality, dates, impact metrics, role clarity, structure, and recruiter readability.

If this text is not a real resume, return score 0 with critical findings explaining why.

RESUME TEXT:
${resumeText}`;

    try {
      const response = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: [{ type: "text", text: instructions }] }),
      });

      const data = await response.json();
      const raw = data.text || (data.content || []).find((b) => b.type === "text")?.text || JSON.stringify(data);
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      setResult(parsed);
    } catch (err) {
      setError("Something broke while scoring. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  function copyReport() {
    if (!result) return;
    const lines = [
      `Resume Score: ${result.score}/100`,
      `Verdict: ${result.verdict}`,
      "",
      ...result.findings.map((f) => `[${f.severity.toUpperCase()}] ${f.point}`),
    ];
    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const containerStyle = {
    minHeight: "100vh",
    background: "#0F1B2D",
    fontFamily: "'Inter', system-ui, sans-serif",
    color: "#F7F3EA",
    padding: "0",
  };

  if (!unlocked) {
    return (
      <div style={{ ...containerStyle, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <style>{fontImports}</style>
        <div
          style={{
            background: "#F7F3EA",
            color: "#0F1B2D",
            borderRadius: 16,
            padding: "36px 28px",
            width: "100%",
            maxWidth: 380,
            boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <Lock size={20} color="#0F1B2D" />
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, letterSpacing: 1, color: "#8A93A0" }}>
              ACCESS REQUIRED
            </span>
          </div>
          <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 28, fontWeight: 700, margin: "8px 0 4px" }}>
            ResumeCheck
          </h1>
          <p style={{ fontSize: 14, color: "#5B6470", marginBottom: 24, lineHeight: 1.5 }}>
            An honest recruiter's read on your resume. Enter the code you were given after payment.
          </p>
          <input
            type="text"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onKeyDown={handleCodeKeyDown}
            placeholder="Access code"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "12px 14px",
              borderRadius: 8,
              border: "1.5px solid #D8D2C4",
              fontSize: 15,
              fontFamily: "'JetBrains Mono', monospace",
              marginBottom: 10,
              outline: "none",
            }}
          />
          {codeError && (
            <div style={{ color: "#D9534F", fontSize: 13, marginBottom: 10 }}>{codeError}</div>
          )}
          <button
            onClick={handleUnlock}
            style={{
              width: "100%",
              padding: "12px 14px",
              borderRadius: 8,
              border: "none",
              background: "#0F1B2D",
              color: "#F7F3EA",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            Unlock <ArrowRight size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <style>{fontImports}</style>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 20px 80px" }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, letterSpacing: 1, color: "#8A93A0", marginBottom: 8 }}>
          RESUME DIAGNOSTIC
        </div>
        <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 34, fontWeight: 700, margin: "0 0 8px" }}>
          Will this resume get you an interview?
        </h1>
        <p style={{ color: "#B8C0CC", fontSize: 15, lineHeight: 1.5, marginBottom: 32 }}>
          Paste your resume text below. You'll get a score, a verdict, and specific fixes, not generic advice.
        </p>

        <label style={{ fontSize: 13, fontWeight: 600, color: "#B8C0CC", display: "block", marginBottom: 6 }}>
          Target role (optional)
        </label>
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. Frontend Engineer, React"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "12px 14px",
            borderRadius: 8,
            border: "1.5px solid #2A3B52",
            background: "#152238",
            color: "#F7F3EA",
            fontSize: 14,
            marginBottom: 18,
            outline: "none",
          }}
        />

        <label style={{ fontSize: 13, fontWeight: 600, color: "#B8C0CC", display: "block", marginBottom: 6 }}>
          Resume file or text
        </label>

        <input
          type="file"
          ref={fileInputRef}
          accept=".txt,.pdf"
          onChange={handleFileUpload}
          style={{ display: "none" }}
        />
        <button
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderRadius: 8,
            border: "1.5px dashed #3A4A5F",
            background: "#152238",
            color: "#B8C0CC",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            marginBottom: 10,
          }}
        >
          <Upload size={15} />
          {parsing ? "Reading file..." : "Upload PDF or .txt"}
        </button>

        {fileName && !fileError && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#6B9080", marginBottom: 10 }}>
            <FileText size={14} />
            {fileName} loaded into the box below.
          </div>
        )}
        {fileError && (
          <div style={{ fontSize: 13, color: "#E8A23D", marginBottom: 10, lineHeight: 1.4 }}>{fileError}</div>
        )}

        <div style={{ fontSize: 12, color: "#5B6470", marginBottom: 10 }}>
          Or paste your resume text directly:
        </div>
        <textarea
          value={resumeText}
          onChange={(e) => setResumeText(e.target.value)}
          placeholder="Paste your full resume text here..."
          rows={10}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "14px",
            borderRadius: 8,
            border: "1.5px solid #2A3B52",
            background: "#152238",
            color: "#F7F3EA",
            fontSize: 14,
            lineHeight: 1.5,
            resize: "vertical",
            outline: "none",
            fontFamily: "'Inter', sans-serif",
          }}
        />

        {error && (
          <div style={{ color: "#D9534F", fontSize: 13, marginTop: 10 }}>{error}</div>
        )}

        <button
          onClick={handleAnalyze}
          disabled={loading}
          style={{
            marginTop: 18,
            padding: "13px 22px",
            borderRadius: 8,
            border: "none",
            background: loading ? "#3A4A5F" : "#E8A23D",
            color: "#0F1B2D",
            fontSize: 15,
            fontWeight: 700,
            cursor: loading ? "default" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {loading ? "Scoring..." : "Score my resume"}
          {!loading && <ArrowRight size={16} />}
        </button>

        {result && (
          <div
            style={{
              marginTop: 40,
              background: "#F7F3EA",
              color: "#0F1B2D",
              borderRadius: 16,
              padding: "28px 24px",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 4 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 48, fontWeight: 700 }}>
                {result.score}
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, color: "#8A93A0" }}>
                / 100
              </span>
            </div>
            <Gauge score={result.score} />

            <p style={{ fontSize: 16, fontWeight: 600, marginTop: 20, lineHeight: 1.4 }}>
              {result.verdict}
            </p>

            <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              {result.findings.map((f, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <SeverityIcon level={f.severity} />
                  <span style={{ fontSize: 14, lineHeight: 1.5, color: "#333" }}>{f.point}</span>
                </div>
              ))}
            </div>

            <button
              onClick={copyReport}
              style={{
                marginTop: 22,
                padding: "10px 16px",
                borderRadius: 8,
                border: "1.5px solid #0F1B2D",
                background: "transparent",
                color: "#0F1B2D",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Copy size={14} /> {copied ? "Copied" : "Copy report"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const fontImports = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Inter:wght@400;600&family=JetBrains+Mono:wght@400;700&display=swap');
`;
