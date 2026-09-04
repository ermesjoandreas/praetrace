import { BaseEdge, getBezierPath, Position, type Edge, type EdgeProps } from '@xyflow/react';
import type { AssociationRole, EdgeKind } from './api';

/**
 * What one line on the canvas knows beyond its two ends. The kind is what the
 * class name already says and is carried again so the marks below need no
 * parsing of it; the rest is present only on an association.
 */
export type RelationData = {
  kind: EdgeKind;
  /** See `ViewEdge.roles`: every field behind an association line. */
  roles?: AssociationRole[];
  /** See `ViewEdge.ownership`: the diamond, decided by the view and not here. */
  ownership?: 'composition' | 'aggregation';
};

export type RelationEdgeType = Edge<RelationData, 'relation'>;

/** Length and half-width of the diamond, and of the open arrowhead. */
const DIAMOND = { length: 12, half: 3.5 };
const HEAD = { length: 8, half: 4 };
/** How far the role text stands off the target box, and above the line. */
const ROLE_GAP = 10;
const ROLE_LIFT = 5;
/** Line height of the role text; `--vsc-font-size-sm` plus the usual leading. */
const ROLE_LINE = 13;
/** Past this many roles the rest are a count: a folder line can carry twenty. */
const ROLE_ROWS = 3;

/**
 * The direction a line leaves a handle in, as a unit vector. A handle on the
 * right side of a box sends the line rightwards; the target's mirror image is
 * the direction the line arrives in.
 */
function outward(position: Position): { x: number; y: number } {
  switch (position) {
    case Position.Left:
      return { x: -1, y: 0 };
    case Position.Top:
      return { x: 0, y: -1 };
    case Position.Bottom:
      return { x: 0, y: 1 };
    default:
      return { x: 1, y: 0 };
  }
}

/**
 * UML's diamond, tip on the holder's box and pointing along the line. The
 * same path for both diamonds; which of the two it is, is a fill.
 */
function diamond(x: number, y: number, position: Position): string {
  const n = outward(position);
  const mid = { x: x + (n.x * DIAMOND.length) / 2, y: y + (n.y * DIAMOND.length) / 2 };
  const far = { x: x + n.x * DIAMOND.length, y: y + n.y * DIAMOND.length };
  // Perpendicular to the direction of travel.
  const p = { x: -n.y * DIAMOND.half, y: n.x * DIAMOND.half };
  return `M ${x} ${y} L ${mid.x + p.x} ${mid.y + p.y} L ${far.x} ${far.y} L ${mid.x - p.x} ${mid.y - p.y} Z`;
}

/** UML's dependency arrowhead: two strokes meeting at the target, never filled. */
function openHead(x: number, y: number, position: Position): string {
  const n = outward(position);
  // The line arrives against the handle's outward direction.
  const back = { x: x + n.x * HEAD.length, y: y + n.y * HEAD.length };
  const p = { x: -n.y * HEAD.half, y: n.x * HEAD.half };
  return `M ${back.x + p.x} ${back.y + p.y} L ${x} ${y} L ${back.x - p.x} ${back.y - p.y}`;
}

/**
 * The far end's multiplicity, as UML writes it, from what the field declared.
 * `*` and not `1..*` for an array: `Node[]` says nothing about being
 * non-empty, and `1..*` would be a claim the source did not make. And nothing
 * at all when the field said neither: `1` is a claim of exactly one, and a
 * Java `private Store store;` is nullable by default — the graph's rule for
 * every attribute is that absent means the source did not say.
 */
function multiplicity(role: AssociationRole): string {
  if (role.many === true) return '*';
  if (role.optional === true) return '0..1';
  return '';
}

/** One row per role, cut at a box's worth with the rest counted. */
function roleRows(roles: readonly AssociationRole[]): string[] {
  const rows = roles
    .slice(0, ROLE_ROWS)
    .map((role) => [role.name, multiplicity(role)].filter((part) => part !== '').join(' '));
  if (roles.length > ROLE_ROWS) rows.push(`+${roles.length - ROLE_ROWS} more`);
  return rows;
}

/**
 * Every line on the canvas. One component rather than one per kind: the path,
 * the weight label and the dimming are the same for all of them, and what a
 * kind adds is a mark at one end or the other — UML's diamond at the holder's
 * end of an association with the role names and multiplicities at the far
 * end, and an open arrowhead on a dependency. Each mark is drawn only from
 * something the view said: a diamond needs `ownership`, which the view
 * decided over the roles, so a line the source did not mark wears none.
 */
export function RelationEdge({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  label,
  style,
}: EdgeProps<RelationEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const roles = data?.roles;
  const arrival = outward(targetPosition);
  // The text sits just short of the target box, lifted off the line, and is
  // anchored so it grows away from the box rather than into it.
  const roleX = targetX + arrival.x * ROLE_GAP;
  const roleY = targetY + arrival.y * ROLE_GAP - ROLE_LIFT;
  const anchor = arrival.x < 0 ? 'end' : arrival.x > 0 ? 'start' : 'middle';

  return (
    <>
      {/* The weight label and the style are the two things App sets on a
          line; the other label options are never set, and forwarding an
          explicit undefined is what `exactOptionalPropertyTypes` refuses. */}
      <BaseEdge
        path={path}
        labelX={labelX}
        labelY={labelY}
        {...(label === undefined ? {} : { label })}
        {...(style === undefined ? {} : { style })}
      />
      {data?.kind === 'depends' && (
        <path className="edge-head" d={openHead(targetX, targetY, targetPosition)} />
      )}
      {data?.ownership !== undefined && (
        <path
          className={`edge-diamond edge-diamond-${data.ownership}`}
          d={diamond(sourceX, sourceY, sourcePosition)}
        />
      )}
      {roles !== undefined && roles.length > 0 && (
        <text className="edge-roles" x={roleX} y={roleY} textAnchor={anchor}>
          {roleRows(roles).map((row, index) => (
            // Stacked upwards from the line, so the first role is the one
            // nearest it however many there are.
            <tspan key={row + index} x={roleX} dy={index === 0 ? 0 : -ROLE_LINE}>
              {row}
            </tspan>
          ))}
        </text>
      )}
    </>
  );
}
