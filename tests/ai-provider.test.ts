import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { aiConfiguration, aiStatus } from "../src/lib/ai-config";
import { askAI } from "../src/lib/ai";
import { db } from "../src/lib/db";
import {
  dateForDay,
  type Draft,
  type Preferences,
} from "../src/lib/validation";
import { saveCatalogPlan } from "../src/lib/travel";

const directory = mkdtempSync(join(tmpdir(), "sanaa-ai-provider-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
const names = [
  "AI_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
];
const originalEnv = Object.fromEntries(
  names.map((name) => [name, process.env[name]]),
);
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of names) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});
after(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});
function configure(provider = "azure") {
  process.env.AI_PROVIDER = provider;
  process.env.OPENAI_API_KEY = "fixture-openai-not-a-real-key";
  process.env.OPENAI_MODEL = "fixture-openai-model";
  process.env.AZURE_OPENAI_ENDPOINT =
    "https://kenyatravel-fixture.openai.azure.com";
  process.env.AZURE_OPENAI_API_KEY = "fixture-azure-not-a-real-key";
  process.env.AZURE_OPENAI_DEPLOYMENT = "kenyatravel-gpt41mini";
}
const userId = randomUUID();
db()
  .prepare(
    "INSERT INTO users(id,email,name,password_hash,role) VALUES (?,?,?,?,'customer')",
  )
  .run(userId, "ai-fixture@example.test", "Synthetic visitor", "!");
const startDate = dateForDay(new Date().toISOString().slice(0, 10), 60);
const preferences: Preferences = {
  startDate,
  endDate: dateForDay(startDate, 5),
  partySize: 2,
  budget: 4000,
  currency: "USD",
  interests: ["Wildlife"],
};

test("direct OpenAI remains the default with unchanged endpoint and explicit provider identity", () => {
  configure("openai");
  delete process.env.AI_PROVIDER;
  const config = aiConfiguration();
  assert.equal(config.provider, "openai");
  assert.equal(config.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(config.model, "fixture-openai-model");
  assert.equal(
    config.headers.Authorization,
    `Bearer ${process.env.OPENAI_API_KEY}`,
  );
  assert.equal(config.headers["api-key"], undefined);
  assert.equal(aiStatus().ready, true);
});
test("Azure uses its deployment name, supported v1 endpoint and api-key without direct OpenAI credentials", () => {
  configure();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  const config = aiConfiguration();
  assert.equal(
    config.url,
    "https://kenyatravel-fixture.openai.azure.com/openai/v1/chat/completions",
  );
  assert.equal(config.model, "kenyatravel-gpt41mini");
  assert.equal(config.headers["api-key"], process.env.AZURE_OPENAI_API_KEY);
  assert.equal(config.headers.Authorization, undefined);
  assert.deepEqual(aiStatus(), {
    ready: true,
    provider: "azure",
    label: "Azure OpenAI",
  });
  for (const endpoint of [
    "https://fixture.cognitiveservices.azure.com/",
    "https://fixture.services.ai.azure.com",
  ]) {
    process.env.AZURE_OPENAI_ENDPOINT = endpoint;
    assert.equal(aiStatus().ready, true);
  }
});
test("incomplete/invalid selected providers never fall back to configured alternate credentials", async () => {
  configure();
  delete process.env.AZURE_OPENAI_API_KEY;
  assert.equal(aiStatus().ready, false);
  await assert.rejects(
    askAI(userId, "enquiry", "Which curated wildlife trips are available?"),
    /AZURE_OPENAI_API_KEY/,
  );
  configure("unsupported");
  assert.equal(aiStatus().ready, false);
  assert.throws(aiConfiguration, /AI_PROVIDER/);
  configure("openai");
  delete process.env.OPENAI_API_KEY;
  assert.equal(aiStatus().ready, false);
  assert.throws(aiConfiguration, /OPENAI_API_KEY/);
});
test("Azure configuration rejects arbitrary credential destinations and non-origin URLs", () => {
  configure();
  for (const endpoint of [
    "http://fixture.openai.azure.com",
    "https://untrusted.example",
    "https://fixture.openai.azure.com.attacker.example",
    "https://user:password@fixture.openai.azure.com",
    "https://fixture.openai.azure.com/openai/v1/",
    "https://fixture.openai.azure.com/?api-key=fixture",
    "https://fixture.openai.azure.com/#fragment",
    "https://127.0.0.1",
    "https://fixture.openai.azure.com:444",
    "not-a-url",
  ]) {
    process.env.AZURE_OPENAI_ENDPOINT = endpoint;
    assert.equal(aiStatus().ready, false);
    assert.throws(aiConfiguration, /AZURE_OPENAI_ENDPOINT/);
  }
  configure();
  process.env.AZURE_OPENAI_DEPLOYMENT = "../../other";
  assert.throws(aiConfiguration, /AZURE_OPENAI_DEPLOYMENT/);
});
test("Azure enquiry and plans keep catalog grounding, strict structured output and server-only price validation", async () => {
  configure();
  const curated = saveCatalogPlan(userId, "wild-heart", preferences);
  const draft: Draft = {
    title: "Kenya wildlife sample itinerary",
    summary: "A synthetic test route grounded in the agency catalog.",
    days: curated.itinerary.days.map(
      ({ day, destinationId, activityIds, travelOnly }) => ({
        day,
        destinationId,
        activityIds,
        travelOnly,
      }),
    ),
  };
  const requests: Record<string, unknown>[] = [];
  let output: object = {
    answer:
      "Our illustrative Maasai Mara wildlife route needs agency availability confirmation.",
  };
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://kenyatravel-fixture.openai.azure.com/openai/v1/chat/completions",
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("api-key"), process.env.AZURE_OPENAI_API_KEY);
    assert.equal(headers.has("authorization"), false);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    assert.equal(request.model, "kenyatravel-gpt41mini");
    assert.equal(request.max_completion_tokens, 3500);
    if (request.tools) {
      assert.equal(request.parallel_tool_calls, false);
      assert.equal(request.tool_choice.function.name, "lookup_catalog");
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "catalog",
                  type: "function",
                  function: { name: "lookup_catalog", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
    }
    assert.equal(request.response_format.json_schema.strict, true);
    const schema = request.response_format.json_schema.schema;
    const schemaText = JSON.stringify(schema);
    for (const keyword of [
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
    ])
      assert.equal(schemaText.includes(`"${keyword}"`), false);
    assert.equal(schema.additionalProperties, false);
    const tool = request.messages.find(
      (message: { role: string }) => message.role === "tool",
    );
    assert.ok(
      JSON.parse(tool.content).destinations.some(
        (destination: { id: string }) => destination.id === "mara",
      ),
    );
    return Response.json({
      choices: [{ message: { content: JSON.stringify(output) } }],
    });
  };
  assert.match(
    (await askAI(userId, "enquiry", "Recommend a wildlife journey")).answer!,
    /Maasai Mara/,
  );
  output = draft;
  const result = await askAI(
    userId,
    "plan",
    "Create a six-day wildlife trip from the catalog",
    preferences,
  );
  assert.ok(result.plan);
  assert.equal(result.plan.itinerary.estimate.amount, 2600);
  assert.equal(result.plan.source, "ai");
  assert.equal(requests.length, 4);
  draft.days[0].activityIds = ["invented"];
  await assert.rejects(
    askAI(userId, "plan", "Create another trip", preferences),
    /not in the agency catalog/,
  );
  output = { ...draft, title: "x" };
  await assert.rejects(
    askAI(userId, "plan", "Create another trip", preferences),
    /Too small/,
  );
});
test("Azure quota and provider failures are visible, bounded and do not call OpenAI as fallback", async () => {
  configure();
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.equal(
      new URL(String(url)).hostname,
      "kenyatravel-fixture.openai.azure.com",
    );
    return new Response("do not expose raw provider details", { status: 429 });
  };
  await assert.rejects(
    askAI(userId, "enquiry", "Recommend wildlife"),
    /Azure OpenAI is at its rate or quota limit/,
  );
  assert.equal(calls, 1);
  globalThis.fetch = async () =>
    new Response("do not expose raw provider details", { status: 401 });
  await assert.rejects(
    askAI(userId, "enquiry", "Recommend wildlife"),
    /Azure OpenAI could not complete/,
  );
  globalThis.fetch = async () => Response.redirect("https://untrusted.example");
  await assert.rejects(
    askAI(userId, "enquiry", "Recommend wildlife"),
    /Azure OpenAI could not complete/,
  );
});
