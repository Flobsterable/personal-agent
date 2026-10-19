const tg = window.Telegram?.WebApp;
let token = null;
const status = document.querySelector("#status");
const fields = document.querySelector("#fields");
function message(text) {
  status.textContent = text;
}
async function api(path, body, method = "POST") {
  const r = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Ошибка соединения");
  return data;
}
async function load() {
  const data = await api("/api/settings", null, "GET");
  const calendars = document.querySelector("#default-calendar");
  calendars.replaceChildren(new Option("Не выбран", ""));
  for (const calendar of data.calendars?.items || [])
    if (calendar.writable)
      calendars.add(new Option(calendar.name, calendar.id));
  if (
    data.settings.defaultCalendarId &&
    ![...calendars.options].some(
      (o) => o.value === data.settings.defaultCalendarId,
    )
  )
    calendars.add(
      new Option("Недоступное подключение", data.settings.defaultCalendarId),
    );
  for (const [key, value] of Object.entries(data.settings)) {
    const field = document.forms.settings.elements[key];
    if (field)
      field.type === "checkbox"
        ? (field.checked = value)
        : (field.value = value);
  }
  for (const provider of ["google", "yandex"]) {
    const c = data.connections[provider];
    document.querySelector("#" + provider + "-state").textContent = c.connected
      ? "Подключён"
      : c.needsCaldav
        ? "Нужен доступ CalDAV"
        : c.configured
          ? "Не подключён"
          : "Подключение ещё не настроено";
    document.querySelector("[data-connect=" + provider + "]").disabled =
      !c.configured;
    document.querySelector("[data-disconnect=" + provider + "]").hidden = !(
      c.connected || c.needsCaldav
    );
  }
  fields.disabled = false;
  document.querySelector("#support").disabled = false;
  document.querySelector("#export").disabled = false;
  document.querySelector("#refresh").disabled = false;
  document.querySelector("#caldav-form button").disabled = false;
}
document.querySelector("#support").onclick = async () => {
  const button = document.querySelector("#support");
  button.disabled = true;
  try {
    await api("/api/support", {});
    message("AI-поддержка открыта. Напишите вопрос в личном чате бота.");
    tg?.close();
  } catch (e) {
    message(e.message);
  } finally {
    button.disabled = false;
  }
};
document.querySelector("#export").onclick = async () => {
  try {
    const data = await api("/api/export", null, "GET");
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "personal-agent-memory.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    message(e.message);
  }
};
document.forms.settings.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = {};
    for (const field of document.forms.settings.elements)
      if (field.name)
        data[field.name] =
          field.type === "checkbox" ? field.checked : field.value;
    await api("/api/settings", data, "PUT");
    message("Настройки сохранены");
  } catch (e) {
    message(e.message);
  }
});
for (const button of document.querySelectorAll("[data-connect]"))
  button.addEventListener("click", async () => {
    try {
      const result = await api("/api/connect", {
        provider: button.dataset.connect,
      });
      const link = document.querySelector("#continue");
      link.href = result.url;
      link.hidden = false;
      link.onclick = (event) => {
        if (tg) {
          event.preventDefault();
          tg.openLink(result.url);
        }
      };
      message(
        "Нажмите «Открыть официальный вход». После авторизации вернитесь сюда.",
      );
    } catch (e) {
      message(e.message);
    }
  });
for (const button of document.querySelectorAll("[data-disconnect]"))
  button.addEventListener("click", async () => {
    if (
      !window.confirm(
        "Удалить подключение у бота? Разрешение в аккаунте провайдера можно отозвать отдельно.",
      )
    )
      return;
    try {
      await api("/api/disconnect", { provider: button.dataset.disconnect });
      await load();
      message("Подключение удалено");
    } catch (e) {
      message(e.message);
    }
  });
document.querySelector("#refresh").onclick = () =>
  load().catch((e) => message(e.message));
document.querySelector("#caldav-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    await api("/api/yandex-caldav", {
      login: form.elements.login.value,
      password: form.elements.password.value,
    });
    form.elements.password.value = "";
    await load();
    message("Яндекс Календарь подключён");
  } catch (e) {
    form.elements.password.value = "";
    message(e.message);
  }
};
if (tg?.initData) {
  tg.ready();
  tg.expand();
  api("/api/session", { initData: tg.initData })
    .then((data) => {
      token = data.token;
      return load();
    })
    .then(() => message("Настройки доступны только вам"))
    .catch((e) => message(e.message));
  tg.onEvent("activated", () => {
    if (token) load().catch((e) => message(e.message));
  });
} else {
  load()
    .then(() => message("Настройки открыты по защищённой ссылке из Telegram"))
    .catch((e) => message(e.message));
}
