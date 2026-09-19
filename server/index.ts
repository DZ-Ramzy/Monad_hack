/**
 * The room-facing server.
 *
 * Two jobs, both of which exist to keep the public RPC from being the thing
 * that kills the demo:
 *
 *   1. ONE indexer. Eighty phones polling the RPC for logs would earn eighty
 *      429s. Instead this process is the only reader; browsers subscribe over
 *      SSE and never read the chain at all. They only ever WRITE, signing
 *      locally and broadcasting their own transactions.
 *
 *   2. Burner handout. Wallets are generated and funded ahead of time; a phone
 *      claims an unused key. No funding transaction is ever sent while the room
 *      is watching.
 */
import 'dotenv/config'
import express from 'express'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  encodePacked,
  formatEther,
  keccak256,
  parseAbiItem,
  type Address,
  type Hex,
} from 'viem'
import { publicClient, chain, rpcUrl, EXPLORER, withRetry } from '../src/lib/chain.js'
import {
  CATALOGUE,
  CATALOGUE_SOURCE,
  TIER_NAMES,
  TIER_SIZES,
  ODDS_CUMULATIVE,
  cardDef,
} from '../src/lib/catalogue.js'
import { drawPack } from '../src/lib/draw.js'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))

const PORT = Number(process.env.PORT ?? 3000)
const CLAIMED_FILE = join(root, '.claimed.json')

// ---------------------------------------------------------------------------
// Deployment + wallet pool
// ---------------------------------------------------------------------------

/**
 * Demo mode: run the whole surface without a deployment.
 *
 * Useful for rehearsing the pitch without spending testnet MON, and for
 * working on the UI before the contract is live. Nothing here touches a chain -
 * the feed is synthesised from the same published odds the contract uses, and
 * the client simulates the rip locally.
 */
const DEMO = process.env.DEMO === '1' || !existsSync(join(root, 'deployments.json'))

if (DEMO && !existsSync(join(root, 'deployments.json'))) {
  console.warn('no deployments.json - starting in DEMO mode (nothing is onchain)\n')
}

const deployment = existsSync(join(root, 'deployments.json'))
  ? readJson('deployments.json')
  : {
      chainId: chain.id,
      packPrice: '1000000000000000',
      catalogueRoot: '0x' + '00'.repeat(32),
      contracts: { RipCards: '0x0000000000000000000000000000000000000000' },
    }
const contractAddress = deployment.contracts.RipCards as Address
const RIP_ABI = existsSync(join(root, 'artifacts/RipCards.json'))
  ? readJson('artifacts/RipCards.json').abi
  : []

/**
 * The burner pool.
 *
 * wallets.json is seventy funded private keys, which is exactly why it is
 * gitignored and never reaches a host that way. A deployed server is handed
 * the same JSON base64-encoded in WALLETS_B64 instead: decoded here at boot,
 * held in memory, never written to disk.
 */
function loadPool(): { privateKey: Hex; address: Address }[] {
  const b64 = process.env.WALLETS_B64
  if (b64) {
    try {
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).wallets
    } catch (e) {
      console.error('WALLETS_B64 is set but could not be decoded:', (e as Error).message)
      process.exit(1)
    }
  }
  return existsSync(join(root, 'wallets.json')) ? readJson('wallets.json').wallets : []
}

const pool = loadPool()

let claimed: Record<string, number> = existsSync(CLAIMED_FILE) ? readJson('.claimed.json') : {}
/**
 * Best effort. A hosted container has an ephemeral and sometimes read-only
 * disk; losing this file costs a re-handout after a restart, but throwing here
 * would take down the one endpoint a phone needs to get into the demo at all.
 */
const persistClaimed = () => {
  try {
    writeFileSync(CLAIMED_FILE, JSON.stringify(claimed))
  } catch (e) {
    console.warn('could not persist .claimed.json:', (e as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Live state, derived entirely from logs
// ---------------------------------------------------------------------------

interface Pull {
  tokenId: string
  owner: Address
  tier: number
  cardIndex: number
  grade: number
  serial: number
  vaultRef: number
  name: string
  set: string
  /** Raw TCGplayer market price, USD. */
  marketRaw: number
  blockNumber: number
  txHash: Hex
  at: number
}

const feed: Pull[] = []
const FEED_MAX = 60

/**
 * Per-address deck cache for /api/cards. Declared here rather than beside its
 * route because the indexer invalidates it: a wallet that just revealed a pack
 * must not be served the deck it had three seconds ago.
 */
const cardsCache = new Map<string, { value: unknown[]; at: number }>()
/** Transaction timestamps in a rolling window, for the live throughput gauge. */
let txTimes: number[] = []
const stats = {
  packsCommitted: 0,
  packsRevealed: 0,
  cardsMinted: 0,
  vaultedPulls: 0,
  redemptions: 0,
  uniqueRippers: new Set<string>(),
  grails: 0,
  block: 0,
  lastBlockAt: 0,
  blockTimeMs: 0,
  /** Published to clients so a phone never has to call eth_gasPrice itself. */
  gasPrice: '0',
}

const pub = publicClient()

const evCommitted = parseAbiItem(
  'event PackCommitted(address indexed buyer, uint64 indexed packNonce, uint64 commitBlock)',
)
const evMinted = parseAbiItem(
  'event CardMinted(uint256 indexed tokenId, address indexed owner, uint8 indexed tier, uint16 cardIndex, uint8 grade, uint32 serial, uint32 vaultRef)',
)
const evRevealed = parseAbiItem(
  'event PackRevealed(address indexed buyer, uint64 indexed packNonce, bytes32 entropy, uint256[] tokenIds)',
)
const evRedeemed = parseAbiItem(
  'event Redeemed(uint32 indexed vaultRef, uint256 indexed tokenId, address indexed holder, string shippingRef)',
)

// ---------------------------------------------------------------------------
// SSE fan-out
// ---------------------------------------------------------------------------

type Client = { id: number; res: express.Response }
const clients: Client[] = []
let clientSeq = 0

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of clients) c.res.write(payload)
}

function snapshot() {
  const now = Date.now()
  const window = txTimes.filter((t) => now - t < 10_000)
  return {
    ...stats,
    uniqueRippers: stats.uniqueRippers.size,
    tps: window.length / 10,
    txTotal: stats.packsCommitted + stats.packsRevealed + stats.redemptions,
    poolClaimed: Object.keys(claimed).length,
    poolSize: pool.length,
  }
}

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

let cursor = 0n
let indexerErrors = 0

/**
 * The public Monad RPC caps eth_getLogs at a 100 block range. Asking for more
 * returns an error, not a truncated result - so a naive wide backfill fails
 * every tick, the cursor never advances, and the feed stays silently empty.
 */
const LOG_SPAN = 90n

async function tick() {
  try {
    const head = await pub.getBlockNumber()
    if (stats.block !== 0 && head > BigInt(stats.block)) {
      const now = Date.now()
      if (stats.lastBlockAt) {
        stats.blockTimeMs = Math.round(
          (now - stats.lastBlockAt) / Number(head - BigInt(stats.block)),
        )
      }
      stats.lastBlockAt = now
    }
    stats.block = Number(head)
    if (stats.gasPrice === '0' || Number(head) % 20 === 0) {
      stats.gasPrice = (await pub.getGasPrice()).toString()
    }
    if (cursor === 0n) cursor = head > LOG_SPAN ? head - LOG_SPAN : 0n
    if (head < cursor) return

    // never ask for more than the RPC will serve, and catch up over several
    // ticks if we have fallen behind
    const toBlock = head - cursor >= LOG_SPAN ? cursor + LOG_SPAN - 1n : head

    const logs = await pub.getLogs({
      address: contractAddress,
      events: [evCommitted, evMinted, evRevealed, evRedeemed],
      fromBlock: cursor,
      toBlock,
    })

    const fresh: Pull[] = []
    for (const log of logs) {
      const name = (log as { eventName?: string }).eventName
      const args = (log as { args?: Record<string, unknown> }).args ?? {}

      if (name === 'PackCommitted') {
        stats.packsCommitted++
        stats.uniqueRippers.add(String(args.buyer).toLowerCase())
        txTimes.push(Date.now())
        // Browsers never read the chain. They learn that their own pack is
        // ripe from this broadcast, matching on their own address.
        broadcast('committed', {
          buyer: String(args.buyer).toLowerCase(),
          packNonce: String(args.packNonce),
          commitBlock: Number(args.commitBlock),
        })
      } else if (name === 'PackRevealed') {
        stats.packsRevealed++
        txTimes.push(Date.now())
      } else if (name === 'Redeemed') {
        stats.redemptions++
        txTimes.push(Date.now())
        // redeem burns the token, so the holder's deck is one card shorter
        cardsCache.delete(String(args.holder).toLowerCase())
        broadcast('redeemed', {
          vaultRef: Number(args.vaultRef),
          tokenId: String(args.tokenId),
          holder: args.holder,
          shippingRef: args.shippingRef,
          txHash: log.transactionHash,
        })
      } else if (name === 'CardMinted') {
        const tier = Number(args.tier)
        const cardIndex = Number(args.cardIndex)
        const grade = Number(args.grade)
        const vaultRef = Number(args.vaultRef)
        const def = cardDef(tier, cardIndex)
        stats.cardsMinted++
        if (vaultRef > 0) stats.vaultedPulls++
        if (tier === 4) stats.grails++
        // This owner's deck just changed, so drop the cached copy. Without
        // this, a client reconciling right after its own reveal is handed the
        // pre-reveal deck and the new cards look like they never landed.
        cardsCache.delete(String(args.owner).toLowerCase())
        fresh.push({
          tokenId: String(args.tokenId),
          owner: args.owner as Address,
          tier,
          cardIndex,
          grade,
          serial: Number(args.serial),
          vaultRef,
          name: def.name,
          set: def.set,
          marketRaw: def.marketRaw,
          blockNumber: Number(log.blockNumber),
          txHash: log.transactionHash!,
          at: Date.now(),
        })
      }
    }

    if (fresh.length) {
      feed.unshift(...fresh.reverse())
      feed.length = Math.min(feed.length, FEED_MAX)
      broadcast('pulls', fresh)
    }

    const cutoff = Date.now() - 10_000
    if (txTimes.length > 2000) txTimes = txTimes.filter((t) => t > cutoff)

    cursor = toBlock + 1n
  } catch (err) {
    // The public RPC rate limits and occasionally drops a request. A missed
    // tick is harmless - the cursor has not advanced, so the next one refetches
    // the same range. But a tick that fails EVERY time means the feed is dead,
    // and a silently empty screen during a pitch is the worst way to find out.
    indexerErrors++
    if (indexerErrors <= 3 || indexerErrors % 50 === 0) {
      console.warn(`indexer tick failed (${indexerErrors}):`, String((err as Error).message).slice(0, 140))
    }
  }
}

// ---------------------------------------------------------------------------
// Demo feed - synthesised from the same published odds the contract uses
// ---------------------------------------------------------------------------

function demoTick() {
  const now = Date.now()
  stats.block += Math.random() < 0.9 ? 1 : 2
  stats.blockTimeMs = 380 + Math.round(Math.random() * 60)
  stats.gasPrice = '102000000000'

  const rippers = 1 + Math.floor(Math.random() * 3)
  const fresh: Pull[] = []

  for (let r = 0; r < rippers; r++) {
    const owner = ('0x' +
      Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(
        '',
      )) as Address
    stats.uniqueRippers.add(owner)
    stats.packsCommitted++
    stats.packsRevealed++
    txTimes.push(now, now)

    for (const c of drawPack(0.1)) {
      stats.cardsMinted++
      if (c.vaultRef > 0) stats.vaultedPulls++
      if (c.tier === 4) stats.grails++
      fresh.push({
        ...c,
        tokenId: String(Math.floor(Math.random() * 1e15)),
        owner,
        blockNumber: stats.block,
        txHash: ('0x' + '0'.repeat(64)) as Hex,
        at: now,
      })
    }
  }

  feed.unshift(...fresh.reverse())
  feed.length = Math.min(feed.length, FEED_MAX)
  broadcast('pulls', fresh)

  const cutoff = now - 10_000
  if (txTimes.length > 2000) txTimes = txTimes.filter((t) => t > cutoff)
}

if (DEMO) {
  stats.block = 63_865_582
  for (let i = 0; i < 6; i++) demoTick() // start with a populated screen
  setInterval(demoTick, 420)
} else {
  setInterval(tick, 500)
}
setInterval(() => broadcast('stats', snapshot()), 1000)

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json())

/**
 * CORS, and only when asked for.
 *
 * The default deployment puts a static host in front that rewrites /api/* to
 * here, which is same-origin from the browser's point of view and needs none
 * of this. ALLOWED_ORIGIN is for the other shape - the page calling this
 * server's origin directly - and is an explicit allowlist rather than a
 * blanket '*', because /api/claim hands out funded private keys.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

if (ALLOWED_ORIGINS.length) {
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })
  console.log(`cors allowed      ${ALLOWED_ORIGINS.join(', ')}`)
}

app.get('/api/config', (_req, res) => {
  res.json({
    demo: DEMO,
    chainId: chain.id,
    rpcUrl: rpcUrl(),
    explorer: EXPLORER,
    contract: contractAddress,
    packPrice: deployment.packPrice,
    catalogueRoot: deployment.catalogueRoot,
    catalogue: CATALOGUE,
    catalogueSource: CATALOGUE_SOURCE,
    tierNames: TIER_NAMES,
    tierSizes: TIER_SIZES,
    odds: ODDS_CUMULATIVE,
  })
})

app.post('/api/claim', (req, res) => {
  if (DEMO && pool.length === 0) {
    const privateKey = generatePrivateKey()
    return res.json({ privateKey, address: privateKeyToAccount(privateKey).address, demo: true })
  }
  const existing = req.body?.address as string | undefined
  // A phone rotates when its burner can no longer cover a rip. The spent
  // wallet keeps its entry in `claimed` - that is what keeps its pool index
  // out of `taken`, so it is never handed to the next person in the room.
  const rotate = req.body?.rotate === true
  if (!rotate && existing && claimed[existing.toLowerCase()] !== undefined) {
    const w = pool[claimed[existing.toLowerCase()]]
    if (w) return res.json({ privateKey: w.privateKey, address: w.address, reused: true })
  }
  const taken = new Set(Object.values(claimed))
  const idx = pool.findIndex((_, i) => !taken.has(i))
  if (idx === -1) return res.status(503).json({ error: 'pool exhausted' })

  const w = pool[idx]
  claimed[w.address.toLowerCase()] = idx
  persistClaimed()
  res.json({ privateKey: w.privateKey, address: w.address, reused: false })
})

app.get('/api/feed', (_req, res) => res.json({ feed, stats: snapshot() }))

/**
 * Balance lookup on behalf of the browser, cached, so that a room full of
 * phones does not turn into a room full of eth_getBalance calls.
 */
const balanceCache = new Map<string, { value: string; at: number }>()

app.get('/api/balance/:address', async (req, res) => {
  if (DEMO) return res.json({ balance: '5000000000000000000' })
  const address = req.params.address.toLowerCase() as Address
  const hit = balanceCache.get(address)
  if (hit && Date.now() - hit.at < 3000) return res.json({ balance: hit.value })
  try {
    const value = (await pub.getBalance({ address })).toString()
    balanceCache.set(address, { value, at: Date.now() })
    res.json({ balance: value })
  } catch {
    // The browser decides whether to rotate wallets on this number. A failed
    // read must be flagged, not dressed up as a zero - that would retire a
    // perfectly good burner every time the RPC hiccups.
    res.json({ balance: hit?.value ?? '0', stale: true })
  }
})

/**
 * Recovery path. If a phone misses its own PackCommitted broadcast - one
 * dropped indexer tick is enough - it would otherwise sit on a sealed pack
 * with no way to open it. The chain always knows, so ask the chain.
 */
app.get('/api/pending/:address', async (req, res) => {
  if (DEMO) return res.json({ sealed: false, commitBlock: 0, packsBought: 0, revealable: false, cards: 0 })
  try {
    const [commitBlock, packsBought, revealable, balance] = (await pub.readContract({
      address: contractAddress,
      abi: readJson('artifacts/RipCards.json').abi,
      functionName: 'userState',
      args: [req.params.address as Address],
    })) as [bigint, bigint, boolean, bigint]
    res.json({
      commitBlock: Number(commitBlock),
      packsBought: Number(packsBought),
      revealable,
      cards: Number(balance),
      sealed: commitBlock !== 0n,
    })
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
})

/**
 * The cards an address actually owns, read from the chain.
 *
 * This is what makes a deck survive a reload: until now the grid was derived
 * purely from the live feed, which is the last 60 pulls in the ROOM. Reload,
 * and your cards were simply gone - not moved, not sold, just never looked
 * up.
 *
 * There is no ERC721Enumerable here, but there does not need to be. Token ids
 * are `keccak256(buyer, packNonce, slot)` and nothing about that needs a node:
 *
 *   buyPack sets packNonce = packsBought, then stores packsBought + 1
 *   revealPack mints slots 0..2 under that same nonce
 *
 * so the ids a wallet can possibly own are exactly nonces 0..packsBought-1
 * across three slots, computed locally for zero RPC calls. The chain is then
 * asked one question about each: who owns it now.
 *
 * Every failure mode collapses into the same answer. A sealed-but-unrevealed
 * pack has no token yet; a pack that expired and was refunded leaves a gap in
 * the nonces (refundExpiredPack clears the commit but keeps the counter); a
 * redeemed card is burned. All three make ownerOf revert, and `allowFailure`
 * turns that into "not in the deck" without a special case.
 *
 * ownerOf is the filter, deliberately - _burn zeroes the owner but leaves
 * card[tokenId] populated, so filtering on cardOf would keep redeemed cards in
 * the grid with a live redeem button on them.
 *
 * Cost: two RPC round trips regardless of deck size.
 */
const CARDS_PER_PACK = 3
/** Ids per multicall. A bot wallet holds hundreds; one giant eth_call would hit the gas cap. */
const OWNER_BATCH = 50

app.get('/api/cards/:address', async (req, res) => {
  if (DEMO) return res.json({ cards: [] })
  const address = req.params.address.toLowerCase() as Address

  const hit = cardsCache.get(address)
  if (hit && Date.now() - hit.at < 3000) return res.json({ cards: hit.value })

  try {
    const [, packsBought] = (await withRetry(() =>
      pub.readContract({
        address: contractAddress,
        abi: RIP_ABI,
        functionName: 'userState',
        args: [address],
      }),
    )) as [bigint, bigint, boolean, bigint]

    const ids: bigint[] = []
    for (let nonce = 0n; nonce < packsBought; nonce++) {
      for (let slot = 0n; slot < BigInt(CARDS_PER_PACK); slot++) {
        ids.push(
          BigInt(keccak256(encodePacked(['address', 'uint64', 'uint256'], [address, nonce, slot]))),
        )
      }
    }
    if (!ids.length) {
      cardsCache.set(address, { value: [], at: Date.now() })
      return res.json({ cards: [] })
    }

    const cards: Pull[] = []
    for (let i = 0; i < ids.length; i += OWNER_BATCH) {
      const chunk = ids.slice(i, i + OWNER_BATCH)
      // The ABI is read from JSON at runtime, so viem cannot infer per-call
      // result types here. The shape is still checked where it is destructured.
      type MulticallResult =
        | { status: 'success'; result: unknown }
        | { status: 'failure'; error: unknown }
      const results = (await withRetry(() =>
        pub.multicall({
          allowFailure: true,
          contracts: chunk.flatMap((tokenId) => [
            { address: contractAddress, abi: RIP_ABI, functionName: 'ownerOf', args: [tokenId] },
            { address: contractAddress, abi: RIP_ABI, functionName: 'cardOf', args: [tokenId] },
          ]),
        } as never),
      )) as unknown as MulticallResult[]

      chunk.forEach((tokenId, k) => {
        const owner = results[k * 2]
        const meta = results[k * 2 + 1]
        if (owner?.status !== 'success' || meta?.status !== 'success') return
        if (String(owner.result).toLowerCase() !== address) return

        const [tier, cardIndex, grade, serial, mintedAt, vaultRef] = meta.result as [
          number, number, number, number, bigint, number,
        ]
        const def = cardDef(Number(tier), Number(cardIndex))
        cards.push({
          tokenId: String(tokenId),
          owner: address,
          tier: Number(tier),
          cardIndex: Number(cardIndex),
          grade: Number(grade),
          serial: Number(serial),
          vaultRef: Number(vaultRef),
          name: def.name,
          set: def.set,
          marketRaw: def.marketRaw,
          // A chain read carries no log, so there is no block or tx to cite.
          // The same sentinel demo mode already uses, rather than widening Pull.
          blockNumber: 0,
          txHash: ('0x' + '0'.repeat(64)) as Hex,
          at: Number(mintedAt) * 1000,
        })
      })
    }

    cards.sort((a, b) => b.at - a.at)
    cardsCache.set(address, { value: cards, at: Date.now() })
    res.json({ cards })
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
})

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`event: hello\ndata: ${JSON.stringify({ feed, stats: snapshot() })}\n\n`)

  const client = { id: ++clientSeq, res }
  clients.push(client)
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000)

  req.on('close', () => {
    clearInterval(keepAlive)
    const i = clients.findIndex((c) => c.id === client.id)
    if (i >= 0) clients.splice(i, 1)
  })
})

/** Host healthcheck. Answers without involving the frontend build at all. */
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, demo: DEMO, block: stats.block, clients: clients.length }),
)

/**
 * Serving the built frontend is optional.
 *
 * When a static host fronts this server, dist/ may not exist here at all - and
 * an unconditional catch-all would then answer every unmatched route with an
 * ENOENT rather than a 404, the healthcheck included.
 */
const distDir = join(root, 'dist')
if (existsSync(join(distDir, 'index.html'))) {
  app.use(express.static(distDir))
  app.get('*', (_req, res) => res.sendFile(join(distDir, 'index.html')))
} else {
  app.get('*', (_req, res) => res.status(404).json({ error: 'api only - no frontend built here' }))
}

app.listen(PORT, () => {
  console.log(`Ripachu server        http://localhost:${PORT}${DEMO ? '   [DEMO - nothing is onchain]' : ''}`)
  console.log(`contract          ${contractAddress}`)
  console.log(`pack price        ${formatEther(BigInt(deployment.packPrice))} MON`)
  console.log(`burner pool       ${pool.length} wallets (${Object.keys(claimed).length} claimed)`)
  console.log(`rpc               ${rpcUrl()}`)
})
