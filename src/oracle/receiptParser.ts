import OpenAI from "openai";
import { sha256, stringToBytes } from "viem";
import example1Receipt from "../../cache-receipts/a738c3a15bc64b92f36f468d33f654f1b6fbc05fd039bd8f04e96001ac1133f6.json";
import example2Receipt from "../../cache-receipts/768d7d8203113092175afc581d76d05da5ba3c30c4dfdbc92fab4bb33617c508.json";

export const RECEIPT_CATEGORIES = [
  "staple_food",
  "fresh_produce",
  "junk_food",
  "drinks",
  "unhealthy_drinks",
  "alcohol",
  "tobacco",
  "other",
] as const;

export type ReceiptCategory = (typeof RECEIPT_CATEGORIES)[number];

export interface ReceiptItem {
  title: string;
  price: number;
  category: ReceiptCategory;
}

export interface ParsedReceipt {
  items: ReceiptItem[];
  evm_wallets: string[];
}

/**
 * Maximum allowed size for raw receipt text input in bytes (50 KB).
 */
export const MAX_RECEIPT_INPUT_SIZE_BYTES = 50 * 1024;

/**
 * Returns the UTF-8 byte length of a string across Node.js, browser, and React Native environments.
 */
export function getReceiptByteLength(text: string): number {
  if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") {
    return Buffer.byteLength(text, "utf8");
  }
  return new TextEncoder().encode(text).length;
}

export interface LLMCredentials {
  model: string;
  apiKey?: string;
  baseURL?: string;
  /**
   * Set to false to disable sending `response_format: { type: "json_object" }`.
   * If omitted, parseReceipt will attempt json_object and automatically retry
   * without it if the provider/model rejects structured outputs.
   */
  jsonMode?: boolean;
  /**
   * Set to true to bypass cache lookup and force a fresh LLM call.
   */
  noCache?: boolean;
  /**
   * Set to true when running client-side (e.g. React Native / browser). Defaults to true.
   */
  dangerouslyAllowBrowser?: boolean;
}

export const DEFAULT_RECEIPT_SYSTEM_PROMPT = `You are a receipt parsing and classification engine. Your task is to process the entire raw text of a receipt, extract line items with their final prices, classify each product into strictly one of the allowed categories, and extract any EVM (Ethereum Virtual Machine) cryptocurrency wallet addresses found anywhere in the receipt text.

### Allowed Categories:
1. \`staple_food\`: Everyday essentials and staple groceries (meat, poultry, fish, dairy, flour, grains, pasta, sugar, salt, cooking oils, canned goods, basic bread, unsweetened bakery).
2. \`fresh_produce\`: Fresh vegetables, leafy greens, fresh fruits, berries, raw mushrooms.
3. \`junk_food\`: Snacks, chips, crisps, candy, chocolate, snack bars, cookies, biscuits, cakes, sweet pastries, desserts.
4. \`drinks\`: Water (still/sparkling), 100% juices, fruit drinks, unsweetened plant milk, tea, coffee, chicory (loose, ground, or instant).
5. \`unhealthy_drinks\`: Energy drinks, sugary sodas, sweetened bottled iced tea.
6. \`alcohol\`: Beer, cider, wine, spirits, alcoholic cocktails, non-alcoholic beer/wine.
7. \`tobacco\`: Cigarettes, heated tobacco sticks, vape liquids, disposable vapes, rolling tobacco, lighters.
8. \`other\`: Non-food household items, bags, toiletries, service fees, taxes, or unidentifiable lines.

### Parsing Rules:
- Process the entire receipt text top-to-bottom. Ignore headers, footers, total sums, cash/card payment lines, and timestamps when extracting line items.
- Extract only actual purchased items into the \`items\` array.
- For each item, clean up receipt-specific abbreviations where possible (e.g., "п/п", "в/с ж", arithmetic operations) and store the readable product name in \`title\`.
- Extract the final payable line total into \`price\` as a numeric float (e.g., from \`31.90x1.268=40.45\` or \`=19.90\`, extract \`40.45\` and \`19.90\`).
- Scan the entire text for EVM wallet addresses: hexadecimal strings starting with \`0x\` followed by exactly 40 hexadecimal characters (case-insensitive regex pattern: \`0x[a-fA-F0-9]{40}\`).
- Collect all unique EVM addresses found into the \`evm_wallets\` array. If none are found, return an empty array \`[]\`.
- Output strictly valid JSON matching the schema below without markdown formatting or surrounding explanations.

### Output JSON Schema:
{
  "items": [
    {
      "title": "Cleaned product title",
      "price": 0.00,
      "category": "one of the 8 category slugs"
    }
  ],
  "evm_wallets": [
    "0x..."
  ]
}`;

/**
 * Accessor function to get the default system prompt.
 */
export function getDefaultReceiptSystemPrompt(): string {
  return DEFAULT_RECEIPT_SYSTEM_PROMPT;
}

/**
 * Pre-seeded example receipt cache entries from raw JSON files.
 */
const PRESEEDED_CACHE_ITEMS: Record<string, ParsedReceipt> = {
  "a738c3a15bc64b92f36f468d33f654f1b6fbc05fd039bd8f04e96001ac1133f6":
    example1Receipt as ParsedReceipt,
  "768d7d8203113092175afc581d76d05da5ba3c30c4dfdbc92fab4bb33617c508":
    example2Receipt as ParsedReceipt,
};

const inMemoryReceiptCache = new Map<string, ParsedReceipt>(
  Object.entries(PRESEEDED_CACHE_ITEMS).map(([k, v]) => [
    k,
    JSON.parse(JSON.stringify(v)) as ParsedReceipt,
  ]),
);

/**
 * Computes a deterministic SHA-256 cache key based on receipt text, model, and prompt.
 */
export function computeReceiptCacheKey(
  receiptText: string,
  model: string,
  systemPrompt?: string,
): string {
  const prompt = systemPrompt ?? getDefaultReceiptSystemPrompt();
  return sha256(
    stringToBytes(`${receiptText.trim()}::${model}::${prompt}`),
  ).slice(2);
}

/**
 * Checks if a parsed result for the given receipt is already in memory.
 */
export function isReceiptCached(
  receiptText: string,
  credentials?: Partial<LLMCredentials>,
  systemPrompt?: string,
): boolean {
  if (
    typeof receiptText !== "string" ||
    getReceiptByteLength(receiptText) > MAX_RECEIPT_INPUT_SIZE_BYTES ||
    credentials?.noCache
  ) {
    return false;
  }

  const model = credentials?.model || "";
  const key = computeReceiptCacheKey(receiptText, model, systemPrompt);
  return inMemoryReceiptCache.has(key);
}

/**
 * Clears the in-memory cache, restoring the pre-seeded example receipts.
 */
export function clearReceiptCache(): void {
  inMemoryReceiptCache.clear();
  for (const [key, val] of Object.entries(PRESEEDED_CACHE_ITEMS)) {
    inMemoryReceiptCache.set(
      key,
      JSON.parse(JSON.stringify(val)) as ParsedReceipt,
    );
  }
}

/**
 * Returns the number of items stored in the in-memory cache.
 */
export function getReceiptCacheSize(): number {
  return inMemoryReceiptCache.size;
}

function getCachedReceipt(key: string): ParsedReceipt | null {
  const mem = inMemoryReceiptCache.get(key);
  if (mem) {
    return JSON.parse(JSON.stringify(mem)) as ParsedReceipt;
  }
  return null;
}

function setCachedReceipt(key: string, data: ParsedReceipt): void {
  inMemoryReceiptCache.set(
    key,
    JSON.parse(JSON.stringify(data)) as ParsedReceipt,
  );
}

const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

function isStructuredOutputsUnsupportedError(error: unknown): boolean {
  if (!error) return false;
  const str = typeof error === "string" ? error : JSON.stringify(error);
  const msg = error instanceof Error ? error.message : "";
  return (
    str.includes("structured-outputs") ||
    str.includes("response_format") ||
    str.includes("json_object") ||
    str.includes("JSON mode is not supported") ||
    msg.includes("structured-outputs") ||
    msg.includes("response_format")
  );
}

/**
 * Strips markdown code blocks, parses JSON, and sanitizes fields to match the ParsedReceipt schema.
 */
export function cleanAndParseReceiptJson(rawJson: string): ParsedReceipt {
  let cleaned = rawJson.trim();

  // If wrapped in a markdown code block anywhere, extract inner content
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    cleaned = codeBlockMatch[1].trim();
  }

  // Find outermost JSON object
  const startIdx = cleaned.indexOf("{");
  const endIdx = cleaned.lastIndexOf("}");
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(
      `Failed to parse LLM response as JSON: ${error instanceof Error ? error.message : String(error)}. Raw content: "${rawJson}"`,
      { cause: error },
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Parsed JSON root must be an object");
  }

  const parsedObj = parsed as Record<string, unknown>;
  const rawItems = Array.isArray(parsedObj.items) ? parsedObj.items : [];
  const rawWallets = Array.isArray(parsedObj.evm_wallets)
    ? parsedObj.evm_wallets
    : [];

  const allowedCategoriesSet = new Set<string>(RECEIPT_CATEGORIES);

  const items: ReceiptItem[] = rawItems.map((item) => {
    if (typeof item !== "object" || item === null) {
      return {
        title: "Unknown Item",
        price: 0,
        category: "other",
      };
    }

    const itemRecord = item as Record<string, unknown>;
    const title =
      typeof itemRecord.title === "string" && itemRecord.title.trim().length > 0
        ? itemRecord.title.trim()
        : "Unknown Item";

    let price = 0;
    if (
      typeof itemRecord.price === "number" &&
      !Number.isNaN(itemRecord.price)
    ) {
      price = itemRecord.price;
    } else if (typeof itemRecord.price === "string") {
      const parsedPrice = parseFloat(itemRecord.price.replace(/[^\d.-]/g, ""));
      price = Number.isNaN(parsedPrice) ? 0 : parsedPrice;
    }

    const categoryRaw =
      typeof itemRecord.category === "string" ? itemRecord.category.trim() : "";
    const category: ReceiptCategory = allowedCategoriesSet.has(categoryRaw)
      ? (categoryRaw as ReceiptCategory)
      : "other";

    return {
      title,
      price,
      category,
    };
  });

  const walletSet = new Set<string>();
  for (const wallet of rawWallets) {
    if (typeof wallet === "string") {
      const trimmed = wallet.trim();
      if (EVM_ADDRESS_REGEX.test(trimmed)) {
        walletSet.add(trimmed);
      }
    }
  }

  return {
    items,
    evm_wallets: Array.from(walletSet),
  };
}

/**
 * Public function to parse cashier receipt text using an OpenAI-compatible LLM.
 * Adapted for React Native, Node.js, and web browsers.
 *
 * @param receiptText - The raw text of the cashier receipt.
 * @param credentials - OpenAI-compatible credentials (apiKey, optional baseURL, optional model).
 * @param systemPrompt - Optional system prompt (defaults to DEFAULT_RECEIPT_SYSTEM_PROMPT).
 * @returns Strongly typed ParsedReceipt object containing items and detected EVM wallet addresses.
 */
export async function parseReceipt(
  receiptText: string,
  credentials: LLMCredentials,
  systemPrompt: string = getDefaultReceiptSystemPrompt(),
): Promise<ParsedReceipt> {
  if (typeof receiptText !== "string") {
    throw new Error("Invalid receiptText: expected string");
  }

  const inputSizeBytes = getReceiptByteLength(receiptText);
  if (inputSizeBytes > MAX_RECEIPT_INPUT_SIZE_BYTES) {
    throw new Error(
      `Receipt input size (${inputSizeBytes} bytes) exceeds maximum allowed size of 50KB (${MAX_RECEIPT_INPUT_SIZE_BYTES} bytes)`,
    );
  }

  if (!credentials || !credentials.model) {
    throw new Error(
      "Missing required parameter: model must be provided",
    );
  }

  const model = credentials.model;
  const cacheKey = computeReceiptCacheKey(receiptText, model, systemPrompt);

  if (!credentials.noCache) {
    const cached = getCachedReceipt(cacheKey);
    if (cached) {
      return cached;
    }
  }

  if (!credentials.apiKey) {
    throw new Error(
      "Missing required LLM credentials: apiKey must be provided for uncached receipt inference",
    );
  }

  const client = new OpenAI({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseURL,
    dangerouslyAllowBrowser: credentials.dangerouslyAllowBrowser ?? true,
  });

  const requestParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: receiptText,
      },
    ],
  };

  if (credentials.jsonMode !== false) {
    requestParams.response_format = { type: "json_object" };
  }

  let completion: OpenAI.ChatCompletion;
  try {
    completion = await client.chat.completions.create(requestParams);
  } catch (error) {
    // If the model/provider rejects response_format/structured-outputs, retry without it
    if (
      requestParams.response_format &&
      credentials.jsonMode === undefined &&
      isStructuredOutputsUnsupportedError(error)
    ) {
      delete requestParams.response_format;
      completion = await client.chat.completions.create(requestParams);
    } else {
      throw error;
    }
  }

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response received from LLM model");
  }

  const parsed = cleanAndParseReceiptJson(content);

  if (!credentials?.noCache) {
    setCachedReceipt(cacheKey, parsed);
  }

  return parsed;
}
