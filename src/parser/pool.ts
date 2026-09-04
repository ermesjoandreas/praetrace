import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { FlowAnswer, FlowRange, FlowRequest, FlowResponse } from './flow.js';
import type { ParsedFile, ParseRequest, ParseResponse } from './types.js';

// Resolved relative to this module, so it points at the compiled worker whether
// the pool runs from dist/ or from a linked install.
const WORKER_URL = new URL('./worker.js', import.meta.url);

type WorkerRequest = ParseRequest | FlowRequest;
type WorkerResponse = ParseResponse | FlowResponse;

interface Job {
  request: WorkerRequest;
  /** Given whatever the worker answered; the method that queued the job reads its own shape out. */
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

export interface ParserPool {
  parse(filePath: string, absolutePath: string, source?: string): Promise<ParsedFile>;
  /**
   * The activity diagram of the function at `range`, read off the file as it
   * is on disk. A parse like any other, so it goes to a worker like any other
   * — decision 1 — and queues behind whatever is being parsed.
   */
  flow(filePath: string, absolutePath: string, range: FlowRange): Promise<FlowAnswer>;
  close(): Promise<void>;
}

/**
 * A worker that dies before parsing anything is a broken install, not bad luck.
 * Replacing it forever turns that into a hang; this turns it into an error.
 */
const MAX_CONSECUTIVE_WORKER_FAILURES = 5;

function defaultSize(): number {
  // Parsing is CPU-bound; leave a core for the main thread, which must stay
  // responsive to incoming events while a burst of edits is being parsed.
  return Math.max(1, Math.min(4, os.availableParallelism() - 1));
}

/**
 * A fixed set of worker threads, each parsing one file at a time.
 *
 * Parsing never runs on the main thread. This matters from the first commit
 * rather than as a later optimisation: an agent fires rapid consecutive edits,
 * and a blocked main thread would stall the event collector behind them.
 */
export function createParserPool(size: number = defaultSize()): ParserPool {
  const idle: Worker[] = [];
  const inFlight = new Map<Worker, Job>();
  const queue: Job[] = [];
  let nextId = 1;
  let closed = false;
  let consecutiveFailures = 0;

  function settle(worker: Worker, outcome: (job: Job) => void): void {
    const job = inFlight.get(worker);
    if (!job) return;
    inFlight.delete(worker);
    outcome(job);
  }

  function spawn(): Worker {
    const worker = new Worker(WORKER_URL);

    worker.on('message', (response: WorkerResponse) => {
      // Reaching here at all means the worker loaded and ran.
      consecutiveFailures = 0;
      settle(worker, (job) => {
        if (response.ok) job.resolve(response);
        else job.reject(new Error(`${job.request.filePath}: ${response.error}`));
      });
      idle.push(worker);
      pump();
    });

    worker.on('error', (error: Error) => {
      settle(worker, (job) => job.reject(error));
      if (closed) return;

      consecutiveFailures += 1;
      if (consecutiveFailures > MAX_CONSECUTIVE_WORKER_FAILURES) {
        // Every replacement has died the same way, so replacing again would
        // spin forever. Fail loudly instead of hanging.
        const reason = new Error(`parser workers keep failing to start: ${error.message}`);
        closed = true;
        while (queue.length > 0) queue.shift()?.reject(reason);
        return;
      }

      idle.push(spawn());
      pump();
    });

    worker.on('exit', () => {
      // Only reached with a job attached if the worker died mid-parse; without
      // this the caller would wait on a promise nothing can settle.
      settle(worker, (job) => job.reject(new Error(`parser worker exited during ${job.request.filePath}`)));
    });

    return worker;
  }

  function pump(): void {
    while (queue.length > 0 && idle.length > 0) {
      const worker = idle.pop();
      const job = queue.shift();
      if (!worker || !job) return;
      inFlight.set(worker, job);
      worker.postMessage(job.request);
    }
  }

  function enqueue(request: WorkerRequest): Promise<WorkerResponse> {
    if (closed) return Promise.reject(new Error('parser pool is closed'));
    return new Promise<WorkerResponse>((resolve, reject) => {
      queue.push({ request, resolve, reject });
      pump();
    });
  }

  for (let i = 0; i < size; i += 1) idle.push(spawn());

  return {
    async parse(filePath, absolutePath, source) {
      const response = await enqueue({ id: nextId++, filePath, absolutePath, source: source ?? null });
      // The worker answers a parse with a parse; anything else is a bug in the
      // worker, not a file that failed.
      if (response.ok && 'parsed' in response) return response.parsed;
      throw new Error(`${filePath}: the worker answered a parse with something else`);
    },

    async flow(filePath, absolutePath, range) {
      const response = await enqueue({ id: nextId++, kind: 'flow', filePath, absolutePath, range });
      if (response.ok && 'answer' in response) return response.answer;
      throw new Error(`${filePath}: the worker answered a flow with something else`);
    },

    async close() {
      closed = true;
      // Jobs still waiting can never run now, and a caller left waiting on one —
      // a commit's graph half built when the project was switched — would hang
      // for ever, its temporary directory with it.
      const reason = new Error('parser pool is closed');
      while (queue.length > 0) queue.shift()?.reject(reason);
      const workers = [...idle, ...inFlight.keys()];
      idle.length = 0;
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}
