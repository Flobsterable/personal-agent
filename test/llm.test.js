import test from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/llm.js";

const config = { baseUrl: "https://api.deepseek.com", model: "test", apiKey: "test" };
test("every model request specifies JSON and exactly one action, including group questions", async () => {
  const result = await plan(config, [{ role: "user", content: "Сводка обсуждения" }], {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.match(body.messages[0].content, /ОДНО действие/);
      assert.match(body.messages[0].content, /JSON/);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"action":"answer","args":{"text":"ok"}}' } }] });
    },
  });
  assert.equal(result.args.text, "ok");
});
test("multiple model actions are rejected and regenerated before execution", async () => {
  let calls = 0;
  const result = await plan(config, [{ role: "user", content: "Сводка" }], {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (calls++) assert.match(body.messages.at(-1).content, /Предыдущий ответ нарушил формат/);
      return Response.json({ choices: [{ finish_reason: "stop", message: {
        content: calls === 1
          ? '{"action":"notes","args":{}}\n{"action":"tasks","args":{}}'
          : '{"action":"answer","args":{"text":"ok"}}',
      } }] });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.action, "answer");
});
test("invalid JSON retries are bounded and do not expose model contents", async () => {
  let calls = 0;
  await assert.rejects(plan(config, [], { fetchImpl: async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: "private invalid text" } }] });
  } }), { message: "Invalid model action" });
  assert.equal(calls, 2);
});
