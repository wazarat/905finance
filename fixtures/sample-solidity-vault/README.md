# sample-solidity-vault

A deliberately flawed ETH vault used as a test fixture. It is run by the
testing worker; it is not part of the application and must never be deployed.

It contains two known defects:

| Defect | Where | Caught by |
|--------|-------|-----------|
| Reentrancy: `withdrawAll` pays out before clearing the balance, so a contract can re-enter and drain other depositors' funds. | `src/Vault.sol` | the unit test `test_withdrawAllCannotBeReentered`, both invariants in `test/invariant`, and Slither's `reentrancy-eth` detector |
| The withdrawal fee can exceed the amount being withdrawn (`amount / 100 + 1`). | `src/Vault.sol` | the fuzz test `testFuzz_feeNeverExceedsAmount` |

The tests use no external libraries: `test/utils/Vm.sol` declares the few
Foundry cheatcodes they need.
