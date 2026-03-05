import express from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import MongoStore from "connect-mongo";
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

app.use(
  session({
    name: "tm30.sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({
      mongoUrl: config.mongoUri,
      ttl: config.sessionTtlDays * 24 * 60 * 60
    }),
    cookie: {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000
    }
  })
);

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
