import { createHostControlServer, requestHostControl } from "./host-control";
import type { HostDaemon } from "./daemon";

// `ompweb host`: link this machine to web servers through ./daemon.
// Loaded by Node/jiti and the compiled binary: no `@/` imports.
// Tokens are read from stdin, never from argv.
import { addHostLink, loginHost, readHostLinks, removeHostLink } from "./host-login";

const USAGE = "Usage: ompweb host login [--add] --url <server url>   (the host token is read from stdin)\n       ompweb host logout --url <server url>\n       ompweb host [--allow-http]\n       ompweb host status|drain|resume";

/** A host token is 43 characters; anything this long is not one. */
const MAX_TOKEN_LINE_BYTES = 4096;

/** The first line on stdin: the token never appears in argv, where `ps` would show it. */
function readTokenLine(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("Paste the host token, then press Enter: ");
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    data += chunk;
    const newline = data.indexOf("\n");
    const line = newline === -1 ? data : data.slice(0, newline);
    if (Buffer.byteLength(line) > MAX_TOKEN_LINE_BYTES) {
      process.stdin.pause();
      reject(new Error(`the host token line is longer than ${MAX_TOKEN_LINE_BYTES} bytes`));
    } else if (newline !== -1) {
      process.stdin.pause();
      resolve(line);
    }
  });
  process.stdin.on("end", () => resolve(data));
  return promise;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "login" || argv[0] === "logout") {
    const add = argv[0] === "login" && argv.includes("--add");
    const args = add ? argv.filter((arg) => arg !== "--add") : argv;
    if (args.length !== 3 || args[1] !== "--url" || !args[2] || args[2].startsWith("--") || argv.length !== (add ? 4 : 3)) {
      console.error(USAGE);
      return 2;
    }
    const url = args[2];
    if (argv[0] === "logout") {
      await removeHostLink(url);
      console.log(`Removed the link to ${url}.`);
    } else {
      const link = { url, token: (await readTokenLine()).trim() };
      if (add) await addHostLink(link);
      else await loginHost(link);
      console.log(`Saved. Run \`ompweb host\` to link this machine to ${url}.`);
    }
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "status" || argv[0] === "drain" || argv[0] === "resume")) {
    // Local controls never load or start a second daemon.
    console.log(JSON.stringify(await requestHostControl(argv[0])));
    return 0;
  }


  if (argv.some((arg) => arg !== "--allow-http")) {
    console.error(USAGE);
    return 2;
  }
  if (readHostLinks().length === 0) {
    console.error("This machine is not linked yet. Start ompweb on this machine (it writes the link), or run `ompweb host login --url <server url>`.");
    return 1;
  }
  // Login/logout need none of the daemon, which jiti would otherwise transpile on every run.
  const [{ runHostDaemon }, { hostSocketPath }, { ensureOmpRunner }] = await Promise.all([import("./daemon"), import("./omp-socket"), import("../omp/runner-fetch")]);
  // Sessions need the runner; until it is here they fail with OMP_NOT_FOUND and the next start retries.
  void ensureOmpRunner().catch((error: unknown) => console.error(`ompweb host: ${error instanceof Error ? error.message : String(error)}`));
  let daemon: HostDaemon | undefined;
  const endpoint = await createHostControlServer((command) => {
    if (!daemon) throw new Error("The host daemon is starting");
    return daemon.control(command);
  });
  try {
    // Windows has no host socket yet (a current-user named pipe is open in the runner spec).
    daemon = runHostDaemon({ allowHttp: argv.includes("--allow-http"), hostSocket: process.platform === "win32" ? undefined : hostSocketPath() });
    // Worker cutover starts fail-closed; ordinary hosts have no maintenance environment.
    if (process.env.OMP_WEB_HOST_DRAINED === "1") daemon.control("drain");
    const stop = () => void daemon!.stop();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
    try { return await daemon.done; }
    finally { for (const signal of ["SIGINT", "SIGTERM"] as const) process.removeListener(signal, stop); }
  } finally {
    await daemon?.stop();
    await endpoint?.close();
  }
}

/** `ompweb host <argv>`: the exit code; errors are printed, never thrown. */
export function runHostCli(argv: string[]): Promise<number> {
  return main(argv).catch((error: unknown) => {
    console.error(`ompweb host: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  });
}
