import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: "No autenticado" });
  next();
}

export function requireAdmin(req, res, next) {
  if (req.session?.user?.role !== "admin") return res.status(403).json({ error: "Solo admin" });
  next();
}

export function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "Falta Authorization header" });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Formato de token inválido" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}