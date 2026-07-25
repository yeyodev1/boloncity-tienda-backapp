import "dotenv/config";
import { dbConnect } from "../config/mongo";
import { Branch } from "../models/Branch";

const branches = [
  {
    name: "Boloncity Centro",
    address: "Aguirre y Malecón",
    city: "Guayaquil",
    coordinates: { lat: -2.1940393, lng: -79.8805643 },
    phone: "096 705 3631",
  },
  {
    name: "Boloncity Garzota",
    address: "V434+882",
    city: "Guayaquil",
    coordinates: { lat: -2.1467032, lng: -79.8939026 },
    phone: "096 723 3341",
  },
  {
    name: "Boloncity Kennedy",
    address: "Cooperativa Guayaquil manzana 10 solar 23, Victor Hugo Sicouret",
    city: "Guayaquil",
    coordinates: { lat: -2.1577677, lng: -79.8947611 },
    phone: "",
  },
  {
    name: "Boloncity Urdesa",
    address: "Av. Victor Emilio Estrada y Peatonal 32 NO",
    city: "Guayaquil",
    coordinates: { lat: -2.1628851, lng: -79.9140524 },
    phone: "",
  },
  {
    name: "Boloncity Vía a la Costa",
    address: "Comercial Blue Coast, LOCAL 22",
    city: "Guayaquil",
    coordinates: { lat: -2.1837511, lng: -79.9859571 },
    phone: "",
  },
  {
    name: "Boloncity República",
    address: "Av. de la República",
    city: "Quito",
    coordinates: { lat: -0.1919427, lng: -78.4855458 },
    phone: "",
  },
  {
    name: "Boloncity La Joya",
    address: "C.C. Palmora Plaza, Av León Febres Cordero Ribadeneyra",
    city: "Guayaquil",
    coordinates: { lat: -2.056124, lng: -79.9188636 },
    phone: "",
  },
  {
    name: "Boloncity Avalon Plaza",
    address: "Av León Febres Cordero Ribadeneyra y Daule Km. 1",
    city: "Guayaquil",
    coordinates: { lat: -2.0539906, lng: -79.8781724 },
    phone: "",
  },
];

async function main() {
  await dbConnect();

  for (const data of branches) {
    await Branch.findOneAndUpdate(
      { slug: data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") },
      {
        name: data.name,
        address: data.address,
        city: data.city,
        coordinates: data.coordinates,
        phone: data.phone,
        isActive: true,
      },
      { upsert: true, new: true }
    );
    console.log(`  ${data.name} → ${data.coordinates ? `${data.coordinates.lat}, ${data.coordinates.lng}` : "sin coordenadas"}`);
  }

  console.log("\nSeed de sucursales completado");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
