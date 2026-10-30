import * as r0 from "../app/api/agent/[id]/bash-output/route";
import * as r1 from "../app/api/agent/[id]/route";
import * as r2 from "../app/api/agent/new/route";
import * as r3 from "../app/api/agents/route";
import * as r4 from "../app/api/app-update/notes/route";
import * as r5 from "../app/api/app-update/route";
import * as r6 from "../app/api/auth/accounts/[provider]/route";
import * as r7 from "../app/api/auth/all-providers/route";
import * as r8 from "../app/api/auth/api-key/[provider]/route";
import * as r9 from "../app/api/auth/login/[provider]/route";
import * as r10 from "../app/api/auth/providers/route";
import * as r11 from "../app/api/cwd/browse/route";
import * as r12 from "../app/api/cwd/validate/route";
import * as r13 from "../app/api/default-cwd/route";
import * as r14 from "../app/api/events/route";
import * as r15 from "../app/api/file-index/route";
import * as r16 from "../app/api/files/[...path]/route";
import * as r17 from "../app/api/git/diff/route";
import * as r18 from "../app/api/git/status/route";
import * as r19 from "../app/api/github-repo/route";
import * as r20 from "../app/api/home/route";
import * as r21 from "../app/api/hosts/link/blob/[reqId]/route";
import * as r22 from "../app/api/hosts/link/route";
import * as r23 from "../app/api/hosts/route";
import * as r24 from "../app/api/manifest/route";
import * as r25 from "../app/api/mcp/route";
import * as r26 from "../app/api/media/[hash]/route";
import * as r27 from "../app/api/model-roles/route";
import * as r28 from "../app/api/models-config/catalog/route";
import * as r29 from "../app/api/models-config/route";
import * as r30 from "../app/api/models-config/test/route";
import * as r31 from "../app/api/models/route";
import * as r32 from "../app/api/notifications/devices/route";
import * as r33 from "../app/api/notifications/history/route";
import * as r34 from "../app/api/notifications/presence/route";
import * as r35 from "../app/api/notifications/test/route";
import * as r36 from "../app/api/omp-settings/route";
import * as r37 from "../app/api/omp-update/route";
import * as r38 from "../app/api/omp-version/route";
import * as r39 from "../app/api/plugins/route";
import * as r40 from "../app/api/projects/clone/route";
import * as r41 from "../app/api/projects/route";
import * as r42 from "../app/api/provider-usage/route";
import * as r43 from "../app/api/providers/enable/route";
import * as r44 from "../app/api/sessions/[id]/archive/route";
import * as r45 from "../app/api/sessions/[id]/auto-name/route";
import * as r46 from "../app/api/sessions/[id]/context/route";
import * as r47 from "../app/api/sessions/[id]/entries/[entryId]/thinking/route";
import * as r48 from "../app/api/sessions/[id]/export/route";
import * as r49 from "../app/api/sessions/[id]/route";
import * as r50 from "../app/api/sessions/[id]/state/route";
import * as r51 from "../app/api/sessions/[id]/subagents/[subagentId]/route";
import * as r52 from "../app/api/sessions/[id]/subagents/route";
import * as r53 from "../app/api/sessions/archive/route";
import * as r54 from "../app/api/sessions/import/route";
import * as r55 from "../app/api/sessions/route";
import * as r56 from "../app/api/sessions/search/route";
import * as r57 from "../app/api/skills/check/route";
import * as r58 from "../app/api/skills/install/route";
import * as r59 from "../app/api/skills/route";
import * as r60 from "../app/api/skills/search/route";
import * as r61 from "../app/api/skills/update/route";
import * as r62 from "../app/api/stt/[jobId]/audio/route";
import * as r63 from "../app/api/stt/[jobId]/route";
import * as r64 from "../app/api/stt/route";
import * as r65 from "../app/api/usage/route";
import * as r66 from "../app/api/web-auth/session/route";
import * as r67 from "../app/api/web-settings/route";
import * as r68 from "../app/api/windows-service/route";
import * as r69 from "../app/api/worktrees/route";
export default {
  "api/agent/[id]/bash-output": r0,
  "api/agent/[id]": r1,
  "api/agent/new": r2,
  "api/agents": r3,
  "api/app-update/notes": r4,
  "api/app-update": r5,
  "api/auth/accounts/[provider]": r6,
  "api/auth/all-providers": r7,
  "api/auth/api-key/[provider]": r8,
  "api/auth/login/[provider]": r9,
  "api/auth/providers": r10,
  "api/cwd/browse": r11,
  "api/cwd/validate": r12,
  "api/default-cwd": r13,
  "api/events": r14,
  "api/file-index": r15,
  "api/files/[...path]": r16,
  "api/git/diff": r17,
  "api/git/status": r18,
  "api/github-repo": r19,
  "api/home": r20,
  "api/hosts/link/blob/[reqId]": r21,
  "api/hosts/link": r22,
  "api/hosts": r23,
  "api/manifest": r24,
  "api/mcp": r25,
  "api/media/[hash]": r26,
  "api/model-roles": r27,
  "api/models-config/catalog": r28,
  "api/models-config": r29,
  "api/models-config/test": r30,
  "api/models": r31,
  "api/notifications/devices": r32,
  "api/notifications/history": r33,
  "api/notifications/presence": r34,
  "api/notifications/test": r35,
  "api/omp-settings": r36,
  "api/omp-update": r37,
  "api/omp-version": r38,
  "api/plugins": r39,
  "api/projects/clone": r40,
  "api/projects": r41,
  "api/provider-usage": r42,
  "api/providers/enable": r43,
  "api/sessions/[id]/archive": r44,
  "api/sessions/[id]/auto-name": r45,
  "api/sessions/[id]/context": r46,
  "api/sessions/[id]/entries/[entryId]/thinking": r47,
  "api/sessions/[id]/export": r48,
  "api/sessions/[id]": r49,
  "api/sessions/[id]/state": r50,
  "api/sessions/[id]/subagents/[subagentId]": r51,
  "api/sessions/[id]/subagents": r52,
  "api/sessions/archive": r53,
  "api/sessions/import": r54,
  "api/sessions": r55,
  "api/sessions/search": r56,
  "api/skills/check": r57,
  "api/skills/install": r58,
  "api/skills": r59,
  "api/skills/search": r60,
  "api/skills/update": r61,
  "api/stt/[jobId]/audio": r62,
  "api/stt/[jobId]": r63,
  "api/stt": r64,
  "api/usage": r65,
  "api/web-auth/session": r66,
  "api/web-settings": r67,
  "api/windows-service": r68,
  "api/worktrees": r69,
};
