import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./store.js";
import { Knowledge } from "./knowledge.js";
import { Vault } from "./vault.js";
import { createCalendarService } from "./calendar.js";
import { createOAuth } from "./oauth.js";
import { readSettings } from "./settings.js";
import { createEngine } from "./engine.js";
import { createSkills } from "./skills.js";

export function createProfiles({ config, registry, telegram }) {
  registry.db
    .exec(`CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,name TEXT,active INTEGER);
    CREATE TABLE IF NOT EXISTS subscriptions(chat TEXT,user TEXT,PRIMARY KEY(chat,user));`);
  const contexts = new Map(),
    tickets = new Map(),
    states = new Map();
  function known(id) {
    return registry.db
      .prepare("SELECT * FROM profiles WHERE id=? AND active=1")
      .get(String(id));
  }
  function register(user) {
    if (!Number.isSafeInteger(user.id) || user.id <= 0)
      throw new Error("Invalid Telegram user");
    if (
      !registry.db
        .prepare("SELECT id FROM profiles WHERE id=?")
        .get(String(user.id)) &&
      registry.db.prepare("SELECT count(*) AS n FROM profiles").get().n >=
        config.maxProfiles
    )
      throw new Error("Profile capacity reached");
    registry.db
      .prepare(
        "INSERT INTO profiles VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=1",
      )
      .run(String(user.id), String(user.first_name || "").slice(0, 100));
    registry.register(user);
    return get(user.id);
  }
  function get(id) {
    id = String(id);
    if (!known(id)) throw new Error("Start bot first");
    if (contexts.has(id)) return contexts.get(id);
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Invalid profile");
    const directory = resolve(config.dataDir, "profiles", id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const store = new Store(resolve(directory, "personal.sqlite")),
      knowledge = new Knowledge(store);
    const ownConfig = { ...config, ownerId: id },
      getSettings = () => readSettings(store, ownConfig);
    const vault = config.vaultKey
      ? new Vault(resolve(directory, "vault.json"), config.vaultKey)
      : null;
    const calendar = vault
      ? createCalendarService(ownConfig, { vault, getSettings })
      : null;
    const oauth = vault
      ? createOAuth(ownConfig, { vault, calendar, getSettings })
      : null;
    const engine = createEngine({
      config: ownConfig,
      store,
      telegram,
      calendar,
      knowledge,
    });
    const skills = createSkills({
      config: ownConfig,
      knowledge,
      calendar,
      getSettings,
      notify: (text) => telegram.send(id, text),
    });
    const ctx = {
      id,
      config: ownConfig,
      store,
      knowledge,
      calendar,
      oauth,
      engine,
      skills,
      getSettings,
    };
    contexts.set(id, ctx);
    return ctx;
  }
  function pruneFlows() {
    for (const map of [tickets, states])
      for (const [key, v] of map) if (v.expires < Date.now()) map.delete(key);
  }
  const oauthRouter = {
    start(ticket) {
      pruneFlows();
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      if (!entry) throw new Error("Expired OAuth ticket");
      const result = get(entry.id).oauth.start(ticket);
      states.set(new URL(result.url).searchParams.get("state"), entry);
      return result;
    },
    async callback(provider, params, cookie) {
      pruneFlows();
      const state = params.get("state"),
        entry = states.get(state);
      states.delete(state);
      if (!entry) throw new Error("Expired OAuth state");
      return get(entry.id).oauth.callback(provider, params, cookie);
    },
  };
  function webContext(id) {
    const ctx = get(id);
    return {
      ...ctx,
      oauth: ctx.oauth
        ? {
            ...ctx.oauth,
            begin(provider) {
              pruneFlows();
              if (tickets.size + states.size >= 100)
                throw new Error("Too many OAuth flows");
              const url = ctx.oauth.begin(provider),
                ticket = new URL(url).searchParams.get("ticket");
              tickets.set(ticket, {
                id: String(id),
                expires: Date.now() + 10 * 60000,
              });
              return url;
            },
          }
        : null,
    };
  }
  function subscribe(chat, id) {
    if (!known(id)) throw new Error("Unknown user");
    if (
      registry.db
        .prepare("SELECT count(*) AS n FROM subscriptions WHERE user=?")
        .get(String(id)).n >= 8
    )
      throw new Error("Maximum eight groups per profile");
    registry.db
      .prepare("INSERT OR IGNORE INTO subscriptions VALUES(?,?)")
      .run(String(chat), String(id));
  }
  function subscribers(chat) {
    return registry.db
      .prepare(
        "SELECT user FROM subscriptions JOIN profiles ON user=id WHERE chat=? AND active=1",
      )
      .all(String(chat))
      .map((x) => x.user);
  }
  function unsubscribe(chat, id) {
    registry.db
      .prepare("DELETE FROM subscriptions WHERE chat=? AND user=?")
      .run(String(chat), String(id));
  }
  function pause(id) {
    registry.db
      .prepare("UPDATE profiles SET active=0 WHERE id=?")
      .run(String(id));
    registry.unsubscribe(id);
    if (contexts.has(String(id))) {
      contexts.get(String(id)).store.close();
      contexts.delete(String(id));
    }
  }
  function active() {
    return registry.db
      .prepare("SELECT id FROM profiles WHERE active=1")
      .all()
      .map((x) => x.id);
  }
  return {
    known,
    register,
    get,
    webContext,
    oauthRouter,
    subscribe,
    subscribers,
    unsubscribe,
    pause,
    active,
    syncContacts(ctx) {
      ctx.store.db.prepare("UPDATE contacts SET active=0").run();
      for (const c of registry.contacts())
        ctx.store.register({
          id: c.chat_id,
          username: c.username,
          first_name: c.name,
        });
    },
    close() {
      for (const c of contexts.values()) c.store.close();
      contexts.clear();
    },
  };
}
