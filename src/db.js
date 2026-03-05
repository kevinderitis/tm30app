import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "./models/User.js";

export async function connectDb(mongoUri) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(mongoUri);
}

export async function ensureAdmin({ email, password, name }) {
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) return;

  const passwordHash = await bcrypt.hash(password, 12);
  await User.create({
    name,
    email: email.toLowerCase(),
    passwordHash,
    role: "admin",
    isActive: true
  });

  console.log(`✅ Admin creado: ${email} (cambiá la pass luego)`);
}
