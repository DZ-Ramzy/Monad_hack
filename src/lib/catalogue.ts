import { keccak256, toHex } from 'viem'
import raw from './catalogue.data.json'

/**
 * The card table.
 *
 * Every card in here is a real printing. Names, sets, card numbers, rarities,
 * artists and scans come from the pokemontcg.io card database; prices are
 * TCGplayer market prices for that exact printing. Nothing is invented, and
 * nothing is filled in when the data is missing - `scripts/fetch-catalogue.ts`
 * refuses to write a card it cannot source. Re-run it with `pnpm catalogue:fetch`.
 *
 * The contract stores only (tier, cardIndex, grade, serial). What card index 7
 * of tier 4 actually *is* lives here - but the contract commits to
 * `catalogueRoot`, the keccak256 of the canonical serialisation below, at
 * deploy time. The app therefore cannot quietly redefine a card after the
 * fact, and anyone can recompute the root and check it against the chain.
 */

export const TIER_NAMES = ['Common', 'Uncommon', 'Rare', 'Holo', 'Grail'] as const

/** Cumulative weights out of 10_000, commonest first. Published onchain. */
export const ODDS_CUMULATIVE = [6000, 8600, 9500, 9900, 10000] as const

/** Per-tier probability, for display. */
export const TIER_PROBABILITY = ODDS_CUMULATIVE.map(
  (c, i) => (c - (i === 0 ? 0 : ODDS_CUMULATIVE[i - 1])) / 100,
)

export interface CardDef {
  /** pokemontcg.io identifier, e.g. `base1-4`. Pins the exact printing. */
  id: string
  /** Card name as it is printed. */
  name: string
  /** Set it was printed in. */
  set: string
  setId: string
  /** Collector number within the set. */
  number: string
  year: number
  /** Rarity as printed on the card - this is what puts it in its tier. */
  rarity: string
  artist: string
  /** The TCGplayer printing the price belongs to, e.g. `1st Edition Holofoil`. */
  printing: string
  /**
   * Raw, ungraded TCGplayer market price in USD for this printing, as of
   * `CATALOGUE_SOURCE.fetchedAt`.
   *
   * This is a RAW price. It is deliberately not adjusted for the grade on the
   * slab: a graded multiple is a number we would have to invent, and a made-up
   * multiplier on a real card is still a made-up number. The grade is shown
   * next to it and left to the reader.
   */
  marketRaw: number
  /** Filename under /cards. */
  image: string
  /** Full-size scan, only carried for the tiers that render large. */
  imageLarge?: string
  /** Set symbol, shared by every card of that set. */
  symbol?: string
}

interface CatalogueData {
  source: string
  priceSource: string
  fetchedAt: string
  tiers: CardDef[][]
}

const data = raw as CatalogueData

export const CATALOGUE: CardDef[][] = data.tiers

/** Where the numbers on screen come from, so the UI can say so out loud. */
export const CATALOGUE_SOURCE = {
  cards: data.source,
  prices: data.priceSource,
  fetchedAt: data.fetchedAt,
}

export const TIER_SIZES = CATALOGUE.map((t) => t.length) as [
  number,
  number,
  number,
  number,
  number,
]

export function cardDef(tier: number, cardIndex: number): CardDef {
  const t = CATALOGUE[tier] ?? CATALOGUE[0]
  return t[cardIndex % t.length]
}

/** Path to a card's scan. Falls back to the small scan where no large one ships. */
export function cardImage(def: CardDef, size: 'sm' | 'lg' = 'sm'): string {
  return `/cards/${size === 'lg' ? (def.imageLarge ?? def.image) : def.image}`
}

export function setSymbol(def: CardDef): string | undefined {
  return def.symbol ? `/cards/${def.symbol}` : undefined
}

/**
 * Canonical serialisation, hashed into `catalogueRoot` onchain.
 *
 * Identity only: which card sits at which index. Field order is fixed here on
 * purpose - changing it changes the root.
 *
 * Price is deliberately NOT in here. What the contract needs to be pinned to is
 * *which card* index 7 of tier 4 is, and that never changes. A market price
 * does change, constantly, and hashing it would mean every price refresh
 * invalidated a live deployment - which in practice would mean nobody ever
 * refreshes the price, and the number on screen quietly goes stale instead.
 */
export function canonicalCatalogue(): string {
  return JSON.stringify(
    CATALOGUE.map((tier) =>
      tier.map((c) => [c.id, c.name, c.set, c.number, c.year] as const),
    ),
  )
}

export function catalogueRoot(): `0x${string}` {
  return keccak256(toHex(canonicalCatalogue()))
}

/** Raw market value of a specific card, in USD. See CardDef.marketRaw. */
export function marketRaw(tier: number, cardIndex: number): number {
  return cardDef(tier, cardIndex).marketRaw
}
