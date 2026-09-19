import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  keccak256,
  toHex,
  encodeFunctionData,
  decodeEventLog,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { executePolicyTransaction } from "../../src/userOp.js";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const RECEIPT_HASH = keccak256(toHex("RECEIPT_12345"));

// Accounts matching Foundry test setup
const deployerAccount = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const beneficiaryAccount = deployerAccount;
const ownerAccount = privateKeyToAccount(
  "0x00000000000000000000000000000000000000000000000000000000000a11ce",
);
const oracleAccount = privateKeyToAccount(
  "0x0000000000000000000000000000000000000000000000000000000000000b0b",
);

function loadArtifact(relativePath: string) {
  const fullPath = path.resolve(process.cwd(), "out", relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(
      `Artifact not found at ${fullPath}. Did you run "forge build"?`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  return {
    abi: raw.abi,
    bytecode: (raw.bytecode?.object || raw.bytecode) as Hex,
  };
}

async function isNodeResponding(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
    });
    const data = (await res.json()) as { result?: string };
    return Boolean(data?.result);
  } catch {
    return false;
  }
}

function resolveAnvilBin(): string {
  const homeAnvil = path.join(os.homedir(), ".foundry", "bin", "anvil");
  if (fs.existsSync(homeAnvil)) {
    return homeAnvil;
  }
  return "anvil";
}

async function ensureAnvilNode(): Promise<ChildProcess | null> {
  if (await isNodeResponding(RPC_URL)) {
    console.log(`Connected to existing RPC node at ${RPC_URL}`);
    return null;
  }

  const anvilBin = resolveAnvilBin();
  console.log(`Spawning anvil node (${anvilBin})...`);
  const child = spawn(anvilBin, ["--port", "8545", "--silent"], {
    stdio: "ignore",
  });

  const cleanup = () => {
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore error on exit
      }
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(1);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(1);
  });

  const startTime = Date.now();
  while (Date.now() - startTime < 10000) {
    if (await isNodeResponding(RPC_URL)) {
      console.log(`Anvil node started successfully at ${RPC_URL}`);
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Failed to start anvil node within 10s at ${RPC_URL}`);
}

async function main() {
  const anvilProcess = await ensureAnvilNode();

  try {
    const publicClient = createPublicClient({
      chain: foundry,
      transport: http(RPC_URL),
    });

    const deployerWallet = createWalletClient({
      account: deployerAccount,
      chain: foundry,
      transport: http(RPC_URL),
    });

    console.log("1. Loading artifacts...");
    const entryPointArtifact = loadArtifact("EntryPoint.sol/EntryPoint.json");
    const policyAccountArtifact = loadArtifact(
      "PolicyAccount.sol/PolicyAccount.json",
    );
    const mockMerchantArtifact = loadArtifact(
      "PolicyAccount.t.sol/MockMerchant.json",
    );

    console.log("2. Deploying contracts...");
    // Deploy EntryPoint
    const epDeployHash = await deployerWallet.deployContract({
      abi: entryPointArtifact.abi,
      bytecode: entryPointArtifact.bytecode,
    });
    const epReceipt = await publicClient.waitForTransactionReceipt({
      hash: epDeployHash,
    });
    const entryPointAddress = epReceipt.contractAddress as Address;
    assert.ok(entryPointAddress, "EntryPoint deployment failed");
    console.log(`   EntryPoint deployed: ${entryPointAddress}`);

    // Deploy MockMerchant
    const merchantDeployHash = await deployerWallet.deployContract({
      abi: mockMerchantArtifact.abi,
      bytecode: mockMerchantArtifact.bytecode,
    });
    const merchantReceipt = await publicClient.waitForTransactionReceipt({
      hash: merchantDeployHash,
    });
    const merchantAddress = merchantReceipt.contractAddress as Address;
    assert.ok(merchantAddress, "MockMerchant deployment failed");
    console.log(`   MockMerchant deployed: ${merchantAddress}`);

    // Deploy PolicyAccount
    const paDeployHash = await deployerWallet.deployContract({
      abi: policyAccountArtifact.abi,
      bytecode: policyAccountArtifact.bytecode,
      args: [entryPointAddress, ownerAccount.address, oracleAccount.address],
    });
    const paReceipt = await publicClient.waitForTransactionReceipt({
      hash: paDeployHash,
    });
    const accountAddress = paReceipt.contractAddress as Address;
    assert.ok(accountAddress, "PolicyAccount deployment failed");
    console.log(`   PolicyAccount deployed: ${accountAddress}`);

    console.log("3. Funding account and EntryPoint deposit...");
    // Send 10 ETH to account
    const fundHash = await deployerWallet.sendTransaction({
      to: accountAddress,
      value: parseEther("10"),
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });

    // Deposit 2 ETH into EntryPoint for account
    const depositHash = await deployerWallet.writeContract({
      address: entryPointAddress,
      abi: entryPointArtifact.abi,
      functionName: "depositTo",
      args: [accountAddress],
      value: parseEther("2"),
    });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });

    console.log("4. Executing UserOperation via executePolicyTransaction...");
    const orderId = keccak256(toHex("ORDER_999"));
    const buyFuncCallData = encodeFunctionData({
      abi: mockMerchantArtifact.abi,
      functionName: "buy",
      args: [orderId],
    });

    const executionResult = await executePolicyTransaction({
      publicClient,
      walletClient: deployerWallet,
      entryPointAddress,
      accountAddress,
      ownerAccount,
      oracle: { oracleAccount },
      receiptHash: RECEIPT_HASH,
      target: {
        to: merchantAddress,
        value: parseEther("1"),
        data: buyFuncCallData,
      },
      beneficiary: beneficiaryAccount.address,
    });

    assert.strictEqual(
      executionResult.success,
      true,
      "handleOps transaction failed",
    );
    const handleOpsReceipt = executionResult.receipt;
    const userOpHash = executionResult.userOpHash;
    console.log(
      `   Transaction confirmed in block ${handleOpsReceipt.blockNumber} (UserOpHash: ${userOpHash})`,
    );

    console.log("5. Verifying state assertions and events...");
    // Assert merchant received 1 ether
    const merchantBalance = await publicClient.getBalance({
      address: merchantAddress,
    });
    assert.strictEqual(
      merchantBalance,
      parseEther("1"),
      `Expected merchant balance 1 ether, got ${merchantBalance}`,
    );

    // Assert receipt nullifier is consumed
    const isUsed = (await publicClient.readContract({
      address: accountAddress,
      abi: policyAccountArtifact.abi,
      functionName: "usedReceipts",
      args: [RECEIPT_HASH],
    })) as boolean;
    assert.strictEqual(isUsed, true, "Receipt hash nullifier was not consumed");

    // Decode and verify events emitted
    let foundPurchaseApproved = false;
    let foundPurchaseReceived = false;
    let foundExecutionSuccess = false;

    for (const log of handleOpsReceipt.logs) {
      if (log.address.toLowerCase() === accountAddress.toLowerCase()) {
        try {
          const decoded = decodeEventLog({
            abi: policyAccountArtifact.abi,
            data: log.data,
            topics: log.topics,
          }) as { eventName: string; args: Record<string, unknown> };

          if (decoded.eventName === "PurchaseApproved") {
            assert.strictEqual(
              (decoded.args as { receiptHash: Hash }).receiptHash,
              RECEIPT_HASH
            );
            assert.strictEqual(
              (decoded.args as { userOpHash: Hash }).userOpHash,
              userOpHash
            );
            foundPurchaseApproved = true;
          } else if (decoded.eventName === "ExecutionSuccess") {
            assert.strictEqual(
              (decoded.args as { dest: Address }).dest.toLowerCase(),
              merchantAddress.toLowerCase()
            );
            assert.strictEqual(
              (decoded.args as { value: bigint }).value,
              parseEther("1")
            );
            foundExecutionSuccess = true;
          }
        } catch {
          // Log is from a different contract / event
        }
      }

      if (log.address.toLowerCase() === merchantAddress.toLowerCase()) {
        try {
          const decoded = decodeEventLog({
            abi: mockMerchantArtifact.abi,
            data: log.data,
            topics: log.topics,
          }) as { eventName: string; args: Record<string, unknown> };

          if (decoded.eventName === "PurchaseReceived") {
            assert.strictEqual(
              (decoded.args as { payer: Address }).payer.toLowerCase(),
              accountAddress.toLowerCase()
            );
            assert.strictEqual(
              (decoded.args as { amount: bigint }).amount,
              parseEther("1")
            );
            assert.strictEqual(
              (decoded.args as { orderId: Hash }).orderId,
              orderId
            );
            foundPurchaseReceived = true;
          }
        } catch {
          // Ignore non-matching logs
        }
      }
    }

    assert.ok(foundPurchaseApproved, "PurchaseApproved event not found");
    assert.ok(foundPurchaseReceived, "PurchaseReceived event not found");
    assert.ok(foundExecutionSuccess, "ExecutionSuccess event not found");

    console.log("All assertions passed successfully! E2E UserOp test passed.");
  } finally {
    if (anvilProcess && !anvilProcess.killed) {
      anvilProcess.kill("SIGTERM");
    }
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
