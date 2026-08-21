# The spell index

A static page at `/spells/`. **Not part of Slate** — it imports nothing from `../src/`, has no
entry in esbuild's build, and touches no room state. It is served by the same `ServeDir` fallback
in `server/src/main.rs` that serves the client, and the client carries one `<a href="/spells/">`
in its bottom-right corner. Those two are the whole of the coupling.

**The anchor opens a new tab on purpose.** In-window is either an iframe with a second stylesheet
to keep in step or these files read from `../src/`, and both are the reference lookup the non-goal
in `.claude/CLAUDE.md` refuses — read it before adding anything that points the other way.

It also means this folder is **not part of the bundle and ships on its own line**: esbuild never
touches it, so a deploy that copies `dist/` and `assets/` alone leaves a 404 behind a button that
worked on the build machine. See `deploy/pi/README.md`.

Everyone at the table owns the PHB, Xanathar's and Tasha's. A book is excellent at *"read me
Fireball"* and useless at *"what 2nd-level bard spells are a bonus action and don't eat
concentration"*, so this stores the fields that answer the second question and leaves the reading
to the page number.

## Files

| File | |
|---|---|
| `srd.json` | **Generated — do not hand-edit.** 319 PHB spells with full text, from SRD 5.1 |
| `extra.json` | Xanathar's, Tasha's and non-SRD PHB entries. Header facts and a page, no text |
| `text.json` | **Not committed.** The prose for `extra.json`, built from the book dumps |
| `vocab.js` | The closed sets every field is checked against. One copy, three readers |
| `query.js` | The search. No DOM, so `query.test.mjs` drives it in node |
| `spells.js` | Loading, drawing, one input listener |
| `index.html` | Markup and styling |

```
node tools/build-spells.mjs          # regenerate srd.json from upstream
node tools/import-spells.mjs         # add extra.json entries from spells_tmp/
node tools/check-spells.mjs          # validate both files
node --test client/spells/query.test.mjs
```

## Importing from the book dumps

`spells_tmp/` holds a plain-text dump of each book, eighty dashes between spells.
**It is gitignored, and so is the `text.json` the import produces** — Xanathar's, Tasha's and the
~41 PHB spells outside SRD 5.1 are under no open licence and this repository is public. The header
facts go in `extra.json` and are committed; the prose stays local. A checkout without `text.json`
shows exactly what `extra.json` always showed, which is a row naming a page. See `LICENSE-SRD.md`.

`tools/import-spells.mjs` reads the dumps and fills in everything a header block states — level,
school, ritual, casting time, range, components, material, duration, concentration — plus two the
SRD could never supply:

- **the trigger of a reaction**, which the books print in the header and SRD 5.1 buries in prose,
- **`area`, from the range line**: `Range: Self (15-foot cone)` records a 15-foot cone.

**It never touches an entry that already exists.** A spell already in `srd.json` belongs to
`build-spells.mjs` and is skipped; one already in `extra.json` is written back byte for byte. So
running it on a finished file is a no-op, and hand-edits survive it.

### It needs `spells_tmp/classes.txt`, which the dumps do not carry

Class lists are the one required field no dump states, so a spell without one is **held back** and
listed by name at the end of every run. The books print their lists *by class* in an appendix, so
that is the shape the file takes — thirteen lists to paste rather than 125 per-spell lookups:

```
[wizard]
Absorb Elements, Chaos Bolt, Toll the Dead
Mind Sliver

[cleric]
Word of Radiance
```

Matching ignores case, punctuation and spacing. Names already in `srd.json` are accepted and
ignored, so a whole appendix list can go in unpruned — but a name matching **nothing** is an error,
because a typo there is a spell that stays missing with nothing to say why.

### What the importer refuses to guess

Every mapping throws on an input it does not recognise, for the reason `build-spells.mjs` gives.
Three tables exist because the dumps are scanned text and the alternative was a silent wrong answer:

- **`HOMOGLYPHS`** — Cyrillic and Greek letters standing in for Latin ones. Xanathar's prints
  HOLY WEAPON with a Greek rho, omicron and nu in it. It looks perfect and matches nothing, so
  anything outside ASCII that is not known punctuation **stops the run**. The eye cannot be the
  check here.
- **`WRAP_JOINS`** — a hyphen at a line break is a broken word 167 times out of 173. The exceptions
  are real compounds that broke at their own hyphen (`yellow-green`) and em dashes the scan
  flattened (`ammunition—arrows`, which welds into a component called "ammunitionarrows").
- **`OCR_FIXES` / `SCAN_SLIPS`** — whole lines that came out wrong, and `Ist-` for `1st-`.

Every entry in all three is asserted to be used, so a corrected dump fails the run rather than
keeping a stale rule.

`src.page` is left `null`: the dumps carry no page numbers and none were guessed at.

## Adding a spell to `extra.json`

Copy this, fill it in from the book, run the validator. Fields marked **required** are the header
block a book prints at the top of a spell.

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

### `verified` is required and never defaulted

`true` means somebody read this entry off the page of a book. `false` means it was typed from
memory and nobody has checked it.

It has no default on purpose. Both possible defaults are wrong: assuming `true` silently trusts a
draft nobody confirmed, and assuming `false` cries wolf about entries somebody did confirm. The
validator refuses an entry without it, so the question gets answered rather than skipped.

An unverified entry carries an **UNCHECKED** chip among its facts, and `check-spells.mjs` lists
them by book. The chip is inside the row rather than on it: most of the hand-typed half is
unchecked, and a badge in every summary drowned out the names it sat beside.
Checking one is a one-word edit: `false` → `true`.

### `alias` is why "bigby" finds anything

SRD 5.1 had to strip the wizards' names off their own spells — Bigby's Hand is filed as *Arcane
Hand*, Tasha's Hideous Laughter as *Hideous Laughter*. Seventeen spells are affected. Without an
alias the search answers "nothing found" about a spell it is holding, which reads as a missing
spell rather than a renamed one.

Those seventeen live in an `ALIASES` table in `tools/build-spells.mjs`, and the build **fails** if
one names a spell that no longer exists. Hand-typed entries can carry their own.

### The one rule that is easy to get wrong

For the four fields below the blank line — `save`, `attack`, `damage`, `area` — **a missing key and
`null` mean different things**:

- `null` or `[]` means **"this spell has none"**. A recorded fact.
- **Leaving the key out entirely** means **"nobody has typed this yet"**.

That distinction is load-bearing. The page counts how many entries carry each of those fields, and
if even one is missing the key, it **switches that filter off** and says so rather than answering.
Otherwise `-fire` would return a list with every un-typed spell quietly absent — a wrong answer
that looks exactly like a right one, which nobody catches mid-fight.

So the filters for damage, saves, attacks and areas stay dark until `extra.json` is finished, and
then turn on by themselves. Nothing to remember, no flag to flip. Type the header block first if
you want; the tier-A filters work from the first entry.

### Naming an existing spell overrides it

An entry whose `name` matches one in `srd.json` **replaces** it. That is how a class list Tasha's
changed gets fixed — adding `"artificer"` to a PHB spell, say — without a second mechanism.

It is also how a typo destroys a PHB entry, so `check-spells.mjs` prints every override by name.
Read that list; anything on it you did not mean is a misspelling.

## Searching

Type a class, level, school, casting time, book, damage type or ability save in any order. Schools
and classes take a prefix (`wiz`, `necro`). `conc` and `ritual` filter on those. A leading `-`
negates. Anything unrecognised searches names and text, and `"quoted words"` stay one phrase.

Tokens for the **same** field widen the result (`fire cold`); tokens for **different** fields narrow
it (`wiz 3`).

```
wiz 3 conc          13 spells
cleric 1 bonus       3 — Healing Word, Sanctuary, Shield of Faith
sor 2 -conc          8
wiz cantrip attack   4 — Chill Touch, Fire Bolt, Ray of Frost, Shocking Grasp
"difficult terrain"  a phrase, searched in the prose
```

Note that the SRD holds only 14 bonus-action spells in total, so a query returning nothing is
usually right rather than broken.

## Known limits of the data

- **The SRD is not the PHB.** It carries 319 spells against the PHB's 360, and what it omits is
  weighted heavily toward warlock, paladin and ranger. The dumps in `spells_tmp/` hold all 360 plus
  95 from Xanathar's and 21 from Tasha's — 477 in all — and `import-spells.mjs` turns them into
  `extra.json` entries as their class lists arrive.
- **Importing switches three filters off until their fields are typed.** An imported entry records
  `area` and omits `save`, `attack` and `damage`, because the header block states the first and says
  nothing about the other three. That is the completeness gate doing its job, not a regression: it
  lifts by itself as the fields get filled in. Nothing about it is automatic, and nothing about it
  is a promise.
- **A few em dashes survive as hyphens mid-line.** The dumps flatten them, so Cordon of Arrows reads
  "crossbow bolts-in the ground". Only the ones that landed at a line break are fixed, because those
  weld two words into one and break search; the rest are cosmetic and were left rather than guessed
  at — `two-dimensional` and `bolts-in` are the same three characters.
- **`area` is patchy in the SRD itself.** Spirit Guardians is a 15-foot radius and arrives with
  `area: null`. That is upstream's gap, not a typo here, and it means the shape filters are
  best-effort across SRD entries even though the completeness gate says the field is "recorded".
  Hand-typed entries record it properly.
- **No page numbers on PHB entries.** The SRD does not carry them and they were not guessed at.
- **`damage: ["weapon"]`** means "the weapon's own type" — Conjure Barrage and Conjure Volley. A
  spell that lets you *choose* a type instead lists every type it could be, so `fire` finds
  Chromatic Orb.

Text search only reaches spells that have text, which means the SRD ones. The page says so when a
phrase is in play, for the same reason the filters switch themselves off.
