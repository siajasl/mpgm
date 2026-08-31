import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Projector } from '../state/projector.js';
import type { TraceIndex } from '../trace/index-store.js';
import { allSummaries, runProjection, traceGraph } from './projection.js';

/**
 * A read-only HTTP projection of folded kernel state (DESIGN §4.4/§4.5, OBS-3).
 *
 * `mpgm status` serves the same event stream from the terminal (DESIGN §4.4);
 * this is the same read surface over HTTP for the web dashboard (T3.2.5b) to
 * render. Every request calls `Projector.project`, which resumes from the
 * newest snapshot and folds only the log's tail — a request made mid-run sees
 * whatever has committed since the last one, so the API is live rather than a
 * snapshot taken at process start.
 *
 * Read-only is enforced, not just documented: only `GET` is dispatched, and
 * every other method gets a `405` rather than being interpreted, because a
 * control channel that silently ignores a method it does not handle is worse
 * than one that says so.
 */
export interface DashboardServerOptions {
  readonly projector: Projector;
  readonly traces: TraceIndex;
}

export class DashboardServer {
  readonly #projector: Projector;
  readonly #traces: TraceIndex;
  readonly #server: Server;

  constructor(options: DashboardServerOptions) {
    this.#projector = options.projector;
    this.#traces = options.traces;
    this.#server = createServer((req, res) => {
      this.#handle(req, res);
    });
  }

  /** Bind and start listening. Port `0` (the default) picks a free one. */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, '127.0.0.1', () => {
        const address = this.#server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      this.#json(res, 405, {
        error: `method ${req.method ?? '?'} not allowed: the projection API is read-only`,
      });
      return;
    }

    // The projector reads the live database on every request (that is what
    // makes this a *live* view rather than a start-time snapshot), so it can
    // throw for reasons entirely outside this handler's control — a writer
    // holding the file lock, a snapshot row that fails to parse, a database
    // closed out from under it. A read-only view sharing the kernel's own
    // projector must not let that kind of failure escape as an uncaught
    // exception: in this process that kills the dashboard *and* the kernel
    // it is observing, and the caller sees nothing but a timeout rather than
    // an error it can act on (CONV-3).
    try {
      this.#dispatch(req, res);
    } catch (err) {
      this.#json(res, 500, {
        error: `projection failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  #dispatch(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://dashboard.local');
    const segments = url.pathname
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));

    if (segments.length === 1 && segments[0] === 'runs') {
      this.#json(res, 200, { runs: allSummaries(this.#projector.project()) });
      return;
    }

    if (segments.length === 2 && segments[0] === 'runs') {
      const runId = segments[1] ?? '';
      const run = this.#projector.project().runs[runId];
      if (run === undefined) {
        this.#json(res, 404, { error: `no run '${runId}' in the log` });
        return;
      }
      this.#json(res, 200, runProjection(run));
      return;
    }

    if (segments.length === 1 && segments[0] === 'trace') {
      this.#json(res, 200, traceGraph(this.#traces));
      return;
    }

    this.#json(res, 404, { error: `no such route: ${url.pathname}` });
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload)),
    });
    res.end(payload);
  }
}
