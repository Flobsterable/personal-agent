import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { telegramClient } from "./telegram.js";
import { createProfiles } from "./profiles.js";
import { createRouter } from "./router.js";
import { createMiniAppServer } from "./mini-server.js";
const config = loadConfig();
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
const store = new Store(resolve(config.dataDir, "personal.sqlite"));
const telegram = telegramClient(config.botToken);
const me = await telegram.call("getMe");
config.botUsername = me.username;
config.botId = me.id;
const profiles = createProfiles({ config, registry: store, telegram });
const engine = createRouter({ config, registry: store, profiles, telegram });
console.log("Personal agent started: @" + me.username);
const webhook = await telegram.call("getWebhookInfo");
if (webhook.url)
  throw new Error(
    "Webhook configured; remove it explicitly before using polling",
  );
let server = null;
if (config.publicBaseUrl) {
  if (new URL(config.publicBaseUrl).protocol !== "https:" || !config.vaultKey)
    throw new Error("Mini App requires HTTPS PUBLIC_BASE_URL and VAULT_KEY");
  server = createMiniAppServer({
    config,
    store,
    profiles,
    oauth: profiles.oauthRouter,
  });
  server.listen(config.miniAppPort, "0.0.0.0");
  await telegram.call("setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "Настройки",
      web_app: { url: config.publicBaseUrl + "/app" },
    },
  });
}
await telegram.call("setMyCommands", {
  commands: [
    { command: "start", description: "Создать или возобновить профиль" },
    { command: "settings", description: "Настройки и календари" },
    { command: "plan", description: "Планы и встречи" },
    { command: "history", description: "История выполнения" },
    { command: "summary", description: "Сводка дел и обсуждений" },
    { command: "status", description: "Проверить сбор и разбор сообщений" },
    { command: "task", description: "Добавить задачу в личке" },
    { command: "tasks", description: "Открытые задачи" },
    { command: "done", description: "Закрыть задачу: ID и результат" },
    { command: "skills", description: "Навыки агента" },
    { command: "track", description: "Подключить обсуждение группы" },
    { command: "untrack", description: "Остановить обработку группы" },
    { command: "stop", description: "Приостановить профиль" },
  ],
});
let tick = Promise.resolve(),
  ticking = false;
const timer = setInterval(() => {
  if (ticking) return;
  ticking = true;
  tick = engine
    .tick()
    .catch(() => console.error("Reminder delivery failed; inspect status."))
    .finally(() => {
      ticking = false;
    });
}, 1000);
let stopping = false;
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    controller.abort();
  });
try {
  while (!stopping) {
    try {
      const updates = await telegram.call(
        "getUpdates",
        {
          offset: Number(store.get("offset") || 0),
          timeout: 25,
          allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"],
        },
        controller.signal,
      );
      for (const update of updates) {
        try {
          await engine.handle(update);
        } catch {
          console.error(
            "Update failed; inspect action status before retrying.",
          );
        }
        store.set("offset", update.update_id + 1);
      }
    } catch {
      if (!stopping) {
        console.error(
          "Polling temporarily unavailable; credentials and message content are not logged.",
        );
        await delay(3000);
      }
    }
  }
} finally {
  clearInterval(timer);
  await tick;
  if (server) await new Promise((resolve) => server.close(resolve));
  profiles.close();
  store.close();
}
