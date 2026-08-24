// The "which room?" overlay, and the list it is built from.
//
// `picker.ts`'s neighbour rather than a generalisation of it, which is the call
// `dock.ts` makes against `rail.ts` in `docs/frontend.md` for the same kind of
// reason: the two overlays share their CSS and nothing else. A room is not a
// slot — nothing can claim one, so there is no `claimed` to dim and no reason
// for a picker that serves both to carry a flag saying which it is today.
//
// It comes before the socket, because a socket belongs to a room from the
// moment it opens. That is why the list is fetched over HTTP: see
// `room_listing` in server/src/main.rs.

/** One room, as `/api/rooms` reports it. */
export interface RoomChoice {
  id: string;
  name: string;
}

export interface RoomPicker {
  show(rooms: RoomChoice[]): void;
  hide(): void;
}

/**
 * Every room on this server.
 *
 * No DM secret: this is the one route under `/api` a player may call, because
 * the picker cannot be drawn without it and a player has no credential to
 * offer. A failure here is fatal to the page in the plainest way — there is
 * nothing to connect to without a room — so it throws rather than answering
 * with an empty list, which would render as a picker with no choices on it and
 * no explanation.
 */
export async function fetchRooms(): Promise<RoomChoice[]> {
  const response = await fetch('/api/rooms');
  if (!response.ok) throw new Error(`could not list the rooms: ${response.status}`);
  const rooms = (await response.json()) as RoomChoice[];
  if (rooms.length === 0) throw new Error('the server has no rooms');
  return rooms;
}

export function createRoomPicker(root: HTMLElement, onPick: (roomId: string) => void): RoomPicker {
  const list = root.querySelector<HTMLElement>('.picker-list');
  if (list === null) throw new Error('#room-picker is missing its .picker-list');

  return {
    show(rooms) {
      list.replaceChildren(
        ...rooms.map((room) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'picker-choice';

          const name = document.createElement('span');
          name.textContent = room.name;
          button.append(name);

          button.addEventListener('click', () => onPick(room.id), { once: true });
          return button;
        }),
      );
      root.hidden = false;
    },

    hide() {
      root.hidden = true;
      list.replaceChildren();
    },
  };
}
