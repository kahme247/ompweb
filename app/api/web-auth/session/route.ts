import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  createWebSession,
  isValidWebPassword,
  isWebPasswordEnabled,
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_SESSION_MAX_AGE_SECONDS,
} from "@/lib/web-auth";

const MAX_PASSWORD_REQUEST_BYTES = 8 * 1024;

export async function POST(request: Request) {
  if (!isWebPasswordEnabled()) {
    return Response.json({ error: "Password protection is disabled" }, { status: 404 });
  }

  let body: { password?: unknown };
  try {
    body = await parseJsonWithinLimit(request, MAX_PASSWORD_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    return Response.json({ error: "Invalid password request" }, { status });
  }
  if (typeof body.password !== "string" || !isValidWebPassword(body.password)) {
    return Response.json({ error: "Incorrect password" }, { status: 401 });
  }

  const response = Response.json({ ok: true });
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  response.headers.append("Set-Cookie", new Bun.Cookie(OMP_WEB_SESSION_COOKIE, createWebSession(), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: OMP_WEB_SESSION_MAX_AGE_SECONDS,
    path: "/",
  }).serialize());
  return response;
}
