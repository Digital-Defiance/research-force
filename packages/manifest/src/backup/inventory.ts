import type { RootManifest } from './manifest';

/**
 * Schema/table INVENTORY REGISTRY and COMPATIBILITY TRANSFORMS (R36.16, R60.5).
 *
 * This module declares, explicitly, which authoritative tables and logical
 * fields an Internal_Backup covers at each released schema version, and the
 * transforms that let the CURRENT reader read a backup written at the current
 * and the TWO PRECEDING released schema versions (where those releases exist).
 *
 * The rule the design already enforces in `@researchforce/domain/compatibility`
 * (`backupReader`, `validateReleaseCatalog`) is mirrored here at the FORMAT
 * layer: a backup header carries `{ formatVersion, schemaRelease }`; a reader
 * selects a registered transform by that pair; an unknown or too-old pair is
 * rejected with a clear error. New schema versions ADD a transform; they never
 * rewrite the chain (R36.16: "retaining older readers ... before retiring
 * support").
 *
 * Pure: no database, no I/O. The restore service (task 58.4) supplies the live
 * release catalog; this layer only defines the inventory shape and the
 * transform-selection logic.
 */

/**
 * The covered authoritative tables and logical field owners at one released
 * schema version. The lists are explicit, not derived, so adding a table is a
 * reviewed registry change (R60.1: "No new table is implicitly safe"). The set
 * of logical field owners names the owner types whose field versions the
 * chunk-aware readers feed into the backup.
 */
export interface SchemaInventory {
  /** The released schema version identifier (matches the release catalog's `id`). */
  readonly schemaRelease: string;
  /** Every authoritative table backed up at this version (sorted, unique). */
  readonly tables: readonly string[];
  /** Every logical field owner type backed up at this version (sorted, unique). */
  readonly fieldOwners: readonly string[];
}

/**
 * A compatibility transform that upgrades a root manifest written at one schema
 * release to the shape the current reader expects. A transform is a pure
 * function over the manifest's logical structure; it never touches the package
 * body or key material. The IDENTITY transform (`from === to`) is the current
 * reader reading a current backup.
 */
export interface CompatibilityTransform {
  /** The schema release this transform reads a backup FROM. */
  readonly from: string;
  /** The schema release this transform produces a manifest FOR (the current reader's view). */
  readonly to: string;
  /** Human-facing note on what changed between `from` and `to`. */
  readonly note: string;
  /**
   * Upgrades a manifest from `from` to `to`. Pure and total for a well-formed
   * `from` manifest; a transform that cannot upgrade a manifest throws an Error
   * naming the reason, which the restore preflight reports (R36.8).
   */
  readonly upgrade: (manifest: RootManifest) => RootManifest;
}

/** The identity transform the current reader uses for a current-version backup. */
export function identityTransform(schemaRelease: string): CompatibilityTransform {
  return {
    from: schemaRelease,
    to: schemaRelease,
    note: 'current reader, no transform',
    upgrade: (manifest) => manifest,
  };
}

/**
 * The registry the current reader consults. `current` is the schema release the
 * current reader writes and reads natively; `supported` are the preceding
 * releases it still reads, newest first, via `transforms`. The restore service
 * builds this from the live release catalog so "current and two preceding
 * released schema versions" (R36.16) stays a single source of truth.
 */
export interface InventoryRegistry {
  /** The schema release the current reader writes (the `to` of every transform). */
  readonly current: string;
  /** The inventories, keyed by schema release, for every supported version. */
  readonly inventories: Readonly<Record<string, SchemaInventory>>;
  /** The transforms that upgrade a supported older release to `current`. */
  readonly transforms: readonly CompatibilityTransform[];
}

/** The maximum number of preceding released schema versions a reader supports (R36.16). */
export const MAX_PRECEDING_SCHEMAS = 2 as const;

/** A clear reason a backup's schema version cannot be read. */
export class UnsupportedSchemaError extends Error {
  constructor(
    readonly schemaRelease: string,
    readonly current: string,
    readonly supported: readonly string[],
  ) {
    super(
      `Backup schema version “${schemaRelease}” is not supported. The current reader “${current}” reads ${
        supported.length > 0 ? supported.map((s) => `“${s}”`).join(', ') : 'no preceding versions'
      }. Restore remains quarantined.`,
    );
    this.name = 'UnsupportedSchemaError';
  }
}

/**
 * Builds a registry from the current release and an ordered list of preceding
 * releases (newest first). At most {@link MAX_PRECEDING_SCHEMAS} preceding
 * releases are retained (R36.16); extra entries are a configuration error so
 * the support window never silently widens.
 *
 * Each preceding release must supply its inventory and the transform that
 * upgrades it to `current`. The current release supplies its own inventory and
 * gets an identity transform automatically.
 */
export function buildRegistry(input: {
  readonly current: SchemaInventory;
  readonly preceding: readonly { readonly inventory: SchemaInventory; readonly transform: CompatibilityTransform }[];
}): InventoryRegistry {
  if (input.preceding.length > MAX_PRECEDING_SCHEMAS) {
    throw new RangeError(`A reader supports at most ${MAX_PRECEDING_SCHEMAS} preceding schema versions (R36.16).`);
  }
  const inventories: Record<string, SchemaInventory> = { [input.current.schemaRelease]: input.current };
  const transforms: CompatibilityTransform[] = [identityTransform(input.current.schemaRelease)];
  for (const entry of input.preceding) {
    if (entry.transform.to !== input.current.schemaRelease) {
      throw new Error(`Transform for “${entry.inventory.schemaRelease}” must target the current release “${input.current.schemaRelease}”.`);
    }
    if (entry.transform.from !== entry.inventory.schemaRelease) {
      throw new Error(`Transform source “${entry.transform.from}” does not match its inventory “${entry.inventory.schemaRelease}”.`);
    }
    if (inventories[entry.inventory.schemaRelease]) {
      throw new Error(`Duplicate schema inventory “${entry.inventory.schemaRelease}”.`);
    }
    inventories[entry.inventory.schemaRelease] = entry.inventory;
    transforms.push(entry.transform);
  }
  return { current: input.current.schemaRelease, inventories, transforms };
}

/** The schema releases this registry supports, newest (current) first. */
export function supportedReleases(registry: InventoryRegistry): string[] {
  return registry.transforms.map((t) => t.from);
}

/**
 * Selects the transform for a backup's schema release, or throws
 * {@link UnsupportedSchemaError} when the version is unknown or too old
 * (R36.8, R36.16). This mirrors `@researchforce/domain` `backupReader` at the
 * format layer: resolution is explicit and a miss fails loudly, never silently
 * reads a mismatched schema.
 */
export function selectTransform(registry: InventoryRegistry, schemaRelease: string): CompatibilityTransform {
  const transform = registry.transforms.find((t) => t.from === schemaRelease);
  if (!transform) {
    throw new UnsupportedSchemaError(schemaRelease, registry.current, supportedReleases(registry));
  }
  return transform;
}

/**
 * Reads a root manifest through the registry: validates the schema version is
 * supported, then upgrades it to the current reader's view (R36.16). The caller
 * (restore preflight) separately validates manifest structure and authenticates
 * the body; this returns the upgraded manifest or throws a clear error.
 */
export function upgradeManifest(registry: InventoryRegistry, manifest: RootManifest): RootManifest {
  const transform = selectTransform(registry, manifest.schemaRelease);
  return transform.upgrade(manifest);
}
