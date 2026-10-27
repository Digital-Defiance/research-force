/**
 * Initial Public_Descriptions for every Methods_Term (R46.12). Administrators can change each one;
 * the text describes the software's meaning of a term and makes no claim about any one installation.
 */
export const VALUE_DESCRIPTIONS = Object.freeze({
  campaign_status: {
    COMPLETE: 'The work this journal entry describes was carried out in full.',
    SUSPENDED: 'The work was paused before it finished and may be resumed from where it stopped.',
    PARTIAL: 'Only part of the planned work was carried out; the entry says which part.',
    STOPPED: 'The work was ended before it finished and is not expected to resume.',
    OPEN: 'The work is still in progress or has not yet been concluded.',
    ELIMINATED: 'The work ruled out the possibility it tested, within the scope the entry states.',
    CLEAN_NEGATIVE: 'The work ran as planned and found nothing, which is itself a recorded result.',
  },
  finding_status: {
    Confirmed: 'The claim is supported by the evidence linked to it.',
    Open: 'The claim has been recorded but is not yet confirmed or withdrawn.',
    Withdrawn: 'The claim was withdrawn; the record keeps it with the date and reason.',
    Superseded: 'A later finding, linked from this one, replaces this claim.',
  },
  run_outcome: {
    'In progress': 'The run had started and had not finished when it was recorded.',
    Complete: 'The run finished and covered its whole stated scope.',
    'Clean negative': 'The run finished its scope without finding a solution; the searched space is excluded.',
    Partial: 'The run covered only part of its stated scope.',
    Suspended: 'The run was paused and can resume from its recorded resume point.',
    Stopped: 'The run was ended before it finished and is not expected to resume.',
  },
  hypothesis_status: {
    Open: 'The hypothesis is still being tested.',
    Eliminated: 'Evidence rules the hypothesis out, within the stated elimination scope.',
  },
  archival_request_status: {
    Planned: 'The request has been prepared but not yet sent.',
    Sent: 'The request was sent to the archive or desk on the date shown.',
    Replied: 'The archive or desk replied on the date shown.',
    Closed: 'No further action is expected on this request.',
  },
  reliability: {
    High: 'The source is considered dependable for the facts it is cited for.',
    Medium: 'The source is generally dependable but has known limits or gaps.',
    Low: 'The source is doubtful and its claims need independent support.',
    Unknown: 'The reliability of the source has not yet been assessed.',
  },
  rights_status: {
    'Own work': 'Made by the credited authors, who license it under the stated content licence.',
    'Public domain': 'Free of copyright restrictions on reproduction.',
    Licensed: 'Reproduced under a licence that the rights terms name.',
    'Permission granted': 'Reproduced with the rights holder’s permission.',
    Unknown: 'The reproduction rights have not been established, so the file is not published.',
    Restricted: 'The rights holder does not permit reproduction, so the file is not published.',
  },
  relation: {
    'Evidence for': 'The linked material supports the finding or hypothesis it points to.',
    'Based on': 'The material builds on the linked material.',
    'Produced by': 'The material was produced by the linked run or work.',
    Discusses: 'The material discusses the linked material.',
    Related: 'The materials are related in a way the record describes.',
  },
});

/** The Methods_Terms outside the configurable value sets (R46.11), in Methods page order within each group. */
export const FIXED_METHODS_TERMS = Object.freeze([
  { key: 'source_kind.primary', groupKey: 'source_kind', name: 'Primary', publicDescription: 'Original material from the time and place it describes, such as a document, message, or log.' },
  { key: 'source_kind.secondary', groupKey: 'source_kind', name: 'Secondary', publicDescription: 'Material that reports on, analyses, or reproduces primary material, such as a book or article.' },
  { key: 'disclosure_level.public', groupKey: 'disclosure_level', name: 'Public', publicDescription: 'The material is published in this archive.' },
  { key: 'disclosure_level.withheld', groupKey: 'disclosure_level', name: 'Withheld', publicDescription: 'The archive records that the material exists, with its kind, date, and parties, but does not publish its content.' },
  { key: 'label_kind.quote', groupKey: 'label_kind', name: 'Quote', publicDescription: 'The exact words of the named source, reproduced without change.' },
  { key: 'label_kind.paraphrase', groupKey: 'label_kind', name: 'Paraphrase', publicDescription: 'The named source’s meaning in different words; it is not an exact quotation.' },
  { key: 'label_kind.source_reported', groupKey: 'label_kind', name: 'Source-reported', publicDescription: 'A claim as a source reports it, which the authors have not confirmed themselves.' },
  { key: 'term.scope_caveat', groupKey: 'term', name: 'Scope caveat', publicDescription: 'The limits within which a finding holds, such as the material or settings it covers.' },
  { key: 'term.elimination_scope', groupKey: 'term', name: 'Elimination scope', publicDescription: 'What exactly the evidence rules out when a hypothesis is eliminated, and what it leaves open.' },
  { key: 'term.resume_point', groupKey: 'term', name: 'Resume point', publicDescription: 'Where an unfinished run can continue from without repeating work.' },
  { key: 'term.withdrawn', groupKey: 'term', name: 'Withdrawn', publicDescription: 'The authors withdrew the material. It stays in the record, with the date and reason, so that nothing is silently removed.' },
  { key: 'term.superseded', groupKey: 'term', name: 'Superseded', publicDescription: 'A newer version replaces this one. The older version stays available and links to its successor.' },
] as const);
