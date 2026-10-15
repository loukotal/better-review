# Annotation navigation and compact conversation controls

## Diagnosis

Clicking two real annotations from a saved review link opened source dialogs even though their message revisions matched the displayed PR head and both lines were in right-side patch hunks. The failure happened before diff focusing, not because of a missing rendered row.

`AnnotationBlock` correctly forwarded the file/line and `ChatPanel` retained the message revision. But `ChatPanel.handleFileClick` compared it against `currentHeadSha`, which saved-session initialization deliberately reset to `null` and did not populate. That produced `sameRevision=false`; App correctly interpreted that flag as historical/unknown and opened source.

The pre-feature HEAD source contains the same saved-session guard and comparator. This was a source comparison, not a separate runtime reproduction of HEAD; it does not establish that selection changes introduced the bug.

## Fix

App now passes the authoritative **displayed diff head** to ChatPanel. Annotation navigation compares against that value (or the selected commit SHA in commit mode), never a saved conversation's potentially different head. Missing revision evidence remains conservative. Historical revisions, unchanged lines, absent files and unavailable targets retain source fallback with the originating session/ref.

The toolbar uses two intentional rows: Session/New, then equally sized Run review/Adversarial actions. All actions remain directly clickable at 240–600px panel widths; the primary action cannot wrap onto an orphan row.

## Regression checks

- On a loaded full-PR page with known core metadata, import `/src/lib/annotation-navigation.browser.ts` and run `testAppAnnotationNavigationInBrowser()`. It injects deterministic saved-session transport fixtures into the **mounted real App**. Clicks run through AnnotationBlock → ChatPanel → App → FileDiffView/SourceDialog. Five cases cover focused current code (no modal/source fetch), historical code, unchanged lines, absent files and unknown revisions. Fixture selection/history/source requests do not change saved sessions or call a model; the original review URL is restored afterward.
- Import `/src/components/ReviewSessionToolbar.browser.tsx` and run `testReviewSessionToolbarInBrowser()`. Geometry, text bounds, direct callbacks, saved-session selection and disabled/creating states are checked at 240, 320, 370 and 600px (36 assertions, no review submissions).
- Both original real annotation links were clicked again after the fix: each selected the correct code row without opening a modal. The selection-editor/browser suites remain separate regression coverage.

The missing safety net was a full click-chain test: earlier helper tests accepted an already-computed `sameRevision` boolean and could not detect the wrong upstream revision source.
