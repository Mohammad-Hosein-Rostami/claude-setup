---
name: tech-research
description: Use when a design decision depends on external facts you lack - service limits, versions, pricing, standards, known failure modes. Search the web and cite; for a library API read the installed package's docs.
---

1. Write the questions first (max 5), each answerable by a fact: "max item size of X", "does Y support Z in version N".
2. Prefer primary sources: official docs, specs/RFCs, release notes, the project's issue tracker. Blogs and forums only to find failure modes; say so.
3. Check date and version of every source. A fact from before the current major version is a lead, not an answer.
4. Cross-check anything that decides the design with a second source or a small local experiment.
5. Write findings as: fact, source URL, date read, confidence (verified / reported / assumption). Put them under "Sources" in the ADR or the PR; never leave a decision resting on memory.
6. Re-fetch every version, date and price claim yourself from two independent sources, one claim at a time; a claim you cannot finish is kept and marked unverified, never dropped; list the open sub-questions.
7. Stop when the questions are answered.
