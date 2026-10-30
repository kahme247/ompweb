# Isolated env for every spike run: never touch the real ~/.omp or spawn the real omp.
export HOME=/tmp/bunspike/home
export PI_CODING_AGENT_DIR=/tmp/bunspike/home/.omp/agent
export OMP_WEB_OMP_BIN=/nonexistent/omp
unset OMP_WEB_PORT OMP_WEB_PASSWORD OMP_WEB_PASSWORD_HASH
export BUN=/root/.bun/bin/bun
