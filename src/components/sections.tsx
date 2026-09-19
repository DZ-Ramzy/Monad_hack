import { CATALOGUE, TIER_NAMES } from '../lib/catalogue'
import type { Pull } from '../lib/live'
import { CardArt } from './CardArt'

/**
 * The page under the pack.
 *
 * A gacha page has to answer two questions before anyone spends: what is in the
 * set, and what is coming out of it right now. The set is shown whole - one
 * grid, every card, no rarity partition - because splitting it into strips made
 * the page read as five short lists instead of one collection. The rarity is
 * still legible card-by-card in the tier colour each slab carries.
 */

/**
 * Every card in the set, in catalogue order, carrying the tier it was drawn
 * from. `cardIndex` stays the index *within* its tier - that pair is what
 * resolves a scan, so it cannot be flattened away.
 */
const ALL_CARDS = CATALOGUE.flatMap((cards, tier) =>
  cards.map((card, cardIndex) => ({ card, tier, cardIndex })),
)

export function WhatsInside() {
  return (
    <section className="sec">
      <h2 className="sec-head">
        What&rsquo;s inside?
        <span className="sec-count">{ALL_CARDS.length} cards</span>
      </h2>

      <div className="cardgrid">
        {ALL_CARDS.map(({ card, tier, cardIndex }, i) => (
          <CardArt
            key={card.id}
            name={card.name}
            set={card.set}
            tier={tier}
            cardIndex={cardIndex}
            grade={9}
            serial={i + 1}
            marketRaw={card.marketRaw}
            size="sm"
          />
        ))}
      </div>
    </section>
  )
}

export function LatestPulls({ feed }: { feed: Pull[] }) {
  const shown = feed.slice(0, 12)

  return (
    <section className="sec">
      <h2 className="sec-head">
        Latest pulls
        {shown.length > 0 && <span className="sec-count">{shown.length}</span>}
      </h2>
      {shown.length === 0 ? (
        <p className="sec-empty">nothing pulled yet — be the first</p>
      ) : (
        <div className="pulls">
          {shown.map((p) => (
            <div key={p.tokenId} className={`row tier-${p.tier}`}>
              <span className="row-addr">
                {p.owner.slice(0, 6)}…{p.owner.slice(-4)}
              </span>
              <span className="row-name">{p.name}</span>
              <span className="row-set">{p.set}</span>
              <span className="row-grade">PSA {p.grade}</span>
              <span className={`row-tier tier-tag tier-${p.tier}`}>{TIER_NAMES[p.tier]}</span>
              {p.vaultRef > 0 && <span className="row-vault">VAULTED</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
