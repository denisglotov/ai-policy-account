// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {SIG_VALIDATION_FAILED, _packValidationData} from "account-abstraction/core/Helpers.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IPolicyAccount} from "./interfaces/IPolicyAccount.sol";

/**
 * @title PolicyAccount
 * @author Denis Glotov
 * @notice ERC-4337 Smart Account wallet requiring cryptographic AI-Oracle ECDSA approval.
 * @dev Enforces dual-signature verification (Owner + AI-Oracle) inside validateUserOp,
 * single-use receipt nullification, and strict EntryPoint-only execution.
 */
contract PolicyAccount is EIP712, IPolicyAccount {
    // =============================================================
    //                          CONSTANTS
    // =============================================================

    /// @notice EIP-712 typehash for AI-Oracle purchase approval.
    bytes32 public constant ORACLE_APPROVAL_TYPEHASH =
        keccak256("OracleApproval(bytes32 userOpHash,bytes32 receiptHash,uint48 validUntil,uint48 validAfter)");

    // =============================================================
    //                          IMMUTABLES
    // =============================================================

    /// @dev Canonical ERC-4337 EntryPoint.
    IEntryPoint private immutable _entryPoint;

    /// @dev Account owner address.
    address private immutable _owner;

    /// @dev AI-Oracle signer address.
    address private immutable _oracle;

    // =============================================================
    //                           STORAGE
    // =============================================================

    /// @notice Records whether a store receipt hash has already been consumed.
    mapping(bytes32 receiptHash => bool isUsed) public usedReceipts;

    // =============================================================
    //                          MODIFIERS
    // =============================================================

    /// @notice Restricts invocation strictly to the EntryPoint contract.
    modifier onlyEntryPoint() {
        if (msg.sender != address(_entryPoint)) {
            revert PolicyAccount__OnlyEntryPoint();
        }
        _;
    }

    // =============================================================
    //                        CONSTRUCTOR
    // =============================================================

    /**
     * @notice Initializes the PolicyAccount.
     * @param anEntryPoint The ERC-4337 EntryPoint contract.
     * @param anOwner The account owner address.
     * @param anOracle The AI-Oracle signer address.
     */
    constructor(IEntryPoint anEntryPoint, address anOwner, address anOracle) payable EIP712("PolicyAccount", "1") {
        if (address(anEntryPoint) == address(0) || anOwner == address(0) || anOracle == address(0)) {
            revert PolicyAccount__ZeroAddressNotAllowed();
        }
        _entryPoint = anEntryPoint;
        _owner = anOwner;
        _oracle = anOracle;

        emit AccountInitialized(anEntryPoint, anOwner, anOracle);
    }

    // =============================================================
    //                        RECEIVE ETH
    // =============================================================

    /// @notice Enables the account to receive native ETH deposits.
    receive() external payable {}

    // =============================================================
    //                    ERC-4337 VALIDATION
    // =============================================================

    /**
     * @notice Validates the UserOperation signatures (Owner and AI-Oracle) and pays gas prefund.
     * @param userOp The operation to be executed.
     * @param userOpHash Hash of the user's request data.
     * @param missingAccountFunds Missing funds on the account's deposit in the entrypoint.
     * @return validationData Packed validation data (authorizer, validUntil, validAfter).
     */
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        override
        returns (uint256 validationData)
    {
        if (msg.sender != address(_entryPoint)) {
            revert PolicyAccount__OnlyEntryPoint();
        }

        (bytes memory ownerSig, bytes memory oracleSig, bytes32 receiptHash, uint48 validUntil, uint48 validAfter) =
            abi.decode(userOp.signature, (bytes, bytes, bytes32, uint48, uint48));

        if (receiptHash == bytes32(0)) {
            revert PolicyAccount__InvalidReceiptHash();
        }

        if (usedReceipts[receiptHash]) {
            revert PolicyAccount__ReceiptAlreadyUsed(receiptHash);
        }

        // 1. Verify owner signature against ERC-4337 userOpHash
        bytes32 ownerDigest = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        (address recoveredOwner, ECDSA.RecoverError errOwner,) = ECDSA.tryRecover(ownerDigest, ownerSig);
        if (errOwner != ECDSA.RecoverError.NoError || recoveredOwner != _owner) {
            return SIG_VALIDATION_FAILED;
        }

        // 2. Verify AI-Oracle signature against EIP-712 approval digest
        bytes32 oracleDigest = getOracleApprovalHash(userOpHash, receiptHash, validUntil, validAfter);
        (address recoveredOracle, ECDSA.RecoverError errOracle,) = ECDSA.tryRecover(oracleDigest, oracleSig);
        if (errOracle != ECDSA.RecoverError.NoError || recoveredOracle != _oracle) {
            return SIG_VALIDATION_FAILED;
        }

        // 3. Mark receipt nullifier as consumed
        usedReceipts[receiptHash] = true;
        emit PurchaseApproved(receiptHash, userOpHash);

        // 4. Pay prefund to EntryPoint if required
        if (missingAccountFunds != 0) {
            (bool success,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (success);
        }

        return _packValidationData(false, validUntil, validAfter);
    }

    // =============================================================
    //                     EXECUTION FUNCTIONS
    // =============================================================

    /**
     * @inheritdoc IPolicyAccount
     */
    function execute(address dest, uint256 value, bytes calldata func) external override onlyEntryPoint {
        if (dest == address(0)) {
            revert PolicyAccount__ZeroAddressNotAllowed();
        }

        (bool success, bytes memory result) = dest.call{value: value}(func);
        if (!success) {
            revert PolicyAccount__CallFailed(result);
        }

        emit ExecutionSuccess(dest, value, func);
    }

    /**
     * @inheritdoc IPolicyAccount
     */
    function executeBatch(address[] calldata dest, uint256[] calldata value, bytes[] calldata func)
        external
        override
        onlyEntryPoint
    {
        uint256 length = dest.length;
        if (length != value.length || length != func.length) {
            revert PolicyAccount__ArrayLengthMismatch();
        }

        for (uint256 i = 0; i < length; ++i) {
            if (dest[i] == address(0)) {
                revert PolicyAccount__ZeroAddressNotAllowed();
            }

            (bool success, bytes memory result) = dest[i].call{value: value[i]}(func[i]);
            if (!success) {
                revert PolicyAccount__CallFailed(result);
            }
        }

        emit BatchExecutionSuccess(length);
    }

    // =============================================================
    //                       VIEW FUNCTIONS
    // =============================================================

    /**
     * @inheritdoc IERC1271
     * @notice Validates an ERC-1271 signature for off-chain message verification.
     * @dev Supports both EIP-191 personal_sign hashes and raw EIP-712 digests signed by the account owner.
     * @param hash The 32-byte hash of the data being verified.
     * @param signature The signature bytes associated with `hash`.
     * @return magicValue 0x1626ba7e if valid, 0xffffffff otherwise.
     */
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        override
        returns (bytes4 magicValue)
    {
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(hash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(ethSignedHash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == _owner) {
            return IERC1271.isValidSignature.selector;
        }

        (recovered, err,) = ECDSA.tryRecoverCalldata(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == _owner) {
            return IERC1271.isValidSignature.selector;
        }

        return 0xffffffff;
    }

    /**
     * @inheritdoc IPolicyAccount
     */
    function entryPoint() external view override returns (IEntryPoint) {
        return _entryPoint;
    }

    /**
     * @inheritdoc IPolicyAccount
     */
    function owner() external view override returns (address) {
        return _owner;
    }

    /**
     * @inheritdoc IPolicyAccount
     */
    function oracle() external view override returns (address) {
        return _oracle;
    }

    /**
     * @inheritdoc IPolicyAccount
     */
    function getOracleApprovalHash(bytes32 userOpHash, bytes32 receiptHash, uint48 validUntil, uint48 validAfter)
        public
        view
        override
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(ORACLE_APPROVAL_TYPEHASH, userOpHash, receiptHash, validUntil, validAfter));
        return _hashTypedDataV4(structHash);
    }
}
