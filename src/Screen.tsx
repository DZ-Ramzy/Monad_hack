import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { CardArt } from './components/CardArt'
import { TIER_NAMES } from './lib/catalogue'
import { useLive } from './lib/live'

/**
 * The projector view.
 *
 * This is the pitch. It has to make two things obvious from the back of the
 * room: that the transactions are real and landing constantly, and that the
 * cards being pulled are backed by physical stock.
 */
export default function Screen() {
  const { feed, stats, connected } = useLive()
  const [qr, setQr] = useState<string>('')
  const [peak, setPeak] = useState(0)
  const peakRef = useRef(0)

  useEffect(() => {
    QRCode.toDataURL(window.location.origin, {
      width: 640,
      margin: 1,
      color: { dark: '#0E100F', light: '#FBFAF9' },
    }).then(setQr)
  }, [])

  useEffect(() => {
    if (stats && stats.tps > peakRef.current) {
      peakRef.current = stats.tps
      setPeak(stats.tps)
    }
  }, [stats])

  const grails = feed.filter((p) => p.tier >= 3).slice(0, 5)

  return (
    <div className="screen">
      <header className="screen-top">
        <div className="brand">
          <span className="brand-mark">Ripachu</span>
          <span className="brand-sub">provably fair gacha · vaulted cards · monad</span>
        </div>
        <div className={`dot ${connected ? 'on' : 'off'}`} />
      </header>

      <div className="screen-body">
        <aside className="screen-join">
          {qr && <img className="qr" src={qr} alt="Join" />}
          <div className="join-text">
            <div className="join-big">scan to rip</div>
            <div className="join-small">no wallet, no install</div>
          </div>
          <div className="pool">
            {stats ? `${stats.poolClaimed}/${stats.poolSize}` : '-'} wallets claimed
          </div>
        </aside>

        <section className="screen-metrics">
          <Metric
            label="transactions"
            value={stats?.txTotal.toLocaleString() ?? '0'}
            hint="commit + reveal + redeem"
          />
          <Metric
            label="throughput"
            value={stats ? stats.tps.toFixed(1) : '0.0'}
            unit="tps"
            hint={`peak ${peak.toFixed(1)}`}
            accent
          />
          <Metric
            label="block time"
            value={stats?.blockTimeMs ? String(stats.blockTimeMs) : '400'}
            unit="ms"
            hint={`block ${stats?.block.toLocaleString() ?? '-'}`}
          />
          <Metric
            label="rippers"
            value={stats?.uniqueRippers.toLocaleString() ?? '0'}
            hint={`${stats?.packsRevealed.toLocaleString() ?? 0} packs opened`}
          />
          <Metric
            label="vaulted pulls"
            value={stats?.vaultedPulls.toLocaleString() ?? '0'}
            hint="backed by physical stock"
            accent
          />
          <Metric
            label="redeemed"
            value={stats?.redemptions.toLocaleString() ?? '0'}
            hint="burned & shipped"
          />
        </section>
      </div>

      {grails.length > 0 && (
        <section className="screen-grails">
          {grails.map((p) => (
            <CardArt key={p.tokenId} {...p} size="md" />
          ))}
        </section>
      )}

      <section className="screen-feed">
        {feed.slice(0, 14).map((p) => (
          <div key={p.tokenId} className={`row tier-${p.tier}`}>
            <span className="row-addr">{p.owner.slice(0, 6)}…{p.owner.slice(-4)}</span>
            <span className="row-name">{p.name}</span>
            <span className="row-set">{p.set}</span>
            <span className="row-grade">PSA {p.grade}</span>
            <span className={`row-tier tier-tag tier-${p.tier}`}>{TIER_NAMES[p.tier]}</span>
            {p.vaultRef > 0 && <span className="row-vault">VAULTED</span>}
          </div>
        ))}
      </section>
    </div>
  )
}

function Metric({
  label,
  value,
  unit,
  hint,
  accent,
}: {
  label: string
  value: string
  unit?: string
  hint?: string
  accent?: boolean
}) {
  return (
    <div className={`metric${accent ? ' metric-accent' : ''}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      {hint && <div className="metric-hint">{hint}</div>}
    </div>
  )
}
