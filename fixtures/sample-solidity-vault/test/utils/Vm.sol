// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The Foundry cheatcodes these tests use, declared here so the fixture needs no libraries.
interface Vm {
    function deal(address account, uint256 newBalance) external;
    function assume(bool condition) external pure;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
