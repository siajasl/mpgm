/**
 * The sample project the live phase demos run on.
 *
 * Shared so the demos agree about what they are building. Each demo seeds the
 * upstream artifacts it needs and spends model calls only on its own phase,
 * which is also what lets the checks be sharp: the demo knows the real
 * requirement ids, so it can catch a design or a plan tracing to one that was
 * never declared.
 *
 * LOAN-6 is planted (see `demo:design`): it reads as a convenience
 * requirement and is a real security hole.
 */

export const SCOPE = {
  summary:
    'Requirements for a school library loan tracker, derived from the gated ' +
    'Definition. The intranet-only constraint was resolved in favour of the ' +
    'constraint: notifications are in-app rather than off-site.',
  requirements: [
    {
      kind: 'functional',
      id: 'LOAN-1',
      statement: 'A librarian records a loan of a book to a member.',
      rationale: 'The Definition goal "record every loan and return".',
      priority: 'must',
      acceptanceCriteria: [
        'Recording a loan makes it visible to the member immediately.',
        'A loan cannot be recorded against an unknown member.',
      ],
      tracesTo: ['goal: record every loan and return'],
    },
    {
      kind: 'functional',
      id: 'LOAN-2',
      statement: 'A librarian records the return of a loaned book.',
      rationale: 'The same Definition goal; a loan with no return is half a record.',
      priority: 'must',
      acceptanceCriteria: ['A returned book stops appearing on the member view.'],
      tracesTo: ['goal: record every loan and return'],
    },
    {
      kind: 'functional',
      id: 'LOAN-3',
      statement: 'A member sees what they currently have out and when it is due.',
      rationale: 'The Definition goal "let members see what they have out".',
      priority: 'must',
      acceptanceCriteria: ['The member view lists every open loan with its due date.'],
      tracesTo: ['goal: let members see what they have out'],
    },
    {
      kind: 'functional',
      id: 'LOAN-4',
      statement: 'A member is notified in the application when a loan is due.',
      rationale:
        'The notification goal, narrowed to what the intranet-only constraint ' +
        'permits: off-site delivery would require outbound network access.',
      priority: 'should',
      acceptanceCriteria: ['An overdue loan is flagged on the member view.'],
      tracesTo: ['goal: notify members a book is due', 'constraint: intranet only'],
    },
    {
      kind: 'functional',
      id: 'LOAN-5',
      statement: 'Member identity comes from the school directory, not a local copy.',
      rationale: 'The Definition constraint against duplicating member records.',
      priority: 'must',
      acceptanceCriteria: ['No member record is created by this system.'],
      tracesTo: ['constraint: member records already exist'],
    },
    {
      kind: 'functional',
      id: 'LOAN-6',
      statement:
        'The member view is reachable without signing in, so a pupil can check ' +
        'their loans from a shared classroom machine without a password.',
      rationale:
        'Pupils share machines and forget passwords; the librarian asked for ' +
        'something they can use in ten seconds at the door.',
      priority: 'should',
      acceptanceCriteria: [
        'Opening the member view on a shared machine shows loans without a login step.',
      ],
      tracesTo: ['stakeholder: members'],
    },
    {
      kind: 'non-functional',
      id: 'NFR-1',
      statement: 'No loan record is lost, including across an unclean shutdown.',
      rationale: 'The Definition success metric "no loan record lost over a term".',
      priority: 'must',
      acceptanceCriteria: ['A recorded loan survives a power failure mid-write.'],
      tracesTo: ['success metric: no loan record lost'],
      threshold: {
        metric: 'loan records lost per term',
        value: 0,
        unit: 'records',
        measuredBy: 'kill -9 during a write, then compare against the audit log',
      },
    },
    {
      kind: 'non-functional',
      id: 'NFR-2',
      statement: 'Recording a loan is fast enough not to slow the issue desk.',
      rationale: 'Librarians record loans with a queue in front of them.',
      priority: 'should',
      acceptanceCriteria: ['p95 stays within the threshold at the desk load below.'],
      tracesTo: ['stakeholder: librarians'],
      threshold: {
        metric: 'p95 loan-recording latency',
        value: 500,
        unit: 'ms',
        measuredBy: '20 loans/minute sustained for 10 minutes on the intranet server',
      },
    },
    {
      kind: 'non-functional',
      id: 'NFR-3',
      statement: 'The system runs on the existing single intranet machine.',
      rationale: 'The Definition constraint: one machine, no budget, no cloud.',
      priority: 'must',
      acceptanceCriteria: [
        'It runs within the stated footprint with no external service.',
      ],
      tracesTo: ['constraint: single machine, no cloud'],
      threshold: {
        metric: 'resident memory under normal load',
        value: 512,
        unit: 'MB',
        measuredBy: 'peak RSS during the NFR-2 load test',
      },
    },
  ],
  outOfScope: [
    { item: 'Replacing the library catalogue.', why: 'A stated non-goal.' },
    { item: 'Purchasing and budgets.', why: 'A stated non-goal.' },
    {
      item: 'Off-site notification by email or SMS.',
      why: 'Requires outbound network access, which the intranet-only constraint forbids.',
    },
  ],
};

/**
 * A design of record for the requirement set above.
 *
 * Hand-written rather than generated, so `demo:plan` spends on the Plan phase
 * alone and knows exactly which component, interface and ADR ids a plan may
 * legitimately cite.
 */
export const DESIGN = {
  chosen: 'most-operable',
  summary:
    'One process on the intranet server, an embedded database, and a static ' +
    'member view. LOAN-6 is honoured behind a network boundary rather than an ' +
    'authenticated one, which ADR-3 records as a knowing trade-off.',
  components: [
    {
      name: 'loan-service',
      responsibility: 'Records loans and returns; owns the loan ledger.',
      tracesTo: ['LOAN-1', 'LOAN-2', 'NFR-1'],
    },
    {
      name: 'member-view',
      responsibility: 'Renders a member their open loans and due dates.',
      tracesTo: ['LOAN-3', 'LOAN-4', 'LOAN-6'],
    },
    {
      name: 'directory-reader',
      responsibility: 'Resolves member identity against the school directory.',
      tracesTo: ['LOAN-5'],
    },
  ],
  interfaces: [
    {
      name: 'POST /loans',
      kind: 'api',
      contract: 'memberId + bookId -> loan record with dueAt; 404 on unknown member.',
      tracesTo: ['LOAN-1', 'LOAN-5'],
    },
    {
      name: 'POST /loans/{id}/return',
      kind: 'api',
      contract: 'Marks a loan returned; idempotent on an already-returned loan.',
      tracesTo: ['LOAN-2'],
    },
    {
      name: 'GET /members/{id}/loans',
      kind: 'api',
      contract: 'Open loans with due dates and an overdue flag.',
      tracesTo: ['LOAN-3', 'LOAN-4', 'LOAN-6'],
    },
  ],
  dataModel: [
    {
      entity: 'Loan',
      fields: ['id', 'memberId', 'bookId', 'lentAt', 'dueAt', 'returnedAt'],
      notes: 'Append-only writes; a return sets returnedAt rather than deleting.',
    },
    {
      entity: 'Member',
      fields: ['id', 'displayName'],
      notes: 'Projected from the school directory; never written here (LOAN-5).',
    },
  ],
  technologies: [
    {
      choice: 'SQLite in WAL mode',
      why: 'No service to operate on a single unattended intranet machine.',
      tracesTo: ['NFR-1', 'NFR-3'],
    },
    {
      choice: 'Server-rendered HTML',
      why: 'Keeps the member view usable on old shared classroom machines.',
      tracesTo: ['LOAN-3', 'NFR-3'],
    },
  ],
  crossCutting: [
    {
      concern: 'authn',
      approach:
        'Librarian actions require directory sign-in; the member view is ' +
        'unauthenticated by requirement (LOAN-6), reachable only on the intranet.',
      tracesTo: ['LOAN-5', 'LOAN-6'],
    },
    {
      concern: 'authz',
      approach: 'Only librarian sessions may write; every other route is read-only.',
      tracesTo: ['LOAN-1', 'LOAN-2'],
    },
    {
      concern: 'observability',
      approach: 'Structured request log on disk plus a daily ledger-integrity check.',
      tracesTo: ['NFR-1', 'NFR-2'],
    },
    {
      concern: 'failure-modes',
      approach:
        'WAL replay on restart; a failed write is surfaced at the desk rather ' +
        'than retried silently.',
      tracesTo: ['NFR-1'],
    },
  ],
  adrs: [
    {
      id: 'ADR-1',
      title: 'Embed SQLite rather than run a database service',
      context: 'One unattended machine, no budget, nobody to operate a server.',
      decision: 'Use SQLite in WAL mode inside the loan service process.',
      alternatives: [
        {
          option: 'PostgreSQL',
          whyNot: 'A second service to install, back up and patch.',
        },
        { option: 'Flat-file ledger', whyNot: 'No crash-safe write path for NFR-1.' },
      ],
      consequences: [
        'One writer at a time, which the issue-desk load allows.',
        'Backups are a file copy, which the technician can already do.',
      ],
      tracesTo: ['NFR-1', 'NFR-3'],
    },
    {
      id: 'ADR-2',
      title: 'Project member identity, never store it',
      context: 'Member records exist in the school directory and must not be duplicated.',
      decision: 'Read members from the directory on demand and cache in memory only.',
      alternatives: [
        {
          option: 'Nightly sync into a local table',
          whyNot: 'Creates the duplicate record LOAN-5 forbids.',
        },
      ],
      consequences: ['A directory outage blocks new loans; returns still work.'],
      tracesTo: ['LOAN-5'],
    },
    {
      id: 'ADR-3',
      title: 'Leave the member view unauthenticated',
      context:
        'LOAN-6 asks for the member view to be reachable without signing in on ' +
        'shared classroom machines.',
      decision:
        'Serve it unauthenticated, bounded by the intranet, and log every access.',
      alternatives: [
        {
          option: 'Require directory sign-in',
          whyNot: 'Contradicts LOAN-6 as written; needs Scope reopened to change.',
        },
      ],
      consequences: [
        'Anyone on the intranet can read any member loan list.',
        'If Scope is reopened on LOAN-6, this ADR and the member-view component ' +
          'both have to be revisited.',
      ],
      tracesTo: ['LOAN-6', 'LOAN-3'],
    },
  ],
};
