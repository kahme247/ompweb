package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ElsewhereSession

/**
 * "We have not heard from the agent yet" decisions.
 *
 * Cache-first startup paints the last known transcript/list from disk before
 * the server answers. Until something about the *live* state has arrived, an
 * empty status line reads as "the agent is idle / nothing is running", which is
 * a claim the client cannot make yet. These two predicates decide when the UI
 * says so instead (chat footer *Connecting…*, session list *Updating…*).
 */

/**
 * The chat footer shows *Connecting…* while the transcript is already on screen
 * but the run state is unknown: cached history (`historyStale`) or any message
 * rows. An empty chat has its own loading placeholder, so it stays quiet here.
 */
fun chatShowsConnecting(liveStateKnown: Boolean, hasTranscript: Boolean): Boolean =
    !liveStateKnown && hasTranscript

/**
 * The session list marks itself as updating while it shows cached rows and the
 * running badges are not known yet (no list answer and no `running` frame).
 * [failed] ends that wait: the request answered with an error, so a spinner
 * would claim an answer is still on its way.
 */
fun sessionsShowsUpdating(runningKnown: Boolean, hasRows: Boolean, failed: Boolean): Boolean =
    !runningKnown && hasRows && !failed

/**
 * The list's revalidation failed while cached rows are on screen. Without rows
 * the full-screen error takes over; with rows the list keeps its content and
 * shows this compact error with a retry instead of the endless *Updating…*.
 */
fun sessionsShowsRefreshError(hasRows: Boolean, failed: Boolean): Boolean =
    hasRows && failed

/**
 * Who owns a session another process is running (`SessionElsewhere.kind`).
 * A newer server may report a kind this app does not know; [Unknown] keeps the
 * banner generic instead of hiding the owner.
 */
enum class ElsewhereKind { OmpWeb, Terminal, Unknown }

fun elsewhereKind(raw: String?): ElsewhereKind = when (raw) {
    "omp-web" -> ElsewhereKind.OmpWeb
    "terminal" -> ElsewhereKind.Terminal
    else -> ElsewhereKind.Unknown
}

/**
 * How strongly the server proved the ownership (`SessionElsewhere.source`),
 * strongest first. [Transcript] only says "written recently, never closed",
 * which a crashed writer also leaves behind.
 */
enum class ElsewhereSource { InstanceList, Process, Transcript, Unknown }

fun elsewhereSource(raw: String?): ElsewhereSource = when (raw) {
    "instance-list" -> ElsewhereSource.InstanceList
    "process" -> ElsewhereSource.Process
    "transcript" -> ElsewhereSource.Transcript
    else -> ElsewhereSource.Unknown
}

/**
 * What a send does while another omp process owns the session.
 *
 * omp allows one writer per session: a prompt from this app makes it move the
 * chat to a copy with a new id. That must never happen silently, so:
 *
 * - [Allow]: nobody else owns the chat (or the user confirmed the copy) — send.
 * - [Block]: a live instance-list entry or a live `omp --resume` process proves
 *   the owner. The send is refused with the banner; the explicit
 *   "send anyway (copy)" action is the only way through.
 * - [Confirm]: only the transcript signal (recent write, no exit record), which
 *   is an indication, not proof. Ask once before sending instead of locking the
 *   composer.
 */
enum class ForeignSubmitDecision { Allow, Block, Confirm }

/**
 * [ForeignSubmitDecision] for a send into a session whose owner is
 * [elsewhere]. [confirmed] is true once the user accepted "send anyway (copy)";
 * it is never stored, so the next send asks again.
 */
fun foreignSubmitDecision(elsewhere: ElsewhereSession?, confirmed: Boolean): ForeignSubmitDecision = when {
    elsewhere == null -> ForeignSubmitDecision.Allow
    confirmed -> ForeignSubmitDecision.Allow
    elsewhereSource(elsewhere.source) == ElsewhereSource.Transcript -> ForeignSubmitDecision.Confirm
    else -> ForeignSubmitDecision.Block
}
