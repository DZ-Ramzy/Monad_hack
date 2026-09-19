import { useEffect, useRef, useState } from 'react'
import type { Address, Hex } from 'viem'

export interface Pull {
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

export interface Stats {
  packsCommitted: number
  packsRevealed: number
  cardsMinted: number
  vaultedPulls: number
  redemptions: number
  uniqueRippers: number
  grails: number
  block: number
  blockTimeMs: number
  gasPrice: string
  tps: number
  txTotal: number
  poolClaimed: number
  poolSize: number
}

export interface CommitNotice {
  buyer: string
  packNonce: string
  commitBlock: number
}

/**
 * The single subscription every screen in the room shares.
 *
 * Browsers never read the chain. The server indexes once and fans out here, so
 * adding a viewer costs the RPC nothing.
 */
export function useLive() {
  const [feed, setFeed] = useState<Pull[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [connected, setConnected] = useState(false)
  const commits = useRef<CommitNotice[]>([])
  const [commitTick, setCommitTick] = useState(0)

  useEffect(() => {
    const es = new EventSource('/api/stream')

    es.addEventListener('open', () => setConnected(true))
    es.addEventListener('error', () => setConnected(false))

    es.addEventListener('hello', (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      setFeed(data.feed)
      setStats(data.stats)
      setConnected(true)
    })
    es.addEventListener('stats', (e) => setStats(JSON.parse((e as MessageEvent).data)))
    es.addEventListener('pulls', (e) => {
      const fresh: Pull[] = JSON.parse((e as MessageEvent).data)
      setFeed((f) => [...fresh.slice().reverse(), ...f].slice(0, 60))
    })
    es.addEventListener('committed', (e) => {
      commits.current.push(JSON.parse((e as MessageEvent).data))
      if (commits.current.length > 200) commits.current.splice(0, 100)
      setCommitTick((t) => t + 1)
    })

    return () => es.close()
  }, [])

  return { feed, stats, connected, commits, commitTick }
}

/** Resolves once the chain is at least `target`, driven purely by the stream. */
export function waitForBlock(
  stats: React.MutableRefObject<Stats | null>,
  target: number,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      if ((stats.current?.block ?? 0) >= target) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for block'))
      setTimeout(check, 120)
    }
    check()
  })
}
