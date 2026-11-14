// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";
import {Attacker} from "../utils/Attacker.sol";
import {vm} from "../utils/Vm.sol";

contract VaultUnitTest {
    Vault internal vault;

    function setUp() public {
        vault = new Vault();
        vm.deal(address(this), 100 ether);
    }

    receive() external payable {}

    function test_depositCreditsTheDepositor() public {
        vault.deposit{value: 2 ether}();
        require(vault.balanceOf(address(this)) == 2 ether, "balance not credited");
        require(vault.totalDeposits() == 2 ether, "total not updated");
        require(address(vault).balance == 2 ether, "vault does not hold the ETH");
    }

    function test_zeroDepositIsRejected() public {
        try vault.deposit{value: 0}() {
            revert("zero deposit was accepted");
        } catch {}
    }

    function test_withdrawAllReturnsTheDeposit() public {
        vault.deposit{value: 3 ether}();
        uint256 before = address(this).balance;
        vault.withdrawAll();
        require(address(this).balance == before + 3 ether, "deposit not returned");
        require(vault.balanceOf(address(this)) == 0, "balance not cleared");
    }

    function test_withdrawAllWithNoDepositIsRejected() public {
        try vault.withdrawAll() {
            revert("withdrawal with no deposit was accepted");
        } catch {}
    }

    function test_withdrawAllCannotBeReentered() public {
        // An honest depositor's funds are in the vault.
        vault.deposit{value: 5 ether}();

        // An attacker deposits 1 ether and withdraws through a contract that re-enters.
        Attacker attacker = new Attacker(vault);
        attacker.attack{value: 1 ether}();

        require(
            address(vault).balance >= vault.balanceOf(address(this)),
            "vault drained by reentrancy: it no longer holds the honest depositor's 5 ether"
        );
    }
}
