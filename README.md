# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/lyretain/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/lyretain/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Offline, single-process GitHub-compatible git forge. Node.js 22 runs `main.ts`. It does not call system git and it does not contact any network service of its own.

## Run it

```sh
node main.ts
```

The harness sets `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN`. With no `MAKEFUN_ENV_URL` the process exits 1. It binds an ephemeral port, registers that port, and exits after `GET /done` returns `{"done":true}`. Do not bind 8080.

The API viewer is the published scenario login `adaiversen`. `Authorization` must be exactly `Bearer $MAKEFUN_SHOP_TOKEN`.

## What it implements

- Smart HTTP `git-upload-pack` protocol v2, including shallow fetch, and `git-receive-pack` protocol v0
- REST `/api/v3` for repositories, contents, refs, commits, issues, labels, and pull requests, including squash merge
- GraphQL `/api/graphql` for the documents the published checks send
- MCP `/mcp`, revision `2026-07-28`, with the six required tools

`main.ts` is the published starter lifecycle. The forge itself is `app.ts`, `forge.ts`, and `gitpack.ts`.

## Scores

These numbers were measured on this machine. They are not a score from make.fun's Docker sandbox, and this repository has not been submitted.

`node cli/makefun.mjs grade-local --kit <official kit> --bot <this tree> --driver process --instances 3` finished all three published practice instances. Docker is not installed here, so this is the kit's process driver: unisolated, no image digest. Each trial scored 1000 (feature 600, MCP 200, performance 200) and the replay check reproduced. Practice instance digests were `2dbde1d1494af3cbb4bfd5e6cd44b3dbab56c5cc7d158ebb9313d9d93b7737fc`, `31709a3ffeef44c0ebe45109826d1c30e603495732744c2badf6e94dd89fabfa`, and `53cdb951ca278437c50c7e7b8497f7e64c67e8086483898cd6e290f22227c0ac`.

An earlier in-process `startEnv` run, not `grade-local`, also passed 120/120 three times with byte-identical `state.json`. That file is the suite's pass bitmap. It is not in this repository, and the server does not write it.

## Limitations

This is not full GitHub. There is no search, no webhooks, no permission matrix, no rebase, and no delta objects in packs.

Attaching the first finished Cursor cloud export to `grade-local` produced an authorship summary of 260 authored lines out of 1751 (`authored_coverage` 0.148). The published reproduction floor is 0.3. One `edit_file` of `forge.ts` was truncated by the API: its completed event has no args and no result, and no earlier event for that call carries the file body. Those bytes were not reconstructed. That gap is why most of `forge.ts` is absent from the ledger. A later run's export is not part of this snapshot. Nothing here is a make.fun submission.

## License

MIT. See `LICENSE`, which includes `SPDX-License-Identifier: MIT`.

---

<sub>Built for [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
