import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RECEIPT_SYSTEM_PROMPT,
  RECEIPT_CATEGORIES,
  cleanAndParseReceiptJson,
  getDefaultReceiptSystemPrompt,
  parseReceipt,
} from "../../src/oracle/receiptParser.js";

test("getDefaultReceiptSystemPrompt returns non-empty prompt from txt file matching categories", () => {
  const prompt = getDefaultReceiptSystemPrompt();
  assert.ok(prompt.length > 0);
  assert.strictEqual(prompt, DEFAULT_RECEIPT_SYSTEM_PROMPT);

  for (const category of RECEIPT_CATEGORIES) {
    assert.ok(
      prompt.includes(category),
      `System prompt must mention category '${category}'`
    );
  }
  assert.ok(prompt.includes("evm_wallets"));
  assert.ok(prompt.includes("items"));
});

test("cleanAndParseReceiptJson correctly parses valid JSON", () => {
  const sampleJson = JSON.stringify({
    items: [
      { title: "Томаты", price: 40.45, category: "fresh_produce" },
      { title: "Молоко", price: 19.9, category: "staple_food" },
    ],
    evm_wallets: ["0x9793Dd93D46F153a2A879165cd163A01b54d8A00"],
  });

  const result = cleanAndParseReceiptJson(sampleJson);
  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(result.items[0]?.title, "Томаты");
  assert.strictEqual(result.items[0]?.price, 40.45);
  assert.strictEqual(result.items[0]?.category, "fresh_produce");
  assert.strictEqual(result.items[1]?.title, "Молоко");
  assert.strictEqual(result.items[1]?.price, 19.9);
  assert.strictEqual(result.items[1]?.category, "staple_food");
  assert.deepStrictEqual(result.evm_wallets, ["0x9793Dd93D46F153a2A879165cd163A01b54d8A00"]);
});

test("cleanAndParseReceiptJson strips markdown code blocks and whitespace", () => {
  const fenced = "```json\n" + JSON.stringify({
    items: [{ title: "Хлеб", price: 25.5, category: "staple_food" }],
    evm_wallets: [],
  }) + "\n```";

  const result = cleanAndParseReceiptJson(fenced);
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0]?.title, "Хлеб");
  assert.strictEqual(result.items[0]?.price, 25.5);
  assert.deepStrictEqual(result.evm_wallets, []);
});

test("cleanAndParseReceiptJson handles string prices and unknown categories", () => {
  const data = JSON.stringify({
    items: [
      { title: "Пакет", price: " 15.50 ", category: "unknown_category_slug" },
      { title: "Товар без цены", price: "abc", category: "junk_food" },
    ],
    evm_wallets: [
      "0x9793Dd93D46F153a2A879165cd163A01b54d8A00",
      "0x9793Dd93D46F153a2A879165cd163A01b54d8A00", // duplicate
      "not-an-evm-address",
      "0x123", // invalid length
    ],
  });

  const result = cleanAndParseReceiptJson(data);
  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(result.items[0]?.title, "Пакет");
  assert.strictEqual(result.items[0]?.price, 15.5);
  assert.strictEqual(result.items[0]?.category, "other"); // fallback to 'other'

  assert.strictEqual(result.items[1]?.title, "Товар без цены");
  assert.strictEqual(result.items[1]?.price, 0); // fallback to 0
  assert.strictEqual(result.items[1]?.category, "junk_food");

  // Only valid EVM address, deduplicated
  assert.deepStrictEqual(result.evm_wallets, ["0x9793Dd93D46F153a2A879165cd163A01b54d8A00"]);
});

test("cleanAndParseReceiptJson throws error on completely invalid JSON", () => {
  assert.throws(
    () => cleanAndParseReceiptJson("invalid json"),
    /Failed to parse LLM response as JSON/
  );
});

test("parseReceipt throws when apiKey is missing", async () => {
  await assert.rejects(
    () => parseReceipt("receipt text", { apiKey: "" }),
    /Missing required LLM credentials/
  );
});

test("parseReceipt properly configures OpenAI call and returns parsed result", async () => {
  let capturedModel = "";
  let capturedMessages: Array<{ role: string; content: string }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    capturedModel = body.model;
    capturedMessages = body.messages;

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  { title: "Томаты 50+", price: 40.45, category: "fresh_produce" },
                  { title: "Печенье Овсяное", price: 45.0, category: "junk_food" },
                ],
                evm_wallets: ["0x9793Dd93D46F153a2A879165cd163A01b54d8A00"],
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }) as typeof globalThis.fetch;

  try {
    const receiptText = "1 Томаты 50+ 40.45\n14 Печенье Овсяное 45.00\n0x9793Dd93D46F153a2A879165cd163A01b54d8A00";
    const result = await parseReceipt(receiptText, {
      apiKey: "test-fake-key",
      model: "gpt-4o",
    });

    assert.strictEqual(capturedModel, "gpt-4o");
    assert.strictEqual(capturedMessages.length, 2);
    assert.strictEqual(capturedMessages[0]?.role, "system");
    assert.strictEqual(capturedMessages[0]?.content, DEFAULT_RECEIPT_SYSTEM_PROMPT);
    assert.strictEqual(capturedMessages[1]?.role, "user");
    assert.strictEqual(capturedMessages[1]?.content, receiptText);

    assert.strictEqual(result.items.length, 2);
    assert.strictEqual(result.items[0]?.title, "Томаты 50+");
    assert.strictEqual(result.items[0]?.price, 40.45);
    assert.strictEqual(result.items[0]?.category, "fresh_produce");
    assert.strictEqual(result.items[1]?.title, "Печенье Овсяное");
    assert.strictEqual(result.items[1]?.price, 45);
    assert.strictEqual(result.items[1]?.category, "junk_food");
    assert.deepStrictEqual(result.evm_wallets, ["0x9793Dd93D46F153a2A879165cd163A01b54d8A00"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseReceipt uses default model gpt-4o-mini if model omitted", async () => {
  let capturedModel = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    capturedModel = body.model;

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ items: [], evm_wallets: [] }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }) as typeof globalThis.fetch;

  try {
    await parseReceipt("empty receipt", { apiKey: "test-fake-key" });
    assert.strictEqual(capturedModel, "gpt-4o-mini");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cleanAndParseReceiptJson correctly processes the user's example receipt payload", () => {
  const exampleReceiptLlmResponse = JSON.stringify({
    items: [
      { title: "Томаты 50+", price: 40.45, category: "fresh_produce" },
      { title: "Молоко Сибирская Милена", price: 19.9, category: "staple_food" },
      { title: "Соль Илецкая поваренная", price: 9.0, category: "staple_food" },
      { title: "Колбаса вареная Молочная", price: 81.5, category: "staple_food" },
      { title: "Сметана Снеда 15%", price: 45.5, category: "staple_food" },
      { title: "Масло сладко-сливочное", price: 35.0, category: "staple_food" },
      { title: "Ряженка Для всей семьи", price: 22.0, category: "staple_food" },
      { title: "Цикорий Цикорич с экстрактом", price: 46.0, category: "drinks" },
      { title: "Говядина тушеная", price: 44.9, category: "staple_food" },
      { title: "Сахар песок 1кг", price: 30.9, category: "staple_food" },
      { title: "Бананы Эквадор", price: 20.62, category: "fresh_produce" },
      { title: "Макаронные изделия Гранмулино", price: 15.9, category: "staple_food" },
      { title: "Сыр Гауда 48%", price: 43.38, category: "staple_food" },
      { title: "Печенье Овсяное Новое", price: 45.0, category: "junk_food" },
      { title: "Хлеб Урицкий нарезка", price: 25.5, category: "staple_food" },
      { title: "Рис Акмаржан круглозерный", price: 27.9, category: "staple_food" },
    ],
    evm_wallets: ["0x9793Dd93D46F153a2A879165cd163A01b54d8A00"],
  });

  const parsed = cleanAndParseReceiptJson(exampleReceiptLlmResponse);
  assert.strictEqual(parsed.items.length, 16);
  assert.strictEqual(parsed.evm_wallets.length, 1);
  assert.strictEqual(parsed.evm_wallets[0], "0x9793Dd93D46F153a2A879165cd163A01b54d8A00");

  const totalSum = parsed.items.reduce((sum, item) => sum + item.price, 0);
  assert.strictEqual(Number(totalSum.toFixed(2)), 553.45);
});

test("cleanAndParseReceiptJson extracts JSON surrounded by conversational text and markdown fences", () => {
  const conversationalResponse =
    "Here is the parsed receipt you requested:\n\n```json\n" +
    JSON.stringify({
      items: [{ title: "Томаты", price: 40.45, category: "fresh_produce" }],
      evm_wallets: ["0x9793Dd93D46F153a2A879165cd163A01b54d8A00"],
    }) +
    "\n```\n\nHope this helps!";

  const result = cleanAndParseReceiptJson(conversationalResponse);
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0]?.title, "Томаты");
  assert.strictEqual(result.items[0]?.price, 40.45);
  assert.deepStrictEqual(result.evm_wallets, ["0x9793Dd93D46F153a2A879165cd163A01b54d8A00"]);
});

test("parseReceipt respects jsonMode: false and does not send response_format", async () => {
  let capturedResponseFormat: unknown = "uninitialized";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    capturedResponseFormat = body.response_format;

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ items: [], evm_wallets: [] }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }) as typeof globalThis.fetch;

  try {
    await parseReceipt("receipt text", {
      apiKey: "test-fake-key",
      jsonMode: false,
    });
    assert.strictEqual(capturedResponseFormat, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseReceipt automatically retries without response_format if provider rejects structured-outputs", async () => {
  let callCount = 0;
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount++;
    const body = JSON.parse(init?.body as string);
    requests.push(body);

    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          code: 400,
          message: "Provider returned error",
          metadata: {
            raw: '{"code":400, "reason":"INVALID_REQUEST_BODY", "message":"model: inclusionai/ling-3.0-flash-vl does not support feature: structured-outputs"}',
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ title: "Сыр Гауда", price: 43.38, category: "staple_food" }],
                evm_wallets: [],
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }) as typeof globalThis.fetch;

  try {
    const result = await parseReceipt("receipt text", { apiKey: "test-fake-key" });
    assert.strictEqual(callCount, 2);
    // First call had response_format
    assert.deepStrictEqual(requests[0]?.response_format, { type: "json_object" });
    // Retry call omitted response_format
    assert.strictEqual(requests[1]?.response_format, undefined);
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.items[0]?.title, "Сыр Гауда");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

