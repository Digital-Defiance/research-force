# Decision records

A Decision_Record starts as **proposed** and is changed by four operations. Each state change is saved as a Status_Change of the record, so it
appears in the record's history, notifies the Owner and the Thread, and keeps the revision rules of every other edit. Each also adds an event
to the decision's own timeline, which is never changed afterwards.

| Operation | Request | Who | Result |
| --- | --- | --- | --- |
| Adopt | `POST /api/v1/decisions/{id}/adopt` `{ "rev": 3 }` | The Owner or an editor | Proposed becomes adopted, with the effective date and the adopter. The record needs a non-blank rationale and an outcome. |
| Withdraw | `POST /api/v1/decisions/{id}/withdraw` `{ "rev": 3, "reason": "…" }` | The Owner or an editor | Proposed or adopted becomes withdrawn. The record stays. |
| Supersede | `POST /api/v1/decisions/{id}/supersede` `{ "rev": 3, "supersededId": "…", "supersededRev": 9 }` | An editor of both decisions | The proposed decision is adopted and replaces an adopted one of the same Project. The two link to each other and the earlier one becomes superseded, in one step. |
| Acknowledge | `POST /api/v1/decisions/{id}/acknowledge` `{ "response": "acknowledged" \| "disagreed", "digest", "wordingVersion", "expectedVersion", "comment"? }` | A named participant, for themselves only | The next version of the participant's own response to the wording named by `digest`. |

Superseded and withdrawn decisions are final. A stale `rev`, a decision that is no longer in the state the request needs, or a decision that moved
while the request ran is refused with `409`; a decision that cannot be adopted is refused with `422` naming the missing rationale or outcome.

Participants and responses are listed for a Team decision. A participant who has not answered is shown as `no_response`; a response to wording
that has since changed is `earlier_wording`. Neither counts as agreement.

## Reminders

An adopted decision with a revisit date is reminded once the date comes, and again every 7 days until it is superseded or withdrawn. The reminder
goes to the Owner, the Member who adopted it and the named participants, and is caused by no Member. Revisiting by condition alone never comes due
automatically. A Member who muted the Project is left out. Adoption, supersession and withdrawal notify the named participants.

## Public presentation

The public view of a decision (`publicDecision`) is an allowlist: question, context, rationale, alternatives, outcome, scope, state, adoption date
and revisit date. Participants, responses, comments, evidence details and who changed the state are never part of it.

## Export

`GET /api/v1/decisions/{id}/export` returns one `researchforce-decision` version 1 JSON document of what the Member can read: the wording, the
state and its timeline, each participant's own status, and the decisions it replaced or was replaced by. A decision the Member cannot read is `404`.
