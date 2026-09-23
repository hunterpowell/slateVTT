# The spell index

A static page at `/spells/`. **It isn't part of Slate**: it imports nothing from `../src/`, has no
entry in esbuild's build, and touches no room state. It's served by the same `ServeDir` fallback in
`server/src/main.rs` that serves the client, and the client has one `<a href="/spells/">` in its
bottom-right corner. Those two are the only connections between them.

The link opens a new tab on purpose. Showing the index in the same window would mean either an
iframe with a second stylesheet to keep in step, or reading these files from `../src/`, and both are
the reference lookup that the non-goal in `.claude/CLAUDE.md` rules out. Read it before adding
anything that connects the two more closely.

It also means this folder **isn't part of the bundle and has to be deployed separately**. esbuild
never touches it, so a deploy that copies only `dist/` and `assets/` leaves a 404 behind a link that
worked on the build machine. **`text.json` is never deployed**: the Pi serves this folder to anyone
with the hostname, so it gets the same treatment as the public repo. See `deploy/pi/README.md`.

Everyone at the table owns the PHB, Xanathar's and Tasha's. A book is excellent at *"read me
Fireball"* and useless at *"what 2nd-level bard spells are a bonus action and don't need
concentration"*, so this stores the fields that answer the second question and leaves the reading
to the page number.

## Files

| File | |
|---|---|
| `srd.json` | **Generated; don't hand-edit.** 319 PHB spells with full text, from SRD 5.1 |
| `extra.json` | Xanathar's, Tasha's and non-SRD PHB entries. Header facts and a page, no text |
| `text.json` | **Not committed.** The prose for `extra.json`, built from the book dumps |
| `vocab.js` | The closed sets every field is checked against. One copy, three readers |
| `query.js` | The search. No DOM, so `query.test.mjs` can run it in Node |
| `spells.js` | Loading, drawing, one input listener |
| `index.html` | Markup and styling |

```
node tools/build-spells.mjs          # regenerate srd.json from upstream
node tools/import-spells.mjs         # add extra.json entries from spells_tmp/
node tools/check-spells.mjs          # validate both files
node tools/prescreen-spells.mjs      # checklist for verifying extra.json against the books
node --test client/spells/query.test.mjs
```

## Importing from the book dumps

`spells_tmp/` holds a plain-text dump of each book, with eighty dashes between spells. **It's
gitignored, and so is the `text.json` the import produces**: Xanathar's, Tasha's and the 42 PHB
spells outside SRD 5.1 are under no open licence, and this repository is public. The header facts go
in `extra.json` and are committed; the prose stays local. A checkout without `text.json` shows what
`extra.json` always showed, a row naming a page. See `LICENSE-SRD.md`.

`tools/import-spells.mjs` reads the dumps and fills in everything a header block states (level,
school, ritual, casting time, range, components, material, duration, concentration), plus two things
the SRD never supplied:

- **the trigger of a reaction**, which the books print in the header and SRD 5.1 buries in prose,
- **`area`, from the range line**: `Range: Self (15-foot cone)` records a 15-foot cone.

**It never touches an entry that already exists.** A spell already in `srd.json` belongs to
`build-spells.mjs` and is skipped; one already in `extra.json` is written back byte for byte. So
running it on a finished file changes nothing, and hand edits survive it.

### It needs `spells_tmp/classes.txt`, which the dumps don't include

Class lists are the one required field no dump states, so a spell without one is **held back** and
listed by name at the end of every run. The books print their lists *by class* in an appendix, so
that's the shape the file takes: thirteen lists to paste rather than 125 per-spell lookups.

```
[wizard]
Absorb Elements, Chaos Bolt, Toll the Dead
Mind Sliver

[cleric]
Word of Radiance
```

Matching ignores case, punctuation and spacing. Names already in `srd.json` are accepted and
ignored, so a whole appendix list can go in unedited. A name that matches **nothing** is an error,
though, because a typo there is a spell that stays missing with nothing to say why.

### What the importer refuses to guess

Every mapping throws on an input it doesn't recognise, for the reason `build-spells.mjs` gives.
Three tables exist because the dumps are scanned text and the alternative was a silent wrong answer:

- **`HOMOGLYPHS`**: Cyrillic and Greek letters standing in for Latin ones. Xanathar's prints HOLY
  WEAPON with a Greek rho, omicron and nu in it. It looks perfect and matches nothing, so anything
  outside ASCII that isn't known punctuation **stops the run**. You can't check this by eye.
- **`WRAP_JOINS`**: a hyphen at a line break is a broken word 167 times out of 173. The exceptions
  are real compounds that broke at their own hyphen (`yellow-green`) and em dashes the scan
  flattened (`ammunition—arrows`, which would otherwise join into a component called
  "ammunitionarrows").
- **`OCR_FIXES` / `SCAN_SLIPS`**: whole lines that came out wrong, and `Ist-` for `1st-`.

Every entry in all three tables is checked for use, so a corrected dump fails the run rather than
keeping a stale rule.

`src.page` is left `null`: the dumps carry no page numbers and none were guessed.

## Adding a spell to `extra.json`

Copy this, fill it in from the book, and run the validator. Fields marked **required** are the
header block a book prints at the top of a spell.

```jsonc
{
  "name": "Toll the Dead",            // required
  "level": 0,                         // required — 0 is a cantrip
  "school": "necromancy",             // required — see SCHOOLS in vocab.js
  "classes": ["cleric", "warlock"],   // required — see CLASSES
  "time": "action",                   // required — action bonus reaction 1min 10min 1hr 8hr 12hr 24hr
  "trigger": null,                    // reaction trigger text, else null
  "range": { "kind": "ranged", "feet": 60 },   // required — kind self touch ranged sight unlimited special
  "components": "VS",                 // required — a subset of "VSM", in that order
  "material": null,                   // required if components has M
  "duration": "Instantaneous",        // required — free text, shown not filtered
  "conc": false,                      // required
  "ritual": false,                    // required
  "src": { "book": "XGE", "page": 169 },       // required

  "save": "wis",                      // ability slug, or null for none
  "attack": null,                     // "melee" | "ranged" | null
  "damage": ["necrotic"],             // [] means "deals none"
  "area": null,                       // { "type": "sphere", "size": 20 } | null

  "alias": null,                      // other names for this spell, or null
  "verified": false                   // required — see below
}
```

### `verified` is required and has no default

`true` means somebody read this entry off the page of a book. `false` means it was typed from
memory and nobody has checked it.

Both possible defaults would be wrong: assuming `true` trusts a draft nobody confirmed, and assuming
`false` raises a false alarm about entries somebody did confirm. The validator refuses an entry
without it, so the question gets answered rather than skipped.

An unverified entry shows an **UNCHECKED** chip among its facts, and `check-spells.mjs` lists them by
book. The chip is inside the row rather than on it: most of the hand-typed entries are unchecked,
and a badge in every summary drowned out the names beside it. Checking one is a one-word edit:
`false` → `true`.

`tools/prescreen-spells.mjs` prints the checklist for that pass: every entry in book order with its
header block in the order the page prints it, and, under any entry whose `save`/`attack`/`damage`/
`area` disagree with its own prose in `text.json`, what the prose says. It changes nothing; it only
tells you where to slow down. `--flagged` shows just those entries, and a book name shows just that
book.

### `alias` is why "bigby" finds anything

SRD 5.1 had to strip the wizards' names off their own spells: Bigby's Hand is filed as *Arcane
Hand*, Tasha's Hideous Laughter as *Hideous Laughter*. Seventeen spells are affected. Without an
alias the search answers "nothing found" about a spell it has, which reads as a missing spell rather
than a renamed one.

Those seventeen are in an `ALIASES` table in `tools/build-spells.mjs`, and the build **fails** if one
names a spell that no longer exists. Hand-typed entries can carry their own.

### The one rule that's easy to get wrong

For the four fields below the blank line (`save`, `attack`, `damage`, `area`), **a missing key and
`null` mean different things**:

- `null` or `[]` means **"this spell has none"**. That's a recorded fact.
- **Leaving the key out entirely** means **"nobody has typed this yet"**.

The page depends on that difference. It counts how many entries carry each of those fields, and if
even one is missing the key, it switches that filter off and says so rather than answering.
Otherwise `-fire` would return a list with every untyped spell silently missing: a wrong answer that
looks exactly like a right one, which nobody catches mid-fight.

So the filters for damage, saves, attacks and areas stay off until `extra.json` is finished, and then
turn on by themselves. There's nothing to remember and no flag to flip. You can type the header
block first; the filters on the header fields (`TIER_A` in `vocab.js`) work from the first entry. (All four are on today, as the next
section explains, and this check is what turns one back off if a new entry ever leaves out a key.)

### Naming an existing spell overrides it

An entry whose `name` matches one in `srd.json` **replaces** it. That's how a class list that Tasha's
changed gets fixed (adding `"artificer"` to a PHB spell, say) without a second mechanism.

It's also how a typo destroys a PHB entry, so `check-spells.mjs` prints every override by name. Read
that list; anything on it you didn't mean is a misspelling.

## Searching

Type a class, level, school, casting time, book, damage type or ability save, in any order. Schools
and classes accept a prefix (`wiz`, `necro`). `conc` and `ritual` filter on those. A leading `-`
negates. Anything unrecognised searches names and text, and `"quoted words"` stay one phrase.

Terms for the **same** field widen the result (`fire cold`); terms for **different** fields narrow it
(`wiz 3`).

```
wiz 3 conc          24 spells
cleric 1 bonus       3 — Healing Word, Sanctuary, Shield of Faith
sor 2 -conc         12
wiz cantrip attack   4 — Chill Touch, Fire Bolt, Ray of Frost, Shocking Grasp
"difficult terrain"  a phrase, searched in the prose
```

Only 38 of the 477 spells are a bonus action, so a query returning nothing is usually right rather
than broken.

## Known limits of the data

- **The SRD is not the PHB.** It has 319 spells against the PHB's 361, and what it leaves out is
  weighted heavily toward warlock, paladin and ranger. The dumps in `spells_tmp/` hold all 361 plus
  95 from Xanathar's and 21 from Tasha's, 477 in all, and every one of the 158 outside the SRD is
  now an `extra.json` entry.
- **Importing switches three filters off until their fields are typed.** An imported entry records
  `area` and leaves out `save`, `attack` and `damage`, because the header block states the first and
  says nothing about the other three. That's the completeness check working as intended, not a
  regression, and it lifts by itself as the fields get filled in. Nothing about it is automatic, and
  nothing about it is a promise. **The 125 imported entries had theirs filled in September 2026**,
  read off the prose in `text.json` rather than the page, so they carry the three fields and still say
  `verified: false`. Four conventions were applied, each the SRD's own where it had one:
  - a **summoned creature's** damage, attacks and saves are the creature's, not the spell's: the
    eleven Summon spells and Tiny Servant are `[]`/`null`/`null`, as Conjure Animals is upstream;
  - a spell that rides on a **weapon attack** (Booming Blade, the smites, Holy Weapon) records the
    damage and `attack: null`, as Branding Smite does, because `attack` means a *spell* attack;
  - **resistance and immunity** aren't damage dealt, so Intellect Fortress and Primordial Ward are
    `[]`; a save the *caster* or the summoned creature makes isn't one the spell forces, so Tenser's
    Transformation and Summon Greater Demon are `save: null`;
  - `save` holds **one** ability, so a spell that forces two records the one tied to its damage
    (Whirlwind is `dex`, not `str`).
- **A few em dashes survive as hyphens mid-line.** The dumps flatten them, so Cordon of Arrows reads
  "crossbow bolts-in the ground". Only the ones that landed at a line break are fixed, because those
  join two words into one and break search. The rest are cosmetic and were left rather than guessed
  at: `two-dimensional` and `bolts-in` are the same three characters.
- **`area` is patchy in the SRD itself.** Spirit Guardians is a 15-foot radius and arrives with
  `area: null`. That's upstream's gap, not a typo here, and it means the shape filters are
  best-effort across SRD entries even though the completeness check treats the field as recorded.
  Hand-typed entries record it properly.
- **No page numbers on PHB entries.** The SRD doesn't carry them and they weren't guessed.
- **`damage: ["weapon"]`** means "the weapon's own type", for Conjure Barrage and Conjure Volley. A
  spell that lets you *choose* a type instead lists every type it could be, so `fire` finds Chromatic
  Orb.

Text search only reaches spells that have text: the SRD ones, plus the rest wherever `text.json` is
present. The page says so when a phrase is in the query, for the same reason the filters switch
themselves off.
