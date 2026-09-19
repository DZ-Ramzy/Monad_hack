/**
 * Run this before walking on stage.
 *
 * Every line here is something that has killed a live demo at some point: a
 * stale contract address, a wallet pool that was never funded, an empty vault,
 * an RPC that stopped answering. Better to find out now than in front of the
 * room.
 */
import 'dotenv/config'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatEther, formatGwei, parseEther, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chain, rpcUrl, publicClient, EXPLORER, mapLimited } from '../src/lib/chain.js'
import { catalogueRoot } from '../src/lib/catalogue.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))
const has = (p: string) => existsSync(join(root, p))

let failures = 0
let warnings = 0

const ok = (label: string, detail = '') => console.log(`  PASS  ${label.padEnd(30)} ${detail}`)
const warn = (label: string, detail = '') => {
  console.log(`  WARN  ${label.padEnd(30)} ${detail}`)
  warnings++
}
const fail = (label: string, detail = '') => {
  console.log(`  FAIL  ${label.padEnd(30)} ${detail}`)
  failures++
}

console.log(`\nRipachu preflight - ${chain.name} (${chain.id})\n`)

// --- rpc -------------------------------------------------------------------

const pub = publicClient()
let head = 0n
try {
  const id = await pub.getChainId()
  head = await pub.getBlockNumber()
  if (id !== chain.id) fail('chain id', `expected ${chain.id}, got ${id}`)
  else ok('rpc reachable', `${rpcUrl()} @ block ${head}`)
} catch (e) {
  fail('rpc reachable', (e as Error).message.split('\n')[0])
}

if (head > 0n) {
  await new Promise((r) => setTimeout(r, 1500))
  const later = await pub.getBlockNumber()
  if (later > head) ok('chain advancing', `+${later - head} blocks in 1.5s`)
  else fail('chain advancing', 'block number did not move')
}

let gasPrice = 0n
try {
  gasPrice = await pub.getGasPrice()
  ok('gas price', `${formatGwei(gasPrice)} gwei`)
} catch {
  warn('gas price', 'could not read')
}

// --- deployment ------------------------------------------------------------

if (!has('deployments.json')) {
  fail('deployments.json', 'missing - run pnpm deploy')
} else {
  const deployment = readJson('deployments.json')
  const contract = deployment.contracts.RipCards as Address
  const abi = readJson('artifacts/RipCards.json').abi

  const code = await pub.getCode({ address: contract }).catch(() => undefined)
  if (!code || code === '0x') fail('contract deployed', `no code at ${contract}`)
  else ok('contract deployed', `${contract} (${(code.length - 2) / 2} bytes)`)

  if (deployment.chainId !== chain.id) {
    fail('deployment network', `deployed to ${deployment.chainId}, connected to ${chain.id}`)
  }

  if (code && code !== '0x') {
    const onchainRoot = (await pub.readContract({
      address: contract,
      abi,
      functionName: 'catalogueRoot',
    })) as Hex
    if (onchainRoot === catalogueRoot()) ok('catalogue root', 'matches local catalogue')
    else fail('catalogue root', 'catalogue changed since deploy - REDEPLOY or revert it')

    const vaultCount = Number(
      await pub.readContract({ address: contract, abi, functionName: 'vaultCount' }),
    )
    if (vaultCount > 0) ok('vault stock', `${vaultCount} physical card(s) deposited`)
    else warn('vault stock', 'empty - every pull will mint unbacked')

    const reserve = await pub.getBalance({ address: contract })
    if (reserve > 0n) ok('buyback reserve', `${formatEther(reserve)} MON`)
    else warn('buyback reserve', 'empty - sellBack will revert')

    const price = (await pub.readContract({
      address: contract,
      abi,
      functionName: 'packPrice',
    })) as bigint
    ok('pack price', `${formatEther(price)} MON`)
  }
}

// --- deployer --------------------------------------------------------------

if (process.env.DEPLOYER_PK && process.env.DEPLOYER_PK.length === 66) {
  const account = privateKeyToAccount(process.env.DEPLOYER_PK as Hex)
  const balance = await pub.getBalance({ address: account.address })
  if (balance > parseEther('0.05')) ok('deployer funded', `${formatEther(balance)} MON`)
  else warn('deployer funded', `only ${formatEther(balance)} MON left`)
} else {
  warn('deployer key', 'DEPLOYER_PK not set')
}

// --- wallet pool -----------------------------------------------------------

if (!has('wallets.json')) {
  fail('wallet pool', 'missing - run pnpm wallets:gen && pnpm wallets:fund')
} else {
  const { wallets } = readJson('wallets.json') as { wallets: { address: Address }[] }
  const floor = parseEther('0.01')
  const balances = await mapLimited(wallets, 8, (w) =>
    pub.getBalance({ address: w.address }).catch(() => 0n),
  )
  const funded = balances.filter((b) => b >= floor).length
  const total = balances.reduce((a, b) => a + b, 0n)

  if (funded === 0) fail('wallet pool', `0/${wallets.length} funded`)
  else if (funded < wallets.length * 0.8) {
    warn('wallet pool', `${funded}/${wallets.length} funded (${formatEther(total)} MON total)`)
  } else ok('wallet pool', `${funded}/${wallets.length} funded (${formatEther(total)} MON total)`)

  const bots = Number(process.env.BOTS ?? 12)
  const botsFunded = balances.slice(-bots).filter((b) => b >= floor).length
  if (botsFunded === bots) ok('bot swarm', `${bots} bots ready`)
  else warn('bot swarm', `${botsFunded}/${bots} bot wallets funded`)

  const claimed = has('.claimed.json') ? Object.keys(readJson('.claimed.json')).length : 0
  if (claimed > 0) warn('claimed wallets', `${claimed} already handed out - delete .claimed.json to reset`)
  else ok('claimed wallets', 'none - pool is fresh')
}

// --- build -----------------------------------------------------------------

if (has('dist/index.html')) ok('frontend built', 'dist/ present')
else fail('frontend built', 'run pnpm build')

if (has('vault.json')) ok('vault manifest', 'vault.json present')
else warn('vault manifest', 'no vault.json - nothing physical registered')

// ---------------------------------------------------------------------------

console.log(
  `\n${failures === 0 ? (warnings === 0 ? 'READY' : 'READY WITH WARNINGS') : 'NOT READY'} - ` +
    `${failures} failure(s), ${warnings} warning(s)\n`,
)
if (!failures) console.log(`explorer  ${EXPLORER}\n`)
process.exit(failures === 0 ? 0 : 1)
