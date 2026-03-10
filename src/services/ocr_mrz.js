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
  return (checks.passportNumberOk ? 1 : 0) + (checks.birthDateOk ? 1 : 0) + (checks.expiryOk ? 1 : 0);
}

function cleanText(text) {
  return (text || "")
    .toUpperCase()
    .replace(/\s/g, "")
    .replace(/[^A-Z0-9<]/g, "");
}

function normalizeMrzLine1(line) {
  let s = cleanText(line);

  if (s.startsWith("IP<")) s = "P<" + s.slice(3);
  if (s.startsWith("1P<")) s = "P<" + s.slice(3);
  if (s.startsWith("LP<")) s = "P<" + s.slice(3);

  s = s.replace(/^I</, "P<");
  s = s.replace(/^1</, "P<");

  // Errores comunes en nombres/separadores
  s = s.replace(/SS/g, "<<");
  s = s.replace(/KK/g, "<<");
  s = s.replace(/CLL+/g, "<<<<<<");
  s = s.replace(/L{4,}/g, "<<<<<<");
  s = s.replace(/<{3,}/g, "<<<<<<");

  return s.padEnd(44, "<").slice(0, 44);
}

function normalizeMrzLine2(line) {
  let s = cleanText(line);

  // Errores comunes en OCR
  s = s.replace(/O/g, "0");
  s = s.replace(/I/g, "1");
  s = s.replace(/Z/g, "2");
  s = s.replace(/S/g, "5");
  s = s.replace(/B/g, "8");

  return s.padEnd(44, "<").slice(0, 44);
}

async function recognizeSingleLine(worker, buffer) {
  const { data } = await worker.recognize(buffer);
  return data?.text || "";
}

async function makeVariants(buffer) {
  return [
    buffer,
    await sharp(buffer).threshold(140).toBuffer(),
    await sharp(buffer).threshold(170).toBuffer(),
    await sharp(buffer).sharpen().toBuffer(),
    await sharp(buffer).rotate(-1.5, { background: "#000" }).toBuffer(),
    await sharp(buffer).rotate(1.5, { background: "#000" }).toBuffer()
  ];
}

export async function readMrzBestEffort(imageInput) {
  const base = await sharp(imageInput)
    .grayscale()
    .normalize()
    .resize({ width: 2400, withoutEnlargement: false })
    .toBuffer();

  const meta = await sharp(base).metadata();
  const width = meta.width;
  const height = meta.height;

  if (!width || !height) return null;

  const lineHeight = Math.floor(height / 2);

  const line1Base = await sharp(base)
    .extract({ left: 0, top: 0, width, height: lineHeight })
    .toBuffer();

  const line2Base = await sharp(base)
    .extract({ left: 0, top: lineHeight, width, height: height - lineHeight })
    .toBuffer();

  const line1Variants = await makeVariants(line1Base);
  const line2Variants = await makeVariants(line2Base);

  const worker = await createWorker("eng");

  try {
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
      preserve_interword_spaces: "0",
      tessedit_pageseg_mode: "7"
    });

    let best = null;

    for (const v1 of line1Variants) {
      const raw1 = await recognizeSingleLine(worker, v1);
      const l1 = normalizeMrzLine1(raw1);

      for (const v2 of line2Variants) {
        const raw2 = await recognizeSingleLine(worker, v2);
        const l2 = normalizeMrzLine2(raw2);

        try {
          const data = parseMrzTD3(l1, l2);
          const score = scoreFromChecks(data.checks);

          console.log("RAW L1:", raw1);
          console.log("RAW L2:", raw2);
          console.log("NORM L1:", l1);
          console.log("NORM L2:", l2);
          console.log("PARSED:", data);
          console.log("SCORE:", score);

          if (!best || score > best.score) {
            best = { score, data, l1, l2 };
          }

          if (score === 3) return best;
        } catch (err) {
          console.log("Parse error:", err.message);
        }
      }
    }

    return best;
  } finally {
    await worker.terminate();
  }
}