function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getRequestOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  return host ? canonicalOrigin(`${requestUrl.protocol}//${host}`) : requestUrl.origin;
}

/** Reject browser cross-site API requests while preserving non-browser clients. */
export function isApiRequestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin) return fetchSite !== "cross-site";

  const requestOrigin = getRequestOrigin(request);
  if (requestOrigin === null) return false;
  if (canonicalOrigin(origin) === requestOrigin) return true;
  // Some local HTTP proxies strip the port from the forwarded Origin header
  // (e.g. `http://127.0.0.1:30177` arrives as `http://127.0.0.1`), which
  // would otherwise 403 every API request (issue #114). Accept that shape
  // only when protocol + hostname match exactly and the received Origin
  // carries the scheme's default port (i.e. no explicit port — browsers
  // always send a non-default port, so a same-host attacker on another
  // explicit port such as :9999 is still rejected). Hostname mismatches
  // (the evil.com drive-by case) are still rejected here.
  try {
    const received = new URL(origin);
    const expected = new URL(requestOrigin);
    return received.protocol === expected.protocol
      && received.hostname === expected.hostname
      && received.port === "";
  } catch {
    return false;
  }
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}
