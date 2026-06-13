import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { readMrzBestEffort } from "../services/ocr_mrz.js";
import { extractPassportDataWithNvidia } from "../services/nvidia_passport.js";
import { Guest } from "../models/Guest.js";
import { Stay } from "../models/Stay.js";
import { generateTm30Excel } from "../services/tm30_excel.js";

const BUSINESS_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Bangkok";
const NATIONALITY_ALIASES = {
  ARG: "ARG",
  ARGENTINA: "ARG",
  ARGENTINE: "ARG",
  ARGENTINIAN: "ARG",
  D: "DEU",
  DE: "DEU",
  GER: "DEU",
  GERMANY: "DEU",
  DEUTSCHLAND: "DEU",
  UK: "GBR",
  GB: "GBR",
  ENG: "GBR",
  UNITEDKINGDOM: "GBR",
  BRITISH: "GBR",
  US: "USA",
  USA: "USA",
  UNITEDSTATES: "USA",
  AMERICAN: "USA",
  UAE: "ARE",
  THAILAND: "THA",
  THAI: "THA"
};

const MONTH_ALIASES = {
  JAN: "01",
  ENE: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  ABR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  AGO: "08",
  SEP: "09",
  SEPT: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
  DIC: "12"
};

function todayIsoDate() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

function getStayAccessFilter(req, extra = {}) {
  return {
    ...extra,
    createdBy: req.user?.id || req.user?._id || null
  };
}

function normalizeNationality(value = "") {
  const normalized = String(value).trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (!normalized) return "";

  if (normalized.length === 3) return normalized;

  return NATIONALITY_ALIASES[normalized] || normalized.slice(0, 3);
}

function normalizeGender(value = "") {
  return value === "male" ? "M" :
    value === "female" ? "F" :
      value === "M" ? "M" :
        value === "F" ? "F" :
          "";
}

function sanitizeTm30NamePart(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizePassportNumber(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function sanitizeGuestNamesForTm30(guest = {}) {
  return {
    ...guest,
    passportNo: sanitizePassportNumber(guest.passportNo),
    firstName: sanitizeTm30NamePart(guest.firstName),
    middleName: sanitizeTm30NamePart(guest.middleName),
    lastName: sanitizeTm30NamePart(guest.lastName)
  };
}

function isThaiNationality(value = "") {
  return normalizeNationality(value) === "THA";
}

function sendThaiNationalityResponse(res) {
  return res.status(422).json({
    error: "Thai nationality does not require TM30 registration.",
    message: "This passport belongs to a Thai national, so it will not be added to TM30.",
    code: "THAI_NATIONALITY"
  });
}

function toDdMmYyyy(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) return "";

  const yyyyMmDdMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyyMmDdMatch) {
    const [, year, month, day] = yyyyMmDdMatch;
    return `${day}/${month}/${year}`;
  }

  return normalized;
}

function buildStayResponse({ stay, guest, checkInDate, warnings = [] }) {
  const sanitizedGuest = sanitizeGuestNamesForTm30(guest);
  const source =
    stay.passportImageMrzPath || stay.passportImageFullPath || stay.mrzLine1 || stay.mrzLine2
      ? "scan"
      : "manual";

  return {
    stayId: String(stay._id),
    guest: {
      guestId: String(sanitizedGuest._id),
      passportNo: sanitizedGuest.passportNo,
      firstName: sanitizedGuest.firstName,
      middleName: sanitizedGuest.middleName,
      lastName: sanitizedGuest.lastName,
      gender: sanitizedGuest.gender,
      nationality: sanitizedGuest.nationality,
      birthDate: sanitizedGuest.birthDateDDMMYYYY
    },
    checkInDate,
    checkOutDate: stay.checkOutDDMMYYYY,
    phoneNo: stay.phoneNo,
    mrzScore: stay.mrzScore || 0,
    warnings,
    source
  };
}

async function findDuplicateStayForGuestOnDate({ req, guestId, checkInDate }) {
  if (!guestId || !checkInDate) return null;

  return Stay.findOne(
    getStayAccessFilter(req, {
      guestId,
      checkInDate
    })
  );
}

function sendDuplicateStayResponse({ res, stay, guest, checkInDate }) {
  return res.status(409).json({
    error: "Registro duplicado",
    message: `This passport is already registered for ${checkInDate}.`,
    code: "DUPLICATE_STAY",
    existingStay: buildStayResponse({ stay, guest, checkInDate })
  });
}

function normalizeBirthDateForForm(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const ddmmyyyyMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmmyyyyMatch) {
    const [, day, month, year] = ddmmyyyyMatch;
    return `${year}-${month}-${day}`;
  }

  const compactSlashMatch = normalized.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (compactSlashMatch) {
    const [, rawDay, rawMonth, rawYear] = compactSlashMatch;
    const day = rawDay.padStart(2, "0");
    const month = rawMonth.padStart(2, "0");
    const year = rawYear.length === 2 ? `${Number(rawYear) >= 30 ? "19" : "20"}${rawYear}` : rawYear;
    return `${year}-${month}-${day}`;
  }

  const textualMonthMatch = normalized
    .toUpperCase()
    .replace(/,/g, "")
    .match(/^(\d{1,2})\s+([A-Z]{3,4})\s+(\d{2,4})$/);
  if (textualMonthMatch) {
    const [, rawDay, rawMonth, rawYear] = textualMonthMatch;
    const month = MONTH_ALIASES[rawMonth];
    if (month) {
      const day = rawDay.padStart(2, "0");
      const year = rawYear.length === 2 ? `${Number(rawYear) >= 30 ? "19" : "20"}${rawYear}` : rawYear;
      return `${year}-${month}-${day}`;
    }
  }

  return "";
}

async function upsertGuestFromExtractedData({
  passportNo,
  firstName,
  middleName,
  lastName,
  gender = "",
  nationality = "",
  birthDateDDMMYYYY = ""
}) {
  let guest = await Guest.findOne({ passportNo });
  const sanitizedFirstName = sanitizeTm30NamePart(firstName);
  const sanitizedMiddleName = sanitizeTm30NamePart(middleName);
  const sanitizedLastName = sanitizeTm30NamePart(lastName);

  if (!guest) {
    guest = await Guest.create({
      passportNo: sanitizePassportNumber(passportNo),
      firstName: sanitizedFirstName,
      middleName: sanitizedMiddleName,
      lastName: sanitizedLastName,
      gender: normalizeGender(gender),
      nationality: normalizeNationality(nationality),
      birthDateDDMMYYYY
    });
  } else {
    guest.passportNo = sanitizePassportNumber(passportNo);
    guest.firstName = sanitizedFirstName;
    guest.middleName = sanitizedMiddleName;
    guest.lastName = sanitizedLastName;
    guest.gender = normalizeGender(gender);
    guest.nationality = normalizeNationality(nationality);
    guest.birthDateDDMMYYYY = birthDateDDMMYYYY;
    await guest.save();
  }

  return guest;
}

export function staysRouter({ uploadDir, exportDir }) {
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
      cb(null, `passport_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = ["image/jpeg", "image/jpg", "image/png"].includes(file.mimetype);
      cb(ok ? null : new Error("Solo JPG/PNG"), ok);
    }
  });
  const scanUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = ["image/jpeg", "image/jpg", "image/png"].includes(file.mimetype);
      cb(ok ? null : new Error("Solo JPG/PNG"), ok);
    }
  });
  const uploadScanImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = file.mimetype.startsWith("image/");
      cb(ok ? null : new Error("Solo imagenes"), ok);
    }
  });

  const router = express.Router();
  router.use(authMiddleware);

  router.post("/mrz/scan", scanUpload.single("passportImageMrz"), async (req, res) => {
    const mrzFile = req.file;

    if (!mrzFile) {
      return res.status(400).json({ error: "Subí passportImageMrz" });
    }

    try {
      const best = await readMrzBestEffort(mrzFile.buffer);

      if (!best) {
        return res.json({
          detected: false,
          guest: null,
          mrzScore: 0,
          warnings: ["mrz_not_detected"]
        });
      }

      const data = best.data;
      const warnings = [...(best.warnings || [])];

      if (
        !data.checks.passportNumberOk ||
        !data.checks.birthDateOk ||
        !data.checks.expiryOk
      ) {
        warnings.push("mrz_low_confidence");
      }

      const fullFirstName = (data.firstName || "").trim();
      const nameParts = fullFirstName.split(/\s+/).filter(Boolean);

      return res.json({
        detected: true,
        guest: {
          passportNo: sanitizePassportNumber(data.passportNo || ""),
          firstName: nameParts[0] || "",
          middleName: data.middleName || nameParts.slice(1).join(" "),
          lastName: data.lastName || "",
          gender:
            data.gender === "male" ? "M" :
              data.gender === "female" ? "F" :
                data.gender === "M" ? "M" :
                  data.gender === "F" ? "F" :
                    "",
          nationality: normalizeNationality(data.nationality),
          birthDate: data.birthDateDDMMYYYY || ""
        },
        mrzScore: best.score,
        warnings,
        mrzLines: {
          line1: best.l1,
          line2: best.l2
        }
      });
    } catch (e) {
      return res.status(500).json({
        error: "Error procesando MRZ",
        details: e.message
      });
    }
  });

  router.post("/stays/manual", async (req, res) => {
    const schema = z.object({
      checkOutDate: z.string().min(8),
      checkInDate: z.string().optional(),
      phoneNo: z.string().optional(),
      status: z.enum(["draft", "confirmed", "exported"]).optional(),
      guest: z.object({
        firstName: z.string().min(1),
        middleName: z.string().optional(),
        lastName: z.string().min(1),
        gender: z.enum(["M", "F"]),
        passportNo: z.string().min(1),
        nationality: z.string().min(1).max(3),
        birthDate: z.string().min(1)
      })
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
    }

    try {
      const { guest: guestPayload, checkOutDate, phoneNo, checkInDate: requestedCheckInDate, status } = parsed.data;
      const passportNo = sanitizePassportNumber(guestPayload.passportNo);
      const normalizedNationality = normalizeNationality(guestPayload.nationality);
      if (isThaiNationality(normalizedNationality)) {
        return sendThaiNationalityResponse(res);
      }
      const birthDateDDMMYYYY = toDdMmYyyy(guestPayload.birthDate);
      const sanitizedFirstName = sanitizeTm30NamePart(guestPayload.firstName);
      const sanitizedMiddleName = sanitizeTm30NamePart(guestPayload.middleName);
      const sanitizedLastName = sanitizeTm30NamePart(guestPayload.lastName);

      let guest = await Guest.findOne({ passportNo });
      if (!guest) {
        guest = await Guest.create({
          passportNo,
          firstName: sanitizedFirstName,
          middleName: sanitizedMiddleName,
          lastName: sanitizedLastName,
          gender: guestPayload.gender,
          nationality: normalizedNationality,
          birthDateDDMMYYYY
        });
      } else {
        guest.firstName = sanitizedFirstName;
        guest.middleName = sanitizedMiddleName;
        guest.lastName = sanitizedLastName;
        guest.gender = normalizeGender(guestPayload.gender);
        guest.nationality = normalizedNationality;
        guest.birthDateDDMMYYYY = birthDateDDMMYYYY;
        await guest.save();
      }

      const checkInDate = requestedCheckInDate || todayIsoDate();

      const duplicateStay = await findDuplicateStayForGuestOnDate({
        req,
        guestId: guest._id,
        checkInDate
      });
      if (duplicateStay) {
        return sendDuplicateStayResponse({
          res,
          stay: duplicateStay,
          guest,
          checkInDate
        });
      }

      const stay = await Stay.create({
        guestId: guest._id,
        checkInDate,
        checkOutDDMMYYYY: checkOutDate,
        phoneNo: phoneNo || "",
        passportImageMrzPath: "",
        passportImageFullPath: "",
        mrzScore: 0,
        mrzLine1: "",
        mrzLine2: "",
        status: status || "confirmed",
        createdBy: req.user?.id || req.user?._id || null
      });

      res.status(201).json(buildStayResponse({ stay, guest, checkInDate }));
    } catch (e) {
      res.status(500).json({ error: "Error creando stay manual", details: e.message });
    }
  });

  router.post("/stays/upload-image", uploadScanImage.single("passportImage"), async (req, res) => {
    const schema = z.object({
      checkOutDate: z.string().min(8),
      phoneNo: z.string().optional(),
      checkInDate: z.string().optional()
    });

    console.log("[UPLOAD_IMAGE] Incoming request body", req.body);

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      console.error("[UPLOAD_IMAGE] Invalid body", parsed.error.flatten());
      return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
    }

    if (!req.file) {
      console.error("[UPLOAD_IMAGE] Missing passportImage file");
      return res.status(400).json({ error: "Subí passportImage" });
    }

    console.log("[UPLOAD_IMAGE] File received", {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });

    try {
      const extraction = await extractPassportDataWithNvidia(req.file);
      console.log("[UPLOAD_IMAGE] Extraction raw result", extraction.data);
      const passportNo = sanitizePassportNumber(extraction.data.passportNumber || "");
      const firstName = String(extraction.data.name || "").trim();
      const middleName = String(extraction.data.middleName || "").trim();
      const lastName = String(extraction.data.lastName || "").trim();
      const gender = normalizeGender(extraction.data.gender);
      const nationality = normalizeNationality(extraction.data.nationality);
      if (isThaiNationality(nationality)) {
        console.warn("[UPLOAD_IMAGE] Thai passport skipped", {
          passportNo,
          nationality,
        });
        return sendThaiNationalityResponse(res);
      }

      console.log("[UPLOAD_IMAGE] Normalized identity fields", {
        passportNo,
        firstName,
        middleName,
        lastName,
        gender,
        nationality,
        birthday: extraction.data.birthday,
      });

      if (!passportNo || !firstName) {
        console.error("[UPLOAD_IMAGE] Missing minimum extracted fields", extraction.data);
        return res.status(422).json({
          error: "No se pudieron extraer suficientes datos del pasaporte.",
          details: extraction.data
        });
      }

      const birthDateForForm = normalizeBirthDateForForm(extraction.data.birthday);
      const birthDateDDMMYYYY = toDdMmYyyy(birthDateForForm || extraction.data.birthday);
      console.log("[UPLOAD_IMAGE] Birth date normalization", {
        original: extraction.data.birthday,
        birthDateForForm,
        birthDateDDMMYYYY,
      });
      const guest = await upsertGuestFromExtractedData({
        passportNo,
        firstName,
        middleName,
        lastName,
        gender,
        nationality,
        birthDateDDMMYYYY
      });

      console.log("[UPLOAD_IMAGE] Guest upserted", {
        guestId: String(guest._id),
        passportNo: guest.passportNo,
        nationality: guest.nationality,
        birthDateDDMMYYYY: guest.birthDateDDMMYYYY,
      });

      const checkInDate = parsed.data.checkInDate || todayIsoDate();
      const duplicateStay = await findDuplicateStayForGuestOnDate({
        req,
        guestId: guest._id,
        checkInDate
      });
      if (duplicateStay) {
        console.warn("[UPLOAD_IMAGE] Duplicate stay detected", {
          guestId: String(guest._id),
          stayId: String(duplicateStay._id),
          checkInDate,
        });
        return sendDuplicateStayResponse({
          res,
          stay: duplicateStay,
          guest,
          checkInDate
        });
      }

      const stay = await Stay.create({
        guestId: guest._id,
        checkInDate,
        checkOutDDMMYYYY: parsed.data.checkOutDate,
        phoneNo: parsed.data.phoneNo || "",
        passportImageMrzPath: "",
        passportImageFullPath: "",
        mrzScore: 0,
        mrzLine1: "",
        mrzLine2: "",
        status: "confirmed",
        createdBy: req.user?.id || req.user?._id || null
      });

      console.log("[UPLOAD_IMAGE] Stay created", {
        stayId: String(stay._id),
        checkInDate,
        checkOutDate: parsed.data.checkOutDate,
        createdBy: req.user?.id || req.user?._id || null,
      });

      return res.status(201).json({
        ...buildStayResponse({
          stay,
          guest,
          checkInDate,
          warnings: ["Extracted from uploaded passport image"]
        }),
        source: "upload",
        guest: {
          guestId: String(guest._id),
          passportNo: guest.passportNo,
          firstName: guest.firstName,
          middleName: guest.middleName,
          lastName: guest.lastName,
          gender: guest.gender,
          nationality: guest.nationality,
          birthDate: birthDateForForm,
          birthDateDDMMYYYY: guest.birthDateDDMMYYYY
        }
      });
    } catch (e) {
      console.error("[UPLOAD_IMAGE] Failed", {
        message: e.message,
        stack: e.stack,
      });
      return res.status(500).json({
        error: "Error procesando imagen subida",
        details: e.message
      });
    }
  });

  router.post(
    "/stays",
    upload.fields([
      { name: "passportImageMrz", maxCount: 1 },
      { name: "passportImageFull", maxCount: 1 }
    ]),
    async (req, res) => {
      const schema = z.object({
        checkOutDate: z.string().min(8),
        phoneNo: z.string().optional(),
        checkInDate: z.string().optional()
      });

      console.log("Received /stays POST with body:", req.body);

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
      }

      const mrzFile = req.files?.passportImageMrz?.[0];
      const fullFile = req.files?.passportImageFull?.[0];

      if (!mrzFile && !fullFile) {
        return res.status(400).json({ error: "Subí passportImageMrz o passportImageFull" });
      }

      const mrzPath = mrzFile?.path || "";
      const fullPath = fullFile?.path || "";

      try {
        const inputForMrz = mrzPath || fullPath;

        console.log("Processing image for MRZ:", inputForMrz);

        const best = await readMrzBestEffort(inputForMrz);

        console.log("MRZ path:", mrzPath);
        console.log("Full image path:", fullPath);
        console.log("MRZ best effort result:", best);

        if (!best) {
          return res.status(422).json({
            error: "No se detectó MRZ. Pedí otra foto (MRZ completa, sin reflejos).",
            mrzImage: mrzFile ? path.basename(mrzPath) : null,
            fullImage: fullFile ? path.basename(fullPath) : null
          });
        }

        const data = best.data;
        const warnings = [...(best.warnings || [])];

        if (
          !data.checks.passportNumberOk ||
          !data.checks.birthDateOk ||
          !data.checks.expiryOk
        ) {
          warnings.push("mrz_low_confidence");
        }

        const passportNo = sanitizePassportNumber(data.passportNo || "");

        const normalizedGender = normalizeGender(data.gender);

        const fullFirstName = (data.firstName || "").trim();
        const nameParts = fullFirstName.split(/\s+/).filter(Boolean);
        const normalizedFirstName = nameParts[0] || "";
        const normalizedMiddleName = data.middleName || nameParts.slice(1).join(" ");
        const normalizedNationality = normalizeNationality(data.nationality);
        if (isThaiNationality(normalizedNationality)) {
          return sendThaiNationalityResponse(res);
        }

        let guest = await Guest.findOne({ passportNo });
        if (!guest) {
          guest = await Guest.create({
            passportNo,
            firstName: normalizedFirstName,
            middleName: normalizedMiddleName,
            lastName: data.lastName || "",
            gender: normalizedGender,
            nationality: normalizedNationality,
            birthDateDDMMYYYY: data.birthDateDDMMYYYY || ""
          });
        }
        else {
          guest.passportNo = sanitizePassportNumber(passportNo);
          guest.firstName = sanitizeTm30NamePart(normalizedFirstName);
          guest.middleName = sanitizeTm30NamePart(normalizedMiddleName);
          guest.lastName = sanitizeTm30NamePart(data.lastName || "");
          guest.gender = normalizedGender;
          guest.nationality = normalizedNationality;
          guest.birthDateDDMMYYYY = data.birthDateDDMMYYYY || "";
          await guest.save();
        }

        const checkInDate = parsed.data.checkInDate || todayIsoDate();
        const duplicateStay = await findDuplicateStayForGuestOnDate({
          req,
          guestId: guest._id,
          checkInDate
        });
        if (duplicateStay) {
          return sendDuplicateStayResponse({
            res,
            stay: duplicateStay,
            guest,
            checkInDate
          });
        }

        console.log("Stay created by:", req.user?.id || req.user?._id || null);

        const stay = await Stay.create({
          guestId: guest._id,
          checkInDate,
          checkOutDDMMYYYY: parsed.data.checkOutDate,
          passportImageMrzPath: mrzPath,
          passportImageFullPath: fullPath,
          mrzScore: best.score,
          mrzLine1: best.l1,
          mrzLine2: best.l2,
          status: "draft",
          createdBy: req.user?.id || req.user?._id || null
        });

        res.status(201).json(buildStayResponse({ stay, guest, checkInDate, warnings }));
      } catch (e) {
        res.status(500).json({ error: "Error procesando imagen", details: e.message });
      }
    }
  );


  router.get("/stays", async (req, res) => {
    try {
      console.log("Query params stays:", req.query);

      const date = String(req.query.date || todayIsoDate());

      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

      if (!dateRegex.test(date)) {
        return res.status(400).json({
          error: "Formato de fecha inválido. Debe ser YYYY-MM-DD"
        });
      }

      console.log("Searching stays for date:", date, typeof date);

      const stays = await Stay.find(getStayAccessFilter(req, { checkInDate: date }))
        .sort({ createdAt: -1 })
        .populate("guestId")
        .lean();

      console.log(`Found ${stays.length} stays for date ${date}`);

      if (!stays || stays.length === 0) {
        return res.json({
          date,
          stays: []
        });
      }

      const formatted = stays.map((s) => {
        const guest = s.guestId || {};

        return {
          id: String(s._id),
          status: s.status,
          checkInDate: s.checkInDate,
          checkOutDate: s.checkOutDDMMYYYY,
          phoneNo: s.phoneNo,
          mrzScore: s.mrzScore || 0,
          source: s.passportImageMrzPath || s.passportImageFullPath || s.mrzLine1 || s.mrzLine2 ? "scan" : "manual",
          guest: guest._id
            ? {
              id: String(guest._id),
              passportNo: sanitizePassportNumber(guest.passportNo),
              firstName: guest.firstName,
              middleName: guest.middleName,
              lastName: guest.lastName,
              gender: guest.gender,
              nationality: guest.nationality,
              birthDate: guest.birthDateDDMMYYYY
            }
            : null
        };
      });

      console.log(`Found ${formatted.length} stays for date ${date}`);

      res.json({
        date,
        stays: formatted
      });

    } catch (error) {
      console.error("Error en /stays:", error);

      res.status(500).json({
        error: "Error interno del servidor"
      });
    }
  });

  router.patch("/stays/:id", async (req, res) => {
    try {
      const schema = z.object({
        status: z.enum(["draft", "confirmed", "exported"]).optional(),
        checkOutDate: z.string().min(8).optional(),
        phoneNo: z.string().optional(),
        firstName: z.string().min(1).optional(),
        middleName: z.string().optional(),
        lastName: z.string().optional(),
        gender: z.enum(["M", "F"]).optional(),
        nationality: z.string().length(3).optional(),
        birthDate: z.string().optional(),
        guest: z.object({
          firstName: z.string().min(1).optional(),
          middleName: z.string().optional(),
          lastName: z.string().optional(),
          gender: z.enum(["M", "F"]).optional(),
          nationality: z.string().length(3).optional(),
          birthDate: z.string().optional()
        }).optional()
      });

      console.log("PATCH /stays/:id body:", req.body);
      console.log("PATCH /stays/:id params:", req.params);

      const parsed = schema.safeParse(req.body);

      if (!parsed.success) {
        console.error("PATCH validation error:", parsed.error.flatten());
        return res.status(400).json({
          error: "Body inválido",
          details: parsed.error.flatten()
        });
      }

      const stay = await Stay.findOne(getStayAccessFilter(req, { _id: req.params.id }));

      if (!stay) {
        console.error("Stay not found:", req.params.id);
        return res.status(404).json({ error: "Stay no encontrado" });
      }

      // update stay
      const guestPayload = parsed.data.guest || {};

      if (parsed.data.status) stay.status = parsed.data.status;
      if (parsed.data.checkOutDate) stay.checkOutDDMMYYYY = parsed.data.checkOutDate;
      if (parsed.data.phoneNo !== undefined) stay.phoneNo = parsed.data.phoneNo || "";

      await stay.save();

      // update guest
      const guestUpdate = {};

      const firstName = parsed.data.firstName ?? guestPayload.firstName;
      const middleName = parsed.data.middleName ?? guestPayload.middleName;
      const lastName = parsed.data.lastName ?? guestPayload.lastName;
      const gender = parsed.data.gender ?? guestPayload.gender;
      const nationality = parsed.data.nationality ?? guestPayload.nationality;
      const birthDate = parsed.data.birthDate ?? guestPayload.birthDate;

      if (nationality && isThaiNationality(nationality)) {
        return sendThaiNationalityResponse(res);
      }

      if (firstName) guestUpdate.firstName = sanitizeTm30NamePart(firstName);
      if (middleName !== undefined) guestUpdate.middleName = sanitizeTm30NamePart(middleName || "");
      if (lastName !== undefined) guestUpdate.lastName = sanitizeTm30NamePart(lastName || "");
      if (gender) guestUpdate.gender = gender;
      if (nationality) guestUpdate.nationality = normalizeNationality(nationality);
      if (birthDate !== undefined) guestUpdate.birthDateDDMMYYYY = birthDate || "";

      if (Object.keys(guestUpdate).length) {
        console.log("Updating guest:", stay.guestId, guestUpdate);
        await Guest.findByIdAndUpdate(stay.guestId, guestUpdate);
      }

      console.log("Stay updated successfully:", stay._id);

      res.json({ ok: true });

    } catch (error) {
      console.error("PATCH /stays/:id error:", error);

      res.status(500).json({
        error: "Error interno actualizando stay",
        message: error.message
      });
    }
  });

  router.delete("/stays/:id", async (req, res) => {
    try {
      const stay = await Stay.findOneAndDelete(getStayAccessFilter(req, { _id: req.params.id }));

      if (!stay) {
        return res.status(404).json({ error: "Stay no encontrado" });
      }

      res.json({ ok: true });
    } catch (error) {
      console.error("DELETE /stays/:id error:", error);

      res.status(500).json({
        error: "Error interno eliminando stay",
        message: error.message
      });
    }
  });
  
  router.get("/export/tm30", async (req, res) => {
    const date = String(req.query.date || todayIsoDate());

    const accessFilter = getStayAccessFilter(req, {
      checkInDate: date,
      status: "confirmed"
    });

    const stays = await Stay.find(accessFilter)
      .sort({ createdAt: 1 })
      .populate("guestId")
      .lean();

    if (!stays.length) {
      return res.status(404).json({
        error: "No hay registros confirmados para ese día"
      });
    }

    const exportableStays = stays.filter((s) => !isThaiNationality(s.guestId?.nationality || ""));
    if (!exportableStays.length) {
      return res.status(400).json({
        error: "No hay registros exportables para ese día.",
        message: "Thai nationals are excluded from TM30 export."
      });
    }

    const missing = exportableStays.filter((s) => !s.checkOutDDMMYYYY);
    if (missing.length) {
      return res.status(400).json({
        error: "Hay stays sin Check-out Date (requerido por template).",
        stayIds: missing.map((s) => String(s._id))
      });
    }

    const fileBase = `TM30_InformAccom_${date.replaceAll("-", "")}`;
    const outXlsx = path.join(exportDir, `${fileBase}.xlsx`);

    await generateTm30Excel({
      outFileXlsx: outXlsx,
      rows: exportableStays.map((s) => ({
        firstName: sanitizeTm30NamePart(s.guestId.firstName || ""),
        middleName: sanitizeTm30NamePart(s.guestId.middleName || ""),
        lastName: sanitizeTm30NamePart(s.guestId.lastName || ""),
        gender: s.guestId.gender || "",
        passportNo: sanitizePassportNumber(s.guestId.passportNo || ""),
        nationality: s.guestId.nationality || "",
        birthDate: s.guestId.birthDateDDMMYYYY || "",
        checkOut: s.checkOutDDMMYYYY || "",
        phoneNo: s.phoneNo || ""
      }))
    });

    await Stay.updateMany(accessFilter, { $set: { status: "exported" } });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(outXlsx)}"`);
    return res.sendFile(path.resolve(outXlsx));
  });

  return router;
}
