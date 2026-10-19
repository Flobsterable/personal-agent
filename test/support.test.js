import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createSupport } from "../src/support.js";
import {
  formatSupportContext,
  loadSupportDocs,
  searchSupportDocs,
} from "../src/support-kb.js";
import { createProfiles } from "../src/profiles.js";
import { createRouter } from "../src/router.js";

test("support knowledge base loads markdown and retrieves relevant sections", () => {
  const docs = loadSupportDocs();
  assert.ok(docs.length >= 20);
  assert.match(
    searchSupportDocs("Как создать встречу в календаре?")[0].id,
    /^03-meetings-and-calendars#/,
  );
  assert.match(
    searchSupportDocs("Бот не видит сообщения группы")[0].id,
    /^02-groups-and-memory#/,
  );
  assert.match(
    searchSupportDocs("Как загрузить старый JSON архив?")[0].id,
    /^05-history-import#/,
  );
  assert.deepEqual(searchSupportDocs("квантовый фотосинтез марсохода"), []);
  const context = formatSupportContext(
    searchSupportDocs("подключить Google календарь"),
  );
  assert.match(context, /\[03-meetings-and-calendars#/);
  assert.ok(context.length <= 12000);
});

test("support has separate bounded context and only allowlisted diagnostics", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.addNote("PRIVATE_NOTE");
  store.remember("user", "PRIVATE_DIALOGUE");
  const sent = [];
  let context;
  const support = createSupport({
    store,
    config: { ownerId: "1", apiKey: "SECRET_KEY" },
    telegram: { send: async (id, text) => sent.push([id, text]) },
    getSettings: () => ({
      timeZone: "UTC",
      password: "SECRET_PASSWORD",
      defaultCalendarId: "PRIVATE_CALENDAR",
    }),
    searchDocs: () => [
      {
        id: "safe#section",
        title: "Safe documentation",
        heading: "Section",
        body: "Only this support fact is available.",
      },
    ],
    decide: async (config, messages) => {
      context = messages;
      return { action: "answer", args: { text: "Проверьте /settings" } };
    },
  });
  await support.start();
  for (let i = 0; i < 10; i++) await support.answer("Вопрос " + i);
  const serialized = JSON.stringify(context);
  for (const value of [
    "PRIVATE_NOTE",
    "PRIVATE_DIALOGUE",
    "SECRET_KEY",
    "SECRET_PASSWORD",
    "PRIVATE_CALENDAR",
  ])
    assert.ok(!serialized.includes(value));
  assert.match(serialized, /calendarSelected/);
  assert.match(serialized, /safe#section/);
  assert.equal(JSON.parse(store.get("support_history")).length, 12);
  assert.equal(store.history().length, 1);
  assert.ok(sent.every(([id]) => id === "1"));
  await support.stop();
  assert.equal(support.active(), false);
  assert.equal(store.get("support_history"), "");
});

test("support rejects tool actions and handles unavailable model without leaving support", async (t) => {
  const store = new Store(":memory:"),
    sent = [];
  t.after(() => store.close());
  let calls = 0;
  const support = createSupport({
    store,
    config: { ownerId: "1" },
    getSettings: () => ({}),
    telegram: { send: async (id, text) => sent.push(text) },
    decide: async () => {
      calls++;
      return { action: "calendar_create", args: { title: "Injected event" } };
    },
  });
  await support.start();
  await support.answer("Создай событие");
  assert.match(sent.at(-1), /временно недоступна/);
  assert.equal(store.get("support_history"), "");
  assert.equal(support.active(), true);
  await support.answer("x".repeat(4001));
  assert.equal(calls, 1);
});

test("router isolates support from extraction, imports, other profiles and edited messages", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "support-router-"));
  const registry = new Store(":memory:"),
    sent = [],
    callbacks = [];
  const config = {
    dataDir: directory,
    maxProfiles: 3,
    timeZone: "UTC",
    vaultKey: "",
    botUsername: "test_bot",
  };
  const telegram = {
    send: async (id, text, extra) => sent.push({ id, text, extra }),
    call: async (method) => callbacks.push(method),
  };
  const profiles = createProfiles({ config, registry, telegram });
  t.after(() => {
    profiles.close();
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const router = createRouter({ config, registry, profiles, telegram });
  let serial = 0;
  const message = (id, text, extra = {}) => ({
    update_id: ++serial,
    message: {
      message_id: serial,
      from: { id },
      chat: { id, type: "private" },
      text,
      ...extra,
    },
  });
  const callback = (id, data, type = "private") => ({
    update_id: ++serial,
    callback_query: {
      id: String(serial),
      from: { id },
      data,
      message: { chat: { id: type === "private" ? id : -1, type } },
    },
  });
  await router.handle(message(3, "/support"));
  assert.equal(profiles.known(3), undefined);
  await router.handle(message(1, "/start"));
  assert.equal(
    sent.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data,
    "support:start",
  );
  await router.handle(message(2, "/start"));
  const a = profiles.get(1),
    b = profiles.get(2);
  let answered = 0,
    regular = 0;
  a.support.answer = async () => answered++;
  a.engine.handle = async () => regular++;
  await router.handle(callback(1, "support:start", "group"));
  assert.equal(a.support.active(), false);
  await router.handle(callback(1, "support:start"));
  assert.equal(a.support.active(), true);
  assert.equal(b.support.active(), false);
  const question = message(1, "Договорились на встречу завтра в 10");
  await router.handle(question);
  await router.handle(question); // duplicated update
  assert.equal(answered, 1);
  await router.handle(
    message(1, undefined, { document: { file_name: "result.json" } }),
  );
  assert.equal(a.store.get("import_job"), undefined);
  assert.equal(a.knowledge.discussion("private").length, 0);
  assert.equal(a.store.get("discussion_job:private"), undefined);
  await router.handle(callback(1, "support:stop"));
  await router.handle({
    update_id: ++serial,
    edited_message: { ...question.message, text: "Edited support message" },
  });
  assert.equal(a.knowledge.discussion("private").length, 0);
  await router.handle(message(1, "Обычный диалог"));
  assert.equal(regular, 1);
  assert.equal(a.knowledge.discussion("private").length, 1);
  assert.ok(callbacks.includes("answerCallbackQuery"));
  await router.handle(message(1, "/support"));
  await router.handle(message(1, "/stop"));
  assert.equal(profiles.known(1), undefined);
});
