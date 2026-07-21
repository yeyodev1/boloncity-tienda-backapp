import axios from "axios";
import { env } from "../config/env";

export async function confirmPayphoneTransaction(id: number, clientTxId: string) {
  if (!env.PAYPHONE_TOKEN) {
    throw new Error("PAYPHONE_TOKEN is not configured");
  }

  const response = await axios.post(
    "https://pay.payphonetodoesposible.com/api/button/V2/Confirm",
    {
      id,
      clientTxId,
    },
    {
      headers: {
        Authorization: `Bearer ${env.PAYPHONE_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}
