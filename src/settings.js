const defaults = {
  timeZone: "Asia/Omsk",
  sendMode: "automatic",
  responseStyle: "normal",
  remindersEnabled: true,
  notifyIncoming: true,
  calendarWriteEnabled: false,
  memoryEnabled: true,
  planningEnabled: true,
  meetingTrackingEnabled: false,
  defaultCalendarId: "",
  retentionDays: 30,
};
export function readSettings(store, config = {}) {
  let saved = {};
  try {
    saved = JSON.parse(store.get("settings") || "{}");
  } catch {}
  return {
    ...defaults,
    timeZone: config.timeZone || defaults.timeZone,
    ...saved,
  };
}
export function saveSettings(store, input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid settings");
  for (const key of Object.keys(input))
    if (!(key in defaults)) throw new Error("Unknown setting");
  const value = { ...defaults, ...input };
  if (typeof value.timeZone !== "string" || value.timeZone.length > 80)
    throw new Error("Invalid timezone");
  new Intl.DateTimeFormat("ru", { timeZone: value.timeZone }).format();
  if (
    !["automatic", "confirm"].includes(value.sendMode) ||
    !["brief", "normal", "detailed"].includes(value.responseStyle)
  )
    throw new Error("Invalid setting");
  for (const key of [
    "remindersEnabled",
    "notifyIncoming",
    "calendarWriteEnabled",
    "memoryEnabled",
    "planningEnabled",
    "meetingTrackingEnabled",
  ])
    if (typeof value[key] !== "boolean") throw new Error("Invalid setting");
  if (
    typeof value.defaultCalendarId !== "string" ||
    value.defaultCalendarId.length > 2000
  )
    throw new Error("Invalid calendar");
  value.retentionDays = Number(value.retentionDays);
  if (![7, 30, 90].includes(value.retentionDays))
    throw new Error("Invalid retention");
  store.set("settings", JSON.stringify(value));
  return value;
}
