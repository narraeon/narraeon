interface ReadTargetOptions<T> {
  load: () => Promise<T>;
  apply: (value: T) => void;
  onSyncFailure: (failed: boolean, reason?: unknown) => void;
}

/** A page's read-only recovery boundary. Commands and their receipts stay with the caller. */
export class ReadTarget<T> {
  private version = 0;
  private lifetime = 0;
  private disposed = false;
  private inFlight: Promise<T | null> | null = null;
  private recoveryNeeded = false;

  private readonly options: ReadTargetOptions<T>;

  constructor(options: ReadTargetOptions<T>) {
    this.options = options;
  }

  /** Ordinary reads get one automatic recovery if they fail. */
  read(): Promise<T | null> {
    return this.inFlight ?? this.start(false);
  }

  /** A fault must be followed by a read begun after that fault. Overlapping demands coalesce. */
  recover(): Promise<T | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.inFlight !== null) {
      this.recoveryNeeded = true;
      return this.inFlight;
    }
    return this.start(true);
  }

  /** Supersede older reads and failures. A partial receipt still needs a full in-flight read replaced. */
  accept({ complete = true }: { complete?: boolean } = {}): void {
    if (this.disposed) return;
    this.version++;
    if (complete) this.options.onSyncFailure(false);
    else if (this.inFlight !== null) this.recoveryNeeded = true;
  }

  /** Retire this scope without closing the boundary shared by its callers. */
  retarget(): void {
    if (this.disposed) return;
    this.activate();
    this.recoveryNeeded = false;
    this.options.onSyncFailure(false);
  }

  /** Reattach after React's development lifecycle check; old work remains invalid. */
  activate(): void {
    this.disposed = false;
    this.lifetime++;
    this.version++;
    this.inFlight = null;
  }

  dispose(): void {
    this.disposed = true;
    this.lifetime++;
    this.version++;
    this.recoveryNeeded = false;
  }

  async command<R>(send: () => Promise<R>): Promise<R> {
    try {
      return await send();
    } catch (error) {
      await this.recover();
      throw error;
    }
  }

  private start(recovery: boolean): Promise<T | null> {
    if (this.disposed) return Promise.resolve(null);
    // Defer the loader until inFlight is assigned, even for a synchronous throw.
    const lifetime = this.lifetime;
    const current = () => !this.disposed && lifetime === this.lifetime;
    const run = async (): Promise<T | null> => {
      let result: T | null;
      let recovering = recovery;
      try {
        do {
          if (!current()) return null;
          result = null;
          this.recoveryNeeded = false;
          const version = this.version;
          try {
            const value = await this.options.load();
            if (current() && version === this.version) {
              this.options.apply(value);
              this.options.onSyncFailure(false);
              result = value;
            }
          } catch (reason) {
            if (current() && version === this.version) {
              if (recovering) this.options.onSyncFailure(true, reason);
              else {
                this.recoveryNeeded = true;
              }
            }
          }
          recovering = true;
        } while (current() && this.recoveryNeeded);
        return result;
      } finally {
        // Release synchronously with the last iteration, before promise settlement
        // can deliver another fault that would otherwise join an already-ended loop.
        if (this.inFlight === pending) this.inFlight = null;
      }
    };
    const pending = Promise.resolve().then(run);
    this.inFlight = pending;
    return pending;
  }
}
