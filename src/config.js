import { resolve } from "node:path";
export function loadConfig() {
  for (const key of ["TELEGRAM_BOT_TOKEN", "LLM_API_KEY", "LLM_MODEL"])
    if (!process.env[key]?.trim()) throw new Error("Set " + key);
  if (
    process.env.OWNER_TELEGRAM_ID &&
    !/^[1-9][0-9]*$/.test(process.env.OWNER_TELEGRAM_ID)
  )
    throw new Error("OWNER_TELEGRAM_ID must be your numeric Telegram user ID");
  const timeZone = process.env.TIME_ZONE || "Asia/Omsk";
  const maxProfiles = Number(process.env.MAX_PROFILES || 32);
  if (!Number.isInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > 100)
    throw new Error("MAX_PROFILES must be 1..100");
  new Intl.DateTimeFormat("ru", { timeZone }).format();
  return {
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    maxProfiles,
    vaultKey: process.env.VAULT_KEY || "",
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    yandexClientId: process.env.YANDEX_CLIENT_ID || "",
    yandexClientSecret: process.env.YANDEX_CLIENT_SECRET || "",
    miniAppPort: Number(process.env.MINI_APP_PORT || 8092),
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    ownerId: process.env.OWNER_TELEGRAM_ID,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    baseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com",
    dataDir: resolve(process.env.DATA_DIR || "./data"),
    timeZone,
  };
}
