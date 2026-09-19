import {
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * The burner wallet a phone plays with.
 *
 * Nobody installs anything and nobody signs a popup: the page claims a
 * pre-funded key from the pool, keeps it in localStorage, and signs locally.
 *
 * Every transaction is deliberately sent with an explicit gas limit, an
 * explicit fee and a locally tracked nonce. That reduces a rip to exactly one
 * RPC call per transaction - eth_sendRawTransaction and nothing else. With
 * eighty phones in a room, the difference between one call and four is the
 * difference between a demo and a wall of 429s.
 */

export interface AppConfig {
  chainId: number
  rpcUrl: string
  explorer: string
  contract: Address
  packPrice: string
  catalogueRoot: Hex
}

const STORAGE_KEY = 'rip.burner.v1'

/** Generous but bounded. Unused gas is refunded; the limit only has to be covered. */
export const GAS = {
  buyPack: 100_000n,
  revealPack: 360_000n,
  redeem: 140_000n,
  sellBack: 180_000n,
  list: 90_000n,
  buy: 140_000n,
} as const

export interface Burner {
  address: Address
  privateKey: Hex
}

function readStored(): Burner | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.privateKey === 'string' && typeof parsed?.address === 'string') {
      return parsed as Burner
    }
  } catch {
    // private browsing, blocked storage, corrupted value - all mean "no wallet yet"
  }
  return null
}

function store(burner: Burner) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(burner))
  } catch {
    // the session still works, it just will not survive a reload
  }
}

/** Claims a pre-funded wallet from the pool, or reuses the one already held. */
export async function claimBurner(): Promise<Burner> {
  const existing = readStored()
  const res = await fetch('/api/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: existing?.address }),
  })
  if (!res.ok) {
    if (existing) return existing
    throw new Error((await res.json().catch(() => ({}))).error ?? 'could not claim a wallet')
  }
  const { privateKey, address } = await res.json()
  const burner = { privateKey, address } as Burner
  store(burner)
  return burner
}

export function makeChain(config: AppConfig) {
  return defineChain({
    id: config.chainId,
    name: 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: { default: { name: 'Monad Explorer', url: config.explorer } },
  })
}

export class Signer {
  private nonce: bigint | null = null
  private client
  readonly account

  constructor(private config: AppConfig, burner: Burner) {
    this.account = privateKeyToAccount(burner.privateKey)
    this.client = createWalletClient({
      account: this.account,
      chain: makeChain(config),
      transport: http(config.rpcUrl, { retryCount: 1, timeout: 15_000 }),
    })
  }

  get address(): Address {
    return this.account.address
  }

  /** One fetch on first use, then tracked locally so rips never wait on a read. */
  private async nextNonce(): Promise<number> {
    if (this.nonce === null) {
      const res = await fetch(this.config.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionCount',
          params: [this.address, 'pending'],
        }),
      })
      const { result } = await res.json()
      this.nonce = BigInt(result)
    }
    const n = this.nonce
    this.nonce = n + 1n
    return Number(n)
  }

  /** A rejected transaction never consumed its nonce - hand it back. */
  private rollback() {
    if (this.nonce !== null && this.nonce > 0n) this.nonce -= 1n
  }

  async send(opts: {
    data: Hex
    gas: bigint
    value?: bigint
    gasPrice: bigint
  }): Promise<Hex> {
    const nonce = await this.nextNonce()
    try {
      return await this.client.sendTransaction({
        to: this.config.contract,
        data: opts.data,
        gas: opts.gas,
        value: opts.value ?? 0n,
        nonce,
        maxFeePerGas: (opts.gasPrice * 15n) / 10n,
        maxPriorityFeePerGas: opts.gasPrice / 10n,
      })
    } catch (err) {
      this.rollback()
      throw err
    }
  }

  /** Forces a nonce refetch, e.g. after an error that may have desynced us. */
  resetNonce() {
    this.nonce = null
  }
}
