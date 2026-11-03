// Disposable releases for the host-update tests: a copy of the repo's real update modules, whose host calls the
// production acknowledgeHostUpdateHealth() exactly as the daemon does on its welcome. No test writes a health marker
// for a host that is meant to succeed.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = fileURLToPath(new URL("../../", import.meta.url));
export const repoVersion = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
export const jitiPath = createRequire(import.meta.url).resolve("jiti");
const RELEASE_MODULES = [
  "lib/hosts/updates.ts",
  "lib/hosts/update-worker.ts",
  "lib/hosts/update-types.ts",
  "lib/npm-update.ts",
  "lib/update-policy.ts",
  "lib/self-update.ts",
  "lib/project-command-env.ts",
  "lib/omp/updates.ts",
  "lib/omp/omp-cli.ts",
];

export function nodeBinary() {
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
  throw new Error("node is required on PATH for the host update tests");
}

function hostScript(kind) {
  if (kind === "exit") return "process.exit(4);\n";
  if (kind === "wrong-version") {
    // A daemon that acknowledges a version other than the one being installed.
    return `const fs=require("node:fs"),path=require("node:path");
const root=path.join(process.env.PI_CODING_AGENT_DIR,"omp-web","host-update");
const id=JSON.parse(fs.readFileSync(path.join(root,"status.json"),"utf8")).operation.id;
fs.writeFileSync(path.join(root,id,"health.json"),JSON.stringify({id,version:"0.0.1",pid:process.pid}),{mode:0o600});
setInterval(()=>{},1000);
`;
  }
  if (kind === "forged-ack") {
    // A candidate that never acknowledges and dies, while another live process (its parent, the worker) seems to vouch for it.
    return `const fs=require("node:fs"),path=require("node:path");
const root=path.join(process.env.PI_CODING_AGENT_DIR,"omp-web","host-update");
const {id,version}=JSON.parse(fs.readFileSync(path.join(root,"status.json"),"utf8")).operation;
fs.writeFileSync(path.join(root,id,"health.json"),JSON.stringify({id,version,pid:process.ppid}),{mode:0o600});
setTimeout(()=>process.exit(5),1000);
`;
  }
  return `const path=require("node:path");
require(${JSON.stringify(jitiPath)}).createJiti(__filename).import(path.join(__dirname,"..","lib","hosts","updates.ts")).then((api)=>{api.acknowledgeHostUpdateHealth();setInterval(()=>{},1000);},(error)=>{console.error(error);process.exit(3);});
`;
}

/** `kind`: "ack" (production health acknowledgement), "exit" (dies at launch), "wrong-version" (acknowledges 0.0.1),
 * "forged-ack" (another live process acknowledges for it, then it dies). */
export function writeRelease(dir, version, kind = "ack", { binary = false } = {}) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  for (const file of RELEASE_MODULES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(repo, file), join(dir, file));
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version }));
  writeFileSync(join(dir, "bin", "omp-web-host.js"), hostScript(kind));
  writeFileSync(join(dir, "bin", "idle-web.js"), "setInterval(()=>{},1000);\n");
  if (!binary) return;
  // The compiled release: an executable that answers --version and otherwise runs this release's host.
  mkdirSync(join(dir, "dist"), { recursive: true });
  mkdirSync(join(dir, "lib", "omp"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), `static files ${version}`);
  writeFileSync(join(dir, "lib", "omp", "session-edit-extension.mjs"), `// extension ${version}`);
  writeFileSync(join(dir, "ompweb"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexec "${nodeBinary()}" "$(dirname "$0")/bin/omp-web-host.js"\n`, { mode: 0o755 });
  chmodSync(join(dir, "ompweb"), 0o755);
}

/** A stand-in for npm/bun: refuses anything but the exact pinned package, then "installs" releaseDir. */
export function writeManager(dir, { method, version, releaseDir, dependenciesDir, webDuringInstall }) {
  const script = join(dir, "manager.cjs");
  const flag = method === "bun" ? "--cwd" : "--prefix";
  writeFileSync(script, `#!/usr/bin/env node
const fs=require("node:fs"),p=require("node:path"),cp=require("node:child_process");
const a=process.argv.slice(2);const prefix=a[a.indexOf(${JSON.stringify(flag)})+1];
if(!a.includes(${JSON.stringify(`@kahme247/ompweb@${version}`)}))process.exit(8);
if(fs.existsSync(${JSON.stringify(dependenciesDir)}))fs.cpSync(${JSON.stringify(dependenciesDir)},p.join(prefix,"node_modules"),{recursive:true});
fs.cpSync(${JSON.stringify(releaseDir)},p.join(prefix,"node_modules","@kahme247","ompweb"),{recursive:true});
${webDuringInstall ? `const web=cp.spawn(process.execPath,[${JSON.stringify(webDuringInstall.script)}],{detached:true,stdio:"ignore"});fs.writeFileSync(${JSON.stringify(webDuringInstall.pidFile)},String(web.pid));web.unref();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);` : ""}
`, { mode: 0o700 });
  chmodSync(script, 0o700);
  if (process.platform !== "win32") return script;
  const launcher = join(dir, "manager.cmd");
  writeFileSync(launcher, `@echo off\r\n"${nodeBinary()}" "${script}" %*\r\n`);
  return launcher;
}

function directoryFiles(dir, prefix) {
  const files = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[`${prefix}/${relative(dir, path).split(sep).join("/")}`] = { data: readFileSync(path), mode: statSync(path).mode & 0o777 };
    }
  };
  walk(dir);
  return files;
}

/** A ustar archive of `files` ({ name: string | { data, mode } }). */
export function tarArchive(files) {
  const chunks = [];
  for (const [name, value] of Object.entries(files)) {
    const { data, mode } = typeof value === "string" || Buffer.isBuffer(value) ? { data: Buffer.from(value), mode: 0o644 } : value;
    if (Buffer.byteLength(name) > 100) throw new Error(`tar member name too long: ${name}`);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

/** The release archive of a writeRelease(..., { binary: true }) directory, rooted at `rootName`. */
export function releaseArchive(dir, rootName) {
  return tarArchive(directoryFiles(dir, rootName));
}

/** True when this process is inside a systemd service, where the engine (correctly) refuses to guess the unit. */
export function insideSystemdService() {
  try {
    return readFileSync("/proc/self/cgroup", "utf8").split("\n").some((line) => (line.startsWith("0::") || line.includes(":name=systemd:")) && line.split("/").at(-1)?.trim().endsWith(".service"));
  } catch { return false; }
}

/** Starts `node script` outside any service unit (a transient scope when this process runs in one); null when no scope can be made. */
export async function spawnNodeOutsideService(script, env) {
  const stdio = ["ignore", "pipe", "pipe"];
  if (process.platform === "win32") {
    // The engine restarts only a Windows host started from an interactive shell: type the command into a plain cmd.exe.
    const shell = spawn(process.env.ComSpec || "cmd.exe", [], { env, stdio: ["pipe", "pipe", "pipe"] });
    shell.stdin.end(`"${nodeBinary()}" "${script}" <NUL\r\nexit %errorlevel%\r\n`);
    return shell;
  }
  if (!insideSystemdService()) return spawn(nodeBinary(), [script], { env, stdio });
  const scope = ["--scope", "--quiet", "--collect", "--no-ask-password"];
  const probe = await new Promise((done) => {
    const child = spawn("systemd-run", [...scope, "true"], { stdio: "ignore" });
    child.once("error", () => done(-1));
    child.once("exit", done);
  });
  return probe === 0 ? spawn("systemd-run", [...scope, nodeBinary(), script], { env, stdio }) : null;
}
