import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";

export function authRouter() {
  const router = express.Router();

  router.post("/login", async (req, res) => {
    console.log(req.get('origin'), req.get('referer'));
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Body inválido" });

    const email = parsed.data.email.toLowerCase();
    const user = await User.findOne({ email });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

    req.session.user = {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role
    };
    console.log("Usuario logueado:", req.session.user);
    res.json({ ok: true, user: req.session.user });
  });

  router.post("/logout", requireAuth, (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get("/me", requireAuth, (req, res) => {
    res.json({ user: req.session.user });
  });

  return router;
}
