// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Vault
/// @notice A deliberately flawed ETH vault used as a testing fixture. Never deploy it.
contract Vault {
    mapping(address => uint256) public balanceOf;
    uint256 public totalDeposits;

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    function deposit() external payable {
        require(msg.value > 0, "Vault: zero deposit");
        balanceOf[msg.sender] += msg.value;
        totalDeposits += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw the caller's whole balance.
    /// @dev Deliberate defect: the ETH is sent before the balance is cleared, so a
    /// receiving contract can call back in and be paid again from other depositors' funds.
    function withdrawAll() external {
        uint256 amount = balanceOf[msg.sender];
        require(amount > 0, "Vault: nothing to withdraw");

        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Vault: transfer failed");

        balanceOf[msg.sender] = 0;
        totalDeposits -= amount;
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice The fee charged on a withdrawal: one percent, never more than the amount itself.
    /// @dev Deliberate defect: the `+ 1` makes the fee exceed very small amounts.
    function quoteWithdrawFee(uint256 amount) public pure returns (uint256) {
        return amount / 100 + 1;
    }
}
