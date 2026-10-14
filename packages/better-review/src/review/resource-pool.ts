type Slot<T> = { value: T; leases: number; touched: number; timer?: ReturnType<typeof setTimeout> };

/** Bounded LRU pool. Leased resources cannot be evicted; idle resources expire. */
export class ResourcePool<T> {
  private slots = new Map<string, Slot<T>>();
  private line: Promise<unknown> = Promise.resolve();
  private waiters = new Set<() => void>();
  private closed = false;
  constructor(
    private capacity: number,
    private idleMs: number,
    private dispose: (value: T) => Promise<void>,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(idleMs) || idleMs < 1)
      throw new Error("Invalid sandbox pool limits");
  }
  private exclusive<A>(run: () => Promise<A>): Promise<A> {
    const next = this.line.then(run, run);
    this.line = next.catch(() => undefined);
    return next;
  }
  private wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
  private async remove(key: string, slot: Slot<T>) {
    clearTimeout(slot.timer);
    await this.dispose(slot.value);
    this.slots.delete(key);
    this.wake();
  }
  async acquire(key: string, create: () => Promise<T>, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      // Register before checking capacity so a release cannot be lost.
      this.waiters.add(wake);
      const slot = await this.exclusive(async () => {
        if (this.closed) throw new Error("Sandbox pool is closed");
        let slot = this.slots.get(key);
        if (!slot && this.slots.size >= this.capacity) {
          const idle = [...this.slots]
            .filter(([, item]) => item.leases === 0)
            .sort((a, b) => a[1].touched - b[1].touched)[0];
          if (!idle) return undefined;
          await this.remove(...idle);
        }
        if (!slot) {
          slot = { value: await create(), leases: 0, touched: Date.now() };
          this.slots.set(key, slot);
        }
        clearTimeout(slot.timer);
        slot.leases++;
        return slot;
      }).catch((error) => {
        this.waiters.delete(wake);
        throw error;
      });
      if (slot) {
        this.waiters.delete(wake);
        let released = false;
        return {
          value: slot.value,
          release: () =>
            this.exclusive(async () => {
              if (released) return;
              released = true;
              slot.leases--;
              slot.touched = Date.now();
              if (!slot.leases) {
                slot.timer = setTimeout(() => {
                  void this.exclusive(async () => {
                    if (!slot.leases && this.slots.get(key) === slot) await this.remove(key, slot);
                  }).catch((error) =>
                    console.error("[Review] Idle sandbox eviction failed:", error),
                  );
                }, this.idleMs);
                slot.timer.unref();
              }
              this.wake();
            }),
        };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          changed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("All review sandboxes are busy; try again shortly")),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.waiters.delete(wake);
      }
    }
  }
  async evict(key: string): Promise<"missing" | "active" | "removed"> {
    return this.exclusive(async () => {
      const slot = this.slots.get(key);
      if (!slot) return "missing";
      if (slot.leases) return "active";
      await this.remove(key, slot);
      return "removed";
    });
  }
  async close() {
    await this.exclusive(async () => {
      this.closed = true;
      this.wake();
      for (const [key, slot] of this.slots) {
        if (slot.leases) throw new Error("Cannot close sandbox pool with active reviews");
        await this.remove(key, slot);
      }
    });
  }
}
