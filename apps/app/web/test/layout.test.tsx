import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { Breadcrumb, Card, PageHeader, PageLayout } from '../src/ui';

const inRouter = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('PageHeader', () => {
  it('renders the title as the single level-one heading (R6.4)', () => {
    inRouter(<PageHeader title="Review queue" />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Review queue');
  });

  it('is not exposed as a banner landmark, so the AppShell header stays the only banner', () => {
    const { container } = inRouter(<PageHeader title="Review queue" />);
    expect(screen.queryByRole('banner')).toBeNull();
    expect(container.querySelector('header.rf-page-header')).not.toBeNull();
  });

  it('renders an optional description paragraph (R6.1)', () => {
    inRouter(<PageHeader title="Review queue" description="Items waiting for your review." />);
    expect(screen.getByText('Items waiting for your review.').classList.contains('rf-page-header__description')).toBe(true);
  });

  it('renders a breadcrumb whose ancestors link to their routes and whose last crumb is the current, unlinked page (R6.3)', () => {
    inRouter(<PageHeader title="Project history" breadcrumb={[{ label: 'Projects', to: '/projects' }, { label: 'Alpha', to: '/projects/P1' }, { label: 'History' }]} />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Projects' }).getAttribute('href')).toBe('/projects');
    expect(within(nav).getByRole('link', { name: 'Alpha' }).getAttribute('href')).toBe('/projects/P1');
    expect(within(nav).queryByRole('link', { name: 'History' })).toBeNull();
    const current = within(nav).getByText('History');
    expect(current.getAttribute('aria-current')).toBe('page');
  });

  it('renders the actions cluster when actions are given (R6.1)', () => {
    inRouter(<PageHeader title="Members" actions={<button type="button">Invite</button>} />);
    const actions = screen.getByRole('button', { name: 'Invite' }).parentElement;
    expect(actions?.className).toBe('rf-actions');
  });
});

describe('Breadcrumb', () => {
  it('renders nothing for an empty trail', () => {
    const { container } = inRouter(<Breadcrumb trail={[]} />);
    expect(container.querySelector('nav')).toBeNull();
  });

  it('does not link a single current crumb', () => {
    inRouter(<Breadcrumb trail={[{ label: 'Here', to: '/here' }]} />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).queryByRole('link')).toBeNull();
    expect(within(nav).getByText('Here').getAttribute('aria-current')).toBe('page');
  });
});

describe('PageLayout', () => {
  it('leaves the default reading measure untouched for the reading variant (R6.5)', () => {
    const { container } = inRouter(<PageLayout><p>Body</p></PageLayout>);
    expect(container.querySelector('div')?.className).toBe('rf-layout');
  });

  it('emits the wide class for dense pages (R6.2)', () => {
    const { container } = inRouter(<PageLayout variant="wide"><p>Body</p></PageLayout>);
    expect(container.querySelector('div')?.className).toBe('rf-layout rf-layout--wide');
  });

  it('emits the split class for two-column pages (R6.2)', () => {
    const { container } = inRouter(<PageLayout variant="split"><p>Body</p></PageLayout>);
    expect(container.querySelector('div')?.className).toBe('rf-layout rf-layout--split');
  });
});

describe('Card', () => {
  it('renders a section grouping its children (R7.1)', () => {
    const { container } = inRouter(<Card><p>Grouped</p></Card>);
    const section = container.querySelector('.rf-card');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Grouped');
  });

  it('renders a plain heading when no headingHref is given (R7.1)', () => {
    inRouter(<Card heading="My drafts"><p>Body</p></Card>);
    const heading = screen.getByRole('heading', { name: 'My drafts' });
    expect(within(heading).queryByRole('link')).toBeNull();
  });

  it('links the heading via headingHref (R7.1)', () => {
    inRouter(<Card heading="My reviews" headingHref="/reviews"><p>Body</p></Card>);
    expect(screen.getByRole('link', { name: 'My reviews' }).getAttribute('href')).toBe('/reviews');
  });
});
