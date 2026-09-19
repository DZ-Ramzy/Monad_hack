import { cardDef, cardImage } from '../lib/catalogue'

/**
 * The card, and nothing around it.
 *
 * The image is the actual scan of the actual printing - `base1-4` is the Base
 * Set Charizard, illustrated by Mitsuhiro Arita, and that is what you see. The
 * scans ship from `public/cards` (see public/cards/SOURCE.md).
 *
 * This used to draw a graded slab around that scan - a grade block, a cert
 * line, a label carrying the set symbol, a foot with the comp - because a
 * graded card is what gets traded. It is gone. At the size these actually
 * render the chrome and the art were competing for the same hundred pixels,
 * and the card is the subject. None of that data is lost: the grade and the
 * vault reference live on the token, and the pulls list still prints them.
 *
 * The one mark kept is the vault tag, because a redeemable card is a different
 * object from a plain pull and the grid has to say which is which.
 */

export interface CardArtProps {
  name: string
  set: string
  tier: number
  /** Index within the tier - this is what resolves the scan. */
  cardIndex: number
  vaultRef?: number
  size?: 'sm' | 'md' | 'lg'
  /**
   * Callers spread a whole Pull into this component, so these still arrive.
   * They are no longer drawn on the card itself.
   */
  grade?: number
  serial?: number
  marketRaw?: number
}

export function CardArt({ name, set, tier, cardIndex, vaultRef = 0, size = 'md' }: CardArtProps) {
  const def = cardDef(tier, cardIndex)
  const vaulted = vaultRef > 0

  return (
    <div className={`pcard pcard-${size} tier-${tier}${vaulted ? ' pcard-vaulted' : ''}`}>
      <img
        className="pcard-scan"
        src={cardImage(def, size === 'lg' ? 'lg' : 'sm')}
        alt={`${name}, ${set} #${def.number}`}
        loading="lazy"
        draggable={false}
      />

      {vaulted && (
        <div className="pcard-vault-tag" title={`Vault item #${vaultRef}`}>
          VAULTED
        </div>
      )}
    </div>
  )
}
