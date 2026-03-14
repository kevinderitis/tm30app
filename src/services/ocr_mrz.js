import vision from "@google-cloud/vision";
import { parse } from "mrz";

const client = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_VISION_KEY)
});

function normalizeMrzLine(line = "") {
  return String(line)
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9<]/g, "");
}

function extractMrzLinesFromText(fullText = "") {
  const lines = String(fullText)
    .split(/\r?\n/)
    .map((line) => normalizeMrzLine(line))
    .filter((line) => /^[A-Z0-9<]{10,}$/.test(line));

  if (lines.length < 2) return null;

  // normalmente las 2 últimas líneas válidas son la MRZ
  return lines.slice(-2);
}

function formatBirthDateDDMMYYYY(dateValue = "") {
  // si parse devuelve YYMMDD
  if (/^\d{6}$/.test(dateValue)) {
    const yy = Number(dateValue.slice(0, 2));
    const mm = dateValue.slice(2, 4);
    const dd = dateValue.slice(4, 6);
    const yyyy = yy >= 30 ? 1900 + yy : 2000 + yy;
    return `${dd}/${mm}/${yyyy}`;
  }

  // si parse devuelve YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    const [yyyy, mm, dd] = dateValue.split("-");
    return `${dd}/${mm}/${yyyy}`;
  }

  return "";
}

function buildWarnings(parsed) {
  const warnings = [];

  if (!parsed?.valid) warnings.push("mrz_not_fully_valid");
  if (!parsed?.fields?.firstName) warnings.push("mrz_first_name_needs_review");
  if (!parsed?.fields?.lastName) warnings.push("mrz_last_name_needs_review");
  if (!parsed?.fields?.documentNumber) warnings.push("mrz_document_number_needs_review");
  if (!parsed?.fields?.nationality) warnings.push("mrz_nationality_needs_review");
  if (!parsed?.fields?.birthDate) warnings.push("mrz_birth_date_needs_review");

  return warnings;
}

function toApiResult(parsed, mrzLines, rawText) {
  const fields = parsed.fields || {};

  return {
    score: parsed.valid ? 3 : 1,
    data: {
      firstName: fields.firstName || "",
      middleName: "",
      lastName: fields.lastName || "",
      gender: fields.sex || "",
      passportNo: fields.documentNumber || "",
      nationality: fields.nationality || "",
      birthDateDDMMYYYY: formatBirthDateDDMMYYYY(fields.birthDate || ""),
      checks: {
        passportNumberOk: !!parsed.valid,
        birthDateOk: !!parsed.valid,
        expiryOk: !!parsed.valid
      }
    },
    l1: mrzLines?.[0] || "",
    l2: mrzLines?.[1] || "",
    warnings: buildWarnings(parsed),
    rawText
  };
}

export async function readMrzBestEffort(imageInput) {
  try {
    const [result] = await client.textDetection(imageInput);

    const fullText = result?.textAnnotations?.[0]?.description || "";

    console.log("Google Vision full text:", fullText);

    if (!fullText) {
      return null;
    }

    const mrzLines = extractMrzLinesFromText(fullText);

    if (!mrzLines || mrzLines.length < 2) {
      return null;
    }

    const parsed = parse(mrzLines);

    if (!parsed) {
      return null;
    }

    const apiResult = toApiResult(parsed, mrzLines, fullText);

    console.log("Vision MRZ lines:", mrzLines);
    console.log("Vision parsed MRZ:", apiResult);

    return apiResult;
  } catch (error) {
    console.error("Google Vision MRZ error:", error.message);
    return null;
  }
}