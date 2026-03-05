import "dotenv/config";

export const config = {
  port: Number(process.env.PORT || 3001),
  nodeEnv: process.env.NODE_ENV || "development",

  mongoUri: process.env.MONGO_URI,
  sessionSecret: process.env.SESSION_SECRET,

  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 14),
  cookieSecure: String(process.env.COOKIE_SECURE || "false") === "true",
  cookieSameSite: process.env.COOKIE_SAME_SITE || "lax",

  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",

  uploadDir: process.env.UPLOAD_DIR || "./uploads/passports",
  exportDir: process.env.EXPORT_DIR || "./output",

  admin: {
    email: process.env.ADMIN_EMAIL || "admin@hostel.local",
    password: process.env.ADMIN_PASSWORD || "Admin123!",
    name: process.env.ADMIN_NAME || "Admin"
  }
};

if (!config.mongoUri) throw new Error("Falta MONGO_URI en .env");
if (!config.sessionSecret) throw new Error("Falta SESSION_SECRET en .env");
