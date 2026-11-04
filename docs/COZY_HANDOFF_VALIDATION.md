# Private handoff verification

The original COZY_PUBLISHING_HANDOFF.md is a contract, not deployment evidence. Current code includes an owner-confirmed browser ZIP export for art/coloring/storybook projects, a CLI exporter, a validator, and Cozy's read-only catalog proposal. Catalog mutation, automatic PR creation, KDP publishing and deployment remain excluded.

Run:
```sh
python -m pip install .
python -m unittest discover -s tests -p test_cozy_handoff.py -v
node tests/browser_cozy_handoff.cjs
```

Browser testing requires Playwright Chromium and a Cozy checkout at .handoff-cozy (or COZY_HANDOFF_DIR). CI pins Cozy commit dfe4b9fc4d0201268769dbc1f1153a6425826476; rerun compatibility against any changed importer before rollout. It creates isolated synthetic projects, clicks the actual export button at 390px/1440px, checks downloaded ZIPs with both validators, confirms metadata/checksums/category and unchanged source records, and tests cancellation and rejected inputs.

The browser preflights 42 MiB/entry and 90 MiB total (reserving 64 KiB manifest space) before allocating ZIP inputs. Existing image intake further limits images to 10 MiB/12 megapixels. Python validators fully decode still PNG/JPEG/WebP and enforce filename format; PDF header checks are type checks only, not print-readiness checks. Signed authenticity is not provided.

Production was last observed on PR #40 while main included #46. This document does not authorize deployment or claim current production contains these changes. Merge paired fixes only after CI succeeds; separately approve the production rollout.
