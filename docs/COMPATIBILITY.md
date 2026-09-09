# Compatibility

These results apply to **DSH SuperAdvisor 0.1.8** on Linux x64 with a local POSIX filesystem. Version 0.1.7 and its published tarball retain their original DSH and Node requirements.

## Supported versions

| DSH | Node 22.19.0 | Node 22.23.2 | Node 24.2.0 | Node 24.19.0 |
| --- | --- | --- | --- | --- |
| 0.1.2-alpha.4 | Pass | Pass | Pass | Pass |
| 0.1.2-alpha.5 | Pass | Pass | Pass | Pass |
| 0.1.2-rc.1 | Pass | Pass | Pass | Pass |
| 0.1.3-alpha.2 | Pass | Pass | Pass | Pass |
| 0.1.5-alpha.1 | Pass | Pass | Pass | Pass |

Each cell includes 53 tests, source and test type checks, a client syntax check, a build, and loading the compiled plugin through the real DSH Loader/Include. The tests use real DSH services with controlled model responses and human answers. They cover approval and rejection, editable evidence, settings changes invalidating approval, native and Code Mode tool calls, selected tool-result evidence, cancellation, output limits, and duplicate-send protection. No paid models are used.

All 20 combinations also passed real Chromium checks against the installed package: one settings card, model selection, save, reload, inherited output defaults, enable/disable, stale-draft conflict handling, and settings retained after restarting DSH. The normal DSH plugin installer succeeded for all five host versions, and every installed DSH peer resolved to its own host release. The Node 22 installation of DSH 0.1.3 used a separately compiled native dependency tree. A saved result created under DSH 0.1.3 was restored under 0.1.5 with zero additional approvals or sends.

DSH peers explicitly list these five releases. Development dependencies remain pinned to 0.1.3-alpha.2; they do not prescribe the user's host version. A caret range starting with an alpha version does not automatically include later alpha release lines, so the supported releases are listed explicitly.

Node 24 is the recommended default (`.nvmrc`). Node `22.19.0` and newer 22.x versions are supported; the 24.x branch requires at least `24.2.0`. Node 23 is not included. Future DSH versions and other operating systems need separate verification; these results do not guarantee arbitrary version combinations or mixed DSH package versions within one host.

## Confirmed incompatibilities

All 17 DSH releases available from npm on 2026-09-09 were attempted:

- `0.0.1-rc.1` and `0.0.1-rc.2`: npm cannot resolve the historical `dsh-type-meta` dependency. No runtime result is claimed.
- `0.0.1-rc.5`, `0.1.0-rc.2`, `0.1.0-rc.3`, `0.1.0-rc.6`, `0.1.0-rc.7`, `0.1.0-rc.8`, `0.1.1-rc.1`, and `0.1.1-rc.2`: incompatible source APIs, including the `ToolCallId` export and `Session.snapshotEvents()`.
- `0.1.2-alpha.2` and `0.1.2-alpha.3`: lack `Session.snapshotEvents()`, required for selecting current-task evidence.
- Node `22.12.0`: all five otherwise supported DSH versions fail to load the Code Mode worker because `node:module` does not export `stripTypeScriptTypes`. Core tests pass from Node 22.13.0, but that is insufficient for a full Web installation.
- Node `22.13.0`: the full DSH Web profile fails while importing session persistence because it needs `node:zlib.createZstdDecompress`. [Node added this API in 22.15.0](https://nodejs.org/api/zlib.html#zlibcreatezstddecompressoptions); this establishes one host requirement, but the newer CLI has a higher requirement.
- Node `22.15.0`: DSH 0.1.3-alpha.2 and 0.1.5-alpha.1 exit silently without starting, because their CLI uses `import.meta.main`. [Node added it in 22.18.0 and 24.2.0](https://nodejs.org/api/esm.html#importmetamain). In addition, current non-optional model-adapter dependencies require Node 22.19.0; the plugin therefore declares `^22.19.0 || >=24.2.0`. Optional native dependencies can have stricter engine requirements and may be skipped by npm on older supported runtimes. This matrix covers the plugin flows described above, not every optional DSH capability.

Upgrade an incompatible DSH installation to a version in the table. Do not suppress dependency checks with `--force` to treat an untested host as supported. Keep all DSH service packages on the same release.

## What changed in 0.1.8

DSH 0.1.5 renamed completed Code Mode events from `tool/code-dispatch` to `tool/ptc-dispatch`. SuperAdvisor now recognizes both names and reads the actual sub-call ID without assuming its prefix. A regression test produces evidence through a real `run_code` worker, selects one line, requires approval, and verifies that rejection or repeated execution cannot trigger another send. With the original implementation, this test returns `evidence_unavailable` on DSH 0.1.5-alpha.1.

## Reproduce

Use a supported Node version and npm:

```sh
npm ci
npm run check
npm run check:dsh -- 0.1.5-alpha.1
```

`check:dsh` copies only build inputs and tests into `.acceptance/compatibility/<version>`, installs that exact DSH service version, rejects mixed DSH versions, then runs the complete checks and starts the full Web profile. The Web smoke check also requires `dsh --version` to print the expected version, so a silent zero exit cannot count as success. It leaves the root development dependencies and your DSH configuration untouched. Network access is needed to download dependencies, but inference is controlled locally. Run it under each Node version you need to support. The GitHub Actions workflow repeats the five-version matrix with Node 22.19.0, current 22.x, Node 24.2.0, and current 24.x.

`scripts/dsh-packages.json` lists DSH package names from the tested host dependency trees. Update that list when evaluating a host that introduces new packages. Automated checks include Web startup; the full interactive Chromium scenarios above are a separate acceptance step.

With [nvm](https://github.com/nvm-sh/nvm#usage) already installed, switch to the recommended runtime with `nvm install 24` and `nvm use 24`. Check `node --version` and `command -v node`. When switching Node major versions, reinstall DSH under the selected Node version to rebuild native dependencies such as `fs-ext`; reusing a Node 24 binary addon under Node 22 can fail with `ERR_DLOPEN_FAILED`. Keep the same DSH_HOME and saved settings. A running DSH process keeps its existing Node executable; finish its tasks and restart it from the selected environment. Launchers with bundled Node and services with an absolute executable path must be checked separately.
