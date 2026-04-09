import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { readMrzBestEffort } from "../services/ocr_mrz.js";
import { Guest } from "../models/Guest.js";
import { Stay } from "../models/Stay.js";
import { generateTm30Excel } from "../services/tm30_excel.js";

const BUSINESS_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Bangkok";

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

  const router = express.Router();
  router.use(authMiddleware);

  router.post("/mrz/scan", upload.single("passportImageMrz"), async (req, res) => {
    const mrzFile = req.file;

    if (!mrzFile) {
      return res.status(400).json({ error: "Subí passportImageMrz" });
    }

    try {
      const best = await readMrzBestEffort(mrzFile.path);

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
          passportNo: (data.passportNo || "").trim(),
          firstName: nameParts[0] || "",
          middleName: data.middleName || nameParts.slice(1).join(" "),
          lastName: data.lastName || "",
          gender:
            data.gender === "male" ? "M" :
              data.gender === "female" ? "F" :
                data.gender === "M" ? "M" :
                  data.gender === "F" ? "F" :
                    "",
          nationality: data.nationality || "",
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

        const passportNo = (data.passportNo || "").trim();

        const normalizedGender =
          data.gender === "male" ? "M" :
            data.gender === "female" ? "F" :
              data.gender === "M" ? "M" :
                data.gender === "F" ? "F" :
                  "";

        const fullFirstName = (data.firstName || "").trim();
        const nameParts = fullFirstName.split(/\s+/).filter(Boolean);
        const normalizedFirstName = nameParts[0] || "";
        const normalizedMiddleName = data.middleName || nameParts.slice(1).join(" ");

        let guest = await Guest.findOne({ passportNo });
        if (!guest) {
          guest = await Guest.create({
            passportNo,
            firstName: normalizedFirstName,
            middleName: normalizedMiddleName,
            lastName: data.lastName || "",
            gender: normalizedGender,
            nationality: data.nationality || "",
            birthDateDDMMYYYY: data.birthDateDDMMYYYY || ""
          });
        }

        const checkInDate = parsed.data.checkInDate || todayIsoDate();

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

        res.status(201).json({
          stayId: String(stay._id),
          guest: {
            guestId: String(guest._id),
            passportNo: guest.passportNo,
            firstName: guest.firstName,
            middleName: guest.middleName,
            lastName: guest.lastName,
            gender: guest.gender,
            nationality: guest.nationality,
            birthDate: guest.birthDateDDMMYYYY
          },
          checkInDate,
          checkOutDate: stay.checkOutDDMMYYYY,
          phoneNo: stay.phoneNo,
          mrzScore: best.score,
          warnings
        });
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

      const stays = await Stay.find({ checkInDate: date })
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
          guest: guest._id
            ? {
              id: String(guest._id),
              passportNo: guest.passportNo,
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
        status: z.enum(["draft", "confirmed"]).optional(),
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

      const stay = await Stay.findById(req.params.id);

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

      if (firstName) guestUpdate.firstName = firstName;
      if (middleName !== undefined) guestUpdate.middleName = middleName || "";
      if (lastName !== undefined) guestUpdate.lastName = lastName || "";
      if (gender) guestUpdate.gender = gender;
      if (nationality) guestUpdate.nationality = nationality.toUpperCase();
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
  
  router.get("/export/tm30", async (req, res) => {
    const date = String(req.query.date || todayIsoDate());

    const stays = await Stay.find({ checkInDate: date })
      .sort({ createdAt: 1 })
      .populate("guestId")
      .lean();

    if (!stays.length) return res.status(404).json({ error: "No hay stays para ese día" });

    const missing = stays.filter((s) => !s.checkOutDDMMYYYY);
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
      rows: stays.map((s) => ({
        firstName: s.guestId.firstName || "",
        middleName: s.guestId.middleName || "",
        lastName: s.guestId.lastName || "",
        gender: s.guestId.gender || "",
        passportNo: s.guestId.passportNo || "",
        nationality: s.guestId.nationality || "",
        birthDate: s.guestId.birthDateDDMMYYYY || "",
        checkOut: s.checkOutDDMMYYYY || "",
        phoneNo: s.phoneNo || ""
      }))
    });

    await Stay.updateMany({ checkInDate: date }, { $set: { status: "exported" } });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(outXlsx)}"`);
    return res.sendFile(path.resolve(outXlsx));
  });

  return router;
}
