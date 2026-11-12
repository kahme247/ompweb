// Control-channel probe: stands in for `ompweb host` on the host socket.
//
//   bun scripts/host-probe.ts
//
// stdin lines are sent to every connected omp as `{t:"cmd", id, op, args}`: `get_state`,
// `set_model <provider> <modelId>`.
import * as fs from "node:fs";
import * as path from "node:path";
import { hostSocketPath } from "../src/control";

const socketPath = hostSocketPath();
fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
fs.rmSync(socketPath, { force: true });

const clients = new Set<Bun.Socket>();
Bun.listen({
	unix: socketPath,
	socket: {
		open: socket => void clients.add(socket),
		close: socket => void clients.delete(socket),
		data: (_socket, data) => void process.stdout.write(`omp> ${data}`),
	},
});
fs.chmodSync(socketPath, 0o600);
console.log(`listening on ${socketPath}`);

let id = 0;
for await (const line of console) {
	const [op, ...args] = line.trim().split(" ");
	const cmd = op === "set_model" ? { t: "cmd", id: ++id, op, args: { provider: args[0], modelId: args[1] } } : { t: "cmd", id: ++id, op };
	for (const client of clients) client.write(`${JSON.stringify(cmd)}\n`);
}
