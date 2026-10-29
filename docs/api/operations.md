# Operation keys and uncertain results

Every mutating `/api/v1` route (`POST`, `PUT`, `PATCH`, `DELETE`) accepts an `Idempotency-Key` header of 16 to 64 letters, digits, hyphens or underscores. The browser client always sends one, stores it in the tab's session storage before sending, and forgets it once the answer is definite.

## What the Worker records

Table `idempotency_results` (core migration `0011_operation_keys.sql`) holds one row per Member and key: the SHA-256 digest of the method, path, query and body bytes; the route; the state; the HTTP status; the error code of a refusal; and the IDs the response named (at most eight, one level deep, such as `item.id`). It never holds a request or response body, so a row reveals nothing that was later removed.

The row is inserted as `pending` before the handler runs. Every `GuardedBatch` committed during the request ends with a statement that flips the row to `committed`, so the domain change and its record are one transaction. A request answered with 4xx becomes `refused` with its status and code. A request that ends with 5xx or is cut off stays `pending`.

## Replay and conflict

* The same Member, key and request digest after `committed` or `refused` returns the recorded status with `{"replayed": true, "operation": ...}` and the header `Idempotency-Replayed: true`. The handler does not run again.
* The same key with a different request is `409 conflict` (`operation_key_reused`).
* The same key while the first request is still pending is `409 conflict` (`operation_pending`). A request pending for more than two minutes may be claimed by the same request, since it never committed.
* Keys belong to the Member: another Member's key is unused, and its status is `404`.

## Reconciling a lost response

`GET /operations/{key}` returns `{operation: {state, status?, error?, resource?}}` for the caller's own key:

| State | Meaning | Client action |
|---|---|---|
| (404) | The Worker never started the write | Send the same request with the same key |
| `pending` | The write is still running | Poll briefly |
| `committed` | The write is saved | Read the result again through the ordinary route using `resource` |
| `refused` | The write was definitely refused | Show the refusal; the saved data is unchanged |
| `unknown` | Pending for over two minutes | Keep the input and say the outcome is not confirmed |

## External effects

`external_operations` records one row per attempt to reach a provider, named by the queued item and attempt number, with no recipient or text. For mail, `accepted` means Microsoft Graph accepted `sendMail`; it is not delivery. `uncertain` means `sendMail` was requested and no answer arrived, so the message may still be delivered and a retry may send a duplicate. `failed` records a refusal or a missing provider. Graph's `sendMail` returns no operation ID, so there is nothing to reconcile against; `confirmed` is reserved for providers that report one.
