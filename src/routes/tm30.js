import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import express from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { Stay } from "../models/Stay.js";
import { Tm30Task, TM30_TASK_STATUSES } from "../models/Tm30Task.js";
import { generateTm30Excel } from "../services/tm30_excel.js";
import { config } from "../config.js";

const TASK_TOKEN_HEADER = "x-tm30-task-token";
const TASK_TOKEN_TTL_SECONDS = 60 * 30;
const TASK_DOWNLOAD_PURPOSE = "tm30-task";
const TASK_STATUSES = new Set(TM30_TASK_STATUSES);

function getTaskTokenSecret() {
  return process.env.JWT_SECRET || process.env.SESSION_SECRET;
}

function getRequestBaseUrl(req) {
  if (config.publicBaseUrl) {
    return String(config.publicBaseUrl).replace(/\/$/, "");
  }

  const forwardedProtoHeader = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProtoHeader || req.protocol || "https";
  return `${protocol}://${req.get("host")}`;
}

function signTaskToken(task) {
  return jwt.sign(
    {
      sub: String(task._id),
      nonce: task.tokenNonce,
      purpose: TASK_DOWNLOAD_PURPOSE
    },
    getTaskTokenSecret(),
    { expiresIn: TASK_TOKEN_TTL_SECONDS }
  );
}

function verifyTaskToken(rawToken, task) {
  if (!rawToken) {
    throw new Error("Falta token temporal");
  }

  const decoded = jwt.verify(rawToken, getTaskTokenSecret());

  if (
    decoded.sub !== String(task._id) ||
    decoded.nonce !== task.tokenNonce ||
    decoded.purpose !== TASK_DOWNLOAD_PURPOSE
  ) {
    throw new Error("Token temporal inválido");
  }
}

function toTaskResponse(task) {
  return {
    id: String(task._id),
    taskId: String(task._id),
    date: task.checkInDate,
    status: task.status,
    message: task.message || "",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function resolveOwnedTask(req, taskId) {
  return Tm30Task.findOne({
    _id: taskId,
    userId: req.user?.id || req.user?._id || null
  });
}

export function tm30Router({ exportDir, extensionZipPath }) {
  fs.mkdirSync(exportDir, { recursive: true });

  const router = express.Router();

  router.post("/tasks", authMiddleware, async (req, res) => {
    const schema = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
    }

    const date = parsed.data.date;
    const userId = req.user?.id || req.user?._id || null;

    const stays = await Stay.find({
      createdBy: userId,
      checkInDate: date,
      status: "confirmed"
    })
      .sort({ createdAt: 1 })
      .populate("guestId")
      .lean();

    if (!stays.length) {
      return res.status(400).json({
        error: "No hay registros confirmados para automatizar en esta fecha"
      });
    }

    const missingCheckOut = stays.filter((stay) => !stay.checkOutDDMMYYYY);
    if (missingCheckOut.length) {
      return res.status(400).json({
        error: "Hay registros sin Check-out Date",
        stayIds: missingCheckOut.map((stay) => String(stay._id))
      });
    }

    const fileBase = `TM30_AutoUpload_${date.replaceAll("-", "")}_${Date.now()}`;
    const outXlsx = path.join(exportDir, `${fileBase}.xlsx`);

    await generateTm30Excel({
      outFileXlsx: outXlsx,
      rows: stays.map((stay) => ({
        firstName: stay.guestId?.firstName || "",
        middleName: stay.guestId?.middleName || "",
        lastName: stay.guestId?.lastName || "",
        gender: stay.guestId?.gender || "",
        passportNo: stay.guestId?.passportNo || "",
        nationality: stay.guestId?.nationality || "",
        birthDate: stay.guestId?.birthDateDDMMYYYY || "",
        checkOut: stay.checkOutDDMMYYYY || "",
        phoneNo: stay.phoneNo || ""
      }))
    });

    const task = await Tm30Task.create({
      userId,
      checkInDate: date,
      stayIds: stays.map((stay) => stay._id),
      status: "STARTING",
      message: "Task created. Waiting for extension.",
      excelFileName: path.basename(outXlsx),
      excelFilePath: outXlsx,
      tokenNonce: crypto.randomBytes(16).toString("hex")
    });

    const token = signTaskToken(task);
    const excelUrl = `${getRequestBaseUrl(req)}/api/tm30/tasks/${task._id}/excel?token=${encodeURIComponent(token)}`;

    return res.status(201).json({
      taskId: String(task._id),
      excelUrl,
      token
    });
  });

  router.get("/tasks/:taskId", authMiddleware, async (req, res) => {
    const task = await resolveOwnedTask(req, req.params.taskId);

    if (!task) {
      return res.status(404).json({ error: "Task no encontrado" });
    }

    return res.json({ task: toTaskResponse(task) });
  });

  router.get("/tasks/:taskId/excel", async (req, res) => {
    const task = await Tm30Task.findById(req.params.taskId);

    if (!task) {
      return res.status(404).json({ error: "Task no encontrado" });
    }

    try {
      verifyTaskToken(String(req.query.token || req.headers[TASK_TOKEN_HEADER] || ""), task);
    } catch (error) {
      return res.status(401).json({ error: error.message });
    }

    if (!fs.existsSync(task.excelFilePath)) {
      return res.status(404).json({ error: "Excel no encontrado" });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${task.excelFileName}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(path.resolve(task.excelFilePath));
  });

  router.post("/tasks/:taskId/status", async (req, res) => {
    const schema = z.object({
      status: z.enum(TM30_TASK_STATUSES),
      message: z.string().optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
    }

    const task = await Tm30Task.findById(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: "Task no encontrado" });
    }

    try {
      verifyTaskToken(String(req.headers[TASK_TOKEN_HEADER] || req.query.token || ""), task);
    } catch (error) {
      return res.status(401).json({ error: error.message });
    }

    task.status = parsed.data.status;
    task.message = parsed.data.message || "";
    await task.save();

    if (task.status === "SUCCESS") {
      await Stay.updateMany(
        {
          _id: { $in: task.stayIds },
          createdBy: task.userId,
          status: "confirmed"
        },
        { $set: { status: "exported" } }
      );
    }

    return res.json({ ok: true, task: toTaskResponse(task) });
  });

  router.get("/extension/download", authMiddleware, async (req, res) => {
    if (!fs.existsSync(extensionZipPath)) {
      return res.status(404).json({ error: "Extensión no disponible" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="tm30-extension.zip"');
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(path.resolve(extensionZipPath));
  });

  return router;
}
