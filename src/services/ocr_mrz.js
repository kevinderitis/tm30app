import fs from "fs";
import sharp from "sharp";
import { createWorker } from "tesseract.js";

const MRZ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";

function cleanMrzText(str = "") {
  return String(str)
    .toUpperCase()
    .replace(/[«»]/g, "<")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9<]/g, "");
}

function charValue(c) {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 55;
  return 0;
}

function checksum(input) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    sum += charValue(input[i]) * weights[i % 3];
  }
  return String(sum % 10);
}

function formatBirthDateDDMMYYYY(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd)) return "";
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  const yyyy = yy >= 30 ? 1900 + yy : 2000 + yy;
  return `${dd}/${mm}/${yyyy}`;
}

function formatExpiryDateYYMMDD(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd)) return "";
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  const yyyy = 2000 + yy;
  return `${yyyy}-${mm}-${dd}`;
}

function fixCommonMrzConfusionsLine1(s) {
  s = cleanMrzText(s);

  // Línea 1: priorizamos letras para nombres/apellidos
  s = s.replace(/0/g, "O");
  s = s.replace(/1/g, "I");
  s = s.replace(/8/g, "B");

  // símbolos raros por <
  s = s.replace(/[|!]/g, "<");

  // Casos típicos al inicio
  if (s.startsWith("PO")) s = "P<" + s.slice(2);
  if (s.startsWith("P0")) s = "P<" + s.slice(2);

  if (s.startsWith("P") && !s.startsWith("P<")) {
    s = "P<" + s.slice(1);
  }

  return s;
}

function fixCommonMrzConfusionsLine2(s) {
  return cleanMrzText(s);
}

function normalizeLine1(line1) {
  let s = fixCommonMrzConfusionsLine1(line1);
  s = s.padEnd(44, "<").slice(0, 44);

  if (!s.startsWith("P<")) {
    s = "P<" + s.slice(2);
  }

  return s;
}

function normalizeLine2(line2) {
  return fixCommonMrzConfusionsLine2(line2).padEnd(44, "<").slice(0, 44);
}

function repairLine1FillersPreservingNames(line1) {
  let s = normalizeLine1(line1);

  const prefix = s.slice(0, 5); // P< + country
  const names = s.slice(5);

  const sepIndex = names.indexOf("<<");
  if (sepIndex === -1) return s;

  const surnamePart = names.slice(0, sepIndex);
  let givenAndFillers = names.slice(sepIndex);

  // Reparar fillers mal leídos como L SOLO en corridas largas
  givenAndFillers = givenAndFillers.replace(/L{3,}/g, (m) => "<".repeat(m.length));
  givenAndFillers = givenAndFillers.replace(/<L</g, "<<<");
  givenAndFillers = givenAndFillers.replace(/<<L<</g, "<<<<<");

  return (prefix + surnamePart + givenAndFillers).padEnd(44, "<").slice(0, 44);
}

function normalizePassportField(s = "") {
  return cleanMrzText(s)
    .replace(/O/g, "0")
    .replace(/Q/g, "0")
    .replace(/D/g, "0");
  // NO L -> 1: el passport number es alfanumérico
}

function normalizeCountryField(s = "") {
  return cleanMrzText(s)
    .replace(/6/g, "G")
    .replace(/8/g, "B")
    .replace(/0/g, "O")
    .replace(/1/g, "I");
}

function normalizeDateField(s = "") {
  return cleanMrzText(s)
    .replace(/O/g, "0")
    .replace(/Q/g, "0")
    .replace(/D/g, "0")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/Z/g, "2")
    .replace(/S/g, "5")
    .replace(/B/g, "8");
}

function normalizeSexField(s = "") {
  const v = cleanMrzText(s)
    .replace(/H/g, "M")
    .replace(/N/g, "M");
  return v[0] || "<";
}

function normalizePersonalNumberField(s = "") {
  return cleanMrzText(s)
    .replace(/O/g, "0")
    .replace(/Q/g, "0");
}

function scoreLine1(line1) {
  let score = 0;
  const s = repairLine1FillersPreservingNames(line1);

  if (s.startsWith("P<")) score += 6;
  if (/^P<[A-Z<]{3}/.test(s)) score += 4;
  if (s.includes("<<")) score += 4;
  if ((s.match(/</g) || []).length >= 5) score += 3;
  if (/[A-Z]{2,}/.test(s.slice(5))) score += 2;

  return score;
}

function scoreLine2(line2) {
  let score = 0;
  const raw = normalizeLine2(line2);

  const passportNo = normalizePassportField(raw.slice(0, 9));
  const passportCheck = normalizeDateField(raw[9] || "");
  const nationality = normalizeCountryField(raw.slice(10, 13));
  const birthDate = normalizeDateField(raw.slice(13, 19));
  const birthCheck = normalizeDateField(raw[19] || "");
  const sex = normalizeSexField(raw[20] || "");
  const expiry = normalizeDateField(raw.slice(21, 27));
  const expiryCheck = normalizeDateField(raw[27] || "");
  const personalNumber = normalizePersonalNumberField(raw.slice(28, 42));
  const personalCheck = normalizeDateField(raw[42] || "");
  const finalCheck = normalizeDateField(raw[43] || "");

  if (/^[A-Z0-9<]{9}$/.test(passportNo)) score += 2;
  if (/^[A-Z]{3}$/.test(nationality)) score += 3;
  if (/^\d{6}$/.test(birthDate)) score += 4;
  if (/^[MFX<]$/.test(sex)) score += 2;
  if (/^\d{6}$/.test(expiry)) score += 4;

  if (/^\d$/.test(passportCheck) && checksum(passportNo) === passportCheck) score += 8;
  if (/^\d$/.test(birthCheck) && checksum(birthDate) === birthCheck) score += 8;
  if (/^\d$/.test(expiryCheck) && checksum(expiry) === expiryCheck) score += 8;

  const composite =
    passportNo +
    passportCheck +
    birthDate +
    birthCheck +
    expiry +
    expiryCheck +
    personalNumber +
    personalCheck;

  if (/^\d$/.test(finalCheck) && checksum(composite) === finalCheck) score += 10;

  return score;
}

function cleanupHumanName(text = "") {
  return String(text)
    .replace(/<+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNameWord(word = "") {
  let w = String(word).trim();
  if (!w) return "";

  w = w.replace(/0/g, "O");
  w = w.replace(/1/g, "I");

  return w;
}

function pickOnlyFirstGivenName(givenRaw = "") {
  const clean = cleanupHumanName(givenRaw);
  if (!clean) return "";

  const parts = clean
    .split(" ")
    .map(normalizeNameWord)
    .filter(Boolean);

  return parts[0] || "";
}

function cleanupSurname(surnameRaw = "") {
  const clean = cleanupHumanName(surnameRaw);
  if (!clean) return "";

  return clean
    .split(" ")
    .map(normalizeNameWord)
    .filter(Boolean)
    .join(" ");
}

function repairIssuingCountry(issuingCountry, nationality, line1, line2) {
  let country = issuingCountry;

  if (!/^[A-Z]{3}$/.test(country) && /^[A-Z]{3}$/.test(nationality)) {
    country = nationality;
  }

  if ((country === "OCH" || country === "0CH") && nationality === "CHN") {
    country = "CHN";
  }

  const raw1 = cleanMrzText(line1);
  if (raw1.startsWith("P<") && /^[A-Z]{3}$/.test(raw1.slice(2, 5))) {
    country = raw1.slice(2, 5);
  }

  if (!/^[A-Z]{3}$/.test(country) && /^[A-Z]{3}$/.test(nationality)) {
    country = nationality;
  }

  return country;
}

function parseTd3(line1, line2) {
  const l1 = repairLine1FillersPreservingNames(line1);
  const rawL2 = normalizeLine2(line2);

  let issuingCountry = l1.slice(2, 5);

  const namesPart = l1.slice(5);
  const nameParts = namesPart.split("<<");

  const surnameRaw = nameParts[0] || "";
  const givenRaw = nameParts.slice(1).join("<<") || "";

  const passportNoField = normalizePassportField(rawL2.slice(0, 9));
  const passportCheck = normalizeDateField(rawL2[9] || "");
  const nationality = normalizeCountryField(rawL2.slice(10, 13));
  const birthDate = normalizeDateField(rawL2.slice(13, 19));
  const birthCheck = normalizeDateField(rawL2[19] || "");
  const sex = normalizeSexField(rawL2[20] || "");
  const expiry = normalizeDateField(rawL2.slice(21, 27));
  const expiryCheck = normalizeDateField(rawL2[27] || "");
  const personalNumber = normalizePersonalNumberField(rawL2.slice(28, 42));
  const personalCheck = normalizeDateField(rawL2[42] || "");
  const finalCheck = normalizeDateField(rawL2[43] || "");

  issuingCountry = repairIssuingCountry(issuingCountry, nationality, line1, line2);

  const rebuiltL2 =
    passportNoField +
    passportCheck +
    nationality +
    birthDate +
    birthCheck +
    sex +
    expiry +
    expiryCheck +
    personalNumber +
    personalCheck +
    finalCheck;

  const checks = {
    passportNumberOk: /^\d$/.test(passportCheck) && checksum(passportNoField) === passportCheck,
    birthDateOk: /^\d$/.test(birthCheck) && checksum(birthDate) === birthCheck,
    expiryOk: /^\d$/.test(expiryCheck) && checksum(expiry) === expiryCheck,
    personalNumberOk: /^\d$/.test(personalCheck) && checksum(personalNumber) === personalCheck,
    finalOk:
      /^\d$/.test(finalCheck) &&
      checksum(
        passportNoField +
        passportCheck +
        birthDate +
        birthCheck +
        expiry +
        expiryCheck +
        personalNumber +
        personalCheck
      ) === finalCheck
  };

  const validScore = Object.values(checks).filter(Boolean).length;

  return {
    raw: [l1, rebuiltL2],
    documentType: l1.slice(0, 2),
    issuingCountry,
    passportNo: passportNoField.replace(/</g, ""),
    nationality,
    firstName: pickOnlyFirstGivenName(givenRaw),
    middleName: "",
    lastName: cleanupSurname(surnameRaw),
    birthDate,
    birthDateDDMMYYYY: formatBirthDateDDMMYYYY(birthDate),
    expiry,
    expiryIso: formatExpiryDateYYMMDD(expiry),
    gender: sex === "<" ? "" : sex,
    personalNumber: personalNumber.replace(/</g, ""),
    checks,
    valid: checks.passportNumberOk && checks.birthDateOk && checks.expiryOk,
    validScore
  };
}

function extractLines(rawText) {
  return String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function buildCandidatesFromLines(lines) {
  const raw = lines.map((l) => cleanMrzText(l)).filter(Boolean);
  const candidates = [];

  // pares de líneas tal como vienen
  for (let i = 0; i < raw.length; i++) {
    for (let j = 0; j < raw.length; j++) {
      if (i === j) continue;

      const a = raw[i];
      const b = raw[j];

      if (a.length >= 15 && b.length >= 20) {
        candidates.push({
          line1: a,
          line2: b,
          score: scoreLine1(a) + scoreLine2(b)
        });
      }
    }
  }

  // si OCR partió una línea, intentar unir vecinas
  for (let i = 0; i < raw.length - 1; i++) {
    const joined = raw[i] + raw[i + 1];
    const joined2 = raw[i + 1] + raw[i];

    candidates.push({
      line1: joined,
      line2: raw[i + 1],
      score: scoreLine1(joined) + scoreLine2(raw[i + 1])
    });

    candidates.push({
      line1: raw[i],
      line2: joined,
      score: scoreLine1(raw[i]) + scoreLine2(joined)
    });

    candidates.push({
      line1: joined2,
      line2: raw[i],
      score: scoreLine1(joined2) + scoreLine2(raw[i])
    });
  }

  // intentar deducir desde texto completo
  const full = raw.join("");
  if (full.length >= 40) {
    const pIndex = full.indexOf("P<");
    if (pIndex >= 0) {
      const possibleLine1 = full.slice(pIndex, pIndex + 60);
      const rest = full.slice(pIndex + 40);

      candidates.push({
        line1: possibleLine1,
        line2: rest,
        score: scoreLine1(possibleLine1) + scoreLine2(rest)
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function chooseBetterResult(a, b) {
  if (!a) return b;
  if (!b) return a;

  if (b.validScore !== a.validScore) return b.validScore > a.validScore ? b : a;

  const aChecks = Object.values(a.checks || {}).filter(Boolean).length;
  const bChecks = Object.values(b.checks || {}).filter(Boolean).length;
  if (bChecks !== aChecks) return bChecks > aChecks ? b : a;

  const aNames = (a.firstName?.length || 0) + (a.lastName?.length || 0);
  const bNames = (b.firstName?.length || 0) + (b.lastName?.length || 0);
  if (bNames !== aNames) return bNames > aNames ? b : a;

  return a;
}

async function buildImageVariants(imageInput) {
  const imageBuffer = Buffer.isBuffer(imageInput)
    ? imageInput
    : fs.readFileSync(imageInput);

  const meta = await sharp(imageBuffer).metadata();
  const width = meta.width;
  const height = meta.height;

  if (!width || !height) throw new Error("No pude leer el tamaño de la imagen");

  const regionSpecs = [
    null,
    { top: 0.50, h: 0.40 },
    { top: 0.55, h: 0.35 },
    { top: 0.60, h: 0.30 },
    { top: 0.65, h: 0.25 },
    { top: 0.70, h: 0.20 },
    { top: 0.75, h: 0.20 }
  ];

  const results = [];

  for (const region of regionSpecs) {
    let base;

    if (!region) {
      base = await sharp(imageBuffer)
        .resize({ width: 2400, withoutEnlargement: false })
        .grayscale()
        .normalize()
        .toBuffer();
    } else {
      const top = Math.max(0, Math.floor(height * region.top));
      const cropHeight = Math.min(height - top, Math.floor(height * region.h));

      if (cropHeight < 80) continue;

      base = await sharp(imageBuffer)
        .extract({
          left: 0,
          top,
          width,
          height: cropHeight
        })
        .resize({ width: 2400, withoutEnlargement: false })
        .grayscale()
        .normalize()
        .toBuffer();
    }

    const variants = [
      base,
      await sharp(base).median(1).toBuffer(),
      await sharp(base).threshold(135).toBuffer(),
      await sharp(base).threshold(155).toBuffer(),
      await sharp(base).threshold(175).toBuffer(),
      await sharp(base).sharpen().toBuffer(),
      await sharp(base).normalize().sharpen().toBuffer(),
      await sharp(base).rotate(-1, { background: "#ffffff" }).toBuffer(),
      await sharp(base).rotate(1, { background: "#ffffff" }).toBuffer(),
      await sharp(base).rotate(-2, { background: "#ffffff" }).toBuffer(),
      await sharp(base).rotate(2, { background: "#ffffff" }).toBuffer()
    ];

    for (const v of variants) results.push(v);
  }

  return results;
}

async function runOcr(worker, buffer, psm) {
  const { data } = await worker.recognize(buffer, {
    tessedit_pageseg_mode: String(psm),
    tessedit_char_whitelist: MRZ_CHARS,
    preserve_interword_spaces: "0"
  });

  return data?.text || "";
}

function toApiResult(parsed) {
  const score = parsed.validScore || 0;
  const warnings = [];

  if (!parsed.valid) warnings.push("mrz_not_fully_valid");
  if (!parsed.firstName) warnings.push("mrz_first_name_needs_review");
  if (!parsed.lastName) warnings.push("mrz_last_name_needs_review");
  if (!/^[A-Z]{3}$/.test(parsed.nationality || "")) warnings.push("mrz_nationality_needs_review");

  return {
    score,
    data: {
      firstName: parsed.firstName || "",
      middleName: parsed.middleName || "",
      lastName: parsed.lastName || "",
      gender: parsed.gender || "",
      passportNo: parsed.passportNo || "",
      nationality: parsed.nationality || "",
      birthDateDDMMYYYY: parsed.birthDateDDMMYYYY || "",
      checks: parsed.checks || {}
    },
    l1: parsed.raw?.[0] || "",
    l2: parsed.raw?.[1] || "",
    warnings
  };
}

export async function readMrzBestEffort(imageInput) {
  const worker = await createWorker("eng");
  let best = null;
  const debugSamples = [];

  const meta = await sharp(imageInput).metadata();
  console.log("Input image size:", meta.width, meta.height);

  try {
    const variants = await buildImageVariants(imageInput);
    const psms = [6, 11, 12];

    for (const variant of variants) {
      for (const psm of psms) {
        const rawText = await runOcr(worker, variant, psm);
        const lines = extractLines(rawText);
        const candidates = buildCandidatesFromLines(lines);

        if (debugSamples.length < 8) {
          debugSamples.push({ psm, rawText, lines });
        }

        for (const c of candidates.slice(0, 12)) {
          const parsed = parseTd3(c.line1, c.line2);
          best = chooseBetterResult(best, parsed);

          if (parsed.valid) {
            const result = toApiResult(parsed);
            console.log("MRZ best effort result:", result);
            return result;
          }
        }
      }
    }

    if (best) {
      const result = toApiResult(best);
      console.log("MRZ best effort result:", result);
      return result;
    }

    return null;
  } finally {
    await worker.terminate();
  }
}