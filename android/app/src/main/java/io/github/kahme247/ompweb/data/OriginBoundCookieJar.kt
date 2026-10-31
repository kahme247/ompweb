package io.github.kahme247.ompweb.data

import java.io.IOException
import java.security.GeneralSecurityException
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * A cookie jar that only ever talks to the one server the user configured.
 *
 * ompweb's session cookie belongs to exactly one origin (scheme, host, port).
 * Every stored cookie carries that origin, so cookies of a server the user
 * left are never sent to the next one — not even when both happen to share a
 * host and only the port differs. Sending them anywhere else — including a
 * redirect target — would hand the user's sign-in to a different server.
 *
 * [clear] and an origin change bump [generation]; a `Set-Cookie` that arrives
 * for a request started before that point is dropped instead of resurrecting
 * the old session.
 */
class OriginBoundCookieJar(
    private val configuredOrigin: () -> HttpUrl?,
    private val records: CookieRecords,
    private val clock: () -> Long = System::currentTimeMillis,
) : CookieJar {

    private val lock = Any()
    private var cache: List<StoredCookie>? = null
    private var generation = 0L

    /**
     * The origin and generation of the last [loadForRequest] call. `null`
     * means no request has run yet (cookies saved directly are accepted);
     * [CLEARED] means a `clear()` happened and only a fresh request may save.
     */
    private var loadTag: String? = null
    private var loadTagGeneration = -1L

    override fun loadForRequest(url: HttpUrl): List<Cookie> = synchronized(lock) {
        val origin = configuredOrigin() ?: return emptyList()
        if (!sameOrigin(origin, url)) return emptyList()
        val originKey = originKey(origin)
        loadTag = originKey
        loadTagGeneration = generation
        val now = clock()
        val stored = cached()
        val live = stored.filter { it.origin == originKey && it.expiresAtMillis > now }
        if (live != stored) {
            cache = live
            persist(live)
        }
        live.mapNotNull { storedCookie ->
            storedCookie.toCookie()?.takeIf { cookie -> cookie.matches(url) }
        }
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (cookies.isEmpty()) return
        synchronized(lock) {
            val origin = configuredOrigin() ?: return
            if (!sameOrigin(origin, url)) return
            val originKey = originKey(origin)
            val tag = loadTag
            // A response to a request that started before clear() must not
            // put its cookie back.
            if (tag != null && (tag != originKey || loadTagGeneration != generation)) return
            // Records of another origin are dropped as well: after a server
            // change nothing of the old server stays behind.
            val merged = cached().filter { it.origin == originKey }.toMutableList()
            for (cookie in cookies) {
                val stored = cookie.toStoredCookie(originKey)
                merged.removeAll { it.name == stored.name && it.domain == stored.domain && it.path == stored.path }
                merged.add(stored)
            }
            cache = merged
            persist(merged)
        }
    }

    /** Drops every stored cookie; used by sign-out and "change server". */
    fun clear() {
        synchronized(lock) {
            generation++
            loadTag = CLEARED
            loadTagGeneration = -1L
            cache = emptyList()
            persist(emptyList())
        }
    }

    /** Whether the configured origin currently has a usable cookie. */
    fun hasCookies(): Boolean = synchronized(lock) {
        val origin = configuredOrigin() ?: return false
        val originKey = originKey(origin)
        val now = clock()
        cached().any { it.origin == originKey && it.expiresAtMillis > now }
    }

    private fun cached(): List<StoredCookie> = cache ?: records.load().also { cache = it }

    /**
     * Persisting is best effort: a full disk or an invalidated Keystore key
     * must not turn a successful sign-in into a network error or a crash.
     * The in-memory cache keeps working for this process.
     */
    private fun persist(cookies: List<StoredCookie>) {
        try {
            records.save(cookies)
        } catch (_: IOException) {
            // Not persisted; the next successful save tries again.
        } catch (_: GeneralSecurityException) {
            // The Keystore key is gone; the session ends on the next launch.
        }
    }

    private fun StoredCookie.toCookie(): Cookie? = try {
        Cookie.Builder()
            .name(name)
            .value(value)
            .domain(domain)
            .path(path)
            .expiresAt(expiresAtMillis)
            .apply {
                if (secure) secure()
                if (httpOnly) httpOnly()
            }
            .build()
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun Cookie.toStoredCookie(originKey: String): StoredCookie = StoredCookie(
        name = name,
        value = value,
        expiresAtMillis = expiresAt,
        domain = domain,
        path = path,
        secure = secure,
        httpOnly = httpOnly,
        origin = originKey,
    )

    private fun sameOrigin(first: HttpUrl, second: HttpUrl): Boolean =
        first.scheme == second.scheme &&
            first.host.equals(second.host, ignoreCase = true) &&
            first.port == second.port

    private fun originKey(url: HttpUrl): String =
        "${url.scheme}://${url.host}:${url.port}"

    private companion object {
        /** Sentinel: a `clear()` happened and no request has tagged a generation since. */
        const val CLEARED = ""
    }
}
