// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  RipCards
 * @notice A provably fair gacha for vaulted, redeemable trading cards.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS MONAD
 * ---------------------------------------------------------------------------
 *
 * A gacha is only provably fair if the buyer commits BEFORE the randomness
 * exists. That means two transactions: commit, then reveal against a block the
 * buyer could not see at commit time.
 *
 * On a 12-second chain that is a 24-second wait between "I opened the pack"
 * and "I see my card". Nobody ships that, which is why every large gacha runs
 * its RNG on a private server and asks you to trust it.
 *
 * At a 400ms block time, commit and reveal are ~800ms apart. Provable fairness
 * becomes compatible with the UX of ripping a pack.
 *
 * The second half of the argument matters as much: a rollup with a single
 * sequencer controls transaction ordering, so the operator can influence which
 * block ends up supplying entropy to which reveal. Speed alone does not give
 * you fairness - speed without a trusted operator does. That combination is
 * what this contract is built on.
 *
 * ---------------------------------------------------------------------------
 * REAL CARDS, NOT JUST ARTWORK
 * ---------------------------------------------------------------------------
 *
 * A custodian deposits a physical graded card into the vault with its cert
 * number and an attestation hash (photo + custody declaration). That creates a
 * VaultItem which sits in an availability pool keyed by the exact card it is.
 *
 * When a rip draws that card, the pull BINDS to the vaulted item: the token
 * carries `vaultRef`, and its grade comes from the real slab rather than from
 * the RNG. Holding that token means holding a claim on a specific physical
 * card, and `redeem` burns the token to release it to its owner - the same
 * burn-to-ship cycle the incumbent vaults run.
 *
 * Pulls that find no matching inventory mint UNBACKED, with `vaultRef == 0`.
 * That is deliberate and visible onchain: the contract never pretends a card
 * is backed when it is not.
 *
 * ---------------------------------------------------------------------------
 * STATE LAYOUT - written for optimistic parallel execution
 * ---------------------------------------------------------------------------
 *
 * Nothing in the hot path touches a global counter. A `nextTokenId++` would be
 * one slot written by every transaction: a guaranteed write conflict between
 * every pair of users, forcing the scheduler to re-execute and serialise them.
 * Instead token ids are derived - keccak256(buyer, packNonce, slot) - so two
 * buyers ripping in the same instant never touch the same slot, and each
 * buyer's pending pack lives in one slot keyed by their own address.
 *
 * Scarce inventory is the honest exception. Two people pulling the SAME card
 * in the same block contend for that card's availability pool; that is not a
 * design flaw, it is what scarcity means. Contention is bounded by how many
 * distinct cards are in the vault, never by how many people are playing.
 *
 * `vaultCount` is a shared counter, but it is only ever written by a custodian
 * depositing stock - never while the room is ripping.
 *
 * Supply, floor price, live throughput and the pull feed are derived offchain
 * from logs.
 */
contract RipCards {
    // -----------------------------------------------------------------------
    // Config
    // -----------------------------------------------------------------------

    uint256 public constant CARDS_PER_PACK = 3;
    uint256 public constant TIERS = 5;
    uint256 public constant REVEAL_DELAY = 2;    // blocks; ~800ms on Monad
    uint256 public constant REVEAL_WINDOW = 200; // strictly inside the 256-block blockhash horizon

    uint8 public constant VAULTED = 0;
    uint8 public constant BOUND = 1;
    uint8 public constant REDEEMED = 2;

    uint256 public immutable packPrice;
    /// @notice keccak256 of the card catalogue JSON the frontend renders.
    bytes32 public immutable catalogueRoot;
    /// @dev 5 x uint16 cumulative weights out of 10_000, commonest tier first.
    uint256 public immutable oddsPacked;
    /// @dev 5 x uint16 number of distinct cards in each tier.
    uint256 public immutable tierSizesPacked;
    address public immutable operator;

    /// @notice Share of indexed value the vault pays to buy a card back, in bps.
    uint16 public buybackBps = 8500;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    struct VaultItem {
        address custodian;
        uint8 tier;
        uint16 cardIndex;
        uint8 grade;
        uint8 status;
        uint64 certNumber;
        bytes32 attestation;
        uint256 boundToken;
    }

    uint32 public vaultCount;
    mapping(uint32 => VaultItem) public vaultItem;
    /// @dev cardKey => stack of vault item ids currently available to be drawn
    mapping(bytes32 => uint32[]) private _available;
    /// @dev cardKey => indexed market value used for the standing buyback quote
    mapping(bytes32 => uint256) public quote;
    mapping(address => bool) public isCustodian;

    /// @dev buyer => bits 0..63 pending commit block (0 = none) | bits 64..127 packs bought
    mapping(address => uint256) private _user;

    /// @dev tokenId => packed card
    ///        bits   0..15  : card index within its tier (uint16)
    ///        bits  16..23  : tier (uint8)
    ///        bits  24..31  : PSA grade (uint8)
    ///        bits  32..63  : serial (uint32)
    ///        bits  64..111 : minted at (uint48)
    ///        bits 112..143 : vault item ref (uint32); 0 = unbacked
    mapping(uint256 => uint256) public card;

    mapping(uint256 => address) private _owner;
    mapping(address => uint256) private _balance;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operatorApproval;

    /// @dev tokenId => bits 0..159 seller | bits 160..255 price (uint96); 0 = unlisted
    mapping(uint256 => uint256) private _listing;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event PackCommitted(address indexed buyer, uint64 indexed packNonce, uint64 commitBlock);
    event PackRevealed(address indexed buyer, uint64 indexed packNonce, bytes32 entropy, uint256[] tokenIds);
    event CardMinted(
        uint256 indexed tokenId,
        address indexed owner,
        uint8 indexed tier,
        uint16 cardIndex,
        uint8 grade,
        uint32 serial,
        uint32 vaultRef
    );
    event PackRefunded(address indexed buyer, uint64 indexed packNonce);

    event CardDeposited(
        uint32 indexed vaultRef,
        address indexed custodian,
        uint8 indexed tier,
        uint16 cardIndex,
        uint8 grade,
        uint64 certNumber,
        bytes32 attestation
    );
    event CardBound(uint32 indexed vaultRef, uint256 indexed tokenId, address indexed holder);
    event Redeemed(uint32 indexed vaultRef, uint256 indexed tokenId, address indexed holder, string shippingRef);
    event BoughtBack(uint256 indexed tokenId, address indexed seller, uint256 paid, uint32 vaultRef);
    event QuoteSet(bytes32 indexed cardKey, uint256 value);
    event CustodianSet(address indexed custodian, bool allowed);

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Delisted(uint256 indexed tokenId, address indexed seller);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price);

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error WrongPrice();
    error PackAlreadyPending();
    error NoPendingPack();
    error RevealTooEarly();
    error RevealExpired();
    error NotYetExpired();
    error NotOwner();
    error NotAuthorized();
    error NotListed();
    error AlreadyListed();
    error BadPrice();
    error TransferFailed();
    error NoSuchToken();
    error NotBacked();
    error BadTier();
    error NoQuote();
    error VaultEmpty();

    constructor(
        uint256 _packPrice,
        bytes32 _catalogueRoot,
        uint16[5] memory cumulativeOdds,
        uint16[5] memory sizes
    ) {
        operator = msg.sender;
        isCustodian[msg.sender] = true;
        packPrice = _packPrice;
        catalogueRoot = _catalogueRoot;

        uint256 o;
        uint256 t;
        for (uint256 i; i < TIERS; ++i) {
            o |= uint256(cumulativeOdds[i]) << (i * 16);
            t |= uint256(sizes[i]) << (i * 16);
        }
        oddsPacked = o;
        tierSizesPacked = t;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotAuthorized();
        _;
    }

    // -----------------------------------------------------------------------
    // Vault - the physical side
    // -----------------------------------------------------------------------

    function cardKey(uint8 tier, uint16 cardIndex) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(tier, cardIndex));
    }

    /**
     * @notice Register a physical card held in custody and make it drawable.
     * @param  certNumber  Grading cert number, or an internal reference if raw.
     * @param  attestation keccak256 of the photo and custody declaration.
     */
    function depositCard(
        uint8 tier,
        uint16 cardIndex,
        uint8 grade,
        uint64 certNumber,
        bytes32 attestation
    ) external returns (uint32 vaultRef) {
        if (!isCustodian[msg.sender]) revert NotAuthorized();
        if (tier >= TIERS) revert BadTier();

        vaultRef = ++vaultCount;
        vaultItem[vaultRef] = VaultItem({
            custodian: msg.sender,
            tier: tier,
            cardIndex: cardIndex,
            grade: grade,
            status: VAULTED,
            certNumber: certNumber,
            attestation: attestation,
            boundToken: 0
        });
        _available[cardKey(tier, cardIndex)].push(vaultRef);

        emit CardDeposited(vaultRef, msg.sender, tier, cardIndex, grade, certNumber, attestation);
    }

    /**
     * @notice Burn a vault-backed token to have the physical card shipped.
     *         This is the only way a card leaves custody, so a card can never
     *         be in the post and tradable at the same time.
     */
    function redeem(uint256 tokenId, string calldata shippingRef) external {
        if (_owner[tokenId] != msg.sender) revert NotOwner();
        uint32 vaultRef = uint32(card[tokenId] >> 112);
        if (vaultRef == 0) revert NotBacked();

        vaultItem[vaultRef].status = REDEEMED;
        if (_listing[tokenId] != 0) _listing[tokenId] = 0;
        _burn(msg.sender, tokenId);

        emit Redeemed(vaultRef, tokenId, msg.sender, shippingRef);
    }

    /// @notice Standing offer: sell a card straight back to the vault.
    function sellBack(uint256 tokenId) external {
        if (_owner[tokenId] != msg.sender) revert NotOwner();
        uint256 c = card[tokenId];
        uint8 tier = uint8(c >> 16);
        uint16 cardIndex = uint16(c);
        uint32 vaultRef = uint32(c >> 112);

        bytes32 key = cardKey(tier, cardIndex);
        uint256 value = quote[key];
        if (value == 0) revert NoQuote();
        uint256 payout = (value * buybackBps) / 10_000;
        if (address(this).balance < payout) revert VaultEmpty();

        if (_listing[tokenId] != 0) _listing[tokenId] = 0;
        _burn(msg.sender, tokenId);

        // the physical card never moved; it simply becomes drawable again
        if (vaultRef != 0) {
            vaultItem[vaultRef].status = VAULTED;
            vaultItem[vaultRef].boundToken = 0;
            _available[key].push(vaultRef);
        }

        (bool ok, ) = msg.sender.call{value: payout}("");
        if (!ok) revert TransferFailed();
        emit BoughtBack(tokenId, msg.sender, payout, vaultRef);
    }

    function buybackOf(uint256 tokenId) external view returns (uint256) {
        uint256 c = card[tokenId];
        return (quote[cardKey(uint8(c >> 16), uint16(c))] * buybackBps) / 10_000;
    }

    function availableOf(uint8 tier, uint16 cardIndex) external view returns (uint256) {
        return _available[cardKey(tier, cardIndex)].length;
    }

    function setQuote(bytes32 key, uint256 value) external onlyOperator {
        quote[key] = value;
        emit QuoteSet(key, value);
    }

    function setQuotes(bytes32[] calldata keys, uint256[] calldata values) external onlyOperator {
        for (uint256 i; i < keys.length; ++i) {
            quote[keys[i]] = values[i];
            emit QuoteSet(keys[i], values[i]);
        }
    }

    function setCustodian(address who, bool allowed) external onlyOperator {
        isCustodian[who] = allowed;
        emit CustodianSet(who, allowed);
    }

    function setBuybackBps(uint16 bps) external onlyOperator {
        buybackBps = bps;
    }

    // -----------------------------------------------------------------------
    // Gacha - commit
    // -----------------------------------------------------------------------

    /// @notice Buy and seal a pack. The randomness does not exist yet.
    function buyPack() external payable returns (uint64 packNonce) {
        if (msg.value != packPrice) revert WrongPrice();

        uint256 u = _user[msg.sender];
        if (uint64(u) != 0) revert PackAlreadyPending();

        packNonce = uint64(u >> 64);
        _user[msg.sender] = uint256(uint64(block.number)) | (uint256(packNonce + 1) << 64);

        emit PackCommitted(msg.sender, packNonce, uint64(block.number));
    }

    // -----------------------------------------------------------------------
    // Gacha - reveal
    // -----------------------------------------------------------------------

    /// @notice Rip the sealed pack against a block hash that did not exist when
    ///         it was sealed. Roughly 800ms after `buyPack` on Monad.
    function revealPack() external returns (uint256[] memory tokenIds) {
        uint256 u = _user[msg.sender];
        uint64 commitBlock = uint64(u);
        if (commitBlock == 0) revert NoPendingPack();
        if (block.number < uint256(commitBlock) + REVEAL_DELAY) revert RevealTooEarly();
        // REVEAL_WINDOW sits inside the blockhash horizon, so this and
        // refundExpiredPack are mutually exclusive: a sealed pack can always be
        // either revealed or refunded, never neither.
        if (block.number > uint256(commitBlock) + REVEAL_WINDOW) revert RevealExpired();

        bytes32 entropy = blockhash(uint256(commitBlock) + 1);
        if (entropy == bytes32(0)) revert RevealExpired();

        uint64 packNonce = uint64(u >> 64) - 1;
        _user[msg.sender] = u & ~uint256(type(uint64).max); // clear commit, keep counter

        uint256 seed = uint256(keccak256(abi.encodePacked(entropy, msg.sender, packNonce)));

        tokenIds = new uint256[](CARDS_PER_PACK);
        for (uint256 i; i < CARDS_PER_PACK; ++i) {
            uint256 r = uint256(keccak256(abi.encodePacked(seed, i)));
            uint256 tokenId = uint256(keccak256(abi.encodePacked(msg.sender, packNonce, i)));

            (uint8 tier, uint16 cardIndex) = _draw(r);
            uint32 vaultRef = _bind(tier, cardIndex, tokenId);
            // a vaulted card carries the grade on its actual slab
            uint8 grade = vaultRef == 0 ? _grade(r >> 96, tier) : vaultItem[vaultRef].grade;
            uint32 serial = uint32((r >> 160) % 10_000) + 1;

            card[tokenId] =
                uint256(cardIndex) |
                (uint256(tier) << 16) |
                (uint256(grade) << 24) |
                (uint256(serial) << 32) |
                (uint256(uint48(block.timestamp)) << 64) |
                (uint256(vaultRef) << 112);
            _owner[tokenId] = msg.sender;
            tokenIds[i] = tokenId;

            emit Transfer(address(0), msg.sender, tokenId);
            emit CardMinted(tokenId, msg.sender, tier, cardIndex, grade, serial, vaultRef);
        }

        _balance[msg.sender] += CARDS_PER_PACK;
        emit PackRevealed(msg.sender, packNonce, entropy, tokenIds);
    }

    /// @dev Pops a vaulted copy of this exact card, if the vault holds one.
    function _bind(uint8 tier, uint16 cardIndex, uint256 tokenId) internal returns (uint32 vaultRef) {
        uint32[] storage pool = _available[cardKey(tier, cardIndex)];
        uint256 n = pool.length;
        if (n == 0) return 0;

        vaultRef = pool[n - 1];
        pool.pop();

        VaultItem storage item = vaultItem[vaultRef];
        item.status = BOUND;
        item.boundToken = tokenId;

        emit CardBound(vaultRef, tokenId, msg.sender);
    }

    /// @notice Recover the pack price if the reveal window was missed.
    function refundExpiredPack() external {
        uint256 u = _user[msg.sender];
        uint64 commitBlock = uint64(u);
        if (commitBlock == 0) revert NoPendingPack();
        if (block.number <= uint256(commitBlock) + REVEAL_WINDOW) revert NotYetExpired();

        uint64 packNonce = uint64(u >> 64) - 1;
        _user[msg.sender] = u & ~uint256(type(uint64).max);

        (bool ok, ) = msg.sender.call{value: packPrice}("");
        if (!ok) revert TransferFailed();
        emit PackRefunded(msg.sender, packNonce);
    }

    // -----------------------------------------------------------------------
    // Draw logic - published odds, verifiable by anyone
    // -----------------------------------------------------------------------

    function _draw(uint256 r) internal view returns (uint8 tier, uint16 cardIndex) {
        uint256 roll = r % 10_000;
        uint256 o = oddsPacked;
        tier = uint8(TIERS - 1);
        for (uint256 i; i < TIERS; ++i) {
            if (roll < uint16(o >> (i * 16))) {
                tier = uint8(i);
                break;
            }
        }
        uint16 size = uint16(tierSizesPacked >> (uint256(tier) * 16));
        cardIndex = uint16((r >> 32) % (size == 0 ? 1 : size));
    }

    /// @dev Grade for unbacked pulls only. Scarcer tiers grade better, PSA 7..10.
    function _grade(uint256 r, uint8 tier) internal pure returns (uint8) {
        uint256 roll = r % 100;
        uint256 bump = uint256(tier) * 8;
        if (roll + bump >= 92) return 10;
        if (roll + bump >= 70) return 9;
        if (roll + bump >= 35) return 8;
        return 7;
    }

    function odds() external view returns (uint16[5] memory out) {
        for (uint256 i; i < TIERS; ++i) out[i] = uint16(oddsPacked >> (i * 16));
    }

    function tierSizes() external view returns (uint16[5] memory out) {
        for (uint256 i; i < TIERS; ++i) out[i] = uint16(tierSizesPacked >> (i * 16));
    }

    /// @notice Everything the UI needs about a buyer, in one call.
    function userState(address who)
        external
        view
        returns (uint64 commitBlock, uint64 packsBought, bool revealable, uint256 balance)
    {
        uint256 u = _user[who];
        commitBlock = uint64(u);
        packsBought = uint64(u >> 64);
        revealable = commitBlock != 0 && block.number >= uint256(commitBlock) + REVEAL_DELAY;
        balance = _balance[who];
    }

    /// @notice Deterministic id, so a client can predict its own token ids.
    function tokenIdFor(address buyer, uint64 packNonce, uint256 slot) external pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(buyer, packNonce, slot)));
    }

    /// @notice Unpacked view of a card, for the UI and for explorers.
    function cardOf(uint256 tokenId)
        external
        view
        returns (uint8 tier, uint16 cardIndex, uint8 grade, uint32 serial, uint48 mintedAt, uint32 vaultRef)
    {
        uint256 c = card[tokenId];
        if (c == 0) revert NoSuchToken();
        return (uint8(c >> 16), uint16(c), uint8(c >> 24), uint32(c >> 32), uint48(c >> 64), uint32(c >> 112));
    }

    // -----------------------------------------------------------------------
    // Instant secondary market
    // -----------------------------------------------------------------------

    function list(uint256 tokenId, uint96 price) external {
        if (_owner[tokenId] != msg.sender) revert NotOwner();
        if (price == 0) revert BadPrice();
        if (_listing[tokenId] != 0) revert AlreadyListed();
        _listing[tokenId] = uint256(uint160(msg.sender)) | (uint256(price) << 160);
        emit Listed(tokenId, msg.sender, price);
    }

    function delist(uint256 tokenId) external {
        uint256 l = _listing[tokenId];
        if (l == 0) revert NotListed();
        if (address(uint160(l)) != msg.sender) revert NotOwner();
        _listing[tokenId] = 0;
        emit Delisted(tokenId, msg.sender);
    }

    function buy(uint256 tokenId) external payable {
        uint256 l = _listing[tokenId];
        if (l == 0) revert NotListed();
        address seller = address(uint160(l));
        uint256 price = l >> 160;
        if (msg.value != price) revert WrongPrice();

        _listing[tokenId] = 0;
        _transfer(seller, msg.sender, tokenId);

        (bool ok, ) = seller.call{value: price}("");
        if (!ok) revert TransferFailed();
        emit Sold(tokenId, seller, msg.sender, price);
    }

    function listingOf(uint256 tokenId) external view returns (address seller, uint256 price) {
        uint256 l = _listing[tokenId];
        return (address(uint160(l)), l >> 160);
    }

    // -----------------------------------------------------------------------
    // Minimal ERC-721
    // -----------------------------------------------------------------------

    function name() external pure returns (string memory) { return "Ripachu Vaulted Cards"; }
    function symbol() external pure returns (string memory) { return "RIP"; }

    function balanceOf(address who) external view returns (uint256) { return _balance[who]; }

    function ownerOf(uint256 tokenId) public view returns (address o) {
        o = _owner[tokenId];
        if (o == address(0)) revert NoSuchToken();
    }

    function approve(address to, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        if (o != msg.sender && !_operatorApproval[o][msg.sender]) revert NotAuthorized();
        _approved[tokenId] = to;
        emit Approval(o, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) { return _approved[tokenId]; }

    function setApprovalForAll(address op, bool ok) external {
        _operatorApproval[msg.sender][op] = ok;
        emit ApprovalForAll(msg.sender, op, ok);
    }

    function isApprovedForAll(address o, address op) external view returns (bool) {
        return _operatorApproval[o][op];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address o = ownerOf(tokenId);
        if (o != from) revert NotOwner();
        if (msg.sender != o && _approved[tokenId] != msg.sender && !_operatorApproval[o][msg.sender]) {
            revert NotAuthorized();
        }
        if (_listing[tokenId] != 0) _listing[tokenId] = 0;
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external {
        transferFrom(from, to, tokenId);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f;
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        _owner[tokenId] = to;
        _balance[from] -= 1;
        _balance[to] += 1;
        if (_approved[tokenId] != address(0)) _approved[tokenId] = address(0);
        emit Transfer(from, to, tokenId);
    }

    function _burn(address from, uint256 tokenId) internal {
        _owner[tokenId] = address(0);
        _balance[from] -= 1;
        if (_approved[tokenId] != address(0)) _approved[tokenId] = address(0);
        emit Transfer(from, address(0), tokenId);
    }

    // -----------------------------------------------------------------------
    // Treasury - funds the standing buyback
    // -----------------------------------------------------------------------

    /// @notice Top up the buyback reserve.
    receive() external payable {}

    function withdraw(address to, uint256 amount) external onlyOperator {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
