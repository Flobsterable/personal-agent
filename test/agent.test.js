import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Store } from "../src/store.js";
import { runTool } from "../src/tools.js";
import { ask } from "../src/llm.js";
import { createEngine } from "../src/engine.js";
import { telegramClient } from "../src/telegram.js";
function fixture(t) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const sends = [],
    calls = [];
  const telegram = {
    async send(chatId, text, extra) {
      sends.push({ chatId: String(chatId), text, extra });
      return { message_id: sends.length };
    },
    async call(method, args) {
      calls.push({ method, args });
      return true;
    },
  };
  return {
    store,
    sends,
    calls,
    telegram,
    config: { ownerId: "1", timeZone: "Asia/Omsk" },
  };
}
const update = (id, user, text) => ({
  update_id: id,
  message: {
    from: { id: user, first_name: "User " + user, is_bot: false },
    chat: { id: user, type: "private" },
    text,
  },
});
test("owner guard rejects injected instructions and personal commands from other users", async (t) => {
  const f = fixture(t);
  let llm = 0;
  const e = createEngine({
    ...f,
    askAgent: async () => {
      llm++;
      return { answer: "private", drafts: [] };
    },
  });
  await e.handle(update(1, 1, "/start"));
  f.store.addNote("secret owner note");
  await e.handle(update(2, 2, "/start"));
  await e.handle(update(3, 2, "/notes"));
  assert.equal(llm, 0);
  assert.ok(
    !f.sends.some(
      (s) => s.chatId === "2" && s.text.includes("secret owner note"),
    ),
  );
  assert.ok(f.sends.some((s) => s.chatId === "1" && s.text.includes("/notes")));
});
test("message draft never sends automatically; only owner can approve once", async (t) => {
  const f = fixture(t);
  f.store.register({ id: 2, first_name: "Recipient" });
  const e = createEngine(f);
  await e.handle(update(1, 1, "/start"));
  const d = f.store.draft("2", "Exact text");
  assert.equal(f.sends.filter((s) => s.chatId === "2").length, 0);
  await e.handle(update(2, 3, "/approve " + d.id));
  assert.equal(f.sends.filter((s) => s.chatId === "2").length, 0);
  await e.handle(update(3, 1, "/approve " + d.id));
  await e.handle(update(4, 1, "/approve " + d.id));
  assert.deepEqual(
    f.sends.filter((s) => s.chatId === "2").map((s) => s.text),
    ["Exact text"],
  );
  assert.equal(f.store.outgoing(d.id).status, "sent");
});
test("approval expires, respects unsubscribe and ignores unauthorized callback", async (t) => {
  const f = fixture(t);
  f.store.register({ id: 2 });
  const e = createEngine({ ...f, now: () => 1000000 });
  const d = f.store.draft("2", "expired", 0);
  await e.handle(update(1, 1, "/start"));
  await e.handle(update(2, 1, "/approve " + d.id));
  assert.equal(f.sends.filter((s) => s.chatId === "2").length, 0);
  const other = f.store.draft("2", "fresh", 1000000);
  await e.handle({
    update_id: 3,
    callback_query: {
      id: "x",
      from: { id: 3 },
      message: { chat: { id: 1, type: "private" } },
      data: "approve:" + other.id,
    },
  });
  f.store.unsubscribe(2);
  await e.handle(update(4, 1, "/approve " + other.id));
  assert.equal(f.sends.filter((s) => s.chatId === "2").length, 0);
});
test("uncertain delivery is never retried automatically", async (t) => {
  const f = fixture(t);
  f.store.register({ id: 2 });
  let deliveries = 0;
  const telegram = {
    ...f.telegram,
    async send(id, text, extra) {
      if (String(id) === "2") {
        deliveries++;
        throw new Error("timeout");
      }
      return f.telegram.send(id, text, extra);
    },
  };
  const e = createEngine({ ...f, telegram });
  await e.handle(update(1, 1, "/start"));
  const d = f.store.draft("2", "maybe delivered");
  await e.handle(update(2, 1, "/approve " + d.id));
  await e.handle(update(3, 1, "/approve " + d.id));
  assert.equal(deliveries, 1);
  assert.equal(f.store.outgoing(d.id).status, "uncertain");
});
test("model can create a draft but cannot approve, send or execute commands", async (t) => {
  const f = fixture(t);
  f.store.register({ id: 2 });
  let step = 0;
  const r = await ask(f.config, f.store, "Напиши пользователю", {
    decide: async () =>
      ++step === 1
        ? { action: "draft_message", args: { chatId: "2", text: "Hello" } }
        : { action: "answer", args: { text: "Черновик подготовлен" } },
  });
  assert.equal(r.drafts.length, 1);
  assert.equal(f.sends.length, 0);
  assert.throws(() => runTool(f.store, "approve", { id: r.drafts[0].id }));
  assert.throws(() => runTool(f.store, "send", { chatId: "2", text: "hack" }));
  assert.throws(() => runTool(f.store, "shell", { command: "x" }));
  assert.equal(f.store.history().length, 2);
});
test("reminders validate time zones and are sent to owner once; duplicate updates are skipped", async (t) => {
  const f = fixture(t);
  let current = 1000;
  const e = createEngine({ ...f, now: () => current });
  await e.handle(update(1, 1, "/start"));
  runTool(
    f.store,
    "add_reminder",
    { text: "Call", at: "1970-01-01T00:00:03Z" },
    current,
  );
  assert.throws(() =>
    runTool(
      f.store,
      "add_reminder",
      { text: "x", at: "2030-01-01T12:00:00" },
      current,
    ),
  );
  current = 4000;
  await e.tick();
  await e.tick();
  assert.equal(f.sends.filter((s) => s.text === "Напоминание: Call").length, 1);
  const count = f.sends.length;
  await e.handle(update(1, 1, "/start"));
  assert.equal(f.sends.length, count);
});
test("SQLite persists notes and recovers in-flight delivery as uncertain", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "personal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "agent.sqlite");
  let store = new Store(path);
  store.addNote("persistent");
  store.register({ id: 2 });
  const d = store.draft("2", "text");
  assert.ok(store.claim(d.id));
  store.close();
  store = new Store(path);
  try {
    assert.equal(store.notes()[0].text, "persistent");
    assert.equal(store.outgoing(d.id).status, "uncertain");
    assert.equal(store.claim(d.id), false);
  } finally {
    store.close();
  }
});
test("Telegram errors do not expose tokens or response bodies", async () => {
  const api = telegramClient("secret-token", {
    fetchImpl: async () => {
      throw new Error("secret-token URL");
    },
  });
  await assert.rejects(
    api.send("1", "hello"),
    (e) => !e.message.includes("secret-token"),
  );
});
