// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";
import {vm} from "../utils/Vm.sol";

contract VaultFuzzTest {
    Vault internal vault;

    function setUp() public {
        vault = new Vault();
    }

    receive() external payable {}

    function testFuzz_depositThenWithdrawAllRoundTrips(uint96 amount) public {
        vm.assume(amount > 0);
        vm.deal(address(this), amount);

        vault.deposit{value: amount}();
        vault.withdrawAll();

        require(address(this).balance == amount, "round trip lost or created ETH");
        require(address(vault).balance == 0, "vault kept ETH after a full withdrawal");
    }

    function testFuzz_feeNeverExceedsAmount(uint256 amount) public view {
        vm.assume(amount < type(uint128).max);
        require(vault.quoteWithdrawFee(amount) <= amount, "fee is larger than the amount withdrawn");
    }
}
