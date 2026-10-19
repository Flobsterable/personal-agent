import { randomUUID } from "node:crypto";
import { createDAVClient } from "tsdav";
import ICAL from "ical.js";
const iso = (value) => {
  if (
    typeof value !== "string" ||
    !/(Z|[+-][0-9]{2}:[0-9]{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Use ISO8601 with explicit time zone");
  return new Date(value).toISOString();
};
export function validateWindow(from, to) {
  const start = iso(from),
    end = iso(to);
  if (
    Date.parse(end) <= Date.parse(start) ||
    Date.parse(end) - Date.parse(start) > 31 * 86400000
  )
    throw new Error("Calendar window must be 1 minute to 31 days");
  return { start, end };
}
const label = (v) => (typeof v === "string" ? v.slice(0, 300) : "Calendar");
export function parseExpandedEvents(data) {
  if (typeof data !== "string" || data.length > 256000)
    throw new Error("Calendar object too large");
  const root = new ICAL.Component(ICAL.parse(data));
  for (const zone of root.getAllSubcomponents("vtimezone")) {
    const tz = new ICAL.Timezone(zone);
    ICAL.TimezoneService.register(tz.tzid, tz);
  }
  const items = [],
    warnings = [];
  for (const component of root.getAllSubcomponents("vevent")) {
    if (component.getFirstPropertyValue("status") === "CANCELLED") continue;
    if (component.hasProperty("rrule") || component.hasProperty("rdate")) {
      warnings.push("Server did not expand recurring event");
      continue;
    }
    const event = new ICAL.Event(component),
      start = event.startDate,
      end = event.endDate;
    if (!start || !end || (!start.isDate && start.zone.tzid === "floating")) {
      warnings.push("Event time zone unavailable");
      continue;
    }
    items.push({
      id: event.uid,
      start: start.isDate ? start.toString() : start.toJSDate().toISOString(),
      end: end.isDate ? end.toString() : end.toJSDate().toISOString(),
      allDay: start.isDate,
      title: label(event.summary),
      description: String(event.description || "").slice(0, 1000),
      location: label(event.location || ""),
    });
  }
  return { items, incomplete: warnings.length > 0, warnings };
}
export function makeEventIcs({
  id,
  title,
  start,
  end,
  description = "",
  location = "",
}) {
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.updatePropertyWithValue("version", "2.0");
  root.updatePropertyWithValue("prodid", "-//Personal Agent//Calendar//EN");
  const c = new ICAL.Component("vevent");
  c.updatePropertyWithValue("uid", id);
  c.updatePropertyWithValue("summary", title);
  c.updatePropertyWithValue("description", description);
  c.updatePropertyWithValue("location", location);
  c.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  c.updatePropertyWithValue(
    "dtstart",
    ICAL.Time.fromJSDate(new Date(start), true),
  );
  c.updatePropertyWithValue("dtend", ICAL.Time.fromJSDate(new Date(end), true));
  root.addSubcomponent(c);
  return root.toString();
}
export function createCalendarService(
  config,
  {
    fetchImpl = fetch,
    davFactory = createDAVClient,
    vault,
    getSettings = () => config,
  } = {},
) {
  let access = null,
    yandex = null,
    yandexCredential = null;
  const calendars = new Map();
  async function json(url, init = {}) {
    let r;
    try {
      r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error();
      return await r.json();
    } catch {
      throw new Error("Calendar provider unavailable");
    }
  }
  async function googleToken() {
    const credentials = await vault.get("google");
    if (!credentials) {
      access = null;
      throw new Error("Google Calendar not connected");
    }
    if (
      access &&
      access.refresh === credentials.refresh_token &&
      access.until > Date.now()
    )
      return access.token;
    if (!credentials) throw new Error("Google Calendar not connected");
    const c = {
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
    };
    const result = await json("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refresh_token,
        client_id: c.client_id,
        client_secret: c.client_secret,
      }),
    });
    if (result.refresh_token)
      await vault.set("google", {
        ...credentials,
        refresh_token: result.refresh_token,
      });
    if (!result.access_token)
      throw new Error("Google Calendar authorization unavailable");
    access = {
      refresh: result.refresh_token || credentials.refresh_token,
      token: result.access_token,
      until:
        Date.now() + Math.max(0, Number(result.expires_in || 3600) - 60) * 1000,
    };
    return access.token;
  }
  async function google(path, options = {}) {
    return json("https://www.googleapis.com/calendar/v3" + path, {
      ...options,
      headers: {
        ...options.headers,
        "Content-Type": "application/json",
        Authorization: "Bearer " + (await googleToken()),
      },
    });
  }
  async function dav() {
    let credentials = await vault.get("yandex");
    if (!credentials) throw new Error("Yandex Calendar not connected");
    if (
      credentials.expires_at &&
      credentials.expires_at <= Date.now() &&
      credentials.refresh_token
    ) {
      const refreshed = await json("https://oauth.yandex.ru/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refresh_token,
          client_id: config.yandexClientId,
          client_secret: config.yandexClientSecret,
        }),
      });
      credentials = {
        ...credentials,
        ...refreshed,
        expires_at:
          Date.now() + Number(refreshed.expires_in || 31536000) * 1000,
      };
      await vault.set("yandex", credentials);
    }
    const password = credentials.appPassword || credentials.access_token;
    if (yandex && yandexCredential === password) return yandex;
    yandex = await davFactory({
      serverUrl: "https://caldav.yandex.ru",
      credentials: { username: credentials.login, password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
      fetch: async (url, init) => {
        const target = new URL(url);
        if (
          target.protocol !== "https:" ||
          target.hostname !== "caldav.yandex.ru"
        )
          throw new Error("Unexpected calendar host");
        return fetchImpl(target, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
      },
    });
    yandexCredential = password;
    return yandex;
  }
  async function list() {
    calendars.clear();
    const items = [],
      errors = [];
    const googleEnabled = !!(
        config.googleClientId && (await vault.get("google"))
      ),
      yandexEnabled = !!(await vault.get("yandex"));
    if (googleEnabled) {
      try {
        let page;
        for (let i = 0; i < 3; i++) {
          const r = await google(
            "/users/me/calendarList?maxResults=100" +
              (page ? "&pageToken=" + encodeURIComponent(page) : ""),
          );
          for (const c of r.items || []) {
            const id = "google:" + Buffer.from(c.id).toString("base64url");
            calendars.set(id, {
              provider: "google",
              rawId: c.id,
              writable: ["owner", "writer"].includes(c.accessRole),
            });
            items.push({
              id,
              provider: "google",
              name: label(c.summary),
              timeZone: c.timeZone,
              writable: calendars.get(id).writable,
            });
          }
          page = r.nextPageToken;
          if (!page) break;
        }
        if (page) errors.push("Google calendar list truncated");
      } catch {
        errors.push("Google Calendar not connected or unavailable");
      }
    }
    if (yandexEnabled) {
      try {
        const cs = await (await dav()).fetchCalendars();
        for (const c of cs.slice(0, 200)) {
          const id = "yandex:" + Buffer.from(c.url).toString("base64url");
          calendars.set(id, { provider: "yandex", raw: c, writable: true });
          items.push({
            id,
            provider: "yandex",
            name: label(c.displayName),
            writable: true,
          });
        }
        if (cs.length > 200) errors.push("Yandex calendar list truncated");
      } catch {
        errors.push("Yandex Calendar not connected or unavailable");
      }
    }
    if (!googleEnabled && !yandexEnabled)
      errors.push("No calendars configured");
    return { items, incomplete: errors.length > 0, errors };
  }
  async function selected(id) {
    await list();
    const c = calendars.get(id);
    if (!c) throw new Error("Choose a connected calendar from calendar_list");
    return c;
  }
  return {
    list,
    async events({ calendarId, from, to }) {
      const w = validateWindow(from, to),
        c = await selected(calendarId);
      if (c.provider === "google") {
        let page;
        const items = [];
        for (let i = 0; i < 4; i++) {
          const q = new URLSearchParams({
            timeMin: w.start,
            timeMax: w.end,
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "100",
            ...(page ? { pageToken: page } : {}),
          });
          const r = await google(
            "/calendars/" + encodeURIComponent(c.rawId) + "/events?" + q,
          );
          for (const e of r.items || [])
            if (e.status !== "cancelled")
              items.push({
                id: e.id,
                title: label(e.summary),
                start: e.start?.dateTime || e.start?.date,
                end: e.end?.dateTime || e.end?.date,
                allDay: !!e.start?.date,
                description: String(e.description || "").slice(0, 1000),
                location: label(e.location || ""),
              });
          page = r.nextPageToken;
          if (!page) break;
        }
        return { calendarId, items, incomplete: !!page };
      }
      const objects = await (
        await dav()
      ).fetchCalendarObjects({ calendar: c.raw, timeRange: w, expand: true });
      const items = [],
        warnings = [];
      for (const object of objects.slice(0, 200)) {
        try {
          const parsed = parseExpandedEvents(object.data);
          items.push(...parsed.items);
          warnings.push(...parsed.warnings);
        } catch {
          warnings.push("Calendar object could not be read");
        }
      }
      if (objects.length > 200) warnings.push("Calendar objects truncated");
      return { calendarId, items, incomplete: warnings.length > 0, warnings };
    },
    async change({
      calendarId,
      eventId,
      title = "",
      start,
      end,
      description = "",
      location = "",
      cancelled = false,
    }) {
      if (
        !getSettings().calendarWriteEnabled ||
        !/^[a-z0-9]{16,128}$/.test(eventId || "")
      )
        throw new Error("Event unavailable");
      const c = await selected(calendarId);
      if (!c.writable) throw new Error("Read only");
      if (
        typeof title !== "string" ||
        title.length > 300 ||
        typeof description !== "string" ||
        description.length > 4000 ||
        typeof location !== "string" ||
        location.length > 300
      )
        throw new Error("Invalid event");
      const w = cancelled ? null : validateWindow(start, end);
      if (c.provider === "google") {
        const credentials = await vault.get("google");
        if (
          !String(credentials?.scope || "")
            .split(" ")
            .some((x) =>
              [
                "https://www.googleapis.com/auth/calendar",
                "https://www.googleapis.com/auth/calendar.events",
              ].includes(x),
            )
        )
          throw new Error("Reconnect with write access");
        const path =
          "/calendars/" +
          encodeURIComponent(c.rawId) +
          "/events/" +
          encodeURIComponent(eventId);
        // Conditional mutation protects edits made outside the agent.
        const existing = await google(path);
        if (!existing.etag) throw new Error("Event version unavailable");
        await google(path + "?sendUpdates=none", {
          method: "PATCH",
          headers: { "If-Match": existing.etag },
          body: JSON.stringify(
            cancelled
              ? { status: "cancelled" }
              : {
                  summary: title,
                  description,
                  location,
                  start: { dateTime: w.start },
                  end: { dateTime: w.end },
                },
          ),
        });
      } else {
        const client = await dav(),
          url = new URL(
            eventId + ".ics",
            c.raw.url.endsWith("/") ? c.raw.url : c.raw.url + "/",
          ).href;
        const objects = await client.fetchCalendarObjects({
          calendar: c.raw,
          objectUrls: [url],
        });
        const object = objects.find((o) => o.url === url);
        if (!object?.etag) throw new Error("Event version unavailable");
        const result = cancelled
          ? await client.deleteCalendarObject({ calendarObject: object })
          : await client.updateCalendarObject({
              calendarObject: {
                ...object,
                data: makeEventIcs({
                  id: eventId,
                  title,
                  ...w,
                  description,
                  location,
                }),
              },
            });
        if (!result.ok) throw new Error("Calendar change failed");
      }
      return { changed: true, cancelled, calendarId, eventId };
    },
    async create({
      calendarId,
      title,
      start,
      end,
      description = "",
      location = "",
    }) {
      if (!getSettings().calendarWriteEnabled)
        throw new Error(
          "Calendar is read-only; enable writes and authorize again",
        );
      if (
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 300 ||
        typeof description !== "string" ||
        description.length > 4000 ||
        typeof location !== "string" ||
        location.length > 300
      )
        throw new Error("Invalid calendar event");
      const w = validateWindow(start, end),
        c = await selected(calendarId);
      if (!c.writable) throw new Error("Calendar is read-only");
      const id = randomUUID().replaceAll("-", "");
      if (c.provider === "google") {
        const credentials = await vault.get("google");
        if (
          !String(credentials?.scope || "")
            .split(" ")
            .some((x) =>
              [
                "https://www.googleapis.com/auth/calendar",
                "https://www.googleapis.com/auth/calendar.events",
              ].includes(x),
            )
        )
          throw new Error("Reconnect Google with write access");
        const result = await google(
          "/calendars/" +
            encodeURIComponent(c.rawId) +
            "/events?sendUpdates=none",
          {
            method: "POST",
            body: JSON.stringify({
              id,
              summary: title,
              description,
              location,
              start: { dateTime: w.start },
              end: { dateTime: w.end },
            }),
          },
        );
        if (typeof result.id !== "string")
          throw new Error("Calendar creation status unknown");
        return {
          created: true,
          calendarId,
          eventId: result.id,
          title,
          start: w.start,
          end: w.end,
        };
      }
      const response = await (
        await dav()
      ).createCalendarObject({
        calendar: c.raw,
        filename: id + ".ics",
        iCalString: makeEventIcs({ id, title, ...w, description, location }),
      });
      if (!response.ok) throw new Error("Calendar event creation failed");
      return {
        created: true,
        calendarId,
        eventId: id,
        title,
        start: w.start,
        end: w.end,
      };
    },
  };
}
