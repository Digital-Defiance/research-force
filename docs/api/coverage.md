# Search scopes, coverage and independent reproduction

These routes describe what a Run's search covered and let other Members reproduce it (R56.3, R56.4, R56.5). Nothing is executed. Every route needs a signed-in Member and reads only what that Member can read.

## Scope schemas

A Project defines schemas for what a search covers. A schema has one to four named dimensions. A dimension is either an integer range (`kind: "integer"`, `min` and `max` as whole numbers written as strings of up to 80 digits, so that nothing is rounded) or a set (`kind: "set"`, with its `members` listed). A schema version never changes; a revised description is the next version of the same name.

- `GET /projects/:id/scope-schemas` lists every version.
- `POST /projects/:id/scope-schemas` defines the next version. It needs the Project edit permission. Send `expectedVersion` (the highest version of that name now, or 0); a stale value is a 409. Negative numbers, decimals, leading zeros, an inverted range (`min` above `max`), repeated names and more than four dimensions are refused with a 422.

## Scopes

A scope belongs to one Run and one exact package version. The Run's newest scope is its current one; earlier scopes stay readable.

- `POST /runs/:id/scope` records a scope as an edit of the Run, so it needs `rev` (a stale one is a 409) and the Run edit permission. Send `packageVersion`, `assumptions` (up to 20), and either:
  - `schema: { id, version }` with `entries`: up to 100 of `{ state, region }`, where `state` is `attempted`, `completed`, `excluded` or `unknown` and `region` names every dimension (a range list `[{ "from": "0", "to": "99" }]` or a list of set members). Leaving a dimension out is refused; to mean all of it, give its whole range. An inverted or out-of-schema range is a 422.
  - or `text`, a generic description. It is valid but labelled "not machine-comparable" and never counts toward elimination.
- `GET /runs/:id/scope` returns `{ current, history }`. `GET /scopes/:id` returns one scope.

A scope view carries exact counts per state (as strings), the size of the whole space, the package manifest hash it was recorded against, and `elimination: { counts, reasons }`.

## When completed work counts

A scope's completed regions count toward elimination only when all hold: the Run's outcome is Complete or Clean negative; its package version is not incomplete and not disputed; it has at least one output; and every output and checkpoint is an archive-held Attachment whose current hash is the one recorded. Otherwise `reasons` says why (`run_not_finished`, `package_incomplete`, `package_disputed`, `outputs_unverified`). Partial, Suspended, Stopped and In progress Runs never count.

## Coverage and comparison

- `GET /projects/:id/coverage?schemaId&version` joins the counted completed work of the Runs the Member can read, exactly. The result has `universe`, `eliminated`, the described `boxes`, `fullElimination` (true only when everything is covered and the list was not truncated), each Run's `contributions`, and `incomparable` Runs (generic text, or another schema), which are listed and never combined. The list covers the newest 200 scopes; `truncated` says when there were more.
- `GET /projects/:id/coverage/compare?a&b` takes two scope ids. Scopes of different schemas, or generic texts, answer `{ comparable: false, reason }` with no numbers. Otherwise the answer has the overlap and the union of what each counted. A comparison too fragmented to compute exactly is a 422, never a guess.

## Independent reproduction

- `POST /runs/:id/reproductions` records an attempt: `packageVersion`, `attemptRunId` (your own, different Run), `outcome` (`reproduced`, `not_reproduced` or `inconclusive`), up to 50 `differences` (`{ kind, name, original, attempt }`), up to 20 `evidence` record ids you can read, and a `note`. The package's author and the Run's Owner cannot record one. A Run can be the attempt for one package only.
- `GET /runs/:id/reproductions` lists the attempts whose Runs the Member can read.

An attempt never changes the first Run, its package or its outcome. A package's state follows the latest attempt of each attempter: Disputed while any attempter's latest attempt did not reproduce it, Reproduced when one did, otherwise Specified (Incomplete while an ingredient is missing). A Member's newer attempt supersedes only their own earlier one. An attempt whose Run the viewer cannot read is hidden from the list but still counts toward the state. Deleting an attempt's Run removes the attempt and works the state out again.
