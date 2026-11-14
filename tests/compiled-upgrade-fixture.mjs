// Build entrypoint of the scratch binaries in lib/compiled-upgrade.integration.test.mjs; never shipped or imported by
// product code. Only delivery is replaced: when OMPWEB_UPGRADE_FIXTURE names a fixture map, the npm registry,
// raw-GitHub, release-metadata and release-asset requests are answered from it before the real server/binary.ts
// (server, host, update worker, preflight, GUI API) is loaded. The map is read per request/process, so its path in the
// environment survives every restart the update performs.
import { readFileSync } from "node:fs";
import packageJson from "../package.json";

const mapPath = process.env.OMPWEB_UPGRADE_FIXTURE;
if (mapPath) {
  const map = () => JSON.parse(readFileSync(mapPath, "utf8"));
  // A candidate whose web server cannot start: the real update worker must put the previous release back.
  if (map().failServerStart === packageJson.version && process.argv.includes("--no-open")) {
    console.error(`fixture: server ${packageJson.version} refuses to start`);
    process.exit(3);
  }
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    // Loopback traffic (host links, the GUI API) is real; nothing else may reach the network.
    if (url.protocol !== "https:") return realFetch(input, init);
    const release = (version) => map().releases?.[version];
    const text = (body) => (body === undefined ? new Response("not found", { status: 404 }) : new Response(body));
    let match;
    if (url.hostname === "registry.npmjs.org") return Response.json({ version: map().latest });
    if (url.hostname === "raw.githubusercontent.com" && (match = /^\/[^/]+\/[^/]+\/v([^/]+)\/lib\/hosts\/link-protocol\.ts$/.exec(url.pathname))) {
      return text(release(match[1])?.linkProtocol);
    }
    if (url.hostname === "api.github.com" && (match = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/v([^/]+)$/.exec(url.pathname))) {
      const metadata = release(match[1])?.metadata;
      return text(metadata && JSON.stringify(metadata));
    }
    if (url.hostname === "github.com" && (match = /^\/[^/]+\/[^/]+\/releases\/download\/v([^/]+)\/([^/]+)$/.exec(url.pathname))) {
      const file = release(match[1])?.assets?.[match[2]];
      return file ? new Response(Bun.file(file)) : text(undefined);
    }
    throw new Error(`fixture: unexpected network request ${url}`);
  };
}

await import("../server/binary.ts");
