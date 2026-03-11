import sharp from "sharp";
import { createWorker } from "tesseract.js";

function clean(text) {
    return (text || "")
        .replace(/\r/g, "")
        .replace(/[ \t]+/g, " ")
        .toUpperCase();
}

export async function readPassportNamesFromVisualZone(imagePath) {

    const buffer = await sharp(imagePath)
        .grayscale()
        .normalize()
        .resize({ width: 2000 })
        .toBuffer();

    const worker = await createWorker("eng");

    try {

        const { data } = await worker.recognize(buffer);

        const text = clean(data?.text || "");

        console.log("FULL OCR TEXT:", text);

        return {
            rawText: text,
            firstName: "",
            middleName: "",
            lastName: ""
        };

    } finally {

        await worker.terminate();

    }
}