# Derivation interchange

ResearchForce exports the artifact derivations a Member can read as one JSON document (R55.5). A derivation with an end the Member cannot read is
left out, and nothing says how many were left out.

## Request

`GET /api/v1/derivations/export?rootId=<record id>` returns the derivations whose output belongs to that record, including every earlier
version of an output that was corrected. A page holds at most 100 derivations. When more remain, the response carries `X-Next-After` with the id
to pass as `after`; its absence means the last page.

## `researchforce-derivations`, version 1

```json
{
  "format": "researchforce-derivations",
  "version": 1,
  "exportedAt": "2026-10-30T04:00:00.000Z",
  "graphEpoch": 12,
  "derivations": [
    {
      "id": "01J…", "kind": "transcription", "method": "Hand transcription", "methodVersion": null, "language": "de",
      "uncertainty": "The name is faded.", "reviewState": "disputed", "createdBy": "01J…", "createdAt": "…",
      "output": { "type": "attachment", "unitId": "01J…", "record": "RI-…", "title": "…", "sha256": "…64 hex digits…", "rev": null },
      "inputs": [ { "type": "attachment", "unitId": "01J…", "record": "RI-…", "title": "…", "sha256": "…", "rev": null } ],
      "text": "Lieber Karl, …",
      "correctsId": null, "correctedBy": "01J…",
      "reviews": [ { "reviewerId": "01J…", "reviewerName": "…", "state": "disputed", "note": "…", "reviewedAt": "…", "passages": [ { "start": 7, "end": 11, "note": "Karl or Carl" } ] } ]
    }
  ]
}
```

- Identities, content hashes, the stored text and uncertainty come through exactly as recorded; a passage's `start` and `end` are UTF-16 offsets
  into `text`.
- A derivation corrected later stays, with `correctedBy` naming the correction, its method and its reviews; the correction names `correctsId`.
- The document is strict: a reader refuses an unknown field or version (`parseDerivationExport`) and compares two exports with
  `comparableDerivations`, which ignores only `exportedAt`.
- Automatic OCR is not provisioned; every stored text was supplied by a Member.
- Backup, restore and public release of derivations follow their own gates in the recovery and publication phases.
