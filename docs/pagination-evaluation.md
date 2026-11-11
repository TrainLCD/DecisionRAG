# Pagination evaluation checkpoint — 2026-11-11
Status: NOT READY FOR PR OR MERGE. Real API tests work; GitHub quota recovered. No new PR created.
Branch head evaluated: c82203f49d9190ba45e87ab2b5734038831c2ac2.
Question: 地下鉄で位置更新が止まる問題, public only, /search, no generation timing included.
Latest concurrent same-query run:
- main: 11.717 s, 14 passages, includes MobileApp #420, #423, #267.
- paged flash: page 1 9.041 s / 7 passages; page 2 2.800 s / 2 passages; page 3 1.557 s / 4 passages. #420 and #423 now page 1. #267 absent from all pages.
- paged Clef: page 1 13.461 s / 6 passages; page 2 1.599 s / 1 passage. #420/#423 page 1, #267 absent. Other relevant sources also differ.
These are single-query measurements, not statistical performance or recall guarantees.
Earlier full-size Clef was accidentally split at flash's byte budget. Fixed to choose the actual model budget. Calls fell from 40+55 to 12+23 but latency did not materially improve.
Retained-candidate diagnostics now use existing trace.selected: page_screening lists retained group member IDs, document_screening lists final document IDs. Remove diagnostic change or formalize its semantics before PR (UI and docs may expect group IDs/top 12).
Trace isolated missing #267 to individual document screening, not group pruning. #267 title is 位置情報精度設定と開発者モード有効化, body related: #263. Need consider linked issue context; title/excerpts alone omit why this matters. Do not add query-specific whitelist.
Document instructions now explicitly include partial evidence (symptoms, fixes, causes, diagnostics; excerpts incomplete). This restored #423 page-one placement in flash but not all recall.
Cloud-browser tested PRE latest prompt revision: actual provisional summary visible before verification; final direct answer then ticket summaries; next-page generation and previous cached page restoration worked. Final answer 31.83 s on first Clef page, 7.74 s second. Browser error recovery still needs testing. New code must be revalidated before PR.
Latest CI and preview upload succeeded. Existing 38 local tests passed before prompt revision; remote has additional preview tests and latest workflow succeeded.
Next: resolve remaining retrieval losses based on actual current code/data, broaden representative queries, verify current browser/SSE/error paths, add meaningful regression checks, remove temporary src/preview-clef.ts and .github/workflows/verify-pages.yml plus diagnostics before PR, update formal docs, then CR/CI and squash merge with expected SHA; verify deploy. Preserve fresh public visibility checks. Do not claim completion.
