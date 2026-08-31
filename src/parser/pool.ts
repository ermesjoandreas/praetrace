import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { ParsedFile, ParseRequest, ParseResponse } from './types.js';

// Resolved relative to this module, so it points at the compiled worker whether
// the pool runs from dist/ or from a linked install.
const WORKER_URL = new URL('./worker.js', import.meta.url);

interface Job {
  request: ParseRequest;
  resolve: (parsed: ParsedFile) => void;
  reject: (error: Error) => void;
}

export interface ParserPool {
  parse(filePath: string, absolutePath: string, source?: string): Promise<ParsedFile>;
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

    worker.on('message', (response: ParseResponse) => {
      // Reaching here at all means the worker loaded and ran.
      consecutiveFailures = 0;
      settle(worker, (job) => {
        if (response.ok) job.resolve(response.parsed);
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

  for (let i = 0; i < size; i += 1) idle.push(spawn());

  return {
    parse(filePath, absolutePath, source) {
      if (closed) return Promise.reject(new Error('parser pool is closed'));
      return new Promise<ParsedFile>((resolve, reject) => {
        queue.push({
          request: { id: nextId++, filePath, absolutePath, source: source ?? null },
          resolve,
          reject,
        });
        pump();
      });
    },

    async close() {
      closed = true;
      const workers = [...idle, ...inFlight.keys()];
      idle.length = 0;
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}
