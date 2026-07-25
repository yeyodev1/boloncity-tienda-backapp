import "dotenv/config";
import axios from "axios";
import { dbConnect } from "../src/config/db";
import { Branch } from "../src/models/Branch";

const PICKER_API = "https://dev-api.pickerexpress.com/api";
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || "https://testing-storybrand-backapp.bakano.ec";

async function registerWebhook(branchName: string, apiKey: string) {
  if (!apiKey) {
    console.log(`  ⏭️  No API key for ${branchName}, skipping`);
    return;
  }

  const events = ["DRIVER_ASSIGNED", "UPDATE_BOOKING_STATUS"];
  for (const event of events) {
    try {
      const res = await axios.post(
        `${PICKER_API}/webhooks`,
        { type: event, url: `${WEBHOOK_BASE_URL}/api/webhooks/picker/${event}` },
        {
          headers: {
            "Content-Type": "application/json",
            "content-language": "en",
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );
      console.log(`  ✅ ${branchName} — ${event} registered (status: ${res.status})`);
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.response?.data?.error || err.message;
      console.error(`  ❌ ${branchName} — ${event} failed: ${msg}`);
    }
  }
}

async function main() {
  console.log(`Registering Picker webhooks → ${WEBHOOK_BASE_URL}/api/webhooks/picker\n`);
  await dbConnect();
  const branches = await Branch.find({ isActive: true }).select("+pickerStore.storeApiKey");

  for (const branch of branches) {
    console.log(`Branch: ${branch.name}`);
    await registerWebhook(branch.name, branch.pickerStore?.storeApiKey || "");
  }

  console.log("\nDone.");
}

main().catch(console.error);
