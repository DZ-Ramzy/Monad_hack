import { CATALOGUE, TIER_NAMES, TIER_PROBABILITY } from '../lib/catalogue'
import type { Pull } from '../lib/live'
import { CardArt } from './CardArt'

/**
 * The page under the pack.
 *
 * A gacha page has to answer three questions before anyone spends: what is in
 * the set, what is coming out of it right now, and what the odds actually are.
 * The third one is where this differs from every other pack site - the odds are
 * not a claim in a footer, they are the weights the contract draws against, and
 * the catalogue they refer to is committed to onchain.
 */

export function WhatsInside() {
  return (
    <section className="sec">
      <h2 className="sec-head">What&rsquo;s inside?</h2>
      {CATALOGUE.map((cards, tier) => (
        <div key={tier} className="tierstrip">
          <div className="tierstrip-head">
            <span className={`tier-tag tier-${tier}`}>{TIER_NAMES[tier]}</span>
            <span className="tierstrip-odds">{TIER_PROBABILITY[tier].toFixed(2)}%</span>
            <span className="tierstrip-count">{cards.length} cards</span>
          </div>
          <div className="tierstrip-rail">
            {cards.map((c, i) => (
              <CardArt
                key={c.id}
                name={c.name}
                set={c.set}
                tier={tier}
                cardIndex={i}
                grade={9}
                serial={i + 1}
                marketRaw={c.marketRaw}
                size="sm"
              />
            ))}
          </div>
        </div>
      ))}
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

export function OddsPanel({
  explorer,
  contract,
  catalogueRoot,
}: {
  explorer: string
  contract: string
  catalogueRoot: string
}) {
  return (
    <section className="sec">
      <details className="odds">
        <summary className="sec-head">Statistics &amp; odds</summary>

        <div className="odds-bars">
          {TIER_NAMES.map((name, tier) => (
            <div key={name} className="odds-row">
              <span className={`odds-name tier-tag tier-${tier}`}>{name}</span>
              <span className="odds-bar">
                <span
                  className={`odds-fill tier-${tier}`}
                  style={{ width: `${Math.max(TIER_PROBABILITY[tier], 0.6)}%` }}
                />
              </span>
              <span className="odds-pct">{TIER_PROBABILITY[tier].toFixed(2)}%</span>
            </div>
          ))}
        </div>

        {/* The odds above are worth nothing if the card table can be swapped
            after the fact. It cannot: the contract holds this hash. */}
        <div className="odds-proof">
          <div className="odds-proof-k">catalogue root, committed onchain</div>
          <code className="odds-proof-v">{catalogueRoot}</code>
          <a className="link" href={`${explorer}/address/${contract}`} target="_blank" rel="noreferrer">
            read it from the contract
          </a>
        </div>
      </details>
    </section>
  )
}
