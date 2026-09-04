/**
 * The activity diagram of one function: its control flow, read off the syntax
 * tree and nothing else.
 *
 * CLAUDE.md is right that an activity diagram is not derivable from static
 * structure *across* files. Inside one function body it is: an `if` is an `if`
 * in the tree, a loop is a loop, a return is a return, and none of it needs a
 * receiver typed — which is what a sequence diagram needs, and what the parser
 * can supply for 13% of call sites. So this is the one behavioural diagram
 * that can be complete rather than a sample, and that is the only reason it
 * exists.
 *
 * Not graph structure. The graph is the single source of truth for what the
 * project *is*; this is a detail about one symbol, like /api/symbol, computed
 * on request and never stored in the graph.
 *
 * Pure over a tree-sitter node. The parse that produces the node runs in the
 * worker (decision 1); nothing here reads a file. And nothing here guesses: a
 * language without a table answers null, not a wrong diagram, and what the
 * diagram leaves out it names in `notDrawn`.
 */

import type { LanguageId, SyntaxNode } from '../lang/types.js';

export type FlowNodeKind = 'start' | 'end' | 'action' | 'decision' | 'loop' | 'try' | 'exit';
export type FlowExit = 'return' | 'throw' | 'break' | 'continue';

/** 1-based, inclusive, like every range the graph carries. */
export interface FlowRange {
  startLine: number;
  endLine: number;
}

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  /**
   * What the box says: the first line of a run, a condition with its parens
   * stripped, a loop's header, `return x`, `catch (e)`. First line only, and
   * cut at MAX_LABEL with an ellipsis, so a 30-line object literal is one line
   * on the page and the range below is how to read the rest.
   */
  label: string;
  /** Where in the file, so the page can open the editor at it. */
  range: FlowRange;
  /**
   * Action only: how many further statements the box stands for. A run of
   * plain statements is one box — without this a 30-line function is 30 boxes
   * and the branches that are the point of the diagram are lost among them.
   */
  more?: number;
  /** Exit only: which kind. `return` and `throw` flow to end, `break` and `continue` to their loop. */
  exit?: FlowExit;
  /**
   * Present when the box holds a function body that was deliberately not
   * walked — a callback passed as an argument, a nested function. It is a
   * separate function, and its branches are not this function's branches; the
   * note is what keeps the box from reading as a plain statement.
   */
  note?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** `yes` / `no` off a decision or loop, a case's value off a switch, `catch` off a try. */
  label?: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /**
   * What is in the function and not in the diagram, in sentences for the page
   * to print. A diagram that leaves things out and says which is honest; one
   * that leaves them out silently is the thing this project exists to avoid.
   */
  notDrawn: string[];
}

/** Message shapes exchanged with the parser worker, beside the parse ones. */

export interface FlowRequest {
  id: number;
  /** What tells the worker this from a ParseRequest. */
  kind: 'flow';
  /** POSIX path relative to the scanned root, as the graph names the file. */
  filePath: string;
  absolutePath: string;
  /** The symbol's range from the graph; the worker finds the function in it. */
  range: FlowRange;
}

/**
 * Null with a reason, never a wrong diagram: the language has no table, or
 * nothing with a body sits at the range.
 */
export type FlowAnswer = { flow: FlowGraph } | { flow: null; reason: string };

export type FlowResponse =
  | { id: number; ok: true; answer: FlowAnswer }
  | { id: number; ok: false; error: string };

/**
 * The longest label a box carries. The page is a diagram, not an editor; the
 * range says where the rest is.
 */
const MAX_LABEL = 80;

/**
 * What one case of a switch holds, in whichever spelling the grammar uses.
 * `fallsThrough` is the language's rule for a case that ends without leaving:
 * JavaScript and a Java colon-case run on into the next, a Java arrow-case and
 * a Go case do not.
 */
interface CaseShape {
  label: string;
  isDefault: boolean;
  statements: SyntaxNode[];
  fallsThrough: boolean;
}

/**
 * A language is a table of node-type names. Three shape-readers where the
 * grammars disagree too much for a name to cover it: which children a switch
 * case holds, and how a switch says it is exhaustive.
 */
interface FlowSyntax {
  /** Function-like nodes: the one asked for is drawn, any inside it is not walked. */
  functions: readonly string[];
  /** Containers whose named children are statements. */
  blocks: readonly string[];
  if: string;
  /** A wrapper around the else branch, when the grammar has one. */
  elseClause: string | null;
  /** Loops tested at the top. */
  loops: readonly string[];
  /** The loop tested at the bottom. */
  doLoop: string | null;
  switches: readonly string[];
  cases(node: SyntaxNode): { cases: CaseShape[]; exhaustive: boolean };
  tries: readonly string[];
  catchClause: string | null;
  finallyClause: string | null;
  return: string;
  throw: string | null;
  break: string;
  continue: string;
  /** Go's explicit `fallthrough`. */
  fallthrough: string | null;
  labeled: string;
  /** Statements whose `body` is a block to walk and nothing more — Java's `synchronized`. */
  wrappers: readonly string[];
  ternary: string | null;
  await: string | null;
  call: string;
  /** Present and drawn where written, so the diagram says so. */
  goStatements: { defer: string; goto: string } | null;
}

/** What a case label says once the keyword and the colon are gone: `case 1, 2:` → `1, 2`. */
function caseLabel(text: string): string {
  return firstLine(text.replace(/^\s*case\b/, '').replace(/\s*(:|->)\s*$/, '')) || 'default';
}

/**
 * Two wrappers for one tree-sitter node are not `===`; the node is its span
 * and its type.
 */
function sameNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

function withoutComments(nodes: readonly SyntaxNode[]): SyntaxNode[] {
  return nodes.filter((node) => !node.type.endsWith('comment'));
}

/**
 * tree-sitter-typescript and tree-sitter-javascript spell every statement the
 * same way, so the two share a table; `await` and the ternary are the JS
 * family's.
 */
const JS_FAMILY: FlowSyntax = {
  functions: [
    'function_declaration',
    'generator_function_declaration',
    'function_expression',
    'generator_function',
    'arrow_function',
    'method_definition',
  ],
  blocks: ['statement_block'],
  if: 'if_statement',
  elseClause: 'else_clause',
  loops: ['for_statement', 'for_in_statement', 'while_statement'],
  doLoop: 'do_statement',
  switches: ['switch_statement'],
  cases(node) {
    const body = node.childForFieldName('body');
    const cases: CaseShape[] = [];
    for (const item of withoutComments(body?.namedChildren ?? [])) {
      const isDefault = item.type === 'switch_default';
      if (!isDefault && item.type !== 'switch_case') continue;
      const children = withoutComments(item.namedChildren);
      cases.push({
        label: isDefault ? 'default' : firstLine(children[0]?.text ?? ''),
        isDefault,
        statements: isDefault ? children : children.slice(1),
        fallsThrough: true,
      });
    }
    return { cases, exhaustive: cases.some((c) => c.isDefault) };
  },
  tries: ['try_statement'],
  catchClause: 'catch_clause',
  finallyClause: 'finally_clause',
  return: 'return_statement',
  throw: 'throw_statement',
  break: 'break_statement',
  continue: 'continue_statement',
  fallthrough: null,
  labeled: 'labeled_statement',
  wrappers: [],
  ternary: 'ternary_expression',
  await: 'await_expression',
  call: 'call_expression',
  goStatements: null,
};

const JAVA: FlowSyntax = {
  functions: ['method_declaration', 'constructor_declaration', 'lambda_expression'],
  blocks: ['block', 'constructor_body'],
  if: 'if_statement',
  elseClause: null,
  loops: ['for_statement', 'enhanced_for_statement', 'while_statement'],
  doLoop: 'do_statement',
  switches: ['switch_expression'],
  cases(node) {
    const body = node.childForFieldName('body');
    const cases: CaseShape[] = [];
    for (const item of withoutComments(body?.namedChildren ?? [])) {
      // A colon-group carries its labels and runs on into the next; an
      // arrow-rule carries one label and one statement, and does not.
      const isGroup = item.type === 'switch_block_statement_group';
      if (!isGroup && item.type !== 'switch_rule') continue;
      const children = withoutComments(item.namedChildren);
      const labels = children.filter((c) => c.type === 'switch_label');
      const isDefault = labels.some((l) => /^\s*default\b/.test(l.text));
      cases.push({
        label: isDefault ? 'default' : labels.map((l) => caseLabel(l.text)).join(', '),
        isDefault,
        statements: children.filter((c) => c.type !== 'switch_label'),
        fallsThrough: isGroup,
      });
    }
    return { cases, exhaustive: cases.some((c) => c.isDefault) };
  },
  tries: ['try_statement', 'try_with_resources_statement'],
  catchClause: 'catch_clause',
  finallyClause: 'finally_clause',
  return: 'return_statement',
  throw: 'throw_statement',
  break: 'break_statement',
  continue: 'continue_statement',
  fallthrough: null,
  labeled: 'labeled_statement',
  wrappers: ['synchronized_statement'],
  ternary: 'ternary_expression',
  await: null,
  call: 'method_invocation',
  goStatements: null,
};

const GO: FlowSyntax = {
  functions: ['function_declaration', 'method_declaration', 'func_literal'],
  blocks: ['block', 'statement_list'],
  if: 'if_statement',
  elseClause: null,
  loops: ['for_statement'],
  doLoop: null,
  switches: ['expression_switch_statement', 'type_switch_statement', 'select_statement'],
  cases(node) {
    const cases: CaseShape[] = [];
    for (const item of withoutComments(node.namedChildren)) {
      if (!item.type.endsWith('_case')) continue;
      const isDefault = item.type === 'default_case';
      const list = item.namedChildren.find((c) => c.type === 'statement_list');
      // An expression case and a select case name what they match in a
      // field; a type case does not, so its label is the text before its
      // statements — never split on `:`, which `m := <-ch` also contains.
      const value = item.childForFieldName('value') ?? item.childForFieldName('communication');
      const head = item.text.slice(0, (list?.startIndex ?? item.endIndex) - item.startIndex);
      cases.push({
        label: isDefault ? 'default' : value ? firstLine(value.text) : caseLabel(head),
        isDefault,
        statements: withoutComments(list?.namedChildren ?? []),
        fallsThrough: false,
      });
    }
    // A select with no default blocks until a case is ready, so there is no
    // way past it; a switch without one is passed by when nothing matches.
    const exhaustive = node.type === 'select_statement' || cases.some((c) => c.isDefault);
    return { cases, exhaustive };
  },
  tries: [],
  catchClause: null,
  finallyClause: null,
  return: 'return_statement',
  throw: null,
  break: 'break_statement',
  continue: 'continue_statement',
  fallthrough: 'fallthrough_statement',
  labeled: 'labeled_statement',
  wrappers: [],
  ternary: null,
  await: null,
  call: 'call_expression',
  goStatements: { defer: 'defer_statement', goto: 'goto_statement' },
};

const SYNTAX: Partial<Record<LanguageId, FlowSyntax>> = {
  typescript: JS_FAMILY,
  javascript: JS_FAMILY,
  java: JAVA,
  go: GO,
};

/** The languages with a table, for the reason a refusal gives. */
export const FLOW_LANGUAGES: readonly LanguageId[] = ['typescript', 'javascript', 'java', 'go'];

export function hasFlowSyntax(language: LanguageId): boolean {
  return SYNTAX[language] !== undefined;
}

/**
 * The function to draw, given the graph's range for a symbol: the outermost
 * function-like node with a body inside it, preferring one that starts on the
 * range's first line. `const f = () => {}` puts the arrow on the declarator's
 * line; `export function f` puts the declaration on the statement's. An
 * interface method or an abstract signature has no body and answers null.
 */
export function functionAt(root: SyntaxNode, range: FlowRange, language: LanguageId): SyntaxNode | null {
  const syntax = SYNTAX[language];
  if (!syntax) return null;
  const first = range.startLine - 1;
  const last = range.endLine - 1;
  // Document order, so an outer function precedes anything nested in it. A
  // function handed to a call is never the answer: `items = xs.map((x) => …)`
  // puts an arrow on the field's own line, and drawing it under the field's
  // name would be the flow of somebody else's function.
  const inside = root
    .descendantsOfType([...syntax.functions])
    .filter(
      (node) =>
        node.startPosition.row >= first &&
        node.endPosition.row <= last &&
        node.childForFieldName('body') !== null &&
        !isArgument(node),
    );
  return inside.find((node) => node.startPosition.row === first) ?? inside[0] ?? null;
}

/** A function written as an argument to a call, in any grammar this reads. */
function isArgument(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'arguments' || parent.type === 'argument_list') return true;
  // Go and Rust wrap the argument; TypeScript wraps a parenthesised or `as`-cast one.
  if (parent.type === 'parenthesized_expression' || parent.type === 'as_expression') return isArgument(parent);
  return false;
}

/** An edge waiting for the node that comes next. */
interface Pending {
  from: string;
  label?: string;
}

/**
 * Where a `break` or `continue` goes. `after` collects the breaks until the
 * construct is finished and knows where after is; `fallthrough` collects an
 * explicit Go `fallthrough` for the next case. A labelled block is a target
 * only for a `break` that names it.
 */
interface Target {
  kind: 'loop' | 'switch' | 'block';
  label: string | null;
  head: string;
  after: Pending[];
  fallthrough: Pending[];
  /** How many finally frames were open when this was entered; see `leave`. */
  depth: number;
}

/**
 * A `finally` that is open while its try body and catch bodies are walked.
 * An exit written inside them runs the finally before it goes anywhere, so
 * the exit's edge goes to the finally box and the finally box gets an edge
 * out for each way something left through it — `return` to end, `break` to
 * the loop — beside the plain one for falling out of the try. Without this
 * a try whose every path returns left the finally box with nothing reaching
 * it, which `history.ts#graphAt` does.
 */
interface FinallyFrame {
  id: string;
  leaves: Leave[];
}

/** Where an exit is going, before any finally on the way is accounted for. */
type Leave =
  | { kind: 'return' }
  | { kind: 'throw'; to: string; depth: number }
  | { kind: 'break' | 'continue'; target: Target };

interface State {
  syntax: FlowSyntax;
  nodes: FlowNode[];
  edges: FlowEdge[];
  targets: Target[];
  /**
   * Where a `throw` goes, innermost last: the single catch of the enclosing
   * try, or null for a try with several — which clause takes it depends on
   * the thrown type, and this walker does not know types, so the throw goes to
   * end and is counted. `depth` is how many finally frames were open when the
   * catch was entered, so a throw inside the try body reaches its own catch
   * directly while one inside the catch body passes through the finally.
   */
  catches: { id: string | null; depth: number }[];
  finallies: FinallyFrame[];
  /** A label waiting for the loop or switch it names. */
  pendingLabel: string | null;
  /**
   * Ternaries and switches drawn as decisions, by start offset, so the ones
   * that sat inside a larger expression can be counted rather than lost.
   */
  drawn: Set<number>;
  ambiguousThrows: number;
  /** Statements tree-sitter had to invent to recover from a syntax error: no text, not drawn. */
  missing: number;
}

/**
 * The flow of one function. Null only when the language has no table — the
 * caller has usually asked `hasFlowSyntax` first, and `functionAt` has
 * already refused a node without a body.
 */
export function flowOf(fn: SyntaxNode, language: LanguageId): FlowGraph | null {
  const syntax = SYNTAX[language];
  if (!syntax) return null;

  const state: State = {
    syntax,
    nodes: [],
    edges: [],
    targets: [],
    catches: [],
    finallies: [],
    pendingLabel: null,
    drawn: new Set(),
    ambiguousThrows: 0,
    missing: 0,
  };

  const body = fn.childForFieldName('body');
  state.nodes.push({ id: 'start', kind: 'start', label: 'start', range: lineAt(fn.startPosition.row) });
  let pending: Pending[] = [{ from: 'start' }];
  if (body !== null) {
    // An arrow's expression body is what the function returns; there is no
    // statement list, so the expression is walked as the one statement.
    pending = syntax.blocks.includes(body.type)
      ? walkList(state, statementsOf(body), pending)
      : walkList(state, [body], pending);
  }
  connect(state, pending, 'end');
  state.nodes.push({ id: 'end', kind: 'end', label: 'end', range: lineAt(fn.endPosition.row) });

  return { nodes: state.nodes, edges: state.edges, notDrawn: notDrawn(state, body) };
}

function statementsOf(block: SyntaxNode): SyntaxNode[] {
  return withoutComments(block.namedChildren);
}

function addNode(state: State, node: Omit<FlowNode, 'id'>): string {
  const id = `n${state.nodes.length}`;
  state.nodes.push({ id, ...node });
  return id;
}

function connect(state: State, pending: readonly Pending[], to: string): void {
  for (const edge of pending) {
    state.edges.push(edge.label === undefined ? { from: edge.from, to } : { from: edge.from, to, label: edge.label });
  }
}

function edge(state: State, from: string, to: string, label?: string): void {
  state.edges.push(label === undefined ? { from, to } : { from, to, label });
}

/**
 * A statement list. Plain statements are merged into one action box per run;
 * anything that branches, loops, leaves or holds a function body gets a box
 * of its own.
 */
function walkList(state: State, statements: readonly SyntaxNode[], incoming: Pending[]): Pending[] {
  let pending = incoming;
  let run: SyntaxNode[] = [];

  const flush = (): void => {
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) return;
    const id = addNode(state, {
      kind: 'action',
      label: firstLine(first.text),
      range: spanOf(first, last),
      ...(run.length > 1 ? { more: run.length - 1 } : {}),
    });
    connect(state, pending, id);
    pending = [{ from: id }];
    run = [];
  };

  for (const statement of statements) {
    if (statement.type === 'empty_statement') continue;
    // `if (a || b)` with nothing after it: tree-sitter recovers by inventing
    // the statement it expected, with no text. An empty box would be drawn
    // from nothing; counted instead, so the diagram can say the source is
    // broken there.
    if (statement.text.trim() === '') {
      state.missing += 1;
      continue;
    }
    if (isPlain(state, statement)) {
      if (!holdsFunction(state, statement)) {
        run.push(statement);
        continue;
      }
      // Its own box, and said so: the callback's branches are not this
      // function's, and merged into a run the note would have nowhere to sit.
      flush();
      const id = addNode(state, {
        kind: 'action',
        label: firstLine(statement.text),
        range: spanOf(statement, statement),
        note: functionNote(state, statement),
      });
      connect(state, pending, id);
      pending = [{ from: id }];
      continue;
    }
    flush();
    pending = walkStatement(state, statement, pending);
  }
  flush();
  return pending;
}

function isPlain(state: State, statement: SyntaxNode): boolean {
  const { syntax } = state;
  const type = statement.type;
  if (
    syntax.blocks.includes(type) ||
    type === syntax.if ||
    syntax.loops.includes(type) ||
    type === syntax.doLoop ||
    syntax.switches.includes(type) ||
    syntax.tries.includes(type) ||
    type === syntax.return ||
    type === syntax.throw ||
    type === syntax.break ||
    type === syntax.continue ||
    type === syntax.fallthrough ||
    type === syntax.labeled ||
    syntax.wrappers.includes(type)
  ) {
    return false;
  }
  return ternaryOf(state, statement) === null;
}

function holdsFunction(state: State, node: SyntaxNode): boolean {
  return node.descendantsOfType([...state.syntax.functions]).length > 0;
}

/**
 * Which of the two ways a statement can hold a function: it declares one —
 * `function helper()`, `const f = () =>`, a local class — or it hands one to a
 * call. Either is a separate function; the note says which so the box reads
 * right.
 */
function functionNote(state: State, statement: SyntaxNode): string {
  const { functions } = state.syntax;
  const declares = (node: SyntaxNode | null): boolean =>
    node !== null && (functions.includes(node.type) || node.type.startsWith('class'));
  const values = [
    statement,
    ...withoutComments(statement.namedChildren).flatMap((child) => [
      child,
      child.childForFieldName('value'),
      child.childForFieldName('right'),
    ]),
  ];
  return values.some(declares)
    ? 'a nested function — a separate function, not walked'
    : 'calls with a function as an argument — its body is a separate function, not walked';
}

function functionNoteIf(state: State, statement: SyntaxNode): { note?: string } {
  return holdsFunction(state, statement) ? { note: functionNote(state, statement) } : {};
}

function walkStatement(state: State, statement: SyntaxNode, pending: Pending[]): Pending[] {
  const { syntax } = state;
  const type = statement.type;

  if (syntax.blocks.includes(type)) return walkList(state, statementsOf(statement), pending);
  // Before `return`: `return c ? a : b` is a decision with two exits, not one exit.
  const ternary = ternaryOf(state, statement);
  if (ternary) return walkTernary(state, statement, ternary.ternary, ternary.holder, pending);
  if (type === syntax.if) return walkIf(state, statement, pending);
  if (syntax.loops.includes(type)) return walkLoop(state, statement, pending);
  if (type === syntax.doLoop) return walkDo(state, statement, pending);
  if (syntax.switches.includes(type)) return walkSwitch(state, statement, pending);
  if (syntax.tries.includes(type)) return walkTry(state, statement, pending);
  if (type === syntax.return) return exitTo(state, statement, 'return', pending, { kind: 'return' });
  if (type === syntax.throw) return exitTo(state, statement, 'throw', pending, throwLeave(state));
  if (type === syntax.break) return walkBreak(state, statement, pending);
  if (type === syntax.continue) return walkContinue(state, statement, pending);
  if (type === syntax.fallthrough) {
    const target = innermost(state, 'switch');
    if (target) {
      target.fallthrough.push(...pending);
      return [];
    }
    return pending;
  }
  if (type === syntax.labeled) return walkLabeled(state, statement, pending);
  if (syntax.wrappers.includes(type)) {
    const body = bodyOf(state, statement);
    return body ? walkStatement(state, body, pending) : pending;
  }
  return walkList(state, [statement], pending);
}

function walkIf(state: State, statement: SyntaxNode, pending: Pending[]): Pending[] {
  const consequence = statement.childForFieldName('consequence');
  if (!consequence) return walkList(state, [statement], pending);
  const header = headerOf(statement, consequence.startIndex);
  const id = addNode(state, {
    kind: 'decision',
    label: firstLine(stripParens(header.replace(/^if\b/, ''))),
    range: headerRange(statement, consequence),
    ...headerNote(state, statement, consequence.startIndex),
  });
  connect(state, pending, id);

  const yes = walkStatement(state, consequence, [{ from: id, label: 'yes' }]);

  let alternative = statement.childForFieldName('alternative');
  if (alternative && alternative.type === state.syntax.elseClause) {
    alternative = withoutComments(alternative.namedChildren)[0] ?? null;
  }
  const no = alternative
    ? walkStatement(state, alternative, [{ from: id, label: 'no' }])
    : [{ from: id, label: 'no' }];
  return [...yes, ...no];
}

function walkLoop(state: State, statement: SyntaxNode, pending: Pending[]): Pending[] {
  const body = statement.childForFieldName('body');
  if (!body) return walkList(state, [statement], pending);
  const id = addNode(state, {
    kind: 'loop',
    label: firstLine(headerOf(statement, body.startIndex)),
    range: headerRange(statement, body),
    ...headerNote(state, statement, body.startIndex),
  });
  connect(state, pending, id);

  const target = openTarget(state, 'loop', id);
  const back = walkStatement(state, body, [{ from: id, label: 'yes' }]);
  state.targets.pop();
  connect(state, back, id);

  // `for (;;)`, `while (true)`, Go's bare `for`: there is no way past the
  // header, and a `no` edge would draw one.
  const out = isEndless(state, statement) ? [] : [{ from: id, label: 'no' }];
  return [...out, ...target.after];
}

function walkDo(state: State, statement: SyntaxNode, pending: Pending[]): Pending[] {
  const body = statement.childForFieldName('body');
  if (!body) return walkList(state, [statement], pending);
  // The condition sits after the body, so the box says so, and the entry goes
  // straight into the body: the loop's own `yes` edge is just one more edge
  // into the body's first box.
  const tail = statement.text.slice(body.endIndex - statement.startIndex).replace(/;\s*$/, '');
  const id = addNode(state, {
    kind: 'loop',
    label: firstLine(`do … ${tail.trim()}`),
    range: { startLine: body.endPosition.row + 1, endLine: statement.endPosition.row + 1 },
  });

  const target = openTarget(state, 'loop', id);
  const back = walkStatement(state, body, [...pending, { from: id, label: 'yes' }]);
  state.targets.pop();
  connect(state, back, id);

  return [{ from: id, label: 'no' }, ...target.after];
}

function walkSwitch(state: State, statement: SyntaxNode, pending: Pending[]): Pending[] {
  const { cases, exhaustive } = state.syntax.cases(statement);
  // The header ends where the cases begin: at the body node when the grammar
  // has one, else at the brace.
  const brace = statement.text.indexOf('{');
  const headerEnd = statement.childForFieldName('body')?.startIndex ?? (brace >= 0 ? statement.startIndex + brace : statement.endIndex);
  const header = headerOf(statement, headerEnd);
  state.drawn.add(statement.startIndex);
  const id = addNode(state, {
    kind: 'decision',
    label: firstLine(stripParens(header.replace(/^(switch|select)\b/, '')) || header),
    range: lineAt(statement.startPosition.row),
    ...headerNote(state, statement, headerEnd),
  });
  connect(state, pending, id);

  const target = openTarget(state, 'switch', id);
  let carried: Pending[] = [];
  for (const item of cases) {
    target.fallthrough = [];
    const out = walkList(state, item.statements, [{ from: id, label: item.label }, ...carried]);
    carried = [...target.fallthrough, ...(item.fallsThrough ? out : [])];
    if (!item.fallsThrough) target.after.push(...out);
  }
  state.targets.pop();

  return [...carried, ...target.after, ...(exhaustive ? [] : [{ from: id, label: 'else' }])];
}

function walkTry(state: State, statement: SyntaxNode, pending: Pending[]): Pending[] {
  const { syntax } = state;
  const body = bodyOf(state, statement);
  if (!body) return walkList(state, [statement], pending);
  const id = addNode(state, { kind: 'try', label: 'try', range: lineAt(statement.startPosition.row) });
  connect(state, pending, id);

  const clauses = withoutComments(statement.namedChildren);
  const catches = clauses.filter((c) => c.type === syntax.catchClause);
  const finalizer = clauses.find((c) => c.type === syntax.finallyClause) ?? null;

  // The catch and finally boxes exist before the body is walked, so a throw
  // or a return inside it has somewhere to go. Any statement in the body may
  // reach the catch, which is what the `catch` edge off the try box says.
  const catchIds = catches.map((clause) => {
    const clauseBody = bodyOf(state, clause);
    const cid = addNode(state, {
      kind: 'try',
      label: firstLine(clauseBody ? headerOf(clause, clauseBody.startIndex) : clause.text),
      range: lineAt(clause.startPosition.row),
    });
    edge(state, id, cid, 'catch');
    return cid;
  });
  const frame: FinallyFrame | null = finalizer
    ? { id: addNode(state, { kind: 'try', label: 'finally', range: lineAt(finalizer.startPosition.row) }), leaves: [] }
    : null;
  if (frame) state.finallies.push(frame);

  // One catch is where a throw in the body goes; several is a question of
  // type this walker cannot answer (null, see State.catches); none — a
  // try/finally — leaves the enclosing try's answer in place. Entered after
  // the finally frame, so its depth says the throw does not pass through it.
  const single = catchIds[0];
  if (catchIds.length > 0) {
    state.catches.push({ id: catchIds.length === 1 && single !== undefined ? single : null, depth: state.finallies.length });
  }
  const bodyOut = walkStatement(state, body, [{ from: id }]);
  if (catchIds.length > 0) state.catches.pop();

  const catchOut = catches.flatMap((clause, i) => {
    const clauseBody = bodyOf(state, clause);
    const cid = catchIds[i];
    if (!clauseBody || cid === undefined) return [];
    return walkStatement(state, clauseBody, [{ from: cid }]);
  });

  if (!frame || !finalizer) return [...bodyOut, ...catchOut];
  state.finallies.pop();
  const fellIn = [...bodyOut, ...catchOut];
  connect(state, fellIn, frame.id);
  const finalBody = bodyOf(state, finalizer);
  const out = finalBody ? walkStatement(state, finalBody, [{ from: frame.id }]) : [{ from: frame.id }];
  // What left through the finally carries on from its last box, each with
  // the exit's own label, and through the next finally out if there is one.
  // A finally that exits on its own — `finally { return b() }` — overrides
  // every exit it was carrying: the try's `return a()` never leaves, and an
  // edge out of the finally box for it would be a path no run takes.
  if (finalBody && out.length === 0) return [];
  const only = out.length === 1 ? out[0] : undefined;
  const last = only !== undefined && only.label === undefined ? only.from : frame.id;
  for (const item of frame.leaves) leave(state, last, item, item.kind);
  // When every path in the try returned, nothing falls out of the finally
  // either: an unlabelled edge on to the next statement would be a path no
  // run takes.
  return fellIn.length === 0 ? [] : out;
}

/**
 * An exit on its way out: to the finally box when one is open between here
 * and where it is going, else straight there. A break to the loop it is
 * inside of passes no finally that was opened outside that loop, which is
 * what the depths compare.
 */
function leave(state: State, from: string, item: Leave, label?: string): void {
  const depth = item.kind === 'return' ? 0 : item.kind === 'throw' ? item.depth : item.target.depth;
  const frame = state.finallies[state.finallies.length - 1];
  if (frame && state.finallies.length > depth) {
    edge(state, from, frame.id, label);
    if (!frame.leaves.some((known) => sameLeave(known, item))) frame.leaves.push(item);
    return;
  }
  switch (item.kind) {
    case 'return':
      edge(state, from, 'end', label);
      return;
    case 'throw':
      edge(state, from, item.to, label);
      return;
    case 'continue':
      edge(state, from, item.target.head, label);
      return;
    case 'break':
      item.target.after.push(label === undefined ? { from } : { from, label });
      return;
  }
}

function sameLeave(a: Leave, b: Leave): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'throw' && b.kind === 'throw') return a.to === b.to;
  if ((a.kind === 'break' || a.kind === 'continue') && (b.kind === 'break' || b.kind === 'continue')) return a.target === b.target;
  return true;
}

function throwLeave(state: State): Leave {
  const entry = state.catches[state.catches.length - 1];
  if (entry === undefined) return { kind: 'throw', to: 'end', depth: 0 };
  if (entry.id === null) {
    state.ambiguousThrows += 1;
    return { kind: 'throw', to: 'end', depth: 0 };
  }
  return { kind: 'throw', to: entry.id, depth: entry.depth };
}

function openTarget(state: State, kind: Target['kind'], head: string): Target {
  const target: Target = {
    kind,
    label: takeLabel(state),
    head,
    after: [],
    fallthrough: [],
    depth: state.finallies.length,
  };
  state.targets.push(target);
  return target;
}

function walkTernary(
  state: State,
  statement: SyntaxNode,
  ternary: SyntaxNode,
  holder: 'return' | 'other',
  pending: Pending[],
): Pending[] {
  const condition = ternary.childForFieldName('condition');
  const consequence = ternary.childForFieldName('consequence');
  const alternative = ternary.childForFieldName('alternative');
  if (!condition || !consequence || !alternative) return walkList(state, [statement], pending);

  state.drawn.add(ternary.startIndex);
  const id = addNode(state, {
    kind: 'decision',
    label: firstLine(stripParens(condition.text)),
    range: spanOf(condition, condition),
    ...headerNote(state, condition, condition.endIndex),
  });
  connect(state, pending, id);

  // `const x = c ? a : b` reads as two boxes `const x = a` and `const x = b`:
  // the prefix is what the branch does, the arm is how it differs.
  const prefix = statement.text.slice(0, ternary.startIndex - statement.startIndex).replace(/^return\s+/, '');
  const arm = (node: SyntaxNode, label: string): Pending[] => {
    const text = `${holder === 'return' ? 'return ' : prefix}${node.text}`;
    if (holder === 'return') {
      const rid = addNode(state, { kind: 'exit', exit: 'return', label: firstLine(text), range: spanOf(node, node) });
      edge(state, id, rid, label);
      leave(state, rid, { kind: 'return' });
      return [];
    }
    const aid = addNode(state, { kind: 'action', label: firstLine(text), range: spanOf(node, node) });
    edge(state, id, aid, label);
    return [{ from: aid }];
  };
  return [...arm(consequence, 'yes'), ...arm(alternative, 'no')];
}

function exitTo(state: State, statement: SyntaxNode, exit: FlowExit, pending: Pending[], item: Leave): Pending[] {
  const id = addNode(state, {
    kind: 'exit',
    exit,
    label: firstLine(statement.text),
    range: spanOf(statement, statement),
    ...functionNoteIf(state, statement),
  });
  connect(state, pending, id);
  leave(state, id, item);
  return [];
}

function walkBreak(state: State, statement: SyntaxNode, pending: Pending[]): Pending[] {
  const label = jumpLabel(statement);
  const target = label === null ? innermost(state, 'loop', 'switch') : byLabel(state, label);
  // A break outside any loop is not valid code; end is the honest place for it.
  return exitTo(state, statement, 'break', pending, target ? { kind: 'break', target } : { kind: 'return' });
}

function walkContinue(state: State, statement: SyntaxNode, pending: Pending[]): Pending[] {
  const label = jumpLabel(statement);
  const target = label === null ? innermost(state, 'loop') : byLabel(state, label);
  return exitTo(state, statement, 'continue', pending, target ? { kind: 'continue', target } : { kind: 'return' });
}

function walkLabeled(state: State, statement: SyntaxNode, pending: Pending[]): Pending[] {
  const children = withoutComments(statement.namedChildren);
  const label = statement.childForFieldName('label') ?? children[0] ?? null;
  const body = statement.childForFieldName('body') ?? children[children.length - 1] ?? null;
  if (!body || (label !== null && sameNode(body, label))) return pending;
  const { syntax } = state;
  const isJumpTarget = syntax.loops.includes(body.type) || body.type === syntax.doLoop || syntax.switches.includes(body.type);
  if (isJumpTarget) {
    state.pendingLabel = label?.text ?? null;
    const out = walkStatement(state, body, pending);
    state.pendingLabel = null;
    return out;
  }
  // A labelled block: only a `break label` leaves it early.
  state.pendingLabel = label?.text ?? null;
  const target = openTarget(state, 'block', '');
  const out = walkStatement(state, body, pending);
  state.targets.pop();
  return [...out, ...target.after];
}

function takeLabel(state: State): string | null {
  const label = state.pendingLabel;
  state.pendingLabel = null;
  return label;
}

function innermost(state: State, ...kinds: Target['kind'][]): Target | null {
  for (let i = state.targets.length - 1; i >= 0; i -= 1) {
    const target = state.targets[i];
    if (target && kinds.includes(target.kind)) return target;
  }
  return null;
}

function byLabel(state: State, label: string): Target | null {
  for (let i = state.targets.length - 1; i >= 0; i -= 1) {
    const target = state.targets[i];
    if (target && target.label === label) return target;
  }
  return null;
}

/** The label a `break` or `continue` names, in whichever child the grammar puts it. */
function jumpLabel(statement: SyntaxNode): string | null {
  const label = statement.childForFieldName('label') ?? withoutComments(statement.namedChildren)[0] ?? null;
  return label ? label.text : null;
}

function bodyOf(state: State, node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName('body') ?? node.namedChildren.find((c) => state.syntax.blocks.includes(c.type)) ?? null;
}

/**
 * A ternary that is the whole of what a statement does — `return c ? a : b`,
 * `x = c ? a : b`, `const x = c ? a : b` — is a branch and drawn as one. A
 * ternary inside a larger expression is not: `f(c ? a : b)` has no place for
 * the two arms to go, and it is counted in `notDrawn` instead.
 */
function ternaryOf(state: State, statement: SyntaxNode): { ternary: SyntaxNode; holder: 'return' | 'other' } | null {
  const { syntax } = state;
  if (syntax.ternary === null) return null;
  const type = statement.type;
  let expression: SyntaxNode | null = null;
  let holder: 'return' | 'other' = 'other';
  if (type === syntax.ternary) {
    // Only an arrow's expression body arrives here bare, and that is what
    // the function returns.
    expression = statement;
    holder = 'return';
  } else if (type === syntax.return) {
    expression = withoutComments(statement.namedChildren)[0] ?? null;
    holder = 'return';
  } else if (type === 'expression_statement') {
    expression = withoutComments(statement.namedChildren)[0] ?? null;
    if (expression?.type === 'assignment_expression') expression = expression.childForFieldName('right');
  } else if (type === 'lexical_declaration' || type === 'variable_declaration' || type === 'local_variable_declaration') {
    const declarators = statement.namedChildren.filter((c) => c.type === 'variable_declarator');
    expression = declarators.length === 1 ? (declarators[0]?.childForFieldName('value') ?? null) : null;
  }
  while (expression && expression.type === 'parenthesized_expression') {
    expression = withoutComments(expression.namedChildren)[0] ?? null;
  }
  return expression && expression.type === syntax.ternary ? { ternary: expression, holder } : null;
}

function isEndless(state: State, statement: SyntaxNode): boolean {
  const { syntax } = state;
  if (statement.type === 'while_statement') {
    return stripParens(statement.childForFieldName('condition')?.text ?? '') === 'true';
  }
  if (statement.type !== 'for_statement') return false;
  if (syntax === GO) {
    const clause = statement.namedChildren.find((c) => c.type === 'for_clause');
    if (clause) return clause.childForFieldName('condition') === null;
    return statement.namedChildren.every((c) => c.type === 'block' || c.type.endsWith('comment'));
  }
  const condition = statement.childForFieldName('condition');
  return condition === null || condition.type === 'empty_statement' || condition.text === ';';
}

/** A note on a decision or loop whose header itself holds a function body. */
function headerNote(state: State, statement: SyntaxNode, bodyStart: number): { note?: string } {
  const inHeader = statement.descendantsOfType([...state.syntax.functions]).some((fn) => fn.startIndex < bodyStart);
  return inHeader ? { note: 'calls with a function as an argument — its body is a separate function, not walked' } : {};
}

function notDrawn(state: State, body: SyntaxNode | null): string[] {
  const { syntax } = state;
  const out: string[] = [];
  if (!body) return out;
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

  // The body itself is one function's; anything of the kind inside it is
  // somebody else's. `descendantsOfType` includes the node asked, so an
  // expression body that is itself an arrow is subtracted.
  const inner = body.descendantsOfType([...syntax.functions]).filter((fn) => !sameNode(fn, body)).length;
  if (inner > 0) {
    out.push(`${inner} function ${plural(inner, 'body', 'bodies')} inside this one ${plural(inner, 'is', 'are')} not walked — each is a separate function`);
  }
  if (syntax.await) {
    const awaits = body.descendantsOfType(syntax.await).length;
    if (awaits > 0) out.push(`${awaits} await: waiting is not a branch, and none is drawn`);
  }
  if (body.descendantsOfType(syntax.call).length > 0) {
    out.push('an exception thrown by a call is not an edge — only an explicit throw is');
  }
  if (syntax.ternary) {
    const rest = body.descendantsOfType(syntax.ternary).filter((t) => !state.drawn.has(t.startIndex)).length;
    if (rest > 0) out.push(`${rest} ${plural(rest, 'ternary', 'ternaries')} inside a larger expression ${plural(rest, 'is', 'are')} not a branch here`);
  }
  // Java's arrow switch is an expression too — `int x = switch (k) {…}` — and
  // then it sits inside a statement the way a ternary does.
  const switches = body.descendantsOfType([...syntax.switches]).filter((s) => !state.drawn.has(s.startIndex)).length;
  if (switches > 0) out.push(`${switches} switch inside a larger expression ${plural(switches, 'is', 'are')} not a branch here`);
  if (state.ambiguousThrows > 0) {
    out.push(`${state.ambiguousThrows} throw inside a try with several catch clauses ${plural(state.ambiguousThrows, 'goes', 'go')} to end: which clause takes it depends on the type`);
  }
  const errors = state.missing + body.descendantsOfType('ERROR').length;
  if (errors > 0) {
    out.push(`the source has a syntax error inside this function; what tree-sitter could not read is not drawn (${errors})`);
  }
  if (syntax.goStatements) {
    const defers = body.descendantsOfType(syntax.goStatements.defer).length;
    if (defers > 0) out.push(`${defers} defer ${plural(defers, 'runs', 'run')} when the function returns, and ${plural(defers, 'is', 'are')} drawn where written`);
    const gotos = body.descendantsOfType(syntax.goStatements.goto).length;
    if (gotos > 0) out.push(`${gotos} goto ${plural(gotos, 'is', 'are')} not followed`);
  }
  return out;
}

/** The text of a statement before its body starts: `for (const x of xs)`, `catch (e)`. */
function headerOf(statement: SyntaxNode, bodyStart: number): string {
  return statement.text.slice(0, Math.max(0, bodyStart - statement.startIndex)).replace(/\{\s*$/, '').trim();
}

/** `(a && b)` → `a && b`, but `(a) && (b)` stays as it is. */
function stripParens(text: string): string {
  let inner = text.trim();
  while (inner.startsWith('(') && inner.endsWith(')')) {
    let depth = 0;
    let closesAtEnd = false;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          closesAtEnd = i === inner.length - 1;
          break;
        }
      }
    }
    if (!closesAtEnd) break;
    inner = inner.slice(1, -1).trim();
  }
  return inner;
}

/** One line, trimmed, without a trailing semicolon; an ellipsis when there was more. */
export function firstLine(text: string): string {
  const lines = text.trim().split('\n');
  const line = (lines[0] ?? '').trim().replace(/;$/, '');
  const cut = line.length > MAX_LABEL;
  const shown = cut ? line.slice(0, MAX_LABEL - 1) : line;
  return cut || lines.length > 1 ? `${shown} …` : shown;
}

function lineAt(row: number): FlowRange {
  return { startLine: row + 1, endLine: row + 1 };
}

function spanOf(first: SyntaxNode, last: SyntaxNode): FlowRange {
  return { startLine: first.startPosition.row + 1, endLine: last.endPosition.row + 1 };
}

/** From the statement's first line to the line its body opens on. */
function headerRange(statement: SyntaxNode, body: SyntaxNode): FlowRange {
  return { startLine: statement.startPosition.row + 1, endLine: Math.max(statement.startPosition.row, body.startPosition.row) + 1 };
}
