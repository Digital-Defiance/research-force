# Citation interchange

ResearchForce exports the Evidence Citations a Member can read in two formats (R54.6). Both leave out any citation with an end the Member
cannot read, and say nothing about how many were left out.

## Request

`GET /api/v1/citations/export` takes one of `projectId` (citations made from records of that Project) or `citingRootId` (one record), and:

| Parameter | Meaning |
|---|---|
| `format` | `json` (default) or `csl-json`. |
| `after` | A citation id; the page starts after it. |

A page holds at most 100 citations. When more remain, the response carries `X-Next-After` with the id to pass as `after`; its absence means
the last page. A CSL-JSON page holds the cited records of that page's citations, so a record cited on two pages appears on both.

## `researchforce-citations`, version 1 (JSON)

```json
{
  "format": "researchforce-citations",
  "version": 1,
  "exportedAt": "2026-10-30T04:00:00.000Z",
  "citations": [
    {
      "id": "01J…",
      "citingRecord": "RI-…", "citingTitle": "…", "citingField": "claim",
      "target": { "type": "source", "unitId": "01J…", "record": "RI-…", "title": "…" },
      "role": "supports",
      "locator": { "type": "folio", "from": { "number": 4, "side": "v" }, "to": { "number": 5 } },
      "locatorLabel": "fol. 4v–5",
      "contentHash": "…64 hex digits…",
      "state": "current",
      "createdAt": "…",
      "csl": { "id": "RI-…", "label": "folio", "locator": "4v-5" }
    }
  ],
  "sources": [ /* CSL-JSON items for the cited records */ ]
}
```

* `target.type` is `source`, `attachment` or `text` (with `target.field`). `contentHash` is the hash of what was cited, so a later change to
  the target never silently re-aims the citation; `state` is `earlier_version` once it has changed, with `earlierVersionAt`.
* `locator.type` is one of `page`, `folio`, `section`, `text_range` (UTF-16 offsets into the cited text), `image_region` (coordinates between
  0 and 1) or `unresolved` (words only, never turned into a position). Identifiers and locators are exported as stored, so a restore or another
  tool reads back exactly what was cited.
* `retiredAt` and `replacedBy` appear on citations that were removed or replaced. They are exported only when the listing asks for them.
* `csl` gives the CSL citation-item fields (`id`, `label`, `locator`) for page, folio and section locators. Other locator types have only `id`.

## CSL-JSON

The array of items follows Citation Style Language 1.0.2. Every cited record becomes one item of type `document`:

| ResearchForce | CSL variable |
|---|---|
| Item identifier | `id` |
| Title | `title` |
| Creator roles author, editor, translator, addressee | `author`, `editor`, `translator`, `recipient` |
| Other creator roles (compiler, photographer, issuer, other) | `note`, one `Role: Name` line each |
| Publication date, else the Source's document date | `issued` as `date-parts` at the entered precision, with `circa` when approximate |
| Access date | `accessed` |
| Archive or collection, archival reference | `archive`, `archive_location` |
| Edition, language | `edition`, `language` |
| Identifiers DOI, ISBN, ISSN (first of each) | `DOI`, `ISBN`, `ISSN` |
| Other identifiers (ark, handle, oclc, other) and repeats | `note`, one `SCHEME: value` line each |
| External address | `URL` |

Spelling is kept exactly as entered. Nothing is invented: a record without a bibliography exports its identifier and title only.

## Curation of unresolved references

* `GET /api/v1/citations?projectId=…&unresolved=1` lists citations whose locator is words only. Replace one with `PUT /citations/:id` and a
  typed locator.
* `GET /api/v1/citations/references/:recordId` lists labels (Quote, Paraphrase, Source-reported) that name a source only in words. They stay
  as written until a Member edits the label to name a citation.
* `GET /api/v1/citations/warnings/:recordId` lists what a publication preview should warn about: unresolved locators, citations to an earlier
  version, and cited records whose rights status does not permit publication. A citation is not permission.
