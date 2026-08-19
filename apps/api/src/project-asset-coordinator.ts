function assertBatchProjectId(batchProjectId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(batchProjectId)) {
    throw new Error("Batch project ID contains invalid characters.");
  }
}

export interface ProjectAssetCoordinator {
  runExclusive<Result>(
    batchProjectId: string,
    operation: () => Result | Promise<Result>,
  ): Promise<Result>;
}

/**
 * Coordinates project asset mutations in this local process. A production
 * multi-process deployment must replace this with a database transaction or
 * distributed lease that covers the same project aggregate.
 */
export class LocalProjectAssetCoordinator implements ProjectAssetCoordinator {
  readonly #tails = new Map<string, Promise<void>>();

  async runExclusive<Result>(
    batchProjectId: string,
    operation: () => Result | Promise<Result>,
  ): Promise<Result> {
    assertBatchProjectId(batchProjectId);
    const previous = this.#tails.get(batchProjectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(batchProjectId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(batchProjectId) === tail) this.#tails.delete(batchProjectId);
    }
  }
}

export const defaultProjectAssetCoordinator = new LocalProjectAssetCoordinator();
