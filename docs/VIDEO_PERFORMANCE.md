# Faster captioned video export

The previous exporter encoded all scene frames, then decoded and encoded the
complete movie again to burn captions. The old 82% finishing stage could be a
substantial second rendering step.

The exporter now burns each measured caption into its own scene during the
scene's only encode. Final assembly concatenates matching H.264 scene streams
with `-c:v copy` and encodes AAC audio. Full-project SRT/ASS files remain in the
workdir; additional scene-local ASS files share the same typography and text.
Caption times account for rounded frame boundaries. Assembly keeps all encoded
scene frames and the finite audio mix, rather than trimming the copied stream
at a fractional-second cut. Video duration follows the 30 fps frame boundary
within the existing delivery tolerance.

Resolution remains **1080 × 1920 at 30 fps**, with gentle motion, the complete
source picture, measured narration timing, optional procedural ambience,
H.264/yuv420p, stereo AAC, faststart and the 20 MB verification limit. The
encoder uses **veryfast / CRF 22** with two encoder threads and one filter thread.
The same CRF is a quality target, not a promise of pixel-identical compression
across presets. The final join itself preserves the already encoded scene
frames without another lossy encode.

## Local comparison

One sequential before/after comparison used the same seven-picture, 35-second
project and the same cached narration WAV files on the same local machine.
Neither run called Cloudflare, synthesized new speech or used the hosted studio.
Times include image preparation, audio fitting/mixing, encoding, final assembly
and delivery verification. Cached speech synthesis is excluded from both.

| Measurement | Previous exporter | Optimized exporter |
| --- | ---: | ---: |
| Elapsed time | 58.649 s | 17.271 s |
| Finishing stage | 25.480 s | 1.093 s |
| Largest child-process RSS | 510,704 KiB | 257,976 KiB |
| MP4 bytes | 7,841,981 | 5,322,228 |
| Video frames encoded for this 35 s project | 2,100 | 1,050 |
| Delivery checks | Passed | Passed |

This comparison was **3.40× faster**, with a roughly 49.5% lower largest
child-process peak and a roughly 32.1% smaller file. Memory was measured with
Linux `resource.getrusage(RUSAGE_CHILDREN).ru_maxrss`: it is the largest observed
child peak, **not** simultaneous whole-service/cgroup memory. It does not prove
Render's limits or establish the cause of any previous restart. Two matched
captioned scene frames were visually compared.

These measurements are not a Render completion-time guarantee. Free-host CPU,
concurrent traffic, narration/model loading, host restarts and download speed
still affect the result. No old hosted job is retried, no completed movie is
deleted, and no service plan or restart behavior is changed by this patch.

## Regression checks

- A real two-scene FFmpeg fixture verifies H.264/AAC, 1080p, 30 fps, fractional
  duration, faststart and delivery size.
- Decoded frame hashes match the captioned scene concatenation exactly, proving
  final assembly adds no further lossy video encode.
- Pixel checks verify visible captions during measured speech in both scenes,
  and no captions before/after the first utterance.
- Rounded scene-frame windows add up to the expected total instead of
  accumulating a per-scene rounding error.
- The container check runs the short synthetic export within 512 MiB / one CPU.
  Narration has its separate bounded CPU smoke test. These are component checks,
  not a full hosted seven-scene capacity guarantee.

`verification.json` records stage elapsed times, encoding mode, preset and total
render time for future comparisons. Existing immutable snapshots, process
leases, quotas, authentication, cancellation and explicit downloads stay in
place. Do not redeploy while the owner has an active test or unexported movie.
