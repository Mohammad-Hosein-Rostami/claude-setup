---
name: tech-research
description: Use when a design decision depends on external facts you lack - service limits, versions, pricing, standards, known failure modes. Search the web and cite; for a library API read the installed package's docs.
---

1. Write the questions first (max 5), each answerable by a fact: "max item size of X", "does Y support Z in version N".
2. A tool installed here (git, node, a CLI, a package): its `--help`, `man`, installed docs or a small probe first; for the installed version, its docs and a probe are two sources. Then primary sources: official docs, specs/RFCs, release notes, the project's issue tracker. Blogs and forums only to find failure modes; say so.
3. Check date and version of every source. A fact from before the current major version is a lead, not an answer.
4. Cross-check anything that decides the design with a second source or a small local experiment.
5. Write findings as: fact, source URL, date read, confidence (verified / reported / assumption). Put them under "Sources" in the ADR or the PR; never leave a decision resting on memory: a fact you only remember is an assumption and goes under Unconfirmed.
6. Re-fetch every version, date and price claim yourself from two independent sources, one claim at a time; a claim you cannot finish is kept and marked unverified, never dropped; list the open sub-questions.
7. Stop when the questions are answered.
