// import ExcelJS from "exceljs";
// import fs from "node:fs";
// import path from "node:path";

// export async function generateTm30Excel({ rows, outFileXlsx }) {
//   const wb = new ExcelJS.Workbook();
//   const ws = wb.addWorksheet("Inform Accom");

//   ws.columns = [
//     { header: "First Name *", key: "firstName", width: 18 },
//     { header: "Middle Name", key: "middleName", width: 18 },
//     { header: "Last Name", key: "lastName", width: 22 },
//     { header: "Gender *", key: "gender", width: 10 },
//     { header: "Passport No. *", key: "passportNo", width: 18 },
//     { header: "Nationality *", key: "nationality", width: 14 },
//     { header: "Birth Date", key: "birthDate", width: 14 },
//     { header: "Check-out Date", key: "checkOut", width: 16 },
//     { header: "Phone No.", key: "phoneNo", width: 16 }
//   ];

//   ws.getRow(1).font = { bold: true };
//   rows.forEach((r) => ws.addRow(r));

//   fs.mkdirSync(path.dirname(outFileXlsx), { recursive: true });
//   await wb.xlsx.writeFile(outFileXlsx);
// }


import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultTemplate = path.join(
  __dirname,
  "../templates/Template-InformAccom-ImportExcel.xlsx"
);


export async function generateTm30Excel({
  rows,
  outFileXlsx,
  templatePath = defaultTemplate
}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);

  const ws = wb.getWorksheet("แบบแจ้งที่พัก Inform Accom") || wb.worksheets[0];
  if (!ws) {
    throw new Error("No se encontró la hoja del template");
  }

  // limpiar filas viejas desde la fila 2 hacia abajo
  const lastRow = ws.lastRow ? ws.lastRow.number : 1;
  if (lastRow >= 2) {
    for (let i = lastRow; i >= 2; i--) {
      ws.spliceRows(i, 1);
    }
  }

  // insertar filas nuevas respetando el orden exacto del template
  for (const r of rows) {
    ws.addRow([
      r.firstName || "",     // A First Name *
      r.middleName || "",    // B Middle Name
      r.lastName || "",      // C Last Name *
      r.gender || "",        // D Gender *
      r.passportNo || "",    // E Passport No. *
      r.nationality || "",   // F Nationality *
      r.birthDate || "",     // G Birth Date
      r.checkOut || "",      // H Check-out Date
      r.phoneNo || ""        // I Phone No.
    ]);
  }

  // copiar estilo de la fila 2 original del template a todas las filas nuevas
  // asumiendo que el template ya tenía la fila 2 como ejemplo/formato base
  const styleSourceRowNumber = 2;
  const sourceRow = ws.getRow(styleSourceRowNumber);

  for (let rowNumber = 2; rowNumber <= ws.rowCount; rowNumber++) {
    const row = ws.getRow(rowNumber);

    for (let col = 1; col <= 9; col++) {
      const srcCell = sourceRow.getCell(col);
      const dstCell = row.getCell(col);

      if (srcCell.style) {
        dstCell.style = JSON.parse(JSON.stringify(srcCell.style));
      }

      if (srcCell.numFmt) dstCell.numFmt = srcCell.numFmt;
      if (srcCell.alignment) dstCell.alignment = JSON.parse(JSON.stringify(srcCell.alignment));
      if (srcCell.font) dstCell.font = JSON.parse(JSON.stringify(srcCell.font));
      if (srcCell.fill) dstCell.fill = JSON.parse(JSON.stringify(srcCell.fill));
      if (srcCell.border) dstCell.border = JSON.parse(JSON.stringify(srcCell.border));
    }

    row.commit();
  }

  fs.mkdirSync(path.dirname(outFileXlsx), { recursive: true });
  await wb.xlsx.writeFile(outFileXlsx);
}