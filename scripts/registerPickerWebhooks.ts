import "dotenv/config";
import axios from "axios";

const PICKER_API = "https://dev-api.pickerexpress.com/api";
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || "https://testing-storybrand-backapp.bakano.ec";

const BRANCH_KEYS: Record<string, string> = {
  garzota: process.env.PICKER_KEY_GARZOTA || "",
  centro: process.env.PICKER_KEY_CENTRO || "",
  kennedy: process.env.PICKER_KEY_KENNEDY || "",
  urdesa: process.env.PICKER_KEY_URDESA || "",
  viaCosta: process.env.PICKER_KEY_VIA_COSTA || "",
  laJoya: process.env.PICKER_KEY_LA_JOYA || "",
  avalon: process.env.PICKER_KEY_AVALON || "",
  republica: process.env.PICKER_KEY_REPUBLICA || "",
};

async function registerWebhook(branchName: string, apiKey: string) {
  if (!apiKey) {
    console.log(`  ⏭️  No API key for ${branchName}, skipping`);
    return;
  }

  const events = ["DRIVER_ASSIGNED", "UPDATE_BOOKING_STATUS"];
  const url = `${WEBHOOK_BASE_URL}/api/webhooks/picker`;

  for (const event of events) {
    try {
      const res = await axios.post(
        `${PICKER_API}/webhooks`,
        { type: event, url },
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

  for (const [name, key] of Object.entries(BRANCH_KEYS)) {
    console.log(`Branch: ${name}`);
    await registerWebhook(name, key);
  }

  console.log("\nDone.");
}

main().catch(console.error);
