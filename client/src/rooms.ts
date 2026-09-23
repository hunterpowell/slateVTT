// The "which room?" overlay, and the list it is built from.
//
// A separate module from `picker.ts`, not a generalisation of it, as `dock.ts`
// is separate from `rail.ts` (see `docs/frontend.md`). The two overlays share
// their CSS and nothing else. A room isn't a slot: nothing can claim one, so
// there is no `claimed` to dim, and a shared picker would need a flag saying
// which list it is showing.
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
 * the picker can't be drawn without it and a player has no credential. A
 * failure here is fatal to the page, since there is nothing to connect to
 * without a room. So it throws instead of returning an empty list, which would
 * render as a picker with no choices and no explanation.
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
