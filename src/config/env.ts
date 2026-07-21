import "dotenv/config";

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const env = {
  PORT: Number(optional("PORT", "8101")),
  NODE_ENV: optional("NODE_ENV", "development"),
  APP_ENV: optional("APP_ENV", "local"),
  DB_URI: required("DB_URI"),
  JWT_SECRET: required("JWT_SECRET"),
  PAYPHONE_TOKEN: optional("PAYPHONE_TOKEN", ""),
  PAYPHONE_STORE_ID: optional("PAYPHONE_STORE_ID", ""),
  RESEND_API_KEY: optional("RESEND_API_KEY", ""),
  RESEND_FROM_EMAIL: optional("RESEND_FROM_EMAIL", "boloncity@bakano.ec"),
  PICKER_MASTER_KEY: optional("PICKER_MASTER_KEY", ""),
  PICKER_KEYS: {
    garzota: optional("PICKER_KEY_GARZOTA", ""),
    centro: optional("PICKER_KEY_CENTRO", ""),
    kennedy: optional("PICKER_KEY_KENNEDY", ""),
    urdesa: optional("PICKER_KEY_URDESA", ""),
    viaCosta: optional("PICKER_KEY_VIA_COSTA", ""),
    laJoya: optional("PICKER_KEY_LA_JOYA", ""),
    avalon: optional("PICKER_KEY_AVALON", ""),
    republica: optional("PICKER_KEY_REPUBLICA", ""),
  } as const,
  CLOUDINARY_URL: optional("CLOUDINARY_URL", ""),
  CLOUDINARY_CLOUD_NAME: optional("CLOUDINARY_CLOUD_NAME", ""),
  CLOUDINARY_API_KEY: optional("CLOUDINARY_API_KEY", ""),
  CLOUDINARY_API_SECRET: optional("CLOUDINARY_API_SECRET", ""),
  SLACK_ERROR_WEBHOOK: optional("SLACK_ERROR_WEBHOOK", ""),
  FRONTEND_URLS: {
    local: "https://localhost:5173",
    tunnel: "https://testing-storybrand-frontend.bakano.ec",
    develop: "https://boloncity-tienda.netlify.app",
    production: "https://boloncity.com",
  } as const,
} as const;

export function getFrontendUrl(appEnv = env.APP_ENV) {
  return env.FRONTEND_URLS[appEnv as keyof typeof env.FRONTEND_URLS] || env.FRONTEND_URLS.local;
}

export function getPayphoneResponseUrl(appEnv = env.APP_ENV) {
  return `${getFrontendUrl(appEnv)}/checkout/response`;
}
