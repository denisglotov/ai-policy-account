# Developer Guide: Receipt Parser & Smart Account Transaction Execution

This guide explains how to import, configure, and use receipt parsing (`parseReceipt`) and
ERC-4337 smart account transaction execution (`executePolicyTransaction`) across Node.js,
React Native, and web environments.

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

### Importing with `package.json` (NPM, Monorepo, or Local Dependency)

If installed as a dependency (`"cifra-ruble-policy-account": "*"` or `file:../Cifra-Ruble-backend`),
`package.json` exports all modules directly:

```typescript
// Smart account UserOperation execution (Viem only, zero OpenAI dependencies)
import {
  executePolicyTransaction,
  buildSignedUserOp,
  ENTRY_POINT_ABI,
  POLICY_ACCOUNT_ABI,
  CANONICAL_ENTRY_POINT_07_ADDRESS,
  type ExecutePolicyTxParams,
  type ExecutePolicyTxResult,
} from "cifra-ruble-policy-account/userOp";

// Receipt parser (OpenAI LLM inference)
import {
  parseReceipt,
  isReceiptCached,
  type LLMCredentials,
  type ParsedReceipt,
} from "cifra-ruble-policy-account/oracle";

// Contract ABI
import { POLICY_ACCOUNT_ABI } from "cifra-ruble-policy-account/abi";
```

### Direct Relative File Imports

You can also import directly from relative source paths:

```typescript
import { parseReceipt } from "./src/oracle/receiptParser.js";
import { executePolicyTransaction } from "./src/userOp.js";
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

## Transaction Execution (`executePolicyTransaction`)

[`executePolicyTransaction`](src/userOp.ts) is an isomorphic TypeScript function that builds,
signs, and executes ERC-4337 transactions on `PolicyAccount`. It satisfies the contract's
dual-signature requirement (Owner EIP-191 + AI-Oracle EIP-712) and submits `handleOps` directly
to the ERC-4337 `EntryPoint` contract using Viem.

### Key Features
- **Zero Node Built-in Dependencies**: No `node:fs`, `node:path`, or `node:crypto`. Dynamically
  imports canonical `entryPoint07Abi` and `entryPoint07Address` from `viem/account-abstraction`.
- **Auto-Generated PolicyAccount ABI**: Extracted automatically during build (`npm run build:abi`)
  from `out/` into `src/abi/policyAccountAbi.ts` with `as const` (zero bytecode/AST bloat).
- **Dynamic ABI & EntryPoint Configuration**: Defaults to canonical ERC-4337 v0.7 EntryPoint and
  auto-generated `POLICY_ACCOUNT_ABI`, with optional custom overrides for both ABIs/addresses.
- **Flexible Oracle Signing**: Accepts either a pre-signed approval payload (standard mobile/backend
  architecture) or a local `Account` signer (ideal for development, testing, and hackathons).
- **Auto Gas & Nonce Management**: Automatically fetches account nonce from `EntryPoint`, resolves
  gas fee estimates, packs 32-byte gas limits and fee fields, and allows granular overrides.

---

### Importing in React Native

Import `executePolicyTransaction` and related types via package name or relative path:

```typescript
// Via package subpath export (recommended when installed as a dependency)
import {
  executePolicyTransaction,
  buildSignedUserOp,
  ENTRY_POINT_ABI,
  POLICY_ACCOUNT_ABI,
  CANONICAL_ENTRY_POINT_07_ADDRESS,
  type ExecutePolicyTxParams,
  type ExecutePolicyTxResult,
  type OracleInput,
  type TargetCall,
} from "cifra-ruble-policy-account/userOp";

// Or directly from relative path:
// import { executePolicyTransaction } from "./src/userOp.js";
```

---

### Type Definitions

```typescript
export interface TargetCall {
  to: Address;
  value?: bigint;
  data?: Hex;
}

export type OracleInput =
  | {
      oracleSignature: Hex;
      validUntil: number;
      validAfter?: number;
    }
  | {
      oracleAccount: Account;
      validUntil?: number;
      validAfter?: number;
    };

export interface UserOpGasOverrides {
  verificationGasLimit?: bigint;
  callGasLimit?: bigint;
  preVerificationGas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface ExecutePolicyTxParams {
  publicClient: PublicClient;
  walletClient: WalletClient;
  entryPointAddress?: Address;
  entryPointAbi?: Abi;
  policyAccountAbi?: Abi;
  accountAddress: Address;
  ownerAccount: Account;
  oracle: OracleInput;
  receiptHash: Hex;
  target?: TargetCall;
  callData?: Hex;
  beneficiary?: Address;
  gasOverrides?: UserOpGasOverrides;
  nonceKey?: bigint;
}

export interface ExecutePolicyTxResult {
  transactionHash: Hash;
  receipt: TransactionReceipt;
  userOpHash: Hash;
  success: boolean;
}
```

---

### React Native Usage Examples

#### 1. Production Flow (Pre-Signed Oracle Approval from Backend)

In a typical mobile app architecture:
1. The app sends receipt text or receipt image to your backend API.
2. The backend runs `parseReceipt`, verifies merchant items against spending policy, and signs
   an EIP-712 approval using the AI-Oracle private key.
3. The backend returns `{ oracleSignature, receiptHash, validUntil, validAfter }` to the app.
4. The React Native app signs the UserOp locally with the user's key and executes the transaction:

```typescript
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executePolicyTransaction } from "./src/userOp.js";

// Viem clients configured for your target chain
const publicClient = createPublicClient({
  chain: myChain,
  transport: http(RPC_URL),
});

const relayerWallet = createWalletClient({
  account: relayerOrDeployerAccount,
  chain: myChain,
  transport: http(RPC_URL),
});

// User's local private key account (stored in mobile secure keychain)
const ownerAccount = privateKeyToAccount(userPrivateKey);

// Execute transaction with oracle signature received from backend
const result = await executePolicyTransaction({
  publicClient,
  walletClient: relayerWallet,
  entryPointAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  accountAddress: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
  ownerAccount,
  oracle: {
    oracleSignature: backendResponse.oracleSignature,
    validUntil: backendResponse.validUntil,
    validAfter: backendResponse.validAfter ?? 0,
  },
  receiptHash: backendResponse.receiptHash,
  target: {
    to: merchantAddress,
    value: parseEther("1.5"),
    data: "0x",
  },
});

console.log("Transaction confirmed in block:", result.receipt.blockNumber);
console.log("UserOpHash:", result.userOpHash);
```

#### 2. Local Demo / Testing Flow (Local Oracle Signer)

For hackathon demos or local integration testing, you can pass `oracleAccount` directly. The
function will automatically calculate the block validity timestamp and sign the EIP-712 approval:

```typescript
const result = await executePolicyTransaction({
  publicClient,
  walletClient: relayerWallet,
  entryPointAddress,
  accountAddress,
  ownerAccount,
  oracle: { oracleAccount }, // Signs EIP-712 typed data locally
  receiptHash,
  target: {
    to: merchantAddress,
    value: parseEther("1"),
    data: buyCalldata,
  },
});
```

---

## Required Frontend Configuration (React Native / Client)

To interact with the smart contract wallet and AI-Oracle from React Native, the frontend app
should maintain the following configurations in its application environment or config store:

### 1. Network & RPC Configuration
- **`RPC_URL`**: Target EVM JSON-RPC provider URL (e.g. `http://127.0.0.1:8545` for local Anvil,
  or your network RPC such as `https://sepolia.base.org`).
- **`CHAIN_ID`**: Numeric chain ID (e.g. `31337` for Foundry/Anvil, `84532` for Base Sepolia).

### 2. Smart Contract Addresses
- **`ENTRY_POINT_ADDRESS`**: Canonical ERC-4337 v0.7 EntryPoint contract.
  - On live EVM networks, defaults to `CANONICAL_ENTRY_POINT_07_ADDRESS`:
    `0x0000000071727De22E5E9d8BAf0edAc6f37da032`.
  - On local Anvil testnets, pass your deployed EntryPoint address.
- **`POLICY_ACCOUNT_ADDRESS`**: Address of the user's deployed `PolicyAccount` smart wallet.
- **`MERCHANT_ADDRESS`**: Default destination contract address or merchant payment recipient.

### 3. Backend Oracle API Endpoint (Production Architecture)
- **`ORACLE_BACKEND_URL`**: Base URL of your backend oracle service
  (e.g. `https://api.yourdomain.com`).
  - The frontend uploads the receipt to `POST /api/verify-receipt-and-approve`.
  - The backend parses the receipt, verifies spending policy, and signs the EIP-712 approval.
  - The backend returns `{ oracleSignature, receiptHash, validUntil, validAfter }` to the client.

### 4. Key Management & Signer Security

> [!IMPORTANT]
> The mobile app only holds the **user's owner key**. It **never** holds the AI-Oracle key.

- **User Owner Signer (`ownerAccount`)**: Created from the user's private key, securely stored
  in native hardware keychain:
  - Expo apps: `expo-secure-store`
  - Bare React Native: `react-native-keychain`
- **Gas Payer (`walletClient`)**:
  - In sponsored / relayer setups, transaction submission to `handleOps` is routed through your
    gas-sponsoring relayer or an ERC-4337 Bundler service.
  - In self-funded setups, the user's funded EOA wallet acts as the `walletClient` submitter.

### 5. Standalone / Demo Mode Configurations (Optional)

If running in standalone offline/hackathon demo mode without an external backend service:
- **`OPENROUTER_API_KEY`**: Client-entered or temporary testing LLM API key.
- **`LLM_MODEL`**: Target model, e.g. `inclusionai/ling-3.0-flash-vl:free`.
- **`LLM_BASE_URL`**: Inference endpoint, e.g. `https://openrouter.ai/api/v1`.

---

## Testing & Verification

### Run End-to-End UserOperation Test (`test:e2e`)

Spawns a local Anvil node, deploys EntryPoint and PolicyAccount, executes a UserOperation via
`executePolicyTransaction`, and verifies balances, nullifier consumption, and event emission:

```bash
npm run test:e2e
```

### Run Automated Unit Tests (`test:unit`)

```bash
npm run test:unit
```

### Run Linters & Type Checking (`lint`)

```bash
npm run lint
```

