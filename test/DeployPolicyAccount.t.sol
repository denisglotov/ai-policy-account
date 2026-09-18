// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {DeployPolicyAccount} from "../script/DeployPolicyAccount.s.sol";
import {PolicyAccount} from "../src/PolicyAccount.sol";

contract DeployPolicyAccountTest is Test {
    DeployPolicyAccount internal deployScript;
    address internal oracle = address(0xABCD);
    address internal explicitOwner = address(0xCAFE);

    function setUp() public {
        deployScript = new DeployPolicyAccount();
    }

    function test_Deploy_Script() public {
        uint256 pk = 0xA11CE;
        address expectedDeployer = vm.addr(pk);

        // 1. Default owner from private key when OWNER_ADDRESS is address(0)
        vm.setEnv("ORACLE_ADDRESS", vm.toString(oracle));
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(pk)));
        vm.setEnv("OWNER_ADDRESS", vm.toString(address(0)));

        PolicyAccount account1 = deployScript.run();
        assertEq(account1.owner(), expectedDeployer);
        assertEq(account1.oracle(), oracle);
        assertEq(address(account1.entryPoint()), deployScript.CANONICAL_ENTRY_POINT_V07());

        // 2. Explicit owner override
        vm.setEnv("OWNER_ADDRESS", vm.toString(explicitOwner));

        PolicyAccount account2 = deployScript.run();
        assertEq(account2.owner(), explicitOwner);
        assertEq(account2.oracle(), oracle);
    }
}
