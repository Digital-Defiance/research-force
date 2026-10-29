# ResearchForce.org public identity and editorial copy

This is the canonical first-installation content bundle for the public website. It is public organizational copy, not research data. The reusable Research Force software must load equivalent values from validated installation configuration; it must not present these ResearchForce.org claims for another installation.

## Masthead

**Name:** Research Force

**Strapline:** Independent research, on the record

## Mission statement

ResearchForce is an independent group of researchers, scientists, historians, and engineers who take on hard, long-running research problems for their own sake. We hold the work to professional and scientific standards: every claim is traced to its source, every contribution is credited, and every result is kept, including dead ends and negative results. We publish what we learn as an open archive so that others can check it, cite it, and build on it.

## About

ResearchForce is a small, independent group of researchers, scientists, historians, and engineers. We work on hard, long-running problems that interest us, for their own sake, and we hold that work to professional and scientific standards.

Our work is organized into Projects. The first, and our current focus, is the campaign to break the Kriegsmarine Enigma M4 message P1030680, which combines archival research with mechanical and computational cryptanalysis. Other Projects will follow, each with its own lead and its own collaborators.

We publish what we learn as an open archive. It keeps the whole record: sources, methods, compute runs, eliminated hypotheses, and negative results, with exact quotes kept apart from paraphrase and confirmed facts kept apart from claims. Outside researchers are welcome to send material, corrections, and comments through the contact form.

## Principles

1. **Independence.** We answer to the evidence, not to a funder, employer, or institution. We take no donations and run no fundraising.
2. **For its own sake.** We choose problems because they’re worth solving, not because they pay or publish well.
3. **Provenance first.** Every claim points to its source. We keep exact quotes apart from paraphrase, primary sources apart from secondary, and confirmed facts apart from reported claims.
4. **Keep the whole record.** Dead ends, eliminated hypotheses, and negative results are findings too, and they stay in the archive.
5. **Credit every contributor.** Authors keep the copyright in their work, and everyone who helps is named for what they did.
6. **Consent before publication.** Nothing goes public without the author’s agreement, and private correspondence stays private unless everyone in it agrees.
7. **Open to correction.** Anyone can send a correction or new material, and we answer it.

## Placement and governance

The masthead name and strapline appear in the public header and at the start of the home page. The home page presents the Mission statement before Featured Projects. The About page retains the fixed legal/status section required by Requirement 46, then presents the About copy and the seven Principles in this order.

The bundle is versioned installation configuration. Bootstrap validates it as a complete unit and records its digest and version. A change to the masthead, mission, or principles is a release/configuration change that updates the affected page’s last-updated date and republishes every affected output. The About prose initializes the required “About the group” Policy_Section and may later change only through the normal preview, Revision, activity, and publication workflow. Production verification compares the rendered ResearchForce.org pages with this file. Synthetic and independent installations supply different copy.
