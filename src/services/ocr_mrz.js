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
import { extractMrzLines, parseMrzTD3 } from "./mrz.js";

function scoreFromChecks(checks) {
  return (checks.passportNumberOk ? 1 : 0) +
    (checks.birthDateOk ? 1 : 0) +
    (checks.expiryOk ? 1 : 0);
}

function countChar(str, ch) {
  return (str.match(new RegExp(`\\${ch}`, "g")) || []).length;
}

function cleanOcrText(text) {
  return (text || "")
    .toUpperCase()
    .replace(/\r/g, "")
    .replace(/[^\nA-Z0-9< ]/g, "");
}

function normalizeLine1(line) {
  let s = (line || "")
    .toUpperCase()
    .replace(/\s/g, "")
    .replace(/[^A-Z0-9<]/g, "");

  // arreglos comunes al inicio
  s = s.replace(/^IP</, "P<");
  s = s.replace(/^1P</, "P<");
  s = s.replace(/^LP</, "P<");
  s = s.replace(/^PARG/, "P<ARG");

  // letras mal leídas como separadores
  s = s.replace(/<K</g, "<<<");
  s = s.replace(/<C</g, "<<<");
  s = s.replace(/<L</g, "<<<");
  s = s.replace(/K<K/g, "<<");
  s = s.replace(/C<C/g, "<<");
  s = s.replace(/L<L/g, "<<");

  s = s.replace(/K/g, "<");
  s = s.replace(/C/g, "<");
  s = s.replace(/L/g, "<");
  s = s.replace(/I/g, "<");

  // colapsar separadores largos
  s = s.replace(/<{3,}/g, "<<<<<<");

  // asegurar prefijo de pasaporte
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

  // errores típicos OCR
  s = s.replace(/O/g, "0");
  s = s.replace(/I/g, "1");
  s = s.replace(/Z/g, "2");
  s = s.replace(/S/g, "5");
  s = s.replace(/B/g, "8");

  return s.padEnd(44, "<").slice(0, 44);
}

function line1QualityScore(l1) {
  let score = 0;

  if (l1.startsWith("P<")) score += 2;

  const separators = countChar(l1, "<");
  if (separators >= 8) score += 2;
  if (separators >= 12) score += 1;

  // penalizar si casi no hay letras reales de nombres
  const letters = (l1.replace(/[^A-Z]/g, "") || "").length;
  if (letters >= 8) score += 1;

  return score;
}

function totalScore(data, l1) {
  return scoreFromChecks(data.checks) * 10 + line1QualityScore(l1);
}

async function recognize(worker, buffer) {
  const { data } = await worker.recognize(buffer);
  return cleanOcrText(data?.text || "");
}

async function runPass(worker, buffer, whitelist) {
  await worker.setParameters({
    tessedit_char_whitelist: whitelist,
    preserve_interword_spaces: "1"
  });

  return await recognize(worker, buffer);
}

function mergeMrzCandidates(textGeneral, textNames) {
  const mrzGeneral = extractMrzLines(textGeneral);
  const mrzNames = extractMrzLines(textNames);

  if (!mrzGeneral && !mrzNames) return null;

  if (mrzGeneral && !mrzNames) {
    const [l1, l2] = mrzGeneral;
    return [normalizeLine1(l1), normalizeLine2(l2)];
  }

  if (!mrzGeneral && mrzNames) {
    const [l1, l2] = mrzNames;
    return [normalizeLine1(l1), normalizeLine2(l2)];
  }

  // combinar: línea 1 de pasada "nombres", línea 2 de pasada general
  const [l1Names] = mrzNames;
  const [, l2General] = mrzGeneral;

  return [normalizeLine1(l1Names), normalizeLine2(l2General)];
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
      // pasada general
      const textGeneral = await runPass(
        worker,
        v,
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"
      );

      // pasada enfocada en nombres / separadores
      const textNames = await runPass(
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
        const data = parseMrzTD3(l1, l2);
        const score = totalScore(data, l1);

        console.log("Parsed data:", data);
        console.log("Final score:", score);

        if (!best || score > best.score) {
          best = { score, data, l1, l2 };
        }

        // ya está perfecto en checks y la línea 1 parece sana
        if (score >= 35) break;
      } catch (err) {
        console.log("Parse error:", err.message);
      }
    }

    return best;
  } finally {
    await worker.terminate();
  }
}