"use strict";

// `ompweb hash-password` plus the password prompt the launcher and the service
// installers use. The password is read from stdin, never from argv, so it
// stays out of shell history and out of `ps` output (issue #239).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hashPassword, isPasswordHash } = require("./omp-web-password-hash");

/** Key sent when the user presses Ctrl+C at a prompt. */
const INTERRUPT_KEY = Buffer.from([0x03]);

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", reject);
  });
}

/**
 * One line, EOF-terminated. Trailing newlines are stripped (a here-string ends
 * with a newline; CRLF is what Windows shells pipe), but nothing else is: a
 * password may legitimately contain spaces or trailing punctuation.
 */
async function readPipedLine() {
  const piped = await readStdin();
  return piped.replace(/(?:\r?\n)+$/, "");
}

/**
 * Read a hidden line from a TTY without node:readline, whose `terminal` mode
 * writes an ANSI prompt that renders badly in the notification dialogs some
 * desktops provide. Raw mode keeps every byte from reaching the caller while
 * stopping the terminal from echoing it.
 */
function readHiddenLine(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    output.write(prompt);
    input.resume();
    input.setRawMode(true);
    const chunks = [];
    let settled = false;
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      resolve(value);
    };
    const onData = (chunk) => {
      const bytes = Buffer.from(chunk);
      // Ctrl+C: stop waiting, and let the caller treat it as a cancel.
      if (bytes.includes(INTERRUPT_KEY)) return finish(null);
      // Raw mode turns off ICRNL, so Enter arrives as \r; a pasted line may end in \n.
      const newline = bytes.findIndex((byte) => byte === 0x0d || byte === 0x0a);
      if (newline === -1) {
        chunks.push(bytes);
        return;
      }
      chunks.push(bytes.subarray(0, newline));
      finish(Buffer.concat(chunks).toString("utf8"));
    };
    const onEnd = () => finish(null);
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      reject(error);
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

/**
 * Ask for the password, twice when a terminal can confirm it. Piped stdin
 * cannot ask twice, so it is taken as-is. Resolves null when the user cancels.
 */
async function promptPassword(options = {}) {
  const { confirm = false, label = "Web sign-in password" } = options;
  if (!process.stdin.isTTY) return readPipedLine();

  while (true) {
    const first = await readHiddenLine(`${label}: `);
    if (first === null) return null;
    if (!first) {
      process.stderr.write("Empty password: nothing to hash. Press Ctrl+C to cancel.\n");
      continue;
    }
    if (!confirm) return first;
    const again = await readHiddenLine(`${label} (again): `);
    if (again === null) return null;
    if (again === first) return first;
    process.stderr.write("Passwords did not match. Try again.\n");
  }
}

/**
 * `ompweb hash-password`: print the `OMP_WEB_PASSWORD_HASH` value for the
 * password read from stdin.
 * @returns {Promise<number>} process exit code
 */
async function runHashPasswordCommand(options = {}) {
  const { stdout = process.stdout, stderr = process.stderr, confirm } = options;
  let password;
  try {
    password = await promptPassword({ confirm: confirm ?? process.stdin.isTTY, label: options.label });
  } catch (error) {
    stderr.write(`Could not read the password: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (password === null) {
    stderr.write("Cancelled.\n");
    return 1;
  }
  if (!password) {
    stderr.write("No password received. Pipe one in or run this command in a terminal.\n");
    return 1;
  }
  stdout.write(`${hashPassword(password)}\n`);
  return 0;
}

/**
 * Resolve the password hash an installer should write: an existing
 * `OMP_WEB_PASSWORD_HASH`, or a plaintext `OMP_WEB_PASSWORD` hashed here.
 * Reading a plaintext password is allowed on this side only — the hash is what
 * gets stored, and the plaintext never reaches a service definition or a child
 * process. Returns null when neither is configured, and throws when a hash was
 * given but is unusable (silently dropping it would disable auth).
 */
function resolvePasswordHash(env = process.env) {
  const existing = typeof env.OMP_WEB_PASSWORD_HASH === "string" ? env.OMP_WEB_PASSWORD_HASH.trim() : "";
  if (existing) {
    if (!isPasswordHash(existing)) {
      throw new Error("OMP_WEB_PASSWORD_HASH is not a valid password hash; generate one with: ompweb hash-password");
    }
    return existing;
  }
  const plaintext = env.OMP_WEB_PASSWORD;
  return typeof plaintext === "string" && plaintext.length > 0 ? hashPassword(plaintext) : null;
}

/**
 * Migration path for a plaintext `OMP_WEB_PASSWORD` given to the launcher:
 * hash it into `OMP_WEB_PASSWORD_HASH` and delete the plaintext from `env`,
 * so it never reaches the server or any process it spawns. Returns the hash.
 */
function migrateLegacyPassword(env = process.env) {
  const hash = hashPassword(env.OMP_WEB_PASSWORD);
  env.OMP_WEB_PASSWORD_HASH = hash;
  delete env.OMP_WEB_PASSWORD;
  return hash;
}

module.exports = { migrateLegacyPassword, promptPassword, resolvePasswordHash, runHashPasswordCommand };
