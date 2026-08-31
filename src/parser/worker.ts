import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { parseSource } from './extract.js';
import type { ParseRequest, ParseResponse } from './types.js';

if (!parentPort) {
  throw new Error('parser worker must be started as a worker thread');
}

const port = parentPort;

port.on('message', (request: ParseRequest) => {
  void handle(request).then((response) => port.postMessage(response));
});

async function handle(request: ParseRequest): Promise<ParseResponse> {
  try {
    // Reading here rather than on the main thread keeps all per-file work,
    // I/O included, off the event loop the collector runs on.
    const source = request.source ?? (await readFile(request.absolutePath, 'utf8'));
    return { id: request.id, ok: true, parsed: parseSource(request.filePath, source) };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
