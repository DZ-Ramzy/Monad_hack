/**
 * Funds the whole burner pool through the Disperse contract.
 *
 * One transaction per chunk, so the entire pool is funded from a handful of
 * nonces instead of one-per-wallet. Run this in the afternoon, long before the
 * pitch; nothing here should ever execute while the room is watching.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createWalletClient,
  http,
  parseEther,
  formatEther,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chain, rpcUrl, publicClient, EXPLORER, mapLimited, withRetry } from '../src/lib/chain.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))

const { wallets } = read('wallets.json') as {
  wallets: { privateKey: Hex; address: Address }[]
}
const deployment = read('deployments.json')
const disperseAbi = read('artifacts/Disperse.json').abi

const CHUNK = Number(process.env.CHUNK ?? 60)
const amount = parseEther(process.env.POOL_FUNDING ?? '0.02')
const account = privateKeyToAccount(process.env.DEPLOYER_PK as Hex)
const pub = publicClient()
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl()) })

const balances = await mapLimited(wallets, 4, (w) => pub.getBalance({ address: w.address }))
const targets = wallets.filter((_, i) => balances[i] < amount / 2n)

console.log(`pool        ${wallets.length} wallets`)
console.log(`already ok  ${wallets.length - targets.length}`)
console.log(`to fund     ${targets.length} x ${formatEther(amount)} MON`)

if (targets.length === 0) {
  console.log('\nnothing to do.')
  process.exit(0)
}

const needed = amount * BigInt(targets.length)
const have = await pub.getBalance({ address: account.address })
console.log(`required    ${formatEther(needed)} MON (+ gas)`)
console.log(`deployer    ${formatEther(have)} MON`)

if (have < needed) {
  console.error(
    `\nShort by ${formatEther(needed - have)} MON. Top up the deployer, or lower\n` +
      `POOL_FUNDING / POOL_SIZE in .env and regenerate.`,
  )
  process.exit(1)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (let i = 0; i < targets.length; i += CHUNK) {
  // Each chunk moves real value out of the deployer, which drops it below
  // Monad's 10 MON reserve balance. An account under that reserve is allowed
  // one balance-dipping transaction per 3-block window, so chunks have to be
  // spaced or the second one comes back as a reserve balance violation.
  if (i > 0) await sleep(2500)
  const slice = targets.slice(i, i + CHUNK)
  const hash = await withRetry(() => wallet.writeContract({
    address: deployment.contracts.Disperse as Address,
    abi: disperseAbi,
    functionName: 'disperse',
    args: [slice.map((w) => w.address), amount],
    value: amount * BigInt(slice.length),
  }))
  const receipt = await withRetry(() => pub.waitForTransactionReceipt({ hash }))
  if (receipt.status !== 'success') throw new Error(`disperse chunk reverted: ${hash}`)
  console.log(
    `  funded ${String(slice.length).padStart(3)} wallets  gas ${receipt.gasUsed}  ${EXPLORER}/tx/${hash}`,
  )
}

const after = await mapLimited(wallets, 4, (w) => pub.getBalance({ address: w.address }))
const ready = after.filter((b) => b >= amount / 2n).length
console.log(`\n${ready}/${wallets.length} wallets ready. Pool is armed.`)
