# PolicyAccount (ERC-4337 Smart Account with AI-Oracle Approval)

An ERC-4337 (v0.7) compliant Smart Account wallet ("PolicyAccount") implemented in Solidity
using Foundry. Execution requires dual cryptographic verification: the account owner's signature
and an off-chain AI-Oracle ECDSA signature approving store receipts/invoices.

---

## Architecture Overview

```
              ┌──────────────────────────┐
              │   ERC-4337 EntryPoint    │
              │         (v0.7)           │
              └─────────────┬────────────┘
                            │
             1. validateUserOp (UserOp)
                            │
                            ▼
              ┌──────────────────────────┐
              │      PolicyAccount       │
              └──────┬────────────┬──────┘
                     │            │
 2. Verify Owner Sig │            │ 3. Verify AI-Oracle Sig
                     ▼            ▼
            [Owner EOA]      [AI-Oracle EIP-712]
                                  │
                                  ▼
                       4. Nullify receiptHash
                       5. Emit PurchaseApproved
                            │
              ┌─────────────┴────────────┐
              │ 6. execute / executeBatch│
              └─────────────┬────────────┘
                            │
                            ▼
                   [Target / Merchant]
```

### Key Security & Design Features

1. **ERC-4337 v0.7 Standard**:
   Implements `IAccount` using `PackedUserOperation` and EntryPoint v0.7.0 conventions.
2. **Dual-Signature Validation**:
   `userOp.signature` encodes:
   ```solidity
   abi.encode(
       bytes ownerSig,
       bytes oracleSig,
       bytes32 receiptHash,
       uint48 validUntil,
       uint48 validAfter
   )
   ```
   - **Owner**: Signs standard ERC-4337 `userOpHash` via EIP-191 personal sign.
   - **AI-Oracle**: Signs an EIP-712 typed digest:
     `OracleApproval(bytes32 userOpHash, bytes32 receiptHash, uint48 validUntil, uint48 validAfter)`
3. **On-Chain Nullifier Tracking**:
   Each `receiptHash` can only be redeemed once via `usedReceipts[receiptHash] = true`. Replay
   attempts revert on-chain.
4. **Strict EntryPoint-Only Execution**:
   `execute()` and `executeBatch()` are restricted strictly to `msg.sender == entryPoint()`. No
   unauthorized direct calls can bypass the AI-Oracle policy.
5. **Clean Code & Custom Errors**:
   All revert conditions use explicit custom errors (`PolicyAccount__ReceiptAlreadyUsed`,
   `PolicyAccount__OnlyEntryPoint`, `PolicyAccount__InvalidReceiptHash`, etc.).

---

## Project Structure

```
├── src/
│   ├── interfaces/
│   │   └── IPolicyAccount.sol    # Account interface, custom errors, and events
│   └── PolicyAccount.sol         # Core smart contract implementation
├── test/
│   └── PolicyAccount.t.sol       # 22 unit, integration, and security tests
├── script/
│   └── DeployPolicyAccount.s.sol # Foundry deployment and broadcast script
├── foundry.toml                  # Foundry compiler (v0.8.24) and via-IR settings
├── package.json                  # Solhint and workflow scripts
└── .solhint.json                 # Solidity linter configuration
```

---

## Quickstart

### Prerequisites
- [Foundry](https://getfoundry.sh/) (`forge`, `cast`, `anvil`)
- [Node.js](https://nodejs.org/) (v18+)

### 1. Install Dependencies
```bash
npm install
```

### 2. Compile Contracts
```bash
forge build
# or
npm run build
```

### 3. Run Tests
```bash
forge test -vvv
# or
npm test
```

### 4. Code Coverage
```bash
forge coverage
```

### 5. Linting & Formatting
```bash
# Check Foundry code formatting
npm run format:check

# Auto-format Solidity files
npm run format

# Run Solhint static analysis
npm run lint
```

---

## Deployment

Deploy a `PolicyAccount` instance via Foundry script:

```bash
export RPC_URL="<your_rpc_url>"
export PRIVATE_KEY="<deployer_private_key>"
export ORACLE_ADDRESS="<ai_oracle_signer_address>"
export OWNER_ADDRESS="<account_owner_address>" # optional, defaults to deployer
export ENTRY_POINT="0x0000000071727De22E5E9d8BAf0edAc6f37da032" # optional, defaults to v0.7
export INITIAL_FUNDING="0" # optional in wei

forge script script/DeployPolicyAccount.s.sol \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast
```
