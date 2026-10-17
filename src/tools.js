export const toolDescription = `Доступные действия, строго JSON {action,args}:
contacts {}, inbox {}, notes {}, add_note {text}, tasks {}, add_task {text}, done_task {id}, reminders {}, add_reminder {text,at:ISO8601 с Z или явным часовым смещением}, draft_message {chatId,text}, outbox {}, answer {text}.
calendar_list {}, calendar_events {calendarId,from:ISO8601,to:ISO8601}, calendar_create {calendarId,title,start:ISO8601,end:ISO8601,description}.\nМожно выполнить одно действие за шаг. draft_message только создаёт черновик: отправку владелец подтверждает отдельно. Нет действий send, approve, execute, shell, read_file.`;
const text = (value, max = 4000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid text");
  return value.trim();
};
export function runTool(store, action, args = {}, now = Date.now()) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Invalid arguments");
  switch (action) {
    case "contacts":
      return store.contacts();
    case "inbox":
      return store.inbox();
    case "notes":
      return store.notes();
    case "tasks":
      return store.tasks();
    case "reminders":
      return store.reminders();
    case "outbox":
      return store.outbox();
    case "add_note":
      return store.addNote(text(args.text));
    case "add_task":
      return store.addTask(text(args.text));
    case "done_task":
      return { done: store.doneTask(text(args.id, 80)) };
    case "add_reminder": {
      const at = text(args.at, 50);
      if (!/(Z|[+-][0-9]{2}:[0-9]{2})$/.test(at))
        throw new Error("Use an explicit time zone");
      const due = Date.parse(at);
      if (!Number.isFinite(due) || due <= now || due > now + 366 * 86400000)
        throw new Error("Reminder must be in the next 366 days");
      return store.addReminder(text(args.text), due);
    }
    case "draft_message":
      return store.draft(text(args.chatId, 30), text(args.text, 3500), now);
    default:
      throw new Error("Unknown action");
  }
}
