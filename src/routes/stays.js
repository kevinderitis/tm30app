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

function todayIsoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
        const warnings = [];
        if (
          !best.data.checks.passportNumberOk ||
          !best.data.checks.birthDateOk ||
          !best.data.checks.expiryOk
        ) {
          warnings.push("mrz_low_confidence");
        }

        const passportNo = data.passportNo.trim();

        let guest = await Guest.findOne({ passportNo });
        if (!guest) {
          guest = await Guest.create({
            passportNo,
            firstName: data.firstName,
            middleName: data.middleName || "",
            lastName: data.lastName || "",
            gender: data.gender || "",
            nationality: data.nationality || "",
            birthDateDDMMYYYY: data.birthDateDDMMYYYY || ""
          });
        }

        const checkInDate = parsed.data.checkInDate || todayIsoDate();

        const stay = await Stay.create({
          guestId: guest._id,
          checkInDate,
          checkOutDDMMYYYY: parsed.data.checkOutDate,
          phoneNo: parsed.data.phoneNo || "",
          passportImageMrzPath: mrzPath,
          passportImageFullPath: fullPath,
          mrzScore: best.score,
          mrzLine1: best.l1,
          mrzLine2: best.l2,
          status: "draft",
          createdBy: req.session.user.id
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

      const stays = await Stay.find({ checkInDate: date })
        .sort({ createdAt: -1 })
        .populate("guestId")
        .lean();

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
    const schema = z.object({
      status: z.enum(["draft", "confirmed"]).optional(),
      checkOutDate: z.string().min(8).optional(),
      phoneNo: z.string().optional(),

      firstName: z.string().min(1).optional(),
      middleName: z.string().optional(),
      lastName: z.string().optional(),
      gender: z.enum(["M", "F"]).optional(),
      nationality: z.string().length(3).optional(),
      birthDate: z.string().optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });

    const stay = await Stay.findById(req.params.id);
    if (!stay) return res.status(404).json({ error: "Stay no encontrado" });

    if (parsed.data.status) stay.status = parsed.data.status;
    if (parsed.data.checkOutDate) stay.checkOutDDMMYYYY = parsed.data.checkOutDate;
    if (parsed.data.phoneNo !== undefined) stay.phoneNo = parsed.data.phoneNo || "";
    await stay.save();

    const guestUpdate = {};
    if (parsed.data.firstName) guestUpdate.firstName = parsed.data.firstName;
    if (parsed.data.middleName !== undefined) guestUpdate.middleName = parsed.data.middleName || "";
    if (parsed.data.lastName !== undefined) guestUpdate.lastName = parsed.data.lastName || "";
    if (parsed.data.gender) guestUpdate.gender = parsed.data.gender;
    if (parsed.data.nationality) guestUpdate.nationality = parsed.data.nationality.toUpperCase();
    if (parsed.data.birthDate !== undefined) guestUpdate.birthDateDDMMYYYY = parsed.data.birthDate || "";

    if (Object.keys(guestUpdate).length) {
      await Guest.findByIdAndUpdate(stay.guestId, guestUpdate);
    }

    res.json({ ok: true });
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
