function charValue(c) {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 55;
  if (c === "<") return 0;
  return 0;
}

function checkDigit(data) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += charValue(data[i]) * weights[i % 3];
  return String(sum % 10);
}

function fmtDDMMYYYYFromMrzRaw(rawYYMMDD) {
  if (!/^\d{6}$/.test(rawYYMMDD)) return "";
  const yy = Number(rawYYMMDD.slice(0, 2));
  const mm = Number(rawYYMMDD.slice(2, 4));
  const dd = Number(rawYYMMDD.slice(4, 6));

  const now = new Date();
  const currentYY = now.getFullYear() % 100;
  const century = yy > currentYY ? 1900 : 2000;
  const yyyy = century + yy;

  return `${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}/${yyyy}`;
}

export function extractMrzLines(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim().toUpperCase())
    .filter(Boolean)
    .map((l) => l.replace(/\s/g, ""));

  const candidates = lines.filter((l) => l.length >= 35 && l.includes("<"));

  for (let i = 0; i < candidates.length - 1; i++) {
    const a = candidates[i];
    const b = candidates[i + 1];
    if (Math.abs(a.length - 44) <= 2 && Math.abs(b.length - 44) <= 2) {
      return [a.padEnd(44, "<").slice(0, 44), b.padEnd(44, "<").slice(0, 44)];
    }
  }

  const scored = candidates
    .map((l) => ({
      line: l,
      score: (l.match(/</g) || []).length * 2 + (44 - Math.abs(l.length - 44))
    }))
    .sort((x, y) => y.score - x.score);

  if (scored.length >= 2) {
    return [
      scored[0].line.padEnd(44, "<").slice(0, 44),
      scored[1].line.padEnd(44, "<").slice(0, 44)
    ];
  }

  return null;
}

export function parseMrzTD3(line1, line2) {
  if (!line1 || !line2 || line1.length !== 44 || line2.length !== 44) {
    throw new Error("MRZ inválida (TD3 2x44).");
  }

  const namesRaw = line1.slice(5).replace(/<+$/g, "");
  const [surnameRaw, givenRaw = ""] = namesRaw.split("<<");
  const lastName = surnameRaw.replace(/</g, " ").trim();
  const givenNames = givenRaw.replace(/</g, " ").trim();

  const parts = givenNames.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || "";
  const middleName = parts.slice(1).join(" ");

  const passportNumberRaw = line2.slice(0, 9);
  const passportNo = passportNumberRaw.replace(/</g, "");
  const passportCD = line2.slice(9, 10);

  const nationality = line2.slice(10, 13);

  const birthRaw = line2.slice(13, 19);
  const birthCD = line2.slice(19, 20);

  const sex = line2.slice(20, 21);

  const expiryRaw = line2.slice(21, 27);
  const expiryCD = line2.slice(27, 28);

  const checks = {
    passportNumberOk: checkDigit(passportNumberRaw) === passportCD,
    birthDateOk: checkDigit(birthRaw) === birthCD,
    expiryOk: checkDigit(expiryRaw) === expiryCD
  };

  return {
    firstName,
    middleName,
    lastName,
    gender: sex === "<" ? "" : sex,
    passportNo,
    nationality,
    birthDateDDMMYYYY: fmtDDMMYYYYFromMrzRaw(birthRaw),
    checks
  };
}
