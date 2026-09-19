/**
 * The bot swarm.
 *
 * Two jobs:
 *   - before the pitch, put enough pulls in the feed that the screen is alive
 *     rather than empty;
 *   - during the pitch, act as the fallback. If the venue wifi eats the room or
 *     nobody scans, this runs from the laptop and the throughput gauge still
 *     moves.
 *
 * Each bot is an independent wallet with its own nonce sequence, so bots never
 * serialise against each other - which is the same property the room has.
 *
 * Bots are taken from the END of the pool; the claim endpoint hands out from
 * the start, so a phone and a bot never share a wallet.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createWalletClient,
  http,
  encodeFunctionData,
  formatEther,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chain, rpcUrl, publicClient } from '../src/lib/chain.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))

const deployment = readJson('deployments.json')
const abi = readJson('artifacts/RipCards.json').abi
const contract = deployment.contracts.RipCards as Address
const packPrice = BigInt(deployment.packPrice)

const BOTS = Number(process.env.BOTS ?? 12)
const ROUNDS = Number(process.env.ROUNDS ?? 0) // 0 = until stopped
const DELAY_MS = Number(process.env.DELAY_MS ?? 600)

const { wallets } = readJson('wallets.json') as {
  wallets: { privateKey: Hex; address: Address }[]
}
const chosen = wallets.slice(-BOTS)
if (chosen.length === 0) {
  console.error('no wallets available - run `pnpm wallets:gen` and `pnpm wallets:fund` first')
  process.exit(1)
}

const pub = publicClient()
const gasPrice = await pub.getGasPrice()

console.log(`bots        ${chosen.length}`)
console.log(`contract    ${contract}`)
console.log(`pack price  ${formatEther(packPrice)} MON`)
console.log(`gas price   ${formatEther(gasPrice * 1_000_000_000n)} gwei-ish\n`)

let running = true
process.on('SIGINT', () => {
  console.log('\nstopping after current round...')
  running = false
})

const totals = { packs: 0, fails: 0 }

async function runBot(index: number, pk: Hex) {
  const account = privateKeyToAccount(pk)
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl()) })
  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' })
  let round = 0

  // stagger the swarm so all bots do not commit in the very same block
  await sleep(index * 90)

  while (running && (ROUNDS === 0 || round < ROUNDS)) {
    round++
    try {
      const balance = await pub.getBalance({ address: account.address })
      if (balance < packPrice + (gasPrice * 115n * 430_000n) / 100n) {
        console.log(`bot ${index} out of funds (${formatEther(balance)} MON), stopping`)
        return
      }

      const commitHash = await wallet.sendTransaction({
        to: contract,
        data: encodeFunctionData({ abi, functionName: 'buyPack' }),
        value: packPrice,
        gas: 62_000n,
        nonce: nonce++,
        maxFeePerGas: (gasPrice * 115n) / 100n,
        maxPriorityFeePerGas: gasPrice / 50n,
      })
      const commitReceipt = await pub.waitForTransactionReceipt({ hash: commitHash })
      if (commitReceipt.status !== 'success') throw new Error('commit reverted')

      // the pack cannot open until a block exists that it could not have seen
      await waitForBlock(commitReceipt.blockNumber + 3n)

      await wallet.sendTransaction({
        to: contract,
        data: encodeFunctionData({ abi, functionName: 'revealPack' }),
        gas: 360_000n,
        nonce: nonce++,
        maxFeePerGas: (gasPrice * 115n) / 100n,
        maxPriorityFeePerGas: gasPrice / 50n,
      })

      totals.packs++
      if (totals.packs % 10 === 0) {
        process.stdout.write(`\rpacks ripped: ${totals.packs}  failures: ${totals.fails}   `)
      }
    } catch (err) {
      totals.fails++
      // a desynced nonce is the usual cause; refetch and carry on
      nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' })
      if (process.env.DEBUG) console.warn(`bot ${index}:`, (err as Error).message.split('\n')[0])
    }
    await sleep(DELAY_MS)
  }
}

async function waitForBlock(target: bigint) {
  for (let i = 0; i < 80; i++) {
    if ((await pub.getBlockNumber()) >= target) return
    await sleep(150)
  }
  throw new Error('timed out waiting for reveal block')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

await Promise.all(chosen.map((w, i) => runBot(i, w.privateKey)))
console.log(`\n\ndone. ${totals.packs} packs ripped, ${totals.fails} failures.`)
