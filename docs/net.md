# The wire, and keeping it open

Why the protocol is JSON, and why the send task pings a socket nobody is using. Milestones 2 and 26.

Read this before changing the wire format, the inbound frame cap, or the ping in the send task. The
ping looks like dead code on a developer machine, because on loopback it is.

The shape of the protocol (`Welcome`, deltas, and which frames are filtered per recipient) is in
`.claude/CLAUDE.md` under *Wire protocol*. The reconnect half of `net.ts` is in `docs/presence.md`.
This file covers the transport: the format, the frame cap, and keeping the socket alive.

## JSON, not a binary format

Frames you can read in devtools are worth more than the bandwidth. At seven clients on a home
network the trade isn't close. It was made for debugging drag sync, where the question is always
"what exactly did the server send, and in what order", and the answer needs to be readable without
a decoder.

Serde tagged enums (`#[serde(tag = "type", rename_all = "snake_case")]`) mean the frame in the
network tab shows the variant name, which a grep will find in the Rust. Don't switch to a binary
format.

## The keepalive

The send task (`KEEPALIVE` in `server/src/ws.rs`) pings an idle socket every 30 seconds.

Nothing crosses a quiet board. Six people looking at a map with nobody moving a token is a
connection with no traffic for minutes at a time, and a proxy that sees no traffic for long enough
closes the connection. A tunnel does this and loopback doesn't. That's why the ping wasn't needed
for the first twenty-five milestones and became necessary once Slate was hosted behind Cloudflare
instead of run on a PC in the room. **You can't reproduce this bug against `localhost`**, so its
absence on a development machine proves nothing.

It's a WebSocket protocol ping, not a message:

- A browser answers it at the protocol level, so no client code knows it exists.
- The wire format is unchanged. There's no `ping` variant in `ServerMsg`, and there must not be one.
- Nothing is logged and nothing is persisted.

Adding a `ServerMsg::Ping` would be the mistake. It would put a frame in every client's mailbox twice
a minute, and the client would have to know to ignore it. A keepalive the application layer can see
is one the application layer can get wrong. (`ServerMsg::Pinged`, which draws a ring on the board,
is unrelated and named for the gesture. See `docs/drawings.md`.)

## A keepalive is not a reconnect

The two solve neighbouring problems, and only the keepalive is here. The keepalive stops a healthy
socket from being closed for being quiet. When a socket actually closes, the client backs off and
reloads the page, and if that gives up the page says so and waits for a refresh. That's `net.ts`,
documented in `docs/presence.md`.

Keep them apart. A keepalive that starts trying to recover state, or a reconnect that starts sending
heartbeats, becomes one component with two jobs, and it can fail in a way where a dropped connection
looks alive because something is still writing to it. The ping's only job is to put a byte on the
wire so the proxy doesn't close a connection that's fine.

## How big a frame may be

`ws_handler` caps an inbound message at `MAX_WS_MESSAGE_BYTES` (128 KiB), setting
`max_message_size` and `max_frame_size` to the same number.

**Both are read side only.** They limit what tungstenite accepts off the socket and nothing on the
way out, so a `Welcome` carrying two thousand walls is unaffected. What they limit is every command,
and a command over the cap isn't a refusal the client can read. It's a failed read that ends the
recv task (logged at `debug!` as `websocket read failed`) and closes the socket. The client sees a
lost connection, and `net.ts` answers that by backing off and reloading the page. The DM sees their
work vanish and the page blink, and the only trace is that `debug!` line.

Most commands are a handful of scalars and can't come near the cap. `SetFogOverride` can. It carries
a `Vec<Cell>`, and a `Cell` is a tuple, so the frame holds one `[x,y]` pair per cell: six bytes at
one digit, twelve at four. `MAX_OVERRIDE_CELLS` (8,000 today) bounds that list, and the two numbers
have to be checked against each other or the smaller one is unreachable.

They weren't, at first. The cell cap shipped at 50,000 against a 16 KiB frame, 25 times over, so the
refusal `check` carefully words could never be delivered for any fill past roughly 1,700 cells. That
was well within what the cap's own comment called legitimate. Filling a large room dropped the DM's
socket instead, and did it again on every retry. Two things hid it. The comment on `Cell` in
`fog.rs` said a `Cell` was never serialised as itself, which is true of `FogView` going out and
false of this command coming in. And the test covering the cap called `check` directly, so it
passed over a path production couldn't reach.

The rule that came out of it:

> A command carrying a variable-length collection has two bounds: the count the room checks, and the
> bytes the socket will accept. **A test must serialise the largest legal instance and assert it
> fits.** A test that calls `check` isn't that test, because `check` never runs on a frame the
> socket dropped.

`room::tests::fog_of_war::largest_override_fits_in_a_frame` is that assertion for `SetFogOverride`.
It builds the frame as text rather than serialising a `ClientMsg` (an inbound type, with no
`Serialize`), then deserialises it back, which proves the shape being measured is the shape the
server parses. It asserts in both directions: over the cap is the bug, and far under it means the DM
is refused a fill for no reason.

`UpdateToken` is the second such command, since a token carries a list of markers.
`room::tests::tokens::the_largest_token_edit_fits_in_a_frame` is its assertion. Two things about it
are worth knowing before writing a third.

Its count bound isn't a chosen number. `Marker::ALL` is a closed set of seven and `token_fields`
refuses duplicates, so the list can't be longer than seven however long the array on the wire was.
Where a bound can come from the type like this, prefer it: a constant tuned against the frame size
can drift, and this one can't.

So it asserts in one direction only. The other direction in the override test guards against a tuned
number drifting far below what a frame holds. There's no tuned number here: the largest legal token
edit is orders of magnitude under the cap and is meant to stay there.

A new command with a variable-length collection needs its own test beside these two. Raising the
frame cap is the other option and it has a cost: it's also how much a socket that hasn't sent
`Hello` yet may push. That's acceptable behind a tunnel with a DM secret, and the reasoning is
written at the constant.

## The two copies of the union

`ClientMsg` and `ServerMsg` are written out by hand twice, in `server/src/protocol.rs` and
`client/src/protocol.ts`, and neither is generated from the other. That follows from having no real
build step, and it can fail: a variant added on one side and forgotten on the other.

It used to fail silently. The server logs `discarding unparseable frame` at `warn` and carries on.
The client's `default:` arm called `console.warn`, and `cdp.mjs` collects only `error` console
entries, so a protocol mismatch made every browser driver do nothing at all instead of failing. That
arm is now `console.error`, so an unknown frame fails whichever driver is running.

`protocol-tags.json` at the repo root is the third copy, and both sides are checked against it. On
each side the local compiler does the enforcing:

- Rust has an exhaustive `match` per union with no wildcard, so the crate won't compile until a new
  variant is named. **There's also a second list beside it**, `KNOWN_CLIENT_TAGS` and
  `KNOWN_SERVER_TAGS`, and that list is what's compared with the fixture. Naming a variant in the
  `match` alone compiles and then fails the test with "protocol-tags.json names a client tag the
  server does not have". The message points at the fixture, but the const is what's missing.
- TypeScript has `Record<Msg['type'], true>` (in `protocol.test.ts`), so the typecheck fails until a
  new variant is named.

A test on each side then asserts its list matches the fixture. A variant added in one language only
fails that language's build; a variant added to both without the fixture fails both tests.

This checks variants only. A renamed or dropped field keeps its tag and passes every check here.
What catches that is the server rejecting the frame at runtime, which now fails a driver. Closing
the gap would take a sample payload per variant or real codegen. Neither is built, and the fixture's
header says so.
