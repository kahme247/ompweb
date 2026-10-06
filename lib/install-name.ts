import { isIP } from "node:net";
import { domainToUnicode } from "node:url";

/** Display-only label shared by installation metadata and browser titles. */
export function getInstallName(headers: Pick<Headers, "get">, override = process.env.OMP_WEB_NAME): string {
  return getInstallNames(headers, override).name;
}

/** Explicit names stay intact; only hostname-derived short names use the first label. */
export function getInstallNames(headers: Pick<Headers, "get">, override = process.env.OMP_WEB_NAME): { name: string; shortName: string } {
  const customName = override?.trim();
  if (customName) return { name: customName, shortName: customName };
  const fallback = { name: "omp web", shortName: "omp web" };
  const host = headers.get("host");
  const hostname = host && URL.parse(`http://${host}`)?.hostname;
  if (!hostname || hostname === "localhost" || hostname === "localhost.") return fallback;
  if (isIP(hostname.startsWith("[") ? hostname.slice(1, -1) : hostname)) return fallback;
  const name = domainToUnicode(hostname) || hostname;
  return { name, shortName: name.split(".")[0] };
}
