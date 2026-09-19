import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { encodeFunctionData, formatEther, type Address, type Hex } from 'viem'
import ripAbi from '../artifacts/RipCards.json'
import { CardArt } from './components/CardArt'
import { TIER_NAMES } from './lib/catalogue'
import { useLive, waitForBlock, type Pull, type Stats } from './lib/live'
import { claimBurner, GAS, Signer, type AppConfig } from './lib/wallet'

const abi = ripAbi.abi

type Phase = 'boot' | 'idle' | 'sealing' | 'sealed' | 'ripping' | 'revealed' | 'error'

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [signer, setSigner] = useState<Signer | null>(null)
  const [balance, setBalance] = useState<bigint>(0n)
  const [phase, setPhase] = useState<Phase>('boot')
  const [error, setError] = useState<string | null>(null)
  const [reveal, setReveal] = useState<Pull[]>([])
  const [collection, setCollection] = useState<Pull[]>([])
  const [latency, setLatency] = useState<number | null>(null)
  const [lastTx, setLastTx] = useState<Hex | null>(null)

  const { feed, stats, connected, commits, commitTick } = useLive()

  const statsRef = useRef<Stats | null>(null)
  statsRef.current = stats
  const commitTickRef = useRef(0)
  commitTickRef.current = commitTick
  const feedRef = useRef<Pull[]>([])
  feedRef.current = feed

  // --- boot ---------------------------------------------------------------

  useEffect(() => {
    ;(async () => {
      try {
        const cfg: AppConfig = await (await fetch('/api/config')).json()
        setConfig(cfg)
        const burner = await claimBurner()
        setSigner(new Signer(cfg, burner))
        setPhase('idle')
      } catch (e) {
        setError((e as Error).message)
        setPhase('error')
      }
    })()
  }, [])

  const refreshBalance = useCallback(async (address: Address) => {
    try {
      const r = await (await fetch(`/api/balance/${address}`)).json()
      setBalance(BigInt(r.balance))
    } catch {
      /* the gauge is cosmetic; never block a rip on it */
    }
  }, [])

  useEffect(() => {
    if (signer) refreshBalance(signer.address)
  }, [signer, refreshBalance])

  // keep the personal collection in sync with whatever the indexer has seen
  useEffect(() => {
    if (!signer) return
    const mine = feed.filter((p) => p.owner.toLowerCase() === signer.address.toLowerCase())
    if (mine.length) {
      setCollection((prev) => {
        const seen = new Set(prev.map((p) => p.tokenId))
        const add = mine.filter((p) => !seen.has(p.tokenId))
        return add.length ? [...add, ...prev] : prev
      })
    }
  }, [feed, signer])

  // --- the rip ------------------------------------------------------------

  const waitForCommit = (address: string, timeoutMs = 20_000) =>
    new Promise<number>((resolve, reject) => {
      const started = Date.now()
      const check = () => {
        const hit = commits.current.find((c) => c.buyer === address.toLowerCase())
        if (hit) {
          commits.current = commits.current.filter((c) => c !== hit)
          return resolve(hit.commitBlock)
        }
        if (Date.now() - started > timeoutMs) return reject(new Error('commit not indexed'))
        setTimeout(check, 100)
      }
      check()
    })

  const waitForPulls = (address: string, since: number, timeoutMs = 25_000) =>
    new Promise<Pull[]>((resolve, reject) => {
      const started = Date.now()
      const check = () => {
        const mine = feedRef.current.filter(
          (p) => p.owner.toLowerCase() === address.toLowerCase() && p.at >= since,
        )
        if (mine.length >= 3) return resolve(mine.slice(0, 3).reverse())
        if (Date.now() - started > timeoutMs) {
          return mine.length ? resolve(mine.reverse()) : reject(new Error('reveal not indexed'))
        }
        setTimeout(check, 100)
      }
      check()
    })

  const rip = useCallback(async () => {
    if (!signer || !config || !stats) return
    setError(null)
    setReveal([])
    setLatency(null)

    const gasPrice = BigInt(stats.gasPrice || '50000000000')
    const since = Date.now()

    try {
      setPhase('sealing')
      const sealedAt = performance.now()
      await signer.send({
        data: encodeFunctionData({ abi, functionName: 'buyPack' }),
        gas: GAS.buyPack,
        value: BigInt(config.packPrice),
        gasPrice,
      })

      const commitBlock = await waitForCommit(signer.address)
      setPhase('sealed')

      // The pack cannot be opened until a block exists that nobody could see
      // when it was sealed. This is the whole fairness guarantee, and on Monad
      // it costs about 800ms.
      await waitForBlock(statsRef, commitBlock + 2)

      setPhase('ripping')
      const tx = await signer.send({
        data: encodeFunctionData({ abi, functionName: 'revealPack' }),
        gas: GAS.revealPack,
        gasPrice,
      })
      setLastTx(tx)

      const pulls = await waitForPulls(signer.address, since)
      setLatency(Math.round(performance.now() - sealedAt))
      setReveal(pulls)
      setPhase('revealed')
      refreshBalance(signer.address)
    } catch (e) {
      signer.resetNonce()
      setError(friendlyError(e as Error))
      setPhase('idle')
    }
  }, [signer, config, stats, refreshBalance])

  const redeem = useCallback(
    async (pull: Pull) => {
      if (!signer || !stats) return
      const ref = window.prompt(
        `Redeem ${pull.name} (${TIER_NAMES[pull.tier]}, PSA ${pull.grade}).\n\n` +
          `This burns the token. The physical card leaves the vault and ships to you.\n\n` +
          `Shipping reference:`,
      )
      if (!ref) return
      try {
        const tx = await signer.send({
          data: encodeFunctionData({
            abi,
            functionName: 'redeem',
            args: [BigInt(pull.tokenId), ref],
          }),
          gas: GAS.redeem,
          gasPrice: BigInt(stats.gasPrice || '50000000000'),
        })
        setLastTx(tx)
        setCollection((c) => c.filter((p) => p.tokenId !== pull.tokenId))
      } catch (e) {
        signer.resetNonce()
        setError(friendlyError(e as Error))
      }
    },
    [signer, stats],
  )

  const busy = phase === 'sealing' || phase === 'sealed' || phase === 'ripping'
  const packPrice = config ? formatEther(BigInt(config.packPrice)) : '-'
  const vaultedCount = useMemo(() => collection.filter((c) => c.vaultRef > 0).length, [collection])

  if (phase === 'boot') return <Boot />
  if (phase === 'error' && !config) return <Fatal message={error ?? 'unknown error'} />

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brand-mark">RIP</span>
          <span className="brand-sub">vaulted card gacha</span>
        </div>
        <div className="top-right">
          <div className="chip">
            <span className="chip-k">balance</span>
            <span className="chip-v">{Number(formatEther(balance)).toFixed(3)} MON</span>
          </div>
          <div className={`dot ${connected ? 'on' : 'off'}`} title={connected ? 'live' : 'reconnecting'} />
        </div>
      </header>

      <main className="stage">
        {phase === 'revealed' && reveal.length > 0 ? (
          <RevealView
            pulls={reveal}
            latency={latency}
            explorer={config!.explorer}
            txHash={lastTx}
            onAgain={() => {
              setPhase('idle')
              setReveal([])
            }}
          />
        ) : (
          <PackView phase={phase} onRip={rip} busy={busy} packPrice={packPrice} />
        )}

        {error && <p className="err">{error}</p>}
      </main>

      {collection.length > 0 && phase !== 'revealed' && (
        <section className="collection">
          <h2>
            your cards <span className="muted">{collection.length}</span>
            {vaultedCount > 0 && <span className="pill">{vaultedCount} redeemable</span>}
          </h2>
          <div className="grid">
            {collection.map((p) => (
              <div key={p.tokenId} className="grid-item">
                <CardArt {...p} size="sm" />
                {p.vaultRef > 0 && (
                  <button className="redeem" onClick={() => redeem(p)}>
                    redeem physical
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="foot">
        <span>
          {stats ? `${stats.txTotal.toLocaleString()} tx` : '-'} · {stats?.tps.toFixed(1) ?? '0.0'} tps
        </span>
        <span>block {stats?.block.toLocaleString() ?? '-'}</span>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------

function PackView({
  phase,
  onRip,
  busy,
  packPrice,
}: {
  phase: Phase
  onRip: () => void
  busy: boolean
  packPrice: string
}) {
  const caption =
    phase === 'sealing'
      ? 'sealing the pack'
      : phase === 'sealed'
        ? 'waiting for a block nobody has seen'
        : phase === 'ripping'
          ? 'ripping'
          : 'three cards, published odds, onchain draw'

  return (
    <div className="packview">
      <div className={`pack ${busy ? 'pack-busy' : ''} ${phase === 'sealed' ? 'pack-sealed' : ''}`}>
        <div className="pack-face">
          <div className="pack-title">RIP</div>
          <div className="pack-meta">3 CARDS</div>
        </div>
        <div className="pack-shine" />
      </div>

      <p className="caption">{caption}</p>

      <button className="cta" onClick={onRip} disabled={busy}>
        {busy ? <span className="spin" /> : <>rip a pack · {packPrice} MON</>}
      </button>

      <ol className="how">
        <li>
          <b>buy</b> seals the pack — the randomness does not exist yet
        </li>
        <li>
          <b>~800 ms</b> later a new block appears
        </li>
        <li>
          <b>reveal</b> draws against that block. Nobody could have known it.
        </li>
      </ol>
    </div>
  )
}

function RevealView({
  pulls,
  latency,
  explorer,
  txHash,
  onAgain,
}: {
  pulls: Pull[]
  latency: number | null
  explorer: string
  txHash: Hex | null
  onAgain: () => void
}) {
  const best = pulls.reduce((a, b) => (b.tier > a.tier ? b : a), pulls[0])
  return (
    <div className="reveal">
      <div className="reveal-head">
        <span className={`tier-tag tier-${best.tier}`}>{TIER_NAMES[best.tier]}</span>
        {latency !== null && (
          <span className="latency">
            sealed → ripped in <b>{latency} ms</b>
          </span>
        )}
      </div>

      <div className="reveal-cards">
        {pulls.map((p, i) => (
          <div key={p.tokenId} className="reveal-card" style={{ animationDelay: `${i * 140}ms` }}>
            <CardArt {...p} size="lg" />
          </div>
        ))}
      </div>

      <div className="reveal-actions">
        <button className="cta" onClick={onAgain}>
          rip another
        </button>
        {txHash && (
          <a className="link" href={`${explorer}/tx/${txHash}`} target="_blank" rel="noreferrer">
            verify onchain
          </a>
        )}
      </div>
    </div>
  )
}

function Boot() {
  return (
    <div className="boot">
      <div className="spin big" />
      <p>claiming a wallet</p>
    </div>
  )
}

function Fatal({ message }: { message: string }) {
  return (
    <div className="boot">
      <h1>cannot start</h1>
      <p className="err">{message}</p>
    </div>
  )
}

function friendlyError(e: Error): string {
  const m = e.message ?? String(e)
  if (/insufficient funds/i.test(m)) return 'this wallet is out of MON — grab a fresh one'
  if (/PackAlreadyPending/i.test(m)) return 'a pack is already sealed — reveal it first'
  if (/RevealTooEarly/i.test(m)) return 'too early, the fairness block has not landed yet'
  if (/RevealExpired/i.test(m)) return 'the reveal window closed — refund available'
  if (/pool exhausted/i.test(m)) return 'every burner wallet is claimed'
  if (/rate limit|429/i.test(m)) return 'the RPC is rate limiting — try again in a second'
  return m.split('\n')[0].slice(0, 160)
}
