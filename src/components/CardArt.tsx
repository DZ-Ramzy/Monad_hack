import { cardDef, cardImage, setSymbol } from '../lib/catalogue'

/**
 * A graded slab, holding the real card.
 *
 * The window is the actual scan of the actual printing - `base1-4` is the Base
 * Set Charizard, illustrated by Mitsuhiro Arita, and that is what you see. The
 * scans ship from `public/cards` (see public/cards/SOURCE.md); everything
 * printed on the label - name, set, collector number, rarity, printing - is the
 * card's own data, not ours.
 *
 * The chrome around it is the part we draw: the grade block, the cert line and
 * the label, laid out the way a slab actually is, because that is what a graded
 * card is traded as. From Holo up a sheen crosses the window - that is the
 * light off the case, and it is kept deliberately weak so it never becomes the
 * subject. The card is the subject.
 */

const GRADE_LABEL: Record<number, string> = {
  10: 'GEM MINT',
  9: 'MINT',
  8: 'NM-MT',
  7: 'NEAR MINT',
}

export interface CardArtProps {
  name: string
  set: string
  tier: number
  /** Index within the tier - this is what resolves the scan. */
  cardIndex: number
  grade: number
  serial: number
  vaultRef?: number
  /** Raw TCGplayer market price, USD. */
  marketRaw?: number
  size?: 'sm' | 'md' | 'lg'
}

export function CardArt({
  name,
  set,
  tier,
  cardIndex,
  grade,
  serial,
  vaultRef = 0,
  marketRaw,
  size = 'md',
}: CardArtProps) {
  const def = cardDef(tier, cardIndex)
  const vaulted = vaultRef > 0
  const symbol = setSymbol(def)

  return (
    <div className={`slab slab-${size} tier-${tier}${vaulted ? ' slab-vaulted' : ''}`}>
      <div className="slab-label">
        <div className="slab-grade">
          <span className="slab-grade-num">{grade}</span>
          <span className="slab-grade-text">{GRADE_LABEL[grade] ?? 'GRADED'}</span>
        </div>
        <div className="slab-ident">
          <div className="slab-name">{name}</div>
          <div className="slab-set">
            {set} &middot; #{def.number}
          </div>
        </div>
        {symbol && <img className="slab-symbol" src={symbol} alt="" loading="lazy" />}
      </div>

      <div className="slab-window">
        <img
          className="slab-scan"
          src={cardImage(def, size === 'lg' ? 'lg' : 'sm')}
          alt={`${name}, ${set} #${def.number}`}
          loading="lazy"
          draggable={false}
        />

        {vaulted && (
          <div className="slab-vault-tag" title={`Vault item #${vaultRef}`}>
            VAULTED
          </div>
        )}
      </div>

      <div className="slab-foot">
        <span className="slab-serial">#{String(serial).padStart(4, '0')}</span>
        <span className="slab-printing" title={`${def.rarity} — ${def.printing}`}>
          {def.printing}
        </span>
        {marketRaw !== undefined && (
          <span className="slab-comp" title="Raw TCGplayer market price, ungraded">
            ${marketRaw.toLocaleString()}
          </span>
        )}
      </div>
    </div>
  )
}
