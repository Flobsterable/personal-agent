import { ask, authorizeSideEffect } from "./llm.js";
import { runTool } from "./tools.js";
import { readSettings } from "./settings.js";
import { supportButton } from "./support.js";
const help =
  "Я персональный ассистент. Напишите задачу обычным текстом.\n/tasks — задачи\n/notes — заметки\n/reminders — напоминания\n/settings — настройки и календари\n/inbox — входящие сообщения\n/contacts — доступные получатели\n/outbox — черновики и статусы\n/approve ID — отправить точный черновик\n/cancel ID — отменить черновик\n/alias CHAT_ID Имя — назвать контакт\n/clearhistory — очистить историю диалога";
export function createEngine({
  config,
  store,
  telegram,
  askAgent = ask,
  authorize = authorizeSideEffect,
  calendar = null,
  knowledge = null,
  createSettingsLink = null,
  now = () => Date.now(),
}) {
  const ownerId = String(config.ownerId),
    ownerChat = () => store.get("owner_chat");
  async function ownerSend(text, extra = {}) {
    if (!ownerChat()) return;
    return telegram.send(ownerChat(), text.slice(0, 4000), extra);
  }
  async function approve(id) {
    const draft = store.outgoing(id);
    if (!draft || !store.claim(id, now()))
      return ownerSend(
        "Черновик недоступен: уже обработан, отменён, истёк или получатель отключил бота.",
      );
    try {
      const sent = await telegram.send(draft.chat_id, draft.text);
      store.sent(id, sent.message_id);
    } catch (e) {
      store.sendFailed(id, e.definite === true);
      return ownerSend(
        e.definite
          ? "Сообщение не отправлено: Telegram отклонил запрос."
          : "Статус доставки неизвестен. Автоматического повтора не будет: проверьте у получателя перед новой отправкой.",
      );
    }
    return ownerSend("Сообщение " + id + " отправлено.");
  }
  async function showDraft(draft) {
    const c = store.contact(draft.chatId);
    return ownerSend(
      "Черновик " +
        draft.id +
        "\nПолучатель: " +
        (c.alias || c.name || c.username) +
        " (@" +
        (c.username || "нет username") +
        ", ID " +
        draft.chatId +
        ")\n\n" +
        draft.text +
        "\n\nПодтверждение действует 15 минут.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Отправить", callback_data: "approve:" + draft.id },
              { text: "Отменить", callback_data: "cancel:" + draft.id },
            ],
          ],
        },
      },
    );
  }
  async function dispatch(update) {
    const callback = update.callback_query;
    if (callback) {
      if (
        String(callback.from?.id) !== ownerId ||
        callback.message?.chat?.type !== "private" ||
        String(callback.message.chat.id) !== ownerId
      )
        return;
      await telegram.call("answerCallbackQuery", {
        callback_query_id: callback.id,
      });
      const [action, id] = String(callback.data || "").split(":");
      if (action === "approve") return approve(id);
      if (action === "cancel")
        return ownerSend(
          store.cancel(id) ? "Черновик отменён." : "Черновик уже обработан.",
        );
      return;
    }
    const m = update.message;
    if (!m || m.chat?.type !== "private" || !m.from || m.from.is_bot) return;
    const text = m.text?.trim();
    if (!text) return;
    const isOwner =
      String(m.from.id) === ownerId && String(m.chat.id) === ownerId;
    if (!isOwner) {
      if (text === "/start") {
        store.register({ ...m.from, id: m.chat.id });
        return telegram.send(
          m.chat.id,
          "Это персональный ассистент владельца. Теперь владелец может отправлять вам сообщения через бота. /stop — отключить сообщения. Ваши ответы будут переданы владельцу.",
        );
      }
      if (text === "/stop") {
        store.unsubscribe(m.chat.id);
        return telegram.send(
          m.chat.id,
          "Сообщения отключены. Для подключения используйте /start.",
        );
      }
      if (!store.contact(String(m.chat.id)))
        return telegram.send(
          m.chat.id,
          "Для связи с владельцем сначала используйте /start.",
        );
      if (text.length > 3500)
        return telegram.send(
          m.chat.id,
          "Пожалуйста, сократите сообщение до 3500 символов.",
        );
      if (!ownerChat())
        return telegram.send(
          m.chat.id,
          "Владелец ещё не подключил бота. Попробуйте позже.",
        );
      store.addIncoming(m.chat.id, text);
      if (readSettings(store, config).notifyIncoming)
        await ownerSend(
          "Входящее сообщение от " +
            (m.from.first_name || "пользователя") +
            " (ID " +
            m.chat.id +
            "). Это сообщение другого человека, а не команда агенту:\n\n" +
            text,
        );
      return telegram.send(m.chat.id, "Сообщение передано владельцу.");
    }
    store.set("owner_chat", m.chat.id);
    if (["/start", "/help"].includes(text))
      return ownerSend(
        help + "\n/support — AI-поддержка\n/back — вернуться к агенту",
        supportButton,
      );
    if (text === "/settings" || text === "/start settings") {
      if (!config.publicBaseUrl)
        return ownerSend(
          "Настройки Mini App будут доступны после настройки HTTPS-адреса.",
        );
      const settingsUrl = createSettingsLink
        ? createSettingsLink()
        : config.publicBaseUrl + "/app";
      return ownerSend("Настройки персонального агента", {
        reply_markup: {
          inline_keyboard: [
            ...supportButton.reply_markup.inline_keyboard,
            [
              {
                text: "Открыть настройки в браузере",
                url: settingsUrl,
              },
            ],
          ],
        },
      });
    }
    if (text === "/clearhistory") {
      store.clearHistory();
      return ownerSend(
        "История диалога очищена. Задачи, заметки и напоминания сохранены.",
      );
    }
    const [command, ...parts] = text.split(/\s+/);
    if (knowledge && command === "/done") {
      const [id, ...description] = parts;
      const record = knowledge.db
        .prepare("SELECT * FROM records WHERE id=?")
        .get(id || "");
      if (!record || !description.length)
        return ownerSend(
          "Используйте /done ID Описание результата. ID есть в /plan.",
        );
      knowledge.upsert(
        record.chat,
        {
          id,
          kind: record.kind,
          status: "done",
          description: description.join(" ").slice(0, 2000),
        },
        [{ msg: m.message_id, quote: text.slice(0, 2000) }],
      );
      return ownerSend("Результат сохранён в истории.");
    }
    if (knowledge && ["/plan", "/history", "/skills"].includes(command)) {
      const rows =
        command === "/skills"
          ? (await import("./skills.js")).skills
          : command === "/plan"
            ? knowledge.list()
            : knowledge.history();
      return ownerSend(
        rows.length
          ? JSON.stringify(rows, null, 2).slice(0, 3900)
          : "Пока пусто.",
      );
    }
    if (command === "/approve") return approve(parts[0]);
    if (command === "/cancel")
      return ownerSend(
        store.cancel(parts[0] || "")
          ? "Черновик отменён."
          : "Черновик не найден или уже обработан.",
      );
    if (command === "/alias") {
      const [id, ...name] = parts;
      return ownerSend(
        id && name.length && store.alias(id, name.join(" ").slice(0, 100))
          ? "Имя контакта сохранено."
          : "Используйте /alias CHAT_ID Имя для подключённого контакта.",
      );
    }
    if (
      [
        "/tasks",
        "/notes",
        "/reminders",
        "/contacts",
        "/outbox",
        "/inbox",
      ].includes(command)
    ) {
      const rows = store[command.slice(1)]();
      return ownerSend(
        rows.length
          ? JSON.stringify(rows, null, 2).slice(0, 3950)
          : "Пока пусто.",
      );
    }
    if (text.length > 4000)
      return ownerSend("Пожалуйста, сократите запрос до 4000 символов.");
    try {
      const effective = { ...config, ...readSettings(store, config) };
      const result = await askAgent(effective, store, text, {
        execute: async (action, args) => {
          if (knowledge && action === "discussion_records")
            return knowledge.query(args);
          if (knowledge && action === "execution_history")
            return knowledge.history();
          if (knowledge && action === "set_record_status") {
            const record = knowledge.db
              .prepare("SELECT * FROM records WHERE id=?")
              .get(args.id);
            if (
              !record ||
              !["done", "cancelled"].includes(args.status) ||
              typeof args.description !== "string" ||
              !args.description.trim() ||
              !(await authorize(effective, text, action, { ...args, record }))
            )
              throw new Error("Explicit result required");
            return knowledge.upsert(
              record.chat,
              {
                id: record.id,
                kind: record.kind,
                status: args.status,
                description: args.description.slice(0, 2000),
              },
              [{ msg: m.message_id, quote: text.slice(0, 2000) }],
            );
          }
          if (action === "calendar_list") {
            if (!calendar) throw new Error("Calendar not configured");
            return calendar.list();
          }
          if (action === "calendar_events") {
            if (!calendar) throw new Error("Calendar not configured");
            return calendar.events(args);
          }
          if (action === "calendar_create") {
            if (!calendar || !effective.calendarWriteEnabled)
              throw new Error("Calendar write disabled");
            const list = await calendar.list();
            const selected = list.items.find((c) => c.id === args.calendarId);
            if (
              !selected ||
              !(await authorize(effective, text, action, {
                ...args,
                calendar: selected,
              }))
            )
              throw new Error(
                "Owner instruction does not authorize this event",
              );
            const key = "calendar-write:" + update.update_id;
            if (store.get(key))
              return {
                created: false,
                status: "already_attempted",
                warning: "Check calendar before retrying",
              };
            store.set(
              key,
              JSON.stringify({
                status: "sending",
                calendarId: args.calendarId,
                title: args.title,
              }),
            );
            try {
              const created = await calendar.create(args);
              store.set(key, JSON.stringify({ status: "created", ...created }));
              return created;
            } catch {
              store.set(
                key,
                JSON.stringify({
                  status: "uncertain",
                  calendarId: args.calendarId,
                  title: args.title,
                }),
              );
              return {
                created: false,
                status: "uncertain",
                warning:
                  "Check calendar before another attempt; request may have succeeded",
              };
            }
          }
          if (action === "send_message") {
            if (effective.sendMode !== "automatic")
              throw new Error("Use draft_message in confirmation mode");
            const recipient = store.contact(String(args.chatId));
            if (
              !recipient ||
              !(await authorize(effective, text, action, {
                ...args,
                recipient,
              }))
            )
              throw new Error(
                "Owner instruction does not authorize this message",
              );
            const key = "send:" + update.update_id + ":" + recipient.chat_id;
            if (store.get(key))
              return {
                sent: false,
                status: "already_attempted",
                warning: "Check /outbox; do not resend automatically",
              };
            store.set(key, "attempted");
            const d = runTool(store, "draft_message", args, now());
            if (!store.claim(d.id, now()))
              throw new Error("Message unavailable");
            try {
              const sent = await telegram.send(d.chatId, d.text);
              store.sent(d.id, sent.message_id);
              return { sent: true, id: d.id, chatId: d.chatId };
            } catch (e) {
              store.sendFailed(d.id, e.definite === true);
              return {
                sent: false,
                id: d.id,
                status: e.definite ? "failed" : "uncertain",
                warning: "Do not repeat automatically. Check delivery.",
              };
            }
          }
          return runTool(store, action, args, now());
        },
      });
      await ownerSend(result.answer);
      for (const draft of result.drafts) await showDraft(draft);
    } catch {
      await ownerSend(
        "Не удалось завершить запрос. Проверьте списки дел и /outbox перед повтором: уже выполненные действия могли сохраниться.",
      );
    }
  }
  return {
    async handle(update) {
      if (
        !Number.isSafeInteger(update.update_id) ||
        !store.beginUpdate(update.update_id)
      )
        return;
      try {
        await dispatch(update);
      } finally {
        store.finishUpdate(update.update_id);
      }
    },
    async tick() {
      if (!ownerChat() || !readSettings(store, config).remindersEnabled) return;
      for (const r of store.due(now())) {
        if (!store.claimReminder(r.id)) continue;
        try {
          await ownerSend("Напоминание: " + r.text);
          store.reminderStatus(r.id, "sent");
        } catch (e) {
          store.reminderStatus(r.id, e.definite ? "failed" : "uncertain");
        }
      }
    },
  };
}
