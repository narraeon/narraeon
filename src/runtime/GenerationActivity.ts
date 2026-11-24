/** Reports the first admitted generation and the point when all have settled. */
export class GenerationActivity {
  #running = 0;
  readonly #report: (active: boolean) => void;

  constructor(report: (active: boolean) => void) {
    this.#report = report;
  }

  start(): () => void {
    if (++this.#running === 1) this.#report(true);
    return () => {
      if (--this.#running === 0) this.#report(false);
    };
  }
}
