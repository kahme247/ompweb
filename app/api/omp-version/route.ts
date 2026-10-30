import { getOmpVersion } from "@/lib/omp/omp-cli";

/** Runtime probe of the installed omp binary ("omp/17.1.3"), separate from the
 * build-time omp-web version — the two can legitimately drift. */
export async function GET() {
  const version = await getOmpVersion();
  return Response.json({ version });
}
