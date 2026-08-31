import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Projector } from '../state/projector.js';
import type { TraceIndex } from '../trace/index-store.js';
import { allSummaries, runProjection, traceGraph } from './projection.js';
import { errorPage, runDetailPage, runListPage, traceGraphPage } from './render.js';

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
 *
 * The dashboard UI (T3.2.5b) is this same JSON surface content-negotiated: a
 * request whose `Accept` header prefers `text/html` gets the panel render
 * from `render.ts` over identical data, rather than a second route tree that
 * could drift from what the API actually returns. Every error response
 * negotiates the same way, so a browser that mistypes a URL or hits a
 * projection failure sees a rendered page rather than a raw JSON body.
 *
 * `/` is the one exception: it is a landing page for a browser, not part of
 * the negotiated API surface, so it renders HTML unconditionally regardless
 * of `Accept` — a JSON client has no use for a landing page and should ask
 * `/runs` directly for the same data.
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
      const message = `method ${req.method ?? '?'} not allowed: the projection API is read-only`;
      this.#respond(req, res, 405, { error: message }, () => errorPage(405, message));
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
      // If a response has already begun (headers sent on an earlier path
      // through this same request), writing another one throws
      // ERR_HTTP_HEADERS_SENT from inside this catch -- which would escape
      // the request listener and reintroduce the process-killing failure
      // this boundary exists to close off. Destroying the socket keeps that
      // exception from ever being raised, at the cost of an incomplete
      // response the client sees as a dropped connection rather than a 500.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = `projection failed: ${err instanceof Error ? err.message : String(err)}`;
      this.#respond(req, res, 500, { error: message }, () => errorPage(500, message));
    }
  }

  #dispatch(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://dashboard.local');
    const rawSegments = url.pathname.split('/').filter((segment) => segment !== '');

    // Decoding is client input, not a projection failure: a malformed
    // escape (`%zz`) throws a URIError that has nothing to do with the
    // projector, and letting it fall into the 500 boundary would blame the
    // server for a client-side mistake and name a component -- "projection"
    // -- that was never reached (CONV-3). Answer 400 here instead, naming
    // the segment that failed to decode.
    const segments: string[] = [];
    for (const segment of rawSegments) {
      try {
        segments.push(decodeURIComponent(segment));
      } catch {
        const message = `malformed path segment '${segment}': not a valid percent-encoding`;
        this.#respond(req, res, 400, { error: message }, () => errorPage(400, message));
        return;
      }
    }

    // `/` is the dashboard's landing page — a browser's first request has
    // nothing else to ask for, so it always renders rather than negotiating
    // like every other route below.
    if (segments.length === 0) {
      this.#html(res, 200, runListPage(allSummaries(this.#projector.project())));
      return;
    }

    if (segments.length === 1 && segments[0] === 'runs') {
      const summaries = allSummaries(this.#projector.project());
      this.#respond(req, res, 200, { runs: summaries }, () => runListPage(summaries));
      return;
    }

    if (segments.length === 2 && segments[0] === 'runs') {
      const runId = segments[1] ?? '';
      const runs = this.#projector.project().runs;
      // A plain object's index access resolves inherited keys too --
      // `runs['constructor']` or `runs['__proto__']` answer with
      // `Object.prototype`'s own value rather than `undefined`, which then
      // fails inside `runProjection` for reasons that look like a
      // projector bug rather than what they are: a run that simply does
      // not exist. `Object.hasOwn` treats the log's own keys as the only
      // ones that count.
      const run = Object.hasOwn(runs, runId) ? runs[runId] : undefined;
      if (run === undefined) {
        const message = `no run '${runId}' in the log`;
        this.#respond(req, res, 404, { error: message }, () => errorPage(404, message));
        return;
      }
      const projection = runProjection(run);
      this.#respond(req, res, 200, projection, () => runDetailPage(projection));
      return;
    }

    if (segments.length === 1 && segments[0] === 'trace') {
      const graph = traceGraph(this.#traces);
      this.#respond(req, res, 200, graph, () => traceGraphPage(graph));
      return;
    }

    const message = `no such route: ${url.pathname}`;
    this.#respond(req, res, 404, { error: message }, () => errorPage(404, message));
  }

  /**
   * A browser's default `Accept` header lists `text/html` ahead of the
   * wildcard `*` / `*` it also sends; `fetch()` with no `Accept` set at all
   * sends that wildcard alone. Treating only an explicit `text/html` range
   * as "wants HTML" is what keeps every existing JSON client (including
   * this file's own tests) getting exactly what it got before this route
   * grew a second representation.
   *
   * A media range's `q` parameter can mark it unacceptable outright
   * (`q=0`, per RFC 9110 §12.5.1) rather than merely a low preference — a
   * client sending `Accept: application/json, text/html;q=0` is refusing
   * HTML explicitly, not asking for it, so that has to be read as "does not
   * want HTML" rather than matched as a bare substring of the header.
   */
  #wantsHtml(req: IncomingMessage): boolean {
    const accept = req.headers.accept;
    if (accept === undefined) {
      return false;
    }
    for (const range of accept.split(',')) {
      const [type, ...params] = range.split(';').map((part) => part.trim());
      if (type !== 'text/html') {
        continue;
      }
      const qParam = params.find((param) => param.startsWith('q='));
      const q = qParam === undefined ? 1 : Number(qParam.slice('q='.length));
      return q !== 0;
    }
    return false;
  }

  /** JSON by default; the HTML panel only for a request that asked for one. */
  #respond(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    json: unknown,
    html: () => string,
  ): void {
    if (this.#wantsHtml(req)) {
      this.#html(res, status, html());
    } else {
      this.#json(res, status, json);
    }
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload)),
    });
    res.end(payload);
  }

  #html(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
    });
    res.end(body);
  }
}
