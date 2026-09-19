/**
 * Compiles contracts/*.sol with solc-js into artifacts/.
 *
 * No Foundry / Hardhat on purpose: one dependency, one command, reproducible
 * on any laptop in the room.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const solc = require('solc')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contractsDir = join(root, 'contracts')
const outDir = join(root, 'artifacts')

// Monad is EVM-equivalent; shanghai keeps us clear of transient storage and
// any post-Cancun opcode the testnet may not have enabled.
const EVM_VERSION = process.env.EVM_VERSION ?? 'shanghai'

const sources: Record<string, { content: string }> = {}
for (const file of readdirSync(contractsDir).filter((f) => f.endsWith('.sol'))) {
  sources[file] = { content: readFileSync(join(contractsDir, file), 'utf8') }
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: EVM_VERSION,
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
    },
  },
}

const output = JSON.parse(solc.compile(JSON.stringify(input)))

const errors = (output.errors ?? []) as Array<{ severity: string; formattedMessage: string }>
const fatal = errors.filter((e) => e.severity === 'error')
for (const e of errors) {
  if (e.severity !== 'error') console.warn(e.formattedMessage)
}
if (fatal.length) {
  for (const e of fatal) console.error(e.formattedMessage)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

let count = 0
for (const [file, contracts] of Object.entries(output.contracts ?? {})) {
  for (const [name, c] of Object.entries(contracts as Record<string, any>)) {
    const artifact = {
      contractName: name,
      sourceName: file,
      evmVersion: EVM_VERSION,
      abi: c.abi,
      bytecode: '0x' + c.evm.bytecode.object,
      deployedBytecodeSize: c.evm.deployedBytecode.object.length / 2,
    }
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(artifact, null, 2))
    console.log(
      `  ${name.padEnd(14)} ${String(artifact.deployedBytecodeSize).padStart(6)} bytes deployed`,
    )
    count++
  }
}

console.log(`\ncompiled ${count} contract(s) with solc ${solc.version()} (evm: ${EVM_VERSION})`)
