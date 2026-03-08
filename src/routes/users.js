import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { authMiddleware, requireAdmin } from "../middleware/auth.js";

export function usersRouter() {
  const router = express.Router();
  router.use(authMiddleware, requireAdmin);

  router.get("/", async (req, res) => {
    const users = await User.find()
      .select("_id name email role isActive createdAt updatedAt")
      .sort({ createdAt: -1 });
    res.json({ users });
  });

  router.post("/", async (req, res) => {
    const schema = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      password: z.string().min(6),
      role: z.enum(["admin", "staff"]).default("staff"),
      isActive: z.boolean().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });

    const email = parsed.data.email.toLowerCase();
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: "Email ya existe" });

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);

    const user = await User.create({
      name: parsed.data.name,
      email,
      passwordHash,
      role: parsed.data.role,
      isActive: parsed.data.isActive ?? true
    });

    res.status(201).json({
      user: { id: String(user._id), name: user.name, email: user.email, role: user.role, isActive: user.isActive }
    });
  });

  router.patch("/:id", async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      role: z.enum(["admin", "staff"]).optional(),
      isActive: z.boolean().optional(),
      password: z.string().min(6).optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });

    const update = {};
    if (parsed.data.name) update.name = parsed.data.name;
    if (parsed.data.role) update.role = parsed.data.role;
    if (parsed.data.isActive !== undefined) update.isActive = parsed.data.isActive;
    if (parsed.data.password) update.passwordHash = await bcrypt.hash(parsed.data.password, 12);

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select("_id name email role isActive");

    if (!user) return res.status(404).json({ error: "User no encontrado" });
    res.json({ user });
  });

  router.delete("/:id", async (req, res) => {
    const user = await User.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true })
      .select("_id name email role isActive");
    if (!user) return res.status(404).json({ error: "User no encontrado" });
    res.json({ ok: true, user });
  });

  return router;
}
