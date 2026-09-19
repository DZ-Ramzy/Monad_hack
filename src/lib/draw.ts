import { CATALOGUE, ODDS_CUMULATIVE, TIER_SIZES, cardDef, compValue } from './catalogue'

/**
 * The draw logic of RipCards, in TypeScript.
 *
 * Used by demo mode to rehearse the pitch without spending testnet MON, and by
 * the offchain odds test. It mirrors the contract deliberately: same cumulative
 * weights, same grade bands. If the two ever disagree, the odds test is what
 * catches it.
 */

export interface DrawnCard {
  tier: number
  cardIndex: number
  grade: number
  serial: number
  vaultRef: number
  name: string
  set: string
  comp: number
}

export function drawTier(roll: number): number {
  for (let i = 0; i < ODDS_CUMULATIVE.length; i++) {
    if (roll < ODDS_CUMULATIVE[i]) return i
  }
  return ODDS_CUMULATIVE.length - 1
}

export function gradeFor(roll: number, tier: number): number {
  const bump = tier * 8
  if (roll + bump >= 92) return 10
  if (roll + bump >= 70) return 9
  if (roll + bump >= 35) return 8
  return 7
}

/** One random card, following the published odds. */
export function drawCard(vaultedChance = 0): DrawnCard {
  const tier = drawTier(Math.floor(Math.random() * 10_000))
  const cardIndex = Math.floor(Math.random() * TIER_SIZES[tier])
  const grade = gradeFor(Math.floor(Math.random() * 100), tier)
  const def = cardDef(tier, cardIndex)
  return {
    tier,
    cardIndex,
    grade,
    serial: Math.floor(Math.random() * 10_000) + 1,
    vaultRef: Math.random() < vaultedChance ? 1 + Math.floor(Math.random() * 3) : 0,
    name: def.name,
    set: def.set,
    comp: compValue(tier, cardIndex, grade),
  }
}

export function drawPack(vaultedChance = 0): DrawnCard[] {
  return Array.from({ length: 3 }, () => drawCard(vaultedChance))
}

export const CATALOGUE_SIZE = CATALOGUE.reduce((n, t) => n + t.length, 0)
