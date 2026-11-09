import { execFile } from "node:child_process";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getAccessibleAddresses, isTailscaleAddress, isWildcardHost } from "../bin/network-addresses";
import { createChildProcessEnvironment } from "./project-command-env";

/**
 * Read-only data for Settings → Mobile app: how the server is bound, whether a
 * password is configured, which addresses a phone can type in, and the exact
 * commands that expose an installed server to the network.
 *
 * The endpoint never changes the binding and never returns a credential — only
 * whether a password hash is configured.
 */

export type MobileExposure = "loopback" | "network" | "unknown";
export type MobileAddressLabel = "magicdns" | "tailscale" | "lan";

export interface MobileAddress {
  url: string;
  label: MobileAddressLabel;
}

export interface MobileAccessMethod {
  id: "cli" | "windowsTray" | "systemd" | "launchd";
  commands: string[];
}

export const DEFAULT_MOBILE_PORT = 30177;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1", "[0:0:0:0:0:0:0:1]"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0", "[0:0:0:0:0:0:0:0]", ""]);

export function parseMobilePort(value: unknown): number | null {
  const port = typeof value === "number" ? value : typeof value === "string" && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Next.js `-H/--hostname` is the only launch-time bind information a route can see. */
export function detectBindHostname(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): string | null {
  const fromEnv = env.OMP_WEB_HOSTNAME?.trim();
  if (fromEnv) return fromEnv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-H" || arg === "--hostname") {
      const value = argv[i + 1]?.trim();
      if (value) return value;
    }
    if (arg.startsWith("--hostname=")) {
      const value = arg.slice("--hostname=".length).trim();
      if (value) return value;
    }
  }
  return null;
}

export function classifyExposure(hostname: string | null): MobileExposure {
  if (hostname === null) return "unknown";
  const host = hostname.trim().toLowerCase();
  if (WILDCARD_HOSTS.has(host)) return "network";
  if (host.startsWith("127.") || LOOPBACK_HOSTS.has(host)) return "loopback";
  return "network";
}

/**
 * The map `os.networkInterfaces()` returns, named so callers and tests do not
 * have to spell out (or infer) the Node type at every call site.
 */
export type NetworkInterfaceMap = Record<string, NetworkInterfaceInfo[] | undefined>;

/**
 * Addresses to type into the app, from the same binding-aware enumeration the
 * launcher prints (`bin/network-addresses.js`): a specific-IP bind yields that
 * one address, a loopback bind yields none a phone can use, and a wildcard
 * bind yields the interface addresses. Duplicating the enumeration here once
 * offered six interface addresses for a single-IP bind.
 *
 * Two deliberate differences from the launcher's list:
 *
 *  - The `Local` entry (`http://localhost:…`) is dropped: a phone cannot reach
 *    this machine's loopback, and the card is addressed to a phone.
 *  - Tailscale addresses come before LAN ones. The launcher prints LAN first
 *    because that is the common case for a browser; a phone that is away from
 *    home needs the Tailscale address, so it is listed first here.
 *
 * MagicDNS is advertised only when the bind actually covers the Tailscale
 * address: a wildcard bind listens on every interface, and a specific-IP bind
 * does so only when that IP is itself the Tailscale address. A socket bound to
 * a LAN IP does not listen on the Tailscale IP, so the MagicDNS name would
 * resolve to an address nothing is listening on.
 */
export function candidateAddresses({
  hostname,
  port,
  magicDnsName,
  interfaces = networkInterfaces(),
}: {
  hostname: string | null;
  port: number;
  magicDnsName?: string | null;
  interfaces?: NetworkInterfaceMap;
}): MobileAddress[] {
  // `null` means the launch flags were not visible. The default bind is
  // loopback, so listing interface addresses would advertise a reachability
  // this server may not have; the card says "unknown" and shows no address.
  const { entries, hint } = getAccessibleAddresses({ hostname: hostname ?? "127.0.0.1", port, interfaces });
  // The helper's hint is its own "not exposed to the network" signal (it is
  // set for a loopback bind). Nothing it lists is reachable from a phone then,
  // MagicDNS included: that name resolves to an address this server is not
  // listening on. The card's network hint tells the user to rebind instead.
  if (hint) return [];
  const tailscale: MobileAddress[] = [];
  const lan: MobileAddress[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.url)) continue;
    // `Local` is loopback: right for the browser, unreachable from a phone.
    if (entry.label === "Local") continue;
    seen.add(entry.url);
    // The helper labels a Tailscale address by interface or CGNAT range; both
    // arrive as "Tailscale". Everything else is a bound name or a LAN address.
    if (entry.label === "Tailscale") tailscale.push({ url: entry.url, label: "tailscale" });
    else lan.push({ url: entry.url, label: "lan" });
  }
  // The bind covers the Tailscale address when it listens on every interface,
  // or when the specific IP it is bound to is the Tailscale address itself.
  const coversTailscale = isWildcardHost(hostname)
    || (typeof hostname === "string" && isTailscaleAddress(undefined, hostname.trim()));
  const magic = coversTailscale ? magicDnsName?.trim().replace(/\.$/, "") : undefined;
  const magicdn: MobileAddress[] = magic ? [{ url: `http://${magic}:${port}`, label: "magicdns" }] : [];
  return [...magicdn, ...tailscale, ...lan];
}

/** Never throw: `tailscale status --json` is optional and time-boxed. */
export function parseMagicDns(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || !("Self" in parsed)) return null;
    const self = parsed.Self;
    if (!self || typeof self !== "object" || !("DNSName" in self)) return null;
    const dnsName = self.DNSName;
    if (typeof dnsName !== "string") return null;
    const name = dnsName.trim().replace(/\.$/, "");
    return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

let magicDnsCache: { at: number; name: string | null } | undefined;

/**
 * Fixed install locations only. A PATH lookup would run whatever a project, an
 * npm `bin` directory or `~/.local/bin` provides — with this server's
 * environment — so a `tailscale` there could read the web password hash from
 * `process.env` and forward it. Without one of these paths, Settings → Mobile
 * app simply shows no MagicDNS name (the address list still works).
 */
export function tailscaleBinary(): string | null {
  const candidates = process.platform === "win32"
    ? [
        join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe"),
        join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale IPN", "tailscale.exe"),
      ]
    : [
        "/usr/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        // The macOS app ships the CLI inside the bundle and installs no symlink.
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // An unreadable candidate is simply not one.
    }
  }
  return null;
}

/** MagicDNS name of this machine, cached for a minute. Absent binary → null without spawning. */
export async function probeMagicDnsName(timeoutMs = 1500): Promise<string | null> {
  if (magicDnsCache && Date.now() - magicDnsCache.at < 60_000) return magicDnsCache.name;
  const binary = tailscaleBinary();
  if (!binary) {
    magicDnsCache = { at: Date.now(), name: null };
    return null;
  }
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(binary, ["status", "--json"], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    // The child never sees omp-web's own secrets (issue #239).
    env: createChildProcessEnvironment(),
  }, (error, stdout) => {
    resolve(error ? null : parseMagicDns(stdout));
  });
  const name = await promise;
  magicDnsCache = { at: Date.now(), name };
  return name;
}

/**
 * Exact commands from the installers and `ompweb --help`; nothing invented.
 *
 * No command line carries a secret, and no secret is echoed. `ompweb
 * hash-password` reads the password at a hidden prompt and prints the hash;
 * every flow pastes that hash into a *hidden* prompt (`read -rs`, `Read-Host
 * -AsSecureString`) and hands it to the next command through the environment,
 * so neither the password nor the hash lands in the shell history or in `ps`.
 * All four installers accept `OMP_WEB_PASSWORD_HASH` directly, so the
 * plaintext never has to be exported at all.
 */
export function mobileAccessMethods(): MobileAccessMethod[] {
  // The prompt is printed by `printf`, not by `read -p`: on macOS the default
  // shell is zsh, where `read -p` reads from a coprocess instead of printing a
  // prompt and the whole sequence fails with `read: -p: no coprocess`. `-r`
  // and `-s` mean the same in bash and zsh, so this sequence works in either.
  // `-s` keeps the input off the terminal; `echo` ends the line the hidden
  // prompt left open. The value goes into the environment, never into argv.
  const readHash = "printf 'OMP_WEB_PASSWORD_HASH: ' && read -rs OMP_WEB_PASSWORD_HASH && export OMP_WEB_PASSWORD_HASH && echo";
  return [
    {
      id: "cli",
      commands: [
        "ompweb hash-password",
        readHash,
        "ompweb -H 0.0.0.0",
      ],
    },
    {
      id: "windowsTray",
      commands: [
        "ompweb hash-password",
        // User scope is what the service script reads at logon; the session
        // variable makes the same value visible to the command below.
        "$s = Read-Host -AsSecureString 'OMP_WEB_PASSWORD_HASH'; $h = [Net.NetworkCredential]::new('', $s).Password; [Environment]::SetEnvironmentVariable('OMP_WEB_PASSWORD_HASH', $h, 'User'); $env:OMP_WEB_PASSWORD_HASH = $h",
        "ompweb --install-tray -H 0.0.0.0",
      ],
    },
    {
      id: "systemd",
      commands: [
        "ompweb hash-password",
        readHash,
        "OMP_WEB_HOSTNAME=0.0.0.0 ompweb-systemd install",
      ],
    },
    {
      id: "launchd",
      commands: [
        "ompweb hash-password",
        readHash,
        "OMP_WEB_HOSTNAME=0.0.0.0 ompweb-launchd install",
      ],
    },
  ];
}
