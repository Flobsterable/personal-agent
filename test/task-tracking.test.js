import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { Knowledge } from "../src/knowledge.js";
import { createSkills } from "../src/skills.js";
import { createEngine } from "../src/engine.js";
import { readSettings } from "../src/settings.js";

test("group task becomes a physical task once and explicit completion closes both representations", async () => {
  const store = new Store(":memory:"), knowledge = new Knowledge(store);
  try {
    const text = "Нужно купить продукты в выходные";
    knowledge.observe(-1, 1, "1", text);
    let change = { kind: "task", title: "Купить продукты в выходные", status: "planned", evidence: [{ msg: 1, quote: text }] };
    const skills = createSkills({ config: { ownerId: "1" }, knowledge,
      getSettings: () => readSettings(store), notify: async () => {},
      decide: async () => ({ action: "extract", args: { changes: [change] } }),
    });
    await skills.analyze(-1);
    const record = knowledge.list(-1)[0];
    assert.equal(store.tasks()[0].record_id, record.id);
    assert.equal(store.tasks()[0].text, "Купить продукты в выходные");
    assert.equal(record.start, "", "a deadline is not required to create a task");
    await skills.analyze(-1);
    assert.equal(store.tasks().length, 1);
    assert.equal(knowledge.history().length, 1);
    knowledge.observe(-1, 2, "1", "Продукты куплены");
    change = { ...change, id: record.id, status: "done", description: "Продукты куплены", evidence: [{ msg: 2, quote: "Продукты куплены" }] };
    await skills.analyze(-1);
    assert.equal(store.tasks().length, 0);
    assert.equal(knowledge.record(record.id, -1).status, "done");
    assert.equal(knowledge.history().length, 2);
    await skills.analyze(-1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM tasks").get().n, 1);
  } finally { store.close(); }
});

test("upgrading the old task schema preserves legacy tasks and backfills extracted tasks idempotently", () => {
  const directory = mkdtempSync(join(tmpdir(), "task-upgrade-")), path = join(directory, "profile.sqlite");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,text TEXT,done INTEGER,created INTEGER); INSERT INTO tasks VALUES('legacy','Старое дело',0,1)");
  old.close();
  let store = new Store(path), knowledge = new Knowledge(store);
  try {
    const saved = knowledge.upsert(-1, { kind: "task", title: "Продукты", status: "planned" }, []);
    store.db.prepare("DELETE FROM tasks WHERE record_id=?").run(saved.record.id);
    store.close();
    store = new Store(path); knowledge = new Knowledge(store);
    assert.equal(store.tasks().length, 2);
    assert.equal(store.tasks().find(t => t.id === "legacy").text, "Старое дело");
    assert.equal(store.tasks().find(t => t.record_id === saved.record.id).id, saved.record.id);
    new Knowledge(store);
    assert.equal(store.tasks().length, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("task-list capacity rolls back the extracted record and its history atomically", () => {
  const store = new Store(":memory:"), knowledge = new Knowledge(store);
  try {
    const insert = store.db.prepare("INSERT INTO tasks(id,text,done,created) VALUES(?,?,0,1)");
    for (let i = 0; i < 2000; i++) insert.run(String(i), "Дело " + i);
    assert.throws(() => knowledge.upsert(-1, { kind: "task", title: "Новая", status: "planned" }, []), /Task quota/);
    assert.equal(knowledge.list().length, 0);
    assert.equal(knowledge.history().length, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM tasks").get().n, 2000);
  } finally { store.close(); }
});

test("explicit task and done commands save and close a task without model calls", async () => {
  const store = new Store(":memory:"), knowledge = new Knowledge(store), sent = [];
  const engine = createEngine({ config: { ownerId: "1" }, store, knowledge,
    telegram: { send: async (id, text) => sent.push(text) },
    askAgent: async () => { throw new Error("Model must not be called"); },
  });
  const message = (id, text) => ({ update_id: id, message: { message_id: id, from: { id: 1 }, chat: { id: 1, type: "private" }, text } });
  try {
    await engine.handle(message(1, "/task@test_bot Купить продукты"));
    const task = store.tasks()[0];
    assert.ok(task.record_id);
    assert.match(sent.at(-1), /Задача сохранена/);
    await engine.handle(message(2, "/tasks"));
    assert.equal(sent.at(-1).split("Купить продукты").length - 1, 1);
    await engine.handle(message(3, "/done " + task.id + " Продукты куплены"));
    assert.equal(store.tasks().length, 0);
    assert.equal(knowledge.record(task.record_id, "private").status, "done");
    assert.equal(knowledge.history().length, 2);
  } finally { store.close(); }
});

test("private add_task and done_task tools keep the task and discussion record consistent", async () => {
  const store = new Store(":memory:"), knowledge = new Knowledge(store);
  let taskId;
  const engine = createEngine({ config: { ownerId: "1" }, store, knowledge,
    telegram: { send: async () => {} }, authorize: async () => true,
    askAgent: async (config, db, text, { execute }) => {
      if (!taskId) { const task = await execute("add_task", { text: "Купить продукты" }); taskId = task.id; }
      else assert.equal((await execute("done_task", { id: taskId })).done, true);
      return { answer: "Готово", drafts: [] };
    },
  });
  try {
    for (const [i, text] of ["Добавь задачу купить продукты", "Продукты куплены"].entries())
      await engine.handle({ update_id: i, message: { message_id: i, from: { id: 1 }, chat: { id: 1, type: "private" }, text } });
    assert.equal(store.tasks().length, 0);
    assert.equal(knowledge.record(taskId, "private").status, "done");
    assert.match(knowledge.record(taskId, "private").description, /Продукты куплены/);
  } finally { store.close(); }
});
