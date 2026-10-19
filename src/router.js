import { importDiscussion } from "./import.js";
import { supportButton } from "./support.js";
export function createRouter({ config, registry, profiles, telegram }) {
  let lastMaintenance = 0,
    importCache = null;
  const schedule = (ctx, chat) => {
    const key = "discussion_job:" + chat,
      now = Date.now();
    let old = null;
    try {
      old = JSON.parse(ctx.store.get(key) || "null");
    } catch {}
    ctx.store.set(key, JSON.stringify({ first: old?.first || now, last: now }));
  };
  const addressed = (m) =>
    m.text?.includes("@" + config.botUsername) ||
    m.reply_to_message?.from?.username === config.botUsername ||
    /^\/(ask|plan|history|track|untrack)(@\w+)?(?:\s|$)/.test(m.text || "");
  async function menu(id) {
    if (config.publicBaseUrl)
      await telegram.call("setChatMenuButton", {
        chat_id: id,
        menu_button: {
          type: "web_app",
          text: "Мой агент",
          web_app: { url: config.publicBaseUrl + "/app" },
        },
      });
  }
  async function handle(update) {
    if (
      !Number.isSafeInteger(update.update_id) ||
      !registry.beginUpdate(update.update_id)
    )
      return;
    try {
      const m = update.message || update.edited_message,
        cb = update.callback_query;
      const sender = m?.from || cb?.from;
      if (!sender || sender.is_bot) return;
      const id = String(sender.id),
        chat = m?.chat || cb?.message?.chat;
      if (!chat) return;
      const privateChat = chat.type === "private" && String(chat.id) === id;
      const text = m?.text?.trim() || "",
        command = text.split(/\s/)[0].split("@")[0];
      if (privateChat && command === "/start") {
        try {
          const ctx = profiles.register(sender);
          ctx.store.set("owner_chat", id);
          ctx.store.set("support_active", "");
          ctx.store.set("support_history", "");
          await menu(id);
          await telegram.send(
            id,
            "Ваш профиль создан. Я веду задачи, заметки, встречи и планы. /settings — настроить навыки и подключить календари. В группе: /track — начать учитывать обсуждение, /untrack — остановить. /plan и /history — планы и история. Для старой переписки отправьте JSON-экспорт Telegram Desktop файлом. /support — написать в AI-поддержку. /stop — приостановить профиль.",
            supportButton,
          );
          if (text === "/start settings")
            await ctx.engine.handle({
              ...update,
              message: { ...m, text: "/settings" },
            });
        } catch {
          await telegram.send(
            id,
            "Не удалось создать профиль: проверьте доступность сервиса или лимит профилей.",
          );
        }
        return;
      }
      if (!profiles.known(id)) {
        if (
          ["group", "supergroup"].includes(chat.type) &&
          (m?.text || m?.caption) &&
          !command.startsWith("/")
        ) {
          for (const owner of profiles.subscribers(chat.id)) {
            const c = profiles.get(owner);
            c.knowledge.observe(chat.id, m.message_id, id, m.text || m.caption);
            schedule(c, String(chat.id));
          }
        }
        if (privateChat || addressed(m || {}))
          await telegram.send(
            chat.id,
            "Я не могу общаться с незнакомым пользователем. Сначала откройте мой личный чат и нажмите /start.",
          );
        return;
      }
      if (privateChat && command === "/stop") {
        profiles.pause(id);
        return telegram.send(
          id,
          "Профиль приостановлен. Напоминания и обработка чатов отключены. /start — возобновить.",
        );
      }
      const ctx = profiles.get(id);
      if (privateChat) {
        if (cb?.data?.startsWith("support:")) {
          await telegram.call("answerCallbackQuery", {
            callback_query_id: cb.id,
          });
          if (cb.data === "support:start") return ctx.support.start();
          if (cb.data === "support:stop") return ctx.support.stop();
          return;
        }
        if (command === "/support") return ctx.support.start();
        if (command === "/back") return ctx.support.stop();
        if (command === "/clearhistory") {
          ctx.store.set("support_history", "");
        }
        if (ctx.support.active() && m && !update.edited_message) {
          if (!command.startsWith("/")) {
            if (m.text) return ctx.support.answer(text);
            return telegram.send(
              id,
              "Опишите проблему текстом. /back — вернуться к агенту.",
            );
          }
        }
        // Only update previously observed discussion messages. Support messages
        // were never observed, including after the user leaves support mode.
        if (
          update.edited_message &&
          !ctx.knowledge
            .discussion("private")
            .some((row) => row.msg === m.message_id)
        )
          return;
        profiles.syncContacts(ctx);
        if (m?.document) {
          if (!m.document.file_name?.endsWith(".json"))
            return telegram.send(
              id,
              "Для импорта нужен JSON-экспорт Telegram Desktop.",
            );
          // Run import in the maintenance worker, never block polling for a long archive.
          if (ctx.store.get("import_job"))
            return telegram.send(
              id,
              "Уже есть импорт. Дождитесь завершения или используйте /cancelimport.",
            );
          if (m.document.file_size > 5 * 1024 * 1024)
            return telegram.send(
              id,
              "Максимум 5 МБ. Экспортируйте меньший диапазон дат.",
            );
          ctx.store.set(
            "import_job",
            JSON.stringify({
              fileId: m.document.file_id,
              chat: "archive:" + m.document.file_unique_id,
              offset: 0,
            }),
          );
          return telegram.send(
            id,
            "Импорт принят. Разберу историю в фоне. Старые сообщения не создают события и не рассылают уведомления. /cancelimport — остановить.",
          );
        }
        if (command === "/cancelimport") {
          ctx.store.set("import_job", "");
          return telegram.send(
            id,
            "Импорт остановлен. Уже извлечённые записи сохранены.",
          );
        }
        if (m?.text && !command.startsWith("/")) {
          ctx.knowledge.observe("private", m.message_id, id, text);
          schedule(ctx, "private");
        }
        return ctx.engine.handle(update);
      }
      if (!["group", "supergroup"].includes(chat.type)) return;
      if (!m) return;
      if (m.new_chat_members?.some((user) => user.id === config.botId)) {
        const member = await telegram.call("getChatMember", {
          chat_id: chat.id,
          user_id: sender.id,
        });
        if (["creator", "administrator"].includes(member.status)) {
          profiles.subscribe(chat.id, id);
          return telegram.send(
            chat.id,
            "Я подключён к профилю администратора и буду учитывать важные договорённости из новых сообщений этого чата. Настройки и личные календари доступны только в личке. /untrack — остановить обработку.",
          );
        }
      }
      if (command === "/track") {
        const member = await telegram.call("getChatMember", {
          chat_id: chat.id,
          user_id: sender.id,
        });
        if (!["creator", "administrator"].includes(member.status))
          return telegram.send(
            chat.id,
            "Подключить обработку может администратор чата с профилем в боте.",
          );
        profiles.subscribe(chat.id, id);
        return telegram.send(
          chat.id,
          "Обработка обсуждения подключена к профилю администратора. Сохраняю важные договорённости и планы из новых текстовых сообщений этого чата. Настройки и календарь остаются в личном чате. /untrack — остановить.",
        );
      }
      if (command === "/untrack") {
        profiles.unsubscribe(chat.id, id);
        return telegram.send(
          chat.id,
          "Ваш профиль больше не учитывает этот чат.",
        );
      }
      const ids = profiles.subscribers(chat.id);
      if (!ids.length) return;
      if (m.text || m.caption)
        for (const owner of ids) {
          const c = profiles.get(owner);
          c.knowledge.observe(chat.id, m.message_id, id, m.text || m.caption);
          schedule(c, String(chat.id));
        }
      if (!addressed(m)) return;
      // Public answers use only this group's records. Private profile tools are never exposed here.
      const source = profiles.get(ids.includes(id) ? id : ids[0]);
      if (command === "/plan" || command === "/history") {
        const rows =
          command === "/plan"
            ? source.knowledge.list(chat.id)
            : source.knowledge.history(chat.id);
        return telegram.send(
          chat.id,
          rows.length
            ? JSON.stringify(rows, null, 2).slice(0, 3900)
            : "В этом обсуждении пока нет сохранённых записей.",
        );
      }
      try {
        await telegram.send(chat.id, await source.skills.answer(chat.id, text));
      } catch {
        await telegram.send(
          chat.id,
          "Не удалось получить ответ. Попробуйте позже.",
        );
      }
    } finally {
      registry.finishUpdate(update.update_id);
    }
  }
  async function tick() {
    const now = Date.now();
    let imported = false;
    for (const id of profiles.active()) {
      const ctx = profiles.get(id);
      await ctx.engine.tick();
      await ctx.skills.tick();
      if (now - lastMaintenance > 3600000) {
        ctx.knowledge.maintain(ctx.getSettings().retentionDays);
        ctx.store.maintain();
      }
      const job = JSON.parse(ctx.store.get("import_job") || "null");
      if (job && !imported) {
        imported = true;
        try {
          // Download to memory only; no unbounded archive files accumulate on disk.
          const data =
            importCache?.fileId === job.fileId
              ? importCache.data
              : await telegram.downloadJson(job.fileId);
          importCache = { fileId: job.fileId, data };
          const part = {
            messages: data.messages.slice(job.offset, job.offset + 40),
          };
          await importDiscussion(ctx.knowledge, ctx.skills, job.chat, part);
          job.offset += 40;
          ctx.store.set(
            "import_job",
            job.offset >= data.messages.length ? "" : JSON.stringify(job),
          );
          if (job.offset >= data.messages.length) {
            importCache = null;
            await telegram.send(
              id,
              "Импорт завершён: " +
                data.messages.length +
                " сообщений. Планы: /plan, история: /history.",
            );
          }
        } catch {
          importCache = null;
          ctx.store.set("import_job", "");
          await telegram.send(
            id,
            "Импорт остановлен: проверьте JSON, лимит 5 МБ / 10000 сообщений и доступность модели. Уже извлечённые записи сохранены.",
          );
        }
      }
    }
    if (now - lastMaintenance > 3600000) {
      lastMaintenance = now;
      registry.maintain();
    }
    if (
      importCache &&
      !profiles.active().some((id) => profiles.get(id).store.get("import_job"))
    )
      importCache = null;
    // At most one model extraction per maintenance pass, debounce noisy groups.
    for (const id of profiles.active()) {
      const ctx = profiles.get(id);
      const jobs = ctx.store.db
        .prepare(
          "SELECT key,value FROM kv WHERE key LIKE 'discussion_job:%' AND value!='' ORDER BY CAST(value AS INTEGER) LIMIT 10",
        )
        .all();
      for (const job of jobs) {
        const timing = JSON.parse(job.value);
        if (now - timing.last < 15000 && now - timing.first < 60000) continue;
        const chat = job.key.slice("discussion_job:".length);
        if (chat !== "private" && !profiles.subscribers(chat).includes(id)) {
          ctx.store.set(job.key, "");
          continue;
        }
        try {
          await ctx.skills.analyze(chat);
        } catch {
          await telegram.send(
            id,
            "Не удалось разобрать обсуждение. Проверьте память/лимиты; записи не удалены. Следующее сообщение запустит повторный анализ.",
          );
        }
        ctx.store.db
          .prepare("UPDATE kv SET value='' WHERE key=? AND value=?")
          .run(job.key, job.value);
        return;
      }
    }
  }
  return { handle, tick };
}
