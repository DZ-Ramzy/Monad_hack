import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWalletClient, http, parseEther, formatEther, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chain, rpcUrl, publicClient, EXPLORER } from '../src/lib/chain.js'
import { catalogueRoot, ODDS_CUMULATIVE, TIER_SIZES, canonicalCatalogue } from '../src/lib/catalogue.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = (name: string) =>
  JSON.parse(readFileSync(join(root, 'artifacts', `${name}.json`), 'utf8'))

const PACK_PRICE = parseEther(process.env.PACK_PRICE ?? '0.001')

const pk = process.env.DEPLOYER_PK as Hex | undefined
if (!pk || !pk.startsWith('0x') || pk.length !== 66) {
  console.error('DEPLOYER_PK missing or malformed in .env (expected 0x + 64 hex chars)')
  process.exit(1)
}

const account = privateKeyToAccount(pk)
const pub = publicClient()
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl()) })

const balance = await pub.getBalance({ address: account.address })
console.log(`deployer  ${account.address}`)
console.log(`balance   ${formatEther(balance)} MON`)
if (balance === 0n) {
  console.error('\nDeployer has no MON. Fund it from a faucet before deploying.')
  process.exit(1)
}

const cardsTotal = TIER_SIZES.reduce((a, b) => a + b, 0)
const cRoot = catalogueRoot()
console.log(`catalogue ${cardsTotal} cards across ${TIER_SIZES.length} tiers`)
console.log(`root      ${cRoot}`)
console.log(`packPrice ${formatEther(PACK_PRICE)} MON\n`)

async function deploy(name: string, args: readonly unknown[] = []) {
  const a = artifact(name)
  const hash = await wallet.deployContract({
    abi: a.abi,
    bytecode: a.bytecode as Hex,
    args: args as never,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`${name} deployment reverted (${hash})`)
  }
  console.log(`${name.padEnd(10)} ${receipt.contractAddress}  (gas ${receipt.gasUsed})`)
  return receipt.contractAddress
}

const ripCards = await deploy('RipCards', [
  PACK_PRICE,
  cRoot,
  ODDS_CUMULATIVE,
  TIER_SIZES,
])
const disperse = await deploy('Disperse')

// Sanity check: the chain agrees with the local catalogue.
const onchainRoot = await pub.readContract({
  address: ripCards,
  abi: artifact('RipCards').abi,
  functionName: 'catalogueRoot',
})
if (onchainRoot !== cRoot) throw new Error('catalogueRoot mismatch after deploy')

const deployment = {
  chainId: chain.id,
  deployedAt: new Date().toISOString(),
  deployer: account.address,
  packPrice: PACK_PRICE.toString(),
  catalogueRoot: cRoot,
  catalogueBytes: canonicalCatalogue().length,
  contracts: { RipCards: ripCards, Disperse: disperse },
}
writeFileSync(join(root, 'deployments.json'), JSON.stringify(deployment, null, 2) + '\n')

console.log(`\nverified  catalogueRoot matches onchain`)
console.log(`explorer  ${EXPLORER}/address/${ripCards}`)
console.log(`written   deployments.json`)
