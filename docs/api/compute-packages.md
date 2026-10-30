# Compute packages

A Compute_Package describes how a Run was made, exactly enough for a colleague to repeat it (R56.1). It is only a description. Nothing in it is
ever executed, and no address in it is visited by the server (R56.6). Each package is a series of versions; a version is never changed, and the
next description is the next version. Recording a version is an ordinary edit of the Run: it needs the Permission to edit the Run, checks the Run's
revision, and appears in the Run's history.

## Requests

| Request | Result |
| --- | --- |
| `GET /api/v1/runs/{id}/package?version=` | The newest version, or the one named, as the Member may see it. |
| `POST /api/v1/runs/{id}/package` | Records the next version. The body is the description plus `rev` (the Run revision it started from) and `expectedVersion` (the package version it follows, 0 for the first). A stale `rev` or `expectedVersion` is `409`; a description identical to the newest version is `422`. |
| `POST /api/v1/runs/{id}/package/validate` | The same checks and refusals, nothing written. Returns the manifest hash, the state and the missing ingredients. |
| `GET /api/v1/runs/{id}/package/export?version=` | One `researchforce-compute-package` version 1 JSON document. |

## The description

```json
{
  "rev": 7, "expectedVersion": 0,
  "code": { "repository": "https://example.org/synthetic/sieve.git", "commit": "<40 or 64 lowercase hex digits>", "release": "v2" },
  "command": "./sieve --range 0:99", "entrypoint": "main", "methodVersion": "2", "usesRandomness": true,
  "configuration": { "batch": 64, "epsilon": "0.1000" },
  "environment": [ { "kind": "toolchain|hardware|os|dependency|seed", "name": "rustc", "value": "1.86.0" } ],
  "artifacts": [
    { "type": "attachment", "role": "input", "unitId": "01J…", "sha256": "optional; must match the archive" },
    { "type": "external", "role": "output", "uri": "https://example.org/out.tar", "name": "out", "sha256": "…", "sizeBytes": 123 }
  ]
}
```

Every value is stored as given. A JSON number in the configuration is accepted only as an integer up to 9007199254740991, because a decimal or a
larger integer would already have been rounded on its way in: write seeds and decimals as text. Numbers in the other fields are exact.

Bounds: 1,000 artifacts, 200 environment entries, a configuration of 262,144 bytes (nested up to 8 levels, 5,000 entries), a command of 2,000
characters, a repository of 500, a release of 200, a method version of 100, an address of 2,000. The configuration is stored in pieces of at most
20,000 characters, so no row is larger than a fragment.

## Held and unverified

An artifact that is an **Attachment** is held by the archive with its SHA-256, which the package records. It reads as held and verified while the
archive still has that hash. An **external** reference is only a name: it is never held and never verified, whatever hash was declared for it. The
server does not fetch it. Both are listed, and the counts of held-and-verified and of unverified artifacts are given.

## Missing ingredients and state

A package lists each ingredient it lacks by name, never inferred from a tool version string: the code repository with an exact commit or release;
a command or entrypoint; at least one input; at least one output; a toolchain; hardware; a method version; and the random seeds when randomness is
used. With any missing, the state is **Incomplete**; with none, **Specified**. **Reproduced** and **Disputed** follow independent reproduction
attempts (recorded separately); a package that is missing an ingredient is never better than Incomplete.

## Secrets and access

Secrets stay outside packages. A configuration key that names one (password, secret, API key, private key, access token and the like), a value
that looks like a private key or a well-known token, and an address that carries a password or a credential in its query are refused. This is a
guard, not a promise to find every secret.

Reading a package needs Can_Read on the Run. An Attachment the Member cannot read is left out of the list, the manifest and the export, with no
count or trace; `hashVerifiable` is then false, because the hash covers the whole description. An Attachment must be readable by whoever names it,
and is checked again as the version is written. Deleting a Run deletes its package versions.

## Export

`researchforce-compute-package` version 1 holds the Run, the package version, the manifest hash, the state, the missing ingredients and the
manifest. The manifest recomputes to the manifest hash when `hashVerifiable` is true, and posting it, with a `rev` and `expectedVersion`, records
the same package on another Run with the same hash. Unknown fields in a document are refused.
