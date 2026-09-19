// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RipCards} from "../contracts/RipCards.sol";

contract RipCardsTest is Test {
    RipCards internal rip;

    uint256 constant PRICE = 0.001 ether;
    bytes32 constant ROOT = keccak256("catalogue-v1");

    // mirrors src/lib/catalogue.ts
    uint16[5] ODDS = [uint16(6000), 8600, 9500, 9900, 10000];
    uint16[5] SIZES = [uint16(12), 10, 8, 6, 4];

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address custodian = makeAddr("custodian");

    function setUp() public {
        rip = new RipCards(PRICE, ROOT, ODDS, SIZES);
        rip.setCustodian(custodian, true);
        vm.roll(1_000);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    function _seal(address who) internal returns (uint256 commitBlock) {
        commitBlock = block.number;
        vm.prank(who);
        rip.buyPack{value: PRICE}();
    }

    /// @dev Advance far enough to reveal and make the entropy block available.
    function _ripen(uint256 commitBlock) internal {
        vm.roll(commitBlock + rip.REVEAL_DELAY());
        vm.setBlockhash(commitBlock + 1, keccak256(abi.encode("entropy", commitBlock + 1)));
    }

    function _rip(address who) internal returns (uint256[] memory ids) {
        uint256 commitBlock = _seal(who);
        _ripen(commitBlock);
        vm.prank(who);
        ids = rip.revealPack();
    }

    function _deposit(uint8 tier, uint16 cardIndex, uint8 grade) internal returns (uint32 ref) {
        vm.prank(custodian);
        ref = rip.depositCard(tier, cardIndex, grade, 12345, keccak256("photo"));
    }

    // =======================================================================
    // Commit / reveal - the fairness guarantee
    // =======================================================================

    function test_BuyPackSealsAndCharges() public {
        uint256 before = alice.balance;
        uint256 commitBlock = _seal(alice);

        (uint64 pendingBlock, uint64 packsBought, bool revealable,) = rip.userState(alice);
        assertEq(pendingBlock, uint64(commitBlock), "commit block recorded");
        assertEq(packsBought, 1, "pack counter advanced");
        assertFalse(revealable, "not revealable in the commit block");
        assertEq(alice.balance, before - PRICE, "charged exactly the pack price");
        assertEq(address(rip).balance, PRICE, "price went to the reserve");
    }

    function test_RevertWhen_WrongPrice() public {
        vm.prank(alice);
        vm.expectRevert(RipCards.WrongPrice.selector);
        rip.buyPack{value: PRICE + 1}();
    }

    function test_RevertWhen_PackAlreadyPending() public {
        _seal(alice);
        vm.prank(alice);
        vm.expectRevert(RipCards.PackAlreadyPending.selector);
        rip.buyPack{value: PRICE}();
    }

    function test_RevertWhen_RevealWithoutPack() public {
        vm.prank(alice);
        vm.expectRevert(RipCards.NoPendingPack.selector);
        rip.revealPack();
    }

    function test_RevertWhen_RevealTooEarly() public {
        uint256 commitBlock = _seal(alice);

        // same block
        vm.prank(alice);
        vm.expectRevert(RipCards.RevealTooEarly.selector);
        rip.revealPack();

        // one block later is still too early: the entropy block must be PAST,
        // otherwise blockhash(commitBlock + 1) is the current block and is zero
        vm.roll(commitBlock + 1);
        vm.prank(alice);
        vm.expectRevert(RipCards.RevealTooEarly.selector);
        rip.revealPack();
    }

    function test_RevealSucceedsAtExactlyTwoBlocks() public {
        uint256 commitBlock = _seal(alice);
        _ripen(commitBlock);
        assertEq(block.number, commitBlock + 2, "two blocks is the whole wait");

        vm.prank(alice);
        uint256[] memory ids = rip.revealPack();
        assertEq(ids.length, rip.CARDS_PER_PACK(), "three cards");
        assertEq(rip.balanceOf(alice), 3);
    }

    /**
     * The core claim: the cards depend on a block that did not exist when the
     * pack was sealed. Same buyer, same pack, same nonce - rewind and change
     * only that one block hash, and the pull must change.
     */
    function test_DrawDependsOnPostCommitBlockhash() public {
        uint256 commitBlock = _seal(alice);
        vm.roll(commitBlock + 2);

        uint256 snap = vm.snapshotState();

        vm.setBlockhash(commitBlock + 1, keccak256("world-a"));
        vm.prank(alice);
        uint256[] memory idsA = rip.revealPack();
        uint256[3] memory worldA;
        for (uint256 i; i < 3; ++i) worldA[i] = rip.card(idsA[i]);

        vm.revertToState(snap);

        vm.setBlockhash(commitBlock + 1, keccak256("world-b"));
        vm.prank(alice);
        uint256[] memory idsB = rip.revealPack();

        bool anyDifferent;
        for (uint256 i; i < 3; ++i) {
            // ids are derived from (buyer, nonce, slot), so they must NOT move
            assertEq(idsB[i], idsA[i], "token id is deterministic");
            if (rip.card(idsB[i]) != worldA[i]) anyDifferent = true;
        }
        assertTrue(anyDifferent, "a different entropy block must produce a different pull");
    }

    /// The same property across two independent buyers.
    function test_DifferentEntropyGivesDifferentCards() public {
        uint256 commitBlockA = _seal(alice);
        vm.roll(commitBlockA + 2);
        vm.setBlockhash(commitBlockA + 1, keccak256("world-a"));
        vm.prank(alice);
        rip.revealPack();
        uint256 cardA = rip.card(rip.tokenIdFor(alice, 0, 0));

        uint256 commitBlockB = _seal(bob);
        vm.roll(commitBlockB + 2);
        vm.setBlockhash(commitBlockB + 1, keccak256("world-b"));
        vm.prank(bob);
        rip.revealPack();
        uint256 cardB = rip.card(rip.tokenIdFor(bob, 0, 0));

        // strip the timestamp so we compare the drawn card, not when it landed
        assertTrue((cardA & type(uint64).max) != (cardB & type(uint64).max), "entropy drives the draw");
    }

    function test_RevertWhen_RevealAfterWindow() public {
        uint256 commitBlock = _seal(alice);
        vm.roll(commitBlock + rip.REVEAL_WINDOW() + 1);
        vm.setBlockhash(commitBlock + 1, keccak256("late"));

        vm.prank(alice);
        vm.expectRevert(RipCards.RevealExpired.selector);
        rip.revealPack();
    }

    function test_RefundAfterWindow() public {
        uint256 commitBlock = _seal(alice);
        uint256 before = alice.balance;
        vm.roll(commitBlock + rip.REVEAL_WINDOW() + 1);

        vm.prank(alice);
        rip.refundExpiredPack();

        assertEq(alice.balance, before + PRICE, "pack price returned");
        (uint64 pending,,,) = rip.userState(alice);
        assertEq(pending, 0, "commit cleared");
    }

    function test_RevertWhen_RefundTooEarly() public {
        uint256 commitBlock = _seal(alice);
        vm.roll(commitBlock + rip.REVEAL_WINDOW());

        vm.prank(alice);
        vm.expectRevert(RipCards.NotYetExpired.selector);
        rip.refundExpiredPack();
    }

    /**
     * Regression test for a real bug.
     *
     * REVEAL_WINDOW used to be checked only by the refund path, so between
     * commit+200 and the blockhash horizon a sealed pack could be neither
     * revealed nor refunded. A buyer could lose the pack entirely.
     *
     * Invariant: once a pack is ripe, exactly one of the two paths works.
     */
    function testFuzz_RevealXorRefund(uint256 offset) public {
        offset = bound(offset, rip.REVEAL_DELAY(), 500);

        uint256 commitBlock = _seal(alice);
        vm.roll(commitBlock + offset);
        vm.setBlockhash(commitBlock + 1, keccak256(abi.encode(commitBlock)));

        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        (bool revealOk,) = address(rip).call(abi.encodeCall(RipCards.revealPack, ()));

        vm.revertToState(snap);

        vm.prank(alice);
        (bool refundOk,) = address(rip).call(abi.encodeCall(RipCards.refundExpiredPack, ()));

        assertTrue(revealOk != refundOk, "a ripe pack is always exactly one of revealable or refundable");
    }

    // =======================================================================
    // Derived ids and the draw
    // =======================================================================

    function test_TokenIdsAreDerivedNotCounted() public {
        uint256[] memory ids = _rip(alice);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(ids[i], rip.tokenIdFor(alice, 0, i), "id is a pure function of buyer and nonce");
            assertEq(rip.ownerOf(ids[i]), alice);
        }
    }

    function testFuzz_TokenIdsNeverCollideAcrossBuyers(address a, address b, uint64 n) public view {
        vm.assume(a != b);
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                assertTrue(rip.tokenIdFor(a, n, i) != rip.tokenIdFor(b, n, j), "buyers never share a slot");
            }
        }
    }

    function testFuzz_DrawAlwaysInsideCatalogue(uint256 entropy) public {
        // a zero block hash means the entropy block is unavailable, which the
        // contract correctly refuses to draw against
        vm.assume(entropy != 0);
        uint256 commitBlock = _seal(alice);
        vm.roll(commitBlock + 2);
        vm.setBlockhash(commitBlock + 1, bytes32(entropy));

        vm.prank(alice);
        uint256[] memory ids = rip.revealPack();

        uint16[5] memory sizes = rip.tierSizes();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 tier, uint16 cardIndex, uint8 grade,,,) = rip.cardOf(ids[i]);
            assertLt(tier, 5, "tier in range");
            assertLt(cardIndex, sizes[tier], "card index inside its tier");
            assertGe(grade, 7, "grade floor");
            assertLe(grade, 10, "grade ceiling");
        }
    }

    function test_OddsAndSizesArePublished() public view {
        uint16[5] memory odds = rip.odds();
        uint16[5] memory sizes = rip.tierSizes();
        for (uint256 i; i < 5; ++i) {
            assertEq(odds[i], ODDS[i], "odds readable by anyone");
            assertEq(sizes[i], SIZES[i]);
        }
        assertEq(odds[4], 10_000, "weights sum to certainty");
    }

    /// The published 1% grail rate has to actually hold.
    function test_GrailRateMatchesPublishedOdds() public {
        uint256 packs = 400;
        uint256 grails;
        uint256 cards;

        for (uint256 p; p < packs; ++p) {
            address who = address(uint160(0x1000 + p));
            vm.deal(who, 1 ether);
            uint256 commitBlock = block.number;
            vm.prank(who);
            rip.buyPack{value: PRICE}();
            vm.roll(commitBlock + 2);
            vm.setBlockhash(commitBlock + 1, keccak256(abi.encode(p)));
            vm.prank(who);
            uint256[] memory ids = rip.revealPack();

            for (uint256 i; i < ids.length; ++i) {
                (uint8 tier,,,,,) = rip.cardOf(ids[i]);
                if (tier == 4) grails++;
                cards++;
            }
        }

        // 1% of 1200 cards is 12; allow a generous band for sample noise
        assertGt(grails, 2, "grails are reachable");
        assertLt(grails * 100, cards * 4, "grails stay rare");
    }

    // =======================================================================
    // Parallel execution - the architectural claim, asserted mechanically
    // =======================================================================

    /**
     * Two buyers ripping concurrently must not write a single common storage
     * slot. This is what lets Monad execute them in parallel instead of
     * detecting a conflict and re-running one of them.
     */
    function test_ConcurrentRipsWriteDisjointSlots() public {
        uint256 commitBlock = block.number;
        vm.prank(alice);
        rip.buyPack{value: PRICE}();
        vm.prank(bob);
        rip.buyPack{value: PRICE}();

        vm.roll(commitBlock + 2);
        vm.setBlockhash(commitBlock + 1, keccak256("shared-entropy"));

        vm.record();
        vm.prank(alice);
        rip.revealPack();
        (, bytes32[] memory aliceWrites) = vm.accesses(address(rip));

        vm.record();
        vm.prank(bob);
        rip.revealPack();
        (, bytes32[] memory bobWrites) = vm.accesses(address(rip));

        assertGt(aliceWrites.length, 0, "reveal writes something");
        for (uint256 i; i < aliceWrites.length; ++i) {
            for (uint256 j; j < bobWrites.length; ++j) {
                assertTrue(
                    aliceWrites[i] != bobWrites[j],
                    "two concurrent reveals shared a storage slot - parallel execution would serialise them"
                );
            }
        }
    }

    /**
     * The documented exception, asserted rather than asserted-in-prose.
     *
     * Scarce inventory IS contended: two buyers pulling the same vaulted card
     * both write that card's availability pool. The README claims contention is
     * bounded to the vault and never to the number of players - this pins the
     * first half of that claim so it cannot silently stop being true.
     */
    function test_BindingContendsOnTheVaultPool() public {
        _deposit(0, 0, 9);
        _deposit(0, 0, 9);

        bytes32[] memory firstWrites;
        bytes32[] memory secondWrites;
        uint256 found;

        for (uint256 attempt; attempt < 80 && found < 2; ++attempt) {
            address who = address(uint160(0x6000 + attempt));
            vm.deal(who, 1 ether);
            uint256 commitBlock = block.number;
            vm.prank(who);
            rip.buyPack{value: PRICE}();
            vm.roll(commitBlock + 2);
            vm.setBlockhash(commitBlock + 1, keccak256(abi.encode("contend", attempt)));

            vm.record();
            vm.prank(who);
            uint256[] memory ids = rip.revealPack();
            (, bytes32[] memory writes) = vm.accesses(address(rip));

            bool didBind;
            for (uint256 i; i < ids.length; ++i) {
                (,,,,, uint32 vaultRef) = rip.cardOf(ids[i]);
                if (vaultRef != 0) didBind = true;
            }
            if (!didBind) continue;

            if (found == 0) firstWrites = writes;
            else secondWrites = writes;
            found++;
        }

        assertEq(found, 2, "two binds happened");

        bool shared;
        for (uint256 i; i < firstWrites.length; ++i) {
            for (uint256 j; j < secondWrites.length; ++j) {
                if (firstWrites[i] == secondWrites[j]) shared = true;
            }
        }
        assertTrue(shared, "two binds to the same card must contend - that is what scarcity costs");
    }

    // =======================================================================
    // Vault - the physical side
    // =======================================================================

    function test_DepositRegistersAndMakesDrawable() public {
        assertEq(rip.availableOf(4, 0), 0, "vault starts empty");
        uint32 ref = _deposit(4, 0, 10);

        assertEq(ref, 1, "first vault item");
        assertEq(rip.vaultCount(), 1);
        assertEq(rip.availableOf(4, 0), 1, "card is drawable");

        (address who, uint8 tier, uint16 cardIndex, uint8 grade, uint8 status, uint64 cert,,) =
            rip.vaultItem(ref);
        assertEq(who, custodian);
        assertEq(tier, 4);
        assertEq(cardIndex, 0);
        assertEq(grade, 10);
        assertEq(status, rip.VAULTED());
        assertEq(cert, 12345);
    }

    function test_RevertWhen_DepositNotCustodian() public {
        vm.prank(alice);
        vm.expectRevert(RipCards.NotAuthorized.selector);
        rip.depositCard(0, 0, 9, 1, bytes32(0));
    }

    function test_RevertWhen_DepositBadTier() public {
        vm.prank(custodian);
        vm.expectRevert(RipCards.BadTier.selector);
        rip.depositCard(5, 0, 9, 1, bytes32(0));
    }

    function test_CustodianRoleIsControlled() public {
        vm.prank(alice);
        vm.expectRevert(RipCards.NotAuthorized.selector);
        rip.setCustodian(alice, true);

        rip.setCustodian(alice, true);
        assertTrue(rip.isCustodian(alice));
    }

    /**
     * The path that makes the RWA claim real: a pull of a card that is in the
     * vault must bind to it and take the grade from the physical slab.
     */
    function test_PullBindsToVaultAndTakesSlabGrade() public {
        // flood one card so whatever the draw picks in tier 0, index 0 is stocked
        uint8 slabGrade = 3; // deliberately impossible for the RNG (it yields 7..10)
        uint32 ref = _deposit(0, 0, slabGrade);

        uint256 tokenId;
        bool bound_;
        // rip until we draw tier 0 / index 0; it is the commonest card so this
        // terminates quickly
        for (uint256 attempt; attempt < 60 && !bound_; ++attempt) {
            address who = address(uint160(0x2000 + attempt));
            vm.deal(who, 1 ether);
            uint256 commitBlock = block.number;
            vm.prank(who);
            rip.buyPack{value: PRICE}();
            vm.roll(commitBlock + 2);
            vm.setBlockhash(commitBlock + 1, keccak256(abi.encode("bind", attempt)));
            vm.prank(who);
            uint256[] memory ids = rip.revealPack();

            for (uint256 i; i < ids.length; ++i) {
                (,,,,, uint32 vaultRef) = rip.cardOf(ids[i]);
                if (vaultRef != 0) {
                    tokenId = ids[i];
                    bound_ = true;
                    break;
                }
            }
        }

        assertTrue(bound_, "a vaulted card eventually binds");

        (uint8 tier, uint16 cardIndex, uint8 grade,,, uint32 vaultRef) = rip.cardOf(tokenId);
        assertEq(vaultRef, ref, "bound to the deposited item");
        assertEq(tier, 0);
        assertEq(cardIndex, 0);
        assertEq(grade, slabGrade, "grade comes from the slab, not the RNG");

        (,,,, uint8 status,,, uint256 boundToken) = rip.vaultItem(ref);
        assertEq(status, rip.BOUND(), "item marked bound");
        assertEq(boundToken, tokenId);
        assertEq(rip.availableOf(0, 0), 0, "item left the pool");
    }

    function test_UnbackedWhenVaultEmpty() public {
        uint256[] memory ids = _rip(alice);
        for (uint256 i; i < ids.length; ++i) {
            (,,,,, uint32 vaultRef) = rip.cardOf(ids[i]);
            assertEq(vaultRef, 0, "no stock means no backing, and the token says so");
        }
    }

    function test_VaultItemBindsOnlyOnce() public {
        _deposit(0, 0, 9);
        assertEq(rip.availableOf(0, 0), 1);

        // burn through rips until the single item is taken
        for (uint256 attempt; attempt < 60 && rip.availableOf(0, 0) > 0; ++attempt) {
            address who = address(uint160(0x3000 + attempt));
            vm.deal(who, 1 ether);
            uint256 commitBlock = block.number;
            vm.prank(who);
            rip.buyPack{value: PRICE}();
            vm.roll(commitBlock + 2);
            vm.setBlockhash(commitBlock + 1, keccak256(abi.encode("once", attempt)));
            vm.prank(who);
            rip.revealPack();
        }

        assertEq(rip.availableOf(0, 0), 0, "pool drained");

        // further rips of the same card must mint unbacked, never rebind
        for (uint256 attempt; attempt < 10; ++attempt) {
            address who = address(uint160(0x4000 + attempt));
            vm.deal(who, 1 ether);
            uint256 commitBlock = block.number;
            vm.prank(who);
            rip.buyPack{value: PRICE}();
            vm.roll(commitBlock + 2);
            vm.setBlockhash(commitBlock + 1, keccak256(abi.encode("after", attempt)));
            vm.prank(who);
            uint256[] memory ids = rip.revealPack();
            for (uint256 i; i < ids.length; ++i) {
                (,,,,, uint32 vaultRef) = rip.cardOf(ids[i]);
                assertEq(vaultRef, 0, "a vaulted item is never bound twice");
            }
        }
    }

    // =======================================================================
    // Redemption
    // =======================================================================

    function test_RedeemBurnsTokenAndReleasesCard() public {
        (uint256 tokenId, uint32 ref) = _mintBackedCard();

        address holder = rip.ownerOf(tokenId);
        uint256 balanceBefore = rip.balanceOf(holder);

        vm.expectEmit(true, true, true, true);
        emit RipCards.Redeemed(ref, tokenId, holder, "paris-blitz-001");

        vm.prank(holder);
        rip.redeem(tokenId, "paris-blitz-001");

        assertEq(rip.balanceOf(holder), balanceBefore - 1, "token burned");
        vm.expectRevert(RipCards.NoSuchToken.selector);
        rip.ownerOf(tokenId);

        (,,,, uint8 status,,,) = rip.vaultItem(ref);
        assertEq(status, rip.REDEEMED(), "card released from custody");
        assertEq(rip.availableOf(0, 0), 0, "a redeemed card never becomes drawable again");
    }

    function test_RevertWhen_RedeemUnbacked() public {
        uint256[] memory ids = _rip(alice);
        vm.prank(alice);
        vm.expectRevert(RipCards.NotBacked.selector);
        rip.redeem(ids[0], "nope");
    }

    function test_RevertWhen_RedeemNotOwner() public {
        (uint256 tokenId,) = _mintBackedCard();
        vm.prank(bob);
        vm.expectRevert(RipCards.NotOwner.selector);
        rip.redeem(tokenId, "nope");
    }

    // =======================================================================
    // Standing buyback
    // =======================================================================

    function test_SellBackPaysFloorAndReturnsCardToPool() public {
        (uint256 tokenId, uint32 ref) = _mintBackedCard();
        address holder = rip.ownerOf(tokenId);

        rip.setQuote(rip.cardKey(0, 0), 1 ether);
        vm.deal(address(rip), 10 ether);

        // uint256() matters: buybackBps is uint16, so without it the literal is
        // narrowed to uint16 and 1 ether overflows before the division
        uint256 expected = (1 ether * uint256(rip.buybackBps())) / 10_000;
        assertEq(rip.buybackOf(tokenId), expected, "quote is public before selling");

        uint256 before = holder.balance;
        vm.prank(holder);
        rip.sellBack(tokenId);

        assertEq(holder.balance, before + expected, "paid the published floor");
        vm.expectRevert(RipCards.NoSuchToken.selector);
        rip.ownerOf(tokenId);

        (,,,, uint8 status,,, uint256 boundToken) = rip.vaultItem(ref);
        assertEq(status, rip.VAULTED(), "card is back in stock");
        assertEq(boundToken, 0);
        assertEq(rip.availableOf(0, 0), 1, "and drawable again");
    }

    function test_RevertWhen_SellBackWithoutQuote() public {
        uint256[] memory ids = _rip(alice);
        vm.deal(address(rip), 10 ether);
        vm.prank(alice);
        vm.expectRevert(RipCards.NoQuote.selector);
        rip.sellBack(ids[0]);
    }

    function test_RevertWhen_ReserveTooThin() public {
        uint256[] memory ids = _rip(alice);
        (uint8 tier, uint16 cardIndex,,,,) = rip.cardOf(ids[0]);
        rip.setQuote(rip.cardKey(tier, cardIndex), 100 ether);

        vm.prank(alice);
        vm.expectRevert(RipCards.VaultEmpty.selector);
        rip.sellBack(ids[0]);
    }

    function test_OnlyOperatorSetsQuotesAndBps() public {
        // hoisted: an inline rip.cardKey(...) would be the call that vm.prank
        // and vm.expectRevert latch onto, and the assertion would be vacuous
        bytes32 key = rip.cardKey(0, 0);

        vm.prank(alice);
        vm.expectRevert(RipCards.NotAuthorized.selector);
        rip.setQuote(key, 1 ether);

        vm.prank(alice);
        vm.expectRevert(RipCards.NotAuthorized.selector);
        rip.setBuybackBps(9000);

        rip.setBuybackBps(9000);
        assertEq(rip.buybackBps(), 9000);
    }

    // =======================================================================
    // Secondary market and ERC-721
    // =======================================================================

    function test_ListAndBuy() public {
        uint256[] memory ids = _rip(alice);
        uint256 tokenId = ids[0];

        vm.prank(alice);
        rip.list(tokenId, 0.5 ether);
        (address seller, uint256 price) = rip.listingOf(tokenId);
        assertEq(seller, alice);
        assertEq(price, 0.5 ether);

        uint256 aliceBefore = alice.balance;
        vm.prank(bob);
        rip.buy{value: 0.5 ether}(tokenId);

        assertEq(rip.ownerOf(tokenId), bob);
        assertEq(alice.balance, aliceBefore + 0.5 ether, "seller paid directly");
        (address after_,) = rip.listingOf(tokenId);
        assertEq(after_, address(0), "listing cleared");
    }

    function test_RevertWhen_BuyAtWrongPrice() public {
        uint256[] memory ids = _rip(alice);
        vm.prank(alice);
        rip.list(ids[0], 0.5 ether);

        vm.prank(bob);
        vm.expectRevert(RipCards.WrongPrice.selector);
        rip.buy{value: 0.4 ether}(ids[0]);
    }

    function test_RevertWhen_ListingSomeoneElsesCard() public {
        uint256[] memory ids = _rip(alice);
        vm.prank(bob);
        vm.expectRevert(RipCards.NotOwner.selector);
        rip.list(ids[0], 1);
    }

    function test_TransferClearsListing() public {
        uint256[] memory ids = _rip(alice);
        vm.startPrank(alice);
        rip.list(ids[0], 0.5 ether);
        rip.transferFrom(alice, bob, ids[0]);
        vm.stopPrank();

        (address seller,) = rip.listingOf(ids[0]);
        assertEq(seller, address(0), "a transferred card is no longer for sale");
        assertEq(rip.ownerOf(ids[0]), bob);
    }

    function test_BalancesTrackTransfers() public {
        uint256[] memory ids = _rip(alice);
        assertEq(rip.balanceOf(alice), 3);

        vm.prank(alice);
        rip.transferFrom(alice, bob, ids[0]);

        assertEq(rip.balanceOf(alice), 2);
        assertEq(rip.balanceOf(bob), 1);
    }

    function test_SupportsErc721Interfaces() public view {
        assertTrue(rip.supportsInterface(0x01ffc9a7), "ERC165");
        assertTrue(rip.supportsInterface(0x80ac58cd), "ERC721");
        assertTrue(rip.supportsInterface(0x5b5e139f), "ERC721Metadata");
        assertFalse(rip.supportsInterface(0xdeadbeef));
    }

    // =======================================================================
    // Catalogue integrity and treasury
    // =======================================================================

    function test_CatalogueRootIsImmutable() public view {
        assertEq(rip.catalogueRoot(), ROOT, "the app cannot redefine a card after deploy");
    }

    function test_OnlyOperatorWithdraws() public {
        _seal(alice);
        vm.prank(bob);
        vm.expectRevert(RipCards.NotAuthorized.selector);
        rip.withdraw(bob, PRICE);

        uint256 before = address(this).balance;
        rip.withdraw(address(this), PRICE);
        assertEq(address(this).balance, before + PRICE);
    }

    // -----------------------------------------------------------------------

    /// Rips until a deposited tier-0 card binds, and returns the backed token.
    function _mintBackedCard() internal returns (uint256 tokenId, uint32 ref) {
        ref = _deposit(0, 0, 9);
        for (uint256 attempt; attempt < 60; ++attempt) {
            address who = address(uint160(0x5000 + attempt));
            vm.deal(who, 1 ether);
            uint256 commitBlock = block.number;
            vm.prank(who);
            rip.buyPack{value: PRICE}();
            vm.roll(commitBlock + 2);
            vm.setBlockhash(commitBlock + 1, keccak256(abi.encode("backed", attempt)));
            vm.prank(who);
            uint256[] memory ids = rip.revealPack();
            for (uint256 i; i < ids.length; ++i) {
                (,,,,, uint32 vaultRef) = rip.cardOf(ids[i]);
                if (vaultRef == ref) return (ids[i], ref);
            }
        }
        revert("no backed card was drawn");
    }

    receive() external payable {}
}
