import { readdirSync, readFileSync } from "node:fs";

const docsUrl = new URL("../docs/support/", import.meta.url);
const stop = new Set(
  "а без в во вы где для до его ее если есть и или из как к когда ли на не но о об от по при с со что это я мы он она они у уже".split(
    " ",
  ),
);
const aliases = {
  встреча: ["событие", "календарь", "договоренность"],
  календарь: ["встреча", "событие", "google", "яндекс", "caldav"],
  группа: ["чат", "track", "администратор", "privacy"],
  память: ["саммари", "решение", "история", "обсуждение"],
  саммари: ["память", "решение", "обсуждение"],
  сообщение: ["получатель", "черновик", "outbox", "доставка"],
  настройка: ["mini", "app", "settings"],
  импорт: ["архив", "json", "telegram", "desktop"],
  ошибка: ["диагностика", "логи", "не работает"],
};

function tokens(text) {
  return (
    String(text)
      .toLocaleLowerCase("ru")
      .replaceAll("ё", "е")
      .match(/[\p{L}\p{N}_-]{2,}/gu)
      ?.filter((word) => !stop.has(word)) ?? []
  );
}

function matchesWord(left, right) {
  if (left === right) return true;
  const shared = Math.min(left.length, right.length, 5);
  return shared >= 4 && left.slice(0, shared) === right.slice(0, shared);
}

function parseDocument(file, text) {
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || file;
  const keywords = text.match(/^Ключевые слова:\s*(.+)$/im)?.[1]?.trim() || "";
  const parts = text.split(/^##\s+/m);
  const chunks = [];
  if (parts[0].replace(/^#.+$/m, "").trim())
    chunks.push({ heading: "Общее", body: parts[0].replace(/^#.+$/m, "") });
  for (const part of parts.slice(1)) {
    const [heading, ...body] = part.split("\n");
    chunks.push({ heading: heading.trim(), body: body.join("\n").trim() });
  }
  return chunks
    .filter((chunk) => chunk.body)
    .map((chunk) => ({
      id: file.replace(/\.md$/, "") + "#" + chunk.heading,
      title,
      keywords,
      ...chunk,
    }));
}

export function loadSupportDocs() {
  return readdirSync(docsUrl)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .flatMap((file) =>
      parseDocument(file, readFileSync(new URL(file, docsUrl), "utf8")),
    );
}

const defaultDocs = loadSupportDocs();

export function searchSupportDocs(
  query,
  { docs = defaultDocs, limit = 4 } = {},
) {
  const original = tokens(query);
  const expanded = new Set(original);
  for (const word of original)
    for (const [key, related] of Object.entries(aliases))
      if (word.startsWith(key.slice(0, 5)) || key.startsWith(word.slice(0, 5)))
        for (const alias of related) expanded.add(alias);
  const terms = [...expanded];
  return docs
    .map((doc) => {
      const heading = tokens(
        doc.title + " " + doc.heading + " " + doc.keywords,
      );
      const body = tokens(doc.body);
      let score = 0;
      for (const term of terms) {
        score += heading.filter((word) => matchesWord(word, term)).length * 8;
        score += body.filter((word) => matchesWord(word, term)).length;
      }
      if (
        doc.body
          .toLocaleLowerCase("ru")
          .includes(String(query).toLocaleLowerCase("ru"))
      )
        score += 12;
      return { ...doc, score };
    })
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ score, keywords, ...doc }) => doc);
}

export function formatSupportContext(chunks) {
  if (!chunks.length)
    return "Подходящих разделов базы знаний не найдено. Уточни проблему и не выдумывай ответ.";
  return chunks
    .map(
      (chunk) =>
        `[${chunk.id}] ${chunk.title} — ${chunk.heading}\n${chunk.body}`,
    )
    .join("\n\n---\n\n")
    .slice(0, 12000);
}
