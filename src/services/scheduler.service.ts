import cron from "node-cron";
import { Product } from "../models/Product";

let started = false;

export function startScheduler() {
  if (started) return;
  started = true;

  cron.schedule("* * * * *", async () => {
    const now = new Date();
    await Product.updateMany(
      { scheduledActivation: { $lte: now }, isAvailable: false },
      { $set: { isAvailable: true, scheduledActivation: null } }
    );
    await Product.updateMany(
      { scheduledDeactivation: { $lte: now }, isAvailable: true },
      { $set: { isAvailable: false, scheduledDeactivation: null } }
    );
  });
}
