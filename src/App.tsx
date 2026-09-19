import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BaseError, encodeFunctionData, formatEther, type Address, type Hex } from 'viem'
import ripAbi from '../artifacts/RipCards.json'
import { CardArt } from './components/CardArt'
import { LatestPulls, OddsPanel, WhatsInside } from './components/sections'
import { TIER_NAMES } from './lib/catalogue'
import { drawPack } from './lib/draw'
import { useLive, waitForBlock, type Pull, type Stats } from './lib/live'
import {
  claimBurner,
  FALLBACK_GAS_PRICE,
  GAS,
  ripReserve,
  revealReserve,
  Signer,
  type AppConfig,
} from './lib/wallet'

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
    const b = await readBalance(address)
    if (b !== null) setBalance(b)
  }, [])

  /** Retires a spent burner and picks up a funded one from the pool. */
  const rotateBurner = useCallback(
    async (cfg: AppConfig): Promise<Signer> => {
      const fresh = new Signer(cfg, await claimBurner({ rotate: true }))
      setSigner(fresh)
      refreshBalance(fresh.address)
      return fresh
    },
    [refreshBalance],
  )

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

    const gasPrice = gasPriceOf(stats)
    const since = Date.now()

    // Demo mode rehearses the exact timing of a real rip - seal, wait for a
    // block that did not exist yet, reveal - without touching a chain.
    if (config.demo) {
      const started = performance.now()
      setPhase('sealing')
      await sleep(240)
      setPhase('sealed')
      await sleep(520)
      setPhase('ripping')
      await sleep(160)
      const pulls: Pull[] = drawPack(0.12).map((c, i) => ({
        ...c,
        tokenId: `${since}-${i}`,
        owner: signer.address,
        blockNumber: stats.block,
        txHash: ('0x' + '0'.repeat(64)) as Hex,
        at: Date.now(),
      }))
      setLatency(Math.round(performance.now() - started))
      setReveal(pulls)
      setCollection((prev) => [...pulls, ...prev])
      setPhase('revealed')
      return
    }

    let active = signer

    try {
      const sealedAt = performance.now()

      // A pack may already be sealed — from a reload, or because the indexer
      // dropped the tick that carried our own commit. The chain always knows,
      // so the button resumes rather than dead-ending on PackAlreadyPending.
      let pending = await readPending(active.address)

      // Monad takes the fee reserve at ADMISSION, so a burner that cannot
      // cover it is refused by the RPC before the transaction is looked at -
      // and the node reports that as a bare -32000, which viem relabels
      // "Missing or invalid parameters." Reading the balance first turns an
      // unreadable rejection into a wallet swap the user never has to think
      // about. Checking BOTH legs is the point: a wallet that affords the
      // commit but not the reveal seals a pack nothing can open again.
      const funds = await readBalance(active.address)
      const need = pending?.sealed
        ? revealReserve(gasPrice)
        : ripReserve(gasPrice, BigInt(config.packPrice))

      if (funds !== null && funds < need) {
        setPhase('sealing')
        active = await rotateBurner(config)
        pending = null
        const fresh = await readBalance(active.address)
        if (fresh !== null && fresh < ripReserve(gasPrice, BigInt(config.packPrice))) {
          throw new Error('the wallet pool is out of MON')
        }
      }

      let commitBlock: number
      if (pending?.sealed) {
        commitBlock = pending.commitBlock
        setPhase('sealed')
      } else {
        setPhase('sealing')
        await active.send({
          data: encodeFunctionData({ abi, functionName: 'buyPack' }),
          gas: GAS.buyPack,
          value: BigInt(config.packPrice),
          gasPrice,
        })
        commitBlock = await waitForCommit(active.address).catch(async () => {
          const p = await readPending(active.address)
          if (!p?.sealed) throw new Error('commit not indexed')
          return p.commitBlock as number
        })
        setPhase('sealed')
      }

      // The pack cannot be opened until a block exists that nobody could see
      // when it was sealed. The contract requires 2 blocks; we wait 3.
      //
      // The extra block is not caution about the entropy, it is about Monad's
      // reserve balance rule: an account holding less than the 10 MON reserve -
      // every burner in this room - gets one balance-dipping transaction per
      // 3-block window. Commit and reveal back to back inside that window is
      // how you collect a reserve balance violation on stage.
      await waitForBlock(statsRef, commitBlock + 3)

      setPhase('ripping')
      const tx = await active.send({
        data: encodeFunctionData({ abi, functionName: 'revealPack' }),
        gas: GAS.revealPack,
        gasPrice,
      })
      setLastTx(tx)

      const pulls = await waitForPulls(active.address, since)
      setLatency(Math.round(performance.now() - sealedAt))
      setReveal(pulls)
      setPhase('revealed')
      refreshBalance(active.address)
    } catch (e) {
      active.resetNonce()
      setError(friendlyError(e))
      setPhase('idle')
    }
  }, [signer, config, stats, refreshBalance, rotateBurner])

  const redeem = useCallback(
    async (pull: Pull) => {
      if (!signer || !stats || !config) return
      const ref = window.prompt(
        `Redeem ${pull.name} (${TIER_NAMES[pull.tier]}, PSA ${pull.grade}).\n\n` +
          `This burns the token. The physical card leaves the vault and ships to you.\n\n` +
          `Shipping reference:`,
      )
      if (!ref) return
      if (config.demo) {
        setCollection((c) => c.filter((p) => p.tokenId !== pull.tokenId))
        return
      }
      try {
        const tx = await signer.send({
          data: encodeFunctionData({
            abi,
            functionName: 'redeem',
            args: [BigInt(pull.tokenId), ref],
          }),
          gas: GAS.redeem,
          gasPrice: gasPriceOf(stats),
        })
        setLastTx(tx)
        setCollection((c) => c.filter((p) => p.tokenId !== pull.tokenId))
      } catch (e) {
        signer.resetNonce()
        setError(friendlyError(e))
      }
    },
    [signer, stats, config],
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
          <span className="brand-logo" aria-hidden="true" />
          <span className="brand-mark">Ripachu</span>
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
          <PackView phase={phase} onRip={rip} busy={busy} packPrice={packPrice} error={error} />
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

      {phase !== 'revealed' && (
        <>
          <WhatsInside />
          <LatestPulls feed={feed} />
          {config && (
            <OddsPanel
              explorer={config.explorer}
              contract={config.contract}
              catalogueRoot={config.catalogueRoot}
            />
          )}
        </>
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

/**
 * The pack art.
 *
 * Drawn, not photographed: a rift opening over a canopy, lit from inside. The
 * reference this follows is a foil TCG wrapper - full-bleed painted scene, a
 * chrome wordmark over it, light streaks across the whole thing - and the one
 * thing not carried over is its hue. Green is not on this app's rarity scale;
 * the scene is built from the Monad palette instead, driven by the --pack-*
 * tokens on .pack, so re-skinning it is an edit to those and nothing else.
 *
 * The scene only works if the sky stays bright. Every shape in front of it is
 * a silhouette, and a silhouette needs something luminous to be cut out of -
 * so the vignettes at top and bottom are kept just strong enough to seat the
 * crimps, and no stronger.
 *
 * Gradients only, no SVG filters. Ten of these render at once on the rail and
 * feGaussianBlur is the one thing that would make that cost anything.
 */
function PackArt() {
  return (
    <svg
      className="pack-art"
      viewBox="0 0 200 318"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="rp-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--pack-night)" />
          <stop offset="0.15" stopColor="var(--pack-deep)" />
          <stop offset="0.33" stopColor="var(--pack-sky)" />
          <stop offset="0.5" stopColor="var(--pack-horizon)" />
          <stop offset="0.63" stopColor="var(--pack-sky)" />
          <stop offset="0.82" stopColor="var(--pack-deep)" />
          <stop offset="1" stopColor="var(--pack-night)" />
        </linearGradient>

        {/* the rift - the whole scene is lit by this one source */}
        <radialGradient id="rp-rift" cx="0.5" cy="0.33" r="0.58">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.92" />
          <stop offset="0.17" stopColor="var(--pack-gem)" stopOpacity="0.88" />
          <stop offset="0.34" stopColor="var(--pack-horizon)" stopOpacity="0.44" />
          <stop offset="1" stopColor="var(--pack-sky)" stopOpacity="0" />
        </radialGradient>

        <linearGradient id="rp-shaft" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="0.5" stopColor="var(--pack-gem)" stopOpacity="0.09" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>

        <linearGradient id="rp-stone" x1="0" y1="0" x2="1" y2="0.25">
          <stop offset="0" stopColor="var(--pack-canopy)" />
          <stop offset="0.3" stopColor="var(--pack-stone)" />
          <stop offset="0.55" stopColor="var(--pack-horizon)" stopOpacity="0.85" />
          <stop offset="0.78" stopColor="var(--pack-stone)" />
          <stop offset="1" stopColor="var(--pack-canopy)" />
        </linearGradient>

        {/* just enough to seat the crimps - see the note above */}
        <linearGradient id="rp-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--pack-night)" stopOpacity="0" />
          <stop offset="1" stopColor="var(--pack-night)" stopOpacity="0.88" />
        </linearGradient>
        <linearGradient id="rp-roof" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--pack-night)" stopOpacity="0.85" />
          <stop offset="1" stopColor="var(--pack-night)" stopOpacity="0" />
        </linearGradient>

        {/* one leaf, one frond; the canopy is <use> of these at nine angles */}
        <path id="rp-leaf" d="M0 0C8-10 23-11 31-3 23 7 8 9 0 0Z" fill="currentColor" />
        <g id="rp-frond">
          <path
            d="M0 0C20 3 44 13 66 31"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <use href="#rp-leaf" transform="translate(3 0)rotate(-52)scale(.8)" />
          <use href="#rp-leaf" transform="translate(6 2)rotate(30)scale(.72)" />
          <use href="#rp-leaf" transform="translate(13 3)rotate(-44)scale(.9)" />
          <use href="#rp-leaf" transform="translate(16 5)rotate(36)scale(.8)" />
          <use href="#rp-leaf" transform="translate(25 7)rotate(-36)scale(.98)" />
          <use href="#rp-leaf" transform="translate(28 9)rotate(44)scale(.86)" />
          <use href="#rp-leaf" transform="translate(37 13)rotate(-28)scale(1)" />
          <use href="#rp-leaf" transform="translate(40 15)rotate(50)scale(.84)" />
          <use href="#rp-leaf" transform="translate(50 21)rotate(-20)scale(.9)" />
          <use href="#rp-leaf" transform="translate(53 23)rotate(58)scale(.74)" />
          <use href="#rp-leaf" transform="translate(63 30)rotate(14)scale(.72)" />
        </g>

        {/* the canopy in three passes: haze, rim, silhouette. The rim is the
            rift catching the top edge of a leaf, and it is the only reason a
            near-black mass reads as foliage rather than as a hole. */}
        <g id="rp-canopy">
          <g color="var(--pack-canopy-3)" opacity="0.5">
            <use href="#rp-frond" transform="translate(-26 -16)rotate(26)scale(1.85)" />
            <use href="#rp-frond" transform="translate(226 -18)rotate(154)scale(1.85)" />
            <use href="#rp-frond" transform="translate(-20 62)rotate(-14)scale(1.4)" />
            <use href="#rp-frond" transform="translate(220 70)rotate(194)scale(1.4)" />
            <use href="#rp-frond" transform="translate(-18 330)rotate(-58)scale(1.6)" />
            <use href="#rp-frond" transform="translate(218 326)rotate(238)scale(1.6)" />
          </g>
          <g color="var(--pack-gem)" opacity="0.55">
            <use href="#rp-frond" transform="translate(-15 -8)rotate(24)scale(1.54)" />
            <use href="#rp-frond" transform="translate(215 -10)rotate(156)scale(1.54)" />
            <use href="#rp-frond" transform="translate(-9 62)rotate(-16)scale(1.18)" />
            <use href="#rp-frond" transform="translate(209 68)rotate(196)scale(1.18)" />
            <use href="#rp-frond" transform="translate(-11 317)rotate(-58)scale(1.38)" />
            <use href="#rp-frond" transform="translate(209 313)rotate(238)scale(1.38)" />
          </g>
          <g color="var(--pack-canopy)">
            <use href="#rp-frond" transform="translate(-13 -4)rotate(24)scale(1.5)" />
            <use href="#rp-frond" transform="translate(213 -6)rotate(156)scale(1.5)" />
            <use href="#rp-frond" transform="translate(-7 66)rotate(-16)scale(1.15)" />
            <use href="#rp-frond" transform="translate(207 72)rotate(196)scale(1.15)" />
            <use href="#rp-frond" transform="translate(-9 320)rotate(-58)scale(1.35)" />
            <use href="#rp-frond" transform="translate(211 316)rotate(238)scale(1.35)" />
            <use href="#rp-frond" transform="translate(4 30)rotate(48)scale(.95)" />
            <use href="#rp-frond" transform="translate(196 36)rotate(132)scale(.95)" />
            <use href="#rp-frond" transform="translate(100 320)rotate(-108)scale(1.1)" />
          </g>
        </g>
      </defs>

      <rect width="200" height="318" fill="url(#rp-sky)" />
      <ellipse cx="100" cy="112" rx="108" ry="98" fill="url(#rp-rift)" />

      {/* light coming down through the gap in the canopy */}
      <g opacity="0.45">
        <path d="M94 6 106 6 126 212 76 212Z" fill="url(#rp-shaft)" />
        <path d="M64 0 74 0 54 206 30 200Z" fill="url(#rp-shaft)" opacity="0.55" />
        <path d="M130 0 140 0 172 198 146 206Z" fill="url(#rp-shaft)" opacity="0.55" />
      </g>

      {/* the far ridge, then the gate standing in front of it. The arch is
          one ring path - outer sweep out, inner sweep back - so the stone
          gradient runs continuously round it instead of breaking at the
          spring line where two separate shapes would meet. */}
      <path
        d="M0 194 26 166 48 184 74 150 100 176 126 148 154 182 176 164 200 190 200 226 0 226Z"
        fill="var(--pack-deep)"
        opacity="0.6"
      />
      <path d="M62 252 62 146A38 38 0 0 1 138 146L138 252Z" fill="var(--pack-gem)" opacity="0.17" />
      <path
        d="M42 252 42 146A58 58 0 0 1 158 146L158 252 138 252 138 146A38 38 0 0 0 62 146L62 252Z"
        fill="url(#rp-stone)"
      />
      <g fill="url(#rp-stone)">
        <path d="M34 264 166 264 158 250 42 250Z" />
        <path d="M26 276 174 276 168 264 32 264Z" />
      </g>
      <path
        d="M42 146A58 58 0 0 1 158 146M62 146A38 38 0 0 0 138 146M42 252 42 146M158 252 158 146"
        stroke="var(--pack-gem)"
        strokeWidth="1.3"
        opacity="0.5"
        fill="none"
      />

      {/* the rune the gem hangs inside */}
      <circle
        cx="100"
        cy="132"
        r="31"
        fill="none"
        stroke="var(--pack-rune)"
        strokeWidth="1.8"
        strokeDasharray="7 9"
        opacity="0.6"
      />
      <circle
        cx="100"
        cy="132"
        r="40"
        fill="none"
        stroke="var(--pack-rune)"
        strokeWidth="1"
        strokeDasharray="2 12"
        opacity="0.42"
      />

      <rect y="236" width="200" height="82" fill="url(#rp-floor)" />
      <rect width="200" height="74" fill="url(#rp-roof)" />

      <use href="#rp-canopy" />

      {/* vines, and leaves the rift has pulled loose */}
      <g fill="none" stroke="var(--pack-canopy)" strokeLinecap="round">
        <path d="M16 0C24 40 12 74 28 112 42 146 24 178 34 214" strokeWidth="2.6" />
        <path d="M184 0C176 44 190 78 174 116 160 150 178 182 168 214" strokeWidth="2.6" />
        <path d="M46 0C52 26 44 46 54 68" strokeWidth="1.8" opacity="0.7" />
      </g>
      <g color="var(--pack-gem)" opacity="0.62">
        <use href="#rp-leaf" transform="translate(46 60)rotate(-28)scale(.46)" />
        <use href="#rp-leaf" transform="translate(150 86)rotate(142)scale(.4)" />
        <use href="#rp-leaf" transform="translate(56 152)rotate(24)scale(.34)" />
        <use href="#rp-leaf" transform="translate(146 170)rotate(-158)scale(.42)" />
        <use href="#rp-leaf" transform="translate(82 42)rotate(196)scale(.3)" />
        <use href="#rp-leaf" transform="translate(126 190)rotate(-36)scale(.32)" />
      </g>
      <g fill="#ffffff" opacity="0.75">
        <circle cx="70" cy="84" r="1.3" />
        <circle cx="134" cy="68" r="1" />
        <circle cx="118" cy="132" r="1.5" />
        <circle cx="60" cy="118" r="0.9" />
        <circle cx="154" cy="124" r="1.2" />
        <circle cx="38" cy="150" r="1" />
        <circle cx="88" cy="160" r="1.1" />
      </g>
    </svg>
  )
}

/** One sealed pack. Sizing lives on the modifier so the face scales with it. */
function Pack({ variant, className = '' }: { variant: 'rail' | 'hero'; className?: string }) {
  return (
    <div className={`pack pack-${variant} ${className}`}>
      <PackArt />
      <div className="pack-gloss" />

      <div className="pack-face">
        <div className="pack-kicker">vaulted card gacha</div>
        {/* a faceted gem, not the Monad mark - the palette is theirs, the
            logo is not ours to stamp on a card product */}
        <svg className="pack-prism" viewBox="0 0 48 48" aria-hidden="true">
          <path d="M24 2 47 24 24 46 1 24Z" fill="rgba(255,255,255,0.16)" />
          <path d="M24 2 47 24 24 24Z" fill="rgba(255,255,255,0.38)" />
          <path d="M24 24 47 24 24 46Z" fill="rgba(255,255,255,0.08)" />
          <path d="M24 2 1 24 24 24Z" fill="rgba(255,255,255,0.26)" />
          <path
            d="M24 2 47 24 24 46 1 24Z"
            fill="none"
            stroke="rgba(255,255,255,0.7)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
        {/* Chrome. Two copies: the back one carries the stroke and the drop
            shadow, the front one carries the metal ramp clipped into the
            glyphs. One element cannot do both - background-clip:text needs a
            transparent fill, and a stroke over that hollows the letters out. */}
        <div className="pack-title">
          <span className="pack-title-shell" aria-hidden="true">
            Ripachu
          </span>
          <span className="pack-title-metal">Ripachu</span>
        </div>
        <div className="pack-meta">3 COLLECTIBLE GAME CARDS</div>
      </div>

      <div className="pack-crimp pack-crimp-top" />
      <div className="pack-crimp pack-crimp-bottom" />
      {/* foil sits over everything, wordmark included - that is what makes it
          read as a wrapper rather than as a printed box */}
      <div className="pack-foil" />
    </div>
  )
}

const RAIL_PACKS = 10

function PackView({
  phase,
  onRip,
  busy,
  packPrice,
  error,
}: {
  phase: Phase
  onRip: () => void
  busy: boolean
  packPrice: string
  error: string | null
}) {
  // Which pack is held up to the light. Picking one is a pure UI step - the
  // packs are identical, the draw happens onchain - but it is the step that
  // makes the choice feel like yours.
  const [selected, setSelected] = useState<number | null>(null)

  const caption =
    phase === 'sealing'
      ? 'sealing the pack'
      : phase === 'sealed'
        ? 'waiting for a block nobody has seen'
        : phase === 'ripping'
          ? 'ripping'
          : 'three cards · published odds · onchain draw'

  // a failed rip has to be readable, and the overlay sits on top of the notice
  useEffect(() => {
    if (error) setSelected(null)
  }, [error])

  useEffect(() => {
    if (selected === null || busy) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, busy])

  return (
    <div className="packview">
      <h1 className="sr-only">Ripachu Pack</h1>
      <div className="rail">
        {Array.from({ length: RAIL_PACKS }, (_, i) => (
          <button
            key={i}
            className={`rail-item${selected === i ? ' rail-item-on' : ''}`}
            onClick={() => setSelected(i)}
            aria-label={`Pack ${i + 1}`}
          >
            <Pack variant="rail" />
          </button>
        ))}
      </div>

      <div className="packinfo">
        <div className="packinfo-price">
          <span className="coin">MON</span>
          <span className="packinfo-amount">{packPrice}</span>
        </div>

        <button className="cta cta-open" onClick={() => setSelected(0)} disabled={busy}>
          Open a pack
        </button>
      </div>

      {selected !== null && (
        <div
          className="overlay"
          onClick={() => {
            if (!busy) setSelected(null)
          }}
        >
          <div className="overlay-inner" onClick={(e) => e.stopPropagation()}>
            <Pack
              variant="hero"
              className={`${busy ? 'pack-busy' : ''} ${phase === 'sealed' ? 'pack-sealed' : ''}`}
            />

            <button className="cta cta-open" onClick={onRip} disabled={busy}>
              {busy ? <span className="spin" /> : 'Open'}
            </button>

            <p className="caption">{caption}</p>

            {!busy && (
              <button className="overlay-back" onClick={() => setSelected(null)}>
                pick another pack
              </button>
            )}
          </div>
        </div>
      )}
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The stream publishes '0' until the indexer's first tick lands. */
function gasPriceOf(stats: Stats): bigint {
  return stats.gasPrice && stats.gasPrice !== '0' ? BigInt(stats.gasPrice) : FALLBACK_GAS_PRICE
}

/**
 * The burner's balance, or null when the server could not read the chain.
 *
 * Null means "unknown", and every caller treats it that way. Rotating a wallet
 * on a number we do not trust would retire a funded burner over an RPC hiccup.
 */
async function readBalance(address: Address): Promise<bigint | null> {
  try {
    const r = await (await fetch(`/api/balance/${address}`)).json()
    return r.stale ? null : BigInt(r.balance)
  } catch {
    return null
  }
}

async function readPending(
  address: Address,
): Promise<{ sealed: boolean; commitBlock: number } | null> {
  try {
    const r = await fetch(`/api/pending/${address}`)
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

/**
 * What actually went wrong, in the node's own words.
 *
 * viem folds every -32000 a node returns into InvalidInputRpcError, whose
 * message opens with "Missing or invalid parameters." That is the line the
 * user was left reading while the real reason - "Signer had insufficient
 * balance" - sat one field away in `details`. Read the cause, not the headline.
 */
function causeOf(e: unknown): string {
  if (e instanceof BaseError) return e.details || e.walk()?.message || e.shortMessage
  return (e as Error)?.message ?? String(e)
}

function friendlyError(e: unknown): string {
  const m = causeOf(e)
  // Monad's own wordings, which match none of the usual Ethereum phrasings:
  // it says "Signer had insufficient balance", not "insufficient funds".
  if (/insufficient (funds|balance)/i.test(m)) {
    return 'this wallet is out of MON — tap open again for a fresh one'
  }
  if (/fee too low|gas limit too low|exceeds transaction gas limit/i.test(m)) {
    return 'the network repriced mid-rip — tap open again'
  }
  if (/pool exhausted|pool is out of MON/i.test(m)) {
    return 'every funded burner is claimed — top the pool up'
  }
  if (/PackAlreadyPending/i.test(m)) return 'a pack is already sealed — reveal it first'
  if (/RevealTooEarly/i.test(m)) return 'too early, the fairness block has not landed yet'
  if (/RevealExpired/i.test(m)) return 'the reveal window closed — refund available'
  if (/rate limit|429|-32007/i.test(m)) return 'the RPC is rate limiting — try again in a second'
  return m.split('\n')[0].slice(0, 160)
}
