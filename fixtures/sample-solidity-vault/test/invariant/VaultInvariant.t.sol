// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";
import {Attacker} from "../utils/Attacker.sol";
import {vm} from "../utils/Vm.sol";

/// The actions the invariant campaign may take against the vault, in any order.
contract VaultHandler {
    Vault public immutable vault;

    constructor(Vault vault_) {
        vault = vault_;
    }

    receive() external payable {}

    /// An honest deposit from this handler.
    function deposit(uint96 amount) external {
        if (amount == 0) return;
        vm.deal(address(this), amount);
        vault.deposit{value: amount}();
    }

    /// An honest full withdrawal by this handler.
    function withdrawAll() external {
        if (vault.balanceOf(address(this)) == 0) return;
        vault.withdrawAll();
    }

    /// A deposit and withdrawal by a contract that re-enters.
    function attack(uint64 amount) external {
        if (amount == 0) return;
        Attacker attacker = new Attacker(vault);
        vm.deal(address(this), amount);
        attacker.attack{value: amount}();
    }
}

contract VaultInvariantTest {
    Vault internal vault;
    VaultHandler internal handler;

    function setUp() public {
        vault = new Vault();
        handler = new VaultHandler(vault);
    }

    /// Restricts the campaign to the handler's actions.
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    /// The vault must always hold at least what it owes the honest depositor.
    function invariant_vaultCoversHonestDeposits() public view {
        require(
            address(vault).balance >= vault.balanceOf(address(handler)),
            "vault holds less ETH than it owes the honest depositor"
        );
    }

    /// A depositor's recorded balance never exceeds the recorded total.
    function invariant_balanceNeverExceedsTotal() public view {
        require(vault.balanceOf(address(handler)) <= vault.totalDeposits(), "balance exceeds total deposits");
    }
}
