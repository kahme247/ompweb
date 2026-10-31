package io.github.kahme247.ompweb.ui.chat

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.chat.DayBucket
import io.github.kahme247.ompweb.chat.TimeBucket
import io.github.kahme247.ompweb.chat.TranscriptFormat
import java.text.SimpleDateFormat
import java.time.ZoneId
import java.util.Date
import kotlinx.coroutines.delay

/**
 * The locale-aware shapes of a transcript timestamp. `android.text.format
 * .DateFormat.getTimeFormat` follows the user's 24-hour setting, and the date
 * patterns follow the locale, while [TranscriptFormat] decides which shape a
 * timestamp needs (today, yesterday, this year, older).
 */
@Immutable
class ChatTimeFormatter(
    private val timeFormat: java.text.DateFormat,
    private val sameYearFormat: java.text.SimpleDateFormat,
    private val anyYearFormat: java.text.SimpleDateFormat,
    private val fullFormat: java.text.DateFormat,
    private val zone: ZoneId,
    private val todayLabel: String,
    private val yesterdayLabel: String,
) {
    /** The time alone, e.g. `09:41` or `9:41 AM`. */
    fun time(timestamp: Long): String = timeFormat.format(Date(timestamp))

    /** The header stamp: `09:41`, `Yesterday 09:41`, `26 Oct, 09:41`, `26 Oct 2025`. */
    fun header(timestamp: Long, now: Long): String = when (
        TranscriptFormat.timeBucket(timestamp, now, zone)
    ) {
        TimeBucket.Today -> time(timestamp)
        TimeBucket.Yesterday -> "$yesterdayLabel ${time(timestamp)}"
        TimeBucket.SameYear -> "${sameYearFormat.format(Date(timestamp))}, ${time(timestamp)}"
        TimeBucket.OlderYear -> anyYearFormat.format(Date(timestamp))
    }

    /** The day separator: `Today`, `Yesterday`, otherwise a date. */
    fun daySeparator(timestamp: Long, now: Long): String = when (
        TranscriptFormat.dayBucket(timestamp, now, zone)
    ) {
        DayBucket.Today -> todayLabel
        DayBucket.Yesterday -> yesterdayLabel
        DayBucket.Date -> anyYearFormat.format(Date(timestamp))
    }

    /**
     * The full date and time shown when a timestamp is tapped. The time is part
     * of it: an older-than-this-year header shows the date only, so this dialog
     * is the only place that can show the clock time for those turns.
     */
    fun full(timestamp: Long): String {
        val date = Date(timestamp)
        return "${fullFormat.format(date)}, ${timeFormat.format(date)}"
    }
}

/**
 * [ChatTimeFormatter] for the current locale, 12/24-hour setting and time zone.
 *
 * A time-zone or 12/24-hour change does not recreate the composition, so the
 * screen observes both (broadcast + settings observer) and publishes a revision
 * through [LocalTimeFormatRevision]; the formatter's caches key on it. The date
 * patterns come from the locale skeleton (`getBestDateTimePattern`), so en-US
 * shows "Oct 26" instead of the German "26 Oct".
 */
@Composable
internal fun rememberChatTimeFormatter(): ChatTimeFormatter {
    val context = LocalContext.current
    // LocalConfiguration is observable state, so a locale change re-creates
    // the formatter instead of keeping the process default.
    val configuration = LocalConfiguration.current
    val locale = configuration.locales[0]
    val revision = LocalTimeFormatRevision.current
    val zone = remember(revision) { ZoneId.systemDefault() }
    val today = stringResource(R.string.chat_day_today)
    val yesterday = stringResource(R.string.chat_day_yesterday)
    return remember(context, locale, zone, today, yesterday, revision) {
        ChatTimeFormatter(
            timeFormat = DateFormat.getTimeFormat(context),
            sameYearFormat = SimpleDateFormat(
                DateFormat.getBestDateTimePattern(locale, "dMMM"),
                locale,
            ),
            anyYearFormat = SimpleDateFormat(
                DateFormat.getBestDateTimePattern(locale, "yMMMd"),
                locale,
            ),
            fullFormat = DateFormat.getLongDateFormat(context),
            zone = zone,
            todayLabel = today,
            yesterdayLabel = yesterday,
        )
    }
}

/**
 * The transcript's shared wall clock. The chat screen provides a minute tick,
 * so "Today"/"Yesterday" and the header shapes keep following midnight while
 * the app stays open; the screenshot harness leaves it unset and the pinned
 * [LocalChatClock] applies.
 */
internal val LocalChatNow = compositionLocalOf<Long?> { null }

/** Bumped when the time zone or the user's 12/24-hour setting changes. */
internal val LocalTimeFormatRevision = compositionLocalOf { 0 }

/**
 * Watches the two settings the formatter caches (zone and hour cycle). Neither
 * recreates the composition, so their value is a revision the formatter keys
 * on instead of holding the old zone until the process restarts.
 */
@Composable
internal fun rememberTimeFormatRevision(): Int {
    val context = LocalContext.current
    var revision by remember { mutableIntStateOf(0) }
    DisposableEffect(context) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                revision++
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
            addAction(Intent.ACTION_TIME_CHANGED)
        }
        ContextCompat.registerReceiver(
            context,
            receiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                revision++
            }
        }
        context.contentResolver.registerContentObserver(
            Settings.System.getUriFor(Settings.System.TIME_12_24),
            false,
            observer,
        )
        onDispose {
            context.unregisterReceiver(receiver)
            context.contentResolver.unregisterContentObserver(observer)
        }
    }
    return revision
}

/**
 * The shared minute clock of the transcript: day labels and header buckets read
 * it, so a screen open over midnight re-labels itself without a new message.
 * Ticks only while the screen is STARTED.
 */
@Composable
internal fun rememberMinuteNow(): Long {
    val clock = LocalChatClock.current
    val started = LocalLifecycleOwner.current.lifecycle
        .currentStateAsState()
        .value
        .isAtLeast(Lifecycle.State.STARTED)
    var now by remember(clock) { mutableLongStateOf(clock()) }
    LaunchedEffect(clock, started) {
        if (!started) return@LaunchedEffect
        while (true) {
            val value = clock()
            now = value
            delay(60_000L - value % 60_000L)
        }
    }
    return now
}
