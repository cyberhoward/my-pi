# GitHub runners

Pi extension for observing and, only after explicit opt-in, managing small Hetzner Cloud pools of **Linux x64 GitHub Actions self-hosted runners**. It was adapted from `my-gratitude/tools/runner-manager` at `1273564a6d326e0e8c1aea6130112bf1c627632e`.

> Development has not validated live infrastructure. Treat a first deployment as an operator-controlled production change; no macOS or iOS runners are supported, and each pool size is limited to 3.

## Install and enable

From this package directory:

```sh
npm ci --ignore-scripts
npm run build
```

Then run `/toggle` in the Pi repository, discover **engineering → github-runners**, and explicitly select it. Engineering extensions are discovered but **not auto-enabled**. Restart/reload Pi as required by its extension settings.

The extension operates only when the current directory has one exact `github.com` origin. Monitoring uses the existing `gh` login; management reads the selected policy and produces a plan first.

## Commands and status

```
/runners
/runners status [--policy NAME_OR_PATH]
/runners refresh
/runners ensure [--policy NAME_OR_PATH] [--capacity 0..3] [--apply]
/runners reconcile [--policy NAME_OR_PATH] [--apply]
/runners drain --instance UUID [--policy NAME_OR_PATH] [--apply]
/runners destroy --instance UUID [--policy NAME_OR_PATH] [--apply]
```

`/runners` opens the command/settings menu in the TUI. `status` observes the configured policy/pool; without a policy it reports the GitHub runner inventory. `refresh` is local read-only monitoring. `ensure` is a bounded desired-capacity request, `reconcile` follows the policy, `drain` starts safe draining of one owned instance, and `destroy` first drains then later probes/removes it when safe. `--instance` is required for `drain` and `destroy`; `--capacity` is only for `ensure`; `--policy` selects a named/materialized policy.

Management is plan-first. `--apply` is allowed only in an interactive TUI, requires a warning-free unchanged plan, two confirmations (including sole-controller confirmation), policy `mutation.enabled: true`, and `RUNNER_MANAGER_ALLOW_MUTATIONS=1`. Without all of them it does not mutate. If more than one policy is configured, CLI apply operations require an explicit `--policy` selection.

The footer is `busy/online runners` (for example, `1/2 runners`), not a capacity guarantee. `/runners status` additionally reports `total - online` as offline. Failed/unknown monitoring displays `?/? runners` and status says it is unavailable.

## Settings and scope

Local settings live at `<git-root>/.pi/github-runners.json`. A local file containing `{ "mode": "global" }` selects the genuinely shared global configuration at `~/.pi/agent/github-runners.json`; it is not a personal-account runner mode. A global pool requires an organization name, a GitHub runner group ID/name, and an explicit exact `owner/repo` allowlist. All allowlisted repositories must belong to that organization, and the active repository and selected policy must be allowlisted.

Defaults are local, monitoring-oriented, and disabled for automation/mutation. Settings reject unknown keys. A minimal valid local draft is:

```json
{
  "mode": "local",
  "policies": [],
  "automationEnabled": false
}
```

A complete generated-pool example (placeholder values only; no credentials belong here) is:

```json
{
  "mode": "global",
  "policies": [],
  "pollIntervalSeconds": 60,
  "standbyMinutes": 15,
  "startOnLoad": false,
  "automationEnabled": false,
  "organization": {
    "name": "example-org",
    "repositories": ["example-org/app", "example-org/docs"],
    "runnerGroupId": 12345,
    "runnerGroupName": "pi-linux"
  },
  "sizes": [
    {
      "name": "small-linux",
      "labels": ["pi-linux-small"],
      "quantity": 0,
      "serverType": "cpx21",
      "location": "fsn1",
      "image": "ubuntu-24.04",
      "firewallId": "123456",
      "runnerVersion": "2.000.0",
      "runnerArchiveSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "maxHourlyCostEur": 1,
      "maxEligibilityCostEur": 10
    }
  ]
}
```

Each active size mapping is complete: custom routing `labels` (not `self-hosted`, `linux`, or `x64`), `quantity` 1–3, Hetzner type/location/image/firewall, pinned runner version and 64-hex archive checksum, and hourly/eligibility cost caps. Generated pools accept only x86 CX/CPX/CCX types and Linux x64 runners. A mapping with `quantity: 0` is disabled and may remain an incomplete draft; it generates no policy and does not delete existing managed VMs. Do not combine `sizes` with legacy `policies`.

Legacy YAML policies remain supported, including the legacy API identity profile. This does **not** adopt old servers into a generic identity: destructive operations require an owned, correctly labelled, configuration-matching instance.

## Automation and credentials

When `automationEnabled` is true **and** `RUNNER_MANAGER_ALLOW_MUTATIONS=1` is present, automation watches every configured local repo or global allowlisted repo. Queued, in-progress, waiting, pending, or requested workflow activity can ensure the pool; idle pools reconcile only after standby expiry. Any unavailable/incomplete activity result fails closed: it skips mutation rather than assuming idle.

`startOnLoad` is a one-time prewarm per policy/startup, not a permanent minimum. The prewarmed runner subsequently expires through normal standby/reconciliation. Closing Pi stops this session-only automation and cleanup, so a remote controller is advised for unattended operation.

For read-only monitoring, authenticate `gh` with GitHub Actions read access. Management needs `HCLOUD_TOKEN` and `RUNNER_MANAGER_GITHUB_TOKEN`, plus GitHub Actions read and repository runner administration; organization pools also need organization self-hosted-runner and runner-group access. Never put tokens in settings JSON or CI runner VMs. The core requires both provider credentials even for policy inventory operations; `gh auth token` may supply the GitHub policy variable locally, but it never supplies the Hetzner token.

## Remote controller (reaper)

Use the TUI commands:

```
/runners reaper install
/runners reaper status
/runners reaper uninstall
```

Install asks for an existing trusted Linux SSH alias (or `user@host`) and an already-provisioned absolute environment-file path. Remote preflight requires Node >=22.19, npm, `flock`, working user `systemd`, and user lingering. The environment file must be a regular, owner-owned `0600` file with literal `KEY=value` lines, containing at least:

```sh
HCLOUD_TOKEN=...
RUNNER_MANAGER_GITHUB_TOKEN=...
RUNNER_MANAGER_ALLOW_MUTATIONS=1
```

No credentials are copied: the installer ships compiled code and an authoritative configuration snapshot, then installs a user systemd service. Do not run a second local controller; one host/controller must be the sole writer for a pool. Local file locks serialize only that host—they are not distributed coordination.

The remote snapshot is authoritative. Repeating install for the same host and scope performs a transactional update while preserving prewarm state; operators must verify the resulting remote status/configuration. Changing the controller host or pool scope requires uninstalling the old controller first. **Uninstall only removes the service/package:** it does not delete runner VMs or the credential environment file. Plan VM cleanup before uninstall; powered-off Hetzner VMs can still be billable. Reaper status reports systemd service health only; inspect controller stderr with `journalctl --user -u pi-github-runners-<installation-id>.service`.

## Limits and provenance

This extension has no live-cloud validation in development. It supports Linux x64 only, up to three runners per pool, and relies on exact GitHub/Hetzner ownership evidence before destructive work. It is adapted from the source revision named above, rather than a promise of compatibility with the tutorial system below.

## Tutorial comparison

The [Hetzner GitLab Runner tutorial](https://community.hetzner.com/tutorials/gitlab-runner-hetzner-cloud/) describes a Docker-based GitLab orchestrator. The designs are not interchangeable:

| Topic | This extension | Tutorial |
| --- | --- | --- |
| Controller | Persistent Pi-managed controller over trusted SSH/user systemd | Docker Compose GitLab controller |
| Routing/scope | Multiple GitHub custom-label pools; organization runner group with exact repository allowlist | One untagged GitLab instance runner |
| Idle behavior | Standby expiry/reconciliation | Billing-boundary deletion optimization |
| Reporting | Plan/status output | CSV usage reporting |

Do not infer tutorial claims—such as pay-only-for-usage economics, billing-boundary optimization, Docker deployment, or CSV reporting—from this extension.
