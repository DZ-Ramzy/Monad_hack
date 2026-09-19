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
import { formatEther, parseAbiItem, type Address, type Hex } from 'viem'
import { publicClient, chain, rpcUrl, EXPLORER } from '../src/lib/chain.js'
import { CATALOGUE, TIER_NAMES, TIER_SIZES, ODDS_CUMULATIVE, cardDef, compValue } from '../src/lib/catalogue.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))

const PORT = Number(process.env.PORT ?? 3000)
const CLAIMED_FILE = join(root, '.claimed.json')

// ---------------------------------------------------------------------------
// Deployment + wallet pool
// ---------------------------------------------------------------------------

if (!existsSync(join(root, 'deployments.json'))) {
  console.error('deployments.json missing - run `pnpm deploy` first.')
  process.exit(1)
}
const deployment = readJson('deployments.json')
const contractAddress = deployment.contracts.RipCards as Address

const pool: { privateKey: Hex; address: Address }[] = existsSync(join(root, 'wallets.json'))
  ? readJson('wallets.json').wallets
  : []

let claimed: Record<string, number> = existsSync(CLAIMED_FILE) ? readJson('.claimed.json') : {}
const persistClaimed = () => writeFileSync(CLAIMED_FILE, JSON.stringify(claimed))

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
  comp: number
  blockNumber: number
  txHash: Hex
  at: number
}

const feed: Pull[] = []
const FEED_MAX = 60
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
    if (cursor === 0n) cursor = head > 200n ? head - 200n : 0n
    if (head < cursor) return

    const logs = await pub.getLogs({
      address: contractAddress,
      events: [evCommitted, evMinted, evRevealed, evRedeemed],
      fromBlock: cursor,
      toBlock: head,
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
          comp: compValue(tier, cardIndex, grade),
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

    cursor = head + 1n
  } catch (err) {
    // The public RPC rate limits and occasionally drops a request. A missed
    // tick is harmless - the cursor has not advanced, so the next one refetches
    // the same range.
    if (process.env.DEBUG) console.warn('indexer tick failed:', (err as Error).message)
  }
}

setInterval(tick, 500)
setInterval(() => broadcast('stats', snapshot()), 1000)

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json())

app.get('/api/config', (_req, res) => {
  res.json({
    chainId: chain.id,
    rpcUrl: rpcUrl(),
    explorer: EXPLORER,
    contract: contractAddress,
    packPrice: deployment.packPrice,
    catalogueRoot: deployment.catalogueRoot,
    catalogue: CATALOGUE,
    tierNames: TIER_NAMES,
    tierSizes: TIER_SIZES,
    odds: ODDS_CUMULATIVE,
  })
})

app.post('/api/claim', (req, res) => {
  const existing = req.body?.address as string | undefined
  if (existing && claimed[existing.toLowerCase()] !== undefined) {
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
  const address = req.params.address.toLowerCase() as Address
  const hit = balanceCache.get(address)
  if (hit && Date.now() - hit.at < 3000) return res.json({ balance: hit.value })
  try {
    const value = (await pub.getBalance({ address })).toString()
    balanceCache.set(address, { value, at: Date.now() })
    res.json({ balance: value })
  } catch {
    res.json({ balance: hit?.value ?? '0', stale: true })
  }
})

/**
 * Recovery path. If a phone misses its own PackCommitted broadcast - one
 * dropped indexer tick is enough - it would otherwise sit on a sealed pack
 * with no way to open it. The chain always knows, so ask the chain.
 */
app.get('/api/pending/:address', async (req, res) => {
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

app.use(express.static(join(root, 'dist')))
app.get('*', (_req, res) => res.sendFile(join(root, 'dist', 'index.html')))

app.listen(PORT, () => {
  console.log(`RIP server        http://localhost:${PORT}`)
  console.log(`contract          ${contractAddress}`)
  console.log(`pack price        ${formatEther(BigInt(deployment.packPrice))} MON`)
  console.log(`burner pool       ${pool.length} wallets (${Object.keys(claimed).length} claimed)`)
  console.log(`rpc               ${rpcUrl()}`)
})
