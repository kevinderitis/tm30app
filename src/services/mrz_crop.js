import sharp from "sharp";

/**
 * Heurística simple: la MRZ suele estar en el tercio inferior del pasaporte.
 * Recorta ~42% inferior, recorta márgenes laterales, y devuelve buffer preprocesado.
 */
export async function cropLikelyMrzRegion(imagePathOrBuffer) {
  const img = sharp(imagePathOrBuffer);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error("No pude leer metadata de imagen");

  const w = meta.width;
  const h = meta.height;

  const top = Math.floor(h * 0.58);          // 42% inferior
  const height = h - top;

  const left = Math.floor(w * 0.05);         // margen 5%
  const width = Math.floor(w * 0.90);

  return await sharp(imagePathOrBuffer)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    .resize({ width: 1800, withoutEnlargement: true })
    .toBuffer();
}
