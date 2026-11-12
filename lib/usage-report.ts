import { pullAllHostUsage } from "./hosts/usage-sync";
import { getUsageDatabase, getUsageReportFromDb } from "./usage-db";
import type { UsageQueryOptions, UsageReport } from "./usage-types";

/**
 * Usage of this machine's sessions plus every linked host's, from the persistent SQLite usage database.
 * Kept out of usage-service.ts, which the host daemon loads under Node, where `bun:sqlite` does not exist.
 */
export async function getUsageReport(options: UsageQueryOptions = {}): Promise<UsageReport> {
  const db = getUsageDatabase();
  return getUsageReportFromDb(options, db, await pullAllHostUsage(db, options.forceRefresh === true));
}
