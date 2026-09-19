# Deploying Ripachu

Two pieces, deployed to two places, because they have opposite shapes.

The frontend is a static bundle and belongs on a CDN. The server is not
static and cannot become static: it runs one indexer on a 500ms loop, fans
out to every phone in the room over SSE, and holds the live feed in memory.
That is a process, not a function, so it runs somewhere that keeps processes
alive and Vercel rewrites `/api/*` to it.

```
Vercel (static dist/)
   └─ /api/*  ──rewrite──▶  Railway (tsx server/index.ts, 1 replica)
                                 ├─ indexer      500ms
                                 ├─ SSE          /api/stream
                                 └─ burner pool  WALLETS_B64
```

`numReplicas` is 1 on purpose. A second instance would run a second indexer
and hold a second, different feed, and half the room would see a different
demo than the other half.

## 1. On chain

```sh
pnpm compile
pnpm deploy          # writes deployments.json
pnpm seed:vault      # needs vault.json - see below
pnpm preflight       # must be green before you walk on stage
```

`preflight` fails on `catalogue root` whenever the catalogue has been
refetched since the last deploy. That is not a nag: the deployed contract
committed to a Merkle root over the old card list, so every card the UI names
would be the wrong card. Redeploy or revert the catalogue.

The buyback reserve funds itself from pack sales - the contract's `receive()`
collects each 0.001 MON. `sellBack` reverts until the first packs are sold, so
sell a few before demoing that path.

## 2. The server (Railway)

```sh
railway login
railway init                 # or: railway link
railway variables --set "WALLETS_B64=$(node -e "console.log(Buffer.from(require('fs').readFileSync('wallets.json')).toString('base64'))")"
railway variables --set "MONAD_RPC=<private rpc url>"
railway up
railway domain               # prints the public URL
```

### Secrets

`wallets.json` is seventy funded private keys. It is gitignored, it is not in
the upload, and it must never be pasted anywhere public. The server reads it
from `WALLETS_B64` instead - base64 of the file, decoded at boot, held in
memory, never written to disk.

`DEPLOYER_PK` is the custodian key and is **not** a server variable. Only the
local scripts touch it. Nothing on any host needs it.

### What resets

`.claimed.json` lives on the container's ephemeral disk, so a redeploy hands
out already-claimed burners again. Harmless for a one-day demo. Mount a volume
at the repo root if you need it to survive.

## 3. The frontend (Vercel)

```sh
vercel login
vercel link
vercel --prod
```

`vercel.json` carries the rewrite. The `/api/*` rule must stay **above** the
SPA fallback - `/(.*)` → `/index.html` matches `/api/stream` too, and an
EventSource handed `index.html` fails in a way that looks like the chain is
down.

### If SSE arrives buffered

The feed is the demo, so check it after deploying:

```sh
curl -N https://<vercel-domain>/api/stream
```

Events should appear within about a second and keep coming. If nothing arrives
until the connection closes, the proxy is buffering. Skip the rewrite and let
the browser call the server directly:

```sh
vercel env add VITE_API_BASE production      # https://<railway-domain>
railway variables --set "ALLOWED_ORIGIN=https://<vercel-domain>"
vercel --prod
```

`VITE_API_BASE` is read at build time, so it needs a rebuild, not a restart.
`ALLOWED_ORIGIN` is an explicit allowlist rather than `*` because `/api/claim`
hands out funded private keys.

## The vault

`vault.json` is gitignored and describes physical cards in someone's actual
custody - each entry's photo and declaration are hashed into an onchain
attestation. Copy `vault.example.json`, point the entries at cards you really
hold, and check the indices against the current catalogue, because
`pnpm catalogue:fetch` renumbers them.

Cards not deposited here still drop; they mint with `vaultRef 0` and the UI
shows them as unbacked. The contract never pretends otherwise.
