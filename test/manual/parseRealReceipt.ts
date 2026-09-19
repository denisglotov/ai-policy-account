import assert from "node:assert/strict";
import { parseReceipt } from "../../src/oracle/receiptParser.js";

// Try loading .env natively (Node.js 20.6+)
try {
  process.loadEnvFile();
} catch {
  // Ignored if .env does not exist
}

export const SAMPLE_CASHIER_RECEIPT = `*******************************
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

const OPENROUTER_MODEL = "inclusionai/ling-3.0-flash-vl:free";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

async function runManualTest(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.error(
      "❌ OPENROUTER_API_KEY is not set.\n" +
      "Please provide an API key by setting OPENROUTER_API_KEY in your environment or in .env:\n" +
      "  OPENROUTER_API_KEY=sk-or-v1-... npm run test:manual\n"
    );
    process.exit(1);
  }

  console.log("==================================================================");
  console.log("Running manual receipt parsing test against OpenRouter");
  console.log(`Endpoint: ${OPENROUTER_BASE_URL}`);
  console.log(`Model:    ${OPENROUTER_MODEL}`);
  console.log("==================================================================\n");

  const startTime = Date.now();

  const parsed = await parseReceipt(
    SAMPLE_CASHIER_RECEIPT,
    {
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      model: OPENROUTER_MODEL,
      jsonMode: false,
    }
  );

  const durationMs = Date.now() - startTime;

  console.log("--- Extracted Items ---");
  console.table(parsed.items);

  console.log("\n--- Extracted EVM Wallets ---");
  console.log(parsed.evm_wallets);

  const totalCalculated = parsed.items.reduce((sum, item) => sum + item.price, 0);
  console.log(`\nItems count:     ${parsed.items.length}`);
  console.log(`Total item sum:  ${totalCalculated.toFixed(2)}`);
  console.log(`Latency:         ${durationMs}ms`);

  // Assertions
  assert.ok(parsed.items.length > 0, "Expected at least one item to be extracted");
  const expectedWallet = "0x9793Dd93D46F153a2A879165cd163A01b54d8A00";
  assert.ok(
    parsed.evm_wallets.some((w) => w.toLowerCase() === expectedWallet.toLowerCase()),
    `Expected EVM wallet ${expectedWallet} to be detected`
  );

  console.log("\n✅ Manual test passed successfully!");
}

runManualTest().catch((err) => {
  console.error("\n❌ Manual test failed with error:", err);
  process.exit(1);
});
