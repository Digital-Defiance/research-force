import type { OpsAccess, OpsAnalytics, OpsBackupAlert, OpsContainment, OpsDeploy, OpsHealthAlert, OpsSpendAlert, OpsWaf } from '@researchforce/domain/ops';
import type { Budget, Jobs, Mailer, Publisher } from './durable-objects';
import type { LocalServices } from './local/services';

export interface Env {
  /** Explicit deployment selection; absence keeps pre-profile development installs compatible. */
  RESOURCE_PROFILE?: string;
  /** Local entrypoint only; generated from the ignored .dev.vars opt-in by the local runner. */
  RF_DEV_AUTH?: string;
  RF_DEV_AUTH_PRIVATE_KEY?: string;
  /** Present only in the generated local config; production refuses both fields. */
  RF_LOCAL_SERVICES?: string;
  LOCAL_SERVICES?: DurableObjectNamespace<LocalServices>;
  /** Bucket-scoped S3 credentials and shared download secret, configured per installation. */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  PRIVATE_BUCKET_NAME?: string;
  /** The `rf-public` bucket name, enabling the Publisher's server-side `CopyObject` of public files (R24.3); absent falls back to the binding get→put stream. */
  PUBLIC_BUCKET_NAME?: string;
  DOWNLOAD_HMAC_KEY?: string;
  DOWNLOAD_ORIGIN?: string;
  RF_CORE: D1Database;
  RF_SEARCH: D1Database;
  RF_PUBLIC: D1Database;
  RF_PRIVATE_BUCKET: R2Bucket;
  RF_PUBLIC_BUCKET: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  /** rf-ops over the service binding: Access, the Publisher's site deploy and edge Containment (tasks 32.1/32.5/59.2), the Budget's submit WAF block (task 34.1/34.2), platform usage analytics (task 44.1), the independent backup-age/RPO alert (task 58.2), and the independent health/spend alerts (task 67.2). */
  OPS: Fetcher & OpsAccess & OpsAnalytics & OpsDeploy & OpsContainment & OpsWaf & OpsBackupAlert & OpsHealthAlert & OpsSpendAlert;
  PUBLISHER: DurableObjectNamespace<Publisher>;
  MAILER: DurableObjectNamespace<Mailer>;
  BUDGET: DurableObjectNamespace<Budget>;
  JOBS: DurableObjectNamespace<Jobs>;
  /** `https://app.researchforce.org`, or the staging hostname. */
  WORKSPACE_ORIGIN: string;
  /** The public pages origin (`https://researchforce.org`) the verify step HEADs removed page addresses at (R24.16). */
  PUBLIC_SITE_ORIGIN?: string;
  /** The public files origin (`https://files.researchforce.org`) the verify step HEADs removed file copies at (R24.16). */
  PUBLIC_FILES_ORIGIN?: string;
  /** The Publisher's public-site size ceiling in current Public_Views (positive integer string); unset or invalid uses the Free-plan default of 750. */
  PUBLISHER_SITE_VIEW_CEILING?: string;
  /** The Outside_Submission worker origin (`https://submit.researchforce.org`, or the staging host) the public form pages call; unset uses the production host. */
  PUBLIC_SUBMIT_ORIGIN?: string;
  /** The Turnstile site key (public) the public form pages mount the Bot_Check with; unset leaves the forms unavailable. */
  TURNSTILE_SITE_KEY?: string;
  /** Secrets: `https://<team>.cloudflareaccess.com` and the Access application's AUD tag. */
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Secrets of the Microsoft Graph Email_Provider: the app registration, its certificate key (PKCS#8 PEM) and SHA-1 thumbprint, and the Sending_Address. */
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_CERT_KEY?: string;
  GRAPH_CERT_THUMBPRINT?: string;
  SENDING_ADDRESS?: string;
  /** The installation's current Content_Licence name; unset until the owner chooses one (no default). */
  CONTENT_LICENCE_NAME?: string;
  /** The full-text address the Content_Licence name links to on public pages (R29.10, R46.15); unset until the owner configures it. */
  CONTENT_LICENCE_URL?: string;
  /**
   * The installation's `Installation_Public_Copy` as a JSON string: the masthead name and strapline, the Mission
   * statement, the About prose, and the ordered Principles (R46.41, R46.42). Unset or incomplete until the owner
   * configures a complete bundle; site generation, publication, and export refuse to proceed without a validated
   * bundle, with no ResearchForce.org fallback. There is no default.
   */
  PUBLIC_COPY?: string;
  /** Secret HMAC key authenticating sealed Research_Release manifests (R59.2); sealing and manifest verification require it. */
  RELEASE_MANIFEST_KEY?: string;
  /**
   * Break-glass secret for the Internal_Backup freeze recovery command (R36.14, R60.6). Held independently of the
   * production account, outside the normal app session auth; the recovery command force-releases a stuck write-freeze
   * only when this secret is presented with a reason and operator label. Unset disables the command.
   */
  FREEZE_BREAK_GLASS_KEY?: string;
  /** The source installation identity recorded in every Internal_Backup manifest (R36.13); defaults to a dev label when unset. */
  BACKUP_INSTALLATION_ID?: string;
  /** The released schema version the current reader writes backups at (R36.13, R36.16); defaults to a dev label when unset. */
  BACKUP_SCHEMA_RELEASE?: string;
  /**
   * The up to two PRECEDING released schema versions the current restore reader still reads (R36.16), as a
   * comma-separated list of release ids. A backup written at the current or either listed release restores through its
   * explicit transform; any other (older/unknown) schema is rejected by preflight and the restore stays quarantined.
   * The restore builds its {@link InventoryRegistry} from `BACKUP_SCHEMA_RELEASE` plus this list, so "current and two
   * preceding released schema versions" stays a single source of truth. Unset means the reader reads only the current
   * schema (the development default).
   */
  BACKUP_PRIOR_SCHEMAS?: string;
  /**
   * The configured recovery custodians for Internal_Backup data-key wrapping (R36.13), as JSON. Each per-backup data
   * key is wrapped once per custodian under that custodian's operator-held recovery key, held INDEPENDENTLY of the
   * production account; no recovery secret is embedded in a package or the source repository. The value is a JSON
   * array of `{ custodianId, generation, keyBase64 }`, where `keyBase64` is a 32-byte AES-256 recovery key. The
   * independent destination, custody rotation, and verification wiring are task 58.2; this task only consumes the
   * configured custodian(s) so a produced package carries wrapped envelopes. Unset leaves a package unwrapped, which
   * blocks sole-copy research custody (R36.12) — the job records that no custodian was configured.
   */
  BACKUP_RECOVERY_CUSTODIANS?: string;
  /**
   * The operator-configured INDEPENDENT backup destination, OUTSIDE the production account (task 58.2, R36.12). It is
   * the target each scheduled snapshot's encrypted package is copied to so a production-account loss cannot destroy
   * every recovery point. The value is a JSON object describing one destination: either `{ "kind": "r2", "label": … }`
   * naming a second configured R2 bucket binding ({@link RF_BACKUP_COPY_BUCKET}), or `{ "kind": "offline", "label": … }`
   * for an operator-run offline transfer. The `label` is a human-facing destination name; NO credential appears here.
   * Unset means no independent destination is configured, which blocks sole-copy custody (R36.12) and raises an alert.
   */
  BACKUP_COPY_DESTINATION?: string;
  /**
   * An independent R2 bucket binding, in a DIFFERENT account from the production `rf-private`, that the transfer
   * writes the encrypted package copy to (task 58.2, R36.12). Present only when the configured destination kind is
   * `r2`. The transfer copies the already-encrypted bytes unchanged (the 58.1 AEAD already protects them); it never
   * re-encrypts and never writes a plaintext key.
   */
  RF_BACKUP_COPY_BUCKET?: R2Bucket;
  /**
   * Whether the operator has approved an independent-backup storage BUDGET for the retained copies and transient
   * packages (task 58.2, R28.4, R28.8, R36.12). A truthy value (`"1"`/`"true"`) records operator consent to the
   * independent-copy spend; unset blocks sole-copy custody until a budget is approved. The budget figure itself lives
   * in the operator's growth/spend model (`GROWTH_PROFILE`); this flag is the recorded approval gate.
   */
  BACKUP_COPY_BUDGET_APPROVED?: string;
  /**
   * OPTIONAL longer RPO alert ages, in whole hours, for an installation whose independent copy is a manual offline
   * download (R36.7). Unset keeps the specification's 18-hour warning and 24-hour breach. Both must be set, positive,
   * and breach after warning, or the defaults apply.
   */
  BACKUP_RPO_WARN_HOURS?: string;
  BACKUP_RPO_BREACH_HOURS?: string;
  /**
   * Whether an INITIAL FRESH RESTORE rehearsal has completed successfully into an isolated environment (task 58.2,
   * R36.12, R36.17). Sole-copy research custody is refused until the operator records a completed initial restore. The
   * restore itself is task 38.5; this flag is the recorded prerequisite the custody gate checks. A truthy value
   * (`"1"`/`"true"`) means the initial restore was demonstrated.
   */
  BACKUP_INITIAL_RESTORE_DONE?: string;
}
