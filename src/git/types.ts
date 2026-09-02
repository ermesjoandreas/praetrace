/**
 * What the working tree looks like against some base commit. These live apart
 * from `project/git.ts` for the same reason `graph/types.ts` lives apart from
 * `parser/`: the view layer has to name a file's status without pulling in the
 * module that shells out to git.
 */

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';

export interface GitStatus {
  /** The base the working tree was compared against, as resolved. */
  base: string;
  /** What the user asked for ('HEAD' | 'HEAD~1' | 'branch'), before resolution. */
  requested: string;
  /** Current branch, or null on a detached HEAD. */
  branch: string | null;
  /** Project-root-relative POSIX path -> status. */
  files: Record<string, GitFileStatus>;
  /**
   * Lines added and removed against the base, per path.
   *
   * Only for what git can count. An untracked file has no diff to measure — every
   * line of it is new, which its status already says — and a binary file reports
   * a dash. Both are absent here rather than being guessed at as zero, because
   * "0 changed" and "not counted" read the same on screen and mean the opposite.
   */
  lines: Record<string, { added: number; deleted: number }>;
  /** The same, summed, so the chip does not add up a thousand entries. */
  totals: { added: number; deleted: number };
}
