package io.github.kahme247.ompweb.ui.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily

/**
 * The server answered but does not offer `/api/app-info` (or an `api` version
 * this app speaks). The screen names the exact update command instead of a
 * generic "connection failed", because nothing the user types will fix it.
 */
@Composable
fun ServerTooOldScreen(
    address: ServerAddress,
    serverVersion: String?,
    onRetry: () -> Unit,
    onChangeServer: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Scaffold { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 28.dp),
        ) {
            Column(modifier = Modifier.widthIn(max = 560.dp)) {
                Text(
                    text = stringResource(R.string.too_old_heading),
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.statusWarning,
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    text = stringResource(R.string.too_old_intro, address.origin),
                    style = MaterialTheme.typography.bodyLarge,
                )
                if (serverVersion != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.too_old_version, serverVersion),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                Spacer(Modifier.height(24.dp))
                Text(
                    text = stringResource(R.string.too_old_command_label),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(8.dp))
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ) {
                    Text(
                        text = stringResource(R.string.too_old_command),
                        modifier = Modifier.padding(12.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        fontFamily = OmpMonoFontFamily,
                    )
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.too_old_restart),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(28.dp))
                Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.too_old_retry))
                }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = onChangeServer, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.password_change_server))
                }
                Spacer(Modifier.height(24.dp))
                Text(
                    text = stringResource(R.string.too_old_help),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Start,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.backgroundSubtle, RoundedCornerShape(10.dp))
                        .padding(12.dp),
                )
            }
        }
    }
}
