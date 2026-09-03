import { normalizeProfileName } from "./omp/paths";

/** 默认 profile 在 Web 端会话标识中的稳定名称。 */
const DEFAULT_PROFILE_SEGMENT = "default";
const SESSION_ID_SEPARATOR = ":";

/**
 * 判断字符串是否是 omp-web 的 profile 会话标识。
 *
 * @param sessionKey 待判断的会话标识。
 * @returns 标识格式合法时为 true；原生 OMP 会话 id 为 false。
 */
export function isProfiledSessionKey(sessionKey: string): boolean {
  const separator = sessionKey.indexOf(SESSION_ID_SEPARATOR);
  if (separator <= 0 || separator === sessionKey.length - 1) return false;

  const profileSegment = sessionKey.slice(0, separator);
  if (profileSegment === DEFAULT_PROFILE_SEGMENT) return true;
  try {
    return normalizeProfileName(profileSegment) !== undefined;
  } catch {
    return false;
  }
}

/**
 * 生成包含 profile 的 Web 会话标识，避免不同 profile 的原生 OMP 会话 id 冲突。
 *
 * @param profile OMP profile；空值和 "default" 表示默认 profile。
 * @param nativeSessionId OMP 写入 JSONL 的原生会话 id。
 * @returns 可安全用于 omp-web API、状态缓存和 React key 的会话标识。
 */
export function sessionKeyForProfile(profile: string | undefined, nativeSessionId: string): string {
  const normalizedProfile = normalizeProfileName(profile);
  return `${normalizedProfile ?? DEFAULT_PROFILE_SEGMENT}${SESSION_ID_SEPARATOR}${nativeSessionId}`;
}

/**
 * 从 Web 会话标识恢复其所属 profile。
 *
 * @param sessionKey 由 {@link sessionKeyForProfile} 生成的会话标识。
 * @returns 命名 profile；默认 profile 返回 undefined。非复合标识返回 undefined。
 */
export function profileForSessionKey(sessionKey: string): string | undefined {
  const separator = sessionKey.indexOf(SESSION_ID_SEPARATOR);
  if (separator <= 0) return undefined;

  const profileSegment = sessionKey.slice(0, separator);
  if (profileSegment === DEFAULT_PROFILE_SEGMENT) return undefined;
  try {
    return normalizeProfileName(profileSegment);
  } catch {
    return undefined;
  }
}
