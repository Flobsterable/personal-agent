import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { Vault } from "../src/vault.js";
import { readSettings, saveSettings } from "../src/settings.js";
import { validateInitData } from "../src/mini-auth.js";
import { createMiniAppServer } from "../src/mini-server.js";
import { createOAuth } from "../src/oauth.js";
import {
  createCalendarService,
  makeEventIcs,
  parseExpandedEvents,
  validateWindow,
} from "../src/calendar.js";
import { createEngine } from "../src/engine.js";
import { createProfiles } from "../src/profiles.js";
function signed(botToken, id, now = Date.now()) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(now / 1000)),
    user: JSON.stringify({ id }),
    query_id: "query",
  });
  const check = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + "=" + v)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  p.set("hash", createHmac("sha256", key).update(check).digest("hex"));
  return p.toString();
}
const memoryVault = (initial) => {
  const data = { ...initial };
  return {
    async get(key) {
      return data[key] || null;
    },
    async set(key, value) {
      if (value === null) delete data[key];
      else data[key] = value;
    },
  };
};
test("multi-user Mini App sessions cannot select another profile or survive pause", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "personal-web-")),
    registry = new Store(":memory:");
  const config = {
    dataDir: directory,
    maxProfiles: 3,
    timeZone: "UTC",
    botToken: "test",
    vaultKey: "",
    publicBaseUrl: "https://agent.example",
  };
  const supportSends = [];
  const profiles = createProfiles({
    config,
    registry,
    telegram: { send: async (id) => supportSends.push(String(id)) },
  });
  profiles.register({ id: 1 });
  profiles.register({ id: 2 });
  const server = createMiniAppServer({
    config,
    store: registry,
    profiles,
    oauth: profiles.oauthRouter,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (path, body, token, method = "POST") =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    const a = await (
      await request("/api/session", { initData: signed("test", 1) })
    ).json();
    const b = await (
      await request("/api/session", { initData: signed("test", 2) })
    ).json();
    assert.equal(
      (await request("/api/session", { initData: signed("test", 3) })).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/settings",
          { timeZone: "Asia/Omsk" },
          a.token,
          "PUT",
        )
      ).status,
      200,
    );
    const other = await (
      await request("/api/settings?user=1", null, b.token, "GET")
    ).json();
    assert.equal(other.profile.id, "2");
    assert.equal(other.settings.timeZone, "UTC");
    assert.equal((await request("/api/support", {})).status, 401);
    assert.equal(
      (await request("/api/support?user=1", {}, b.token)).status,
      200,
    );
    assert.deepEqual(supportSends, ["2"]);
    assert.equal(profiles.get(1).support.active(), false);
    assert.equal(profiles.get(2).support.active(), true);
    profiles.pause(1);
    assert.equal((await request("/api/support", {}, a.token)).status, 403);
    assert.equal(
      (await request("/api/settings", null, a.token, "GET")).status,
      403,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    profiles.close();
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("Mini App accepts only signed fresh owner sessions", () => {
  const now = Date.now(),
    raw = signed("token", 1, now);
  assert.equal(validateInitData(raw, "token", "1", now).id, "1");
  assert.throws(() => validateInitData(raw, "other", "1", now));
  assert.throws(() =>
    validateInitData(signed("token", 2, now), "token", "1", now),
  );
  assert.throws(() => validateInitData(raw, "token", "1", now + 6 * 60000));
});
test("settings persist, reject unknown fields and invalid timezone", () => {
  const s = new Store(":memory:");
  try {
    saveSettings(s, {
      ...readSettings(s),
      timeZone: "Europe/Moscow",
      sendMode: "automatic",
    });
    assert.equal(readSettings(s).timeZone, "Europe/Moscow");
    assert.throws(() => saveSettings(s, { OWNER_TELEGRAM_ID: "999" }));
    assert.throws(() => saveSettings(s, { timeZone: "not/a/zone" }));
  } finally {
    s.close();
  }
});
test("vault encrypts credentials at rest and serializes provider writes", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "vault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32).toString("base64"),
    path = resolve(root, "vault.json"),
    v = new Vault(path, key);
  await Promise.all([
    v.set("google", { refresh_token: "private-refresh" }),
    v.set("yandex", { access_token: "private-access" }),
  ]);
  const text = await readFile(path, "utf8");
  assert.ok(!text.includes("private-"));
  const restored = new Vault(path, key);
  assert.equal((await restored.get("google")).refresh_token, "private-refresh");
  assert.equal((await restored.get("yandex")).access_token, "private-access");
  await assert.rejects(
    new Vault(path, randomBytes(32).toString("base64")).get("google"),
  );
});
test("OAuth requires one-time state and browser binding and never reports ID login as calendar access", async () => {
  const config = {
    publicBaseUrl: "https://agent.example",
    googleClientId: "g",
    googleClientSecret: "secret",
    yandexClientId: "y",
    yandexClientSecret: "secret",
  };
  const vault = memoryVault({});
  const flow = createOAuth(config, {
    vault,
    getSettings: () => ({ calendarWriteEnabled: false }),
    calendar: {
      async list() {
        return {
          items: [],
          errors: ["Yandex Calendar not connected or unavailable"],
        };
      },
    },
    fetchImpl: async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("/info")
            ? { login: "demo", default_email: "demo@yandex.ru" }
            : {
                access_token: "private-token",
                refresh_token: "private-refresh",
                expires_in: 3600,
              },
        ),
      ),
  });
  const link = new URL(flow.begin("yandex"));
  const start = flow.start(link.searchParams.get("ticket"));
  assert.throws(() => flow.start(link.searchParams.get("ticket")));
  const auth = new URL(start.url),
    params = new URLSearchParams({
      state: auth.searchParams.get("state"),
      code: "one-use-code",
    });
  const cookie = start.cookie.split(";")[0].split("=")[1];
  const result = await flow.callback("yandex", params, cookie);
  assert.equal(result.connected, false);
  assert.equal((await flow.status()).yandex.needsCaldav, true);
  await assert.rejects(flow.callback("yandex", params, cookie));
  const other = flow.start(
    new URL(flow.begin("google")).searchParams.get("ticket"),
  );
  await assert.rejects(
    flow.callback(
      "google",
      new URLSearchParams({
        state: new URL(other.url).searchParams.get("state"),
        code: "x",
      }),
      "wrong-browser",
    ),
  );
});
test("Google OAuth requests calendar access with offline access and PKCE", () => {
  const flow = createOAuth(
    {
      publicBaseUrl: "https://agent.example",
      googleClientId: "g",
      googleClientSecret: "s",
    },
    {
      vault: memoryVault({}),
      getSettings: () => ({ calendarWriteEnabled: false }),
    },
  );
  const start = flow.start(
    new URL(flow.begin("google")).searchParams.get("ticket"),
  );
  const url = new URL(start.url);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("scope"),
    "https://www.googleapis.com/auth/calendar.readonly",
  );
  assert.ok(start.cookie.includes("HttpOnly"));
});
test("calendar payload escapes text and does not silently misreport unexpanded recurrence", () => {
  const ics = makeEventIcs({
    id: "uid",
    title: "Meeting\nATTENDEE:malicious",
    description: "line,semi;",
    start: "2026-10-19T10:00:00Z",
    end: "2026-10-19T11:00:00Z",
  });
  const parsed = parseExpandedEvents(ics);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].start, "2026-10-19T10:00:00.000Z");
  assert.equal(parsed.items[0].title, "Meeting\nATTENDEE:malicious");
  const recur = ics.replace("END:VEVENT", "RRULE:FREQ=DAILY\r\nEND:VEVENT");
  assert.equal(parseExpandedEvents(recur).incomplete, true);
  assert.throws(() =>
    validateWindow("2026-10-19T10:00:00", "2026-10-19T11:00:00Z"),
  );
});
test("Yandex calendar adapter requests server expansion and creates a real ICS object", async () => {
  let writes = 0;
  const vault = memoryVault({
    yandex: { login: "demo", appPassword: "secret" },
  });
  const calendar = createCalendarService(
    {},
    {
      vault,
      getSettings: () => ({ calendarWriteEnabled: true }),
      davFactory: async () => ({
        async fetchCalendars() {
          return [
            {
              url: "https://caldav.yandex.ru/calendar/",
              displayName: "Personal",
            },
          ];
        },
        async fetchCalendarObjects(args) {
          assert.equal(args.expand, true);
          return [
            {
              data: makeEventIcs({
                id: "x",
                title: "Demo",
                start: "2026-10-19T10:00:00Z",
                end: "2026-10-19T11:00:00Z",
              }),
            },
          ];
        },
        async createCalendarObject(args) {
          writes++;
          assert.equal(
            parseExpandedEvents(args.iCalString).items[0].title,
            "New",
          );
          return { ok: true };
        },
      }),
    },
  );
  const id = (await calendar.list()).items[0].id;
  assert.equal(
    (
      await calendar.events({
        calendarId: id,
        from: "2026-10-19T00:00:00Z",
        to: "2026-10-20T00:00:00Z",
      })
    ).items.length,
    1,
  );
  assert.equal(
    (
      await calendar.create({
        calendarId: id,
        title: "New",
        start: "2026-10-19T12:00:00Z",
        end: "2026-10-19T13:00:00Z",
      })
    ).created,
    true,
  );
  assert.equal(writes, 1);
});
test("automatic send executes the owner instruction without approval and deduplicates retries", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.register({ id: 2, first_name: "Max" });
  const sent = [];
  const engine = createEngine({
    config: { ownerId: "1", timeZone: "Asia/Omsk" },
    store,
    telegram: {
      async send(id, text) {
        sent.push({ id: String(id), text });
        return { message_id: 1 };
      },
    },
    authorize: async () => true,
    askAgent: async (_c, _s, _m, { execute }) => {
      await execute("send_message", { chatId: "2", text: "Hello" });
      await execute("send_message", { chatId: "2", text: "Hello" });
      return { answer: "Sent", drafts: [] };
    },
  });
  await engine.handle({
    update_id: 1,
    message: {
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      text: "Send Max Hello",
    },
  });
  assert.equal(sent.filter((x) => x.id === "2").length, 1);
});
test("Mini App API hides settings from anonymous visitors and validates owner initData", async (t) => {
  const store = new Store(":memory:");
  const server = createMiniAppServer({
    config: {
      botToken: "token",
      ownerId: "1",
      publicBaseUrl: "https://agent.example",
    },
    store,
    oauth: {
      async status() {
        return { google: { configured: false }, yandex: { configured: false } };
      },
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.close(() => {
          store.close();
          r();
        });
        server.closeAllConnections();
      }),
  );
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(base + "/api/settings")).status, 401);
  const session = await (
    await fetch(base + "/api/session", {
      method: "POST",
      body: JSON.stringify({ initData: signed("token", 1) }),
    })
  ).json();
  const result = await fetch(base + "/api/settings", {
    headers: { Authorization: "Bearer " + session.token },
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).settings.sendMode, "automatic");
});

test("Google adapter uses refresh tokens, expands events and enforces write scopes", async () => {
  const vault = memoryVault({
    google: {
      refresh_token: "refresh",
      scope: "https://www.googleapis.com/auth/calendar.events",
    },
  });
  let writes = 0,
    enabled = false;
  const api = createCalendarService(
    { googleClientId: "id", googleClientSecret: "secret" },
    {
      vault,
      getSettings: () => ({ calendarWriteEnabled: enabled }),
      fetchImpl: async (url, init) => {
        const u = new URL(url);
        if (u.hostname === "oauth2.googleapis.com")
          return new Response(
            JSON.stringify({ access_token: "access", expires_in: 3600 }),
          );
        if (u.pathname.endsWith("/calendarList"))
          return new Response(
            JSON.stringify({
              items: [{ id: "primary", summary: "Main", accessRole: "owner" }],
            }),
          );
        if (init.method === "POST") {
          writes++;
          const data = JSON.parse(init.body);
          assert.equal(data.summary, "Meeting");
          return new Response(JSON.stringify({ id: data.id }));
        }
        assert.equal(u.searchParams.get("singleEvents"), "true");
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "event",
                summary: "Event",
                start: { dateTime: "2026-10-19T10:00:00Z" },
                end: { dateTime: "2026-10-19T11:00:00Z" },
              },
            ],
          }),
        );
      },
    },
  );
  const id = (await api.list()).items[0].id;
  assert.equal(
    (
      await api.events({
        calendarId: id,
        from: "2026-10-19T00:00:00Z",
        to: "2026-10-20T00:00:00Z",
      })
    ).items.length,
    1,
  );
  const request = {
    calendarId: id,
    title: "Meeting",
    start: "2026-10-19T10:00:00Z",
    end: "2026-10-19T11:00:00Z",
  };
  await assert.rejects(api.create(request));
  enabled = true;
  assert.equal((await api.create(request)).created, true);
  assert.equal(writes, 1);
  await vault.set("google", null);
  assert.equal((await api.list()).items.length, 0);
});

test("calendar changes preserve location and use provider version preconditions", async () => {
  const id = "abcdef0123456789abcdef0123456789";
  const writes = [];
  const vault = memoryVault({
    google: {
      refresh_token: "r",
      scope: "https://www.googleapis.com/auth/calendar.events",
    },
  });
  const service = createCalendarService(
    { googleClientId: "id", googleClientSecret: "secret" },
    {
      vault,
      getSettings: () => ({ calendarWriteEnabled: true }),
      fetchImpl: async (url, init = {}) => {
        const path = String(url);
        let data = {};
        if (path.includes("oauth2.googleapis.com"))
          data = { access_token: "a", expires_in: 3600 };
        else if (path.includes("calendarList"))
          data = {
            items: [{ id: "primary", summary: "Mine", accessRole: "owner" }],
          };
        else if (init.method === "PATCH") {
          writes.push(init);
          data = { id };
        } else data = { id, etag: '"version-1"' };
        return { ok: true, json: async () => data };
      },
    },
  );
  const calendarId = (await service.list()).items[0].id;
  await service.change({
    calendarId,
    eventId: id,
    title: "Встреча",
    location: "Кафе",
    start: "2030-01-01T10:00:00Z",
    end: "2030-01-01T11:00:00Z",
  });
  assert.equal(writes[0].headers["If-Match"], '"version-1"');
  assert.equal(JSON.parse(writes[0].body).location, "Кафе");
  await service.change({ calendarId, eventId: id, cancelled: true });
  assert.equal(JSON.parse(writes[1].body).status, "cancelled");
  const davWrites = [];
  const davService = createCalendarService(
    {},
    {
      vault: memoryVault({ yandex: { login: "me", appPassword: "p" } }),
      getSettings: () => ({ calendarWriteEnabled: true }),
      davFactory: async () => ({
        fetchCalendars: async () => [
          {
            url: "https://caldav.yandex.ru/calendars/me/default/",
            displayName: "Mine",
          },
        ],
        fetchCalendarObjects: async ({ objectUrls }) => [
          { url: objectUrls[0], etag: "v1", data: "old" },
        ],
        updateCalendarObject: async ({ calendarObject }) => {
          davWrites.push(calendarObject);
          return { ok: true };
        },
        deleteCalendarObject: async ({ calendarObject }) => {
          davWrites.push(calendarObject);
          return { ok: true };
        },
      }),
    },
  );
  const davId = (await davService.list()).items[0].id;
  await davService.change({
    calendarId: davId,
    eventId: id,
    title: "Встреча",
    location: "Кафе",
    start: "2030-01-01T10:00:00Z",
    end: "2030-01-01T11:00:00Z",
  });
  assert.equal(davWrites[0].etag, "v1");
  assert.match(davWrites[0].data, /LOCATION:Кафе/);
  await davService.change({ calendarId: davId, eventId: id, cancelled: true });
  assert.equal(davWrites.length, 2);
});
