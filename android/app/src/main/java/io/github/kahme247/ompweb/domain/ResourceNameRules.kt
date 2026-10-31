package io.github.kahme247.ompweb.domain

/**
 * Name rule shared by MCP servers and agents, used by both settings editors.
 *
 * The server declares the same pattern twice: `SERVER_NAME` in
 * `lib/omp/mcp-config.ts` and `AGENT_NAME_RE` in `lib/omp/agents-service.ts`
 * are both `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Android keeps one constant so
 * the two forms cannot drift apart; if the server ever splits the rules, split
 * this constant instead of adding a second copy.
 */
val OMP_RESOURCE_NAME_RE: Regex = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
