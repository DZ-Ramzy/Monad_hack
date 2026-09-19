import {
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { api } from './api'

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
  /** True when the server runs without a deployment: the UI rehearses locally. */
  demo?: boolean
  chainId: number
  rpcUrl: string
  explorer: string
  contract: Address
  packPrice: string
  catalogueRoot: Hex
}

const STORAGE_KEY = 'rip.burner.v1'

/**
 * Gas limits, calibrated against the live contract from a FRESH account.
 *
 * Two Monad specifics drive these numbers.
 *
 * First, Monad charges the gas LIMIT, not the gas used. A transaction that
 * reserves 400k and burns 283k pays for 400k, and a reverted transaction pays
 * its full limit too. Padding limits is not free insurance here the way it is
 * on Ethereum - it is a direct tax on every wallet in the room.
 *
 * Second, and this is the one that nearly ate the demo: estimating against a
 * wallet that has already ripped gives the WRONG answer. On a fresh account the
 * pending-pack slot goes zero -> non-zero, which is a 20,000 gas SSTORE instead
 * of 2,900. Every phone in the room is a fresh account, so those are the only
 * numbers that matter.
 *
 *   eth_estimateGas, fresh account, live contract:
 *     buyPack      51,915   (34,881 from an account that had ripped before)
 *     revealPack  283,713   (unbacked pull; binding a vaulted card adds ~35k)
 *
 * revealPack carries extra room specifically so the vault-binding path cannot
 * run out of gas - that pull is the whole point of the demo.
 */
export const GAS = {
  buyPack: 62_000n,
  revealPack: 360_000n,
  redeem: 120_000n,
  sellBack: 160_000n,
  list: 80_000n,
  buy: 120_000n,
} as const

/**
 * Monad's base fee while this was built. Used only to bridge the gap before
 * the stream delivers a live one - never as a guess over a real reading.
 */
export const FALLBACK_GAS_PRICE = 102_000_000_000n

/**
 * The node reserves maxFeePerGas * gas at admission, so an inflated multiplier
 * raises the balance every burner needs just to be allowed to send. Monad's
 * base fee is stable, so 1.15x is ample.
 */
const feeCap = (gasPrice: bigint) => (gasPrice * 115n) / 100n

/**
 * What a wallet must HOLD - not spend - to see a rip through.
 *
 * Because the reserve is taken at admission rather than at execution, a burner
 * is refused before the transaction is even looked at, and it is refused for
 * both legs separately. Gating on the commit alone is how a wallet ends up
 * holding a sealed pack it can never open: the buy fits, the reveal does not,
 * and nothing in the UI can undo it. So the gate covers the whole round trip.
 */
export function ripReserve(gasPrice: bigint, packPrice: bigint): bigint {
  return packPrice + feeCap(gasPrice) * (GAS.buyPack + GAS.revealPack)
}

/** The same reserve for a pack that is already sealed - reveal only. */
export function revealReserve(gasPrice: bigint): bigint {
  return feeCap(gasPrice) * GAS.revealPack
}

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

/**
 * Claims a pre-funded wallet from the pool, or reuses the one already held.
 *
 * `rotate` abandons the held wallet and asks for a different one. A burner
 * that can no longer cover a rip is finished - there is no way to spend its
 * way back - so the only recovery is a fresh key from the pool.
 */
export async function claimBurner(opts: { rotate?: boolean } = {}): Promise<Burner> {
  const existing = readStored()
  const res = await fetch(api('/api/claim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: existing?.address, rotate: opts.rotate === true }),
  })
  if (!res.ok) {
    // Reusing the stored wallet is the right answer on a normal boot. It is
    // the wrong one when rotating: we are rotating BECAUSE that wallet is
    // spent, so handing it back loops the same failure forever.
    if (existing && !opts.rotate) return existing
    throw new Error((await res.json().catch(() => ({}))).error ?? 'could not claim a wallet')
  }
  const { privateKey, address } = await res.json()
  const burner = { privateKey, address } as Burner
  store(burner)
  return burner
}

function makeChain(config: AppConfig) {
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
        maxFeePerGas: feeCap(opts.gasPrice),
        maxPriorityFeePerGas: opts.gasPrice / 50n,
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
