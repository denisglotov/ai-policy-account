// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAccount} from "account-abstraction/interfaces/IAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

/**
 * @title IPolicyAccount
 * @author Cifra Ruble Team
 * @notice Interface for PolicyAccount smart contract wallet requiring AI-Oracle approval.
 */
interface IPolicyAccount is IAccount {
    // =============================================================
    //                           EVENTS
    // =============================================================

    /**
     * @notice Emitted when a purchase is approved and its receipt hash is consumed.
     * @param receiptHash The unique hash of the purchase receipt.
     * @param userOpHash The hash of the validated UserOperation.
     */
    event PurchaseApproved(bytes32 indexed receiptHash, bytes32 indexed userOpHash);

    /**
     * @notice Emitted when the account is deployed and initialized.
     * @param entryPoint The ERC-4337 EntryPoint contract.
     * @param owner The account owner address.
     * @param oracle The AI-Oracle signer address.
     */
    event AccountInitialized(IEntryPoint indexed entryPoint, address indexed owner, address indexed oracle);

    // =============================================================
    //                           ERRORS
    // =============================================================

    /// @notice Thrown when a call is made by an account other than the authorized EntryPoint.
    error PolicyAccount__OnlyEntryPoint();

    /// @notice Thrown when attempting to use a receipt hash that has already been consumed.
    error PolicyAccount__ReceiptAlreadyUsed(bytes32 receiptHash);

    /// @notice Thrown when the provided receipt hash is zero.
    error PolicyAccount__InvalidReceiptHash();

    /// @notice Thrown when an internal call to a target destination fails.
    error PolicyAccount__CallFailed(bytes revertReason);

    /// @notice Thrown when batch execution arrays have mismatched lengths.
    error PolicyAccount__ArrayLengthMismatch();

    /// @notice Thrown when any constructor parameter is address(0).
    error PolicyAccount__ZeroAddressNotAllowed();

    // =============================================================
    //                      EXTERNAL FUNCTIONS
    // =============================================================

    /**
     * @notice Executes a single call from the account to a target address.
     * @dev Only callable by the EntryPoint.
     * @param dest The recipient contract or EOA.
     * @param value Amount of native currency to send.
     * @param func Calldata to send to the recipient.
     */
    function execute(address dest, uint256 value, bytes calldata func) external;

    /**
     * @notice Executes a batch of calls from the account.
     * @dev Only callable by the EntryPoint.
     * @param dest Array of recipient contracts or EOAs.
     * @param value Array of native currency amounts.
     * @param func Array of calldata payloads.
     */
    function executeBatch(address[] calldata dest, uint256[] calldata value, bytes[] calldata func) external;

    /**
     * @notice Computes the EIP-712 typed digest that the AI-Oracle must sign.
     * @param userOpHash The UserOperation hash.
     * @param receiptHash The unique store receipt hash.
     * @param validUntil Timestamp until which approval is valid.
     * @param validAfter Timestamp after which approval is valid.
     * @return The 32-byte digest ready for ECDSA signing.
     */
    function getOracleApprovalHash(bytes32 userOpHash, bytes32 receiptHash, uint48 validUntil, uint48 validAfter)
        external
        view
        returns (bytes32);

    /**
     * @notice Returns the EntryPoint contract address.
     */
    function entryPoint() external view returns (IEntryPoint);

    /**
     * @notice Returns the account owner address.
     */
    function owner() external view returns (address);

    /**
     * @notice Returns the AI-Oracle signer address.
     */
    function oracle() external view returns (address);

    /**
     * @notice Returns whether a receipt hash has already been consumed.
     * @param receiptHash The receipt hash to query.
     */
    function usedReceipts(bytes32 receiptHash) external view returns (bool);
}
