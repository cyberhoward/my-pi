### GitHub runners (`/runners`)

Observes GitHub Actions self-hosted runners and can explicitly, plan-first manage small Hetzner Linux x64 pools for the active exact `github.com` repository.

- Discovered under **engineering** by `/toggle`; it is **not auto-enabled**. Build first in `engineering/extensions/github-runners`: `npm ci --ignore-scripts && npm run build`.
- `/runners status|refresh|ensure|reconcile|drain|destroy` supports `--policy`, `--capacity`, `--instance`, and management `--apply`; mutation requires interactive confirmation, policy opt-in, and `RUNNER_MANAGER_ALLOW_MUTATIONS=1`. CLI apply operations require explicit `--policy` when multiple policies exist.
- Settings are local `.pi/github-runners.json`, or explicit shared-org mode via `~/.pi/agent/github-runners.json`; never place tokens in JSON or CI VMs.
- `/runners reaper install|status|uninstall` installs one trusted-Linux SSH/systemd controller using a pre-provisioned private `0600` environment file. Same-host/same-scope reinstall is transactional; changing host or scope requires uninstall first. Status is systemd health only; use controller stderr/journalctl for logs. Uninstall does not delete billable VMs or that environment file.
- A size mapping with `quantity: 0` is disabled, may remain an incomplete draft, and does not delete existing managed VMs. Footer is `busy/online runners`; `?/? runners` means status is unknown. No live infrastructure was validated. See `README.md` for limits, required GitHub/Hetzner permissions, configuration schema, and remote-controller caveats.
