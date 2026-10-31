import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
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

export function isTailscaleIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part)) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isCandidateAddress(address: string): boolean {
  if (address.startsWith("127.") || address.startsWith("169.254.") || /^198\.(18|19)\./.test(address)) return false;
  return address.split(".").length === 4;
}

/**
 * Addresses to type into the app: Tailscale first (MagicDNS, then 100.64/10
 * addresses), then other non-internal IPv4s. No loopback: a phone cannot use it.
 */
export function candidateAddresses({
  interfaces,
  port,
  magicDnsName,
}: {
  interfaces: ReturnType<typeof networkInterfaces>;
  port: number;
  magicDnsName?: string | null;
}): MobileAddress[] {
  const magic = magicDnsName?.trim().replace(/\.$/, "");
  const magicdn: MobileAddress[] = magic ? [{ url: `http://${magic}:${port}`, label: "magicdns" }] : [];
  const tailscale: MobileAddress[] = [];
  const lan: MobileAddress[] = [];
  const seen = new Set<string>();
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      // `family` is "IPv4" on modern Node and 4 on older versions.
      if (info.family !== "IPv4" && String(info.family) !== "4") continue;
      if (info.internal || seen.has(info.address) || !isCandidateAddress(info.address)) continue;
      seen.add(info.address);
      const entry = { url: `http://${info.address}:${port}`, label: "tailscale" as const };
      if (isTailscaleIpv4(info.address) || name.toLowerCase().includes("tailscale")) tailscale.push(entry);
      else lan.push({ url: `http://${info.address}:${port}`, label: "lan" });
    }
  }
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
 * `scrypt$…` stands for the output of `ompweb hash-password` (stdin, so it
 * never reaches the shell history or `ps`).
 */
export function mobileAccessMethods(): MobileAccessMethod[] {
  return [
    {
      id: "cli",
      commands: [
        "ompweb hash-password",
        "OMP_WEB_PASSWORD_HASH='scrypt$…' ompweb -H 0.0.0.0",
      ],
    },
    {
      id: "windowsTray",
      commands: [
        "ompweb hash-password",
        "setx OMP_WEB_PASSWORD_HASH \"scrypt$…\"",
        "ompweb --install-tray -H 0.0.0.0",
      ],
    },
    {
      id: "systemd",
      commands: [
        "OMP_WEB_HOSTNAME=0.0.0.0 OMP_WEB_PASSWORD='…' ompweb-systemd install",
      ],
    },
    {
      id: "launchd",
      commands: [
        "OMP_WEB_HOSTNAME=0.0.0.0 OMP_WEB_PASSWORD='…' ompweb-launchd install",
      ],
    },
  ];
}
