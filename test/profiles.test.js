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
import { createEngine } from "../src/engine.js";
import { ask } from "../src/llm.js";
const task = {
  kind: "task",
  title: "Подготовить релиз",
  description: "Проверить сборку",
  start: "2027-04",
  status: "planned",
};
test("what needs doing includes group tasks even when personal tasks are empty and exposes recent unprocessed messages", async () => {
  const store=new Store(":memory:"), knowledge=new Knowledge(store), sent=[];
  try {
    knowledge.observe(-1,1,1,"Нужно купить продукты в выходные");
    knowledge.observe(-1,2,1,"Нужно забрать заказ");
    knowledge.upsert(-1,{kind:"task",title:"Купить продукты в выходные",status:"planned"},[{msg:1,quote:"купить продукты"}]);
    store.remember("assistant","Список дел пуст.");
    let calls=0;
    const engine=createEngine({config:{ownerId:"1"},store,knowledge,
      telegram:{send:async(id,text)=>sent.push(text)},
      askAgent:(config,db,text,options)=>ask(config,db,text,{...options,decide:async(c,messages)=>{
        if(calls++===0){
          const snapshot=JSON.parse(messages.at(-2).content).profileMemory;
          assert.equal(snapshot.tasks.length,1);
          assert.equal(snapshot.discussionRecords.items[0].title,"Купить продукты в выходные");
          assert.ok(snapshot.recentMessages.items.some(m=>m.text.includes("забрать заказ")));
          return {action:"tasks",args:{}};
        }
        const result=JSON.parse(messages.at(-1).content).toolResult;
        assert.equal(result.tasks.length,1);
        assert.equal(result.discussionTasks.total,1);
        return {action:"answer",args:{text:"Купить продукты в выходные; забрать заказ."}};
      }}),
    });
    const message=(id,text)=>({update_id:id,message:{message_id:id,from:{id:1},chat:{id:1,type:"private"},text}});
    await engine.handle(message(1,"что нужно сделать?"));
    assert.match(sent.at(-1),/Купить продукты/);
    await engine.handle(message(2,"/tasks"));
    assert.match(sent.at(-1),/Купить продукты/);
    assert.match(sent.at(-1),/\/done ID/);
  }finally{store.close();}
});
test("bot promotion subscribes a registered admin and migration retains collection under the new chat ID", async () => {
  const directory=mkdtempSync(join(tmpdir(),"personal-migration-"));
  const registry=new Store(":memory:");
  const config={dataDir:directory,maxProfiles:2,timeZone:"UTC",vaultKey:"",botId:99};
  const telegram={send:async()=>{},call:async()=>({status:"creator"})};
  const profiles=createProfiles({config,registry,telegram});
  const router=createRouter({config,registry,profiles,telegram});
  try {
    profiles.register({id:1});
    await router.handle({update_id:1,my_chat_member:{chat:{id:-1,type:"group"},from:{id:1},
      old_chat_member:{status:"member"},new_chat_member:{status:"administrator"}}});
    assert.deepEqual(profiles.subscribers(-1),["1"]);
    profiles.subscribe(-2,1);
    // Telegram service sender is a bot and has no profile.
    await router.handle({update_id:2,message:{message_id:1,from:{id:1087968824,is_bot:true},
      chat:{id:-1,type:"group"},migrate_to_chat_id:-1001}});
    assert.deepEqual(profiles.subscribers(-1001),["1"]);
    assert.deepEqual(profiles.subscribers(-1),["1"],"old analysis jobs remain authorized");
    assert.deepEqual(profiles.subscribers(-2),["1"]);
    await router.handle({update_id:3,message:{message_id:2,from:{id:1087968824,is_bot:true},
      chat:{id:-1001,type:"supergroup"},migrate_from_chat_id:-1}});
    await router.handle({update_id:4,message:{message_id:3,from:{id:2},
      chat:{id:-1001,type:"supergroup"},text:"Нужно купить продукты в выходные"}});
    assert.equal(profiles.get(1).knowledge.discussion(-1001)[0].text,"Нужно купить продукты в выходные");
    assert.ok(profiles.get(1).store.get("discussion_job:-1001"));
    assert.equal(registry.db.prepare("SELECT count(*) AS n FROM subscriptions WHERE chat='-1'").get().n,0);
    profiles.unsubscribe(-1,1);
    assert.deepEqual(profiles.subscribers(-1001),[]);
    await router.handle({update_id:5,my_chat_member:{chat:{id:-1001,type:"supergroup"},from:{id:1},
      old_chat_member:{status:"administrator"},new_chat_member:{status:"administrator"}}});
    assert.deepEqual(profiles.subscribers(-1001),[],"rights edits must not undo /untrack");
  } finally {profiles.close();registry.close();rmSync(directory,{recursive:true,force:true});}
});
test("private summary reads raw group messages before extraction, with profile isolation and pagination", async () => {
  const store = new Store(":memory:"), other = new Store(":memory:");
  const knowledge = new Knowledge(store), foreign = new Knowledge(other), sent = [];
  try {
    for (let i = 1; i <= 6; i++) knowledge.observe("-1", i, "2", "Релиз: сборка " + i);
    foreign.observe("-2", 1, "3", "Чужой секрет");
    const first = knowledge.recent({ text: "РЕЛИЗ" });
    assert.equal(first.total, 6);
    assert.equal(first.items.length, 5);
    assert.equal(first.nextOffset, 5);
    assert.equal(knowledge.recent({ offset: first.nextOffset }).items.length, 1);
    assert.equal(knowledge.recent({ chat: "-2" }).total, 0);
    assert.throws(() => knowledge.recent({ offset: -1 }));
    let step = 0;
    const engine = createEngine({
      config: { ownerId: "1" }, store, knowledge,
      telegram: { send: async (id, text) => sent.push(text) },
      askAgent: (config, db, text, options) => ask(config, db, text, {
        ...options,
        decide: async (c, messages) => {
          if (step++ === 0) {
            assert.match(messages[0].content, /discussion_messages/);
            assert.match(messages.at(-1).content, /Составь сводку/);
            return { action: "discussion_records", args: {} };
          }
          if (step === 2) {
            assert.equal(JSON.parse(messages.at(-1).content).toolResult.total, 0);
            return { action: "discussion_messages", args: { text: "РЕЛИЗ" } };
          }
          const result = JSON.parse(messages.at(-1).content).toolResult;
          assert.equal(result.total, 6);
          assert.ok(result.items.every((m) => m.chat === "-1"));
          assert.match(result.warning, /не вся история/);
          return { action: "answer", args: { text: "Релиз: проверка сборки. Показана часть переписки." } };
        },
      }),
    });
    await engine.handle({ update_id: 1, message: { message_id: 1,
      from: { id: 1 }, chat: { id: 1, type: "private" }, text: "/summary" } });
    assert.match(sent.at(-1), /Релиз/);
  } finally { store.close(); other.close(); }
});

test("failed background extraction retries without another message, preserves concurrent messages and reports status", async () => {
  const directory = mkdtempSync(join(tmpdir(), "personal-retry-"));
  const registry = new Store(":memory:"), sent = [];
  const config = { dataDir: directory, maxProfiles: 2, timeZone: "UTC", vaultKey: "" };
  const telegram = { send: async (id, text) => sent.push({ id, text }),
    call: async (method) => method === "getMe" ? { id: 99, can_read_all_group_messages: false } : { status: "member" } };
  const profiles = createProfiles({ config, registry, telegram });
  const router = createRouter({ config, registry, profiles, telegram });
  const key = "discussion_job:-1";
  try {
    const ctx = profiles.register({ id: 1 });
    profiles.subscribe(-1, 1);
    // An unregistered group participant must still be collected for its subscriber.
    await router.handle({ update_id: 1, message: { message_id: 1, from: { id: 2 },
      chat: { id: -1, type: "group" }, text: "Готовим релиз" } });
    assert.equal(ctx.knowledge.discussion(-1).length, 1);
    ctx.store.set(key, JSON.stringify({ first: Date.now() - 60001, last: Date.now() - 16000 }));
    let attempts = 0;
    ctx.skills.tick = async () => {};
    ctx.skills.analyze = async () => { attempts++; throw new Error("Model unavailable"); };
    await router.tick();
    let job = JSON.parse(ctx.store.get(key));
    assert.equal(job.attempts, 1);
    assert.ok(job.retryAt > Date.now());
    await router.tick();
    assert.equal(attempts, 1);
    await router.handle({ update_id: 2, message: { message_id: 2, from: { id: 1 },
      chat: { id: 1, type: "private" }, text: "/status" } });
    assert.match(sent.at(-1).text, /Подключено групп: 1/);
    assert.match(sent.at(-1).text, /сообщений в буфере 1/);
    assert.match(sent.at(-1).text, /ошибка анализа, повтор/);
    assert.match(sent.at(-1).text, /ограничено privacy mode/);
    assert.equal(ctx.knowledge.discussion("private").length, 0);
    ctx.store.set(key, JSON.stringify({ ...job, retryAt: 0 }));
    ctx.skills.analyze = async () => {
      attempts++;
      await router.handle({ update_id: 3, message: { message_id: 3, from: { id: 2 },
        chat: { id: -1, type: "group" }, text: "Проверить тесты" } });
    };
    await router.tick();
    assert.equal(attempts, 2);
    assert.ok(ctx.store.get(key), "concurrent message must retain its analysis job");
    ctx.skills.analyze = async () => { attempts++; };
    job = JSON.parse(ctx.store.get(key));
    ctx.store.set(key, JSON.stringify({ ...job, first: Date.now() - 60001, retryAt: 0 }));
    await router.tick();
    assert.equal(attempts, 3);
    assert.equal(ctx.store.get(key), "");
    assert.ok(ctx.store.get("discussion_analyzed:-1"));
  } finally {
    profiles.close(); registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("group status and summary commands route explicitly and cannot expose another chat or private profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "personal-group-summary-"));
  const registry = new Store(":memory:"), sent = [];
  const config = { dataDir: directory, maxProfiles: 2, timeZone: "UTC", vaultKey: "", botUsername: "test_bot" };
  const telegram = { send: async (id, text) => sent.push({ id, text }),
    call: async method => method === "getMe" ? { id: 99 } : { status: "administrator" } };
  const profiles = createProfiles({ config, registry, telegram });
  const router = createRouter({ config, registry, profiles, telegram });
  const message = (id, chat, text, type="group") => ({ update_id:id, message: {
    message_id:id, from:{ id:1 }, chat:{ id:chat,type }, text,
  } });
  try {
    const ctx = profiles.register({ id:1 });
    profiles.subscribe(-1, 1); profiles.subscribe(-2, 1);
    ctx.knowledge.observe(-1, 1, 1, "Согласовали релиз");
    ctx.knowledge.observe(-2, 1, 1, "Другой проект");
    ctx.knowledge.observe("private", 1, 1, "Личная заметка");
    ctx.skills.answer = async (chat, text) => {
      assert.equal(chat, -1);
      assert.match(text, /Составь сводку/);
      return "Релиз согласован";
    };
    await router.handle(message(10, -1, "/summary@test_bot"));
    assert.equal(sent.at(-1).text, "Релиз согласован");
    assert.equal(ctx.knowledge.discussion(-1).length, 1);
    await router.handle(message(11, -1, "/status@test_bot"));
    assert.match(sent.at(-1).text, /Получение обычных сообщений: разрешено/);
    assert.doesNotMatch(sent.at(-1).text, /Личка|Группа -2|Подключено групп/);
    ctx.skills.answer = async chat => { assert.equal(chat,null); return "Личная сводка"; };
    await router.handle(message(12, 1, "/summary@test_bot", "private"));
    assert.equal(sent.at(-1).text, "Личная сводка");
    profiles.subscribe(-3, 1);
    await router.handle(message(13, -3, "/summary@test_bot"));
    assert.match(sent.at(-1).text, /Пока нет сохранённых/);
  } finally { profiles.close(); registry.close(); rmSync(directory,{recursive:true,force:true}); }
});
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
