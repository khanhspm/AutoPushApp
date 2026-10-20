# Build reliability and local artifacts

- Treat Test Build and Build as the same real Fastlane pipeline; Test Build only changes notification behavior. Do not claim either is a dry run.
- Validate the exact requested scheme against Xcode before Fastlane changes version/build numbers. Do not silently substitute another scheme.
- Keep bounded Xcode timeouts, and pass supported timeout overrides through the worker's environment allowlist.
- Every build attempt must own a unique temporary archive directory. Pass its archive path using `GYM_ARCHIVE_PATH`; managed Fastfiles must honor it and must not hard-code another archive path.
- Delete only that attempt's temporary archive after Fastlane/export/upload finishes, on success, failure, timeout, or cancellation. Keep IPA and logs. Never sweep `~/Library/Developer/Xcode/Archives`, existing user archives, or other builds' files.
- Cleanup errors must be visible in logs and must not replace the original build failure or cause a successful upload to be retried.
- Cover archive cleanup and scheme preflight with regression tests. Use fake runners for failure/cancellation tests; do not distribute builds or send notifications just to test cleanup.
- Before restarting a worker, check active builds and preserve in-flight work. Report whether validation used a fake runner or an actual Xcode/Fastlane build.
- Explain that preflight prevents known configuration errors, not all compiler, signing, network, or external-service failures.
