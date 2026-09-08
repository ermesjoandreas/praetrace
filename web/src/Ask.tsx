import { useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { askQuestion, dropProposal, endAsk, fetchAsk, money, proposeGrouping } from './api';
import {
  askBlocked,
  cohesionNote,
  FAILURE_WORDS,
  FIRST_QUESTION_USD,
  FOLLOW_UP_USD,
  inventedPaths,
  MAX_QUESTION,
  NO_CONVERSATION,
  overlapNote,
  proposeBlocked,
  proposeStatus,
  proposeSummary,
  PROPOSE_USD,
  reachNote,
  reduceAsk,
  sameRun,
  seconds,
  showThinking,
  subscribeAsk,
  timingNote,
  weakCohesion,
} from './ask';
import { fileIconFor } from './fileicons';
import { LIST_ROW, useListKeys } from './listkeys';
import type { AskTurn, Proposal, ProposeRun } from './api';

/**
 * How often the panel asks the server what the conversation is, as a fallback
 * for a socket frame that never arrived. The same three seconds the explain
 * panel polls at, and the same reason: the socket is the fast path and this is
 * the one that notices it was wrong.
 *
 * It also notices a project switch, which ends the conversation on the server
 * without any frame of its own — so the poll runs whenever this section's body
 * is on screen, not only while a turn is being written. A folded Categories
 * section renders no body, so folding it stops the poll.
 */
const POLL_MS = 3000;

/**
 * A conversation about the categories, under the categories themselves.
 *
 * What it is, in one sentence, is on the face of the panel and not in a
 * tooltip: **it answers and it changes nothing.** No name is written, no file
 * moves, nothing reaches `.codemap/`. Decision 4 keeps the model out of the
 * graph and decision 5 keeps it out of who belongs to a category; a name this
 * proposes is a sentence on a screen until a person types or accepts it
 * through the gesture that already exists two rows up.
 *
 * **It is drawn to feel fast, and that is the whole of the design.** A turn is
 * six to twenty-two seconds before the answer starts, which is a spinner, not
 * a conversation — so the model's own working notes are drawn the moment they
 * arrive, about two seconds in, dim and monospace, and step aside for the
 * first word of the answer. They are never drawn *as* the answer: see
 * `showThinking`, and `AskDeltaKind` in `src/project/ask.ts` for why the two
 * are told apart on the wire at all.
 */
export function Ask({
  categories,
  addedNames,
  fileCount,
  onAccept,
  onSelect,
  consentStanding,
}: {
  categories: number;
  /**
   * The names of the categories that exist. A proposal whose name is one of
   * them has been accepted — and is read from the list rather than from what
   * this page remembers pressing, so the mark survives a reload and a second
   * accept is never offered for a category that is already there.
   */
  addedNames: ReadonlySet<string>;
  /** Files in the graph. Nothing to group is the one refusal this can say without a press. */
  fileCount: number;
  /**
   * Draw a proposed grouping as a category. The same create a shift-click draw
   * makes — `origin: 'manual'`, marked "by hand" wherever it is shown —
   * because the person pressing accept is the person drawing that group.
   */
  onAccept: (name: string, files: string[]) => void;
  /** Focus a file. A proposal's members are rows, and a row leads somewhere. */
  onSelect: (file: string) => void;
  /**
   * The server's `.codemap/` question is standing. Accepting raises the same
   * one a hand-drawn category does, and it is answered at the top of this
   * section — far above this panel, so the row that raised it says so.
   */
  consentStanding: boolean;
}) {
  const [view, dispatch] = useReducer(reduceAsk, NO_CONVERSATION);
  const [question, setQuestion] = useState('');
  /** The press has gone out and the 202 has not come back. */
  const [sending, setSending] = useState(false);
  /** The server's words for a press that did nothing and spent nothing. */
  const [refused, setRefused] = useState<string | null>(null);
  /** Why the last press could not even be made — the server was unreachable. */
  const [broken, setBroken] = useState<string | null>(null);
  /**
   * The last proposal run, as the server holds it. Not in the reducer beside
   * the conversation: it is a different job, it arrives on no socket frame,
   * and nothing about it is patched a few characters at a time.
   */
  const [run, setRun] = useState<ProposeRun | null>(null);
  const [proposing, setProposing] = useState(false);
  /** The press has gone out and the 202 has not come back. */
  const [proposeSending, setProposeSending] = useState(false);
  const [proposeRefused, setProposeRefused] = useState<string | null>(null);
  /**
   * The proposals this reader has finished with, by name: accepted, or
   * dismissed. Page state, and honestly so — a reload shows the run again,
   * which is the same shape a dismissed suggestion has. Dropping the run
   * itself is the press that leaves nothing behind, and dismissing the last
   * one does it.
   */
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const box = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLOListElement>(null);
  // One Tab stop for every file row under every proposal, the way every other
  // list on this page is one.
  const keys = useListKeys();

  // The socket carries every frame to every client, so a run another tab
  // started streams in here too, and the conversation is the session's rather
  // than this page's.
  useEffect(() => subscribeAsk((frame) => {
    if (frame.type === 'ask') {
      dispatch({
        kind: 'server',
        state: { conversation: frame.conversation, running: frame.conversation.turns.at(-1)?.state === 'running' },
      });
      return;
    }
    dispatch({ kind: 'delta', frame });
  }), []);

  useEffect(() => {
    let stopped = false;
    const read = () => {
      void fetchAsk()
        .then((state) => {
          if (stopped) return;
          dispatch({ kind: 'server', state });
          // A proposal has no frame of its own — a schema answer has nothing
          // to stream — so this poll is how a finished run arrives, up to
          // three seconds after it finished. It is also how a run another tab
          // started, or a project switch that dropped one, gets here.
          setRun((was) => (sameRun(was, state.proposal) ? was : state.proposal));
          setProposing(state.proposal?.state === 'running');
        })
        // A failed read is not a failed conversation: the socket is the fast
        // path and the next tick tries again. Saying so here would put an
        // error under a transcript that is still perfectly correct.
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  const { conversation, running, gone } = view;
  const blocked = askBlocked({ question, running, sending, categories });

  // The transcript scrolls inside itself — see `.ask-turns` — so this follows
  // the words *within that box* and moves nothing else on the page. Layout,
  // not effect, so the jump happens in the same frame the text does.
  //
  // Two rules, and the difference between them was a bug on the screen: a
  // question that has just been asked is always shown, because the reader
  // asked it and nothing else they could be looking at outranks that; the
  // words filling in *under* it defer to wherever they had scrolled to,
  // because scrolling up to re-read an earlier answer must not be undone by
  // the next few characters.
  //
  // It deliberately does not stop when the turn does. The last render of a
  // turn is the one that grows the list most — the streamed deltas are
  // replaced by the CLI's whole copy and the cost line is added under it —
  // and it happens in the same frame `running` goes false. Skipping it left a
  // reader who had sat at the bottom throughout looking at the answer they
  // had just paid for with its last sentences cut off, which was watched
  // happening on screen. `room < 40` still decides, so a reader who scrolled
  // up is no more disturbed at the end than during.
  const turnCount = conversation?.turns.length ?? 0;
  const drawn = useRef(0);
  useLayoutEffect(() => {
    const asked = turnCount > drawn.current;
    drawn.current = turnCount;
    const list = transcript.current;
    if (list === null) return;
    const room = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (asked || room < 40) list.scrollTop = list.scrollHeight;
  }, [conversation, running, turnCount]);

  // A follow-up resumes the CLI's session and so does not send the categories
  // again — measured at less than half the price. A conversation with no
  // session id has nothing to resume, so its next turn is a first turn and
  // costs like one.
  const nextPrice = conversation === null || conversation.sessionId === null ? FIRST_QUESTION_USD : FOLLOW_UP_USD;

  const send = () => {
    if (blocked !== null) return;
    setSending(true);
    setRefused(null);
    setBroken(null);
    void askQuestion(question.trim())
      .then((started) => {
        if (started.refused !== null) {
          setRefused(started.refused);
          return;
        }
        // The box empties on a press that started something, and keeps what
        // was typed on one that did not: a refused question is usually one
        // word from being a good one.
        setQuestion('');
        if (started.conversation !== null) {
          dispatch({ kind: 'server', state: { conversation: started.conversation, running: true } });
        }
      })
      .catch((error: unknown) => setBroken(error instanceof Error ? error.message : String(error)))
      .finally(() => setSending(false));
  };

  const proposeStopped = proposeBlocked({ proposing, sending: proposeSending, fileCount });

  const propose = () => {
    if (proposeStopped !== null) return;
    setProposeSending(true);
    setProposeRefused(null);
    setBroken(null);
    // A new answer, so nothing a reader decided about the last one carries
    // over — a name that happens to repeat is a different set of files.
    setAccepted(new Set());
    setDismissed(new Set());
    void proposeGrouping()
      .then((started) => {
        if (started.refused !== null) {
          setProposeRefused(started.refused);
          return;
        }
        setRun(started.proposal);
        setProposing(started.proposal?.state === 'running');
      })
      .catch((error: unknown) => setBroken(error instanceof Error ? error.message : String(error)))
      .finally(() => setProposeSending(false));
  };

  /**
   * Throw the whole answer away, on the server as well as here, so there is
   * nothing left of it: no file was written by any of this, and now no run is
   * held either.
   */
  const drop = () => {
    setRun(null);
    setProposing(false);
    setProposeRefused(null);
    setAccepted(new Set());
    setDismissed(new Set());
    void dropProposal().catch(() => undefined);
  };

  const proposals = run?.proposals ?? [];
  const standing = proposals.filter((proposal) => !dismissed.has(proposal.name));

  const dismiss = (name: string) => {
    // The last one out takes the run with it, so "dismiss" leaves nothing
    // behind rather than leaving a run on the server that a reload would
    // bring back — which is exactly the flaw a dismissed suggestion has.
    if (standing.length <= 1) {
      drop();
      return;
    }
    setDismissed((was) => new Set(was).add(name));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends and shift-Enter is a newline, which is the gesture anybody
    // typing into a box like this already has in their hands.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="ask">
      <h3
        className="ask-title"
        title="A conversation about the categories: their names, their files, what each provides, and the imports between them — the same picture the component diagram draws, of the project as it is now rather than of a commit"
      >
        Ask
      </h3>

      {/* Said once, on the face of the panel, because the one thing a reader
          could wrongly believe about an answer is that it did something. It
          cannot: there is no writer behind this, and a name it proposes is
          accepted with the ✓ on the category's own row, by a person. */}
      <p className="panel-empty">
        Ask Claude about these categories — their names, their files, and how they lean on each other. It reads
        and answers; it changes nothing, and it cannot rename a category or move a file into one.
      </p>

      {gone === 'switched' && (
        <p className="panel-empty ask-gone">
          The project changed. That conversation was about the one before it, so it was closed rather than
          carried over.
        </p>
      )}

      {conversation !== null && (
        <ol className="ask-turns" ref={transcript} aria-busy={running}>
          {conversation.turns.map((turn) => (
            <li key={turn.at} className="ask-turn">
              {/* The question in the panel's own voice — muted, the way every
                  label here is — and the answer in the body colour. The
                  contrast is what says which is which; nothing is quoted and
                  nothing wears a badge. */}
              <p className="ask-question">{turn.question}</p>
              <Answer turn={turn} />
            </li>
          ))}
        </ol>
      )}

      <textarea
        ref={box}
        className="ask-input"
        rows={2}
        maxLength={MAX_QUESTION}
        value={question}
        placeholder={conversation === null ? 'Ask about these categories…' : 'Ask something else…'}
        aria-label="Ask about these categories"
        onChange={(event) => {
          setQuestion(event.target.value);
          setRefused(null);
        }}
        onKeyDown={onKeyDown}
      />

      <div className="explain-bar">
        <button
          type="button"
          className="explain-run"
          aria-busy={running || sending}
          disabled={blocked !== null}
          title={
            blocked ??
            `Ask this, and spend about ${money(nextPrice)} of your Claude quota. ${
              nextPrice === FOLLOW_UP_USD
                ? 'A follow-up resumes the same conversation, so the categories are not sent again.'
                : 'The first question sends the categories; the ones after it resume and cost less.'
            } The answer is about the project as it is now.`
          }
          onClick={send}
        >
          {conversation === null ? 'Ask' : 'Ask again'}
          {/* The price before the press, not after it. An estimate, said as
              one: what it really costs sits under the answer it bought. */}
          <span>about {money(nextPrice)}</span>
        </button>
        {conversation !== null && (
          <button
            type="button"
            className="explain-stop"
            title={
              running
                ? 'Stop using this answer and close the conversation. What it has already spent is spent — this abandons the run, it does not call it back.'
                : 'Close this conversation. The next question sends the categories again and costs like a first one.'
            }
            onClick={() => {
              dispatch({ kind: 'ended' });
              // The server is told, and the poll above is what corrects this
              // page if it was not: ending is a read of nothing, so a failed
              // one costs nothing to get wrong for three seconds.
              void endAsk().catch(() => undefined);
            }}
          >
            End
          </button>
        )}
      </div>

      {/* Nothing ran and nothing was spent, so this is a sentence and not the
          error colour — the same shape the Explain panel's refusals wear. */}
      {refused !== null && <p className="panel-empty ask-refused">{refused}</p>}
      {broken !== null && <p className="categories-error">{broken}</p>}

      {/* The other job, and the sentence above the button is what keeps the
          two apart: a question is answered from the categories that exist,
          and this one is asked how the project divides when they do not. It
          is a separate press with a separate price, and it writes as little
          as the question does. */}
      <div className="ask-propose">
        <h3 className="ask-title" title="Ask Claude how this project could divide, from its files and the imports between them — not from the categories, which is what the question above asks about">
          Propose a grouping
        </h3>
        <p className="panel-empty">
          For a project the imports found no category in. Claude is sent the files and the references
          between them and answers with groups; the cohesion and the overlap beside each one are counted
          here, from the graph, not taken from what it said. Accepting one draws it by hand.
        </p>

        <div className="explain-bar">
          <button
            type="button"
            className="explain-run"
            aria-busy={proposing || proposeSending}
            disabled={proposeStopped !== null}
            title={
              proposeStopped ??
              `Propose a grouping of these ${fileCount} files, and spend about ${money(PROPOSE_USD)} of your Claude quota. Nothing is stored: each proposal is shown with the share of its references that stay inside it, and accepting one is you drawing that category.`
            }
            onClick={propose}
          >
            {run === null ? 'Propose a grouping' : 'Propose again'}
            {/* The price before the press, not after it. */}
            <span>about {money(PROPOSE_USD)}</span>
          </button>
          {run !== null && (
            <button
              type="button"
              className="explain-stop"
              title={
                proposing
                  ? 'Stop using this answer. What it has already spent is spent — this abandons the run, it does not call it back.'
                  : 'Throw these proposals away. Nothing was written, so nothing is undone.'
              }
              onClick={drop}
            >
              Dismiss
            </button>
          )}
        </div>

        {proposeRefused !== null && <p className="panel-empty ask-refused">{proposeRefused}</p>}

        {/* Nothing streams here, so the panel says what it is doing and for
            how long — a still panel for a minute and a half reads as hung. */}
        {proposeStatus(run) !== null && (
          <p className={run?.state === 'failed' ? 'explain-failed' : 'ask-waiting'}>{proposeStatus(run)}</p>
        )}

        {run !== null && run.state === 'done' && (
          <>
            <p className="ask-note">{proposeSummary(run)}</p>
            {/* The model's own sentence about why the project would not
                divide. Its words, and marked as such by sitting apart from
                every number on this panel, all of which are ours. */}
            {run.note !== null && <p className="panel-empty ask-model-note">{run.note}</p>}
          </>
        )}

        {standing.length > 0 && (
          <ol className="ask-proposals" {...keys}>
            {standing.map((proposal) => (
              <ProposalRow
                key={proposal.name}
                proposal={proposal}
                added={addedNames.has(proposal.name)}
                accepted={accepted.has(proposal.name)}
                consentStanding={consentStanding}
                onAccept={() => {
                  setAccepted((was) => new Set(was).add(proposal.name));
                  onAccept(proposal.name, proposal.files);
                }}
                onDismiss={() => dismiss(proposal.name)}
                onSelect={onSelect}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/**
 * One proposed grouping, drawn so it can be judged before it is accepted.
 *
 * The order is the order the decision is made in: what it is called, what it
 * is for, then **our** numbers — the share of its references that stay
 * inside, what reaches it, and what of it a category already holds — then the
 * files themselves, every one of them, because "the parser files" is not a
 * proposal and a reader cannot check a set they have not been shown.
 *
 * The cohesion is the whole defence, and the reason it is on the face of the
 * row rather than in a tooltip: measured on a real project, four proposals
 * came back at 0%, 1%, 4% and 0% with sentences beside them that read like
 * architecture. Nothing here stops a person accepting one of those — they may
 * know something the imports do not, which is decision 5's own carve-out —
 * but they are told first.
 */
function ProposalRow({
  proposal,
  added,
  accepted,
  consentStanding,
  onAccept,
  onDismiss,
  onSelect,
}: {
  proposal: Proposal;
  /** A category of this name is in the list. Read from the categories, so it survives a reload. */
  added: boolean;
  /** This page pressed accept. The window before the write lands, and the one the consent question stands in. */
  accepted: boolean;
  consentStanding: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onSelect: (file: string) => void;
}) {
  const invented = inventedPaths(proposal);
  const reach = reachNote(proposal.evidence);
  const weak = weakCohesion(proposal.evidence);
  const waiting = accepted && !added;

  return (
    <li className="ask-proposal">
      <div className="ask-proposal-head">
        <span className="ask-proposal-name">{proposal.name}</span>
        {added || accepted ? (
          <span
            className="ask-proposal-done"
            title={
              added
                ? 'A category of this name is in .codemap/groups.json, stored as one you drew — the imports did not find it, and the picture does not claim they did'
                : 'Not written yet: the question above asks before this project gets a .codemap/'
            }
          >
            {waiting ? 'accepted' : 'added · by hand'}
          </span>
        ) : (
          <span className="row-actions">
            <button
              type="button"
              className="group-drop"
              title={`Draw "${proposal.name}" as a category of these ${proposal.files.length} files. It is stored as one you drew — marked "by hand" on the frame, in this panel and on the component diagram — because the imports did not find it.`}
              aria-label={`Accept ${proposal.name}`}
              onClick={onAccept}
            >
              <i className="codicon codicon-check" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="group-drop"
              title="Dismiss this proposal. Nothing was written, so nothing is undone."
              aria-label={`Dismiss ${proposal.name}`}
              onClick={onDismiss}
            >
              <i className="codicon codicon-close" aria-hidden="true" />
            </button>
          </span>
        )}
      </div>

      {/* The model's sentence. Nothing checks it — only the numbers under it
          are ours — so it sits in the muted voice every label here wears and
          never in the body colour the evidence has. */}
      <p className="ask-proposal-sentence">{proposal.sentence}</p>

      <p
        className={weak ? 'ask-proposal-evidence ask-proposal-weak' : 'ask-proposal-evidence'}
        title={
          weak
            ? 'Less than a third of this set’s references stay inside it — under the cut the clustering itself uses, so the import graph would not have offered these files as a group'
            : 'Counted here from the import graph, over the files this names — the same count a category’s own cohesion is'
        }
      >
        {cohesionNote(proposal.evidence)}
      </p>
      {reach !== null && <p className="ask-proposal-evidence ask-proposal-reach">{reach}</p>}
      {/* Counted against the categories **as they stood when the answer came
          back**, and it is not recomputed after: accepting one of these
          proposals changes what the next one overlaps, and this line will
          not know. The row's own "added · by hand" is what says the state
          moved on. */}
      <p className="ask-proposal-evidence" title="Counted against the categories as they stood when this was proposed">
        {overlapNote(proposal)}
      </p>

      {/* Never hidden: a proposal that names files this project has not got is
          a proposal to distrust, and a reader shown only what landed cannot
          see that. */}
      {invented.length > 0 && (
        <p className="ask-proposal-invented" title={invented.join('\n')}>
          {invented.length} {invented.length === 1 ? 'path' : 'paths'} named that this project has no file for
        </p>
      )}

      {waiting && consentStanding && (
        <p className="ask-proposal-invented">
          Not stored yet — answer the question at the top of this section, which asks before creating{' '}
          <code>.codemap/</code>.
        </p>
      )}

      <div className="ask-proposal-files">
        {proposal.files.map((file) => {
          const icon = fileIconFor(file);
          return (
            <button type="button" {...LIST_ROW} key={file} title={file} onClick={() => onSelect(file)}>
              {icon !== null && <img className="file-icon" src={icon.url} alt="" title={icon.label} draggable={false} />}
              <span className="group-file-path">{file}</span>
            </button>
          );
        })}
      </div>
    </li>
  );
}

/**
 * One turn's half of the transcript below the question: what is being thought,
 * what has been said, and what it cost.
 *
 * The order the three appear in is the order a person meets them, and the
 * thinking is drawn *only* until the answer starts. It is the model working,
 * not the model's reply; the server itself drops it when the turn ends, so
 * this is the earlier of the same two jumps rather than a third.
 */
function Answer({ turn }: { turn: AskTurn }) {
  if (showThinking(turn)) {
    return (
      <p className="explain-stream ask-thinking" title="What the model is working through. Not its answer.">
        {turn.thinking}
      </p>
    );
  }

  if (turn.state === 'running' && turn.answer === '') {
    // Measured at one and a half to two and a half seconds. Short enough not
    // to need a spinner, long enough that an empty panel would read as broken.
    return <p className="ask-waiting">Asking…</p>;
  }

  return (
    <>
      {turn.answer !== '' && <p className="explain-short ask-answer">{turn.answer}</p>}
      {/* The label alone is never the useful half: `missing` carries the list
          of places that were searched, which is the fixable part. */}
      {turn.state === 'failed' && (
        <p className="explain-failed">
          {FAILURE_WORDS[turn.reason ?? 'failed']}
          {turn.detail === undefined || turn.detail === '' ? '' : ` ${turn.detail}`}
        </p>
      )}
      {turn.state === 'cancelled' && (
        <p className="ask-note">Ended before it finished. What it had already spent is spent.</p>
      )}
      {/* No price under an answer. Asked for and removed: a receipt beside
          every reply is noise in a panel a person reads for the reply. What
          protects them is the button, which says what a press costs before it
          is pressed. The cost is still measured and still on the wire. */}
      {turn.state === 'done' && turn.ms !== undefined && (
        <p className="ask-note" title={timingNote(turn) ?? undefined}>{seconds(turn.ms)}</p>
      )}
    </>
  );
}
