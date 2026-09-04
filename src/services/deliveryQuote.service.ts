import { getOrCreateSettings } from "../models/Setting";
import { distanceKm } from "../utils/haversine";
import { getPickerStoreApiKey } from "./branchOperational.service";
import { preCheckout } from "./pickerexpress.service";

/**
 * Cotiza un delivery: si la direccion esta cubierta y cuanto cuesta llevarla.
 *
 * La cobertura real son los poligonos dibujados por sucursal en Picker; `preCheckout`
 * responde `covered: false` cuando el punto cae fuera de todos. Ese campo existia en
 * el tipo y NUNCA se leia: se tomaba solo el precio y se seguia de largo.
 *
 * Cuando Picker no contesta se cotiza por distancia, y ahi estaba el desastre: sin
 * techo, un punto mal resuelto salia a 4301 km y el envio a $6542 (ORD-00110). Por
 * eso el tope de distancia se evalua ANTES de cualquier precio.
 *
 * Vive en un solo lugar a proposito: el checkout y la creacion de la orden tienen
 * que dar exactamente el mismo numero, o el cliente ve un precio y paga otro.
 */

export interface DeliveryQuote {
  covered: boolean;
  /** Por que se rechazo, en palabras que el cliente pueda leer. */
  reason?: string;
  /** En dolares. Solo tiene sentido con covered = true. */
  deliveryFee: number;
  distance: number;
  source: "picker" | "distance";
}

interface QuoteInput {
  branch: {
    name?: string;
    coordinates?: { lat?: number | null; lng?: number | null } | null;
    pickerStore?: any;
  };
  lat: number;
  lng: number;
}

const OUT_OF_RANGE_MESSAGE =
  "Esa dirección queda fuera de nuestra zona de entrega. Puedes elegir retiro en tienda o escribirnos por WhatsApp.";

export async function quoteDelivery({ branch, lat, lng }: QuoteInput): Promise<DeliveryQuote> {
  const branchLat = branch.coordinates?.lat;
  const branchLng = branch.coordinates?.lng;

  if (branchLat == null || branchLng == null) {
    return { covered: false, reason: "La sucursal no tiene ubicación configurada.", deliveryFee: 0, distance: 0, source: "distance" };
  }

  const distance = distanceKm({ lat, lng }, { lat: branchLat, lng: branchLng });
  const settings = await getOrCreateSettings();
  const maxDistance = settings.deliveryMaxDistanceKm || 30;

  // Primero el techo. Un punto absurdo no debe llegar siquiera a cotizarse: es la
  // diferencia entre rechazar el pedido y cobrarle $6542 de envio a alguien.
  if (distance > maxDistance) {
    return {
      covered: false,
      reason: OUT_OF_RANGE_MESSAGE,
      deliveryFee: 0,
      distance,
      source: "distance",
    };
  }

  const pricePerKm = settings.deliveryPricePerKm || 150;
  const byDistance = Math.round(distance * (pricePerKm / 100) * 100) / 100;

  const branchKey = getPickerStoreApiKey(branch.pickerStore);
  if (!branchKey) {
    // Sucursal sin Picker: se cobra por distancia, ya acotada por el tope de arriba.
    return { covered: true, deliveryFee: byDistance, distance, source: "distance" };
  }

  try {
    const pickerResult = await preCheckout({ branchKey, latitude: lat, longitude: lng });

    // `covered` puede venir undefined si Picker cambia el contrato: en ese caso se
    // asume cubierto (el tope de distancia ya filtro lo absurdo). Solo un `false`
    // explicito rechaza — para no dejar de vender por un campo que dejo de existir.
    if (pickerResult.covered === false) {
      return {
        covered: false,
        reason: pickerResult.message || OUT_OF_RANGE_MESSAGE,
        deliveryFee: 0,
        distance,
        source: "picker",
      };
    }

    const fee = Number(pickerResult.deliveryFee);
    if (!Number.isFinite(fee) || fee <= 0) {
      return { covered: true, deliveryFee: byDistance, distance, source: "distance" };
    }

    return { covered: true, deliveryFee: fee, distance, source: "picker" };
  } catch {
    // Picker caido no puede frenar la venta: se cobra por distancia, con techo.
    return { covered: true, deliveryFee: byDistance, distance, source: "distance" };
  }
}
