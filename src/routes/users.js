import express from "express";
import { authMiddleware } from "../middleware/auth.js";

export function usersRouter() {
  const router = express.Router();
  router.use(authMiddleware);

  router.all("*", (req, res) => {
    return res.status(403).json({
      error: "La gestión global de usuarios está deshabilitada en esta instalación"
    });
  });

  return router;
}
