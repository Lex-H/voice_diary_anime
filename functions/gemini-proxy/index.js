const fs = require("fs");
const functions = require("@google-cloud/functions-framework");

const GEMINI_HOST = "https://generativelanguage.googleapis.com";
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const MAX_CONTENTS = 40;
const MAX_PARTS = 8;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

function readApiKey() {
  const fromEnv = String(process.env.GEMINI_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const filePath = String(process.env.GEMINI_API_KEY_FILE || "").trim();
  if (!filePath) return "";
  return fs.readFileSync(filePath, "utf8").trim();
}

function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || "https://lex-h.github.io";
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function allowedModels() {
  const raw = String(
    process.env.ALLOWED_MODELS ||
      "gemini-3.8-flash,gemini-3.8-flash-lite,gemini-3.5-flash-lite"
  );
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function isLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return localHost && (url.protocol === "http:" || url.protocol === "https:");
  } catch (error) {
    return false;
  }
}

function applyCors(req, res) {
  const origin = req.get("Origin");
  const allowList = allowedOrigins();
  const allowed = Boolean(origin) && (allowList.includes("*") || allowList.includes(origin) || isLocalOrigin(origin));
  if (allowed) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "3600");
  return { origin, allowed };
}

function sendError(res, status, message) {
  res.status(status).json({ error: { message } });
}

function redact(text, apiKey) {
  let output = String(text || "");
  if (apiKey) output = output.split(apiKey).join("[redacted]");
  return output.slice(0, 500);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateText(text, label) {
  if (typeof text !== "string") return `${label} 必須是字串`;
  if (text.length > MAX_TEXT_CHARS) return `${label} 超過長度上限`;
  return "";
}

function validatePart(part) {
  if (!isPlainObject(part)) return "parts 項目格式不正確";
  const keys = Object.keys(part);
  if (keys.length !== 1) return "每個 part 只能包含 text 或 inlineData";
  if (typeof part.text === "string") return validateText(part.text, "text");
  if (!isPlainObject(part.inlineData)) return "part 只能是 text 或 inlineData";
  const mimeType = part.inlineData.mimeType;
  const data = part.inlineData.data;
  if (typeof mimeType !== "string" || !/^audio\/[a-zA-Z0-9.+-]+(?:\s*;\s*[\w.+-]+=[\w.+-]+)*$/.test(mimeType)) {
    return "只接受音訊 inlineData";
  }
  if (typeof data !== "string" || !/^[A-Za-z0-9+/=\s]+$/.test(data)) {
    return "音訊資料不是有效的 Base64";
  }
  const bytes = Buffer.byteLength(data.replace(/\s/g, ""), "utf8") * 0.75;
  if (bytes > MAX_AUDIO_BYTES) return "音訊超過大小上限";
  return "";
}

function validateContents(contents) {
  if (!Array.isArray(contents) || contents.length === 0 || contents.length > MAX_CONTENTS) {
    return "contents 必須是 1 到 40 則的陣列";
  }
  for (const item of contents) {
    if (!isPlainObject(item) || (item.role !== "user" && item.role !== "model")) {
      return "contents.role 只能是 user 或 model";
    }
    if (!Array.isArray(item.parts) || item.parts.length === 0 || item.parts.length > MAX_PARTS) {
      return "每個 content 的 parts 數量不正確";
    }
    for (const part of item.parts) {
      const problem = validatePart(part);
      if (problem) return problem;
    }
  }
  return "";
}

function validateGenerationConfig(config) {
  if (config == null) return { value: undefined, error: "" };
  if (!isPlainObject(config)) return { value: undefined, error: "generationConfig 格式不正確" };
  const value = {};
  if (config.temperature != null) {
    const temperature = Number(config.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return { value: undefined, error: "temperature 必須介於 0 到 2" };
    }
    value.temperature = temperature;
  }
  if (config.maxOutputTokens != null) {
    const tokens = Number(config.maxOutputTokens);
    if (!Number.isInteger(tokens) || tokens < 1 || tokens > 8192) {
      return { value: undefined, error: "maxOutputTokens 必須是 1 到 8192 的整數" };
    }
    value.maxOutputTokens = tokens;
  }
  if (config.responseMimeType != null) {
    if (config.responseMimeType !== "application/json" && config.responseMimeType !== "text/plain") {
      return { value: undefined, error: "不支援的 responseMimeType" };
    }
    value.responseMimeType = config.responseMimeType;
  }
  if (config.responseSchema != null) {
    const schema = JSON.stringify(config.responseSchema);
    if (!isPlainObject(config.responseSchema) || schema.length > 8000) {
      return { value: undefined, error: "responseSchema 過大或格式不正確" };
    }
    value.responseSchema = config.responseSchema;
  }
  return { value, error: "" };
}

function buildPayload(body) {
  const model = String(body.model || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model) || !allowedModels().includes(model)) {
    return { error: "不允許的模型名稱" };
  }
  const contentsError = validateContents(body.contents);
  if (contentsError) return { error: contentsError };

  const payload = { contents: body.contents };
  if (body.systemInstruction != null) {
    if (!isPlainObject(body.systemInstruction) || !Array.isArray(body.systemInstruction.parts)) {
      return { error: "systemInstruction 格式不正確" };
    }
    if (body.systemInstruction.parts.length !== 1) return { error: "systemInstruction 只接受一段文字" };
    const problem = validatePart(body.systemInstruction.parts[0]);
    if (problem || typeof body.systemInstruction.parts[0].text !== "string") {
      return { error: "systemInstruction 只接受文字" };
    }
    payload.systemInstruction = { parts: [{ text: body.systemInstruction.parts[0].text }] };
  }

  const generation = validateGenerationConfig(body.generationConfig);
  if (generation.error) return { error: generation.error };
  if (generation.value && Object.keys(generation.value).length) payload.generationConfig = generation.value;
  return { model, payload };
}

functions.http("geminiProxy", async (req, res) => {
  const cors = applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (cors.origin && !cors.allowed) {
    sendError(res, 403, "這個網域不在允許清單");
    return;
  }
  if (req.method !== "POST") {
    sendError(res, 405, "只接受 POST");
    return;
  }

  const apiKey = readApiKey();
  if (!apiKey) {
    sendError(res, 500, "伺服器尚未設定 Gemini 金鑰");
    return;
  }

  const rawSize = Buffer.byteLength(req.rawBody || JSON.stringify(req.body || {}), "utf8");
  if (rawSize > MAX_BODY_BYTES) {
    sendError(res, 413, "請求內容過大");
    return;
  }
  if (!isPlainObject(req.body)) {
    sendError(res, 400, "請求本文必須是 JSON 物件");
    return;
  }

  const built = buildPayload(req.body);
  if (built.error) {
    sendError(res, 400, built.error);
    return;
  }

  try {
    const upstream = await fetch(
      `${GEMINI_HOST}/v1beta/models/${encodeURIComponent(built.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(built.payload)
      }
    );
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const message = redact(data?.error?.message || `Gemini HTTP ${upstream.status}`, apiKey);
      sendError(res, upstream.status >= 500 ? 502 : upstream.status, message);
      return;
    }
    res.status(200).json(data);
  } catch (error) {
    console.error("Gemini proxy failed", redact(error && error.message, apiKey));
    sendError(res, 502, "無法連線到 Gemini");
  }
});
