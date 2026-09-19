/**
 * Pre-generates the burner wallet pool handed out to the room.
 *
 * Why a pool instead of a live faucet endpoint: funding on demand means every
 * transfer comes from one signer, so 80 people scanning the QR at once means 80
 * parallel sendTransaction calls sharing one nonce sequence. That collides and
 * reverts on stage. We generate and fund the whole pool ahead of time; at demo
 * time a phone just claims an unused key. No funding transaction happens while
 * anyone is watching.
 */
import 'dotenv/config'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(root, 'wallets.json')

const size = Number(process.env.POOL_SIZE ?? 120)

if (existsSync(outFile)) {
  const existing = JSON.parse(readFileSync(outFile, 'utf8'))
  if (!process.env.FORCE) {
    console.log(
      `wallets.json already holds ${existing.wallets.length} wallets.\n` +
        `Regenerating would strand any MON already funded into them.\n` +
        `Re-run with FORCE=1 if that is what you want.`,
    )
    process.exit(0)
  }
}

const wallets = Array.from({ length: size }, () => {
  const privateKey = generatePrivateKey()
  return { privateKey, address: privateKeyToAccount(privateKey).address }
})

writeFileSync(
  outFile,
  JSON.stringify({ createdAt: new Date().toISOString(), wallets }, null, 2) + '\n',
)

console.log(`generated ${size} burner wallets -> wallets.json (gitignored)`)
console.log(`first: ${wallets[0].address}`)
console.log(`last:  ${wallets[size - 1].address}`)
console.log(`\nnext: pnpm wallets:fund`)
