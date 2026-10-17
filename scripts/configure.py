"""Run on the VPS. No credentials are printed or passed in command arguments."""
import base64
import getpass
import json
import os
from pathlib import Path

os.umask(0o077)
root = Path(__file__).resolve().parents[1]


def read_env(path):
    values = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if value.startswith('"'):
                try:
                    value = json.loads(value)
                except ValueError:
                    pass
            values[key.strip()] = value.strip("'")
    return values


values = read_env(root / ".env")
old = read_env(Path("/home/user/cosplay-2/tools/dev-assistant/.env"))
token = getpass.getpass("Telegram bot token (Enter keeps existing): ").strip()
if token:
    values["TELEGRAM_BOT_TOKEN"] = token
if not values.get("TELEGRAM_BOT_TOKEN"):
    raise SystemExit("Bot token required; file not changed")
for key in ("LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"):
    values[key] = values.get(key) or old.get(key, "")
if not values.get("LLM_API_KEY"):
    values["LLM_API_KEY"] = getpass.getpass("DeepSeek API key: ").strip()
if not values.get("LLM_MODEL"):
    values["LLM_MODEL"] = input("DeepSeek model ID: ").strip()
values["LLM_BASE_URL"] = values.get("LLM_BASE_URL") or "https://api.deepseek.com"
values["VAULT_KEY"] = values.get("VAULT_KEY") or base64.b64encode(os.urandom(32)).decode()
values.setdefault("MAX_PROFILES", "32")
values.setdefault("TIME_ZONE", "Asia/Omsk")
values.setdefault("MINI_APP_PORT", "8092")
values["PUBLIC_BASE_URL"] = input("Permanent HTTPS URL (Enter keeps existing / no Mini App): ").strip() or values.get("PUBLIC_BASE_URL", "")
if not values.get("LLM_API_KEY") or not values.get("LLM_MODEL"):
    raise SystemExit("Model/key required; file not changed")
temporary = root / ".env.tmp"
temporary.write_text("\n".join(key + "=" + json.dumps(value, ensure_ascii=False) for key, value in values.items()) + "\n", encoding="utf-8")
temporary.chmod(0o600)
temporary.replace(root / ".env")
print("Configuration saved. Start with: sudo docker compose up -d --build")
