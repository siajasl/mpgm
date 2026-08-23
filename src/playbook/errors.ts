/**
 * A playbook could not be loaded or expanded. As with role files, the message
 * names the file and the offending element: a playbook that fails to load
 * stops a phase before it starts, so the error has to be enough to fix it.
 */
export class PlaybookLoadError extends Error {
  constructor(
    readonly sourcePath: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${sourcePath}: ${detail}`, options);
    this.name = 'PlaybookLoadError';
  }
}
