import { readFileSync } from "node:fs";
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
  baseURL?: string;
  model?: string;
  /**
   * Set to false to disable sending `response_format: { type: "json_object" }`.
   * If omitted, parseReceipt will attempt json_object and automatically retry
   * without it if the provider/model rejects structured outputs.
   */
  jsonMode?: boolean;
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
  if (!credentials || !credentials.apiKey) {
    throw new Error(
      "Missing required LLM credentials: apiKey must be provided",
    );
  }

  const client = new OpenAI({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseURL,
  });

  const model = credentials.model || "gpt-4o-mini";

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

  return cleanAndParseReceiptJson(content);
}
