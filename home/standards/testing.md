# Testing (T1-T8) plus C11, C13

- **T1** Many unit tests, fewer integration, very few E2E for critical journeys.
- **T2** Bug or logic: write the failing test, watch it fail, fix, refactor.
- **T3** Assert behaviour through the public interface; no assertion-free or snapshot-only logic tests.
- **T4** Inject time and randomness; no sleeps or network.
- **T5** Arrange-Act-Assert; name like `returns 403 when user is not owner`.
- **T6** Mock only at system boundaries; prefer fakes.
- **T7** Cover empty, null, boundary, unauthorised and timeout; 80% on changed lines.
- **T8** Testing Library queries by role/label; Playwright for critical flows.
- **C11** Changed src needs a changed or added test.
- **C13** Never add ts-ignore, eslint-disable, skip, xit or only to get green.
