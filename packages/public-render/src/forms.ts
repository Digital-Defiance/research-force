import { FORM_FOOTER_LINK, button, formField, type FieldOption } from '@researchforce/design/components/index';
import { SITE_PATHS } from '@researchforce/design/fixed-texts';
import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';
import { ITEM_KINDS, type OutsideSubmissionType } from '@researchforce/domain/types';
import type { ProjectView } from '@researchforce/kernel/views';
import { KIND_NAMES } from './format';
import type { PageSpec } from './frame';
import { PAGE_PATHS, projectPaths } from './paths';
import type { SiteInput } from './site';

const TYPE_OPTIONS: readonly { readonly value: OutsideSubmissionType; readonly label: string }[] = [
  { value: 'material', label: 'Material' }, { value: 'correction', label: 'Correction' }, { value: 'comment', label: 'Comment' }, { value: 'removal_request', label: 'Removal request' },
];
export const GENERAL_CHOICE = 'general';
export const GENERAL_LABEL = 'General (not about one project)';
export const projectChoice = (slug: string): string => `project:${slug}`;

/** What a form page preselects: the Submission_Type and the Project or General_Choice (R31.13, R46.18, R46.21). */
export interface FormPreselection { readonly type?: OutsideSubmissionType; readonly destination?: string }

const choose = (label: string): FieldOption => ({ value: '', label });

/** The Outside_Submission_Form with every field of R31.1; the licence agreement is never preselected. */
function submissionForm(site: SiteInput, projects: readonly ProjectView[], page: FormPage): ElementNode {
  const { preselect } = page;
  const options = (values: readonly FieldOption[], selected: string | undefined, prompt: string): FieldOption[] =>
    [{ ...choose(prompt), selected: selected === undefined }, ...values.map((option) => ({ ...option, selected: option.value === selected }))];
  return element('form', {
    class: 'rf-form', method: 'post', action: PAGE_PATHS.submit, enctype: 'multipart/form-data', 'data-submit-form': true,
    'data-submit-type': preselect.type, 'data-submit-project': page.project === undefined ? undefined : unitId(page.project),
    'data-submit-general': page.project === undefined && preselect.destination === GENERAL_CHOICE ? 'true' : undefined,
    'data-content-licence': site.licence.name, 'data-submit-form-key': formKey(page.path), ...formsAttributes(site),
  }, [
    element('p', { class: 'rf-form__status', 'data-submit-status': true, 'aria-live': 'polite' }, []),
    formField({ id: 'type', label: 'Type of submission', control: 'select', required: true, options: options(TYPE_OPTIONS, preselect.type, 'Choose a type') }),
    formField({
      id: 'destination', label: 'What it concerns', control: 'select', required: true,
      options: options([...projects.map((project) => ({ value: projectChoice(project.slug), label: project.name, attributes: { 'data-project-id': unitId(project) } })), { value: GENERAL_CHOICE, label: GENERAL_LABEL }], preselect.destination, 'Choose a project or general'),
    }),
    formField({ id: 'message', label: 'Message', control: 'textarea', required: true, attributes: { maxlength: 10_000 } }),
    formField({ id: 'name', label: 'Your name', required: true, attributes: { maxlength: 200, autocomplete: 'name' } }),
    formField({ id: 'email', label: 'Your email address', control: 'email', required: true, hint: 'Used only to reply to you; it is never published.', attributes: { maxlength: 254, autocomplete: 'email' } }),
    formField({ id: 'affiliation', label: 'Affiliation', hint: 'Optional.', attributes: { maxlength: 200 } }),
    formField({ id: 'pageReference', label: 'Page this concerns', hint: 'Optional: the address of a page on this site.', attributes: { maxlength: 2000 } }),
    filesField(),
    element('ul', { class: 'rf-file-list', 'data-file-list': true }, []),
    formField({
      id: 'licenceAgreement', label: `I agree that my own work in this submission may be published under the ${site.licence.name} and credited to the name and any affiliation I give.`,
      control: 'checkbox', value: 'agreed', hint: 'Needed for every type except a removal request.',
    }),
    botCheck(),
    button({ label: 'Send', variant: 'primary', type: 'submit' }),
  ]);
}

/** The Project's id, from its view key `p:<id>`; the Outside_Submission API validates the destination against it. */
const unitId = (project: ProjectView): string => project.key.replace(/^p:/u, '');
/** The kept-input key of a form page, from its address (`/submit` is `submit`). */
const formKey = (path: string): string => path.replace(/^\//u, '').replace(/\//gu, '-');
/** The installation's Turnstile site key and origins as the attributes the form scripts read; none when not configured. */
const formsAttributes = (site: SiteInput): Record<string, string> => site.forms === undefined ? {} : {
  'data-turnstile-sitekey': site.forms.siteKey, 'data-submit-origin': site.forms.submitOrigin, 'data-status-url': `${site.forms.filesOrigin}/status.json`,
};
function filesField(): ElementNode {
  return element('div', { class: 'rf-field' }, [
    element('label', { class: 'rf-field__label', for: 'files' }, [text('Files')]),
    element('p', { class: 'rf-field__hint', id: 'files-hint' }, [text('Optional.')]),
    element('input', { class: 'rf-input', id: 'files', name: 'files', type: 'file', multiple: true, 'aria-describedby': 'files-hint' }, []),
  ]);
}

/** The Bot_Check mounts here from the form script; without scripts the form says why it cannot be sent (R31.3). */
const botCheck = (): ElementNode => element('div', { class: 'rf-bot-check', 'data-turnstile': true }, [
  element('noscript', {}, [element('p', {}, [text('This form needs JavaScript to check that it is sent by a person.')])]),
]);

export interface FormPage { readonly path: string; readonly title: string; readonly preselect: FormPreselection; readonly project?: ProjectView }

/** The form pages and what each preselects: none from other pages, the General_Choice from Policy_Pages, a Project from its section. */
export function formPages(projects: readonly ProjectView[]): FormPage[] {
  return [
    { path: SITE_PATHS.submit, title: FORM_FOOTER_LINK, preselect: {} },
    { path: PAGE_PATHS.submitGeneral, title: FORM_FOOTER_LINK, preselect: { destination: GENERAL_CHOICE } },
    { path: SITE_PATHS.submitCorrection, title: 'Ask for a correction', preselect: { type: 'correction', destination: GENERAL_CHOICE } },
    { path: SITE_PATHS.submitRemoval, title: 'Ask for a removal', preselect: { type: 'removal_request' } },
    { path: SITE_PATHS.submitRemovalGeneral, title: 'Ask for a removal or about personal data', preselect: { type: 'removal_request', destination: GENERAL_CHOICE } },
    ...projects.map((project) => ({ path: projectPaths(project.slug).submit, title: FORM_FOOTER_LINK, preselect: { destination: projectChoice(project.slug) }, project })),
  ];
}

export function formPage(site: SiteInput, projects: readonly ProjectView[], page: FormPage, formScript: string): PageSpec {
  const body: ViewNode[] = [
    element('p', {}, [text(`Use this form to send ${site.publicCopy.name} material, a correction, a comment, or a request to remove material or personal data. Removal requests are never published.`)]),
    submissionForm(site, projects, page),
    element('p', { 'data-submit-unavailable': true, hidden: true }, []),
    element('section', { class: 'rf-form__confirmation', 'data-submit-confirmation': true, hidden: true, 'aria-live': 'polite' }, [
      element('p', {}, [text('Your submission was received. Your reference is '), element('strong', { 'data-reference': true }, []), text(', received at '), element('time', { 'data-time': true }, []), text('.')]),
    ]),
  ];
  return {
    path: page.path, title: page.title, body, scripts: [formScript],
    ...(page.project === undefined ? {} : { titleContext: page.project.name, ...(page.project.accent === undefined ? {} : { accent: page.project.accent }) }),
  };
}

/** The page a Response_Link opens; the script reads the link's token and the Moderation_Service decides what the form may do. */
export function respondPage(site: SiteInput, formScript: string): PageSpec {
  return {
    path: PAGE_PATHS.respond, title: 'Respond to a request', scripts: [formScript],
    body: [
      element('p', {}, [text(`Use this form to answer a request from ${site.publicCopy.name} about your submission.`)]),
      element('form', { class: 'rf-form', method: 'post', action: PAGE_PATHS.respond, enctype: 'multipart/form-data', 'data-response-form': true, 'data-respond-form': true, ...formsAttributes(site) }, [
        element('p', { class: 'rf-form__status', 'data-respond-status': true, 'aria-live': 'polite' }, []),
        formField({ id: 'message', label: 'Message', control: 'textarea', required: true, attributes: { maxlength: 10_000 } }),
        filesField(),
        element('ul', { class: 'rf-file-list', 'data-file-list': true }, []),
        botCheck(),
        button({ label: 'Send', variant: 'primary', type: 'submit' }),
      ]),
      element('p', { 'data-respond-unavailable': true, hidden: true }, []),
      element('p', { 'data-respond-invalid': true, hidden: true }, []),
      element('section', { 'data-respond-confirmation': true, hidden: true, 'aria-live': 'polite' }, [
        element('p', {}, [text('Your response was received at '), element('time', { 'data-time': true }, []), text('.')]),
      ]),
    ],
  };
}
/** The page a Consent_Link (`/consent`) or a change link (`/consent/change`) opens; the script reads the link's token and fills in the request. */
export function consentPage(site: SiteInput, formScript: string, mode: 'consent' | 'change'): PageSpec {
  const path = mode === 'consent' ? PAGE_PATHS.consent : PAGE_PATHS.consentChange;
  return {
    path, title: mode === 'consent' ? 'Answer a consent request' : 'Change a consent answer', scripts: [formScript],
    body: [
      element('p', {}, [text(mode === 'consent'
        ? `Use this page to answer a request from ${site.publicCopy.name} about publishing your material.`
        : `Use this page to withdraw or change an answer you gave ${site.publicCopy.name}.`)]),
      element('form', { class: 'rf-form', method: 'post', action: path, 'data-consent-form': true, 'data-consent-mode': mode, ...formsAttributes(site) }, [
        element('p', { class: 'rf-form__status', 'data-consent-status': true, 'aria-live': 'polite' }, []),
        ...(mode === 'consent' ? [
          element('div', { 'data-consent-elements': true }, []),
          element('div', { 'data-consent-one-answer': true }, []),
          element('div', { class: 'rf-field', 'data-consent-label-field': true, hidden: true }, [
            formField({ id: 'genericLabel', label: 'Label to credit you by', hint: 'Optional.', attributes: { maxlength: 100 } }),
          ]),
        ] : []),
        formField({ id: 'comment', label: 'Comment', control: 'textarea', hint: 'Optional.', attributes: { maxlength: 2000 } }),
        botCheck(),
        button({ label: mode === 'consent' ? 'Send answer' : 'Send change', variant: 'primary', type: 'submit' }),
      ]),
      element('p', { 'data-consent-unavailable': true, hidden: true }, []),
      element('p', { 'data-consent-invalid': true, hidden: true }, [
        element('span', { 'data-consent-invalid-text': true }, []), text(' '), element('a', { href: PAGE_PATHS.submit }, [text('Send us a message')]),
      ]),
      element('section', { 'data-consent-confirmation': true, hidden: true, 'aria-live': 'polite' }, [
        element('p', {}, [text('Your answer was recorded at '), element('time', { 'data-time': true }, []), text('.')]),
      ]),
    ],
  };
}
const SEARCH_KINDS: readonly FieldOption[] = [...ITEM_KINDS.map((kind) => ({ value: kind, label: KIND_NAMES[kind] })), { value: 'attachment', label: 'Attachment' }, { value: 'withheld', label: 'Withheld' }];

/** The public search page; results come from the search script, limited by default to the Project it was opened from (R30.4, R30.12). */
export function searchPage(projects: readonly ProjectView[], searchScript: string, project?: ProjectView): PageSpec {
  const path = project === undefined ? PAGE_PATHS.search : projectPaths(project.slug).search;
  return {
    path, title: 'Search', scripts: [searchScript],
    ...(project === undefined ? {} : { titleContext: project.name, ...(project.accent === undefined ? {} : { accent: project.accent }) }),
    body: [
      element('form', { class: 'rf-search', role: 'search', method: 'get', action: path, 'data-search-form': true }, [
        formField({ id: 'q', label: 'Search terms', control: 'search', required: true, attributes: { maxlength: 200 } }),
        formField({
          id: 'project', label: 'Project', control: 'select',
          options: [{ value: '', label: 'All projects', selected: project === undefined }, ...projects.map((entry) => ({ value: entry.slug, label: entry.name, selected: entry.key === project?.key }))],
        }),
        element('fieldset', { class: 'rf-field' }, [
          element('legend', { class: 'rf-field__label' }, [text('Kinds')]),
          ...SEARCH_KINDS.map((option) => formField({ id: `kind-${option.value}`, name: 'kind', label: option.label, control: 'checkbox', value: option.value })),
        ]),
        formField({ id: 'from', label: 'From date', control: 'date' }),
        formField({ id: 'to', label: 'To date', control: 'date' }),
        button({ label: 'Search', variant: 'primary', type: 'submit' }),
      ]),
      element('div', { class: 'rf-search-results', 'data-search-results': true, 'aria-live': 'polite' }, []),
    ],
  };
}
