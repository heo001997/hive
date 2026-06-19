export function parseProtectedBranches(raw?: string | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((b) => b.trim().toLowerCase())
    .filter(Boolean)
}

export function isProtectedBranch(branch?: string | null, raw?: string | null): boolean {
  if (!branch) return false
  return parseProtectedBranches(raw).includes(branch.trim().toLowerCase())
}
