// `ompweb host`: link this machine to a main omp-web so sessions can run here (./daemon). Run by
// bin/omp-web-host.js (Node, through jiti) and by the compiled binary (server/binary.ts): no `@/` imports.
//   ompweb host login --url <url>   reads the host token from stdin
//   ompweb host [--allow-http]      dials the saved server and keeps the link up (http:// is accepted without the flag for loopback)
import { loginHost, readHostLogin } from "./host-login";

const USAGE = "Usage: ompweb host login --url <server url>   (the host token is read from stdin)\n       ompweb host [--allow-http]";

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
  if (argv[0] === "login") {
    const urlIndex = argv.indexOf("--url");
    const url = urlIndex === -1 ? undefined : argv[urlIndex + 1];
    if (!url || argv.length !== 3) {
      console.error(USAGE);
      return 2;
    }
    loginHost({ url, token: (await readTokenLine()).trim() });
    console.log(`Saved. Run \`ompweb host\` to link this machine to ${url}.`);
    return 0;
  }

  if (argv.some((arg) => arg !== "--allow-http")) {
    console.error(USAGE);
    return 2;
  }
  const login = readHostLogin();
  if (!login) {
    console.error("This machine is not linked yet. Start ompweb on this machine (it writes the link), or run `ompweb host login --url <server url>`.");
    return 1;
  }
  // Loaded here, not at the top: `login` needs none of the daemon, which jiti would otherwise transpile on every run.
  const { runHostDaemon } = await import("./daemon");
  const daemon = runHostDaemon({ ...login, allowHttp: argv.includes("--allow-http") });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void daemon.stop());
  return daemon.done;
}

/** `ompweb host <argv>`: the exit code; errors are printed, never thrown. */
export function runHostCli(argv: string[]): Promise<number> {
  return main(argv).catch((error: unknown) => {
    console.error(`ompweb host: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  });
}
