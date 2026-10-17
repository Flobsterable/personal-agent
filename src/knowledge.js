import { randomUUID, createHash } from "node:crypto";

// One database per profile. Raw conversations have a short, bounded lifetime;
// durable decisions and their audit trail are never silently evicted.
export class Knowledge {
  constructor(store) {
    this.db = store.db;
    this.db.function("fold", (value) =>
      String(value || "").toLocaleLowerCase("ru"),
    );
    this.db.exec(`PRAGMA max_page_count=16384;
      CREATE TABLE IF NOT EXISTS discussion(chat TEXT,msg INTEGER,sender TEXT,text TEXT,created INTEGER,PRIMARY KEY(chat,msg));
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,chat TEXT,kind TEXT,title TEXT,description TEXT,start TEXT,end TEXT,location TEXT,status TEXT,evidence TEXT,calendar TEXT,remote TEXT,created INTEGER,updated INTEGER);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,record TEXT,action TEXT,description TEXT,created INTEGER);
      CREATE TABLE IF NOT EXISTS delivery(key TEXT PRIMARY KEY,status TEXT,created INTEGER);
      UPDATE delivery SET status='uncertain' WHERE status='sending';`);
  }
  capacity() {
    return (
      this.db.prepare("SELECT count(*) AS n FROM audit").get().n < 5000 &&
      this.db.prepare("SELECT count(*) AS n FROM records").get().n < 2000
    );
  }
  observe(chat, msg, sender, text, now = Date.now()) {
    if (
      !this.db
        .prepare("SELECT chat FROM discussion WHERE chat=? LIMIT 1")
        .get(String(chat)) &&
      this.db.prepare("SELECT count(DISTINCT chat) AS n FROM discussion").get()
        .n >= 32
    )
      throw new Error("Discussion quota reached");
    this.db
      .prepare(
        "INSERT INTO discussion VALUES(?,?,?,?,?) ON CONFLICT(chat,msg) DO UPDATE SET text=excluded.text,created=excluded.created",
      )
      .run(String(chat), msg, String(sender), text.slice(0, 4000), now);
    this.db
      .prepare(
        "DELETE FROM discussion WHERE chat=? AND msg NOT IN (SELECT msg FROM discussion WHERE chat=? ORDER BY created DESC LIMIT 80)",
      )
      .run(String(chat), String(chat));
  }
  discussion(chat) {
    return this.db
      .prepare(
        "SELECT msg,sender,text FROM discussion WHERE chat=? ORDER BY created,msg",
      )
      .all(String(chat));
  }
  list(chat = null, kind = null) {
    return this.db
      .prepare(
        "SELECT * FROM records WHERE (? IS NULL OR chat=?) AND (? IS NULL OR kind=?) ORDER BY updated DESC LIMIT 100",
      )
      .all(
        chat == null ? null : String(chat),
        chat == null ? null : String(chat),
        kind,
        kind,
      );
  }
  record(id, chat) {
    return this.db
      .prepare("SELECT * FROM records WHERE id=? AND chat=?")
      .get(id, String(chat));
  }
  upsert(chat, change, evidence, now = Date.now()) {
    if (!this.capacity())
      throw new Error("Memory quota reached; export history before continuing");
    const old = change.id
      ? this.record(change.id, chat)
      : this.db
          .prepare("SELECT * FROM records WHERE chat=? AND kind=? AND title=?")
          .get(String(chat), change.kind, change.title);
    if (change.id && !old) throw new Error("Record outside this discussion");
    const id = old?.id || randomUUID();
    const data = {
      kind: old?.kind || change.kind,
      title: change.title || old?.title,
      description: change.description ?? old?.description ?? "",
      start: change.start ?? old?.start ?? "",
      end: change.end ?? old?.end ?? "",
      location: change.location ?? old?.location ?? "",
      status: change.status || old?.status || "planned",
    };
    if (
      !["meeting", "task", "decision"].includes(data.kind) ||
      !["planned", "done", "cancelled", "needs_clarification"].includes(
        data.status,
      ) ||
      typeof data.title !== "string" ||
      !data.title.trim() ||
      data.title.length > 300 ||
      [data.description, data.location, data.start, data.end].some(
        (x) => typeof x !== "string" || x.length > 2000,
      )
    )
      throw new Error("Invalid record");
    if (old && Object.entries(data).every(([k, v]) => old[k] === v))
      return { record: old, changed: false };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,start=excluded.start,end=excluded.end,location=excluded.location,status=excluded.status,evidence=excluded.evidence,updated=excluded.updated",
        )
        .run(
          id,
          String(chat),
          data.kind,
          data.title,
          data.description,
          data.start,
          data.end,
          data.location,
          data.status,
          JSON.stringify(evidence),
          old?.calendar || "",
          old?.remote || "",
          old?.created || now,
          now,
        );
      this.db
        .prepare(
          "INSERT INTO audit(record,action,description,created) VALUES(?,?,?,?)",
        )
        .run(
          id,
          old ? "changed" : "created",
          JSON.stringify({
            before: old
              ? {
                  title: old.title,
                  start: old.start,
                  end: old.end,
                  status: old.status,
                  location: old.location,
                }
              : null,
            after: data,
            evidence,
          }),
          now,
        );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { record: this.record(id, chat), changed: true };
  }
  bind(id, calendar, remote) {
    this.db
      .prepare("UPDATE records SET calendar=?,remote=? WHERE id=?")
      .run(calendar, remote, id);
  }
  query({
    chat = null,
    kind = null,
    status = null,
    period = "",
    text = "",
    offset = 0,
  } = {}) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 2000 ||
      typeof text !== "string" ||
      text.length > 200 ||
      typeof period !== "string" ||
      !/^([0-9]{4}(-[0-9]{2})?)?$/.test(period)
    )
      throw new Error("Invalid memory query");
    const where =
      "(? IS NULL OR chat=?) AND (? IS NULL OR kind=?) AND (? IS NULL OR status=?) AND start LIKE ? AND (fold(title) LIKE ? OR fold(description) LIKE ?)";
    const p = [
      chat == null ? null : String(chat),
      chat == null ? null : String(chat),
      kind,
      kind,
      status,
      status,
      period + "%",
      "%" + text.toLocaleLowerCase("ru") + "%",
      "%" + text.toLocaleLowerCase("ru") + "%",
    ];
    const total = this.db
      .prepare("SELECT count(*) AS n FROM records WHERE " + where)
      .get(...p).n;
    const items = this.db
      .prepare(
        "SELECT * FROM records WHERE " +
          where +
          " ORDER BY start,created LIMIT 50 OFFSET ?",
      )
      .all(...p, offset);
    return {
      items,
      total,
      nextOffset: offset + items.length < total ? offset + items.length : null,
    };
  }
  history(chat = null) {
    return this.db
      .prepare(
        "SELECT a.* FROM audit a JOIN records r ON r.id=a.record WHERE (? IS NULL OR r.chat=?) ORDER BY a.id DESC LIMIT 100",
      )
      .all(
        chat == null ? null : String(chat),
        chat == null ? null : String(chat),
      );
  }
  export() {
    return {
      records: this.db.prepare("SELECT * FROM records ORDER BY created").all(),
      history: this.db.prepare("SELECT * FROM audit ORDER BY id").all(),
    };
  }
  claim(key) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO delivery VALUES(?,'sending',?)")
        .run(key, Date.now()).changes === 1
    );
  }
  delivery(key, status) {
    this.db
      .prepare("UPDATE delivery SET status=? WHERE key=?")
      .run(status, key);
  }
  signature(record) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          record.id,
          record.title,
          record.start,
          record.end,
          record.location,
          record.status,
        ]),
      )
      .digest("hex");
  }
  maintain(days, now = Date.now()) {
    this.db
      .prepare("DELETE FROM discussion WHERE created<?")
      .run(now - days * 86400000);
    // Completed technical bookkeeping is expendable. Ambiguous side effects remain.
    this.db
      .prepare("DELETE FROM delivery WHERE created<? AND status='done'")
      .run(now - 90 * 86400000);
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
}
