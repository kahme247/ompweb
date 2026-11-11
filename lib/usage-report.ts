import { pullAllHostUsage } from "./hosts/usage-sync";
import { invalidateSessionFileListCache } from "./omp/session-files";
import { getUsageDatabase, getUsageReportFromDb } from "./usage-db";
import { invalidateUsageCache } from "./usage-service";
import type { UsageQueryOptions, UsageReport } from "./usage-types";

/**
 * Usage of this machine's sessions plus every linked host's, from the persistent SQLite usage database.
 * Kept out of usage-service.ts, which the host daemon loads under Node, where `bun:sqlite` does not exist.
 */
export async function getUsageReport(options: UsageQueryOptions = {}): Promise<UsageReport> {
  if (options.forceRefresh) {
    invalidateUsageCache();
    invalidateSessionFileListCache();
  }
  const db = getUsageDatabase();
  const hosts = await pullAllHostUsage(db, options.forceRefresh === true);
  return getUsageReportFromDb(options, db, hosts);
}
