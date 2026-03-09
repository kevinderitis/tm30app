import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { extractMrzLines, parseMrzTD3 } from "./mrz.js";

function scoreFromChecks(checks) {
  return (checks.passportNumberOk ? 1 : 0) + (checks.birthDateOk ? 1 : 0) + (checks.expiryOk ? 1 : 0);
}

async function recognize(worker, buffer) {
  const { data } = await worker.recognize(buffer);
  return (data?.text || "").toUpperCase();
}

export async function readMrzBestEffort(imageInput) {
  const base = await sharp(imageInput)
    .grayscale()
    .normalize()
    .resize({ width: 1800, withoutEnlargement: true })
    .toBuffer();

  const variants = [];
  variants.push(base);
  variants.push(await sharp(base).threshold(160).toBuffer());
  variants.push(await sharp(base).rotate(-2, { background: "#000" }).toBuffer());
  variants.push(await sharp(base).rotate(2, { background: "#000" }).toBuffer());
  variants.push(await sharp(base).sharpen().toBuffer());

  const worker = await createWorker("eng");
  try {
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
      preserve_interword_spaces: "1"
    });

    let best = null;

    for (const v of variants) {
      const text = await recognize(worker, v);
      const mrz = extractMrzLines(text);
      if (!mrz) continue;

      const [l1, l2] = mrz;

      try {
        const data = parseMrzTD3(l1, l2);
        const score = scoreFromChecks(data.checks);

        if (!best || score > best.score) {
          best = { score, data, l1, l2 };
        }
        if (score === 3) break;
      } catch {
        // ignore
      }
    }

    return best;
  } finally {
    await worker.terminate();
  }
}