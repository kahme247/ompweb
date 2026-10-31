package io.github.kahme247.ompweb.ui.connect

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.kahme247.ompweb.net.AppInfoProbe
import io.github.kahme247.ompweb.net.ProbeResult
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.ServerAddressResult
import io.github.kahme247.ompweb.net.ServerProbe
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ConnectUiState(
    val input: String = "",
    val address: ServerAddress? = null,
    val error: String? = null,
    val checking: Boolean = false,
    val result: ProbeResult? = null,
)

/** Where a successful connect attempt leads. */
sealed interface ConnectEvent {
    data class Accepted(val address: ServerAddress, val needsPassword: Boolean) : ConnectEvent
    data class TooOld(val address: ServerAddress, val serverVersion: String?) : ConnectEvent
}

/**
 * Probes the typed address in two steps: `/api/sessions` first (is this
 * ompweb at all?) and then `/api/app-info` (is it new enough for this app?).
 * Every failure that still leaves the user with a usable screen stays on the
 * connect screen as a result card.
 */
class ConnectViewModel(
    private val probe: ServerProbe,
) : ViewModel() {

    private val _state = MutableStateFlow(ConnectUiState())
    val state: StateFlow<ConnectUiState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<ConnectEvent>(extraBufferCapacity = 1)
    val events: SharedFlow<ConnectEvent> = _events.asSharedFlow()

    private var probeJob: Job? = null

    fun onAddressChange(value: String) {
        probeJob?.cancel()
        val parsed = ServerAddress.parse(value)
        _state.update {
            it.copy(
                input = value,
                address = (parsed as? ServerAddressResult.Valid)?.address,
                error = (parsed as? ServerAddressResult.Invalid)?.message?.takeIf { value.isNotBlank() },
                checking = false,
                result = null,
            )
        }
    }

    /**
     * Shows the address and the result of a failed "Check again" from the
     * too-old screen, so the user does not have to retype anything.
     */
    fun prefill(address: ServerAddress?, result: ProbeResult?) {
        if (address == null && result == null) return
        _state.update { current ->
            if (current.checking) {
                current
            } else {
                current.copy(
                    input = address?.origin ?: current.input,
                    address = address ?: current.address,
                    error = null,
                    result = result,
                )
            }
        }
    }

    fun connect() {
        val address = _state.value.address ?: return
        if (_state.value.checking) return
        _state.update { it.copy(checking = true, result = null) }
        probeJob = viewModelScope.launch {
            val sessions = probe.probe(address)
            when (sessions) {
                ProbeResult.REACHABLE, ProbeResult.PASSWORD_REQUIRED -> {
                    when (val info = probe.probeAppInfo(address)) {
                        is AppInfoProbe.Supported -> {
                            settle()
                            _events.emit(ConnectEvent.Accepted(address, sessions == ProbeResult.PASSWORD_REQUIRED))
                        }
                        // The auth gate ran before routing: on a password-protected
                        // server this says nothing about the version yet. The check
                        // repeats after sign-in, when the cookie exists.
                        AppInfoProbe.PasswordRequired -> {
                            settle()
                            _events.emit(ConnectEvent.Accepted(address, needsPassword = true))
                        }
                        is AppInfoProbe.TooOld -> {
                            settle()
                            _events.emit(ConnectEvent.TooOld(address, info.serverVersion))
                        }
                        else -> finish(address, info.toProbeResult())
                    }
                }
                else -> finish(address, sessions)
            }
        }
    }

    private fun settle() {
        _state.update { it.copy(checking = false) }
    }

    private fun finish(address: ServerAddress, result: ProbeResult) {
        _state.update { current ->
            if (current.address == address) {
                current.copy(checking = false, result = result)
            } else {
                current.copy(checking = false)
            }
        }
    }

    private fun AppInfoProbe.toProbeResult(): ProbeResult = when (this) {
        is AppInfoProbe.Supported -> ProbeResult.REACHABLE
        is AppInfoProbe.TooOld -> ProbeResult.NOT_OMPWEB
        AppInfoProbe.PasswordRequired -> ProbeResult.PASSWORD_REQUIRED
        AppInfoProbe.Forbidden -> ProbeResult.FORBIDDEN
        AppInfoProbe.Misconfigured -> ProbeResult.MISCONFIGURED
        AppInfoProbe.Unreachable -> ProbeResult.UNREACHABLE
        AppInfoProbe.TlsError -> ProbeResult.TLS_ERROR
        AppInfoProbe.NotOmpweb -> ProbeResult.NOT_OMPWEB
    }
}
