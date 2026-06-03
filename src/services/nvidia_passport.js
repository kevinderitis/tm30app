import { config } from "../config.js";

const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const OUTPUT_TOKEN_BUDGETS = [960, 1280];
const JSON_OUTPUT_EXAMPLE =
  '{"name":"JOHN","middle_name":"PAUL","last_name":"SMITH","birthday":"1990-01-31","gender":"M","nationality":"USA","passport_number":"123456789"}';
const PASSPORT_JSON_SCHEMA = {
  name: "passport_extraction",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      middle_name: { type: "string" },
      last_name: { type: "string" },
      birthday: { type: "string" },
      gender: { type: "string" },
      nationality: { type: "string" },
      passport_number: { type: "string" },
    },
    required: [
      "name",
      "middle_name",
      "last_name",
      "birthday",
      "gender",
      "nationality",
      "passport_number",
    ],
  },
};

function maskApiKey(value = "") {
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `[unserializable:${error.message}]`;
  }
}

function mergePassportData(...sources) {
  const merged = {
    name: "",
    middle_name: "",
    last_name: "",
    birthday: "",
    gender: "",
    nationality: "",
    passport_number: "",
  };

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of Object.keys(merged)) {
      const value = String(source[key] || "").trim();
      if (value && !merged[key]) {
        merged[key] = value;
      }
    }
  }

  return merged;
}

function hasMinimumPassportFields(payload = {}) {
  return Boolean(String(payload.name || "").trim() && String(payload.passport_number || "").trim());
}

function parseMrzLikeText(text = "") {
  const mrzMatch = String(text).match(/P<([A-Z]{3})([A-Z<]+)<<([A-Z<]+)(?:\s|["`]|$)/i);
  if (!mrzMatch) return null;

  const nationality = (mrzMatch[1] || "").toUpperCase();
  const surname = (mrzMatch[2] || "")
    .replace(/<+/g, " ")
    .trim();
  const givenBlock = (mrzMatch[3] || "").toUpperCase();
  const givenParts = givenBlock
    .split("<")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    nationality,
    last_name: surname,
    name: givenParts[0] || "",
    middle_name: givenParts.slice(1).join(" "),
  };
}

function getAssistantContent(message) {
  return typeof message?.content === "string" ? message.content.trim() : "";
}

function findBalancedJsonObject(text = "") {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return text.slice(start, index + 1);
      }
    }
  }

  return "";
}

function extractJsonObject(content = "") {
  if (!content) {
    throw new Error("La respuesta del modelo vino vacia.");
  }

  const fencedMatch = content.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : content;
  const balancedObject = findBalancedJsonObject(candidate);

  if (balancedObject) {
    return JSON.parse(balancedObject);
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    throw new Error("No se pudo encontrar un JSON valido en la respuesta del modelo.");
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

function extractLabeledFields(content = "") {
  const text = String(content || "");
  if (!text) {
    return null;
  }

  const captureValue = (fieldName) => {
    const pattern = new RegExp(
      String.raw`(?:^|\n)\s*(?:[-*]\s*|\d+\.\s*)?(?:\*\*)?${fieldName}(?:\*\*)?\s*:\s*(?:"([^"]*)"|([^\n]+))`,
      "i"
    );
    const match = text.match(pattern);
    const rawValue = match?.[1] || match?.[2] || "";
    return rawValue
      .replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  const extracted = {
    name: captureValue("name"),
    middle_name: captureValue("middle[_\\s-]?name"),
    last_name: captureValue("last[_\\s-]?name"),
    birthday: captureValue("birthday"),
    gender: captureValue("gender") || captureValue("sex"),
    nationality: captureValue("nationality"),
    passport_number: captureValue("passport[_\\s-]?number"),
  };

  const sentenceCapture = (pattern) => {
    const match = text.match(pattern);
    return match?.[1]?.replace(/\s+/g, " ").trim() || "";
  };

  const cleanNarrativeValue = (value = "") =>
    String(value)
      .replace(/^[\s:.-]+/, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/\s*\((?:appears|seems|looks|could|might|maybe)[^)]*$/i, "")
      .replace(/\s*(?:as|which|or it could|but looking).*$/i, "")
      .replace(/\s*(?:appears|seems|looks|could|might|maybe)\b.*$/i, "")
      .replace(/\s*(?:\/|\||-|–|—)\s*(?:appears|seems|looks|could|might|maybe)\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();

  const firstQuotedValue = (value = "") => {
    const match = String(value).match(/"([^"]+)"/);
    return match?.[1]?.replace(/\s+/g, " ").trim() || "";
  };

  const explicitMrzRoleMatch = text.match(
    /This shows:\s*([A-Z\s]+)\s*\(surname\),\s*([A-Z\s]+)\s*\(given name\),\s*([A-Z\s]+)\s*\(middle/i
  );

  const normalizeGivenNames = (value = "") => {
    const cleaned = cleanNarrativeValue(value);
    if (!cleaned) return "";
    const quoted = firstQuotedValue(cleaned);
    return cleanNarrativeValue(quoted || cleaned);
  };

  if (!extracted.last_name) {
    extracted.last_name =
      captureValue("surname") ||
      captureValue("family[_\\s-]?name") ||
      cleanNarrativeValue(sentenceCapture(/Surname\s*=\s*([^,\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/Last name\s*\(Surname\)\s*:\s*([^\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/Surname\s*:\s*([^\n]+)/i));
  }

  const givenNames =
    normalizeGivenNames(captureValue("given[_\\s-]?name")) ||
    normalizeGivenNames(captureValue("given[_\\s-]?names")) ||
    normalizeGivenNames(captureValue("first[_\\s-]?name")) ||
    cleanNarrativeValue(sentenceCapture(/First name\s*=\s*([^,\n]+)/i)) ||
    normalizeGivenNames(sentenceCapture(/First name\s*\(Given Names\)\s*:\s*([^\n]+)/i)) ||
    normalizeGivenNames(sentenceCapture(/Given Names?\s*:\s*([^\n]+)/i)) ||
    normalizeGivenNames(sentenceCapture(/First name\s*:\s*([^\n]+)/i)) ||
    firstQuotedValue(sentenceCapture(/The passport shows\s*([^\n]+)\s+as the given name/i));

  if (givenNames && !extracted.name) {
    const parts = givenNames.split(/\s+/).filter(Boolean);
    extracted.name = parts[0] || "";
    if (!extracted.middle_name) {
      extracted.middle_name = parts.slice(1).join(" ");
    }
  }

  if (!extracted.middle_name) {
    extracted.middle_name =
      cleanNarrativeValue(sentenceCapture(/Middle name\s*=\s*([^,\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/Middle name\s*:\s*([^\n]+)/i)) ||
      cleanNarrativeValue(explicitMrzRoleMatch?.[3] || "");
  }

  if (!extracted.birthday) {
    extracted.birthday =
      captureValue("date[_\\s-]?of[_\\s-]?birth") ||
      captureValue("birth[_\\s-]?date") ||
      cleanNarrativeValue(sentenceCapture(/Birthday\s+is\s+([^,\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/Date of birth\s*:\s*([^\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/The date of birth is shown as\s*"([^"]+)"/i)) ||
      cleanNarrativeValue(sentenceCapture(/Normalizing to YYYY-MM-DD:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i)) ||
      cleanNarrativeValue(sentenceCapture(/would be\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i));
  }

  if (!extracted.passport_number) {
    extracted.passport_number =
      captureValue("document[_\\s-]?number") ||
      captureValue("passport[_\\s-]?no") ||
      captureValue("passport[_\\s-]?no\\.?") ||
      cleanNarrativeValue(sentenceCapture(/passport number\s+is\s*([^,.\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/Passport number\s*:\s*([A-Z0-9]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/Passport No\.?\s*:\s*([A-Z0-9]+)/i));
  }

  if (!extracted.gender) {
    extracted.gender =
      cleanNarrativeValue(sentenceCapture(/gender\s+is\s*([^,?.\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/sex\s+is\s*([^,?.\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/Gender\s*:\s*([^\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/Sex\s*:\s*([^\n]+)/i));
  }

  if (!extracted.nationality) {
    extracted.nationality =
      cleanNarrativeValue(sentenceCapture(/nationality\s+is\s*([^,?.\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/Nationality\s*:\s*([^\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/country code is\s*["“]?([A-Z]{3})["”]?/i));
  }

  if (!extracted.name || /the passport shows/i.test(extracted.name)) {
    extracted.name =
      cleanNarrativeValue(sentenceCapture(/name\s+is\s*([^,.\n]+)/i)) ||
      cleanNarrativeValue(sentenceCapture(/First name\s*=\s*([^,\n]+)/i));
  }

  if (!extracted.last_name) {
    extracted.last_name = cleanNarrativeValue(sentenceCapture(/Last name\s*=\s*([^,\n]+)/i));
  }

  if (!extracted.middle_name) {
    extracted.middle_name = cleanNarrativeValue(sentenceCapture(/Middle name\s*=\s*([^,\n]+)/i));
  }

  if (!extracted.name || /the passport shows/i.test(extracted.name)) {
    const fullNameNarrative = cleanNarrativeValue(
      sentenceCapture(/The passport shows\s+"([^"]+)"\s+as the full name/i)
    );
    if (fullNameNarrative) {
      const fullParts = fullNameNarrative.split(/\s+/).filter(Boolean);
      if (extracted.last_name) {
        const surnameParts = extracted.last_name.split(/\s+/).filter(Boolean);
        const givenParts = fullParts.slice(0, Math.max(1, fullParts.length - surnameParts.length));
        extracted.name = givenParts[0] || "";
        if (!extracted.middle_name) {
          extracted.middle_name = givenParts.slice(1).join(" ");
        }
      } else {
        extracted.name = fullParts[0] || "";
        if (!extracted.middle_name) {
          extracted.middle_name = fullParts.slice(1).join(" ");
        }
      }
    }
  }

  const mrzFields = parseMrzLikeText(text);
  if (mrzFields) {
    extracted.name = extracted.name && !/the passport shows/i.test(extracted.name) ? extracted.name : mrzFields.name;
    extracted.middle_name = extracted.middle_name || mrzFields.middle_name;
    extracted.last_name = extracted.last_name || mrzFields.last_name;
    extracted.nationality = extracted.nationality || mrzFields.nationality;
  }

  if (explicitMrzRoleMatch) {
    extracted.last_name = extracted.last_name || cleanNarrativeValue(explicitMrzRoleMatch[1]);
    if (!extracted.name || /the passport shows/i.test(extracted.name)) {
      extracted.name = cleanNarrativeValue(explicitMrzRoleMatch[2]);
    }
    extracted.middle_name = extracted.middle_name || cleanNarrativeValue(explicitMrzRoleMatch[3]);
  }

  if (!extracted.nationality) {
    extracted.nationality =
      cleanNarrativeValue(sentenceCapture(/an?\s+([A-Za-z]+)\s+passport/i)) ||
      extracted.nationality;
  }

  if (!extracted.birthday) {
    extracted.birthday =
      cleanNarrativeValue(sentenceCapture(/would be\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i)) ||
      extracted.birthday;
  }

  const hasAnyValue = Object.values(extracted).some(Boolean);
  return hasAnyValue ? extracted : null;
}

function normalizePassportData(payload = {}) {
  return {
    name: String(payload.name || payload.first_name || payload.firstName || "").trim(),
    middleName: String(payload.middle_name || payload.middleName || "").trim(),
    lastName: String(payload.last_name || payload.lastName || payload.surname || "").trim(),
    birthday: String(payload.birthday || payload.date_of_birth || payload.dateOfBirth || "").trim(),
    gender: String(payload.gender || payload.sex || "").trim().toUpperCase(),
    nationality: String(payload.nationality || payload.nationality_code || payload.country_code || "").trim(),
    passportNumber: String(
      payload.passport_number || payload.passportNumber || payload.document_number || ""
    ).trim(),
  };
}

async function createChatCompletion(payload) {
  console.log("[NVIDIA] Sending request", {
    url: NVIDIA_API_URL,
    model: payload.model,
    maxTokens: payload.max_tokens,
    temperature: payload.temperature,
    apiKey: maskApiKey(config.nvidiaApiKey),
    hasImage: Array.isArray(payload.messages?.[1]?.content),
    responseFormat: payload.response_format || null,
  });

  const response = await fetch(NVIDIA_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.nvidiaApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[NVIDIA] HTTP error", {
      status: response.status,
      body: errorText,
    });
    throw new Error(`Error de NVIDIA API (${response.status}): ${errorText}`);
  }

  const json = await response.json();
  console.log("[NVIDIA] HTTP success", {
    status: response.status,
    choices: json?.choices?.length || 0,
    usage: json?.usage || null,
  });
  console.log("[NVIDIA] Full response payload", safeStringify(json));
  return json;
}

function createResponseFormat() {
  return {
    type: "json_schema",
    json_schema: PASSPORT_JSON_SCHEMA,
  };
}

function createNvidiaImagePayload(dataUrl, maxTokens = OUTPUT_TOKEN_BUDGETS[0]) {
  return {
    model: config.nvidiaModel,
    messages: [
      {
        role: "system",
        content:
          `/no_think You are a passport data extractor. Final answer must be a single minified JSON object in assistant content, not in reasoning. Do not think. Do not analyze. Do not explain. Do not describe the image. Do not add prose. Do not add markdown. Example output: ${JSON_OUTPUT_EXAMPLE}`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              'Extract passport data from this image and return the JSON immediately, without explanation or analysis. Return exactly one minified JSON object with exactly these keys: "name", "middle_name", "last_name", "birthday", "gender", "nationality", "passport_number". Use empty strings if a value is missing. For "birthday", normalize to YYYY-MM-DD when possible. For "gender", return only "M", "F", or "". For "nationality", prefer the 3-letter passport code if visible.',
          },
          {
            type: "image_url",
            image_url: {
              url: dataUrl,
            },
          },
        ],
      },
    ],
    temperature: 0.1,
    top_p: 0.3,
    max_tokens: maxTokens,
    reasoning_budget: 0,
    response_format: createResponseFormat(),
    chat_template_kwargs: {
      enable_thinking: false,
      reasoning_budget: 0,
    },
    stream: false,
  };
}

export async function extractPassportDataWithNvidia(file) {
  if (!config.nvidiaApiKey) {
    throw new Error("Falta configurar NVIDIA_API_KEY en el archivo .env");
  }

  console.log("[NVIDIA] Starting passport extraction", {
    originalFilename: file?.originalname,
    mimeType: file?.mimetype,
    sizeBytes: file?.size,
    model: config.nvidiaModel,
  });

  const imageBase64 = file.buffer.toString("base64");
  const dataUrl = `data:${file.mimetype};base64,${imageBase64}`;
  console.log("[NVIDIA] Image prepared", {
    dataUrlLength: dataUrl.length,
    base64Length: imageBase64.length,
  });

  let finalContent = "";
  let finalFinishReason = "";
  let lastResult = null;

  for (let index = 0; index < OUTPUT_TOKEN_BUDGETS.length; index += 1) {
    const maxTokens = OUTPUT_TOKEN_BUDGETS[index];
    const result = await createChatCompletion(createNvidiaImagePayload(dataUrl, maxTokens));
    lastResult = result;
    const choice = result?.choices?.[0] || {};
    const message = choice?.message || {};
    const content = getAssistantContent(message);
    const finishReason = choice?.finish_reason || "";

    console.log("[NVIDIA] Assistant content check", {
      attempt: index + 1,
      maxTokens,
      finishReason,
      hasContent: Boolean(content),
      contentLength: content.length,
      hasReasoning: Boolean(message?.reasoning || message?.reasoning_content),
    });

    if (content && finishReason === "stop") {
      finalContent = content;
      finalFinishReason = finishReason;
      break;
    }

    if (finishReason === "length" && !content && index < OUTPUT_TOKEN_BUDGETS.length - 1) {
      console.warn("[NVIDIA] Incomplete generation detected, retrying with larger token budget", {
        attempt: index + 1,
        currentMaxTokens: maxTokens,
        nextMaxTokens: OUTPUT_TOKEN_BUDGETS[index + 1],
      });
      continue;
    }

    if (index < OUTPUT_TOKEN_BUDGETS.length - 1) {
      console.warn("[NVIDIA] Response did not produce final JSON content, retrying", {
        attempt: index + 1,
        currentMaxTokens: maxTokens,
        nextMaxTokens: OUTPUT_TOKEN_BUDGETS[index + 1],
        finishReason,
        hasContent: Boolean(content),
      });
      continue;
    }

    finalContent = content;
    finalFinishReason = finishReason;
  }

  if (!finalContent || finalFinishReason !== "stop") {
    const lastChoice = lastResult?.choices?.[0] || {};
    const lastMessage = lastChoice?.message || {};
    console.error("[NVIDIA] Model never produced final assistant content", {
      finalFinishReason,
      hasContent: Boolean(finalContent),
      contentLength: finalContent.length,
      lastFinishReason: lastChoice?.finish_reason || "",
      lastHasReasoning: Boolean(lastMessage?.reasoning || lastMessage?.reasoning_content),
    });
    throw new Error(
      "La generacion del modelo quedo incompleta: no devolvio JSON final en message.content."
    );
  }

  console.log("[NVIDIA] Final assistant content", {
    rawContent: finalContent,
  });

  let parsed;
  try {
    parsed = extractJsonObject(finalContent);
    console.log("[NVIDIA] Parsed JSON directly", parsed);
  } catch (jsonError) {
    console.warn("[NVIDIA] Assistant content was not valid JSON, trying labeled field extraction", {
      message: jsonError.message,
    });
    const labeledFields = extractLabeledFields(finalContent);
    if (!labeledFields) {
      throw jsonError;
    }
    parsed = labeledFields;
    console.log("[NVIDIA] Parsed labeled fields from assistant content", parsed);
  }

  const normalized = normalizePassportData(parsed);
  console.log("[NVIDIA] Normalized passport data", normalized);

  return {
    rawContent: finalContent,
    data: normalized,
  };
}
