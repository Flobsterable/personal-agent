import { readFileSync } from "node:fs";

// The Telegram runtime loads the skill itself; it is not a Codex-only install.
export const taskTrackingInstructions = readFileSync(
  new URL("../skills/task-tracking/SKILL.md", import.meta.url), "utf8",
).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");

export function syncTaskRecord(db, record) {
  if (record.kind !== "task") return;
  const old = db.prepare("SELECT id FROM tasks WHERE record_id=?").get(record.id);
  if (!old && db.prepare("SELECT count(*) AS n FROM tasks").get().n >= 2000)
    throw new Error("Task quota reached");
  db.prepare(`INSERT INTO tasks(id,text,done,created,record_id) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET text=excluded.text,done=excluded.done,record_id=excluded.record_id`)
    .run(old?.id || record.id, record.title,
      ["done", "cancelled"].includes(record.status) ? 1 : 0, record.created, record.id);
}

export function taskList(store, knowledge = null) {
  return store.tasks().map(task => {
    const record = knowledge && task.record_id
      ? knowledge.db.prepare("SELECT * FROM records WHERE id=?").get(task.record_id) : null;
    return { ...task, status: record?.status || "planned", start: record?.start || "",
      description: record?.description || "", source_chat: record?.chat || "private" };
  });
}

export function formatTasks(tasks) {
  if (!tasks.length) return "Открытых задач пока нет.";
  const lines = [];
  let shown = 0;
  for (const task of tasks) {
    const line = `${shown + 1}. ${task.text}${task.start ? " · " + task.start : ""}\nID: ${task.id}`;
    if (lines.join("\n\n").length + line.length > 3400) break;
    lines.push(line); shown++;
  }
  if (shown < tasks.length) lines.push(`Показано ${shown} из ${tasks.length} задач.`);
  lines.push("Закрыть задачу: /done ID Описание результата");
  return lines.join("\n\n");
}
