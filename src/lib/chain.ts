import { createPublicClient, defineChain, http, type Hex } from 'viem'
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

export const BLOCK_TIME_MS = 400
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

export function txUrl(hash: Hex): string {
  return `${EXPLORER}/tx/${hash}`
}

export function addressUrl(address: string): string {
  return `${EXPLORER}/address/${address}`
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}
