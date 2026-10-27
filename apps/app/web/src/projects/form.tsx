import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { PROJECT_ACCENTS } from '@researchforce/design/tokens';
import { RESERVED_PROJECT_SLUGS } from '@researchforce/domain/schemas/people';
import { ApiFailure, useApi } from '../api';
import { usePersistentForm } from '../persist';
import type { ProjectRecord } from '../types';
import { Button, CheckboxField, LoadState, Notice, RestoredNotice, SaveFailure, TextField, useLoad } from '../ui';

interface ProjectValues {
  readonly name: string;
  readonly description: string;
  readonly slug: string;
  readonly featured: boolean;
  readonly accent: string | null;
}

export const RESERVED_SLUG_HINT = `Lowercase letters, digits, and hyphens, up to 40 characters, starting with a letter or digit. Reserved names: ${RESERVED_PROJECT_SLUGS.join(', ')}.`;

/** The Project_Accent choices: only the Design_System palette, or none (R45.4). */
function AccentPicker({ value, onChange, errors }: { readonly value: string | null; readonly onChange: (value: string | null) => void; readonly errors: readonly { rule: string }[] }) {
  const choices = [{ id: null, name: 'No accent', light: undefined, dark: undefined }, ...PROJECT_ACCENTS];
  return (
    <fieldset className={errors.length > 0 ? 'rf-field rf-field--invalid' : 'rf-field'}>
      <legend className="rf-field__label">Accent colour</legend>
      {errors.length > 0 && <p className="rf-field__error">{errors.map((issue) => issue.rule).join(' ')}</p>}
      {choices.map((accent) => {
        const id = `accent-${accent.id ?? 'none'}`;
        return (
          <div className="rf-field rf-field--checkbox" key={id}>
            <input className="rf-checkbox" type="radio" name="accent" id={id} checked={value === accent.id} onChange={() => onChange(accent.id)} />
            <label className="rf-field__label" htmlFor={id}>
              {accent.light !== undefined && <span className="rf-accent-swatch" aria-hidden="true" style={{ background: accent.light }} />}
              {accent.name}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

/** Create or edit a Project, with the reserved slug names listed and the slug fixed once it has appeared publicly (R39.4, R39.5, R39.7). */
export function ProjectForm({ project }: { readonly project?: ProjectRecord }) {
  const client = useApi();
  const navigate = useNavigate();
  const form = usePersistentForm<ProjectValues>(project === undefined ? 'project:new' : `project:${project.id}:edit`, () => ({
    name: project?.name ?? '', description: project?.description ?? '', slug: project?.slug ?? '', featured: project?.featured ?? false, accent: project?.accent ?? null,
  }));
  const [failure, setFailure] = useState<unknown>(undefined);
  const { values } = form;
  const errors = (field: string) => (failure instanceof ApiFailure ? failure.issuesFor(field) : []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    try {
      if (project === undefined) {
        await client.post('/projects', { name: values.name, description: values.description, slug: values.slug });
      } else {
        const changes: Record<string, unknown> = { rev: project.rev };
        if (values.name !== project.name) changes['name'] = values.name;
        if (values.description !== (project.description ?? '')) changes['description'] = values.description;
        if (values.slug !== project.slug) changes['slug'] = values.slug;
        if (values.featured !== project.featured) changes['featured'] = values.featured;
        if (values.accent !== project.accent) changes['accent'] = values.accent;
        await client.patch(`/projects/${project.id}`, changes);
      }
      form.sent();
      void navigate('/projects');
    } catch (error) {
      setFailure(error);
    }
  };
  return (
    <form className="rf-stack" onSubmit={(event) => void submit(event)} noValidate>
      <h1>{project === undefined ? 'Create a Project' : `Edit ${project.name}`}</h1>
      {form.restored && <RestoredNotice onDiscard={form.discard} />}
      {failure instanceof ApiFailure && failure.code === 'conflict'
        ? <Notice tone="warning" title="Someone saved a change to this Project after you opened it. Your input was not saved; it is kept below." />
        : <SaveFailure error={failure} />}
      <TextField label="Name" required value={values.name} onChange={(name) => form.set('name', name)} maxLength={100} errors={errors('name')} hint="Up to 100 characters, different from every other Project’s name." />
      <TextField label="Short description" required multiline value={values.description} onChange={(description) => form.set('description', description)} maxLength={500} errors={errors('description')} hint="Up to 500 characters." />
      {project?.slugFixed === true ? (
        <div className="rf-field">
          <p className="rf-field__label">Project Slug</p>
          <p><code>{project.slug}</code> <span className="rf-status">Fixed</span></p>
          <p className="rf-field__hint">The slug is fixed because the Project has appeared on the Public Site.</p>
        </div>
      ) : (
        <TextField label="Project Slug" required value={values.slug} onChange={(slug) => form.set('slug', slug)} maxLength={40} errors={errors('slug')} hint={RESERVED_SLUG_HINT} />
      )}
      {project !== undefined && (
        <>
          <CheckboxField label="Featured" checked={values.featured} onChange={(featured) => form.set('featured', featured)} errors={errors('featured')} hint="Any number of Projects can be featured." />
          <AccentPicker value={values.accent} onChange={(accent) => form.set('accent', accent)} errors={errors('accent')} />
        </>
      )}
      <div className="rf-actions">
        <Button type="submit" variant="primary">{project === undefined ? 'Create the Project' : 'Save the Project'}</Button>
        <Button variant="quiet" onClick={() => { form.discard(); void navigate('/projects'); }}>Discard</Button>
      </div>
    </form>
  );
}

export function EditProjectPage({ id }: { readonly id: string }) {
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  if (!projects.data) return <LoadState error={projects.error} />;
  const project = projects.data.projects.find((entry) => entry.id === id);
  return project === undefined ? <Notice tone="warning" title="This Project does not exist." /> : <ProjectForm key={project.rev} project={project} />;
}
