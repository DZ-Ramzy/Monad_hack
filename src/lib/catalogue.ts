import { keccak256, toHex } from 'viem'

/**
 * The card table.
 *
 * The contract stores only (tier, cardIndex, grade, serial). What card index 7
 * of tier 4 actually *is* lives here — but the contract commits to
 * `catalogueRoot`, the keccak256 of the canonical serialisation below, at
 * deploy time. The app therefore cannot quietly redefine a card after the
 * fact, and anyone can recompute the root and check it against the chain.
 *
 * Card art is generated procedurally from the card name (see CardArt) rather
 * than shipping copyrighted scans.
 */

export type Tier = 0 | 1 | 2 | 3 | 4

export const TIER_NAMES = ['Common', 'Uncommon', 'Rare', 'Holo', 'Grail'] as const

/** Cumulative weights out of 10_000, commonest first. Published onchain. */
export const ODDS_CUMULATIVE = [6000, 8600, 9500, 9900, 10000] as const

/** Per-tier probability, for display. */
export const TIER_PROBABILITY = ODDS_CUMULATIVE.map(
  (c, i) => (c - (i === 0 ? 0 : ODDS_CUMULATIVE[i - 1])) / 100,
)

export interface CardDef {
  /** Card name as it appears on the slab. */
  name: string
  /** Set it was printed in. */
  set: string
  year: number
  /** Indicative market comp in USD for a PSA 9, used for the floor display. */
  comp: number
}

export const CATALOGUE: CardDef[][] = [
  // --- Tier 0 : Common -----------------------------------------------------
  [
    { name: 'Rattata', set: 'Base Set', year: 1999, comp: 8 },
    { name: 'Caterpie', set: 'Base Set', year: 1999, comp: 9 },
    { name: 'Weedle', set: 'Base Set', year: 1999, comp: 9 },
    { name: 'Pidgey', set: 'Base Set', year: 1999, comp: 10 },
    { name: 'Magikarp', set: 'Base Set', year: 1999, comp: 14 },
    { name: 'Voltorb', set: 'Base Set', year: 1999, comp: 11 },
    { name: 'Diglett', set: 'Base Set', year: 1999, comp: 10 },
    { name: 'Machop', set: 'Base Set', year: 1999, comp: 12 },
    { name: 'Bellsprout', set: 'Jungle', year: 1999, comp: 9 },
    { name: 'Tangela', set: 'Jungle', year: 1999, comp: 11 },
    { name: 'Meowth', set: 'Jungle', year: 1999, comp: 13 },
    { name: 'Psyduck', set: 'Fossil', year: 1999, comp: 12 },
  ],
  // --- Tier 1 : Uncommon ---------------------------------------------------
  [
    { name: 'Charmeleon', set: 'Base Set', year: 1999, comp: 45 },
    { name: 'Wartortle', set: 'Base Set', year: 1999, comp: 40 },
    { name: 'Ivysaur', set: 'Base Set', year: 1999, comp: 42 },
    { name: 'Kadabra', set: 'Base Set', year: 1999, comp: 38 },
    { name: 'Haunter', set: 'Fossil', year: 1999, comp: 48 },
    { name: 'Electabuzz', set: 'Base Set', year: 1999, comp: 44 },
    { name: 'Dragonair', set: 'Base Set', year: 1999, comp: 60 },
    { name: 'Scyther', set: 'Jungle', year: 1999, comp: 65 },
    { name: 'Pinsir', set: 'Jungle', year: 1999, comp: 52 },
    { name: 'Lapras', set: 'Fossil', year: 1999, comp: 58 },
  ],
  // --- Tier 2 : Rare -------------------------------------------------------
  [
    { name: 'Gyarados', set: 'Base Set', year: 1999, comp: 210 },
    { name: 'Alakazam', set: 'Base Set', year: 1999, comp: 240 },
    { name: 'Machamp', set: 'Base Set', year: 1999, comp: 180 },
    { name: 'Zapdos', set: 'Base Set', year: 1999, comp: 320 },
    { name: 'Articuno', set: 'Fossil', year: 1999, comp: 290 },
    { name: 'Moltres', set: 'Fossil', year: 1999, comp: 275 },
    { name: 'Snorlax', set: 'Jungle', year: 1999, comp: 260 },
    { name: 'Dragonite', set: 'Fossil', year: 1999, comp: 310 },
  ],
  // --- Tier 3 : Holo -------------------------------------------------------
  [
    { name: 'Venusaur', set: 'Base Set', year: 1999, comp: 900 },
    { name: 'Blastoise', set: 'Base Set', year: 1999, comp: 1200 },
    { name: 'Mewtwo', set: 'Base Set', year: 1999, comp: 850 },
    { name: 'Raichu', set: 'Base Set', year: 1999, comp: 780 },
    { name: 'Mew', set: 'Black Star Promo', year: 1999, comp: 1100 },
    { name: 'Gengar', set: 'Fossil', year: 1999, comp: 820 },
  ],
  // --- Tier 4 : Grail ------------------------------------------------------
  [
    { name: 'Charizard', set: 'Base Set Shadowless', year: 1999, comp: 14000 },
    { name: 'Pikachu Illustrator', set: 'CoroCoro Promo', year: 1998, comp: 375000 },
    { name: 'Blastoise', set: 'Base Set 1st Edition', year: 1999, comp: 22000 },
    { name: 'Charizard', set: 'Base Set 1st Edition', year: 1999, comp: 62000 },
  ],
]

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

/**
 * Canonical serialisation, hashed into `catalogueRoot` onchain.
 * Field order is fixed here on purpose — changing it changes the root.
 */
export function canonicalCatalogue(): string {
  return JSON.stringify(
    CATALOGUE.map((tier) =>
      tier.map((c) => [c.name, c.set, c.year, c.comp] as const),
    ),
  )
}

export function catalogueRoot(): `0x${string}` {
  return keccak256(toHex(canonicalCatalogue()))
}

/** Indicative USD value of a specific pull, scaled by its grade. */
export function compValue(tier: number, cardIndex: number, grade: number): number {
  const base = cardDef(tier, cardIndex).comp
  const gradeMultiplier: Record<number, number> = { 7: 0.35, 8: 0.6, 9: 1, 10: 3.2 }
  return Math.round(base * (gradeMultiplier[grade] ?? 1))
}
