import { ApiFailure } from '../api';
import { SaveFailure } from '../ui';

/** A failed save, followed by each refusal the Workspace gave and the field it concerns, since these forms are built from rows rather than single fields. */
export function Failure({ error }: { readonly error: unknown }) {
  return (
    <>
      <SaveFailure error={error} />
      {error instanceof ApiFailure && error.fields.length > 0 && (
        <ul className="rf-list" aria-label="Refused because">{error.fields.map((issue, index) => <li key={index}>{`${issue.field}: ${issue.rule}`}</li>)}</ul>
      )}
    </>
  );
}
