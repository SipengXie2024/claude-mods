/**
 * The checks a loop has seen fail in the work at hand, and whether a failure
 * is a repeat: the same check (same full command) failing again after the
 * model changed code since its last failure. Only a repeat moves the ladder;
 * a first failure, or a rerun with no edit in between, does not. A pass
 * clears the check. Pure state, no I/O.
 */

export type CheckOutcome =
  /** the check failed for the first time in this work */
  | 'first-failure'
  /** failed again with no code change since its last failure */
  | 'rerun-failure'
  /** failed again after a code change: one rung on the ladder */
  | 'repeat-failure'
  | 'pass';

interface CheckRecord {
  /** an Edit/Write/MultiEdit/NotebookEdit succeeded since the last failure */
  editedSince: boolean;
  failures: number;
  repeats: number;
  /** a raise (mid-loop or carried) was made for this check */
  raised: boolean;
}

export interface CheckNote {
  outcome: CheckOutcome;
  failures: number;
  /** a pass of a check that a raise was made for */
  passedAfterRaise: boolean;
}

export class Ladder {
  private readonly checks = new Map<string, CheckRecord>();

  /** A successful code change: every failing check may now repeat. */
  noteEdit(): void {
    for (const c of this.checks.values()) c.editedSince = true;
  }

  noteCheck(id: string, failed: boolean): CheckNote {
    const c = this.checks.get(id);
    if (!failed) {
      this.checks.delete(id);
      return { outcome: 'pass', failures: 0, passedAfterRaise: c?.raised === true };
    }
    if (!c) {
      this.checks.set(id, { editedSince: false, failures: 1, repeats: 0, raised: false });
      return { outcome: 'first-failure', failures: 1, passedAfterRaise: false };
    }
    c.failures += 1;
    const repeat = c.editedSince;
    c.editedSince = false;
    if (repeat) c.repeats += 1;
    return { outcome: repeat ? 'repeat-failure' : 'rerun-failure', failures: c.failures, passedAfterRaise: false };
  }

  markRaised(id: string): void {
    const c = this.checks.get(id);
    if (c) c.raised = true;
  }

  /** Checks that repeat-failed and have not passed since: what a continuing prompt carries. */
  repeatFailing(): string[] {
    return [...this.checks].filter(([, c]) => c.repeats > 0).map(([id]) => id);
  }

  get open(): number {
    return this.checks.size;
  }
}
