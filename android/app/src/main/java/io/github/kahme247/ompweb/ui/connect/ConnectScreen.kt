package io.github.kahme247.ompweb.ui.connect

import androidx.annotation.StringRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.ProbeResult
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

@Composable
fun ConnectScreen(
    viewModel: ConnectViewModel,
    onAccepted: (ServerAddress, Boolean) -> Unit,
    onTooOld: (ServerAddress, String?) -> Unit,
    initialAddress: ServerAddress? = null,
    initialResult: ProbeResult? = null,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val focusManager = LocalFocusManager.current
    val resultRequester = remember { BringIntoViewRequester() }

    LaunchedEffect(viewModel, initialAddress, initialResult) {
        viewModel.prefill(initialAddress, initialResult)
    }

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is ConnectEvent.Accepted -> onAccepted(event.address, event.needsPassword)
                is ConnectEvent.TooOld -> onTooOld(event.address, event.serverVersion)
            }
        }
    }

    LaunchedEffect(state.result) {
        if (state.result != null) {
            withFrameNanos { }
            resultRequester.bringIntoView()
        }
    }

    Scaffold { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .imePadding(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Column(modifier = Modifier.widthIn(max = 480.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Image(
                            painter = painterResource(R.drawable.ic_launcher_foreground),
                            contentDescription = null,
                            modifier = Modifier
                                .size(56.dp)
                                .clip(RoundedCornerShape(16.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                                .padding(8.dp),
                        )
                        Spacer(Modifier.width(12.dp))
                        Text(
                            text = stringResource(R.string.app_name),
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }

                    Spacer(Modifier.height(32.dp))
                    Text(
                        text = stringResource(R.string.connect_heading),
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.semantics { heading() },
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.connect_intro),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                    Spacer(Modifier.height(24.dp))
                    OutlinedTextField(
                        value = state.input,
                        onValueChange = viewModel::onAddressChange,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.connect_address_label)) },
                        placeholder = { Text(stringResource(R.string.connect_address_placeholder)) },
                        singleLine = true,
                        isError = state.error != null,
                        supportingText = state.error?.let { message ->
                            { Text(message) }
                        },
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Go,
                        ),
                        keyboardActions = KeyboardActions(
                            onGo = {
                                viewModel.connect()
                                focusManager.clearFocus()
                            },
                        ),
                    )
                    state.address?.let { address ->
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = stringResource(R.string.connect_resolved, address.origin),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = {
                            viewModel.connect()
                            focusManager.clearFocus()
                        },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = state.address != null && !state.checking,
                    ) {
                        Text(stringResource(R.string.connect_button))
                    }

                    if (state.checking) {
                        Spacer(Modifier.height(20.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(18.dp),
                                strokeWidth = 2.dp,
                            )
                            Spacer(Modifier.width(12.dp))
                            Text(
                                text = stringResource(R.string.connect_checking),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }

                    state.result?.let { result ->
                        Spacer(Modifier.height(24.dp))
                        ProbeResultCard(
                            result = result,
                            modifier = Modifier.bringIntoViewRequester(resultRequester),
                        )
                    }

                    Spacer(Modifier.height(32.dp))
                    Text(
                        text = stringResource(R.string.connect_help),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Start,
                    )
                }
            }
        }
    }
}

private data class ProbeCopy(
    @param:StringRes val title: Int,
    @param:StringRes val message: Int,
)

@Composable
private fun ProbeResultCard(result: ProbeResult, modifier: Modifier = Modifier) {
    val colors = LocalOmpColors.current
    val (copy, color) = when (result) {
        ProbeResult.MISCONFIGURED ->
            ProbeCopy(R.string.probe_misconfigured_title, R.string.probe_misconfigured_message) to colors.statusError
        ProbeResult.FORBIDDEN ->
            ProbeCopy(R.string.probe_forbidden_title, R.string.probe_forbidden_message) to colors.statusWarning
        ProbeResult.NOT_OMPWEB ->
            ProbeCopy(R.string.probe_not_ompweb_title, R.string.probe_not_ompweb_message) to colors.statusError
        ProbeResult.UNREACHABLE ->
            ProbeCopy(R.string.probe_unreachable_title, R.string.probe_unreachable_message) to colors.statusError
        ProbeResult.TLS_ERROR ->
            ProbeCopy(R.string.probe_tls_title, R.string.probe_tls_message) to colors.statusError
        // A reachable or password-protected server moves on to the next
        // onboarding step; it never becomes a card.
        ProbeResult.REACHABLE, ProbeResult.PASSWORD_REQUIRED -> return
    }

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
        shape = RoundedCornerShape(16.dp),
        color = color.copy(alpha = 0.12f),
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .background(color, CircleShape),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    text = stringResource(copy.title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = color,
                )
            }
            Spacer(Modifier.height(8.dp))
            Text(
                text = stringResource(copy.message),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}
