import { Request, Response } from "express";
import {
  META_EVENT_NAMES,
  MetaCustomData,
  MetaEventName,
  isMetaConfigured,
  metaUserDataFromRequest,
  sendMetaEvent,
} from "../services/metaConversions.service";

/**
 * Espejo servidor de un evento que el navegador ya envio por el pixel.
 *
 * El navegador manda el mismo `eventId` que uso en `fbq(..., { eventID })`, asi
 * Meta reconoce que son el mismo hecho y cuenta uno solo. Si el pixel fue
 * bloqueado, esta copia es la unica que llega — que es justamente el punto.
 *
 * Es un endpoint publico (la tienda vende sin login), asi que solo se aceptan los
 * cinco eventos del catalogo y el email/telefono se hashean aqui: el navegador
 * nunca hace ese trabajo ni toca el access token.
 */
export async function trackMetaEvent(req: Request, res: Response) {
  const {
    eventName,
    eventId,
    eventSourceUrl,
    customData,
    email,
    phone,
    firstName,
    lastName,
    externalId,
    fbp,
    fbc,
  } = req.body as {
    eventName?: string;
    eventId?: string;
    eventSourceUrl?: string;
    customData?: MetaCustomData;
    email?: string;
    phone?: string;
    firstName?: string;
    lastName?: string;
    externalId?: string;
    fbp?: string;
    fbc?: string;
  };

  if (!isMetaConfigured()) {
    // No es un error del cliente: la tienda simplemente no tiene pixel configurado.
    res.json({ tracked: false, reason: "META_NOT_CONFIGURED" });
    return;
  }

  if (!eventName || !META_EVENT_NAMES.includes(eventName as MetaEventName)) {
    res.status(400).json({ message: `Evento no soportado: ${eventName || "(vacío)"}` });
    return;
  }

  if (!eventId || typeof eventId !== "string" || eventId.length > 200) {
    res.status(400).json({ message: "Falta un eventId válido para deduplicar el evento" });
    return;
  }

  const tracked = await sendMetaEvent({
    eventName: eventName as MetaEventName,
    eventId,
    eventSourceUrl,
    actionSource: "website",
    customData,
    userData: {
      ...metaUserDataFromRequest(req),
      email,
      phone,
      firstName,
      lastName,
      externalId,
      fbp,
      fbc,
    },
  });

  res.json({ tracked });
}
