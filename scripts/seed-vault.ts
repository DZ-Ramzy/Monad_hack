/**
 * Deposits physical stock into the vault and posts buyback quotes.
 *
 * This is the script that makes the RWA claim true rather than decorative.
 * Every entry in vault.json is a card that physically exists and is in
 * custody; the attestation hash commits onchain to the photo of it, so the
 * claim "this token is that card" is checkable rather than asserted.
 *
 * Cards that are NOT deposited here simply never bind - their pulls mint with
 * vaultRef 0 and the UI shows them as unbacked. The contract never pretends.
 */
import 'dotenv/config'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createWalletClient,
  http,
  keccak256,
  toHex,
  encodePacked,
  parseEther,
  formatEther,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chain, rpcUrl, publicClient, EXPLORER } from '../src/lib/chain.js'
import { CATALOGUE, TIER_NAMES, cardDef } from '../src/lib/catalogue.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))

interface VaultEntry {
  /** Human note, ignored onchain. */
  label?: string
  tier: number
  cardIndex: number
  /** Real grade on the slab. Use 0 for raw/ungraded. */
  grade: number
  /** Grading cert number, or your own reference for a raw card. */
  certNumber: number
  /** Path to the photo of the card, relative to the repo. Hashed onchain. */
  photo?: string
  /** Custody declaration, hashed together with the photo. */
  declaration?: string
  /** Indexed market value in MON, used for the standing buyback quote. */
  quoteMon?: string
}

if (!existsSync(join(root, 'vault.json'))) {
  console.error(
    'vault.json missing.\n\n' +
      'Copy vault.example.json to vault.json and describe the cards you physically hold.\n' +
      'Every entry must be a real card in your custody.',
  )
  process.exit(1)
}

const entries = readJson('vault.json') as VaultEntry[]
const deployment = readJson('deployments.json')
const abi = readJson('artifacts/RipCards.json').abi
const contract = deployment.contracts.RipCards as Address

const account = privateKeyToAccount(process.env.DEPLOYER_PK as Hex)
const pub = publicClient()
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl()) })

console.log(`custodian  ${account.address}`)
console.log(`contract   ${contract}`)
console.log(`entries    ${entries.length}\n`)

// --- validate before writing anything -------------------------------------

let bad = 0
for (const [i, e] of entries.entries()) {
  const tier = CATALOGUE[e.tier]
  if (!tier) {
    console.error(`  [${i}] tier ${e.tier} does not exist`)
    bad++
    continue
  }
  if (e.cardIndex < 0 || e.cardIndex >= tier.length) {
    console.error(`  [${i}] cardIndex ${e.cardIndex} out of range for tier ${e.tier} (0..${tier.length - 1})`)
    bad++
    continue
  }
  if (e.photo && !existsSync(join(root, e.photo))) {
    console.error(`  [${i}] photo not found: ${e.photo}`)
    bad++
  }
}
if (bad) {
  console.error(`\n${bad} invalid entr${bad === 1 ? 'y' : 'ies'} - nothing deposited.`)
  process.exit(1)
}

// --- deposit ---------------------------------------------------------------

let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' })

for (const e of entries) {
  const def = cardDef(e.tier, e.cardIndex)
  const photoBytes = e.photo ? readFileSync(join(root, e.photo)) : Buffer.alloc(0)
  const attestation = keccak256(
    toHex(
      Buffer.concat([
        photoBytes,
        Buffer.from(e.declaration ?? `${def.name} / ${def.set} / cert ${e.certNumber}`),
      ]),
    ),
  )

  const hash = await wallet.writeContract({
    address: contract,
    abi,
    functionName: 'depositCard',
    args: [e.tier, e.cardIndex, e.grade, BigInt(e.certNumber), attestation],
    nonce: nonce++,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`deposit reverted for ${def.name}`)

  console.log(
    `  vaulted  ${def.name.padEnd(20)} ${TIER_NAMES[e.tier].padEnd(9)} ` +
      `${e.grade ? `PSA ${e.grade}` : 'raw  '}  cert ${e.certNumber}`,
  )
  console.log(`           attestation ${attestation}`)
}

// --- buyback quotes --------------------------------------------------------

const quoted = entries.filter((e) => e.quoteMon)
if (quoted.length) {
  const keys = quoted.map((e) =>
    keccak256(encodePacked(['uint8', 'uint16'], [e.tier, e.cardIndex])),
  )
  const values = quoted.map((e) => parseEther(e.quoteMon!))
  const hash = await wallet.writeContract({
    address: contract,
    abi,
    functionName: 'setQuotes',
    args: [keys, values],
    nonce: nonce++,
  })
  await pub.waitForTransactionReceipt({ hash })
  console.log(`\n  quotes posted for ${quoted.length} card(s)`)
}

const vaultCount = await pub.readContract({ address: contract, abi, functionName: 'vaultCount' })
const reserve = await pub.getBalance({ address: contract })

console.log(`\nvault holds ${vaultCount} item(s)`)
console.log(`buyback reserve ${formatEther(reserve)} MON`)
console.log(`${EXPLORER}/address/${contract}`)
