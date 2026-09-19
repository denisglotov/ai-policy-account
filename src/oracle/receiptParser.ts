import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import OpenAI from "openai";

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

export interface LLMCredentials {
  apiKey: string;
  model: string;
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
}

const inMemoryReceiptCache = new Map<string, ParsedReceipt>();
const CACHE_DIR = path.resolve(process.cwd(), "cache-receipts");

/**
 * Computes a deterministic SHA-256 cache key based on receipt text, model, and prompt.
 */
export function computeReceiptCacheKey(
  receiptText: string,
  model: string,
  systemPrompt?: string,
): string {
  const prompt = systemPrompt ?? getDefaultReceiptSystemPrompt();
  return createHash("sha256")
    .update(`${receiptText.trim()}::${model}::${prompt}`)
    .digest("hex");
}

/**
 * Checks if a parsed result for the given receipt is already in memory or on disk.
 */
export function isReceiptCached(
  receiptText: string,
  credentials?: Partial<LLMCredentials>,
  systemPrompt?: string,
): boolean {
  if (credentials?.noCache) {
    return false;
  }

  const model = credentials?.model || "";
  const key = computeReceiptCacheKey(receiptText, model, systemPrompt);
  if (inMemoryReceiptCache.has(key)) {
    return true;
  }
  try {
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    return existsSync(filePath);
  } catch {
    return false;
  }
}

// Pre-populated example receipt cache keys to preserve on disk
const PRESERVED_CACHE_KEYS = new Set([
  "a738c3a15bc64b92f36f468d33f654f1b6fbc05fd039bd8f04e96001ac1133f6", // Example 1
  "768d7d8203113092175afc581d76d05da5ba3c30c4dfdbc92fab4bb33617c508", // Example 2
]);

/**
 * Clears the in-memory and dynamic on-disk receipt cache.
 * Preserves pre-populated raw cache JSON files for example receipts.
 */
export function clearReceiptCache(): void {
  inMemoryReceiptCache.clear();
  try {
    if (existsSync(CACHE_DIR)) {
      const files = readdirSync(CACHE_DIR);
      for (const file of files) {
        const key = path.basename(file, ".json");
        if (file.endsWith(".json") && !PRESERVED_CACHE_KEYS.has(key)) {
          unlinkSync(path.join(CACHE_DIR, file));
        }
      }
    }
  } catch {
    // Ignore cleanup errors
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

  try {
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as ParsedReceipt;
      inMemoryReceiptCache.set(key, data);
      return data;
    }
  } catch {
    // Ignore read errors
  }

  return null;
}

function setCachedReceipt(key: string, data: ParsedReceipt): void {
  inMemoryReceiptCache.set(key, data);
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Ignore disk write errors
  }
}

let cachedDefaultPrompt: string | null = null;

/**
 * Accessor function to get the default system prompt from default_receipt_system_prompt.txt.
 * Caches the prompt in memory after reading from disk.
 */
export function getDefaultReceiptSystemPrompt(): string {
  if (cachedDefaultPrompt === null) {
    const promptPath = path.resolve(__dirname, "default_receipt_system_prompt.txt");
    cachedDefaultPrompt = readFileSync(promptPath, "utf-8").trim();
  }
  return cachedDefaultPrompt;
}

export const DEFAULT_RECEIPT_SYSTEM_PROMPT = getDefaultReceiptSystemPrompt();

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
    throw new Error("LLM response did not parse to a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const rawWallets = Array.isArray(record.evm_wallets)
    ? record.evm_wallets
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
  if (!credentials || !credentials.apiKey || !credentials.model) {
    throw new Error(
      "Missing required LLM credentials: both apiKey and model must be provided",
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

  const client = new OpenAI({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseURL,
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
