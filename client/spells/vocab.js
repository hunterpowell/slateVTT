// The closed sets every spell field is checked against.
//
// One file, imported by three things that would otherwise each keep their own
// copy: `tools/build-spells.mjs` asserts what it produces is in here,
// `tools/check-spells.mjs` validates hand-typed entries against it, and
// `spells.js` builds the query language out of it. A school spelled wrong in
// `extra.json` is a spell no filter can ever find, which is the failure this
// exists to make impossible.
//
// Plain ES module so the browser and node both read the same bytes — the same
// trick `protocol-tags.json` plays for the wire format, minus the second
// language.

export const SCHOOLS = [
  'abjuration', 'conjuration', 'divination', 'enchantment',
  'evocation', 'illusion', 'necromancy', 'transmutation',
];

/**
 * SRD 5.1 is the 2014 list and knows eight; artificer is here because Tasha's
 * added it and an `extra.json` entry is how that gets said. See the override
 * rule in `check-spells.mjs`.
 */
export const CLASSES = [
  'artificer', 'bard', 'cleric', 'druid', 'paladin',
  'ranger', 'sorcerer', 'warlock', 'wizard',
];

export const TIMES = ['action', 'bonus', 'reaction', '1min', '10min', '1hr', '8hr', '12hr', '24hr'];

export const RANGE_KINDS = ['self', 'touch', 'ranged', 'sight', 'unlimited', 'special'];

export const SAVES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export const ATTACKS = ['melee', 'ranged'];

/**
 * `weapon` is not a damage type in the rules — it is the honest answer for a
 * spell that deals "damage of the weapon's type" (Conjure Barrage, Conjure
 * Volley). The alternatives are both lies: `[]` claims the spell deals no damage,
 * and leaving the key off marks it un-recorded and switches the whole damage
 * filter off over one entry.
 *
 * A spell that lets you *choose* a type is not this case — it lists every type
 * it could be, so `fire` finds Chromatic Orb.
 */
export const DAMAGE = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder', 'weapon',
];

export const AREAS = ['cone', 'cube', 'cylinder', 'line', 'sphere'];

/** Page counts, so a typo'd page reference is caught rather than followed. */
export const BOOKS = { PHB: 320, XGE: 192, TCE: 192 };

/**
 * Required on every entry, from every source. The header block a book prints at
 * the top of a spell, which is the part that answers a question the book itself
 * cannot — see `spells.js`.
 */
export const TIER_A = [
  'name', 'level', 'school', 'classes', 'time', 'range',
  'components', 'duration', 'conc', 'ritual', 'src',
];

/**
 * Facts from the spell's body. Free for SRD entries and hand-typed for the rest,
 * so these are the fields that can be **partially** present — which is what the
 * completeness gate in `spells.js` exists to handle. A missing key here means
 * "not recorded yet"; `null` and `[]` mean "this spell has none".
 */
export const TIER_B = ['save', 'attack', 'damage', 'area'];
