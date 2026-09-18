// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/* solhint-disable no-console */

import {Script, console2} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PolicyAccount} from "../src/PolicyAccount.sol";

/**
 * @title DeployPolicyAccount
 * @author Denis Glotov
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
        address oracleAddr = vm.envAddress("ORACLE_ADDRESS");
        address ownerConfig = vm.envOr("OWNER_ADDRESS", address(0));
        uint256 initialFunding = vm.envOr("INITIAL_FUNDING", uint256(0));
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0));

        // Determine deployer address: derive from private key if provided, else from caller
        address deployer = deployerPrivateKey != 0 ? vm.addr(deployerPrivateKey) : msg.sender;

        // Owner defaults to deployer if OWNER_ADDRESS is unset
        address ownerAddr = ownerConfig != address(0) ? ownerConfig : deployer;

        console2.log("--- Deploying PolicyAccount ---");
        console2.log("EntryPoint:", entryPointAddr);
        console2.log("Owner:     ", ownerAddr);
        console2.log("Oracle:    ", oracleAddr);
        console2.log("Funding:   ", initialFunding);

        if (deployerPrivateKey != 0) {
            vm.startBroadcast(deployerPrivateKey);
        } else {
            vm.startBroadcast();
        }

        account = new PolicyAccount{value: initialFunding}(IEntryPoint(entryPointAddr), ownerAddr, oracleAddr);

        vm.stopBroadcast();

        console2.log("PolicyAccount deployed at:", address(account));
    }
}
