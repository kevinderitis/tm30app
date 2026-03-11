import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { extractMrzLines, parseMrzTD3 } from "./mrz.js";

function scoreFromChecks(checks) {
  return (checks.passportNumberOk ? 1 : 0) +
    (checks.birthDateOk ? 1 : 0) +
    (checks.expiryOk ? 1 : 0);
}

async function recognize(worker, buffer) {
  const { data } = await worker.recognize(buffer);
  return (data?.text || "").toUpperCase();
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
    .resize({ width: 1800, withoutEnlargement: false })
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
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
      preserve_interword_spaces: "1"
    });

    let best = null;

    for (const v of variants) {
      const text = await recognize(worker, v);
      console.log("OCR text:", text);

      const mrz = extractMrzLines(text);
      console.log("Detected MRZ:", mrz);

      if (!mrz) continue;

      const [l1, l2] = mrz;

      try {
        const data = parseMrzTD3(l1, l2);
        const score = scoreFromChecks(data.checks);

        const warnings = [];
        if (score < 3) warnings.push(`mrz_low_confidence_score_${score}`);
        if (!/^[A-Z]{3}$/.test(data.nationality || "")) warnings.push("mrz_nationality_needs_review");

        console.log("Parsed data:", data);
        console.log("Score:", score);
        console.log("Warnings:", warnings);

        if (!best || score > best.score) {
          best = { score, data, l1, l2, warnings };
        }

        if (score === 3) break;
      } catch (err) {
        console.log("Parse error:", err.message);
      }
    }

    return best;
  } finally {
    await worker.terminate();
  }
}