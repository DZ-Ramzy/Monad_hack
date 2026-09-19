/**
 * End-to-end against the live deployment.
 *
 * Everything else in this repo is verified offline. This is the script that
 * proves the thing actually works on Monad: seal a pack, wait for a block that
 * did not exist when it was sealed, rip it, and report the real latency.
 *
 * It also exercises the vault path - deposit a card, rip until it binds - which
 * is the part that carries the RWA claim.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createWalletClient,
  http,
  decodeEventLog,
  formatEther,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chain, rpcUrl, publicClient, EXPLORER } from '../src/lib/chain.js'
import { TIER_NAMES, cardDef, compValue } from '../src/lib/catalogue.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))

const deployment = readJson('deployments.json')
const abi = readJson('artifacts/RipCards.json').abi
const contract = deployment.contracts.RipCards as Address
const packPrice = BigInt(deployment.packPrice)

const account = privateKeyToAccount(process.env.DEPLOYER_PK as Hex)
const pub = publicClient()
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl()) })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log(`contract  ${contract}`)
console.log(`buyer     ${account.address}`)
console.log(`balance   ${formatEther(await pub.getBalance({ address: account.address }))} MON\n`)

// ---------------------------------------------------------------------------
// Optionally seed one vault item first, so the binding path is exercised
// ---------------------------------------------------------------------------

const SEED_TIER = Number(process.env.SEED_TIER ?? -1)
const SEED_INDEX = Number(process.env.SEED_INDEX ?? 0)

if (SEED_TIER >= 0) {
  const def = cardDef(SEED_TIER, SEED_INDEX)
  const hash = await wallet.writeContract({
    address: contract,
    abi,
    functionName: 'depositCard',
    args: [SEED_TIER, SEED_INDEX, 9, 99999n, '0x' + 'ab'.repeat(32)],
  })
  await pub.waitForTransactionReceipt({ hash })
  console.log(`seeded vault with ${def.name} (${def.set})\n`)
}

// ---------------------------------------------------------------------------
// The rip
// ---------------------------------------------------------------------------

const PACKS = Number(process.env.PACKS ?? 3)
const latencies: number[] = []

for (let n = 0; n < PACKS; n++) {
  const t0 = Date.now()

  const commitHash = await wallet.writeContract({
    address: contract,
    abi,
    functionName: 'buyPack',
    value: packPrice,
    gas: 100_000n,
  })
  const commitReceipt = await pub.waitForTransactionReceipt({ hash: commitHash })
  if (commitReceipt.status !== 'success') throw new Error(`buyPack reverted: ${commitHash}`)
  const commitBlock = commitReceipt.blockNumber
  const tSealed = Date.now()

  // the pack cannot be opened until a block exists that it could not have seen
  let head = await pub.getBlockNumber()
  while (head < commitBlock + 2n) {
    await sleep(80)
    head = await pub.getBlockNumber()
  }

  const revealHash = await wallet.writeContract({
    address: contract,
    abi,
    functionName: 'revealPack',
    gas: 400_000n,
  })
  const revealReceipt = await pub.waitForTransactionReceipt({ hash: revealHash })
  if (revealReceipt.status !== 'success') throw new Error(`revealPack reverted: ${revealHash}`)

  const total = Date.now() - t0
  latencies.push(total)

  console.log(
    `pack ${n + 1}  sealed@${commitBlock} revealed@${revealReceipt.blockNumber} ` +
      `(+${revealReceipt.blockNumber - commitBlock} blocks)  ` +
      `seal ${tSealed - t0}ms · total ${total}ms  gas ${revealReceipt.gasUsed}`,
  )

  for (const log of revealReceipt.logs) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics }) as {
        eventName: string
        args: Record<string, unknown>
      }
      if (ev.eventName !== 'CardMinted') continue
      const a = ev.args
      const tier = Number(a.tier)
      const cardIndex = Number(a.cardIndex)
      const grade = Number(a.grade)
      const vaultRef = Number(a.vaultRef)
      const def = cardDef(tier, cardIndex)
      console.log(
        `          ${def.name.padEnd(20)} ${TIER_NAMES[tier].padEnd(9)} PSA ${String(grade).padEnd(2)} ` +
          `#${String(a.serial).padStart(4, '0')}  $${compValue(tier, cardIndex, grade).toLocaleString().padStart(7)}` +
          (vaultRef ? `  <- VAULTED #${vaultRef}` : ''),
      )
    } catch {
      /* not one of ours */
    }
  }
  console.log(`          ${EXPLORER}/tx/${revealHash}`)
}

const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
const best = Math.min(...latencies)
console.log(`\ncommit -> reveal, end to end: avg ${avg}ms, best ${best}ms`)
console.log(`cards held: ${await pub.readContract({ address: contract, abi, functionName: 'balanceOf', args: [account.address] })}`)
console.log(`vault items: ${await pub.readContract({ address: contract, abi, functionName: 'vaultCount' })}`)
