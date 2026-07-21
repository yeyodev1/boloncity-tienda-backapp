import "dotenv/config";
import axios from "axios";

const KEY = process.env.PICKER_KEY_CENTRO || "";
const DOMAIN = "https://dev-api.pickerexpress.com/api";
const LAT = -2.1813769396063902;
const LNG = -79.8740943168259;

const AUTH = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const BODY = { latitude: LAT, longitude: LNG, carName: "BIKE" };

const PATHS = [
  "/preCheckout",
  "/pre-checkout",
  "/precheckout",
  "/pre_checkout",
  "/booking/pre-checkout",
  "/booking/precheckout",
  "/bookings/pre-checkout",
  "/bookings/precheckout",
  "/v1/pre-checkout",
  "/v1/precheckout",
  "/v1/pre_checkout",
  "/v1/booking/pre-checkout",
  "/v1/bookings/pre-checkout",
  "/checkout",
  "/pre-checkout/calculate",
  "/delivery/pre-checkout",
  "/delivery/calculate",
  "/shipping/calculate",
  "/shipping/pre-checkout",
  "/quote",
  "/price",
  "/calculate",
  "/estimate",
];

async function main() {
  // Primero confirmar que createBooking funciona en dev-api
  try {
    const cbRes = await axios.post(`${DOMAIN}/createBooking`, {
      latitude: LAT, longitude: LNG, address: "Test", reference: "test",
      customerName: "Test", customerLastName: "User", customerEmail: "test@test.com",
      customerCountryCode: "593", customerMobile: "999999999",
      paymentMethod: "CARD", orderAmount: 100, externalBookingId: "test-123",
      cookTime: 0, sendTrackingLink: false, bookingNotes: "", bookingStops: [],
    }, { headers: AUTH, timeout: 5000 });
    console.log(`✅ createBooking → ${cbRes.status} (auth OK)`);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      if (err.response.status === 400) {
        console.log(`✅ createBooking → ${err.response.status} (auth OK, body inválido — la key funciona)`);
      } else {
        console.log(`❌ createBooking → ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 100)}`);
      }
    }
  }

  // Probar todas las rutas de pre-checkout
  for (const path of PATHS) {
    const url = `${DOMAIN}${path}`;
    try {
      const res = await axios.post(url, BODY, { headers: AUTH, timeout: 5000 });
      console.log(`\n🎯 ${res.status} ${url}`);
      console.log(`   ${JSON.stringify(res.data).slice(0, 300)}`);
      if (res.data && typeof res.data === 'object' && 'deliveryFee' in res.data) {
        console.log(`\n✅ PRECHECKOUT ENCONTRADO en ${url}`);
        console.log(`   deliveryFee: ${(res.data as any).deliveryFee}`);
        return;
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        if (err.response.status !== 404 && err.response.status !== 401) {
          console.log(`⚠️ ${err.response.status} ${url}: ${JSON.stringify(err.response.data).slice(0, 150)}`);
        }
      } else if (axios.isAxiosError(err) && !err.response) {
        // Network error — ignore for now
      }
    }
  }
  console.log("\n❌ Ninguna ruta de pre-checkout existe en dev-api.pickerexpress.com");
}

main();
