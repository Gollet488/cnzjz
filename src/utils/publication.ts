// Coalesce append notifications, but pause/reset/end must flush the final frame.
export class SessionPublication {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private publish: () => void;
  private delay: number;
  constructor(publish: () => void, delay = 100) {
    this.publish = publish;
    this.delay = delay;
  }
  schedule() {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.publish();
    }, this.delay);
  }
  flush() {
    this.cancel();
    this.publish();
  }
  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
