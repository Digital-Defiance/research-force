import { asTimestamp } from '@researchforce/domain/types';
import { newULID } from '@researchforce/domain/identifiers';
import { logicalIndexParts } from '@researchforce/domain/logical-search';
import { fieldFragments, fieldManifest, fragmentDigest, readField } from '@researchforce/domain/text-fragments';
import type { FieldFragment, FieldManifest, FieldReference, FieldVersionReader } from '@researchforce/domain/text-fragments';
import type { RichText } from '@researchforce/domain/richtext';
import { DEFAULT_RESOURCE_PROFILE, encodedJsonBytes } from '@researchforce/domain/resource-profile';
import type { SearchDoc } from './documents';

export function needsLogicalSearch(doc: SearchDoc): boolean {
  return encodedJsonBytes({ text: doc.body, spans: doc.spans }, DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment) > DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment;
}
export async function prepareLogicalDocument(db: D1Database, key: number, doc: SearchDoc): Promise<string> {
  const id = newULID(asTimestamp(new Date().toISOString())); const rich: RichText = { text: doc.body, spans: doc.spans as RichText['spans'] };
  const manifest = fieldManifest(rich); const digest = fragmentDigest(manifest);
  await db.prepare('INSERT INTO logical_search_versions(id,doc_key,manifest_json,sha256) VALUES(?,?,?,?)').bind(id, key, JSON.stringify(manifest), digest).run();
  let statements: D1PreparedStatement[] = [];
  const flush = async (): Promise<void> => { if (statements.length) { await db.batch(statements); statements = []; } };
  for (const piece of fieldFragments(rich)) {
    statements.push(db.prepare('INSERT INTO logical_search_bodies(version_id,kind,ordinal,payload_json,sha256) VALUES(?,?,?,?,?)').bind(id, piece.kind, piece.ordinal, JSON.stringify(piece), fragmentDigest(piece)));
    if (statements.length === 40) await flush();
  }
  for (const part of logicalIndexParts([doc.body])) {
    statements.push(db.prepare('INSERT INTO logical_search_parts(version_id,ordinal,start_utf16,end_utf16,body) VALUES(?,?,?,?,?)').bind(id, part.ordinal, part.start, part.end, part.body));
    if (statements.length === 40) await flush();
  }
  await flush();
  await db.prepare('UPDATE logical_search_versions SET sealed=1 WHERE id=?').bind(id).run();
  return id;
}
/** The query layer has already checked Can_Read on this document's root. */
export async function readLogicalDocument(db: D1Database, key: number): Promise<RichText | null> {
  const head = await db.prepare('SELECT v.id,v.manifest_json AS manifest,v.sha256 AS digest FROM logical_search_heads h JOIN logical_search_versions v ON v.id=h.version_id AND v.sealed=1 WHERE h.doc_key=?')
    .bind(key).first<{ id: string; manifest: string; digest: string }>();
  if (!head) return null;
  const manifest = JSON.parse(head.manifest) as FieldManifest;
  const reference: FieldReference = { $fieldVersion: 1, id: head.id, ownerType: 'search', ownerId: String(key), field: 'body', digest: head.digest };
  const reader: FieldVersionReader = { manifest: async () => manifest, fragments: async function* () {
    for (let offset = 0; offset < manifest.fragments.length; offset += 40) {
      const descriptors = manifest.fragments.slice(offset, offset + 40);
      const results = await db.batch<{ payload: string }>(descriptors.map((p) => db.prepare('SELECT payload_json AS payload FROM logical_search_bodies WHERE version_id=? AND kind=? AND ordinal=?').bind(head.id, p.kind, p.ordinal)));
      for (const result of results) { if (!result.results[0]) throw new Error('Incomplete logical search document.'); yield JSON.parse(result.results[0].payload) as FieldFragment; }
    }
  } };
  return readField(reference, reader);
}
