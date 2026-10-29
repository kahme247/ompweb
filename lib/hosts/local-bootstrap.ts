// The web server's side of the local daemon link: keep the `local` host record
// and the daemon's host.json in step. Pure Node: no Next or `@/` imports.
import { loginHost, readHostLogin } from "./daemon";
import { hostForToken, LOCAL_HOST_ID, rotateLocalHostToken } from "./registry";

/** Where the daemon dials this server: its own loopback address on the port it listens on; null when the launcher did not say. */
export function localLinkUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const port = env.OMP_WEB_PORT;
  if (!port) return null;
  const v6 = env.OMP_WEB_HOSTNAME === "::1" || env.OMP_WEB_HOSTNAME === "[::1]";
  return `http://${v6 ? "[::1]" : "127.0.0.1"}:${port}`;
}

/** Make sure the `local` record exists and host.json holds its token and `url`.
 * A host.json whose token the registry still accepts is kept, so a restart does not make the daemon redial. */
export function ensureLocalHostLink(input: { url: string }): { token: string; written: boolean } {
  const url = input.url.replace(/\/+$/, "");
  const saved = readHostLogin();
  const kept = saved && hostForToken(saved.token)?.id === LOCAL_HOST_ID ? saved : null;
  if (kept && kept.url === url) return { token: kept.token, written: false };
  const token = kept?.token ?? rotateLocalHostToken();
  loginHost({ url, token });
  return { token, written: true };
}
