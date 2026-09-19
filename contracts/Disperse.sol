// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  Disperse
 * @notice Funds the whole burner-wallet pool in a SINGLE transaction.
 *
 * Funding 150 wallets with 150 separate transfers from one EOA means 150
 * sequential nonces. Doing that live, while people are scanning the QR code,
 * is how a demo dies. We pre-fund the entire pool from one nonce instead.
 */
contract Disperse {
    error LengthMismatch();
    error TransferFailed(address to);

    function disperse(address[] calldata recipients, uint256 amount) external payable {
        uint256 n = recipients.length;
        for (uint256 i; i < n; ++i) {
            (bool ok, ) = recipients[i].call{value: amount}("");
            if (!ok) revert TransferFailed(recipients[i]);
        }
        uint256 rest = address(this).balance;
        if (rest > 0) {
            (bool ok, ) = msg.sender.call{value: rest}("");
            if (!ok) revert TransferFailed(msg.sender);
        }
    }

    function disperseVariable(address[] calldata recipients, uint256[] calldata amounts) external payable {
        if (recipients.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < recipients.length; ++i) {
            (bool ok, ) = recipients[i].call{value: amounts[i]}("");
            if (!ok) revert TransferFailed(recipients[i]);
        }
        uint256 rest = address(this).balance;
        if (rest > 0) {
            (bool ok, ) = msg.sender.call{value: rest}("");
            if (!ok) revert TransferFailed(msg.sender);
        }
    }
}
