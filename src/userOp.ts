import {
  type Abi,
  encodeAbiParameters,
  encodeFunctionData,
  parseGwei,
  toHex,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';

/**
 * Standard ERC-4337 v0.7 PackedUserOperation data structure.
 */
export interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

/**
 * Parameters for target single execution from PolicyAccount.
 */
export interface TargetCall {
  to: Address;
  value?: bigint;
  data?: Hex;
}

/**
 * Oracle approval parameters. Either a pre-computed signature or a local Account signer.
 */
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

/**
 * Optional gas overrides for UserOperation execution.
 */
export interface UserOpGasOverrides {
  verificationGasLimit?: bigint;
  callGasLimit?: bigint;
  preVerificationGas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/**
 * Full parameter list for building and executing a PolicyAccount UserOperation.
 */
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

/**
 * Result returned by executePolicyTransaction.
 */
export interface ExecutePolicyTxResult {
  transactionHash: Hash;
  receipt: TransactionReceipt;
  userOpHash: Hash;
  success: boolean;
}

/**
 * Result returned by buildSignedUserOp.
 */
export interface SignedUserOpResult {
  packedUserOp: PackedUserOperation;
  userOpHash: Hash;
}

/**
 * Canonical EntryPoint v0.7 ABI dynamically imported from viem/account-abstraction.
 */
export const ENTRY_POINT_ABI = entryPoint07Abi;

/**
 * Canonical ERC-4337 EntryPoint v0.7 contract address across EVM chains.
 */
export const CANONICAL_ENTRY_POINT_07_ADDRESS = entryPoint07Address;

import { POLICY_ACCOUNT_ABI } from './abi/policyAccountAbi.js';
export { POLICY_ACCOUNT_ABI };

/**
 * EIP-712 typing for AI-Oracle approval signature.
 */
export const ORACLE_APPROVAL_TYPES = {
  OracleApproval: [
    { name: 'userOpHash', type: 'bytes32' },
    { name: 'receiptHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint48' },
    { name: 'validAfter', type: 'uint48' },
  ],
} as const;

/**
 * Packs verificationGasLimit (high 128 bits) and callGasLimit (low 128 bits) into bytes32.
 */
export function packGasLimits(verificationGasLimit: bigint, callGasLimit: bigint): Hex {
  return toHex((verificationGasLimit << 128n) | callGasLimit, { size: 32 });
}

/**
 * Packs maxPriorityFeePerGas (high 128 bits) and maxFeePerGas (low 128 bits) into bytes32.
 */
export function packGasFees(maxPriorityFeePerGas: bigint, maxFeePerGas: bigint): Hex {
  return toHex((maxPriorityFeePerGas << 128n) | maxFeePerGas, { size: 32 });
}

/**
 * Packs dual signature payload required by PolicyAccount.validateUserOp:
 * abi.encode(ownerSig, oracleSig, receiptHash, validUntil, validAfter)
 */
export function packDualSignature({
  ownerSig,
  oracleSig,
  receiptHash,
  validUntil,
  validAfter,
}: {
  ownerSig: Hex;
  oracleSig: Hex;
  receiptHash: Hex;
  validUntil: number;
  validAfter: number;
}): Hex {
  return encodeAbiParameters(
    [
      { type: 'bytes' },
      { type: 'bytes' },
      { type: 'bytes32' },
      { type: 'uint48' },
      { type: 'uint48' },
    ],
    [ownerSig, oracleSig, receiptHash, validUntil, validAfter],
  );
}

/**
 * Resolves calldata, nonce, gas limits, signs with owner and oracle, and returns
 * the fully prepared PackedUserOperation along with userOpHash.
 */
export async function buildSignedUserOp(
  params: ExecutePolicyTxParams,
): Promise<SignedUserOpResult> {
  let callData = params.callData;
  if (!callData) {
    if (!params.target) {
      throw new Error("Either 'target' ({ to, value, data }) or 'callData' must be provided");
    }
    const policyAccountAbi = params.policyAccountAbi ?? POLICY_ACCOUNT_ABI;
    callData = encodeFunctionData({
      abi: policyAccountAbi,
      functionName: 'execute',
      args: [params.target.to, params.target.value ?? 0n, params.target.data ?? '0x'],
    });
  }

  const entryPointAddress = params.entryPointAddress ?? CANONICAL_ENTRY_POINT_07_ADDRESS;
  const entryPointAbi = params.entryPointAbi ?? ENTRY_POINT_ABI;

  // Fetch current account nonce from EntryPoint
  const nonceKey = params.nonceKey ?? 0n;
  const nonce = (await params.publicClient.readContract({
    address: entryPointAddress,
    abi: entryPointAbi,
    functionName: 'getNonce',
    args: [params.accountAddress, nonceKey],
  })) as bigint;

  // Gas limits resolution
  const verificationGasLimit = params.gasOverrides?.verificationGasLimit ?? 200_000n;
  const callGasLimit = params.gasOverrides?.callGasLimit ?? 300_000n;
  const accountGasLimits = packGasLimits(verificationGasLimit, callGasLimit);

  let maxPriorityFeePerGas = params.gasOverrides?.maxPriorityFeePerGas;
  let maxFeePerGas = params.gasOverrides?.maxFeePerGas;

  if (maxPriorityFeePerGas === undefined || maxFeePerGas === undefined) {
    try {
      const fees = await params.publicClient.estimateFeesPerGas();
      if (
        maxPriorityFeePerGas === undefined &&
        fees.maxPriorityFeePerGas !== undefined &&
        fees.maxPriorityFeePerGas > 0n
      ) {
        maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      }
      if (maxFeePerGas === undefined && fees.maxFeePerGas !== undefined && fees.maxFeePerGas > 0n) {
        maxFeePerGas = fees.maxFeePerGas;
      }
    } catch {
      // Fallback for local chains / Anvil where estimateFeesPerGas is unsupported
    }
  }

  maxPriorityFeePerGas = maxPriorityFeePerGas ?? parseGwei('1');
  maxFeePerGas = maxFeePerGas ?? maxPriorityFeePerGas + parseGwei('1');
  const gasFees = packGasFees(maxPriorityFeePerGas, maxFeePerGas);
  const preVerificationGas = params.gasOverrides?.preVerificationGas ?? 50_000n;

  // Unsigned PackedUserOperation
  const packedUserOp: PackedUserOperation = {
    sender: params.accountAddress,
    nonce,
    initCode: '0x',
    callData,
    accountGasLimits,
    preVerificationGas,
    gasFees,
    paymasterAndData: '0x',
    signature: '0x',
  };

  // Get UserOpHash from EntryPoint
  const userOpHash = (await params.publicClient.readContract({
    address: entryPointAddress,
    abi: entryPointAbi,
    functionName: 'getUserOpHash',
    args: [packedUserOp],
  })) as Hash;

  // 1. Owner signs personal EIP-191 message over userOpHash
  if (!params.ownerAccount.signMessage) {
    throw new Error('ownerAccount must support signMessage');
  }
  const ownerSig = await params.ownerAccount.signMessage({
    message: { raw: userOpHash },
  });

  // 2. Oracle signature resolution
  let oracleSig: Hex;
  let validUntil: number;
  const validAfter = params.oracle.validAfter ?? 0;

  if ('oracleSignature' in params.oracle) {
    oracleSig = params.oracle.oracleSignature;
    validUntil = params.oracle.validUntil;
  } else {
    // Generate signature locally using oracleAccount
    if (params.oracle.validUntil !== undefined) {
      validUntil = params.oracle.validUntil;
    } else {
      try {
        const block = await params.publicClient.getBlock();
        validUntil = Number(block.timestamp) + 3600;
      } catch {
        validUntil = Math.floor(Date.now() / 1000) + 3600;
      }
    }

    const chainId = params.publicClient.chain?.id ?? (await params.publicClient.getChainId());

    if (!params.oracle.oracleAccount.signTypedData) {
      throw new Error('oracleAccount must support signTypedData');
    }

    oracleSig = await params.oracle.oracleAccount.signTypedData({
      domain: {
        name: 'PolicyAccount',
        version: '1',
        chainId,
        verifyingContract: params.accountAddress,
      },
      types: ORACLE_APPROVAL_TYPES,
      primaryType: 'OracleApproval',
      message: {
        userOpHash,
        receiptHash: params.receiptHash,
        validUntil,
        validAfter,
      },
    });
  }

  // 3. Pack dual signature into userOp.signature
  packedUserOp.signature = packDualSignature({
    ownerSig,
    oracleSig,
    receiptHash: params.receiptHash,
    validUntil,
    validAfter,
  });

  return { packedUserOp, userOpHash };
}

/**
 * Builds and signs an ERC-4337 UserOperation for PolicyAccount and submits it to EntryPoint.handleOps.
 *
 * Designed to be zero-Node-dependency and isomorphic (React Native, Metro bundler, web, and Node.js).
 *
 * @param params Full configuration including clients, accounts, receiptHash, and target call.
 * @returns Result containing transactionHash, transaction receipt, userOpHash, and execution success status.
 */
export async function executePolicyTransaction(
  params: ExecutePolicyTxParams,
): Promise<ExecutePolicyTxResult> {
  const clientAccount = params.walletClient.account;
  if (!clientAccount) {
    throw new Error('walletClient must have an account configured to submit transactions');
  }

  const { packedUserOp, userOpHash } = await buildSignedUserOp(params);

  const beneficiary = params.beneficiary ?? clientAccount.address ?? params.ownerAccount.address;

  const entryPointAddress = params.entryPointAddress ?? CANONICAL_ENTRY_POINT_07_ADDRESS;
  const entryPointAbi = params.entryPointAbi ?? ENTRY_POINT_ABI;

  const transactionHash = await params.walletClient.writeContract({
    address: entryPointAddress,
    abi: entryPointAbi,
    functionName: 'handleOps',
    args: [[packedUserOp], beneficiary],
    account: clientAccount,
    chain: params.walletClient.chain,
  });

  const receipt = await params.publicClient.waitForTransactionReceipt({
    hash: transactionHash,
  });

  return {
    transactionHash,
    receipt,
    userOpHash,
    success: receipt.status === 'success',
  };
}
