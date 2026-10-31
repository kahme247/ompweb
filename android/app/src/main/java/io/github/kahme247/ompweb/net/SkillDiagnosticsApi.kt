package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.SkillDiagnosticsSnapshot

/**
 * The two skill-resolution calls the startup notice and the Skills inspector
 * make (web `lib/rpc-manager.ts` `get_skill_diagnostics` /
 * `set_skill_startup_diagnostics`).
 *
 * Both answer with the effective report. `null` means the server has no
 * report for this session (an omp without the RPC, or a payload the
 * allowlisted parser rejected), so the UI shows "unavailable" instead of
 * claiming a clean result.
 */
interface SkillDiagnosticsApi {

    /** `{type:"get_skill_diagnostics"}`. */
    suspend fun skillDiagnostics(sessionId: String): SkillDiagnosticsSnapshot?

    /** `{type:"set_skill_startup_diagnostics", enabled}`; answers with the effective report. */
    suspend fun setSkillStartupDiagnostics(sessionId: String, enabled: Boolean): SkillDiagnosticsSnapshot?
}
