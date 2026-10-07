// Async queue for streaming-input mode: interrupt() only works when the prompt is an open AsyncIterable.
export class Pushable<T> implements AsyncIterable<T> {
  private q: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(v: T): void {
    if (this.done) return;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: v, done: false }); } else this.q.push(v);
  }

  end(): void {
    this.done = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: undefined, done: true }); }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.q.length) return Promise.resolve({ value: this.q.shift() as T, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => { this.waiter = r; });
      },
    };
  }
}
