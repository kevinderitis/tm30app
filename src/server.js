import express from "express";
import cors from "cors";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";
import { connectDb, ensureAdmin } from "./db.js";

import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { staysRouter } from "./routes/stays.js";

await connectDb(config.mongoUri);
await ensureAdmin(config.admin);

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.exportDir, { recursive: true });

const app = express();

app.use(helmet());

app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true
  })
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter());
app.use("/api/users", usersRouter());
app.use("/api", staysRouter({ uploadDir: config.uploadDir, exportDir: config.exportDir }));

// opcional previews
app.use("/uploads", express.static(path.resolve("./uploads")));

app.listen(config.port, () => {
  console.log(`✅ Server: http://localhost:${config.port}`);
  console.log(`CORS origin: ${config.corsOrigin}`);
});
