/**
 * Public fields of one FS-1 membership row. wallet postedMemberKeys must
 * match this set. spend.js re-exports it. This file imports nothing, so the
 * Android admit job can load it without node_modules.
 */
export const MEMBER_KEYS = new Set(['commit', 'hash', 'side', 'anchor', 'root']);
