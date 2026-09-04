/**
 * What the find bar says beside its input, in VS Code's words.
 *
 * Nothing before anything is typed — an empty query is not a search. "No
 * results" when it matched nothing. "3 of 17" once there is a match to be the
 * 3, and the plain count when there is not: the index the last Enter left
 * behind can outlive the match it named, because the diagram goes on changing
 * under the bar. Saying "8 of 3" would be the confident wrong answer this
 * project cares most about, in miniature.
 */
export function countLabel(query: string, matches: number, current: number): string {
  if (query.trim() === '') return '';
  if (matches === 0) return 'No results';
  if (current < 0 || current >= matches) return matches === 1 ? '1 match' : `${matches} matches`;
  return `${current + 1} of ${matches}`;
}
