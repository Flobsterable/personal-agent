import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA journal_size_limit=4194304;
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts(chat_id TEXT PRIMARY KEY,username TEXT,name TEXT,alias TEXT,active INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY,chat_id TEXT,text TEXT,created INTEGER);
    CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,role TEXT,content TEXT);
    CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,text TEXT,created INTEGER);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,text TEXT,done INTEGER,created INTEGER);
    CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,text TEXT,due INTEGER,status TEXT);
    CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,chat_id TEXT,text TEXT,status TEXT,expires INTEGER,message_id INTEGER);
    UPDATE outbox SET status='uncertain' WHERE status='sending';
    UPDATE reminders SET status='uncertain' WHERE status='sending';`);
  }
  close() {
    this.db.close();
  }
  maintain(now = Date.now()) {
    this.db.exec(
      "DELETE FROM updates WHERE status='done' AND id NOT IN (SELECT id FROM updates ORDER BY id DESC LIMIT 2000)",
    );
    this.db
      .prepare(
        "DELETE FROM inbox WHERE created<? OR id NOT IN (SELECT id FROM inbox ORDER BY id DESC LIMIT 200)",
      )
      .run(now - 30 * 86400000);
    this.db
      .prepare(
        "DELETE FROM outbox WHERE expires<? AND status IN ('sent','failed','cancelled','pending')",
      )
      .run(now - 90 * 86400000);
    this.db
      .prepare("DELETE FROM reminders WHERE due<? AND status='sent'")
      .run(now - 90 * 86400000);
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
  checkQuota(table) {
    if (!["notes", "tasks", "reminders"].includes(table))
      throw new Error("Invalid table");
    if (this.db.prepare("SELECT count(*) AS n FROM " + table).get().n >= 2000)
      throw new Error(
        "Memory quota reached; export or remove records before continuing",
      );
  }
  get(key) {
    return this.db.prepare("SELECT value FROM kv WHERE key=?").get(key)?.value;
  }
  set(key, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO kv VALUES(?,?)")
      .run(key, String(value));
  }
  beginUpdate(id) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO updates VALUES(?,'processing')")
        .run(id).changes === 1
    );
  }
  finishUpdate(id) {
    this.db.prepare("UPDATE updates SET status='done' WHERE id=?").run(id);
  }
  remember(role, content) {
    this.db
      .prepare("INSERT INTO history(role,content) VALUES(?,?)")
      .run(role, content);
    this.db.exec(
      "DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 20)",
    );
  }
  history() {
    return this.db
      .prepare("SELECT role,content FROM history ORDER BY id")
      .all();
  }
  clearHistory() {
    this.db.exec("DELETE FROM history");
  }
  register(chat) {
    this.db
      .prepare(
        "INSERT INTO contacts(chat_id,username,name,active) VALUES(?,?,?,1) ON CONFLICT(chat_id) DO UPDATE SET username=excluded.username,name=excluded.name,active=1",
      )
      .run(String(chat.id), chat.username || "", chat.first_name || "");
  }
  unsubscribe(id) {
    this.db
      .prepare("UPDATE contacts SET active=0 WHERE chat_id=?")
      .run(String(id));
  }
  contacts() {
    return this.db
      .prepare("SELECT * FROM contacts WHERE active=1 ORDER BY name LIMIT 200")
      .all();
  }
  contact(id) {
    return this.db
      .prepare("SELECT * FROM contacts WHERE chat_id=? AND active=1")
      .get(String(id));
  }
  alias(id, name) {
    return (
      this.db
        .prepare("UPDATE contacts SET alias=? WHERE chat_id=? AND active=1")
        .run(name, id).changes === 1
    );
  }
  addIncoming(chatId, text) {
    this.db
      .prepare("INSERT INTO inbox(chat_id,text,created) VALUES(?,?,?)")
      .run(String(chatId), text, Date.now());
  }
  inbox() {
    return this.db
      .prepare("SELECT * FROM inbox ORDER BY id DESC LIMIT 30")
      .all();
  }
  addNote(text) {
    this.checkQuota("notes");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO notes VALUES(?,?,?)")
      .run(id, text, Date.now());
    return { id, text };
  }
  notes() {
    return this.db
      .prepare("SELECT * FROM notes ORDER BY created DESC LIMIT 200")
      .all();
  }
  addTask(text) {
    this.checkQuota("tasks");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO tasks VALUES(?,?,0,?)")
      .run(id, text, Date.now());
    return { id, text };
  }
  tasks() {
    return this.db
      .prepare("SELECT * FROM tasks WHERE done=0 ORDER BY created LIMIT 200")
      .all();
  }
  doneTask(id) {
    return (
      this.db.prepare("UPDATE tasks SET done=1 WHERE id=? AND done=0").run(id)
        .changes === 1
    );
  }
  addReminder(text, due) {
    this.checkQuota("reminders");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO reminders VALUES(?,?,?,'pending')")
      .run(id, text, due);
    return { id, text, due };
  }
  reminders() {
    return this.db
      .prepare(
        "SELECT * FROM reminders WHERE status!='sent' ORDER BY due LIMIT 200",
      )
      .all();
  }
  due(now) {
    return this.db
      .prepare(
        "SELECT * FROM reminders WHERE due<=? AND status='pending' ORDER BY due LIMIT 20",
      )
      .all(now);
  }
  claimReminder(id) {
    return (
      this.db
        .prepare(
          "UPDATE reminders SET status='sending' WHERE id=? AND status='pending'",
        )
        .run(id).changes === 1
    );
  }
  reminderStatus(id, status) {
    this.db.prepare("UPDATE reminders SET status=? WHERE id=?").run(status, id);
  }
  draft(chatId, text, now = Date.now()) {
    if (!this.contact(chatId))
      throw new Error("Recipient must start the bot first");
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare("INSERT INTO outbox VALUES(?,?,?,'pending',?,NULL)")
      .run(id, String(chatId), text, now + 15 * 60000);
    return { id, chatId: String(chatId), text };
  }
  outbox() {
    return this.db
      .prepare("SELECT * FROM outbox ORDER BY rowid DESC LIMIT 30")
      .all();
  }
  outgoing(id) {
    return this.db.prepare("SELECT * FROM outbox WHERE id=?").get(id);
  }
  cancel(id) {
    return (
      this.db
        .prepare(
          "UPDATE outbox SET status='cancelled' WHERE id=? AND status='pending'",
        )
        .run(id).changes === 1
    );
  }
  claim(id, now = Date.now()) {
    return (
      this.db
        .prepare(
          "UPDATE outbox SET status='sending' WHERE id=? AND status='pending' AND expires>? AND chat_id IN (SELECT chat_id FROM contacts WHERE active=1)",
        )
        .run(id, now).changes === 1
    );
  }
  sent(id, messageId) {
    this.db
      .prepare("UPDATE outbox SET status='sent',message_id=? WHERE id=?")
      .run(messageId, id);
  }
  sendFailed(id, definite) {
    this.db
      .prepare("UPDATE outbox SET status=? WHERE id=?")
      .run(definite ? "failed" : "uncertain", id);
  }
}
