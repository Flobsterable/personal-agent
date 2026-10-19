import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { validateInitData } from "./mini-auth.js";
import { readSettings, saveSettings } from "./settings.js";
function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0,
      done = false;
    const chunks = [];
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > 16384) {
        done = true;
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", () => reject(new Error("Request failed")));
  });
}
export function createMiniAppServer({
  config,
  store,
  oauth,
  profiles = null,
  now = () => Date.now(),
}) {
  const sessions = new Map();
  return createServer(async (req, res) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
    };
    const send = (
      status,
      value,
      type = "application/json; charset=utf-8",
      extra = {},
    ) => {
      res.writeHead(status, { ...headers, "Content-Type": type, ...extra });
      res.end(
        type.startsWith("application/json") ? JSON.stringify(value) : value,
      );
    };
    const url = new URL(req.url, "http://localhost");
    try {
      if (
        req.method === "GET" &&
        ["/app", "/app.js", "/app.css"].includes(url.pathname)
      ) {
        const file =
          url.pathname === "/app" ? "app.html" : url.pathname.slice(1);
        return send(
          200,
          await readFile(new URL("../web/" + file, import.meta.url)),
          file.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : file.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8",
        );
      }
      if (req.method === "GET" && url.pathname === "/health")
        return send(200, { status: "ok" });
      if (url.pathname === "/oauth/start" && req.method === "GET") {
        const start = oauth.start(url.searchParams.get("ticket"));
        return send(302, "", "text/plain", {
          Location: start.url,
          "Set-Cookie": start.cookie,
        });
      }
      if (url.pathname.startsWith("/oauth/callback/") && req.method === "GET") {
        const provider = url.pathname.split("/").at(-1),
          cookie = (req.headers.cookie || "")
            .split(";")
            .map((x) => x.trim())
            .find((x) => x.startsWith("pa_oauth="))
            ?.slice(9);
        const result = await oauth.callback(provider, url.searchParams, cookie);
        const username = /^[A-Za-z0-9_]{5,32}$/.test(config.botUsername || "")
          ? config.botUsername
          : null;
        return send(
          200,
          '<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><main><h1>' +
            (result.connected ? "Календарь подключён" : "Вход выполнен") +
            "</h1><p>" +
            (result.connected
              ? "Вернитесь в Telegram и обновите экран настроек."
              : "Яндекс ID подключён, но доступ к календарю не подтверждён. Откройте настройки: может потребоваться пароль приложения для CalDAV.") +
            "</p>" +
            (username
              ? '<a class="button" href="https://t.me/' +
                username +
                '?start=settings">Вернуться к боту</a>'
              : "") +
            "</main></html>",
          "text/html; charset=utf-8",
          {
            "Set-Cookie":
              "pa_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=0",
          },
        );
      }
      if (
        req.url.startsWith("/api/") &&
        req.headers.origin &&
        config.publicBaseUrl &&
        req.headers.origin !== new URL(config.publicBaseUrl).origin
      )
        return send(403, { error: "Forbidden origin" });
      for (const [key, value] of sessions)
        if (value.expires <= now()) sessions.delete(key);
      if (url.pathname === "/api/session" && req.method === "POST") {
        const data = await body(req);
        const user = validateInitData(
          data.initData,
          config.botToken,
          profiles ? null : config.ownerId,
          now(),
        );
        if (profiles && !profiles.known(user.id))
          return send(403, {
            error: "Сначала нажмите /start в личном чате бота.",
          });
        if (sessions.size >= 50)
          return send(429, { error: "Too many sessions" });
        const token = randomBytes(32).toString("hex");
        sessions.set(token, { expires: now() + 15 * 60000, id: user.id });
        return send(200, { token });
      }
      if (
        !sessions.has((req.headers.authorization || "").replace(/^Bearer /, ""))
      )
        return send(401, { error: "Откройте настройки заново из Telegram." });
      const session = sessions.get(
        (req.headers.authorization || "").replace(/^Bearer /, ""),
      );
      if (profiles && !profiles.known(session.id))
        return send(403, { error: "Профиль приостановлен." });
      const context = profiles
        ? profiles.webContext(session.id)
        : { store, oauth, config };
      const ownStore = context.store,
        ownOAuth = context.oauth;
      if (url.pathname === "/api/export" && req.method === "GET")
        return send(200, context.knowledge?.export() || {});
      if (url.pathname === "/api/settings" && req.method === "GET")
        return send(200, {
          profile: { id: session.id },
          skills: (await import("./skills.js")).skills,
          settings: readSettings(ownStore, context.config || config),
          connections: ownOAuth
            ? await ownOAuth.status()
            : { google: { configured: false }, yandex: { configured: false } },
          calendars: context.calendar
            ? await context.calendar.list()
            : { items: [] },
        });
      if (url.pathname === "/api/settings" && req.method === "PUT")
        return send(200, { settings: saveSettings(ownStore, await body(req)) });
      if (url.pathname === "/api/connect" && req.method === "POST") {
        const data = await body(req);
        return send(200, { url: ownOAuth.begin(data.provider) });
      }
      if (url.pathname === "/api/disconnect" && req.method === "POST") {
        const data = await body(req);
        await ownOAuth.disconnect(data.provider);
        return send(200, { ok: true });
      }
      if (url.pathname === "/api/yandex-caldav" && req.method === "POST") {
        const data = await body(req);
        await ownOAuth.setCaldav(data.login, data.password);
        return send(200, { ok: true });
      }
      return send(404, { error: "Not found" });
    } catch {
      return send(400, {
        error:
          "Не удалось выполнить действие. Проверьте подключение и откройте настройки заново.",
      });
    }
  });
}
