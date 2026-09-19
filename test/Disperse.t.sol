// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Disperse} from "../contracts/Disperse.sol";

/// Refuses incoming value, to stand in for a recipient that cannot be paid.
contract Rejector {
    receive() external payable {
        revert("no");
    }
}

contract DisperseTest is Test {
    Disperse internal disperse;
    address funder = makeAddr("funder");

    function setUp() public {
        disperse = new Disperse();
        vm.deal(funder, 100 ether);
    }

    function _recipients(uint256 n) internal pure returns (address[] memory out) {
        out = new address[](n);
        for (uint256 i; i < n; ++i) out[i] = address(uint160(0x1000 + i));
    }

    function test_FundsEveryRecipientEqually() public {
        address[] memory to = _recipients(120);
        uint256 amount = 0.05 ether;

        vm.prank(funder);
        disperse.disperse{value: amount * to.length}(to, amount);

        for (uint256 i; i < to.length; ++i) {
            assertEq(to[i].balance, amount, "every wallet in the pool is armed");
        }
        assertEq(address(disperse).balance, 0, "contract keeps nothing");
    }

    /**
     * The whole point of this contract is that the pool is funded from one
     * nonce instead of 120. forge cannot observe a nonce under vm.prank, but it
     * can observe the constraint that actually makes the claim true: the batch
     * has to fit in a single transaction.
     */
    function test_WholePoolFitsInOneTransaction() public {
        address[] memory to = _recipients(120);

        vm.prank(funder);
        uint256 before = gasleft();
        disperse.disperse{value: 0.05 ether * 120}(to, 0.05 ether);
        uint256 used = before - gasleft();

        assertLt(used, 15_000_000, "120 recipients must fit comfortably inside one block");
        for (uint256 i; i < to.length; ++i) {
            assertEq(to[i].balance, 0.05 ether, "and every one of them is funded");
        }
    }

    function test_RefundsExcessToSender() public {
        address[] memory to = _recipients(10);
        uint256 amount = 1 ether;
        uint256 before = funder.balance;

        vm.prank(funder);
        disperse.disperse{value: 15 ether}(to, amount);

        assertEq(funder.balance, before - 10 ether, "only the dispersed amount left the sender");
        assertEq(address(disperse).balance, 0);
    }

    function test_RevertWhen_ShortOfFunds() public {
        address[] memory to = _recipients(10);
        vm.prank(funder);
        vm.expectRevert();
        disperse.disperse{value: 5 ether}(to, 1 ether);
    }

    function test_RevertWhen_RecipientRejects() public {
        address[] memory to = new address[](2);
        to[0] = address(uint160(0x1000));
        to[1] = address(new Rejector());

        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(Disperse.TransferFailed.selector, to[1]));
        disperse.disperse{value: 2 ether}(to, 1 ether);

        assertEq(to[0].balance, 0, "the whole batch reverts, nothing is half-funded");
    }

    function test_VariableAmounts() public {
        address[] memory to = _recipients(3);
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 1 ether;
        amounts[1] = 2 ether;
        amounts[2] = 3 ether;

        vm.prank(funder);
        disperse.disperseVariable{value: 6 ether}(to, amounts);

        assertEq(to[0].balance, 1 ether);
        assertEq(to[1].balance, 2 ether);
        assertEq(to[2].balance, 3 ether);
    }

    function test_RevertWhen_LengthMismatch() public {
        address[] memory to = _recipients(3);
        uint256[] memory amounts = new uint256[](2);

        vm.prank(funder);
        vm.expectRevert(Disperse.LengthMismatch.selector);
        disperse.disperseVariable{value: 6 ether}(to, amounts);
    }

    function testFuzz_ConservesValue(uint8 count, uint64 amount) public {
        count = uint8(bound(count, 1, 150));
        amount = uint64(bound(amount, 1, 1 ether));

        address[] memory to = _recipients(count);
        uint256 total = uint256(amount) * count;
        vm.deal(funder, total + 10 ether);
        uint256 before = funder.balance;

        vm.prank(funder);
        disperse.disperse{value: before}(to, amount);

        uint256 received;
        for (uint256 i; i < to.length; ++i) received += to[i].balance;

        assertEq(received, total, "everyone got exactly their share");
        assertEq(funder.balance, before - total, "and nothing evaporated");
    }
}
