# Attribution for `srd.json`

The spell text in `srd.json` is not ours and carries a licence that requires this notice. It is
reproduced in the page footer as well, because a notice only in the repository is a notice the
people reading the page never see.

> This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards
> of the Coast LLC and available at
> <https://dnd.wizards.com/resources/systems-reference-document>. The SRD 5.1 is licensed under
> the Creative Commons Attribution 4.0 International License available at
> <https://creativecommons.org/licenses/by/4.0/legalcode>.

The machine-readable form was taken from [5e-bits/5e-database](https://github.com/5e-bits/5e-database)
(`src/2014/en/5e-SRD-Spells.json`), which republishes the same SRD 5.1 material.

## What is deliberately not here

`extra.json` holds entries for **Xanathar's Guide to Everything**, **Tasha's Cauldron of
Everything** and the ~41 **Player's Handbook** spells SRD 5.1 leaves out. None of those books is in
any SRD and none is under an open licence. So those entries carry **no spell text** — only the
header facts and a page number.

That is not a workaround, it is the design. Everyone at this table owns all three books; what they
need is the thing a book cannot do, which is answer "what 2nd-level bard spells are a bonus action
and don't eat concentration". The reading happens in the book. See `README.md`.

## Where the unlicensed text does live

`tools/import-spells.mjs` builds those entries from plain-text dumps in `spells_tmp/`, and it writes
the prose it finds to `client/spells/text.json`. **Both are gitignored.** The page fetches the
overlay, tolerates its absence, and a checkout without it shows what `extra.json` alone has always
shown — a row that names a page.

So the split is the licence line drawn in the filesystem: **committed means SRD 5.1 and CC-BY.**
Anything the import produces from a book stays on the machine that owns the book. Keep it that way
— this repository is public.
