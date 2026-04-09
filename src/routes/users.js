import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { authMiddleware, requireAdmin } from "../middleware/auth.js";

export function usersRouter() {
  const router = express.Router();
  router.use(authMiddleware);
  router.use((req, res, next) => {
    const denial = requireAdmin(req, res);
    if (denial) return;
    next();
  });

  router.get("/", async (req, res) => {
    const users = await User.find()
      .select("_id name email role isActive createdAt updatedAt")
      .sort({ createdAt: -1 });

    res.json({
      users: users.map((user) => ({
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }))
    });
  });

  router.post("/", async (req, res) => {
    const schema = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      password: z.string().min(6),
      isActive: z.boolean().optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
    }

    const email = parsed.data.email.toLowerCase();
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: "Email ya existe" });

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const user = await User.create({
      name: parsed.data.name,
      email,
      passwordHash,
      role: "hostel",
      isActive: parsed.data.isActive ?? true
    });

    return res.status(201).json({
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive
      }
    });
  });

  router.patch("/:id", async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      isActive: z.boolean().optional(),
      password: z.string().min(6).optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
    }

    const update = {};
    if (parsed.data.name) update.name = parsed.data.name;
    if (parsed.data.isActive !== undefined) update.isActive = parsed.data.isActive;
    if (parsed.data.password) update.passwordHash = await bcrypt.hash(parsed.data.password, 12);

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select("_id name email role isActive createdAt updatedAt");

    if (!user) return res.status(404).json({ error: "User no encontrado" });

    return res.json({
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });
  });

  router.delete("/:id", async (req, res) => {
    const existingUser = await User.findById(req.params.id).select("_id role");
    if (!existingUser) return res.status(404).json({ error: "User no encontrado" });
    if (existingUser.role === "admin") {
      return res.status(400).json({ error: "No se puede desactivar el usuario admin desde esta pantalla" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    ).select("_id name email role isActive createdAt updatedAt");

    if (!user) return res.status(404).json({ error: "User no encontrado" });

    return res.json({
      ok: true,
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });
  });

  return router;
}
