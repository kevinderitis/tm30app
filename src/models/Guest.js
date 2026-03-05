import mongoose from "mongoose";

const GuestSchema = new mongoose.Schema(
  {
    passportNo: { type: String, required: true, unique: true, trim: true },
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, default: "", trim: true },
    lastName: { type: String, default: "", trim: true },
    gender: { type: String, enum: ["M", "F", ""], default: "" },
    nationality: { type: String, default: "", uppercase: true, trim: true },
    birthDateDDMMYYYY: { type: String, default: "" }
  },
  { timestamps: true }
);

export const Guest = mongoose.model("Guest", GuestSchema);
