// The web server's side of the local daemon link: keep the `local` host record
// and the daemon's host.json in step. Pure Node: no Next or `@/` imports.
import { isLoopbackHost, loginHost, readHostLogin } from "./host-login";
import { hostForToken, LOCAL_HOST_ID, rotateLocalHostToken } from "./registry";

/** Where the daemon dials this server, or why it cannot: the daemon uses plain http only on loopback, so a bind address elsewhere gets no link. */
export function localLinkUrl(env: NodeJS.ProcessEnv = process.env): { url: string } | { skip: string } {
  const port = env.OMP_WEB_PORT;
  if (!port) return { skip: "OMP_WEB_PORT is not set (start through the ompweb launcher)" };
  const bind = env.OMP_WEB_HOSTNAME || "127.0.0.1";
  // A wildcard bind also answers on 127.0.0.1; "localhost" is dialed by name, so it matches whichever family the server bound.
  const host = ["0.0.0.0", "::", "[::]"].includes(bind) ? "127.0.0.1" : bind === "::1" ? "[::1]" : bind;
  if (!isLoopbackHost(host)) return { skip: `OMP_WEB_HOSTNAME=${bind} is not loopback, so the local daemon cannot link to it over http` };
  return { url: `http://${host}:${port}` };
}

const linksElsewhere = (url: string) => {
  try {
    return !isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** Make sure the `local` record exists and host.json holds its token and `url`.
 * A host.json whose token the registry still accepts is kept, so a restart does not make the daemon redial.
 * Throws instead of overwriting a host.json that links this machine's daemon to another server. */
export function ensureLocalHostLink(input: { url: string }): { token: string; written: boolean } {
  const url = input.url.replace(/\/+$/, "");
  const saved = readHostLogin();
  if (saved && linksElsewhere(saved.url)) {
    throw new Error(`host.json links this machine's daemon to ${saved.url}, not to this server; remove it to use this server for "This machine"`);
  }
  const kept = saved && hostForToken(saved.token)?.id === LOCAL_HOST_ID ? saved : null;
  if (kept && kept.url === url) return { token: kept.token, written: false };
  const token = kept?.token ?? rotateLocalHostToken();
  loginHost({ url, token });
  return { token, written: true };
}
