/**
 * Mirrors the draw logic of RipCards in TypeScript and samples it.
 *
 * This is not a substitute for an onchain test, but it catches the two bugs
 * that would actually surface on stage: an off-by-one in the cumulative-odds
 * loop, and a card or tier that can never be drawn. It reproduces the exact
 * keccak chain the contract uses, so a mismatch here is a real mismatch.
 */
import { keccak256, encodePacked, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  CATALOGUE,
  ODDS_CUMULATIVE,
  TIER_SIZES,
  TIER_NAMES,
  TIER_PROBABILITY,
  cardDef,
} from '../src/lib/catalogue.js'

const TIERS = 5
const CARDS_PER_PACK = 3
const MASK256 = (1n << 256n) - 1n

function draw(r: bigint): { tier: number; cardIndex: number } {
  const roll = r % 10_000n
  let tier = TIERS - 1
  for (let i = 0; i < TIERS; i++) {
    if (roll < BigInt(ODDS_CUMULATIVE[i])) {
      tier = i
      break
    }
  }
  const size = BigInt(TIER_SIZES[tier])
  const cardIndex = Number(((r >> 32n) & MASK256) % (size === 0n ? 1n : size))
  return { tier, cardIndex }
}

function grade(r: bigint, tier: number): number {
  const roll = Number(r % 100n)
  const bump = tier * 8
  if (roll + bump >= 92) return 10
  if (roll + bump >= 70) return 9
  if (roll + bump >= 35) return 8
  return 7
}

function packSeed(entropy: Hex, buyer: Hex, packNonce: bigint): bigint {
  return BigInt(
    keccak256(encodePacked(['bytes32', 'address', 'uint64'], [entropy, buyer, packNonce])),
  )
}

// ---------------------------------------------------------------------------

const PACKS = Number(process.env.PACKS ?? 400_000)
const buyers = Array.from({ length: 64 }, (_, i) =>
  privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, '0')}` as Hex).address,
)

const tierCounts = new Array(TIERS).fill(0)
const gradeCounts: Record<number, number> = { 7: 0, 8: 0, 9: 0, 10: 0 }
const cardSeen = CATALOGUE.map((t) => new Array(t.length).fill(0))
const tokenIds = new Set<string>()
let cards = 0

for (let p = 0; p < PACKS; p++) {
  const entropy = keccak256(encodePacked(['uint256'], [BigInt(p)]))
  const buyer = buyers[p % buyers.length] as Hex
  const nonce = BigInt(Math.floor(p / buyers.length))
  const seed = packSeed(entropy, buyer, nonce)

  for (let i = 0; i < CARDS_PER_PACK; i++) {
    const r = BigInt(keccak256(encodePacked(['uint256', 'uint256'], [seed, BigInt(i)])))
    const { tier, cardIndex } = draw(r)
    const g = grade((r >> 96n) & MASK256, tier)

    tierCounts[tier]++
    gradeCounts[g]++
    cardSeen[tier][cardIndex]++
    cards++

    tokenIds.add(keccak256(encodePacked(['address', 'uint64', 'uint256'], [buyer, nonce, BigInt(i)])))
  }
}

let failures = 0
const fail = (msg: string) => {
  console.error(`  FAIL  ${msg}`)
  failures++
}

console.log(`sampled ${PACKS.toLocaleString()} packs = ${cards.toLocaleString()} cards\n`)

console.log('tier distribution')
for (let t = 0; t < TIERS; t++) {
  const actual = (tierCounts[t] / cards) * 100
  const expected = TIER_PROBABILITY[t]
  const drift = actual - expected
  const bar = '#'.repeat(Math.max(1, Math.round(actual / 2)))
  console.log(
    `  ${TIER_NAMES[t].padEnd(9)} ${actual.toFixed(2).padStart(6)}%  (target ${expected
      .toFixed(2)
      .padStart(5)}%, drift ${drift >= 0 ? '+' : ''}${drift.toFixed(3)})  ${bar}`,
  )
  if (tierCounts[t] === 0) fail(`tier ${TIER_NAMES[t]} is unreachable`)
  else if (Math.abs(drift) > 0.5) fail(`tier ${TIER_NAMES[t]} drifts ${drift.toFixed(3)}pp from target`)
}

console.log('\ngrade distribution')
for (const g of [7, 8, 9, 10]) {
  const pct = (gradeCounts[g] / cards) * 100
  console.log(`  PSA ${String(g).padEnd(2)}    ${pct.toFixed(2).padStart(6)}%`)
  if (gradeCounts[g] === 0) fail(`grade PSA ${g} is unreachable`)
}

console.log('\ncard coverage')
for (let t = 0; t < TIERS; t++) {
  const unseen = cardSeen[t].map((n, i) => (n === 0 ? i : -1)).filter((i) => i >= 0)
  const min = Math.min(...cardSeen[t])
  const max = Math.max(...cardSeen[t])
  const spread = max === 0 ? 0 : (max - min) / max
  console.log(
    `  ${TIER_NAMES[t].padEnd(9)} ${cardSeen[t].length} cards, all drawn: ${
      unseen.length === 0 ? 'yes' : 'NO'
    }, spread ${(spread * 100).toFixed(1)}%`,
  )
  for (const i of unseen) fail(`${TIER_NAMES[t]} card "${cardDef(t, i).name}" never drawn`)
  if (spread > 0.15) fail(`${TIER_NAMES[t]} card frequencies are uneven (${(spread * 100).toFixed(1)}%)`)
}

const expectedIds = PACKS * CARDS_PER_PACK
console.log(`\ntoken id collisions: ${expectedIds - tokenIds.size} of ${expectedIds.toLocaleString()}`)
if (tokenIds.size !== expectedIds) fail('derived token ids collided')

const grail = cardSeen[4].reduce((a, b) => a + b, 0)
console.log(`grail pulls: ${grail.toLocaleString()} (1 per ${Math.round(cards / grail)} cards)`)

console.log(failures === 0 ? '\nOK - all checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
