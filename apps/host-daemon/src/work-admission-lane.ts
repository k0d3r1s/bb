export class WorkAdmissionLane {
  private exclusiveTail: Promise<void> = Promise.resolve();
  private readonly activeShared = new Set<Promise<void>>();

  runShared<T>(work: () => T | PromiseLike<T>): Promise<T> {
    const started = this.exclusiveTail.catch(() => undefined).then(work);
    const settled = started.then(
      () => undefined,
      () => undefined,
    );
    this.activeShared.add(settled);
    void settled.then(() => {
      this.activeShared.delete(settled);
    });
    return started;
  }

  runExclusive<T>(work: () => T | PromiseLike<T>): Promise<T> {
    const priorShared = Promise.all(
      [...this.activeShared].map((entry) => entry.catch(() => undefined)),
    );
    const started = Promise.all([
      this.exclusiveTail.catch(() => undefined),
      priorShared,
    ]).then(work);
    this.exclusiveTail = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }
}
