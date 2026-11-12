/**
 * Loopback collab relay: the room contract omp's collab clients expect (`wss://my.omp.sh`
 * semantics, mirrored from omp's `collab-web/scripts/local-relay.ts`).
 *
 * - `GET /r/<roomId>?role=host|guest` upgrades to a WebSocket; a second host gets 4009, a guest
 *   joining a missing room 4004.
 * - Host binary frames: envelope peerId 0 broadcasts to every guest, peerId N targets guest N.
 * - Guest binary frames: the envelope peerId is rewritten to the sender's, then forwarded to the host.
 * - TEXT control to the host: `peer-joined` / `peer-left`; host disconnect sends `room-closed` and 4001.
 *
 * Payloads stay sealed end to end; the relay never sees plaintext.
 */
import { rewriteEnvelopePeer, unpackEnvelope } from "@oh-my-pi/pi-wire";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	peerId: number;
}
type RelaySocket = Bun.ServerWebSocket<SocketData>;
interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

export interface Relay {
	/** `ws://127.0.0.1:<port>`; collab hosts take it as `collab.relayUrl`. */
	url: string;
	stop(): void;
}

function closeRoom(room: Room): void {
	const closure = JSON.stringify({ t: "room-closed" });
	for (const guest of room.guests.values()) {
		guest.send(closure);
		guest.close(4001, "room closed");
	}
	room.guests.clear();
}

export function startRelay(port = 0): Relay {
	const rooms = new Map<string, Room>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		fetch(req, srv): Response | undefined {
			const url = new URL(req.url);
			const match = ROOM_PATH_RE.exec(url.pathname);
			const role = url.searchParams.get("role");
			if (!match || (role !== "host" && role !== "guest")) return new Response("not found", { status: 404 });
			if (srv.upgrade(req, { data: { roomId: match[1]!, role, peerId: 0 } satisfies SocketData })) return undefined;
			return new Response("websocket upgrade required", { status: 426 });
		},
		websocket: {
			open(ws: RelaySocket): void {
				const { roomId, role } = ws.data;
				if (role === "host") {
					if (rooms.has(roomId)) return ws.close(4009, "a host is already connected for this room");
					rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
					return;
				}
				const room = rooms.get(roomId);
				if (!room) return ws.close(4004, "no such room");
				ws.data.peerId = room.nextPeerId++;
				room.guests.set(ws.data.peerId, ws);
				room.host.send(JSON.stringify({ t: "peer-joined", peer: ws.data.peerId }));
			},
			message(ws: RelaySocket, message: string | Buffer): void {
				if (typeof message === "string") return; // clients never send TEXT
				const room = rooms.get(ws.data.roomId);
				if (!room) return;
				if (ws.data.role === "host") {
					const envelope = unpackEnvelope(message);
					if (!envelope) return;
					if (envelope.peerId === 0) for (const guest of room.guests.values()) guest.send(message);
					else room.guests.get(envelope.peerId)?.send(message);
					return;
				}
				if (message.byteLength < 4) return;
				rewriteEnvelopePeer(message, ws.data.peerId);
				room.host.send(message);
			},
			close(ws: RelaySocket): void {
				const { roomId, role, peerId } = ws.data;
				const room = rooms.get(roomId);
				if (!room) return;
				if (role === "host") {
					if (room.host !== ws) return; // a rejected second host does not own the room
					rooms.delete(roomId);
					closeRoom(room);
					return;
				}
				if (room.guests.delete(peerId)) room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		stop(): void {
			for (const room of rooms.values()) {
				closeRoom(room);
				room.host.close(1001, "relay shutting down");
			}
			rooms.clear();
			server.stop(true);
		},
	};
}

if (import.meta.main) {
	const relay = startRelay(Number(process.argv[2] ?? 7466));
	console.log(`relay listening on ${relay.url}`);
}
