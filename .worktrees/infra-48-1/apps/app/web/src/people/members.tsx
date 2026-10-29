import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiFailure, useApi } from '../api';
import { usePersistentForm } from '../persist';
import { useSession } from '../session';
import type { MemberRow, Role } from '../types';
import { Button, formatDate, LoadState, Notice, RestoredNotice, SaveFailure, SelectField, TextField, useLoad } from '../ui';

const STATUS_NAMES: Readonly<Record<string, string>> = { pending: 'Pending', active: 'Active', revoked: 'Revoked' };

/** Invite an address with the Role the Administrator selects (R2.1). */
function InviteForm({ roles, onDone }: { readonly roles: readonly Role[]; readonly onDone: () => void }) {
  const client = useApi();
  const form = usePersistentForm('members:invite', { email: '', roleId: '' });
  const [failure, setFailure] = useState<unknown>(undefined);
  const [invited, setInvited] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    setInvited(null);
    try {
      await client.post('/members/invite', form.values);
      setInvited(form.values.email);
      form.discard();
      onDone();
    } catch (error) {
      setFailure(error);
    }
  };
  const errors = (field: string) => (failure instanceof ApiFailure ? failure.issuesFor(field) : []);
  return (
    <form className="rf-stack" onSubmit={(event) => void submit(event)} noValidate aria-label="Invite a Member">
      <h2>Invite a Member</h2>
      {form.restored && <RestoredNotice onDiscard={form.discard} />}
      {invited !== null && <Notice tone="success" title={`An invitation to ${invited} is on its way.`} />}
      <SaveFailure error={failure} />
      <TextField label="Email address" type="email" required value={form.values.email} onChange={(email) => form.set('email', email)} errors={errors('email')} />
      <SelectField label="Role" required value={form.values.roleId} placeholder="Choose a Role" options={roles.map((role) => ({ value: role.id, label: role.name }))}
        onChange={(roleId) => form.set('roleId', roleId)} errors={errors('roleId')} />
      <Button type="submit" variant="primary">Send the invitation</Button>
    </form>
  );
}

/** One Member's Role change and revocation, for those whose Role permits them. */
function MemberActions({ member, roles, canRole, canRevoke, onDone }: {
  readonly member: MemberRow; readonly roles: readonly Role[]; readonly canRole: boolean; readonly canRevoke: boolean; readonly onDone: () => void;
}) {
  const client = useApi();
  const [roleId, setRoleId] = useState(member.roleId);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const run = async (action: () => Promise<unknown>) => {
    setFailure(undefined);
    try {
      await action();
      setConfirming(false);
      onDone();
    } catch (error) {
      setFailure(error);
    }
  };
  const name = member.displayName ?? member.email;
  return (
    <div className="rf-actions">
      <SaveFailure error={failure} />
      {canRole && member.status !== 'revoked' && (
        <>
          <SelectField label={`Role of ${name}`} value={roleId} options={roles.map((role) => ({ value: role.id, label: role.name }))} onChange={setRoleId}
            errors={failure instanceof ApiFailure ? failure.issuesFor('roleId') : []} />
          <Button disabled={roleId === member.roleId} onClick={() => void run(() => client.patch(`/members/${member.id}/role`, { roleId }))}>{`Change the Role of ${name}`}</Button>
        </>
      )}
      {canRevoke && member.status !== 'revoked' && (confirming
        ? (
          <>
            <span>{`Revoke ${name}’s access? Their records stay.`}</span>
            <Button variant="danger" onClick={() => void run(() => client.post(`/members/${member.id}/revoke`))}>{`Revoke ${name}`}</Button>
            <Button variant="quiet" onClick={() => setConfirming(false)}>Keep access</Button>
          </>
        )
        : <Button variant="danger" onClick={() => setConfirming(true)}>{`Revoke access for ${name}`}</Button>)}
    </div>
  );
}

/** `/members`: every Member, with invitations, Role changes, and revocations for Administrators (R2.1). */
export function MembersPage() {
  const { can } = useSession();
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const roles = useLoad<{ roles: Role[] }>('/roles');
  if (!members.data || !roles.data) return <LoadState error={members.error ?? roles.error} />;
  const roleName = new Map(roles.data.roles.map((role) => [role.id, role.name]));
  const reload = () => members.reload();
  const manage = can('member.role') || can('member.revoke');
  return (
    <div className="rf-stack">
      <h1>Members</h1>
      {can('member.invite') && <InviteForm roles={roles.data.roles} onDone={reload} />}
      <div className="rf-table-scroll">
        <table className="rf-table">
          <thead>
            <tr><th scope="col">Member</th><th scope="col">Role</th><th scope="col">Status</th>{manage && <th scope="col">Email</th>}{manage && <th scope="col">Actions</th>}</tr>
          </thead>
          <tbody>
            {members.data.members.map((member) => (
              <tr key={member.id}>
                <td>{member.displayName === null ? <span className="rf-meta">No Profile yet</span> : <Link to={`/members/${member.id}`}>{member.displayName}</Link>}</td>
                <td>{roleName.get(member.roleId) ?? member.roleId}</td>
                <td>
                  {STATUS_NAMES[member.status] ?? member.status}
                  {member.revokedAt !== null && <span className="rf-meta">{` since ${formatDate(member.revokedAt)}`}</span>}
                  {member.inviteEmailState === 'failed' && <span className="rf-meta"> (the invitation email could not be sent)</span>}
                </td>
                {manage && <td>{member.email}</td>}
                {manage && <td><MemberActions member={member} roles={roles.data!.roles} canRole={can('member.role')} canRevoke={can('member.revoke')} onDone={reload} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
