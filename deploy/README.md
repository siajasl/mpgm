# `deploy/`

Infrastructure as code for the environments `env.provision` provisions
(DEP-1, DEP-4; `contracts/env.provision.md`). Everything under
`environments/<env>/` is what "up" and "down" mean for that environment; there
is no manual step anywhere in this directory.

- `environments/environments.yaml` — which environments this project
  declares, and where each one's compose file is.
- `environments/<env>/compose.yaml` — the environment itself, a Docker
  Compose file (DESIGN §9 decision 8: containers, ahead of a hosted provider,
  chosen for the reasons stated there).
- `environments/<env>/compose.release.yaml` — applied on top of the file
  above only when `env.provision#up` carries an explicit `image` (DEP-3,
  `release.deliver`, T4.1.2). It undoes the base file's placeholder bind
  mount, which would otherwise keep serving itself over a delivered image
  (`contracts/env.provision.md`).
- `environments/<env>/html/` — the placeholder service each environment runs
  by default, standing in for a real deployable service until one lands
  (`${MPGM_SERVICE_IMAGE}` in the compose file overrides it without editing
  anything here).
- `sample-service/` — the service `release.deliver` (`contracts/
  release.deliver.md`) builds and delivers via that same override. Its
  content changes with the `APP_VERSION` build arg, so a release and a
  rollback are both observable rather than merely asserted.

Bring one up or down with the `env.provision` contract
(`src/env/provision.ts`, `src/env/compose-provider.ts`), or directly for local
debugging:

```sh
docker compose -f deploy/environments/test/compose.yaml -p mpgm-test up -d --wait
docker compose -f deploy/environments/test/compose.yaml -p mpgm-test down
```
