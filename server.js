const express = require("express");
const multer = require("multer");
const cors = require("cors");
const pdfParse = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Multer ────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files allowed"), false);
  },
});

// ── Gemini model list (tried in order, no wasted test calls) ──────────
const MODELS_TO_TRY = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro",
  "gemini-pro",
];

// ── Classify Gemini errors ────────────────────────────────────────────
function classifyError(err) {
  const msg = (err.message || "").toLowerCase();
  const status = err.status || err.statusCode || (err.response && err.response.status) || 0;

  if (
    status === 401 || status === 403 ||
    msg.includes("api_key_invalid") ||
    msg.includes("invalid api key") ||
    msg.includes("unauthorized") ||
    msg.includes("permission denied")
  ) {
    return "auth"; // Bad API key — stop immediately
  }
  if (
    status === 400 || status === 404 ||
    msg.includes("not found") || msg.includes("does not exist") ||
    msg.includes("invalid") || msg.includes("not supported")
  ) {
    return "model"; // This model doesn't exist or bad request — try next
  }
  if (status === 429 || msg.includes("quota") || msg.includes("rate limit")) {
    return "quota"; // Rate limit
  }
  return "model"; // Unknown — try next model
}

// ── Generate MCQs for one chunk with a specific model ─────────────────
// Returns { questions } on success
// Throws { type: "auth"|"quota" } for fatal errors
// Returns null for non-fatal model errors (try next model)
async function generateMCQsForChunk(genAI, chunk, chunkIndex, modelName) {
  const prompt = `You are an expert exam question writer. Generate exactly 10 high-quality multiple-choice questions from the text below.

RULES (follow strictly):
- Questions must test deep understanding and concepts, NOT trivial facts
- Each question must have exactly 4 options labeled A, B, C, D
- Only ONE option is correct
- Explanation must clearly explain WHY the correct answer is right
- Return ONLY a valid JSON array — no markdown, no code fences, no extra text

JSON format:
[
  {
    "question": "Question text here?",
    "options": ["A. option one", "B. option two", "C. option three", "D. option four"],
    "correct": "A",
    "explanation": "A is correct because..."
  }
]

TEXT:
${chunk}`;

  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json|```/gi, "").trim();

    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("No JSON array in response");

    const parsed = JSON.parse(raw.slice(start, end + 1));

    return parsed.filter(
      (q) =>
        q.question &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        q.correct &&
        ["A", "B", "C", "D"].includes(q.correct) &&
        q.explanation
    );
  } catch (err) {
    const type = classifyError(err);
    console.error(`Chunk ${chunkIndex} | model ${modelName} | type=${type} | ${err.message}`);

    if (type === "auth") {
      const e = new Error("AUTH_ERROR");
      e.type = "auth";
      throw e;
    }
    if (type === "quota") {
      const e = new Error("QUOTA_ERROR");
      e.type = "quota";
      throw e;
    }
    return null; // model not available — try next
  }
}

// ── Try all models for one chunk until one succeeds ───────────────────
async function generateWithFallback(genAI, chunk, chunkIndex) {
  for (const modelName of MODELS_TO_TRY) {
    const result = await generateMCQsForChunk(genAI, chunk, chunkIndex, modelName);
    if (result !== null) {
      console.log(`Using model: ${modelName}`);
      return { modelName, questions: result };
    }
    console.log(`Model ${modelName} unavailable, trying next...`);
  }
  return { modelName: null, questions: [] };
}

// ── Split text into chunks ────────────────────────────────────────────
function splitIntoChunks(text, charsPerChunk = 3000) {
  const chunks = [];
  const clean = text.replace(/\s+/g, " ").trim();
  for (let i = 0; i < clean.length; i += charsPerChunk) {
    const chunk = clean.slice(i, i + charsPerChunk).trim();
    if (chunk.length > 200) chunks.push(chunk);
  }
  return chunks;
}

// ── Robust PDF text extraction (two attempts) ─────────────────────────
async function extractPDFText(buffer) {
  // Attempt 1: standard
  try {
    const data = await pdfParse(buffer);
    if (data && data.text && data.text.trim().length >= 100) {
      return { text: data.text, numpages: data.numpages };
    }
  } catch (e) {
    console.warn("PDF attempt 1 failed:", e.message);
  }

  // Attempt 2: limit pages to avoid hangs on huge/corrupt PDFs
  try {
    const data = await pdfParse(buffer, { max: 50 });
    if (data && data.text && data.text.trim().length >= 100) {
      return { text: data.text, numpages: data.numpages };
    }
  } catch (e) {
    console.warn("PDF attempt 2 failed:", e.message);
  }

  return null;
}

// ── API endpoint ──────────────────────────────────────────────────────
app.post("/generate-mcq", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF uploaded." });

  // Validate API key before doing any work
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({
      error:
        "GEMINI_API_KEY is not set. Get your free key at https://aistudio.google.com/apikey and add it to your environment.",
    });
  }

  try {
    // Parse PDF
    const extracted = await extractPDFText(req.file.buffer);

    if (!extracted) {
      return res.status(400).json({
        error:
          "Could not extract text from this PDF. Make sure it is a text-based PDF (not a scanned image). Tip: if you cannot copy-paste text from the PDF in a viewer, it is image-only and won't work.",
      });
    }

    const { text, numpages } = extracted;

    if (text.trim().length < 100) {
      return res.status(400).json({
        error:
          "This PDF contains very little readable text. Please use a text-based PDF, not a scanned image.",
      });
    }

    console.log(`PDF parsed: ${numpages} pages, ${text.length} chars`);

    const chunks = splitIntoChunks(text, 3000);
    const MAX_CHUNKS = 10;
    const selectedChunks = chunks.slice(0, MAX_CHUNKS);
    console.log(`Processing ${selectedChunks.length} chunks...`);

    const genAI = new GoogleGenerativeAI(apiKey);

    // Use first chunk to discover working model, then reuse it
    const firstResult = await generateWithFallback(genAI, selectedChunks[0], 0);

    if (!firstResult.modelName) {
      return res.status(500).json({
        error:
          "All Gemini models are currently unavailable. Wait a minute and retry. If it keeps failing, your key may have no quota — check https://aistudio.google.com/apikey.",
      });
    }

    let workingModelName = firstResult.modelName;
    const allQuestions = [...firstResult.questions];
    console.log(`Batch 1 done, total: ${allQuestions.length} questions`);

    // Process remaining chunks in batches of 3
    const BATCH_SIZE = 3;
    const remainingChunks = selectedChunks.slice(1);

    for (let i = 0; i < remainingChunks.length; i += BATCH_SIZE) {
      const batch = remainingChunks.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (chunk, j) => {
          let qs = await generateMCQsForChunk(genAI, chunk, i + j + 1, workingModelName);
          if (qs === null) {
            // Working model stopped working, fall back again
            const fb = await generateWithFallback(genAI, chunk, i + j + 1);
            if (fb.modelName) workingModelName = fb.modelName;
            return fb.questions;
          }
          return qs;
        })
      );

      batchResults.forEach((qs) => allQuestions.push(...qs));
      console.log(
        `Batch ${Math.floor(i / BATCH_SIZE) + 2} done, total: ${allQuestions.length} questions`
      );

      if (i + BATCH_SIZE < remainingChunks.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (allQuestions.length === 0) {
      return res.status(500).json({
        error: "Could not generate questions from this PDF. Try a different PDF.",
      });
    }

    const shuffled = allQuestions.sort(() => Math.random() - 0.5);
    console.log(`Done! Returning ${shuffled.length} questions`);
    res.json({ questions: shuffled, total: shuffled.length, pages: numpages });
  } catch (err) {
    console.error("Unhandled error:", err);

    // Errors thrown from generateMCQsForChunk for auth/quota
    if (err.type === "auth" || err.message === "AUTH_ERROR") {
      return res.status(500).json({
        error:
          "Your GEMINI_API_KEY is invalid or has been revoked. Please go to https://aistudio.google.com/apikey, create a new key, and update it in your Render environment variables.",
      });
    }

    if (err.type === "quota" || err.message === "QUOTA_ERROR") {
      return res.status(429).json({
        error: "Gemini API rate limit hit. Please wait a minute and try again.",
      });
    }

    const msg = err.message || "";
    const status = err.status || err.statusCode || 0;

    if (
      msg.includes("API_KEY") || msg.includes("api key") || msg.includes("API key") ||
      status === 401 || status === 403
    ) {
      return res.status(500).json({
        error:
          "Invalid GEMINI_API_KEY. Get your free key at https://aistudio.google.com/apikey and update it in Render → Environment Variables.",
      });
    }

    if (msg.includes("quota") || msg.includes("429") || status === 429) {
      return res.status(429).json({
        error: "Rate limit hit. Please wait a minute and try again.",
      });
    }

    res.status(500).json({ error: msg || "Internal server error." });
  }
});

// ── Test key endpoint — visit /test-key in browser to diagnose ────────
app.get("/test-key", async (_req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return res.json({ ok: false, error: "GEMINI_API_KEY env var is not set." });
  const genAI = new GoogleGenerativeAI(apiKey);
  const results = [];
  for (const modelName of MODELS_TO_TRY) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      await model.generateContent("say ok");
      results.push({ model: modelName, status: "WORKING" });
      break;
    } catch (e) {
      results.push({ model: modelName, status: "FAILED: " + e.message });
    }
  }
  res.json({ apiKeySet: true, keyPrefix: apiKey.slice(0, 8) + "...", results });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("*", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.listen(PORT, () => console.log(`QuizGenius v2 running on port ${PORT}`));

// Note: test-key route added below health
