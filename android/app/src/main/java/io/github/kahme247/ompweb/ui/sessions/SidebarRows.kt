package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.MAX_PROJECT_SESSIONS
import io.github.kahme247.ompweb.domain.ProjectActivity
import io.github.kahme247.ompweb.domain.SessionTreeNode
import io.github.kahme247.ompweb.domain.buildSessionTree
import io.github.kahme247.ompweb.domain.projectLabel
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSummary
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDropdownMenu
import java.time.Instant

/**
 * One project card plus its fork tree, ported from `components/SessionSidebar`
 * and `SessionSidebar-rows.tsx`: activity badges, expansion, long-press drag
 * reorder, the five-root cap with "Show more", and the per-session action menu.
 */
@Composable
internal fun ProjectBlock(
    project: ManagedProject,
    allProjectSessions: List<SessionSummary>,
    visibleSessions: List<SessionSummary>,
    activity: ProjectActivity,
    expanded: Boolean,
    filterActive: Boolean,
    now: Instant,
    runningIds: Set<String>,
    unreadIds: Set<String>,
    exitedIds: Set<String>,
    /** Sessions another omp process owns: their row says "Elsewhere". */
    elsewhereIds: Set<String>,
    selectedSessionId: String?,
    /** The session whose auto-name request is running (A5). */
    namingSessionId: String?,
    /** Sessions pinned for this origin; pinned rows offer "Unpin". */
    pinnedIds: Set<String>,
    dragging: Boolean,
    dragOffset: Float,
    dropHighlight: Boolean,
    onToggle: () -> Unit,
    onActivate: () -> Unit,
    onNewSession: () -> Unit,
    onRenameProject: () -> Unit,
    onLaunchConfig: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onHide: () -> Unit,
    onDragStart: (pointerY: Float) -> Unit,
    onDrag: (deltaY: Float, pointerY: Float) -> Unit,
    onDragEnd: () -> Unit,
    onDragCancel: () -> Unit,
    onSelectSession: (String) -> Unit,
    onTogglePin: (SessionSummary) -> Unit,
    onRenameSession: (SessionSummary) -> Unit,
    onArchiveSession: (SessionSummary) -> Unit,
    onAutoName: (SessionSummary) -> Unit,
    onCopyTranscript: (SessionSummary) -> Unit,
    onExportSession: (SessionSummary) -> Unit,
    onDeleteSession: (SessionSummary) -> Unit,
    onCopyId: (String) -> Unit,
) {
    val colors = LocalOmpColors.current
    var projectMenuOpen by remember(project.path) { mutableStateOf(false) }
    var showAllRoots by remember(project.path) { mutableStateOf(false) }
    val collapsedNodes = remember(project.path) { mutableStateMapOf<String, Boolean>() }
    val roots = remember(visibleSessions) { buildSessionTree(visibleSessions) }
    val childIds = remember(allProjectSessions) {
        allProjectSessions.mapNotNull { it.parentSessionId }.toSet()
    }
    val shownRoots = if (filterActive || showAllRoots) roots else roots.take(MAX_PROJECT_SESSIONS)
    val canDrag = !filterActive

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .zIndex(if (dragging) 1f else 0f)
            .graphicsLayer { translationY = if (dragging) dragOffset else 0f }
            .background(if (dropHighlight) colors.selected else colors.background),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onActivate)
                .pointerInput(project.path, canDrag) {
                    if (!canDrag) return@pointerInput
                    detectDragGesturesAfterLongPress(
                        onDragStart = { offset -> onDragStart(offset.y) },
                        onDrag = { change, amount ->
                            change.consume()
                            onDrag(amount.y, change.position.y)
                        },
                        onDragEnd = { onDragEnd() },
                        onDragCancel = { onDragCancel() },
                    )
                }
                .padding(start = 8.dp, end = 4.dp, top = 10.dp, bottom = 6.dp),
        ) {
            // The web splits the header into an identity button (activate +
            // expand) and a separate chevron button (toggle); merging both into
            // one click made activate and toggle cancel each other out.
            IconButton(onClick = onToggle) {
                Icon(
                    imageVector = if (expanded) {
                        Icons.Filled.KeyboardArrowDown
                    } else {
                        Icons.AutoMirrored.Filled.KeyboardArrowRight
                    },
                    contentDescription = stringResource(
                        if (expanded) R.string.project_collapse else R.string.project_expand,
                    ),
                    tint = colors.textMuted,
                    modifier = Modifier.size(20.dp),
                )
            }
            Spacer(Modifier.width(2.dp))
            Text(
                text = projectLabel(project),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            ProjectActivityBadges(activity, allProjectSessions.size)
            Box {
                IconButton(onClick = { projectMenuOpen = true }) {
                    Icon(
                        imageVector = Icons.Filled.MoreVert,
                        contentDescription = stringResource(R.string.project_menu),
                        tint = colors.textMuted,
                        modifier = Modifier.size(18.dp),
                    )
                }
                OmpDropdownMenu(expanded = projectMenuOpen, onDismissRequest = { projectMenuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.project_new_session)) },
                        onClick = {
                            projectMenuOpen = false
                            onNewSession()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.project_rename)) },
                        onClick = {
                            projectMenuOpen = false
                            onRenameProject()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.project_launch_config)) },
                        onClick = {
                            projectMenuOpen = false
                            onLaunchConfig()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.project_move_up)) },
                        onClick = {
                            projectMenuOpen = false
                            onMoveUp()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.project_move_down)) },
                        onClick = {
                            projectMenuOpen = false
                            onMoveDown()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.project_hide)) },
                        onClick = {
                            projectMenuOpen = false
                            onHide()
                        },
                    )
                }
            }
        }

        if (expanded) {
            if (visibleSessions.isEmpty()) {
                Text(
                    text = stringResource(R.string.project_empty),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textDim,
                    modifier = Modifier.padding(start = 34.dp, top = 2.dp, bottom = 10.dp),
                )
            } else {
                shownRoots.forEach { node ->
                    SessionTreeRows(
                        node = node,
                        depth = 0,
                        now = now,
                        runningIds = runningIds,
                        unreadIds = unreadIds,
                        exitedIds = exitedIds,
                        elsewhereIds = elsewhereIds,
                        selectedSessionId = selectedSessionId,
                        namingSessionId = namingSessionId,
                        pinnedIds = pinnedIds,
                        childIds = childIds,
                        collapsedNodes = collapsedNodes,
                        onSelectSession = onSelectSession,
                        onTogglePin = onTogglePin,
                        onRenameSession = onRenameSession,
                        onArchiveSession = onArchiveSession,
                        onAutoName = onAutoName,
                        onCopyTranscript = onCopyTranscript,
                        onExportSession = onExportSession,
                        onDeleteSession = onDeleteSession,
                        onCopyId = onCopyId,
                    )
                }
                if (!filterActive && roots.size > MAX_PROJECT_SESSIONS) {
                    TextButton(
                        onClick = { showAllRoots = !showAllRoots },
                        modifier = Modifier.padding(start = 24.dp, bottom = 4.dp),
                    ) {
                        Text(
                            text = if (showAllRoots) {
                                stringResource(R.string.session_show_less)
                            } else {
                                stringResource(R.string.session_show_more, roots.size - MAX_PROJECT_SESSIONS)
                            },
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(2.dp))
    }
}

@Composable
private fun ProjectActivityBadges(activity: ProjectActivity, totalSessions: Int) {
    val colors = LocalOmpColors.current
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(end = 2.dp),
    ) {
        if (activity.running > 0) {
            val label = stringResource(R.string.project_running_count, activity.running)
            ActivityBadge(label = activity.running.toString(), description = label, color = colors.statusSuccess)
        }
        if (activity.unread > 0) {
            val label = stringResource(R.string.project_unread_count, activity.unread)
            ActivityBadge(label = activity.unread.toString(), description = label, color = colors.accent)
        }
        if (activity.exited > 0) {
            val label = stringResource(R.string.project_exited_count, activity.exited)
            ActivityBadge(label = activity.exited.toString(), description = label, color = colors.statusWarning)
        }
        if (activity.running == 0 && activity.unread == 0 && activity.exited == 0 && totalSessions > 0) {
            Text(
                text = totalSessions.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textDim,
            )
        }
    }
}

@Composable
private fun ActivityBadge(label: String, description: String, color: androidx.compose.ui.graphics.Color) {
    Surface(
        color = color.copy(alpha = 0.16f),
        contentColor = color,
        shape = RoundedCornerShape(999.dp),
        modifier = Modifier.semantics { contentDescription = description },
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
        )
    }
}

/**
 * The "Pinned" block at the top of the list. Pinned sessions are rendered here
 * as a shortcut; the caller keeps their row in the project tree as well, so a
 * pinned fork's children never change parents.
 */
@Composable
internal fun PinnedSection(
    sessions: List<SessionSummary>,
    now: Instant,
    runningIds: Set<String>,
    unreadIds: Set<String>,
    exitedIds: Set<String>,
    /** Sessions another omp process owns: their row says "Elsewhere". */
    elsewhereIds: Set<String>,
    selectedSessionId: String?,
    namingSessionId: String?,
    onSelectSession: (String) -> Unit,
    onTogglePin: (SessionSummary) -> Unit,
    onRenameSession: (SessionSummary) -> Unit,
    onArchiveSession: (SessionSummary) -> Unit,
    onAutoName: (SessionSummary) -> Unit,
    onCopyTranscript: (SessionSummary) -> Unit,
    onExportSession: (SessionSummary) -> Unit,
    onDeleteSession: (SessionSummary) -> Unit,
    onCopyId: (String) -> Unit,
) {
    if (sessions.isEmpty()) return
    val colors = LocalOmpColors.current
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = stringResource(R.string.sessions_pinned),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = colors.accent,
            modifier = Modifier.padding(start = 16.dp, top = 8.dp, bottom = 2.dp),
        )
        sessions.forEach { session ->
            SessionRow(
                session = session,
                depth = 0,
                now = now,
                running = session.id in runningIds,
                unread = session.id in unreadIds,
                exited = session.id in exitedIds,
                elsewhere = session.id in elsewhereIds,
                selected = session.id == selectedSessionId,
                naming = session.id == namingSessionId,
                pinned = true,
                hasChildren = false,
                collapsed = false,
                hasForks = false,
                onSelect = { onSelectSession(session.id) },
                onTogglePin = { onTogglePin(session) },
                onToggleChildren = {},
                onRename = { onRenameSession(session) },
                onArchive = { onArchiveSession(session) },
                onAutoName = { onAutoName(session) },
                onCopyTranscript = { onCopyTranscript(session) },
                onExport = { onExportSession(session) },
                onDelete = { onDeleteSession(session) },
                onCopyId = { onCopyId(session.id) },
            )
        }
        Spacer(Modifier.height(6.dp))
    }
}

@Composable
private fun SessionTreeRows(
    node: SessionTreeNode,
    depth: Int,
    now: Instant,
    runningIds: Set<String>,
    unreadIds: Set<String>,
    exitedIds: Set<String>,
    /** Sessions another omp process owns: their row says "Elsewhere". */
    elsewhereIds: Set<String>,
    selectedSessionId: String?,
    namingSessionId: String?,
    pinnedIds: Set<String>,
    childIds: Set<String>,
    collapsedNodes: MutableMap<String, Boolean>,
    onSelectSession: (String) -> Unit,
    onTogglePin: (SessionSummary) -> Unit,
    onRenameSession: (SessionSummary) -> Unit,
    onArchiveSession: (SessionSummary) -> Unit,
    onAutoName: (SessionSummary) -> Unit,
    onCopyTranscript: (SessionSummary) -> Unit,
    onExportSession: (SessionSummary) -> Unit,
    onDeleteSession: (SessionSummary) -> Unit,
    onCopyId: (String) -> Unit,
) {
    val session = node.session
    val hasChildren = node.children.isNotEmpty()
    val collapsed = collapsedNodes[session.id] == true
    SessionRow(
        session = session,
        depth = depth,
        now = now,
        running = session.id in runningIds,
        unread = session.id in unreadIds,
        exited = session.id in exitedIds,
        elsewhere = session.id in elsewhereIds,
        selected = session.id == selectedSessionId,
        naming = session.id == namingSessionId,
        pinned = session.id in pinnedIds,
        hasChildren = hasChildren,
        collapsed = collapsed,
        hasForks = session.id in childIds,
        onSelect = { onSelectSession(session.id) },
        onTogglePin = { onTogglePin(session) },
        onToggleChildren = { collapsedNodes[session.id] = !collapsed },
        onRename = { onRenameSession(session) },
        onArchive = { onArchiveSession(session) },
        onAutoName = { onAutoName(session) },
        onCopyTranscript = { onCopyTranscript(session) },
        onExport = { onExportSession(session) },
        onDelete = { onDeleteSession(session) },
        onCopyId = { onCopyId(session.id) },
    )
    if (hasChildren && !collapsed) {
        node.children.forEach { child ->
            SessionTreeRows(
                node = child,
                depth = depth + 1,
                now = now,
                runningIds = runningIds,
                unreadIds = unreadIds,
                exitedIds = exitedIds,
                elsewhereIds = elsewhereIds,
                selectedSessionId = selectedSessionId,
                namingSessionId = namingSessionId,
                pinnedIds = pinnedIds,
                childIds = childIds,
                collapsedNodes = collapsedNodes,
                onSelectSession = onSelectSession,
                onTogglePin = onTogglePin,
                onRenameSession = onRenameSession,
                onArchiveSession = onArchiveSession,
                onAutoName = onAutoName,
                onCopyTranscript = onCopyTranscript,
                onExportSession = onExportSession,
                onDeleteSession = onDeleteSession,
                onCopyId = onCopyId,
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun SessionRow(
    session: SessionSummary,
    depth: Int,
    now: Instant,
    running: Boolean,
    unread: Boolean,
    exited: Boolean,
    /** Another omp process runs this session: sending here would copy it. */
    elsewhere: Boolean,
    selected: Boolean,
    naming: Boolean,
    pinned: Boolean,
    hasChildren: Boolean,
    collapsed: Boolean,
    hasForks: Boolean,
    onSelect: () -> Unit,
    onTogglePin: () -> Unit,
    onToggleChildren: () -> Unit,
    onRename: () -> Unit,
    onArchive: () -> Unit,
    onAutoName: () -> Unit,
    onCopyTranscript: () -> Unit,
    onExport: () -> Unit,
    onDelete: () -> Unit,
    onCopyId: () -> Unit,
) {
    val colors = LocalOmpColors.current
    var menuOpen by remember(session.id) { mutableStateOf(false) }
    val title = session.title() ?: stringResource(R.string.session_untitled)
    val unreadDescription = stringResource(R.string.session_unread)
    val elsewhereDescription = stringResource(R.string.session_elsewhere_description)
    val time = relativeTime(session.modified, now)
    val branch = session.worktreeBranch
    val background = if (selected) colors.selected else colors.background

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(background)
            .combinedClickable(onClick = onSelect, onLongClick = onTogglePin)
            .padding(start = (26 + depth * 14).dp, end = 2.dp, top = 6.dp, bottom = 6.dp),
    ) {
        if (hasChildren) {
            IconButton(onClick = onToggleChildren) {
                Icon(
                    imageVector = if (collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown,
                    contentDescription = stringResource(
                        if (collapsed) R.string.session_expand_forks else R.string.session_collapse_forks,
                    ),
                    tint = colors.textDim,
                    modifier = Modifier.size(16.dp),
                )
            }
        } else {
            Spacer(Modifier.width(8.dp))
        }
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(
                    when {
                        running -> colors.statusSuccess
                        elsewhere -> colors.statusWarning
                        exited -> colors.statusWarning
                        unread -> colors.accent
                        else -> colors.textDim.copy(alpha = 0.45f)
                    },
                ),
        )
        Spacer(Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (selected || unread) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = if (running) colors.text else colors.textMuted,
            )
            val detailParts = listOfNotNull(time, branch?.let { stringResource(R.string.session_worktree, it) })
            if (detailParts.isNotEmpty()) {
                Text(
                    text = detailParts.joinToString(" · "),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (naming) {
            CircularProgressIndicator(
                strokeWidth = 1.5.dp,
                modifier = Modifier
                    .padding(horizontal = 6.dp)
                    .size(12.dp)
                    .testTag("session-autoname-spinner-${session.id}"),
            )
        }
        if (running) {
            Text(
                text = stringResource(R.string.session_running),
                style = MaterialTheme.typography.labelSmall,
                color = colors.statusSuccess,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(horizontal = 6.dp),
            )
        } else if (elsewhere) {
            // Another omp process owns it: the chat follows read-only and asks
            // before sending (web sidebar `runningElsewhere` badge).
            Text(
                text = stringResource(R.string.session_elsewhere),
                style = MaterialTheme.typography.labelSmall,
                color = colors.statusWarning,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .padding(horizontal = 6.dp)
                    .semantics { contentDescription = elsewhereDescription },
            )
        } else if (unread) {
            Box(
                modifier = Modifier
                    .padding(horizontal = 6.dp)
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(colors.accent)
                    .semantics { contentDescription = unreadDescription },
            )
        }
        Box {
            IconButton(
                onClick = { menuOpen = true },
                modifier = Modifier.testTag("session-menu-${session.id}"),
            ) {
                Icon(
                    imageVector = Icons.Filled.MoreVert,
                    contentDescription = stringResource(R.string.session_menu),
                    tint = colors.textMuted,
                    modifier = Modifier.size(16.dp),
                )
            }
            OmpDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = {
                        Text(stringResource(if (pinned) R.string.session_unpin else R.string.session_pin))
                    },
                    onClick = {
                        menuOpen = false
                        onTogglePin()
                    },
                )
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(stringResource(R.string.session_archive))
                            if (hasForks) {
                                Text(
                                    text = stringResource(R.string.session_archive_leaf_only),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.textMuted,
                                )
                            }
                        }
                    },
                    enabled = !hasForks,
                    onClick = {
                        menuOpen = false
                        onArchive()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.session_rename)) },
                    onClick = {
                        menuOpen = false
                        onRename()
                    },
                )
                DropdownMenuItem(
                    // Nothing to summarize in an empty session; the running
                    // request also keeps the item disabled (A5).
                    text = {
                        Text(
                            stringResource(
                                if (naming) R.string.session_auto_name_running
                                else R.string.session_auto_name,
                            ),
                        )
                    },
                    enabled = !naming && session.messageCount > 0,
                    onClick = {
                        menuOpen = false
                        onAutoName()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.session_copy_transcript)) },
                    onClick = {
                        menuOpen = false
                        onCopyTranscript()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.session_export)) },
                    onClick = {
                        menuOpen = false
                        onExport()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.session_copy_id)) },
                    onClick = {
                        menuOpen = false
                        onCopyId()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.session_delete)) },
                    onClick = {
                        menuOpen = false
                        onDelete()
                    },
                )
            }
        }
    }
}
