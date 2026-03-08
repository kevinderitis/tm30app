import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { authMiddleware } from "../middleware/auth.js";
import jwt from "jsonwebtoken";


export function authRouter() {
  const router = express.Router();



  router.post("/login", async (req, res) => {
    console.log(req.get("origin"), req.get("referer"));

    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1)
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Body inválido" });
    }

    try {
      const email = parsed.data.email.toLowerCase();
      const user = await User.findOne({ email });

      if (!user || !user.isActive) {
        return res.status(401).json({ error: "Credenciales inválidas" });
      }

      const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
      if (!ok) {
        return res.status(401).json({ error: "Credenciales inválidas" });
      }

      const payload = {
        id: String(user._id),
        email: user.email,
        name: user.name,
        role: user.role
      };

      const token = jwt.sign(
        payload,
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      console.log("Usuario logueado:", payload);
      console.log("Token generado:", token);

      return res.json({
        ok: true,
        token,
        user: payload
      });
    } catch (error) {
      console.error("Error en /login:", error);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  });

  router.post("/logout", authMiddleware, (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get("/me", authMiddleware, async (req, res) => {
    console.log("Usuario autenticado:", req.user);
    return res.json({ user: req.user });
  });

  return router;
}
