// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PolicyAccount} from "../src/PolicyAccount.sol";
import {IPolicyAccount} from "../src/interfaces/IPolicyAccount.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

contract MockMerchant {
    event PurchaseReceived(address indexed payer, uint256 amount, bytes32 orderId);

    receive() external payable {}

    function buy(bytes32 orderId) external payable {
        emit PurchaseReceived(msg.sender, msg.value, orderId);
    }

    function fail() external pure {
        revert("MOCK_FAIL");
    }
}

contract PolicyAccountTest is Test {
    EntryPoint internal entryPoint;
    PolicyAccount internal account;
    MockMerchant internal merchant;

    uint256 internal ownerPrivateKey = 0xA11CE;
    uint256 internal oraclePrivateKey = 0xB0B;
    uint256 internal attackerPrivateKey = 0xBAD;

    address internal ownerAddress;
    address internal oracleAddress;
    address internal attackerAddress;
    address payable internal beneficiary = payable(address(0xFEED));

    bytes32 internal constant RECEIPT_HASH = keccak256("RECEIPT_STORE_123_TOTAL_50_USD");

    function setUp() public {
        ownerAddress = vm.addr(ownerPrivateKey);
        oracleAddress = vm.addr(oraclePrivateKey);
        attackerAddress = vm.addr(attackerPrivateKey);

        entryPoint = new EntryPoint();
        account = new PolicyAccount(entryPoint, ownerAddress, oracleAddress);
        merchant = new MockMerchant();

        vm.deal(address(account), 10 ether);
        vm.deal(beneficiary, 1 ether);
        entryPoint.depositTo{value: 2 ether}(address(account));
    }

    // =============================================================
    //                     INITIALIZATION TESTS
    // =============================================================

    function test_Initialization_Success() public view {
        assertEq(address(account.entryPoint()), address(entryPoint));
        assertEq(account.owner(), ownerAddress);
        assertEq(account.oracle(), oracleAddress);
    }

    function test_Initialization_RevertIf_ZeroAddress() public {
        vm.expectRevert(IPolicyAccount.PolicyAccount__ZeroAddressNotAllowed.selector);
        new PolicyAccount(IEntryPoint(address(0)), ownerAddress, oracleAddress);

        vm.expectRevert(IPolicyAccount.PolicyAccount__ZeroAddressNotAllowed.selector);
        new PolicyAccount(entryPoint, address(0), oracleAddress);

        vm.expectRevert(IPolicyAccount.PolicyAccount__ZeroAddressNotAllowed.selector);
        new PolicyAccount(entryPoint, ownerAddress, address(0));
    }

    function test_ReceiveEth() public {
        uint256 balanceBefore = address(account).balance;
        (bool sent,) = address(account).call{value: 1 ether}("");
        assertTrue(sent);
        assertEq(address(account).balance, balanceBefore + 1 ether);
    }

    // =============================================================
    //                    ACCESS CONTROL TESTS
    // =============================================================

    function test_Execute_RevertIfNotEntryPoint() public {
        vm.prank(ownerAddress);
        vm.expectRevert(IPolicyAccount.PolicyAccount__OnlyEntryPoint.selector);
        account.execute(address(merchant), 1 ether, "");

        vm.prank(attackerAddress);
        vm.expectRevert(IPolicyAccount.PolicyAccount__OnlyEntryPoint.selector);
        account.execute(address(merchant), 1 ether, "");
    }

    function test_ExecuteBatch_RevertIfNotEntryPoint() public {
        address[] memory dests = new address[](1);
        dests[0] = address(merchant);
        uint256[] memory values = new uint256[](1);
        values[0] = 1 ether;
        bytes[] memory funcs = new bytes[](1);
        funcs[0] = "";

        vm.prank(ownerAddress);
        vm.expectRevert(IPolicyAccount.PolicyAccount__OnlyEntryPoint.selector);
        account.executeBatch(dests, values, funcs);
    }

    function test_ValidateUserOp_RevertIfNotEntryPoint() public {
        PackedUserOperation memory userOp = _createBaseUserOp(address(merchant), 1 ether, "");

        vm.prank(ownerAddress);
        vm.expectRevert(IPolicyAccount.PolicyAccount__OnlyEntryPoint.selector);
        account.validateUserOp(userOp, bytes32(0), 0);
    }

    // =============================================================
    //                 ERC-4337 EXECUTION TESTS
    // =============================================================

    function test_UserOp_Success_EndToEnd() public {
        bytes32 orderId = keccak256("ORDER_999");
        bytes memory callData = abi.encodeWithSelector(
            PolicyAccount.execute.selector,
            address(merchant),
            1 ether,
            abi.encodeWithSelector(MockMerchant.buy.selector, orderId)
        );

        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = 0;

        PackedUserOperation memory userOp = _createBaseUserOp(callData);
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);

        bytes memory ownerSig = _signOwner(ownerPrivateKey, userOpHash);
        bytes memory oracleSig = _signOracle(oraclePrivateKey, userOpHash, RECEIPT_HASH, validUntil, validAfter);

        userOp.signature = abi.encode(ownerSig, oracleSig, RECEIPT_HASH, validUntil, validAfter);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.expectEmit(true, true, false, true, address(account));
        emit IPolicyAccount.PurchaseApproved(RECEIPT_HASH, userOpHash);

        vm.expectEmit(true, false, false, true, address(merchant));
        emit MockMerchant.PurchaseReceived(address(account), 1 ether, orderId);

        vm.expectEmit(true, true, false, true, address(account));
        emit IPolicyAccount.ExecutionSuccess(
            address(merchant), 1 ether, abi.encodeWithSelector(MockMerchant.buy.selector, orderId)
        );

        entryPoint.handleOps(ops, beneficiary);

        assertEq(address(merchant).balance, 1 ether);
        assertTrue(account.usedReceipts(RECEIPT_HASH));
    }

    function test_UserOp_RevertIf_InvalidOwnerSignature() public {
        bytes memory callData = abi.encodeWithSelector(PolicyAccount.execute.selector, address(merchant), 1 ether, "");

        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = 0;

        PackedUserOperation memory userOp = _createBaseUserOp(callData);
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);

        // Sign with attacker instead of owner
        bytes memory badOwnerSig = _signOwner(attackerPrivateKey, userOpHash);
        bytes memory oracleSig = _signOracle(oraclePrivateKey, userOpHash, RECEIPT_HASH, validUntil, validAfter);

        userOp.signature = abi.encode(badOwnerSig, oracleSig, RECEIPT_HASH, validUntil, validAfter);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.expectRevert(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA24 signature error"));
        entryPoint.handleOps(ops, beneficiary);
    }

    function test_UserOp_RevertIf_InvalidOracleSignature() public {
        bytes memory callData = abi.encodeWithSelector(PolicyAccount.execute.selector, address(merchant), 1 ether, "");

        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = 0;

        PackedUserOperation memory userOp = _createBaseUserOp(callData);
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);

        bytes memory ownerSig = _signOwner(ownerPrivateKey, userOpHash);
        // Sign with attacker instead of oracle
        bytes memory badOracleSig = _signOracle(attackerPrivateKey, userOpHash, RECEIPT_HASH, validUntil, validAfter);

        userOp.signature = abi.encode(ownerSig, badOracleSig, RECEIPT_HASH, validUntil, validAfter);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.expectRevert(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA24 signature error"));
        entryPoint.handleOps(ops, beneficiary);
    }

    function test_UserOp_RevertIf_ReceiptAlreadyUsed() public {
        bytes memory callData = abi.encodeWithSelector(PolicyAccount.execute.selector, address(merchant), 1 ether, "");

        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = 0;

        // First execution succeeds
        PackedUserOperation memory userOp1 = _createBaseUserOp(callData);
        bytes32 userOpHash1 = entryPoint.getUserOpHash(userOp1);
        bytes memory ownerSig1 = _signOwner(ownerPrivateKey, userOpHash1);
        bytes memory oracleSig1 = _signOracle(oraclePrivateKey, userOpHash1, RECEIPT_HASH, validUntil, validAfter);
        userOp1.signature = abi.encode(ownerSig1, oracleSig1, RECEIPT_HASH, validUntil, validAfter);

        PackedUserOperation[] memory ops1 = new PackedUserOperation[](1);
        ops1[0] = userOp1;
        entryPoint.handleOps(ops1, beneficiary);
        assertTrue(account.usedReceipts(RECEIPT_HASH));

        // Second execution with SAME receiptHash must fail
        PackedUserOperation memory userOp2 = _createBaseUserOp(callData);
        bytes32 userOpHash2 = entryPoint.getUserOpHash(userOp2);
        bytes memory ownerSig2 = _signOwner(ownerPrivateKey, userOpHash2);
        bytes memory oracleSig2 = _signOracle(oraclePrivateKey, userOpHash2, RECEIPT_HASH, validUntil, validAfter);
        userOp2.signature = abi.encode(ownerSig2, oracleSig2, RECEIPT_HASH, validUntil, validAfter);

        PackedUserOperation[] memory ops2 = new PackedUserOperation[](1);
        ops2[0] = userOp2;

        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(IPolicyAccount.PolicyAccount__ReceiptAlreadyUsed.selector, RECEIPT_HASH)
            )
        );
        entryPoint.handleOps(ops2, beneficiary);
    }

    function test_UserOp_RevertIf_ZeroReceiptHash() public {
        bytes memory callData = abi.encodeWithSelector(PolicyAccount.execute.selector, address(merchant), 1 ether, "");

        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = 0;

        PackedUserOperation memory userOp = _createBaseUserOp(callData);
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);
        bytes memory ownerSig = _signOwner(ownerPrivateKey, userOpHash);
        bytes memory oracleSig = _signOracle(oraclePrivateKey, userOpHash, bytes32(0), validUntil, validAfter);

        userOp.signature = abi.encode(ownerSig, oracleSig, bytes32(0), validUntil, validAfter);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(IPolicyAccount.PolicyAccount__InvalidReceiptHash.selector)
            )
        );
        entryPoint.handleOps(ops, beneficiary);
    }

    function test_UserOp_RevertIf_ExpiredSignature() public {
        bytes memory callData = abi.encodeWithSelector(PolicyAccount.execute.selector, address(merchant), 1 ether, "");

        uint48 validUntil = uint48(block.timestamp + 60);
        uint48 validAfter = 0;

        PackedUserOperation memory userOp = _createBaseUserOp(callData);
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);
        bytes memory ownerSig = _signOwner(ownerPrivateKey, userOpHash);
        bytes memory oracleSig = _signOracle(oraclePrivateKey, userOpHash, RECEIPT_HASH, validUntil, validAfter);

        userOp.signature = abi.encode(ownerSig, oracleSig, RECEIPT_HASH, validUntil, validAfter);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        // Warp past expiration
        vm.warp(block.timestamp + 120);

        vm.expectRevert(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA22 expired or not due"));
        entryPoint.handleOps(ops, beneficiary);
    }

    function test_UserOp_RevertIf_NotYetValidSignature() public {
        bytes memory callData = abi.encodeWithSelector(PolicyAccount.execute.selector, address(merchant), 1 ether, "");

        uint48 validUntil = uint48(block.timestamp + 2 hours);
        uint48 validAfter = uint48(block.timestamp + 1 hours);

        PackedUserOperation memory userOp = _createBaseUserOp(callData);
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);
        bytes memory ownerSig = _signOwner(ownerPrivateKey, userOpHash);
        bytes memory oracleSig = _signOracle(oraclePrivateKey, userOpHash, RECEIPT_HASH, validUntil, validAfter);

        userOp.signature = abi.encode(ownerSig, oracleSig, RECEIPT_HASH, validUntil, validAfter);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        // We are currently before validAfter
        vm.expectRevert(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA22 expired or not due"));
        entryPoint.handleOps(ops, beneficiary);
    }

    function test_UserOp_ExecuteBatch_Success() public {
        MockMerchant merchant2 = new MockMerchant();

        address[] memory dests = new address[](2);
        dests[0] = address(merchant);
        dests[1] = address(merchant2);

        uint256[] memory values = new uint256[](2);
        values[0] = 0.5 ether;
        values[1] = 0.8 ether;

        bytes[] memory funcs = new bytes[](2);
        funcs[0] = abi.encodeWithSelector(MockMerchant.buy.selector, keccak256("ORDER_1"));
        funcs[1] = abi.encodeWithSelector(MockMerchant.buy.selector, keccak256("ORDER_2"));

        bytes memory callData = abi.encodeWithSelector(PolicyAccount.executeBatch.selector, dests, values, funcs);

        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = 0;

        PackedUserOperation memory userOp = _createBaseUserOp(callData);
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);

        bytes memory ownerSig = _signOwner(ownerPrivateKey, userOpHash);
        bytes memory oracleSig = _signOracle(oraclePrivateKey, userOpHash, RECEIPT_HASH, validUntil, validAfter);

        userOp.signature = abi.encode(ownerSig, oracleSig, RECEIPT_HASH, validUntil, validAfter);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.expectEmit(true, false, false, false, address(account));
        emit IPolicyAccount.BatchExecutionSuccess(2);

        entryPoint.handleOps(ops, beneficiary);

        assertEq(address(merchant).balance, 0.5 ether);
        assertEq(address(merchant2).balance, 0.8 ether);
        assertTrue(account.usedReceipts(RECEIPT_HASH));
    }

    function test_UserOp_ExecuteBatch_ArrayLengthMismatch_Reverts() public {
        address[] memory dests = new address[](2);
        dests[0] = address(merchant);
        dests[1] = address(merchant);

        uint256[] memory values = new uint256[](1);
        values[0] = 1 ether;

        bytes[] memory funcs = new bytes[](2);
        funcs[0] = "";
        funcs[1] = "";

        bytes memory callData = abi.encodeWithSelector(PolicyAccount.executeBatch.selector, dests, values, funcs);

        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = 0;

        PackedUserOperation memory userOp = _createBaseUserOp(callData);
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);
        bytes memory ownerSig = _signOwner(ownerPrivateKey, userOpHash);
        bytes memory oracleSig = _signOracle(oraclePrivateKey, userOpHash, RECEIPT_HASH, validUntil, validAfter);
        userOp.signature = abi.encode(ownerSig, oracleSig, RECEIPT_HASH, validUntil, validAfter);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.expectEmit(true, true, false, true, address(entryPoint));
        emit IEntryPoint.UserOperationRevertReason(
            userOpHash,
            address(account),
            0,
            abi.encodeWithSelector(IPolicyAccount.PolicyAccount__ArrayLengthMismatch.selector)
        );
        entryPoint.handleOps(ops, beneficiary);
    }

    function test_UserOp_Execute_ZeroDestination_Reverts() public {
        bytes memory callData = abi.encodeWithSelector(PolicyAccount.execute.selector, address(0), 1 ether, "");

        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = 0;

        PackedUserOperation memory userOp = _createBaseUserOp(callData);
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);
        bytes memory ownerSig = _signOwner(ownerPrivateKey, userOpHash);
        bytes memory oracleSig = _signOracle(oraclePrivateKey, userOpHash, RECEIPT_HASH, validUntil, validAfter);
        userOp.signature = abi.encode(ownerSig, oracleSig, RECEIPT_HASH, validUntil, validAfter);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.expectEmit(true, true, false, true, address(entryPoint));
        emit IEntryPoint.UserOperationRevertReason(
            userOpHash,
            address(account),
            0,
            abi.encodeWithSelector(IPolicyAccount.PolicyAccount__ZeroAddressNotAllowed.selector)
        );
        entryPoint.handleOps(ops, beneficiary);
    }

    function test_Execute_Direct_ZeroDestination_Reverts() public {
        vm.prank(address(entryPoint));
        vm.expectRevert(IPolicyAccount.PolicyAccount__ZeroAddressNotAllowed.selector);
        account.execute(address(0), 1 ether, "");
    }

    function test_ExecuteBatch_Direct_LengthMismatch_Reverts() public {
        address[] memory dests = new address[](2);
        dests[0] = address(merchant);
        dests[1] = address(merchant);

        uint256[] memory values = new uint256[](1);
        values[0] = 1 ether;

        bytes[] memory funcs = new bytes[](2);
        funcs[0] = "";
        funcs[1] = "";

        vm.prank(address(entryPoint));
        vm.expectRevert(IPolicyAccount.PolicyAccount__ArrayLengthMismatch.selector);
        account.executeBatch(dests, values, funcs);
    }

    function test_Execute_CallFailed_DirectReverts() public {
        vm.prank(address(entryPoint));
        vm.expectRevert(
            abi.encodeWithSelector(
                IPolicyAccount.PolicyAccount__CallFailed.selector, abi.encodeWithSignature("Error(string)", "MOCK_FAIL")
            )
        );
        account.execute(address(merchant), 0, abi.encodeWithSelector(MockMerchant.fail.selector));
    }

    function test_ExecuteBatch_CallFailed_DirectReverts() public {
        address[] memory dests = new address[](1);
        dests[0] = address(merchant);
        uint256[] memory values = new uint256[](1);
        values[0] = 0;
        bytes[] memory funcs = new bytes[](1);
        funcs[0] = abi.encodeWithSelector(MockMerchant.fail.selector);

        vm.prank(address(entryPoint));
        vm.expectRevert(
            abi.encodeWithSelector(
                IPolicyAccount.PolicyAccount__CallFailed.selector, abi.encodeWithSignature("Error(string)", "MOCK_FAIL")
            )
        );
        account.executeBatch(dests, values, funcs);
    }

    function test_UserOp_PaysPrefundWhenMissingAccountFunds() public {
        PolicyAccount freshAccount = new PolicyAccount(entryPoint, ownerAddress, oracleAddress);
        vm.deal(address(freshAccount), 10 ether);

        bytes memory callData = abi.encodeWithSelector(PolicyAccount.execute.selector, address(merchant), 0.5 ether, "");

        uint48 validUntil = uint48(block.timestamp + 1 hours);
        PackedUserOperation memory userOp = _createBaseUserOpFor(address(freshAccount), callData);
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);
        bytes memory ownerSig = _signOwner(ownerPrivateKey, userOpHash);
        bytes memory oracleSig = _signOracleFor(freshAccount, oraclePrivateKey, userOpHash, RECEIPT_HASH, validUntil, 0);

        userOp.signature = abi.encode(ownerSig, oracleSig, RECEIPT_HASH, validUntil, uint48(0));

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        entryPoint.handleOps(ops, beneficiary);

        assertEq(address(merchant).balance, 0.5 ether);
        assertTrue(freshAccount.usedReceipts(RECEIPT_HASH));
    }

    function test_UserOp_RevertIf_MalformedSignature() public {
        bytes memory callData = abi.encodeWithSelector(PolicyAccount.execute.selector, address(merchant), 1 ether, "");

        PackedUserOperation memory userOp = _createBaseUserOp(callData);
        userOp.signature = hex"deadbeef";

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, "AA23 reverted", hex""));
        entryPoint.handleOps(ops, beneficiary);
    }

    // =============================================================
    //                 EXECUTION EVENT TESTS
    // =============================================================

    function test_Execute_Emits_ExecutionSuccess_Direct() public {
        vm.prank(address(entryPoint));
        vm.expectEmit(true, true, false, true, address(account));
        emit IPolicyAccount.ExecutionSuccess(address(merchant), 1 ether, "");
        account.execute(address(merchant), 1 ether, "");
    }

    function test_ExecuteBatch_Emits_BatchExecutionSuccess_Direct() public {
        address[] memory dests = new address[](1);
        dests[0] = address(merchant);
        uint256[] memory values = new uint256[](1);
        values[0] = 1 ether;
        bytes[] memory funcs = new bytes[](1);
        funcs[0] = "";

        vm.prank(address(entryPoint));
        vm.expectEmit(true, false, false, false, address(account));
        emit IPolicyAccount.BatchExecutionSuccess(1);
        account.executeBatch(dests, values, funcs);
    }

    // =============================================================
    //                    ERC-1271 TESTS
    // =============================================================

    function test_IsValidSignature_Success_EthSignedMessageHash() public view {
        bytes32 messageHash = keccak256("SIWE_OR_OFFCHAIN_MESSAGE");
        bytes32 ethSignedDigest = MessageHashUtils.toEthSignedMessageHash(messageHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPrivateKey, ethSignedDigest);
        bytes memory signature = abi.encodePacked(r, s, v);

        bytes4 magicValue = account.isValidSignature(messageHash, signature);
        assertEq(magicValue, IERC1271.isValidSignature.selector);
    }

    function test_IsValidSignature_Success_RawHash() public view {
        bytes32 rawDigest = keccak256("EIP712_TYPED_DATA_DIGEST");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPrivateKey, rawDigest);
        bytes memory signature = abi.encodePacked(r, s, v);

        bytes4 magicValue = account.isValidSignature(rawDigest, signature);
        assertEq(magicValue, IERC1271.isValidSignature.selector);
    }

    function test_IsValidSignature_Failed_AttackerSignature() public view {
        bytes32 messageHash = keccak256("OFFCHAIN_MESSAGE");
        bytes32 ethSignedDigest = MessageHashUtils.toEthSignedMessageHash(messageHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPrivateKey, ethSignedDigest);
        bytes memory signature = abi.encodePacked(r, s, v);

        bytes4 magicValue = account.isValidSignature(messageHash, signature);
        assertEq(magicValue, bytes4(0xffffffff));
    }

    function test_IsValidSignature_Failed_InvalidLength() public view {
        bytes32 messageHash = keccak256("OFFCHAIN_MESSAGE");
        bytes4 magicValue = account.isValidSignature(messageHash, hex"deadbeef");
        assertEq(magicValue, bytes4(0xffffffff));
    }

    // =============================================================
    //                       HELPERS
    // =============================================================

    function _createBaseUserOp(address dest, uint256 value, bytes memory func)
        internal
        view
        returns (PackedUserOperation memory)
    {
        bytes memory callData = abi.encodeWithSelector(PolicyAccount.execute.selector, dest, value, func);
        return _createBaseUserOp(callData);
    }

    function _createBaseUserOp(bytes memory callData) internal view returns (PackedUserOperation memory) {
        return _createBaseUserOpFor(address(account), callData);
    }

    function _createBaseUserOpFor(address sender, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory)
    {
        uint256 verificationGasLimit = 200000;
        uint256 callGasLimit = 300000;
        bytes32 accountGasLimits = bytes32((verificationGasLimit << 128) | callGasLimit);

        uint256 maxPriorityFeePerGas = 1 gwei;
        uint256 maxFeePerGas = 2 gwei;
        bytes32 gasFees = bytes32((maxPriorityFeePerGas << 128) | maxFeePerGas);

        return PackedUserOperation({
            sender: sender,
            nonce: entryPoint.getNonce(sender, 0),
            initCode: hex"",
            callData: callData,
            accountGasLimits: accountGasLimits,
            preVerificationGas: 50000,
            gasFees: gasFees,
            paymasterAndData: hex"",
            signature: hex""
        });
    }

    function _signOwner(uint256 pk, bytes32 userOpHash) internal pure returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signOracle(uint256 pk, bytes32 userOpHash, bytes32 receiptHash, uint48 validUntil, uint48 validAfter)
        internal
        view
        returns (bytes memory)
    {
        return _signOracleFor(account, pk, userOpHash, receiptHash, validUntil, validAfter);
    }

    function _signOracleFor(
        PolicyAccount targetAccount,
        uint256 pk,
        bytes32 userOpHash,
        bytes32 receiptHash,
        uint48 validUntil,
        uint48 validAfter
    ) internal view returns (bytes memory) {
        bytes32 digest = targetAccount.getOracleApprovalHash(userOpHash, receiptHash, validUntil, validAfter);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
