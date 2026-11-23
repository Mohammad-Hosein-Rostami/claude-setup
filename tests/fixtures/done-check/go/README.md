# Go tool output samples

Output of the Go tools the done-check reads, kept as files so `tests/done-check-go.test.mjs` can check that
`home/tools/done-check/lib/go-parse.mjs` reads what the real tools print. No `.go` file is kept here: a Go module in this repo would
be checked by the done-check itself; the test writes its throw-away modules into temp folders.

## Where they come from

Captured with go 1.27.4 (darwin/arm64) in a throw-away module `example.com/probe` in a scratch folder, with its own `GOCACHE`,
`GOMODCACHE` and `GOPATH`, `GOTOOLCHAIN=local` and empty `GOFLAGS`. The module held one package per case: `ok` (a passing test),
`fmtbad` (a file gofmt would change), `vettype` (a type error), `vetan` (a printf analyzer finding), `testfail` (a failing test, a
failing subtest named `a b`, a passing subtest and a passing test), `buildfail` (a package that does not compile), `notests` (no test
file), `panics` (a test that panics) and `two words` (a folder name with a space, which go refuses as an import path). Machine paths in
the panic trace were replaced by `/work/proj` (the module) and `/work/go` (GOROOT).

| Sample | Command (run in the module folder) |
|---|---|
| `go-vet-1.27.4.txt` | `go vet ./vettype ./vetan ./ok` (exit 1, stderr; stdout is empty) |
| `gofmt-1.27.4-list.txt` | `gofmt -l ./fmtbad/x.go ./ok/ok.go` (exit 0, stdout) |
| `go-test-1.27.4-fail.jsonl` | `go test -json ./testfail ./buildfail ./ok ./notests ./panics "./two words"` (exit 1, stdout) |
| `go-test-1.27.4-pass.jsonl` | `go test -json ./ok` (exit 0, stdout) |

## Windows variant

`go-vet-1.27.4-windows.txt` is `go-vet-1.27.4.txt` rewritten, not captured on Windows: the file paths use `\` and every line ends with
CRLF, as go vet prints on Windows. The parser test expects the same failure ids from both. The `.gitattributes` of the folder above
keeps the CRLF on every checkout.
