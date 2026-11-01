import { previewChange } from '@researchforce/kernel/preview';
import type { Timestamp } from '@researchforce/domain/types';
import { loadProjectionInput } from '../kernel-input';
import { issuePreviewToken } from '../disclosure/token';
import { previewReportKey } from '../disclosure/preview';
import type { PreviewJobParams, PreviewJobResult } from '../disclosure/preview';
import { JOB_HANDLERS } from '../do/jobs';
import type { JobHandler, JsonValue } from '../do/jobs';

/**
 * The `preview` job. A preview of more than a few hundred units runs here with progress and paging: one slice loads the
 * roots, projects the current and changed states with the kernel, writes the diff, gate failures, and preview token to
 * the private bucket under the job's report key, and reports its unit total as progress (R23.6, R23.16). The polling
 * route pages the stored diff. The write is idempotent: a slice that runs again overwrites the same object.
 */
export const previewJob: JobHandler = {
  async slice({ env, job, now }): Promise<{ cursor: JsonValue; progress: JsonValue; done: boolean }> {
    const params = job.params as unknown as PreviewJobParams;
    const { input, dependencies, consent } = await loadProjectionInput(env.RF_CORE, params.roots, now as Timestamp, { projectIds: params.projectIds, withConsent: true });
    const { diff, failures } = previewChange(params.change, { input, requesterId: params.requesterId, contentLicence: (env.CONTENT_LICENCE_NAME ?? '').trim(), ...(consent ? { consent } : {}) });
    const token = failures.length === 0 && env.DOWNLOAD_HMAC_KEY
      ? await issuePreviewToken({ change: params.change, dependencies, requesterId: params.requesterId, issuedAt: new Date(now).getTime() }, env.DOWNLOAD_HMAC_KEY)
      : null;
    const result: PreviewJobResult = { diff, failures: [...failures], token };
    const key = previewReportKey(job.id).replace(/^rf-private\//u, '');
    await env.RF_PRIVATE_BUCKET.put(key, JSON.stringify(result));
    return { cursor: null, progress: { units: diff.changed.length, changed: diff.changed.length, pages: Math.ceil(diff.changed.length / 100) }, done: true };
  },
};

JOB_HANDLERS.preview = previewJob;
