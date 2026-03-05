import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";

export async function generateTm30Excel({ rows, outFileXlsx }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Inform Accom");

  ws.columns = [
    { header: "First Name *", key: "firstName", width: 18 },
    { header: "Middle Name", key: "middleName", width: 18 },
    { header: "Last Name", key: "lastName", width: 22 },
    { header: "Gender *", key: "gender", width: 10 },
    { header: "Passport No. *", key: "passportNo", width: 18 },
    { header: "Nationality *", key: "nationality", width: 14 },
    { header: "Birth Date", key: "birthDate", width: 14 },
    { header: "Check-out Date", key: "checkOut", width: 16 },
    { header: "Phone No.", key: "phoneNo", width: 16 }
  ];

  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));

  fs.mkdirSync(path.dirname(outFileXlsx), { recursive: true });
  await wb.xlsx.writeFile(outFileXlsx);
}
