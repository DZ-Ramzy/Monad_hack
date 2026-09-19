# Where these images come from

Every file in this directory is a scan of a real Pokémon trading card, fetched
from the **pokemontcg.io** card database by `scripts/fetch-catalogue.ts`
(`pnpm catalogue:fetch`). Nothing here is generated, retouched or invented.

- `<set>-<number>.png` — the card, e.g. `base1-4.png` is Charizard,
  Base Set #4, illustrated by Mitsuhiro Arita.
- `<set>-<number>_hires.png` — the full-size scan. Only carried for the Holo
  and Grail tiers, which are the ones rendered large on the reveal.
- `sym-<set>.png` — the set symbol, e.g. `sym-base1.png`.

The card data that goes with them (names, sets, collector numbers, rarities,
artists, printings) comes from the same API and lives in
`src/lib/catalogue.data.json`. Prices are **TCGplayer** market prices for that
exact printing — raw and ungraded — carried through the same feed.

## Attribution and rights

Card images and card data: [pokemontcg.io](https://pokemontcg.io), whose API
serves them for developer use. Prices: [TCGplayer](https://www.tcgplayer.com).

The cards themselves — artwork, names, and the Pokémon characters — are the
intellectual property of **The Pokémon Company, Nintendo, Game Freak and
Creatures Inc.** This project is not affiliated with, endorsed by, or licensed
by any of them. The scans are reproduced here to identify the specific physical
cards a vault entry refers to, the same way a marketplace listing shows the
card it is selling.

That is a deliberate change from how this repo started. The first version drew
card art procedurally from card names precisely so it would ship no
copyrighted artwork. Showing the real card is what makes a vaulted-card claim
checkable — you cannot say "this token is that card" while showing something
that is not that card — but it is a rights tradeoff, not a free one, and
anyone taking this past a demo should get the licensing right first.
