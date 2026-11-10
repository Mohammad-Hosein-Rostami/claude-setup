---
paths: ["**/*.test.*","**/*.spec.*","**/e2e/**"]
---
# Test rules: id | rule | check
T1 | Many unit, fewer integration, very few E2E | rev
T2 | TDD for logic and bugs: see it fail first | rev
T3 | Test behaviour via the public interface; no assertion-free tests | eslint
T4 | Deterministic: no sleeps, real clocks, network | CI rerun
T5 | Arrange-Act-Assert; descriptive names | rev
T6 | Mock only at system boundaries; prefer fakes | rev
T7 | Cover empty, null, boundary, unauthorised paths | coverage
T8 | Testing Library by role; Playwright for key flows | eslint
