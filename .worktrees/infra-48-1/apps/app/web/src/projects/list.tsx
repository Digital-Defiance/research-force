import { useState } from 'react';
import type { DragEvent } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api';
import { useSession } from '../session';
import type { ProjectRecord } from '../types';
import { Button, levelName, LoadState, SaveFailure, useLoad } from '../ui';

/**
 * The Projects in the Project_Order, which an Administrator can change with Move buttons or by dragging; each move puts
 * one Project in its new position and keeps the others in order (R39.7).
 */
export function ProjectOrder({ projects, canEdit, onMoved }: { readonly projects: readonly ProjectRecord[]; readonly canEdit: boolean; readonly onMoved: () => void }) {
  const client = useApi();
  const [dragged, setDragged] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);
  const move = async (project: ProjectRecord, position: number) => {
    if (position < 0 || position >= projects.length || position === project.position) return;
    setFailure(undefined);
    try {
      await client.post(`/projects/${project.id}/move-position`, { position });
      onMoved();
    } catch (error) {
      setFailure(error);
    }
  };
  const drop = (event: DragEvent, position: number) => {
    event.preventDefault();
    const project = projects.find((entry) => entry.id === dragged);
    setDragged(null);
    if (project) void move(project, position);
  };
  return (
    <>
      <SaveFailure error={failure} />
      <ol className="rf-list" aria-label="Project order">
        {projects.map((project, index) => (
          <li key={project.id} className="rf-order-item" draggable={canEdit} aria-grabbed={canEdit ? dragged === project.id : undefined}
            onDragStart={(event) => { setDragged(project.id); event.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(event) => { if (dragged !== null) event.preventDefault(); }}
            onDrop={(event) => drop(event, index)}
            onDragEnd={() => setDragged(null)}>
            <div>
              <strong>{project.name}</strong>
              {project.featured && <span className="rf-status rf-status--info"> Featured</span>}
              {project.muted === true && <span className="rf-status"> Muted</span>}
              <p className="rf-meta">{`/${project.slug} · ${levelName(project.disclosureLevel)} · ${project.researchItems ?? 0} Research Items`}</p>
            </div>
            <div className="rf-actions">
              <Link to={`/projects/${project.id}/history`}>{`History of ${project.name}`}</Link>
              {canEdit && (
                <>
                  <Link className="rf-button" to={`/projects/${project.id}/edit`}>{`Edit ${project.name}`}</Link>
                  <Button variant="quiet" disabled={index === 0} onClick={() => void move(project, index - 1)}>{`Move ${project.name} up`}</Button>
                  <Button variant="quiet" disabled={index === projects.length - 1} onClick={() => void move(project, index + 1)}>{`Move ${project.name} down`}</Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

/** `/projects`. */
export function ProjectsPage() {
  const { can } = useSession();
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  if (!projects.data) return <LoadState error={projects.error} />;
  return (
    <div className="rf-stack">
      <h1>Projects</h1>
      {can('project.create') && <Link className="rf-button rf-button--primary" to="/projects/new">Create a Project</Link>}
      {projects.data.projects.length === 0
        ? <p className="rf-meta">No Project exists yet.</p>
        : <ProjectOrder projects={projects.data.projects} canEdit={can('project.edit')} onMoved={projects.reload} />}
    </div>
  );
}
