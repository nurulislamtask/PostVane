# Releasing PostVane

Releases are built by GitHub Actions (`.github/workflows/release.yml`).

1. Bump `version` in `package.json` and in `latest.json`.
2. `npm test`
3. Commit and push to `main`, then run **Actions → Release → Run workflow** (or push a tag like `v1.1.1`).
4. The workflow builds the Windows installer (`PostVane-<version>-win-x64.exe`) and the Android app
   (`PostVane-<version>-android.apk`) and publishes both on the GitHub Releases page.

You can also run the workflow by hand from the Actions tab (**Release → Run workflow**) to check the builds.

The Android APK is signed with the standard debug key, so it installs on any phone that allows installs from unknown
sources. For Google Play you need your own release keystore.
