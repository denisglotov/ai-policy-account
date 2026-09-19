# Developer Guide: Receipt Parser (`parseReceipt`)

This guide explains how to import, configure, and use `parseReceipt` across Node.js, React Native,
and web browsers, as well as how to run manual AI tests.

---

## Overview

[`parseReceipt`](src/oracle/receiptParser.ts) is an isomorphic TypeScript function that uses an
OpenAI-compatible LLM to:
- Parse messy cashier receipt text into structured line items (`title`, `price`, `category`).
- Classify line items into 8 standard categories (`staple_food`, `fresh_produce`, `junk_food`,
  `drinks`, `unhealthy_drinks`, `alcohol`, `tobacco`, `other`).
- Extract any EVM cryptocurrency wallet addresses (`0x[a-fA-F0-9]{40}`) present in the text.
- Cache parsed results in memory with zero native Node.js dependencies (`node:fs`, `node:crypto`).

---

## Installation & Import

### Importing in Node.js or React Native

You can import `parseReceipt` directly into your project:

```typescript
import {
  parseReceipt,
  isReceiptCached,
  type LLMCredentials,
  type ParsedReceipt,
} from "./src/oracle/receiptParser.js";
```

### Type Definitions

```typescript
export interface ReceiptItem {
  title: string;
  price: number;
  category: ReceiptCategory;
}

export interface ParsedReceipt {
  items: ReceiptItem[];
  evm_wallets: string[];
}

export interface LLMCredentials {
  model: string;
  apiKey?: string;
  baseURL?: string;
  jsonMode?: boolean;
  noCache?: boolean;
  dangerouslyAllowBrowser?: boolean;
}
```

---

## Usage Examples

### 1. Basic Usage (Uncached Receipt)

When parsing an uncached receipt, provide the target `model`, `apiKey`, and optional `baseURL`:

```typescript
const credentials: LLMCredentials = {
  model: "inclusionai/ling-3.0-flash-vl:free",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
};

const receiptText = `
Чек ПРОДАЖА № 102
Молоко 1л       = 85.00
Хлеб нарезка    = 42.00
0x9793Dd93D46F153a2A879165cd163A01b54d8A00
`;

const result = await parseReceipt(receiptText, credentials);
console.log(result.items);
console.log(result.evm_wallets);
```

### 2. Cached Receipts (No API Key Required)

If a receipt was previously parsed in memory or is one of the pre-seeded example receipts,
`parseReceipt` returns the cached result with 0ms latency. In this case, `apiKey` is optional:

```typescript
if (isReceiptCached(receiptText, { model: "inclusionai/ling-3.0-flash-vl:free" })) {
  // No apiKey needed for cached receipts
  const result = await parseReceipt(receiptText, {
    model: "inclusionai/ling-3.0-flash-vl:free",
  });
  console.log("Served instantly from cache:", result);
}
```

---

## React Native & Client-Side Environments

### Zero Node Built-in Dependencies

`receiptParser.ts` has been adapted for client-side environments (React Native, Metro bundler,
web browsers):
- **No `node:fs` or `node:path`**: File caching is removed; caching uses an in-memory `Map`.
- **No `node:crypto`**: Uses `viem`'s standard, cross-platform `sha256` implementation.
- **Pre-seeded JSONs**: Metro bundles the pre-seeded JSON cache fixtures at compile time.

### `dangerouslyAllowBrowser`

The official `openai` JS SDK protects developers by refusing to initialize in browser-like or
mobile environments where API keys might be exposed to end users:
```
Error: It looks like you're running in a browser-like environment.
This is disabled by default, as it risks exposing your secret API credentials to attackers.
```

To enable execution directly inside React Native or web apps:
- `parseReceipt` passes `dangerouslyAllowBrowser: credentials.dangerouslyAllowBrowser ?? true`
  to the OpenAI client constructor by default.
- You can also explicitly specify it in credentials:
  ```typescript
  const result = await parseReceipt(receiptText, {
    model: "inclusionai/ling-3.0-flash-vl:free",
    apiKey: userEnteredKey,
    baseURL: "https://openrouter.ai/api/v1",
    dangerouslyAllowBrowser: true,
  });
  ```

> [!TIP]
> In production mobile apps, prefer proxying inference calls through your own backend rather
> than embedding a permanent master API key in the client bundle.

---

## Input Size Limit (50 KB)

`parseReceipt` strictly enforces a 50 KB input limit:
- Constant: `MAX_RECEIPT_INPUT_SIZE_BYTES = 50 * 1024` (51,200 bytes).
- UTF-8 byte length is validated upfront using `getReceiptByteLength(text)`.
- If `receiptText` exceeds 50 KB, `parseReceipt` rejects immediately with an error:
  `Receipt input size (... bytes) exceeds maximum allowed size of 50KB (51200 bytes)`.
- `isReceiptCached` returns `false` safely for oversized inputs without hashing.

---

## Running Manual AI Tests (`test:ai <url>`)

A CLI test utility is provided in
[`test/manual/parseRealReceipt.ts`](test/manual/parseRealReceipt.ts)
to test real receipts against OpenRouter or any OpenAI-compatible provider.

### Running with a Receipt URL

Pass an HTTP/HTTPS URL directly to `npm run test:ai`:

```bash
OPENROUTER_API_KEY=sk-or-v1-... npm run test:ai -- https://raw.githubusercontent.com/.../receipt.txt
```

### Running with a Local File

Pass a local file path:

```bash
OPENROUTER_API_KEY=sk-or-v1-... npm run test:ai -- ./sample_receipt.txt
```

### Options & Flags

| Option / Flag | Description | Default |
| :--- | :--- | :--- |
| `<URL_OR_FILE>` | Receipt URL or local file path (required) | — |
| `-o`, `--output <path>` | Destination file for the parsed JSON output | `./receipt_output.json` |
| `--no-cache` | Force a fresh LLM call, bypassing cached items | `false` |

### Example Output

```text
==================================================================
Running AI receipt parsing test against OpenRouter
Receipt Source: https://example.com/receipt.txt
Endpoint:       https://openrouter.ai/api/v1
Model:          inclusionai/ling-3.0-flash-vl:free
Output File:    ./receipt_output.json
Bypass Cache:   NO
==================================================================

Loaded receipt file (1642 characters).
Cache Status:  HIT (served from cache ⚡)

--- Extracted Items ---
+---------+---------------+-------+-----------------+
| (index) | title         | price | category        |
+---------+---------------+-------+-----------------+
| 0       | 'Томаты'      | 40.45 | 'fresh_produce' |
| 1       | 'Молоко'      | 19.90 | 'staple_food'   |
+---------+---------------+-------+-----------------+

--- Extracted EVM Wallets ---
[ '0x9793Dd93D46F153a2A879165cd163A01b54d8A00' ]

Items count:     2
Total item sum:  60.35
Latency:         2ms

💾 Saved AI output JSON to: ./receipt_output.json
✅ AI test completed successfully!
```

---

## Unit Testing

Run the automated unit test suite:

```bash
npm run test:unit
```

Run code formatting and linters:

```bash
npm run lint
```
