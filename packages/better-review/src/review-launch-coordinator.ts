/** Coalesce duplicate launches for one PR; different PRs remain independent. */
export class ReviewLaunchCoordinator<T> {
  private pending = new Map<string, Promise<T>>();
  has(key: string): boolean {
    return this.pending.has(key);
  }
  run(key: string, launch: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(launch)
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, task);
    return task;
  }
}

/** Session preparation and navigation must not create competing sessions for one PR. */
export class PrSessionLock {
  private pending = new Map<string, Promise<unknown>>();
  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(action);
    this.pending.set(key, task);
    void task
      .finally(() => {
        if (this.pending.get(key) === task) this.pending.delete(key);
      })
      .catch(() => undefined);
    return task;
  }
}
