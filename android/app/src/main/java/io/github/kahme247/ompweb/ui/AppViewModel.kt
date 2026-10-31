package io.github.kahme247.ompweb.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.kahme247.ompweb.AppContainer
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.AppInfoProbe
import io.github.kahme247.ompweb.net.LoginOutcome
import io.github.kahme247.ompweb.net.ProbeResult
import io.github.kahme247.ompweb.net.ServerAddress
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** Which screen the app shows. */
sealed interface AppRoute {
    data object Loading : AppRoute

    /** The connect screen, optionally with the address and result of a failed re-check. */
    data class Connect(
        val prefill: ServerAddress? = null,
        val result: ProbeResult? = null,
    ) : AppRoute

    data object Password : AppRoute
    data class TooOld(val address: ServerAddress, val serverVersion: String?) : AppRoute
    data object Main : AppRoute
}

/** Why the last sign-in attempt failed; the screen owns the wording. */
enum class PasswordError {
    WrongPassword,
    TooLarge,
    Misconfigured,
    Forbidden,
    Network,
    Server,
}

/**
 * Owns the onboarding state machine: connect → (password) → main.
 *
 * A stored origin plus a stored cookie goes straight to the main screen on
 * launch — that is what makes a relaunch stay signed in; without a cookie the
 * app asks for the password again (unless the server never had one). Any 401
 * for the configured origin clears the cookie and returns to the password
 * screen with the origin kept; "Sign out" does the same on purpose, and
 * "Change server" also forgets the origin.
 */
class AppViewModel(private val container: AppContainer) : ViewModel() {

    private val _route = MutableStateFlow<AppRoute>(AppRoute.Loading)
    val route: StateFlow<AppRoute> = _route.asStateFlow()

    private val _signingIn = MutableStateFlow(false)
    val signingIn: StateFlow<Boolean> = _signingIn.asStateFlow()

    private val _passwordError = MutableStateFlow<PasswordError?>(null)
    val passwordError: StateFlow<PasswordError?> = _passwordError.asStateFlow()

    private var signInJob: Job? = null

    init {
        viewModelScope.launch {
            val snapshot = container.settings.snapshot.first { it.loaded }
            _route.value = when {
                snapshot.origin == null -> AppRoute.Connect()
                // A stored address without a cookie is not a signed-in app;
                // only a server that never asked for a password can skip it.
                snapshot.needsPassword && !container.cookieJar.hasCookies() -> AppRoute.Password
                else -> AppRoute.Main
            }
        }
        viewModelScope.launch {
            container.authEvents.collect { failedOrigin ->
                // A late 401 from a server the user already left must not sign
                // out the one that is configured now.
                if (_route.value == AppRoute.Main && failedOrigin == container.settings.originNow()) {
                    // The unregister of the notification device still needs a
                    // session; a cleared cookie would make it a 401 again.
                    container.clearLocalUserData()
                    container.cookieJar.clear()
                    _passwordError.value = null
                    _route.value = AppRoute.Password
                }
            }
        }
    }

    /** The connect screen validated the address (and the server's capabilities). */
    fun acceptServer(address: ServerAddress, needsPassword: Boolean) {
        viewModelScope.launch {
            // Drafts, recordings and exports belong to the previous origin.
            if (container.settings.originNow()?.origin != address.origin) {
                container.clearLocalUserData()
            }
            container.settings.setOrigin(address.origin)
            container.settings.setNeedsPassword(needsPassword)
            _passwordError.value = null
            _route.value = if (needsPassword) AppRoute.Password else AppRoute.Main
        }
    }

    /** The server answered, but without a usable `/api/app-info`. */
    fun reportTooOld(address: ServerAddress, serverVersion: String?) {
        viewModelScope.launch {
            // Same rule as acceptServer: pointing the app at another server
            // must not keep that installation's cache, cookies or drafts. A
            // too-old server is often reached after another one, and this path
            // used to switch the origin without wiping.
            if (container.settings.originNow()?.origin != address.origin) {
                container.clearLocalUserData()
            }
            container.settings.setOrigin(address.origin)
            _route.value = AppRoute.TooOld(address, serverVersion)
        }
    }

    fun signIn(password: String) {
        if (_signingIn.value || password.isEmpty()) return
        _signingIn.value = true
        _passwordError.value = null
        signInJob = viewModelScope.launch {
            try {
                when (container.api.login(password)) {
                    LoginOutcome.Success -> verifyCapabilitiesThenMain()
                    LoginOutcome.PasswordDisabled -> {
                        // The server does not use a password after all (the
                        // stored hint may be stale); remember it so "Sign out"
                        // does not lead into a password screen.
                        container.settings.setNeedsPassword(false)
                        _route.value = AppRoute.Main
                    }
                    LoginOutcome.WrongPassword -> _passwordError.value = PasswordError.WrongPassword
                    LoginOutcome.TooLarge -> _passwordError.value = PasswordError.TooLarge
                }
            } catch (error: ApiError) {
                _passwordError.value = error.toPasswordError()
            } finally {
                _signingIn.value = false
            }
        }
    }

    /**
     * "Check again" on the too-old screen: after updating ompweb on the PC the
     * user should not have to retype the address.
     */
    fun retryServer() {
        val address = (_route.value as? AppRoute.TooOld)?.address ?: return
        _route.value = AppRoute.Loading
        viewModelScope.launch {
            val next: AppRoute = when (val probe = container.probe.probeAppInfo(address)) {
                is AppInfoProbe.Supported -> AppRoute.Main
                is AppInfoProbe.TooOld -> AppRoute.TooOld(address, probe.serverVersion)
                AppInfoProbe.PasswordRequired -> AppRoute.Password
                // Only a missing or unknown API means "too old"; a network,
                // TLS or proxy problem belongs on the connect screen, where
                // the user can retry and see what actually failed.
                AppInfoProbe.Unreachable -> AppRoute.Connect(address, ProbeResult.UNREACHABLE)
                AppInfoProbe.TlsError -> AppRoute.Connect(address, ProbeResult.TLS_ERROR)
                AppInfoProbe.Forbidden -> AppRoute.Connect(address, ProbeResult.FORBIDDEN)
                AppInfoProbe.Misconfigured -> AppRoute.Connect(address, ProbeResult.MISCONFIGURED)
                AppInfoProbe.NotOmpweb -> AppRoute.Connect(address, ProbeResult.NOT_OMPWEB)
            }
            _route.value = next
        }
    }

    fun signOut() {
        signInJob?.cancel()
        _signingIn.value = false
        val needsPassword = container.settings.snapshot.value.needsPassword
        _passwordError.value = null
        // An open server has no password to ask for; asking anyway would be a
        // dead end where every input is accepted.
        _route.value = if (needsPassword) AppRoute.Password else AppRoute.Main
        viewModelScope.launch {
            // Unregistrate first: it still needs the cookie and the origin.
            // Drafts, recovered queue text and local recordings are the
            // signed-in user's; they must not survive either.
            container.clearLocalUserData()
            container.cookieJar.clear()
        }
    }

    fun changeServer() {
        signInJob?.cancel()
        _signingIn.value = false
        viewModelScope.launch {
            // Same order as sign-out: the device unregister needs the old cookie.
            container.clearLocalUserData()
            container.cookieJar.clear()
            container.settings.setOrigin(null)
            _passwordError.value = null
            _route.value = AppRoute.Connect()
        }
    }

    fun setTheme(themeId: String) {
        viewModelScope.launch { container.settings.setTheme(themeId) }
    }

    /**
     * A password-protected server cannot answer `/api/app-info` before sign-in,
     * so the "server too old" check runs once more with the session cookie.
     */
    private suspend fun verifyCapabilitiesThenMain() {
        val address = container.settings.originNow()
        if (address == null) {
            _route.value = AppRoute.Connect()
            return
        }
        when (val probe = container.probe.probeAppInfo(address)) {
            is AppInfoProbe.TooOld -> _route.value = AppRoute.TooOld(address, probe.serverVersion)
            else -> _route.value = AppRoute.Main
        }
    }

    private fun ApiError.toPasswordError(): PasswordError = when (this) {
        is ApiError.Unauthorized -> PasswordError.WrongPassword
        is ApiError.Forbidden -> PasswordError.Forbidden
        is ApiError.ServerMisconfigured -> PasswordError.Misconfigured
        // "omp is busy" (503 session_slow): not a sign-in condition, but the
        // server answered — retrying is a server-side wait, not a credentials one.
        is ApiError.SessionSlow -> PasswordError.Server
        // A foreign owner is not a sign-in condition either: the server
        // answered, the session just belongs to another omp process.
        is ApiError.SessionRunningElsewhere -> PasswordError.Server
        is ApiError.Network -> PasswordError.Network
        is ApiError.NotConfigured -> PasswordError.Network
        is ApiError.Http -> PasswordError.Server
        is ApiError.ServerResponse -> when (status) {
            401 -> PasswordError.WrongPassword
            403 -> PasswordError.Forbidden
            else -> PasswordError.Server
        }
    }
}
