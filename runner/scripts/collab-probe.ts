// Collab guest probe: joins a live omp collab host found in the local registry and prints its frames.
//
//   bun scripts/collab-probe.ts [instanceId|pid]
//
// stdin lines: `prompt <text>`, `answer <reqId> <value>`, `abort`.
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { listCollabHosts, resolveCollabHostLink } from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";

const hosts = await listCollabHosts();
console.log("hosts", JSON.stringify(hosts.map(h => ({ id: h.instanceId, pid: h.pid, session: h.sessionId, cwd: h.cwd }))));
const selector = process.argv[2] ?? hosts[0]?.instanceId;
if (!selector) throw new Error("no live collab host");

const { url } = await resolveCollabHostLink(selector, "control");
const link = parseCollabLink(url);
if ("error" in link) throw new Error(link.error);

const socket = new CollabSocket({ wsUrl: link.wsUrl, role: "guest", key: await importRoomKey(link.key) });
socket.onOpen = () =>
	socket.send({
		t: "hello",
		proto: COLLAB_PROTO,
		name: "ompweb-probe",
		writeToken: link.writeToken && Buffer.from(link.writeToken).toString("base64url"),
	});
socket.onFrame = frame => {
	const text = JSON.stringify(frame);
	console.log(frame.t, text.length > 400 ? `${text.slice(0, 400)}…` : text);
};
socket.onClose = (reason, willReconnect) => console.log("close", reason, { willReconnect });
socket.connect();

for await (const line of console) {
	const [cmd, ...rest] = line.trim().split(" ");
	if (cmd === "prompt") socket.send({ t: "prompt", text: rest.join(" ") });
	else if (cmd === "abort") socket.send({ t: "abort" });
	else if (cmd === "answer") socket.send({ t: "ui-response", reqId: Number(rest[0]), value: rest.slice(1).join(" ") });
}
