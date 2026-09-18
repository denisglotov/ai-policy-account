// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/* solhint-disable no-console */

import {Script, console2} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PolicyAccount} from "../src/PolicyAccount.sol";

/**
 * @title DeployPolicyAccount
 * @author Cifra Ruble Team
 * @notice Foundry deployment script for PolicyAccount smart contract wallet.
 */
contract DeployPolicyAccount is Script {
    /// @notice Canonical ERC-4337 v0.7 EntryPoint on EVM networks.
    address public constant CANONICAL_ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    /**
     * @notice Deploys a new PolicyAccount instance using environment configuration.
     * @return account The deployed PolicyAccount instance.
     */
    function run() external returns (PolicyAccount account) {
        address entryPointAddr = vm.envOr("ENTRY_POINT", CANONICAL_ENTRY_POINT_V07);
        address ownerAddr = vm.envOr("OWNER_ADDRESS", msg.sender);
        address oracleAddr = vm.envAddress("ORACLE_ADDRESS");
        uint256 initialFunding = vm.envOr("INITIAL_FUNDING", uint256(0));

        console2.log("--- Deploying PolicyAccount ---");
        console2.log("EntryPoint:", entryPointAddr);
        console2.log("Owner:     ", ownerAddr);
        console2.log("Oracle:    ", oracleAddr);
        console2.log("Funding:   ", initialFunding);

        vm.startBroadcast();

        account = new PolicyAccount{value: initialFunding}(IEntryPoint(entryPointAddr), ownerAddr, oracleAddr);

        vm.stopBroadcast();

        console2.log("PolicyAccount deployed at:", address(account));
    }
}
