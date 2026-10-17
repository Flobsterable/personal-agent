import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export class Vault {
  constructor(path, key) {
    this.path = path;
    this.key = Buffer.from(key || "", "base64");
    if (this.key.length !== 32)
      throw new Error("VAULT_KEY must be 32 random bytes in base64");
    this.queue = Promise.resolve();
    this.loaded = null;
  }
  async load() {
    if (!this.loaded)
      this.loaded = (async () => {
        try {
          const x = JSON.parse(await readFile(this.path, "utf8")),
            dec = createDecipheriv(
              "aes-256-gcm",
              this.key,
              Buffer.from(x.iv, "base64"),
            );
          dec.setAuthTag(Buffer.from(x.tag, "base64"));
          return JSON.parse(
            Buffer.concat([
              dec.update(Buffer.from(x.data, "base64")),
              dec.final(),
            ]).toString("utf8"),
          );
        } catch (e) {
          if (e.code === "ENOENT") return {};
          throw new Error("Cannot decrypt credential vault");
        }
      })();
    return this.loaded;
  }
  async get(provider) {
    const data = await this.load();
    return data[provider] ? JSON.parse(JSON.stringify(data[provider])) : null;
  }
  async set(provider, value) {
    const data = await this.load();
    if (value === null) delete data[provider];
    else data[provider] = value;
    const snapshot = JSON.stringify(data);
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", this.key, iv),
          encrypted = Buffer.concat([
            cipher.update(snapshot, "utf8"),
            cipher.final(),
          ]);
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const tmp = this.path + ".tmp";
        await writeFile(
          tmp,
          JSON.stringify({
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            data: encrypted.toString("base64"),
          }),
          { mode: 0o600 },
        );
        await rename(tmp, this.path);
      });
    await this.queue;
  }
}
