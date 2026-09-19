/**
 * Builds the card catalogue from real market data.
 *
 * Nothing in the catalogue is invented. Every card is a real printing that
 * exists, identified by its real set, card number and rarity, illustrated with
 * its real scan, and priced at what it actually trades for.
 *
 *   names / sets / numbers / rarities / scans   pokemontcg.io API
 *   prices                                      TCGplayer, via the same API
 *
 * The output is committed to the repo (`src/lib/catalogue.data.json` plus the
 * scans under `public/cards/`) so that `catalogueRoot` is a pure function of
 * bytes in git. Nothing is fetched at build or run time - if this script had to
 * run to render the app, the root could drift without anyone noticing.
 *
 *   pnpm catalogue:fetch
 *
 * Re-running it refreshes prices. Prices are deliberately NOT part of
 * `catalogueRoot` (see canonicalCatalogue in src/lib/catalogue.ts), so a price
 * refresh does not invalidate a deployment; only changing which *cards* are in
 * the set does.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CARD_DIR = join(root, 'public', 'cards')
const DATA_FILE = join(root, 'src', 'lib', 'catalogue.data.json')

const API = 'https://api.pokemontcg.io/v2'

/**
 * The WOTC-era sets, 1999-2003. This is the era vaulted-card platforms
 * actually custody: the print runs are closed, the population reports are
 * stable, and a slab of one is a known quantity.
 */
const SETS = [
  'base1', // Base
  'base2', // Jungle
  'base3', // Fossil
  'base4', // Base Set 2
  'base5', // Team Rocket
  'base6', // Legendary Collection
  'basep', // Wizards Black Star Promos
  'gym1', // Gym Heroes
  'gym2', // Gym Challenge
  'neo1', // Neo Genesis
  'neo2', // Neo Discovery
  'neo3', // Neo Revelation
  'neo4', // Neo Destiny
  // Southern Islands (si1) is deliberately absent: the API carries no rarity
  // for any of its 18 cards, so none of them can be tiered by printed rarity.
  'ecard1', // Expedition Base Set
  'ecard2', // Aquapolis
  'ecard3', // Skyridge
]

/**
 * How the five tiers are defined.
 *
 * `rarity` is the rarity actually printed on the card - the tier names are not
 * our invention, they are what the card says it is. `min`/`max` then hold the
 * value ladder monotonic, because a gacha whose Commons out-price its Grails is
 * not a gacha. Cards are picked from that pool by descending market price.
 */
const TIERS = [
  { name: 'Common', rarity: ['Common'], size: 12, min: 2, max: 15 },
  { name: 'Uncommon', rarity: ['Uncommon'], size: 10, min: 15, max: 50 },
  { name: 'Rare', rarity: ['Rare'], size: 8, min: 50, max: 200 },
  { name: 'Holo', rarity: ['Rare Holo'], size: 6, min: 200, max: 900 },
  { name: 'Grail', rarity: ['Rare Shining', 'Rare Secret'], size: 4, min: 900, max: Infinity },
] as const

/**
 * Which printing of a card we price.
 *
 * TCGplayer prices each printing as its own SKU, so a card has several. We take
 * the card's *canonical* printing - the one it was sold as - rather than its
 * dearest, because picking the maximum makes reverse-holo Commons out-price
 * Shining Charizard and the whole ladder inverts.
 */
const VARIANT_PREFERENCE = [
  'normal',
  'holofoil',
  '1stEditionNormal',
  '1stEdition',
  '1stEditionHolofoil',
  'unlimited',
  'unlimitedHolofoil',
  'reverseHolofoil',
]

/** How that SKU key is spelled on a slab. */
const VARIANT_LABEL: Record<string, string> = {
  normal: 'Unlimited',
  holofoil: 'Holofoil',
  '1stEditionNormal': '1st Edition',
  '1stEdition': '1st Edition',
  '1stEditionHolofoil': '1st Edition Holofoil',
  unlimited: 'Unlimited',
  unlimitedHolofoil: 'Unlimited Holofoil',
  reverseHolofoil: 'Reverse Holofoil',
}

/** At most this many cards from any one set within a tier, so the set reads
 *  like a vault rather than like a scrape of whichever set indexed best. */
const PER_SET_CAP = 3

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * The API serves some text double-encoded - `Pokémon` arrives as `PokÃ©mon`,
 * `Farfetch'd` and `Nidoran♀` likewise. Repair it HERE, at fetch time, before
 * anything is hashed: a string repaired after the fact would silently change
 * `catalogueRoot`.
 */
function repair(s: string): string {
  if (!/[\u0080-ÿ]/.test(s)) return s
  if ([...s].some((c) => c.charCodeAt(0) > 0xff)) return s
  const bytes = Uint8Array.from([...s].map((c) => c.charCodeAt(0)))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return s // genuinely latin-1, leave it alone
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The upstream API 500s intermittently under load, so every call retries with
 *  a widening backoff rather than letting a blip decide what is in the set. */
async function getJson(url: string, tries = 8): Promise<any> {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (i === tries) throw new Error(`${url}: ${(err as Error).message}`)
      process.stdout.write(`    retry ${i}/${tries - 1} (${(err as Error).message})
`)
      await sleep(2000 * i)
    }
  }
}

/**
 * Raw API responses are cached under `cache/` (gitignored) so that re-running
 * this script does not re-hammer a flaky upstream, and so a run interrupted
 * halfway does not start from zero. Pass `--refresh` to bypass it and pull
 * fresh prices.
 */
const REFRESH = process.argv.includes('--refresh')
const CACHE_DIR = join(root, 'cache', 'pokemontcg')
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

async function getSet(setId: string): Promise<any[]> {
  const cached = join(CACHE_DIR, `${setId}.json`)
  if (!REFRESH && existsSync(cached) && Date.now() - statSync(cached).mtimeMs < CACHE_TTL_MS) {
    return JSON.parse(readFileSync(cached, 'utf8')).data ?? []
  }
  const data = await getJson(`${API}/cards?q=set.id:${setId}&pageSize=250`)
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cached, JSON.stringify(data))
  await sleep(600) // be a decent citizen of a free API
  return data?.data ?? []
}

interface Candidate {
  id: string
  name: string
  set: string
  setId: string
  number: string
  year: number
  rarity: string
  artist: string
  variant: string
  variantLabel: string
  market: number
  release: string
  symbol: string
  imageSmall: string
  imageLarge: string
}

async function pool(): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const setId of SETS) {
    const cards = await getSet(setId)
    let kept = 0

    for (const c of cards) {
      if (repair(c.supertype ?? '') !== 'Pokémon') continue

      const prices = c.tcgplayer?.prices ?? {}
      const variant = VARIANT_PREFERENCE.find((v) => prices[v]?.market)
      if (!variant) continue // no real price -> the card is not eligible, never filled in
      if (!c.images?.large || !c.images?.small) continue
      if (!c.rarity || !c.set?.releaseDate) continue

      out.push({
        id: c.id,
        name: repair(c.name),
        set: repair(c.set.name),
        setId: c.set.id,
        number: c.number,
        year: Number(c.set.releaseDate.slice(0, 4)),
        rarity: repair(c.rarity),
        artist: repair(c.artist ?? ''),
        variant,
        variantLabel: VARIANT_LABEL[variant] ?? variant,
        market: prices[variant].market,
        release: c.set.releaseDate,
        symbol: c.set.images?.symbol ?? '',
        imageSmall: c.images.small,
        imageLarge: c.images.large,
      })
      kept++
    }
    console.log(`  ${setId.padEnd(7)} ${String(cards.length).padStart(3)} cards  ${kept} priced`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function select(candidates: Candidate[]) {
  return TIERS.map((tier, t) => {
    const banded = candidates.filter(
      (c) =>
        (tier.rarity as readonly string[]).includes(c.rarity) &&
        c.market >= tier.min &&
        c.market < tier.max,
    )

    // Same Pokemon twice in a tier -> keep the earliest printing. This is why
    // the Base Set Charizard holds its slot against the 2002 reprint.
    const earliest = new Map<string, Candidate>()
    for (const c of banded) {
      const prev = earliest.get(c.name)
      if (!prev || c.release < prev.release) earliest.set(c.name, c)
    }

    const ranked = [...earliest.values()].sort(
      (a, b) => b.market - a.market || a.id.localeCompare(b.id),
    )

    const perSet = new Map<string, number>()
    const picked: Candidate[] = []
    for (const c of ranked) {
      const n = perSet.get(c.setId) ?? 0
      if (n >= PER_SET_CAP) continue
      perSet.set(c.setId, n + 1)
      picked.push(c)
      if (picked.length === tier.size) break
    }

    if (picked.length !== tier.size) {
      throw new Error(
        `tier ${t} (${tier.name}) wanted ${tier.size} cards, the market gave ${picked.length}. ` +
          `Widen the band or raise PER_SET_CAP - do not pad it with a card that is not there.`,
      )
    }
    return picked
  })
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

/**
 * Which tiers ship a full-size scan as well as a thumbnail.
 *
 * 0 = all of them, and that is deliberate. The reveal renders at `.slab-lg`,
 * which is ~190 CSS px; on a 2x display that asks for ~380 device px, and the
 * small scan is only 240 wide - so the card arrives visibly soft. The published
 * odds put 95% of reveals in tiers 0-2, which means the cheap-looking path is
 * the one almost every player actually sees.
 *
 * The cost is disk: full-size scans are ~850KB each. Raise this to 3 to carry
 * them for Holo and Grail only, at ~25MB less.
 */
const LARGE_FROM_TIER = 0

/** `minBytes` guards against a truncated or error-page download. Set symbols are
 *  legitimately tiny (~800B); card scans are six figures, so they get a real floor. */
async function download(url: string, dest: string, minBytes = 20_000) {
  if (existsSync(dest) && statSync(dest).size >= minBytes) return false
  for (let i = 1; i <= 6; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < minBytes) throw new Error(`suspiciously small (${buf.length}B)`)
      writeFileSync(dest, buf)
      return true
    } catch (err) {
      if (i === 6) throw new Error(`${url}: ${(err as Error).message}`)
      await new Promise((r) => setTimeout(r, 1500 * i))
    }
  }
  return false
}

// ---------------------------------------------------------------------------

console.log(`fetching ${SETS.length} sets from ${API}\n`)
const candidates = await pool()
console.log(`\npool     ${candidates.length} real, priced, illustrated cards\n`)

const tiers = select(candidates)
mkdirSync(CARD_DIR, { recursive: true })

const fetchedAt = new Date().toISOString()
let downloaded = 0

const catalogue = []
for (const [t, cards] of tiers.entries()) {
  console.log(`--- ${TIERS[t].name} (${cards.length}) ---`)
  const rows = []

  for (const c of cards) {
    const small = `${c.id}.png`
    await download(c.imageSmall, join(CARD_DIR, small)) && downloaded++

    let large: string | undefined
    if (t >= LARGE_FROM_TIER) {
      large = `${c.id}_hires.png`
      await download(c.imageLarge, join(CARD_DIR, large)) && downloaded++
    }

    let symbol: string | undefined
    if (c.symbol) {
      symbol = `sym-${c.setId}.png`
      await download(c.symbol, join(CARD_DIR, symbol), 400) && downloaded++
    }

    rows.push({
      id: c.id,
      name: c.name,
      set: c.set,
      setId: c.setId,
      number: c.number,
      year: c.year,
      rarity: c.rarity,
      artist: c.artist,
      printing: c.variantLabel,
      /** Raw, ungraded TCGplayer market price for this exact printing. */
      marketRaw: Math.round(c.market * 100) / 100,
      image: small,
      imageLarge: large,
      symbol,
    })

    console.log(
      `  $${String(rows.at(-1)!.marketRaw).padStart(8)}  ${c.id.padEnd(12)} ` +
        `${c.name.padEnd(20)} ${c.set.padEnd(22)} #${c.number.padEnd(5)} ${c.variantLabel}`,
    )
  }
  catalogue.push(rows)
}

// --- refuse to write anything that is not fully backed ----------------------

for (const [t, rows] of catalogue.entries()) {
  for (const r of rows) {
    if (!(r.marketRaw > 0)) throw new Error(`${r.id} has no price`)
    if (!existsSync(join(CARD_DIR, r.image))) throw new Error(`${r.id} has no scan on disk`)
    if (r.imageLarge && !existsSync(join(CARD_DIR, r.imageLarge)))
      throw new Error(`${r.id} is missing its full-size scan`)
    if (t !== catalogue.length - 1 && !r.rarity) throw new Error(`${r.id} has no rarity`)
  }
}

writeFileSync(
  DATA_FILE,
  JSON.stringify(
    {
      _comment:
        'Generated by scripts/fetch-catalogue.ts - do not edit by hand. ' +
        'Card data and scans: pokemontcg.io. Prices: TCGplayer market (raw, ungraded).',
      source: 'pokemontcg.io',
      priceSource: 'tcgplayer',
      fetchedAt,
      tiers: catalogue,
    },
    null,
    2,
  ) + '\n',
)

const total = catalogue.reduce((a, t) => a + t.length, 0)
console.log(`\nwrote    ${DATA_FILE.replace(root, '.')}  (${total} cards)`)
console.log(`scans    ${downloaded} new file(s) in ./public/cards`)
console.log(`\nprices are raw TCGplayer market as of ${fetchedAt.slice(0, 10)}`)
console.log('run `pnpm deploy` if the card SET changed - a price refresh alone does not move the root')
