# RIP — provably fair gacha for vaulted cards

Built at Monad Blitz Paris, 19 September 2026.

Buy a pack. Open it. Get a graded card that is backed by a physical card in
custody, and that you can redeem to have shipped to you.

The part that is new is not the pack. It is that **the draw is provably fair**,
and that this is only usable because Monad blocks are 400ms.

---

## The argument

A gacha is only fair if the buyer commits **before** the randomness exists.
That means two transactions: commit, then reveal against a block the buyer
could not have seen when they committed.

On a 12-second chain that is a **24-second wait** between "I opened the pack"
and "I see my card". Nobody ships that. Which is why every large gacha —
including the ones doing hundreds of millions a month — runs its RNG on a
private server and asks you to trust it.

At a 400ms block time, commit and reveal are **~800ms apart**. Provable
fairness becomes compatible with the UX of ripping a pack.

Speed alone is not the whole argument, though. A rollup with a single
sequencer controls transaction ordering, so its operator can influence which
block supplies entropy to which reveal — the fairness claim quietly
reconstitutes the trusted party you were trying to remove. What this needs is
sub-second blocks **without** a privileged operator. That is the combination
Monad provides.

---

## What is actually real

Honesty about scope matters more than a bigger claim, so:

| | Status |
|---|---|
| Commit–reveal draw, onchain | **Real.** `blockhash(commitBlock + 1)`, unpredictable at commit time |
| Published odds | **Real.** Set at deploy, immutable, readable by anyone via `odds()` |
| Catalogue integrity | **Real.** `catalogueRoot` commits to the card table; the app cannot redefine a card afterwards |
| Physical backing | **Real, at small scale.** Cards in `vault.json` physically exist and are in custody |
| Redemption | **Real.** `redeem()` burns the token; the card is handed over |
| Standing buyback | **Real.** Funded from the contract reserve at `buybackBps` of the posted quote |
| Vault at scale, insurance, shipping | **Not built.** This is a custodian integration, not a contract |

Pulls with no matching stock in the vault mint **unbacked**, with `vaultRef == 0`,
and the UI says so. The contract never pretends a card is backed when it is not.

For reference, the incumbents do not run their own vaults either — they
integrate PSA, PWCC and ALT, which already served the traditional graded-card
market. Custody is a business-development problem. The parts that have to be
onchain are the parts built here.

---

## State layout, and why it looks wasteful

Nothing in the hot path touches a global counter.

A `nextTokenId++` is one storage slot written by every transaction: a
guaranteed write conflict between every pair of users, which forces Monad's
optimistic parallel execution to detect the collision and re-execute them
serially. A contract that does this is actively suppressing the throughput it
is deployed on.

So instead:

- **token ids are derived** — `keccak256(buyer, packNonce, slot)` — two buyers
  ripping in the same instant never touch the same slot;
- **each buyer's pending pack** lives in a single slot keyed by their own address;
- **listings and ownership** are keyed by token id;
- **supply, floor, live throughput and the pull feed** are derived offchain from
  logs, never stored.

Scarce inventory is the honest exception. Two people pulling the *same* card in
the same block contend for that card's availability pool — that is not a design
flaw, it is what scarcity means. Contention is bounded by how many distinct
cards are in the vault, never by how many people are playing.

The two shared slots that do exist — `vaultCount` and the contract's native
balance — are only written by custodian deposits and by `buyPack` respectively.
The expensive transaction, `revealPack`, writes six slots and contends with
nobody.

---

## Demo architecture

The room is the demo, which means the public RPC is the thing most likely to
kill it. So:

- **One indexer.** The server is the only process reading the chain. Browsers
  subscribe over SSE and never read at all — they only *write*, signing locally
  and broadcasting their own transactions. Adding a viewer costs the RPC nothing.
- **Pre-funded burner pool.** Wallets are generated and funded in one
  `Disperse` transaction, hours ahead. At demo time a phone claims an unused
  key. No funding transaction is ever sent while the room is watching — which
  is what goes wrong when 80 people scan a QR code and one signer tries to send
  80 transfers from one nonce sequence.
- **One RPC call per action.** Explicit gas limits, explicit fees and a locally
  tracked nonce reduce a rip to exactly one `eth_sendRawTransaction` per
  transaction.
- **A bot swarm** as the fallback. If the venue wifi eats the room, it runs from
  the laptop and the throughput gauge still moves.

---

## Running it

```bash
pnpm install
cp .env.example .env          # add DEPLOYER_PK
pnpm test                     # 49 Foundry tests
pnpm compile                  # solc-js artifacts for the deploy scripts
pnpm test:odds                # samples the draw logic, 360k cards
pnpm deploy                   # writes deployments.json

cp vault.example.json vault.json   # describe the cards you physically hold
pnpm seed:vault                    # deposit them + post buyback quotes

pnpm wallets:gen              # generate the burner pool
pnpm wallets:fund             # fund it in one transaction
pnpm build && pnpm start      # server on :3000

pnpm preflight                # run this before walking on stage
pnpm bots                     # pre-seed the feed / fallback
```

- `/` — the phone view. Claim a wallet, rip a pack, redeem a card.
- `/screen` — the projector view. QR code, live pull feed, throughput.

---

## Tests

```bash
pnpm test        # 49 Foundry tests
pnpm test:deep   # the same, with fuzz runs at 20,000
pnpm test:odds   # samples the draw logic offchain
```

`forge test` — 49 tests, 0 failures. The ones that carry weight:

**Fairness.** `test_DrawDependsOnPostCommitBlockhash` seals a pack, snapshots,
reveals against one block hash, rewinds, and reveals against another. The token
ids must be identical (they are derived) and the cards behind them must differ.
That is the property the whole product rests on, asserted rather than claimed.

**The bug that was there.** `testFuzz_RevealXorRefund` fuzzes the block offset
across the entire window and asserts that a ripe pack is *always* exactly one of
revealable or refundable. `REVEAL_WINDOW` used to be checked only on the refund
path, which left a range where a sealed pack was neither — the buyer just lost
it. 20,000 runs.

**The parallelism claim, mechanically.** `test_ConcurrentRipsWriteDisjointSlots`
records the storage writes of two buyers revealing in the same block and asserts
the write sets do not intersect at a single slot. If someone later adds a global
counter, this test fails — which is the point.

**The honest exception.** `test_BindingContendsOnTheVaultPool` asserts the
opposite for scarce stock: two pulls of the same vaulted card *must* share a
slot. Scarcity costs contention, and the README should not be able to drift away
from that quietly.

**The RWA path.** `test_PullBindsToVaultAndTakesSlabGrade` deposits a card with
a grade the RNG cannot produce, rips until it binds, and asserts the grade came
from the slab. `test_VaultItemBindsOnlyOnce` drains the pool and confirms later
pulls mint unbacked rather than double-binding one physical card.

`pnpm test:odds` additionally mirrors the draw logic in TypeScript — reproducing
the exact keccak chain — and samples it at a scale Foundry would be slow at:

```
tier distribution
  Common     60.06%  (target 60.00%, drift +0.057)
  Uncommon   25.98%  (target 26.00%, drift -0.016)
  Rare        8.98%  (target  9.00%, drift -0.018)
  Holo        4.00%  (target  4.00%, drift -0.004)
  Grail       0.98%  (target  1.00%, drift -0.019)

token id collisions: 0 of 1,200,000
OK - all checks passed
```

Gas, for capacity planning: `disperse` funds 120 wallets in **4.2M gas**, one
transaction.

---

## Notes

- `REVEAL_WINDOW` (200 blocks) sits strictly inside the 256-block `blockhash`
  horizon, so `revealPack` and `refundExpiredPack` are mutually exclusive: a
  sealed pack can always be either revealed or refunded, never neither.
- `blockhash`-based entropy is influenceable by a block proposer targeting a
  specific user. For production this becomes a VRF or a two-party commit–reveal.
  The latency argument — the thing Monad unlocks — is unchanged either way.
- Card art is generated procedurally from card names rather than shipping
  copyrighted scans.
