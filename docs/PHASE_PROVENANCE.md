# Phase provenance

Integration base: `c1eea9a95e5c17af935a6f1d18e734d72dd13426` (original main commit).

| Source | Result |
| --- | --- |
| Phase 1 | Inspected directly from main; existing source and history preserved. No standalone archive supplied. |
| Phase 4 standalone archive | Upload unavailable; not read or claimed verified. Later cumulative archives contain Phase 4-labeled production code/tests. Re-upload for independent comparison. |
| Phase 2: `wec-ai-engine-phase2(1).zip` | 21 files inspected; SHA-256 `cf9bdc679a8178c4a89dbd178f92548a42123de873e8bbb66e13cf78a5ddadb2` |
| Phase 3: `wec-ai-engine-phase3(1).zip` | 25 files inspected; SHA-256 `2df96e98ffe86ca2d2c266a4bbfb9dddec54e1faea354af80bdf8a25e0e17039` |
| Phase 5: `wec-ai-engine-phase5(1).zip` | 30 files inspected; SHA-256 `d234ca4e38c29310ad4bcf84cd769afda96c7bb0f7fe13062896b7d1e0ec9b8d` |
| Phase 6: `wec-ai-engine-phase6(1).zip` | 32 files inspected; SHA-256 `ef0ec21d926ede3282043655cbbac3779aba8fe1f3205049a15f386cae130bde` |
| Phase 7: `wec-ai-engine-phase7(1).zip` | 34 files inspected; SHA-256 `760f37a3f7a445d0360b50cf6a869bf56c41176a719f92e83494286ae383b2f4` |
| Phase 8: `wec-ai-engine-phase8(1).zip` | 36 files inspected; SHA-256 `787237d448d6a6de3704335470d85d99210189f9abd6e19fd695e871b10f7f88` |
| Phase 9: `wec-ai-engine-phase9(1).zip` | 41 files inspected; SHA-256 `799d24e697dd322eb64b90acda48511a7672e16e918ce1b5116539a1fd189d60` |
| Phase 10: `wec-ai-engine-phase10(1).zip` | 47 files inspected; SHA-256 `7bd988ce1457231aa3e0ceeb60b76da8bdbcb2bbaece82b017b8e5fc5401f51e` |

## Reconciliation

Each available later archive contains every path from the preceding available one. Phase 10 is the complete supplied snapshot (47 files). File hashes were compared across all eight available archives before merging. No phase-specific file was silently dropped. Later revisions were selected for evolving modules; the root was reorganized into one installable package rather than duplicate phase directories.

Phase 1 `router.py`, `providers/cloud.py`, `providers/comfy.py`, `video.py`, `test_router.py`, `scene.json` and `video-manifest.json` matched their Phase 10 counterparts byte-for-byte before integration fixes. CLI and package metadata evolved across phases. The original README is retained in `docs/archive/PHASE1_README.md`; the supplied Phase 10 deployment note is in `docs/archive/PHASE10_DEPLOY.md`. These archived notes describe historical behavior; current setup lives in the top-level README and current docs.

## Original root paths

| Original | Integrated path |
| --- | --- |
| `__init__.py` | `wec_engine/__init__.py` |
| `cli.py` | `wec_engine/cli.py` |
| `cloud.py` | `wec_engine/providers/cloud.py` |
| `comfy.py` | `wec_engine/providers/comfy.py` |
| `router.py` | `wec_engine/router.py` |
| `video.py` | `wec_engine/video.py` |
| `test_router.py` | `tests/test_router.py` |
| `scene.json` | `examples/scene.json` |
| `video-manifest.json` | `examples/video-manifest.json` |

Five root `*.cpython-313.pyc` cache artifacts are removed from tracking in the integration branch. They remain accessible in the original commit. Source modules are moved/extended, not discarded. No history rewriting, merge, deployment, original-branch deletion, model downloads or paid API calls are part of this integration.
