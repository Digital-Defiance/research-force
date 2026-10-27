import { OPERATIONS } from '@researchforce/domain/settings';

interface MetaCarrier { readonly meta?: { readonly rows_read?: number; readonly rows_written?: number } }
export interface RequestUsage { readonly statements: number; readonly rowsRead: number; readonly rowsWritten: number }

/**
 * Sums D1 statements and the rows each reports for one request, so the route can be logged with its
 * usage and Public_Traffic can be reported to Budget (design "Measured budgets"; R28.3).
 */
export class RequestAccountant {
  #statements = 0;
  #rowsRead = 0;
  #rowsWritten = 0;

  /** Record one result, or the results of one batch, in which every statement counts. */
  add(result: MetaCarrier | readonly MetaCarrier[]): void {
    for (const entry of Array.isArray(result) ? result : [result as MetaCarrier]) {
      this.#statements++;
      this.#rowsRead += entry.meta?.rows_read ?? 0;
      this.#rowsWritten += entry.meta?.rows_written ?? 0;
    }
  }

  async track<T extends MetaCarrier | readonly MetaCarrier[]>(pending: Promise<T>): Promise<T> {
    const result = await pending;
    this.add(result);
    return result;
  }

  /** Statements a handler may still issue within the per-request limit. */
  get remaining(): number { return Math.max(0, OPERATIONS.maxD1Statements - this.#statements); }
  get usage(): RequestUsage { return { statements: this.#statements, rowsRead: this.#rowsRead, rowsWritten: this.#rowsWritten }; }
}
