export function parseTelegramExport(data) {
  if (!data || !Array.isArray(data.messages) || data.messages.length > 10000)
    throw new Error("Export needs messages, maximum 10000");
  return data.messages
    .filter((m) => m.type === "message")
    .map((m, i) => {
      const text =
        typeof m.text === "string"
          ? m.text
          : Array.isArray(m.text)
            ? m.text
                .map((x) => (typeof x === "string" ? x : x.text || ""))
                .join("")
            : "";
      const created = Number(m.date_unixtime) * 1000 || Date.parse(m.date);
      if (!Number.isSafeInteger(m.id) || !Number.isFinite(created))
        throw new Error("Invalid exported message");
      return {
        msg: m.id,
        sender: String(m.from_id || m.from || "unknown").slice(0, 100),
        text: text.slice(0, 4000),
        created,
      };
    })
    .filter((m) => m.text)
    .sort((a, b) => a.created - b.created || a.msg - b.msg);
}
export async function importDiscussion(knowledge, skills, chat, data) {
  const messages = parseTelegramExport(data);
  // Run in bounded batches, carry extracted decisions forward; raw text is bounded to 80 messages.
  let changed = 0;
  for (let i = 0; i < messages.length; i += 40) {
    for (const m of messages.slice(i, i + 40))
      knowledge.observe(chat, m.msg, m.sender, m.text, m.created);
    changed += (await skills.analyze(chat, { historical: true })).length;
  }
  return { messages: messages.length, changed };
}
