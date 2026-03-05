import mongoose from "mongoose";

const StaySchema = new mongoose.Schema(
  {
    guestId: { type: mongoose.Schema.Types.ObjectId, ref: "Guest", required: true },
    checkInDate: { type: String, required: true }, // YYYY-MM-DD
    checkOutDDMMYYYY: { type: String, required: true }, // DD/MM/YYYY
    phoneNo: { type: String, default: "" },

    // imágenes
    passportImageMrzPath: { type: String, default: "" },  // recorte MRZ (preferido)
    passportImageFullPath: { type: String, default: "" }, // opcional

    // debugging/calidad
    mrzScore: { type: Number, default: 0 },               // 0..3 por check-digits
    mrzLine1: { type: String, default: "" },
    mrzLine2: { type: String, default: "" },

    status: { type: String, enum: ["draft", "confirmed", "exported"], default: "draft" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

StaySchema.index({ checkInDate: 1 });

export const Stay = mongoose.model("Stay", StaySchema);
