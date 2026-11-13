// Channel probe: stands in for `ompweb host` on the host socket and prints what omp sends.
//
//   bun scripts/host-probe.ts
//
// stdin lines go to every connected omp: `get_state`, `set_model <provider> <modelId>`,
// `prompt <text>`, `abort`, `answer <uiId> <json value>`.
import * as fs from "node:fs";
import * as path from "node:path";
import { hostSocketPath } from "../src/channel";

const socketPath = hostSocketPath();
fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
fs.rmSync(socketPath, { force: true });

const clients = new Set<Bun.Socket>();
let buffered = "";
Bun.listen({
	unix: socketPath,
	socket: {
		open: socket => void clients.add(socket),
		close: socket => void clients.delete(socket),
		data: (_socket, data) => {
			buffered += data.toString();
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				const message = JSON.parse(line);
				// Streaming deltas would flood the probe; their message_end carries the result.
				if (message.t === "event" && message.event.type === "message_update") continue;
				console.log(`omp> ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
			}
		},
	},
});
fs.chmodSync(socketPath, 0o600);
console.log(`listening on ${socketPath}`);

let id = 0;
for await (const line of console) {
	const [op = "", ...rest] = line.trim().split(" ");
	const text = rest.join(" ");
	const message =
		op === "answer"
			? { t: "ui_response", id: Number(rest[0]), value: JSON.parse(rest.slice(1).join(" ")) }
			: op === "set_model"
				? { t: "cmd", id: ++id, op, args: { provider: rest[0], modelId: rest[1] } }
				: op === "prompt"
					? { t: "cmd", id: ++id, op, args: { text } }
					: { t: "cmd", id: ++id, op };
	for (const client of clients) client.write(`${JSON.stringify(message)}\n`);
}
