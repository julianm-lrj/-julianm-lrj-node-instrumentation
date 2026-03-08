# Licence Folder

This folder contains third-party dependency license inventory and criteria summaries for this repository.

## Files
- `THIRD_PARTY_LICENSES.md`: Human-readable inventory for all packages found in `package-lock.json`, including license criteria per package.
- `third-party-licenses.json`: Machine-readable version of the same data.
- `license-texts/`: Canonical license texts used by current dependencies.
- `generate-third-party-license-report.mjs`: Regenerates inventory from current `package-lock.json` and `node_modules` metadata.

## Regenerate

```bash
node licence/generate-third-party-license-report.mjs
```
