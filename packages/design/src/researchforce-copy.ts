import type { InstallationPublicCopy } from './installation';

/**
 * The canonical ResearchForce.org `Installation_Public_Copy`, encoded verbatim from
 * `docs/instance/researchforce-org-content.md` (the masthead name and strapline, the Mission statement, the three
 * About paragraphs, and the seven ordered Principles with their bold lead words). This is public organizational copy,
 * not research data. The reusable software must not present these claims for any other installation: other
 * installations configure their own complete bundle, and `validatePublicCopy` rejects an incomplete one with no
 * ResearchForce.org fallback (design "Site display name…", R46.41, R46.42).
 *
 * The version is the content doc's own last change; changing any field here is a release that advances it.
 */
export const RESEARCHFORCE_PUBLIC_COPY: InstallationPublicCopy = {
  version: '2026-10-27',
  name: 'Research Force',
  strapline: 'Independent research, on the record',
  mission: {
    heading: 'Mission statement',
    paragraphs: [
      'ResearchForce is an independent group of researchers, scientists, historians, and engineers who take on hard, long-running research problems for their own sake. We hold the work to professional and scientific standards: every claim is traced to its source, every contribution is credited, and every result is kept, including dead ends and negative results. We publish what we learn as an open archive so that others can check it, cite it, and build on it.',
    ],
  },
  about: [
    'ResearchForce is a small, independent group of researchers, scientists, historians, and engineers. We work on hard, long-running problems that interest us, for their own sake, and we hold that work to professional and scientific standards.',
    'Our work is organized into Projects. The first, and our current focus, is the campaign to break the Kriegsmarine Enigma M4 message P1030680, which combines archival research with mechanical and computational cryptanalysis. Other Projects will follow, each with its own lead and its own collaborators.',
    'We publish what we learn as an open archive. It keeps the whole record: sources, methods, compute runs, eliminated hypotheses, and negative results, with exact quotes kept apart from paraphrase and confirmed facts kept apart from claims. Outside researchers are welcome to send material, corrections, and comments through the contact form.',
  ],
  principles: [
    { name: 'Independence', text: 'We answer to the evidence, not to a funder, employer, or institution. We take no donations and run no fundraising.' },
    { name: 'For its own sake', text: 'We choose problems because they’re worth solving, not because they pay or publish well.' },
    { name: 'Provenance first', text: 'Every claim points to its source. We keep exact quotes apart from paraphrase, primary sources apart from secondary, and confirmed facts apart from reported claims.' },
    { name: 'Keep the whole record', text: 'Dead ends, eliminated hypotheses, and negative results are findings too, and they stay in the archive.' },
    { name: 'Credit every contributor', text: 'Authors keep the copyright in their work, and everyone who helps is named for what they did.' },
    { name: 'Consent before publication', text: 'Nothing goes public without the author’s agreement, and private correspondence stays private unless everyone in it agrees.' },
    { name: 'Open to correction', text: 'Anyone can send a correction or new material, and we answer it.' },
  ],
};
