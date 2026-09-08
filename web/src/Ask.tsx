import { useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { askQuestion, endAsk, fetchAsk, money } from './api';
import {
  askBlocked,
  FAILURE_WORDS,
  FIRST_QUESTION_USD,
  FOLLOW_UP_USD,
  MAX_QUESTION,
  NO_CONVERSATION,
  reduceAsk,
  seconds,
  showThinking,
  subscribeAsk,
  timingNote,
} from './ask';
import type { AskTurn } from './api';

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
export function Ask({ categories }: { categories: number }) {
  const [view, dispatch] = useReducer(reduceAsk, NO_CONVERSATION);
  const [question, setQuestion] = useState('');
  /** The press has gone out and the 202 has not come back. */
  const [sending, setSending] = useState(false);
  /** The server's words for a press that did nothing and spent nothing. */
  const [refused, setRefused] = useState<string | null>(null);
  /** Why the last press could not even be made — the server was unreachable. */
  const [broken, setBroken] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLOListElement>(null);

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
          if (!stopped) dispatch({ kind: 'server', state });
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

      {conversation !== null && conversation.costUsd > 0 && (
        <p
          className="ask-total"
          title="What the answers that arrived cost. A turn that failed adds nothing — the CLI prints a price only when it finishes — so this is a floor rather than the whole bill."
        >
          {money(conversation.costUsd)} so far
        </p>
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
    </div>
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
      {turn.state === 'done' && turn.costUsd !== undefined && (
        <p className="ask-note" title={timingNote(turn) ?? undefined}>
          {money(turn.costUsd)}
          {turn.ms === undefined ? '' : ` · ${seconds(turn.ms)}`}
        </p>
      )}
    </>
  );
}
