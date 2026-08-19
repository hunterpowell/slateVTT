# The wire, and keeping it open

Why the protocol is JSON, and why the send task pings a socket nobody is using. Milestones 2 and 26.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before changing the
wire format, or before touching the ping in the send task** — the second one looks like dead code on
a developer machine, because on loopback it is.

The *shape* of the protocol — `Welcome`, deltas, and which frames are filtered per recipient — is in
`.claude/CLAUDE.md` under *Wire protocol* and is not repeated here. The reconnect half of `net.ts`
is in `docs/presence.md`. This file is the transport: the format, and the liveness.

## JSON, and not a binary format

Human-readable frames in devtools are worth more than the bandwidth. That trade is not close at this
scale — seven clients on a home network — and the case it was made for is drag-sync debugging, where
the question is always "what exactly did the server send, in what order", and the answer needs to be
readable without a decoder.

Serde tagged enums (`#[serde(tag = "type", rename_all = "snake_case")]`) mean the frame in the
network tab reads as the variant name a grep will find in the Rust. Do not switch to a binary format.

## The keepalive

**The send task pings an idle socket every 30 seconds.**

Nothing crosses a quiet board. Six people staring at a map, nobody moving a token, is a connection
with zero bytes on it for minutes at a time — and a proxy that sees no traffic for long enough
closes it as dead. That is what a tunnel does and what loopback does not, which is why this was not
needed for the first twenty-five milestones and became needed the day Slate was hosted behind
Cloudflare rather than started on a PC in the room. **The absence of this bug on a development
machine is structural, not luck**: if you are testing against `localhost`, you cannot reproduce the
thing this exists to fix.

It is a WebSocket protocol ping, **not a message**:

- A browser answers it at the protocol level, so no client code knows it exists.
- The wire format is unchanged — there is no `ping` variant in `ServerMsg` and there must not be one.
- Nothing is logged and nothing is persisted.

Adding a `ServerMsg::Ping` would be the mistake here. It would put a frame in every client's mailbox
twice a minute, and the client would have to know to ignore it — a keepalive that the application
layer can see is a keepalive the application layer can get wrong. (Note that `ServerMsg::Pinged`, the
one that draws a ring on the board, is unrelated and named for the gesture; see `docs/drawings.md`.)

## A keepalive is not a reconnect

These solve adjacent problems and only one of them is here. The keepalive stops a *healthy* socket
from being reaped for being quiet. When a socket actually closes, the client backs off and reloads
the page, and if that gives up the page says so and waits for a refresh — that is `net.ts` and it is
documented in `docs/presence.md`.

The reason the boundary matters: a keepalive that starts trying to recover state, or a reconnect that
starts sending heartbeats, ends up as one component with two jobs and a failure mode where a dropped
connection looks alive because something is still writing to it. Keep the ping ignorant. Its only
job is to put a byte on the wire so the proxy does not close a connection that is fine.

## How big a frame may be, and the rule that keeps it honest

`ws_handler` caps an inbound message at `MAX_WS_MESSAGE_BYTES` — `max_message_size` and
`max_frame_size`, both set to the same number.

**Both are read-side only.** They gate what tungstenite will accept off the socket and bound nothing
on the way out, so a `Welcome` carrying two thousand walls is unaffected by this number and always
was. What they bound is every *command*, and that is the direction the trap is in: a frame over the
cap is not a refusal the client can read, it is a failed read that ends the recv task and closes the
socket. On the far side that is a lost connection, and `net.ts` answers a lost connection by backing
off and reloading the page. The DM sees their work vanish and the page blink, and the only trace is
a `debug!` line.

**Most commands are a handful of scalars and can never approach it. One is not.** `SetFogOverride`
carries `Vec<Cell>`, and a `Cell` is a tuple, so the frame holds one `[x,y]` pair per cell — six
bytes at one digit, twelve at four. `MAX_OVERRIDE_CELLS` is what bounds that list, and the two
numbers have to be read together or the smaller one is unreachable.

They were not. The cap shipped at 50,000 cells against a 16 KiB frame — 25× over — so the refusal
`check` is careful to word helpfully could not be delivered for any fill past roughly 1,700 cells,
which is well inside what the cap's own comment calls legitimate. Filling a large room killed the
DM's socket instead, and did it again on every retry. Two things hid it: the comment on `Cell` in
`fog.rs` claimed it was never serialised as itself, which is true of `FogView` outbound and false of
this command inbound; and the test covering the cap drives `check` directly, so it passed green over
a path production could not reach.

So the rule, and it is the durable output of that bug:

> **A command carrying a variable-length collection has two bounds, not one** — the count the room
> checks and the bytes the socket will accept — and **a test must serialise the largest legal
> instance and assert it fits.** Driving `check` is not that test. `check` never runs.

`room::tests::fog_of_war::largest_override_fits_in_a_frame` is that assertion for the one command
that needs it today. It builds the frame as text rather than serialising a `ClientMsg`, which is
inbound and carries no `Serialize`, and deserialises it back — so the shape being measured is proven
to be the shape the server parses. It asserts in both directions: over the frame is the bug, and far
under it is a fill the DM is refused for nothing.

Adding a second such command means a second test beside it. Raising the frame cap is the other lever
and it is not free — it is also what an unidentified socket may push before `Hello`, which is
acceptable behind a tunnel with a DM secret and is written down at the constant rather than left to
be rediscovered.

## The two copies of the union

`ClientMsg` and `ServerMsg` are written out by hand twice, once in `server/src/protocol.rs` and once
in `client/src/protocol.ts`, and nothing generates either from the other. That is a deliberate
consequence of having no build step worth the name, and it has a failure mode: a variant added on one
side and forgotten on the other.

It used to fail *silently*, which is the part worth fixing. The server logs `discarding unparseable
frame` at `warn` and carries on; the client hit a `default:` arm and called `console.warn` — and
`cdp.mjs` collects console entries of type `error` only, so a drifted protocol failed every browser
driver by doing nothing at all. That arm is now `console.error`, which makes any unknown frame fail
whichever driver is running.

`protocol-tags.json` at the repo root is the third copy and the one both sides are measured against.
The enforcement on each side is the local compiler rather than the fixture:

- Rust has an exhaustive `match` per union with no wildcard, so a new variant stops the crate
  compiling until it is named.
- TypeScript has `Record<Msg['type'], true>`, so a new variant stops the typecheck until it is named.

Then a test on each side asserts its list and the fixture agree. Adding a variant to one language
alone fails that language's own build; adding it to both without the fixture fails both tests.

**Variant-level only, and do not oversell it.** A renamed or dropped *field* keeps its tag and passes
every check here. What catches that is the server rejecting the frame at runtime, which is now loud
in a driver. Closing it properly means sample payloads per variant or real codegen, and neither is
built — the fixture says so in its own header.
