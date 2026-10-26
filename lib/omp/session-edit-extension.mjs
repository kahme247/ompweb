// Loaded by omp, not by its model: use only the public extension command API.
export const SESSION_EDIT_COMMAND = "omp-web-edit";
export const SESSION_EDIT_RESPONSE_PREFIX = "omp-web-edit:";

export default function registerSessionEdit(pi) {
  pi.registerCommand(SESSION_EDIT_COMMAND, {
    description: "Edit a user message in the current session",
    handler: async (args, ctx) => {
      let request;
      try {
        request = JSON.parse(args);
        if (typeof request.requestId !== "string" || typeof request.entryId !== "string" || typeof request.sessionId !== "string") {
          throw new Error("Invalid session edit request");
        }
        if (!ctx.isIdle()) throw new Error("Cannot edit while the agent is running");
        const entry = ctx.sessionManager.getEntry(request.entryId);
        if (entry?.type !== "message" || entry.message.role !== "user") {
          throw new Error("The edit target must be a user message");
        }
        const sessionId = ctx.sessionManager.getSessionId();
        if (request.sessionId !== sessionId) throw new Error("The session changed before editing history");
        const result = await ctx.navigateTree(entry.id, { summarize: false });
        if (ctx.sessionManager.getSessionId() !== sessionId) {
          throw new Error("The session changed while editing history");
        }
        if (!result.cancelled) {
          // Navigation selects the target's parent, preserving the old branch.
          // The non-message marker persists that leaf without adding context;
          // its first native write may legitimately move an unowned session.
          pi.appendEntry("omp-web-history-navigation", { entryId: entry.id });
        }
        ctx.ui.notify(SESSION_EDIT_RESPONSE_PREFIX + JSON.stringify({
          requestId: request.requestId,
          sessionId: ctx.sessionManager.getSessionId(),
          cancelled: result.cancelled,
          leafId: ctx.sessionManager.getLeafId(),
        }), "info");
      } catch (error) {
        if (typeof request?.requestId !== "string") return;
        ctx.ui.notify(SESSION_EDIT_RESPONSE_PREFIX + JSON.stringify({
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        }), "info");
      }
    },
  });
}
