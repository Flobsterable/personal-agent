import { createHmac, timingSafeEqual } from "node:crypto";
export function validateInitData(
  initData,
  botToken,
  ownerId,
  now = Date.now(),
) {
  if (typeof initData !== "string" || initData.length > 16384)
    throw new Error("Invalid Telegram session");
  const params = new URLSearchParams(initData),
    hash = params.get("hash");
  if (!/^[a-f0-9]{64}$/i.test(hash || ""))
    throw new Error("Invalid Telegram signature");
  const entries = [...params.entries()];
  if (new Set(entries.map(([k]) => k)).size !== entries.length)
    throw new Error("Duplicate Telegram fields");
  const check = entries
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + "=" + v)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex")))
    throw new Error("Invalid Telegram signature");
  const date = Number(params.get("auth_date")) * 1000;
  if (!Number.isFinite(date) || date > now + 30000 || now - date > 5 * 60000)
    throw new Error("Telegram session expired");
  const user = JSON.parse(params.get("user") || "null");
  if (
    !user ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    (ownerId != null && String(user.id) !== String(ownerId))
  )
    throw new Error("Only the owner may open settings");
  return { id: String(user.id) };
}
