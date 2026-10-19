export class TelegramError extends Error {
  constructor(code, definite = false) {
    super("Telegram request failed");
    this.code = code;
    this.definite = definite;
  }
}
export function telegramClient(token, { fetchImpl = fetch } = {}) {
  async function call(method, args = {}, signal) {
    let response, data;
    try {
      response = await fetchImpl(
        "https://api.telegram.org/bot" + token + "/" + method,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
          signal: signal || AbortSignal.timeout(45000),
        },
      );
      data = await response.json();
    } catch {
      throw new TelegramError("transport", false);
    }
    if (!response.ok || !data.ok)
      throw new TelegramError(
        data.error_code || response.status,
        Number(data.error_code || response.status) >= 400 &&
          Number(data.error_code || response.status) < 500,
      );
    return data.result;
  }
  return {
    call,
    async downloadJson(fileId) {
      const file = await call("getFile", { file_id: fileId });
      if (
        file.file_size > 5 * 1024 * 1024 ||
        !/^[A-Za-z0-9_\-/.]+$/.test(file.file_path || "") ||
        file.file_path.includes("..")
      )
        throw new TelegramError("file", true);
      try {
        const r = await fetchImpl(
          "https://api.telegram.org/file/bot" + token + "/" + file.file_path,
          { signal: AbortSignal.timeout(45000), redirect: "error" },
        );
        if (!r.ok) throw new Error();
        const chunks = [];
        let size = 0;
        for await (const chunk of r.body) {
          size += chunk.length;
          if (size > 5 * 1024 * 1024) throw new Error();
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!Array.isArray(data.messages) || data.messages.length > 10000)
          throw new Error();
        return data;
      } catch {
        throw new TelegramError("file", true);
      }
    },
    async send(chatId, text, extra = {}) {
      return call("sendMessage", {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...extra,
      });
    },
  };
}
