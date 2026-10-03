import { isIP } from "node:net";

/** Display-only label shared by installation metadata and browser titles. */
export function getInstallName(headers: Pick<Headers, "get">): string {
  const host = headers.get("host");
  const hostname = host && URL.parse(`http://${host}`)?.hostname;
  if (!hostname || hostname === "localhost" || hostname === "localhost.") return "omp web";
  return isIP(hostname.startsWith("[") ? hostname.slice(1, -1) : hostname) ? "omp web" : hostname;
}
