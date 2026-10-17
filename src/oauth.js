import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
const definitions = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
  },
  yandex: {
    auth: "https://oauth.yandex.ru/authorize",
    token: "https://oauth.yandex.ru/token",
  },
};
export function createOAuth(
  config,
  { vault, calendar, getSettings, fetchImpl = fetch, now = () => Date.now() },
) {
  const tickets = new Map(),
    states = new Map();
  const prune = () => {
    for (const map of [tickets, states])
      for (const [k, v] of map) if (v.expires <= now()) map.delete(k);
  };
  function client(provider) {
    if (!definitions[provider]) throw new Error("Unknown provider");
    const id = config[provider + "ClientId"],
      secret = config[provider + "ClientSecret"];
    if (!id || !secret) throw new Error("OAuth application not configured");
    return { id, secret };
  }
  async function json(url, options) {
    const r = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error("Provider authorization failed");
    return r.json();
  }
  return {
    async status() {
      const result = {};
      for (const provider of Object.keys(definitions)) {
        const data = await vault.get(provider);
        result[provider] = {
          configured: !!(
            config[provider + "ClientId"] && config[provider + "ClientSecret"]
          ),
          connected: !!data?.calendarReady,
          needsCaldav: provider === "yandex" && !!data && !data.calendarReady,
        };
      }
      return result;
    },
    begin(provider) {
      client(provider);
      if (new URL(config.publicBaseUrl).protocol !== "https:")
        throw new Error("HTTPS URL required");
      prune();
      if (tickets.size + states.size >= 50)
        throw new Error("Too many authorization attempts");
      const ticket = randomBytes(24).toString("hex");
      tickets.set(ticket, { provider, expires: now() + 5 * 60000 });
      return config.publicBaseUrl + "/oauth/start?ticket=" + ticket;
    },
    start(ticket) {
      prune();
      const t = tickets.get(ticket);
      tickets.delete(ticket);
      if (!t) throw new Error("Authorization link expired");
      const c = client(t.provider),
        state = randomBytes(24).toString("hex"),
        browser = randomBytes(24).toString("hex"),
        verifier = randomBytes(32).toString("base64url");
      states.set(state, {
        ...t,
        state,
        browserHash: createHash("sha256").update(browser).digest(),
        verifier,
        expires: now() + 10 * 60000,
      });
      const url = new URL(definitions[t.provider].auth);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", c.id);
      url.searchParams.set(
        "redirect_uri",
        config.publicBaseUrl + "/oauth/callback/" + t.provider,
      );
      url.searchParams.set("state", state);
      if (t.provider === "google") {
        url.searchParams.set(
          "scope",
          getSettings().calendarWriteEnabled
            ? "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly"
            : "https://www.googleapis.com/auth/calendar.readonly",
        );
        url.searchParams.set("access_type", "offline");
        url.searchParams.set("prompt", "consent");
        url.searchParams.set(
          "code_challenge",
          createHash("sha256").update(verifier).digest("base64url"),
        );
        url.searchParams.set("code_challenge_method", "S256");
      }
      return {
        url: url.toString(),
        cookie:
          "pa_oauth=" +
          browser +
          "; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=600",
      };
    },
    async callback(provider, params, browser) {
      prune();
      const state = params.get("state"),
        s = states.get(state);
      states.delete(state);
      if (
        !s ||
        s.provider !== provider ||
        typeof browser !== "string" ||
        !timingSafeEqual(
          s.browserHash,
          createHash("sha256").update(browser).digest(),
        )
      )
        throw new Error("Authorization state invalid");
      if (params.has("error") || !params.get("code"))
        throw new Error("Authorization cancelled");
      const c = client(provider);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: params.get("code"),
        client_id: c.id,
        client_secret: c.secret,
        redirect_uri: config.publicBaseUrl + "/oauth/callback/" + provider,
        ...(provider === "google" ? { code_verifier: s.verifier } : {}),
      });
      const tokens = await json(definitions[provider].token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!tokens.access_token) throw new Error("Authorization failed");
      const record = {
        ...tokens,
        expires_at: now() + Number(tokens.expires_in || 3600) * 1000,
        calendarReady: false,
      };
      if (provider === "google" && !tokens.refresh_token)
        throw new Error("Offline access not granted");
      if (provider === "yandex") {
        const user = await json("https://login.yandex.ru/info?format=json", {
          headers: { Authorization: "OAuth " + tokens.access_token },
        });
        record.login = user.default_email || user.login;
        if (!record.login) throw new Error("Yandex account unavailable");
      }
      await vault.set(provider, record);
      const result = await calendar.list();
      record.calendarReady = !result.errors.some((e) =>
        e.toLowerCase().startsWith(provider),
      );
      await vault.set(provider, record);
      return { provider, connected: record.calendarReady };
    },
    async setCaldav(login, appPassword) {
      if (
        typeof login !== "string" ||
        !login.trim() ||
        login.length > 200 ||
        typeof appPassword !== "string" ||
        appPassword.length < 8 ||
        appPassword.length > 200
      )
        throw new Error("Invalid CalDAV credentials");
      const record = { login: login.trim(), appPassword, calendarReady: false };
      await vault.set("yandex", record);
      const result = await calendar.list();
      record.calendarReady = !result.errors.some((e) => e.startsWith("Yandex"));
      await vault.set("yandex", record);
      if (!record.calendarReady) throw new Error("CalDAV access unavailable");
    },
    async disconnect(provider) {
      if (!definitions[provider]) throw new Error("Unknown provider");
      await vault.set(provider, null);
    },
  };
}
