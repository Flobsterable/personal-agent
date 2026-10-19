import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Knowledge } from "../src/knowledge.js";
import { createProfiles } from "../src/profiles.js";
import { createRouter } from "../src/router.js";
import { createSkills, validateChanges } from "../src/skills.js";
import { importDiscussion, parseTelegramExport } from "../src/import.js";
import { saveSettings, readSettings } from "../src/settings.js";
const task = {
  kind: "task",
  title: "Подготовить релиз",
  description: "Проверить сборку",
  start: "2027-04",
  status: "planned",
};
test("discussion records deduplicate and retain before/after execution history", () => {
  const store = new Store(":memory:"),
    k = new Knowledge(store);
  try {
    const a = k.upsert("-1", task, [{ msg: 1, quote: "релиз" }]);
    assert.equal(k.upsert("-1", task, []).changed, false);
    k.upsert(
      "-1",
      {
        id: a.record.id,
        kind: "task",
        status: "done",
        description: "APK собран",
      },
      [{ msg: 2, quote: "собран" }],
    );
    assert.equal(k.history("-1").length, 2);
    assert.equal(k.query({ period: "2027", status: "done" }).total, 1);
    assert.throws(() =>
      k.upsert("-2", { id: a.record.id, kind: "task", title: "Чужое" }, []),
    );
    assert.equal(k.query({ chat: "-2" }).total, 0);
  } finally {
    store.close();
  }
});
test("raw discussion is bounded, old text expires, decisions survive", () => {
  const store = new Store(":memory:"),
    k = new Knowledge(store);
  try {
    for (let i = 0; i < 150; i++)
      k.observe("-1", i, "1", "text " + i, 1000 + i);
    assert.equal(k.discussion("-1").length, 80);
    k.upsert("-1", task, []);
    k.maintain(7, Date.now());
    assert.equal(k.discussion("-1").length, 0);
    assert.equal(k.list().length, 1);
  } finally {
    store.close();
  }
});
test("extraction rejects invented sources and cross-discussion IDs, asks about vague meetings", () => {
  const messages = [{ msg: 1, sender: "1", text: "Давайте встретимся" }];
  const vague = {
    kind: "meeting",
    title: "Встреча",
    status: "planned",
    evidence: [{ msg: 1, quote: "встретимся" }],
  };
  const found = validateChanges(
    [
      vague,
      { ...vague, id: "foreign" },
      { ...vague, evidence: [{ msg: 1, quote: "утром в 10" }] },
    ],
    messages,
    [],
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].status, "needs_clarification");
});
test("Telegram import handles rich text in batches and marks historical analysis", async () => {
  const store = new Store(":memory:"),
    k = new Knowledge(store),
    flags = [];
  try {
    const data = {
      messages: Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        type: "message",
        date_unixtime: "1700000000",
        from_id: "user1",
        text: ["Релиз ", { type: "bold", text: String(i) }],
      })),
    };
    assert.equal(parseTelegramExport(data)[0].text, "Релиз 0");
    const result = await importDiscussion(
      k,
      {
        analyze: async (chat, options) => {
          flags.push(options.historical);
          return [];
        },
      },
      "archive:a",
      data,
    );
    assert.equal(result.messages, 100);
    assert.deepEqual(flags, [true, true, true]);
    assert.equal(k.discussion("archive:a").length, 80);
    assert.throws(() =>
      parseTelegramExport({
        messages: [{ id: "oops", type: "message", text: "x" }],
      }),
    );
  } finally {
    store.close();
  }
});
test("profiles isolate settings, data, calendars and stop background processing", () => {
  const directory = mkdtempSync(join(tmpdir(), "personal-profiles-")),
    registry = new Store(":memory:");
  const config = {
      dataDir: directory,
      maxProfiles: 2,
      timeZone: "Asia/Omsk",
      vaultKey: "",
    },
    telegram = { send: async () => {}, call: async () => {} };
  const p = createProfiles({ config, registry, telegram });
  try {
    const a = p.register({ id: 1, first_name: "A" }),
      b = p.register({ id: 2, first_name: "B" });
    a.store.addNote("Секрет A");
    saveSettings(a.store, { timeZone: "UTC" });
    assert.equal(b.store.notes().length, 0);
    assert.equal(b.getSettings().timeZone, "Asia/Omsk");
    assert.throws(() => p.register({ id: 3 }));
    p.subscribe("-1", "1");
    assert.deepEqual(p.subscribers("-1"), ["1"]);
    p.pause("1");
    assert.equal(p.known("1"), undefined);
    assert.deepEqual(p.subscribers("-1"), []);
    assert.throws(() => p.webContext("1"));
    assert.equal(p.register({ id: 1 }).store.notes()[0].text, "Секрет A");
  } finally {
    p.close();
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("router creates profiles only in private /start and refuses unknown group users", async () => {
  const directory = mkdtempSync(join(tmpdir(), "personal-router-")),
    registry = new Store(":memory:"),
    sent = [];
  const telegram = {
    send: async (id, text) => sent.push({ id, text }),
    call: async () => ({ status: "member" }),
  };
  const config = {
    dataDir: directory,
    maxProfiles: 2,
    timeZone: "UTC",
    vaultKey: "",
    botUsername: "test_bot",
  };
  const p = createProfiles({ config, registry, telegram }),
    r = createRouter({ config, registry, profiles: p, telegram });
  const message = (update_id, id, text, type = "private") => ({
    update_id,
    message: {
      message_id: update_id,
      from: { id },
      chat: { id: type === "private" ? id : -1, type },
      text,
    },
  });
  try {
    await r.handle(message(1, 1, "/start"));
    assert.ok(p.known(1));
    await r.handle(message(2, 2, "@test_bot расскажи секрет", "group"));
    assert.match(sent.at(-1).text, /незнаком/);
    assert.equal(p.known(2), undefined);
    await r.handle(message(3, 1, "/track", "group"));
    assert.deepEqual(p.subscribers(-1), []);
    telegram.call = async () => ({ status: "administrator" });
    await r.handle(message(4, 1, "/track", "group"));
    assert.deepEqual(p.subscribers(-1), ["1"]);
    await r.handle(message(5, 1, "Релиз в апреле", "group"));
    assert.equal(p.get(1).knowledge.discussion(-1).length, 1);
    assert.ok(p.get(1).store.get("discussion_job:-1"));
    await r.handle(message(6, 1, "/stop"));
    assert.equal(p.known(1), undefined);
  } finally {
    p.close();
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("meeting skill creates, reschedules, cancels linked event and does not write imported history", async () => {
  const store = new Store(":memory:"),
    k = new Knowledge(store),
    calls = [],
    notices = [];
  saveSettings(store, {
    meetingTrackingEnabled: true,
    calendarWriteEnabled: true,
    defaultCalendarId: "google:a",
  });
  const future = "2030-05-01T10:00:00Z",
    end = "2030-05-01T11:00:00Z";
  let next;
  const s = createSkills({
    config: { ownerId: "1", timeZone: "UTC" },
    knowledge: k,
    getSettings: () => readSettings(store),
    notify: async (t) => notices.push(t),
    calendar: {
      create: async (args) => {
        calls.push(["create", args]);
        return {
          calendarId: args.calendarId,
          eventId: "abcdef0123456789abcdef0123456789",
        };
      },
      change: async (args) => calls.push(["change", args]),
    },
    decide: async (config, messages) =>
      messages[0].content.includes("Проверь только")
        ? { action: "verify", args: { valid: true } }
        : { action: "extract", args: { changes: [next] } },
  });
  try {
    k.observe("-1", 1, "1", "Договорились на встречу");
    next = {
      kind: "meeting",
      title: "Встреча",
      description: "Обсуждение",
      start: future,
      end,
      location: "Кафе",
      confirmed: true,
      status: "planned",
      evidence: [{ msg: 1, quote: "Договорились" }],
    };
    await s.analyze("-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].location, "Кафе");
    await s.analyze("-1");
    assert.equal(calls.length, 1);
    const record = k.list("-1")[0];
    next = {
      ...next,
      id: record.id,
      start: "2030-05-02T10:00:00Z",
      end: "2030-05-02T11:00:00Z",
    };
    await s.analyze("-1");
    assert.equal(calls[1][0], "change");
    assert.equal(calls[1][1].eventId, record.remote);
    next = { ...next, status: "cancelled" };
    await s.analyze("-1");
    assert.equal(calls[2][1].cancelled, true);
    next = {
      ...next,
      id: undefined,
      title: "Архивная встреча",
      status: "planned",
    };
    await s.analyze("-1", { historical: true });
    assert.equal(calls.length, 3);
  } finally {
    store.close();
  }
});
test("group answering can retrieve old plans without accessing another chat", async () => {
  const store = new Store(":memory:"),
    k = new Knowledge(store);
  let step = 0;
  try {
    k.upsert("-1", task, []);
    k.upsert("-2", { ...task, title: "Чужая задача" }, []);
    const skill = createSkills({
      config: {},
      knowledge: k,
      getSettings: () => readSettings(store),
      notify: async () => {},
      decide: async (c, m) => {
        if (step++ === 0)
          return {
            action: "memory_search",
            args: { period: "2027", chat: "-2" },
          };
        const result = JSON.parse(m.at(-1).content);
        assert.equal(result.total, 1);
        assert.equal(result.items[0].chat, "-1");
        return { action: "answer", args: { text: "План: подготовить релиз" } };
      },
    });
    assert.match(await skill.answer("-1", "План на 2027?"), /релиз/);
  } finally {
    store.close();
  }
});
