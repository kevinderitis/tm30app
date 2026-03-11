// import sharp from "sharp";
// import { createWorker } from "tesseract.js";
// import { extractMrzLines, parseMrzTD3 } from "./mrz.js";

// function scoreFromChecks(checks) {
//   return (checks.passportNumberOk ? 1 : 0) + (checks.birthDateOk ? 1 : 0) + (checks.expiryOk ? 1 : 0);
// }

// async function recognize(worker, buffer) {
//   const { data } = await worker.recognize(buffer);
//   return (data?.text || "").toUpperCase();
// }

// export async function readMrzBestEffort(imageInput) {
//   const base = await sharp(imageInput)
//     .grayscale()
//     .normalize()
//     .resize({ width: 1800, withoutEnlargement: true })
//     .toBuffer();


//   console.log("Base image prepared, size:", base.length);

//   const variants = [];
//   variants.push(base);
//   variants.push(await sharp(base).threshold(160).toBuffer());
//   variants.push(await sharp(base).rotate(-2, { background: "#000" }).toBuffer());
//   variants.push(await sharp(base).rotate(2, { background: "#000" }).toBuffer());
//   variants.push(await sharp(base).sharpen().toBuffer());

//   const worker = await createWorker("eng");
//   try {
//     await worker.setParameters({
//       tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
//       preserve_interword_spaces: "1"
//     });

//     let best = null;

//     for (const v of variants) {
//       const text = await recognize(worker, v);
//       console.log("OCR text:", text);

//       const mrz = extractMrzLines(text);
//       console.log("Detected MRZ:", mrz);

//       if (!mrz) continue;

//       const [l1, l2] = mrz;

//       try {
//         const data = parseMrzTD3(l1, l2);
//         const score = scoreFromChecks(data.checks);

//         console.log("Parsed data:", data);
//         console.log("Score:", score);

//         if (!best || score > best.score) {
//           best = { score, data, l1, l2 };
//         }
//         if (score === 3) break;
//       } catch (err) {
//         console.log("Parse error:", err.message);
//       }
//     }

//     return best;
//   } finally {
//     await worker.terminate();
//   }
// }

import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { parseMrzTD3 } from "./mrz.js";

function scoreFromChecks(checks) {
  return (checks.passportNumberOk ? 1 : 0) +
    (checks.birthDateOk ? 1 : 0) +
    (checks.expiryOk ? 1 : 0);
}

function cleanOcrText(text) {
  return (text || "")
    .toUpperCase()
    .replace(/\r/g, "")
    .replace(/[^\nA-Z0-9< ]/g, "");
}

function countChar(str, ch) {
  return (str.match(new RegExp(`\\${ch}`, "g")) || []).length;
}

function looksLikeLine1(line) {
  const s = (line || "").replace(/\s/g, "");
  return (
    s.includes("<") &&
    (
      s.startsWith("P<") ||
      s.startsWith("IP<") ||
      s.startsWith("LP<") ||
      s.startsWith("1P<") ||
      s.startsWith("PC") ||
      s.startsWith("PARG") ||
      s.startsWith("ARG")
    )
  );
}

function looksLikeLine2(line) {
  const s = (line || "").replace(/\s/g, "");
  return /\d{6}/.test(s);
}

function normalizeLine1(line) {
  let s = (line || "")
    .toUpperCase()
    .replace(/\s/g, "")
    .replace(/[^A-Z0-9<]/g, "");

  // arreglos de prefijo documento/país
  s = s.replace(/^IP</, "P<");
  s = s.replace(/^1P</, "P<");
  s = s.replace(/^LP</, "P<");
  s = s.replace(/^PCARG/, "P<ARG");
  s = s.replace(/^PARG/, "P<ARG");
  s = s.replace(/^ARG/, "P<ARG");

  // arreglos suaves de separadores sin destruir letras de nombres
  s = s.replace(/<<+/g, "<<");
  s = s.replace(/<K</g, "<<<");
  s = s.replace(/<C</g, "<<<");
  s = s.replace(/<L</g, "<<<");
  s = s.replace(/<I</g, "<<<");
  s = s.replace(/K<K/g, "<<");
  s = s.replace(/C<C/g, "<<");
  s = s.replace(/L<L/g, "<<");
  s = s.replace(/I<I/g, "<<");

  // relleno al final
  s = s.replace(/<{3,}/g, "<<<<<<");

  if (!s.startsWith("P<")) {
    s = "P<" + s.replace(/^P*/, "");
  }

  return s.padEnd(44, "<").slice(0, 44);
}

function normalizeLine2(line) {
  let s = (line || "")
    .toUpperCase()
    .replace(/\s/g, "")
    .replace(/[^A-Z0-9<]/g, "");

  // correcciones OCR comunes en línea 2
  s = s.replace(/O/g, "0");
  s = s.replace(/I/g, "1");
  s = s.replace(/Z/g, "2");
  s = s.replace(/S/g, "5");
  s = s.replace(/B/g, "8");

  // fixes frecuentes concretos
  s = s.replace(/AR6/g, "ARG");
  s = s.replace(/DE6/g, "DEG"); // por si aparece en otros contextos, luego parser/validación manda
  s = s.replace(/6BR/g, "GBR");

  return s.padEnd(44, "<").slice(0, 44);
}

function line1QualityScore(l1) {
  let score = 0;

  if (l1.startsWith("P<")) score += 2;

  const separators = countChar(l1, "<");
  if (separators >= 6) score += 1;
  if (separators >= 10) score += 1;
  if (separators >= 14) score += 1;

  const letters = (l1.replace(/[^A-Z]/g, "") || "").length;
  if (letters >= 8) score += 1;
  if (letters >= 12) score += 1;

  return score;
}

function totalScore(data, l1, l2) {
  return (
    scoreFromChecks(data.checks) * 100 +
    line1QualityScore(l1) * 5 +
    (/^[A-Z0-9<]{44}$/.test(l1) ? 5 : 0) +
    (/^[A-Z0-9<]{44}$/.test(l2) ? 5 : 0)
  );
}

async function recognize(worker, buffer, whitelist) {
  await worker.setParameters({
    tessedit_char_whitelist: whitelist,
    preserve_interword_spaces: "1"
  });

  const { data } = await worker.recognize(buffer);
  return cleanOcrText(data?.text || "");
}

function pickBestLine1(lines) {
  if (!lines.length) return null;

  const scored = lines.map((line) => {
    const normalized = normalizeLine1(line);
    return {
      raw: line,
      normalized,
      score:
        (looksLikeLine1(line) ? 20 : 0) +
        line1QualityScore(normalized) +
        countChar(normalized, "<")
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].raw;
}

function pickBestLine2(lines) {
  if (!lines.length) return null;

  const scored = lines.map((line) => {
    const normalized = normalizeLine2(line);
    return {
      raw: line,
      normalized,
      score:
        (looksLikeLine2(line) ? 20 : 0) +
        (/\d{6}/.test(normalized) ? 10 : 0) +
        (/[A-Z]{3}/.test(normalized.slice(10, 13)) ? 5 : 0)
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].raw;
}

function mergeMrzCandidates(textGeneral, textNames) {
  const allLines = [textGeneral, textNames]
    .flatMap((t) => (t || "").split(/\n/))
    .map((l) => l.toUpperCase().replace(/\s/g, "").trim())
    .filter(Boolean)
    .filter((l) => l.length >= 20);

  const line1Candidates = allLines.filter((l) => l.includes("<"));
  const line2Candidates = allLines.filter((l) => /\d{6}/.test(l));

  const bestLine1 = pickBestLine1(line1Candidates);
  const bestLine2 = pickBestLine2(line2Candidates);

  if (!bestLine1 || !bestLine2) return null;

  return [
    normalizeLine1(bestLine1),
    normalizeLine2(bestLine2)
  ];
}

function cleanupNameToken(token) {
  return (token || "")
    .replace(/^[<]+|[<]+$/g, "")
    .replace(/[^A-Z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function maybeFixCommonNameArtifacts(token) {
  let t = token || "";

  // artefactos comunes sin tocar demasiado
  t = t.replace(/^K(?=[A-Z]{3,})/, "");     // KKEVIN -> KEVIN
  t = t.replace(/^C(?=[A-Z]{3,})/, "");     // CKEVIN -> KEVIN
  t = t.replace(/^L(?=[A-Z]{3,})/, "");     // LKEVIN -> KEVIN

  t = t.replace(/(?<=[A-Z])K(?=[A-Z]{3,})/g, " ");
  t = t.replace(/(?<=[A-Z])C(?=[A-Z]{3,})/g, " ");
  t = t.replace(/(?<=[A-Z])L(?=[A-Z]{3,})/g, " ");

  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function normalizeHumanName(name) {
  let n = cleanupNameToken(name);
  n = maybeFixCommonNameArtifacts(n);

  // Si quedó todo pegado y largo, al menos conservarlo legible
  return n.replace(/\s+/g, " ").trim();
}

function extractNamesFromLine1Flexible(l1) {
  // quitar prefijo P< + país (3 letras)
  const body = (l1 || "").slice(5);

  // split principal por << (apellido || nombres)
  const parts = body.split("<<").filter(Boolean);

  let surnamePart = parts[0] || "";
  let namesPart = parts.slice(1).join(" ");

  surnamePart = surnamePart.replace(/</g, " ");
  namesPart = namesPart.replace(/</g, " ");

  let lastName = normalizeHumanName(surnamePart);
  let names = normalizeHumanName(namesPart);

  // fallback extra: si names quedó vacío pero hay mucho texto en surnamePart roto
  if (!names && lastName.includes(" ")) {
    const chunks = lastName.split(" ").filter(Boolean);
    if (chunks.length >= 3) {
      lastName = chunks.slice(0, Math.max(1, chunks.length - 2)).join(" ");
      names = chunks.slice(Math.max(1, chunks.length - 2)).join(" ");
    }
  }

  const nameTokens = names.split(" ").filter(Boolean);

  return {
    lastName,
    firstName: nameTokens[0] || "",
    middleName: nameTokens.slice(1).join(" ") || "",
    rawLine1Names: names
  };
}

function mergeParsedNames(data, l1) {
  const extracted = extractNamesFromLine1Flexible(l1);

  const merged = {
    ...data,
    lastName: normalizeHumanName(data.lastName || extracted.lastName || ""),
    firstName: normalizeHumanName(data.firstName || extracted.firstName || ""),
    middleName: normalizeHumanName(data.middleName || extracted.middleName || ""),
    rawLine1Names: extracted.rawLine1Names || ""
  };

  // fallback: si firstName sigue vacío y middleName tiene todo
  if (!merged.firstName && merged.middleName) {
    const tokens = merged.middleName.split(" ").filter(Boolean);
    merged.firstName = tokens[0] || "";
    merged.middleName = tokens.slice(1).join(" ");
  }

  return merged;
}

function addWarnings(data, l1, l2, score) {
  const warnings = [];

  if (scoreFromChecks(data.checks) < 3) warnings.push("mrz_checks_not_perfect");
  if (!data.firstName) warnings.push("mrz_first_name_needs_review");
  if (!data.lastName) warnings.push("mrz_last_name_needs_review");
  if (!/^[A-Z]{3}$/.test(data.nationality || "")) warnings.push("mrz_nationality_needs_review");
  if (!l1.startsWith("P<")) warnings.push("mrz_line1_prefix_unusual");
  if (!/\d{6}/.test(l2)) warnings.push("mrz_line2_unusual");

  return warnings;
}

export async function readMrzBestEffort(imageInput) {
  const base = await sharp(imageInput)
    .extend({
      top: 40,
      bottom: 40,
      left: 0,
      right: 0,
      background: "#ffffff"
    })
    .grayscale()
    .normalize()
    .resize({ width: 2200, withoutEnlargement: false })
    .toBuffer();

  console.log("Base image prepared, size:", base.length);

  const variants = [
    base,
    await sharp(base).threshold(140).toBuffer(),
    await sharp(base).threshold(170).toBuffer(),
    await sharp(base).rotate(-2, { background: "#ffffff" }).toBuffer(),
    await sharp(base).rotate(2, { background: "#ffffff" }).toBuffer(),
    await sharp(base).sharpen().toBuffer()
  ];

  const worker = await createWorker("eng");

  try {
    let best = null;

    for (const v of variants) {
      const textGeneral = await recognize(
        worker,
        v,
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"
      );

      const textNames = await recognize(
        worker,
        v,
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ<"
      );

      console.log("OCR general:", textGeneral);
      console.log("OCR names:", textNames);

      const mrz = mergeMrzCandidates(textGeneral, textNames);
      console.log("Merged MRZ:", mrz);

      if (!mrz) continue;

      const [l1, l2] = mrz;

      try {
        let data = parseMrzTD3(l1, l2);

        // Fallback y reconstrucción de nombres
        data = mergeParsedNames(data, l1);

        const score = totalScore(data, l1, l2);
        const warnings = addWarnings(data, l1, l2, score);

        console.log("Parsed data:", data);
        console.log("Final score:", score);
        console.log("Warnings:", warnings);

        if (!best || score > best.score) {
          best = { score, data, l1, l2, warnings };
        }

        if (score >= 320 && warnings.length === 0) break;
      } catch (err) {
        console.log("Parse error:", err.message);
      }
    }

    return best;
  } finally {
    await worker.terminate();
  }
}
