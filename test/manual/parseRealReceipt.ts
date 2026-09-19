import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseReceipt } from "../../src/oracle/receiptParser.js";

// Try loading .env natively (Node.js 20.6+)
try {
  process.loadEnvFile();
} catch {
  // Ignored if .env does not exist
}

const OPENROUTER_MODEL = "inclusionai/ling-3.0-flash-vl:free";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

async function runTestAi(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.error(
      "❌ OPENROUTER_API_KEY is not set.\n" +
        "Please provide an API key by setting OPENROUTER_API_KEY in your environment or in .env:\n" +
        "  OPENROUTER_API_KEY=sk-or-v1-... npm run test:ai\n",
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const receiptUrl = args.find(
    (arg) => arg.startsWith("http://") || arg.startsWith("https://"),
  );

  if (!receiptUrl) {
    console.error(
      "❌ Receipt URL is required.\n" +
        "Usage:\n" +
        "  npm run test:ai -- <RECEIPT_URL> [--output <path>]\n\n" +
        "Example:\n" +
        "  npm run test:ai -- \"https://gist.githubusercontent.com/.../receipt.txt\"\n",
    );
    process.exit(1);
  }

  const outputFlagIdx = args.findIndex(
    (arg) => arg === "-o" || arg === "--output",
  );
  const outputFile =
    outputFlagIdx !== -1 && args[outputFlagIdx + 1]
      ? path.resolve(args[outputFlagIdx + 1])
      : path.resolve("receipt_output.json");

  console.log(
    "==================================================================",
  );
  console.log("Running AI receipt parsing test against OpenRouter");
  console.log(`Receipt URL: ${receiptUrl}`);
  console.log(`Endpoint:    ${OPENROUTER_BASE_URL}`);
  console.log(`Model:       ${OPENROUTER_MODEL}`);
  console.log(`Output File: ${outputFile}`);
  console.log(
    "==================================================================\n",
  );

  console.log(`Fetching receipt text from: ${receiptUrl}...`);
  const response = await fetch(receiptUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch receipt from ${receiptUrl}: ${response.status} ${response.statusText}`,
    );
  }
  const receiptText = await response.text();
  console.log(`Fetched receipt (${receiptText.length} characters).\n`);

  const startTime = Date.now();

  const parsed = await parseReceipt(receiptText, {
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    model: OPENROUTER_MODEL,
    jsonMode: false,
  });

  const durationMs = Date.now() - startTime;

  console.log("--- Extracted Items ---");
  console.table(parsed.items);

  console.log("\n--- Extracted EVM Wallets ---");
  console.log(parsed.evm_wallets);

  const totalCalculated = parsed.items.reduce(
    (sum, item) => sum + item.price,
    0,
  );
  console.log(`\nItems count:     ${parsed.items.length}`);
  console.log(`Total item sum:  ${totalCalculated.toFixed(2)}`);
  console.log(`Latency:         ${durationMs}ms`);

  // Write the AI output JSON to file
  fs.writeFileSync(outputFile, JSON.stringify(parsed, null, 2), "utf-8");
  console.log(`\n💾 Saved AI output JSON to: ${outputFile}`);

  // Assertions
  assert.ok(
    parsed.items.length > 0,
    "Expected at least one item to be extracted",
  );

  console.log("\n✅ AI test completed successfully!");
}

runTestAi().catch((err) => {
  console.error("\n❌ AI test failed with error:", err);
  process.exit(1);
});
