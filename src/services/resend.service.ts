import { Resend } from "resend";
import { env } from "../config/env";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export type SendEmailResult = { ok: true; id: string | null } | { ok: false; error: string };

/**
 * Envia un correo con Resend. Nunca lanza: devuelve `{ ok: false }` con el motivo.
 *
 * El SDK de Resend no lanza cuando rechaza un envio (dominio sin verificar, API key
 * revocada, remitente invalido): devuelve `{ error }`. Antes eso se ignoraba y el
 * "recuperar contraseña" respondia "te enviamos el correo" sin haber enviado nada.
 * Quien necesite saber si salio (forgot-password) revisa `ok`; el resto puede
 * seguir ignorando el resultado, pero el fallo queda en los logs de Vercel.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<SendEmailResult> {
  if (!resend) {
    console.error(`[email] RESEND_API_KEY no configurada; no se envio "${subject}" a ${to}`);
    return { ok: false, error: "RESEND_API_KEY no configurada" };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to,
      subject,
      html,
    });

    if (error) {
      console.error(`[email] Resend rechazo "${subject}" a ${to}: ${error.name} — ${error.message}`);
      return { ok: false, error: `${error.name}: ${error.message}` };
    }

    return { ok: true, id: data?.id || null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email] Fallo enviando "${subject}" a ${to}: ${message}`);
    return { ok: false, error: message };
  }
}
