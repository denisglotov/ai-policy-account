import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RECEIPT_SYSTEM_PROMPT,
  RECEIPT_CATEGORIES,
  cleanAndParseReceiptJson,
  clearReceiptCache,
  getDefaultReceiptSystemPrompt,
  isReceiptCached,
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

test("parseReceipt throws when apiKey or model is missing", async () => {
  await assert.rejects(
    () => parseReceipt("receipt text", { apiKey: "", model: "test-model" }),
    /Missing required LLM credentials/
  );
  await assert.rejects(
    () => parseReceipt("receipt text", { apiKey: "key", model: "" }),
    /Missing required LLM credentials/
  );
  await assert.rejects(
    // @ts-expect-error testing missing model parameter
    () => parseReceipt("receipt text", { apiKey: "key" }),
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
      noCache: true,
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

test("parseReceipt properly uses the explicitly provided model", async () => {
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
    await parseReceipt("empty receipt", {
      apiKey: "test-fake-key",
      model: "custom-llm-model-v1",
      noCache: true,
    });
    assert.strictEqual(capturedModel, "custom-llm-model-v1");
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
    await parseReceipt("receipt text for jsonMode false test", {
      apiKey: "test-fake-key",
      model: "test-model",
      jsonMode: false,
      noCache: true,
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
    const result = await parseReceipt("receipt text for retry test", {
      apiKey: "test-fake-key",
      model: "test-model",
      noCache: true,
    });
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

test("parseReceipt caches results and reuses them without making repeated API calls", async () => {
  clearReceiptCache();
  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    fetchCallCount++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ title: "Хлеб Бородинский", price: 30.0, category: "staple_food" }],
                evm_wallets: ["0x9793Dd93D46F153a2A879165cd163A01b54d8A00"],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof globalThis.fetch;

  try {
    const receipt = "UNIQUE_CACHE_RECEIPT_TEXT_TEST_SUITE_123";
    clearReceiptCache();
    assert.strictEqual(isReceiptCached(receipt, { model: "test-model" }), false);

    // Call 1: should fetch from LLM
    const res1 = await parseReceipt(receipt, { apiKey: "test-key", model: "test-model" });
    assert.strictEqual(fetchCallCount, 1);
    assert.strictEqual(res1.items[0]?.title, "Хлеб Бородинский");
    assert.strictEqual(isReceiptCached(receipt, { model: "test-model" }), true);

    // Call 2: should be returned directly from cache (fetchCallCount stays 1)
    const res2 = await parseReceipt(receipt, { apiKey: "test-key", model: "test-model" });
    assert.strictEqual(fetchCallCount, 1);
    assert.deepStrictEqual(res2, res1);

    // Call 3 with noCache: true should bypass cache and call fetch
    const res3 = await parseReceipt(receipt, {
      apiKey: "test-key",
      model: "test-model",
      noCache: true,
    });
    assert.strictEqual(fetchCallCount, 2);
    assert.deepStrictEqual(res3, res1);
  } finally {
    globalThis.fetch = originalFetch;
    clearReceiptCache();
  }
});

const EXAMPLE_RECEIPT_TEXT_1 = `*******************************
Чек ПРОДАЖА № 9999.2.407.518
Касса № 2
15.08.2012 18:57:22
---------------------------------------------
1  Томаты 50+                    31.90x1.268=40.45
2  Молоко Сибиская Милена                   =19.90
3  Соль Илецкая поваренна                    =9.00
4  Колбаса вареная Молочн                   =81.50
5  Сметана Снеда 15% п/п                    =45.50
6  Масло сладко-сливочное                   =35.00
7  Ряженка Для всей семьи                   =22.00
8  Цикорий Цикорич с экст                   =46.00
9  Говядина тушеная в/с ж                   =44.90
10 Сахар песок п/п 1кг                      =30.90
11 Бананы Эквадор                38.90x0.530=20.62
12 Макаронные изделия Гра                   =15.90
13 Сыр Гауда 48 %               199.00x0.218=43.38
14 Печенье Овсяное Новое                    =45.00
15 Хлеб Урицкий нарезка п                   =25.50
16 Рис Акмаржан круглозер                   =27.90
---------------------------------------------
ИТОГО без скидок:                           553.45
Итого скидок:                                 0.45
ИТОГО с учетом скидок:                      553.00
ВНЕСЕНО:                                    555.00
СДАЧА:                                        2.00
Наличные:                                   553.00

            СПАСИБО ЗА ПОКУПКУ!

ИТОГ                                      =553.00
НАЛИЧНЫМИ                                 =553.00
#2747 ДОК. 00123706             К30 15-08-12 18:57
4ККМ с ФП 0002043                  ИНН 0066741211794
  00021505 #022698                 ЭКЛЗ 1426838547
  
  0x9793Dd93D46F153a2A879165cd163A01b54d8A00`;

test("isReceiptCached and parseReceipt reuse raw JSONs in cache for example receipts", async () => {
  const model = "inclusionai/ling-3.0-flash-vl:free";

  // Receipt 1 is cached out-of-the-box via the raw JSON in cache/receipts/
  assert.strictEqual(isReceiptCached(EXAMPLE_RECEIPT_TEXT_1, { model }), true);

  // noCache: true bypasses
  assert.strictEqual(
    isReceiptCached(EXAMPLE_RECEIPT_TEXT_1, { model, noCache: true }),
    false,
  );

  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    throw new Error("fetch should not be called when served from raw cache JSON");
  }) as typeof globalThis.fetch;

  try {
    const res = await parseReceipt(EXAMPLE_RECEIPT_TEXT_1, {
      apiKey: "dummy-key",
      model,
    });
    assert.strictEqual(fetchCallCount, 0);
    assert.strictEqual(res.items.length, 16);
    assert.deepStrictEqual(res.evm_wallets, [
      "0x9793Dd93D46F153a2A879165cd163A01b54d8A00",
    ]);
    const sum = res.items.reduce((s, it) => s + it.price, 0);
    assert.strictEqual(Number(sum.toFixed(2)), 553.45);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


