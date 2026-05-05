import mongoose from "mongoose";

export const TM30_TASK_STATUSES = [
  "EXTENSION_NOT_INSTALLED",
  "EXTENSION_CONNECTED",
  "STARTING",
  "OPENING_TM30",
  "WAITING_CLOUDFLARE",
  "LOGGING_IN",
  "UPLOADING",
  "ACTION_REQUIRED",
  "SUCCESS",
  "FAILED"
];

const Tm30TaskSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    checkInDate: { type: String, required: true },
    stayIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Stay", required: true }],
    status: {
      type: String,
      enum: TM30_TASK_STATUSES,
      default: "STARTING"
    },
    message: { type: String, default: "" },
    excelFileName: { type: String, required: true },
    excelFilePath: { type: String, required: true },
    tokenNonce: { type: String, required: true }
  },
  { timestamps: true }
);

Tm30TaskSchema.index({ userId: 1, checkInDate: 1, createdAt: -1 });

export const Tm30Task = mongoose.model("Tm30Task", Tm30TaskSchema);
