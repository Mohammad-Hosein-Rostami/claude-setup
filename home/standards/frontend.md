# Frontend (F1-F10)

- **F1** Function components, typed props, one per file.
- **F2** Prefer children/slots to many config props; components under 150 lines; move logic to hooks.
- **F3** Derive values during render instead of syncing state. Effects need cleanup and full deps.
- **F4** Local state first, lift when shared, server state in TanStack Query, URL for filters and tabs.
- **F5** `key={item.id}`, never the index; memoise only after measuring.
- **F6** Lazy routes and images, virtualise long lists, LCP < 2.5 s, INP < 200 ms, CLS < 0.1.
- **F7** Every async view: loading, empty, error, success (a test or story each).
- **F8** Route-level error boundary with a retry action and a human message.
- **F9** Labelled inputs, inline validation, input preserved on error, submit disabled while pending.
- **F10** Discriminated unions for variant props instead of casts.
