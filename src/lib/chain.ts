import { createPublicClient, defineChain, http } from 'viem'
import { monadTestnet } from 'viem/chains'

/**
 * Monad testnet. 400ms blocks is the whole reason this product exists, so it
 * is worth writing down: at this block time a commit/reveal round trip is
 * ~800ms, which is inside the window a user perceives as "instant".
 */
export const chain = defineChain({
  ...monadTestnet,
  rpcUrls: {
    default: {
      http: [
        (typeof process !== 'undefined' && process.env?.MONAD_RPC) ||
          monadTestnet.rpcUrls.default.http[0],
      ],
    },
  },
})

export const EXPLORER = monadTestnet.blockExplorers!.default.url

export function rpcUrl(): string {
  return chain.rpcUrls.default.http[0]
}

export function publicClient(url = rpcUrl()) {
  return createPublicClient({
    chain,
    transport: http(url, { batch: { wait: 16 }, retryCount: 2 }),
  })
}

/**
 * Concurrency-limited map.
 *
 * The public Monad RPC allows 50 requests per second. A bare
 * `Promise.all(wallets.map(getBalance))` over a 70-wallet pool trips it
 * instantly and the whole script dies. Everything that fans out over the pool
 * goes through here.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let delay = 300
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      const rateLimited = msg.includes('-32007') || /request limit|429|rate/i.test(msg)
      if (!rateLimited || i >= attempts - 1) throw err
      await new Promise((r) => setTimeout(r, delay))
      delay *= 2
    }
  }
}

export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await withRetry(() => fn(items[i], i))
    }
  })
  await Promise.all(workers)
  return out
}
