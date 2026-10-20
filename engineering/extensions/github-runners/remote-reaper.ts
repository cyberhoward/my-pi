import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepositoryBinding } from "./repository.js";
import { reaperInstallationId as canonicalReaperInstallationId, type RunnerSettings } from "./settings.js";
import { materializePolicies } from "./policies.js";
import { parseReaperConfig, parseReaperRequest } from "./reaper-runtime.js";

export type ReaperInstallation = { sshTarget: string; installationId: string; environmentFile: string };
export interface ReaperRequest { operation: "status" | "ensure" | "reconcile" | "drain" | "destroy" | "startup"; policy?: string; capacity?: number; instance?: string; all?: boolean; apply?: boolean; expectedPlanFingerprint?: string; expectedScopeFingerprint?: string }
export interface ReaperTransportResult { code: number; stdout: string; stderr: string }
export interface ReaperTransport { (input: { sshTarget: string; command: string; stdin?: Buffer; timeoutMs: number; maxOutputBytes: number }): Promise<ReaperTransportResult> }
export interface ReaperDependencies { transport?: ReaperTransport; pack?: (config: Buffer) => Promise<Buffer>; timeoutMs?: number }

const targetPattern = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const idPattern = /^[a-f0-9]{16}$/;
const envPathPattern = /^\/[A-Za-z0-9_./@+=:,-]+$/;
const maxArchiveBytes = 32 * 1024 * 1024;
const timeoutMs = 45_000;
const maxOutputBytes = 64 * 1024;

function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function checked(installation: ReaperInstallation): void {
  if (!targetPattern.test(installation.sshTarget)) throw new Error("ssh target must be a safe SSH alias or user@host");
  if (!idPattern.test(installation.installationId)) throw new Error("invalid reaper installation id");
  if (!envPathPattern.test(installation.environmentFile) || installation.environmentFile.includes("..")) throw new Error("environment file must be a safe absolute path");
}
function resultText(result: ReaperTransportResult): string { return [result.stdout, result.stderr].filter(Boolean).join("\n").trim(); }
function command(script: string, args: string[]): string { return `sh -c ${quote(script)} -- ${args.map(quote).join(" ")}`; }
function installDirectory(id: string): string { return `$HOME/.local/share/pi-github-runners/${id}`; }
function unitName(id: string): string { return `pi-github-runners-${id}.service`; }

export const sshTransport: ReaperTransport = async ({ sshTarget, command: remoteCommand, stdin, timeoutMs: timeout, maxOutputBytes: maxOutput }) => await new Promise((resolveResult, reject) => {
  const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", sshTarget, remoteCommand], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0); let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0); let settled = false;
  const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
    const next = Buffer.concat([current, chunk]);
    if (next.byteLength > maxOutput) { child.kill("SIGTERM"); return next.subarray(0, maxOutput); }
    return next;
  };
  const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (error) reject(error); else resolveResult({ code: child.exitCode ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
  };
  child.once("error", finish);
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  child.once("close", () => finish());
  child.stdin.once("error", () => undefined);
  child.stdin.end(stdin);
});

export const reaperInstallationId = canonicalReaperInstallationId;

function serializableSettings(settings: RunnerSettings): Record<string, unknown> {
  const { sourcePath: _sourcePath, policies: _policies, reaper: _reaper, ...value } = settings;
  return value;
}
async function configPayload(binding: RepositoryBinding, settings: RunnerSettings): Promise<Buffer> {
  const explicit = settings.sizes.length === 0;
  const materialized = explicit ? await materializePolicies(binding, settings) : undefined;
  try {
    const policies = explicit ? await Promise.all((materialized?.policies ?? []).map(async (policy) => ({ name: policy.name, yaml: await readFile(policy.path, "utf8") }))) : undefined;
    if (explicit && !policies?.length) throw new Error("remote reaper requires explicit policies or generated runner sizes");
    const payload = { version: 1 as const, binding: { root: "." as const, repository: binding.repository }, settings: { ...serializableSettings(settings), policies: [] }, ...(policies?.length ? { policies } : {}) };
    parseReaperConfig(payload, "/installed/config.json");
    return Buffer.from(JSON.stringify(payload) + "\n");
  } finally { await materialized?.cleanup(); }
}
async function run(transport: ReaperTransport, sshTarget: string, script: string, args: string[], stdin?: Buffer, timeout = timeoutMs): Promise<ReaperTransportResult> {
  const response = await transport({ sshTarget, command: command(script, args), stdin, timeoutMs: timeout, maxOutputBytes });
  return response;
}
function mustSucceed(stage: string, value: ReaperTransportResult): void { if (value.code !== 0) throw new Error(`${stage} failed${resultText(value) ? `: ${resultText(value)}` : ""}`); }

const preflightScript = `set -eu
id=$1
env=$2
case "$HOME" in /*) ;; *) exit 20;; esac
case "$HOME" in *[!A-Za-z0-9_./-]*) exit 24;; esac
case "$env" in *[%[:space:]]*|*[!A-Za-z0-9_./@+=:,-]*) exit 25;; esac
command -v node >/dev/null
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&(b>19||(b===19&&c>=0)))?0:1)'
command -v npm >/dev/null
command -v flock >/dev/null
systemctl --user show-environment >/dev/null
[ "$(loginctl show-user "$(id -u)" -p Linger --value)" = yes ]
[ -f "$env" ] && [ ! -L "$env" ]
[ "$(stat -c %u "$env")" = "$(id -u)" ]
[ "$(stat -c %a "$env")" = 600 ]
awk 'BEGIN { h=0; g=0; m=0; ok=1 } /^[[:space:]]*($|#)/ { next } !/^[A-Za-z_][A-Za-z0-9_]*=.*/ { ok=0; next } /^HCLOUD_TOKEN=/ { h=1 } /^RUNNER_MANAGER_GITHUB_TOKEN=/ { g=1 } /^RUNNER_MANAGER_ALLOW_MUTATIONS=1$/ { m=1 } END { exit !(ok && h && g && m) }' "$env"
base="$HOME/.local/share/pi-github-runners/$id"
case "$env" in "$base"|"$base"/*) exit 21;; esac
if [ -e "$base" ]; then [ -f "$base/.pi-reaper-owner" ] && [ "$(cat "$base/.pi-reaper-owner")" = "$id" ] || exit 22; fi
unit="$HOME/.config/systemd/user/pi-github-runners-$id.service"
if [ -e "$unit" ]; then grep -Fqx "X-Pi-GitHub-Runners-Installation=$id" "$unit" || exit 23; fi`;

export const installScript = `set -eu
id=$1
env=$2
base="$HOME/.local/share/pi-github-runners/$id"
parent=$(dirname "$base")
unit="$HOME/.config/systemd/user/pi-github-runners-$id.service"
mkdir -p "$parent" "$HOME/.config/systemd/user"
exec 9>"$parent/.\${id}.install.lock"
flock -x 9
[ ! -e "$base" ] || { [ -f "$base/.pi-reaper-owner" ] && [ "$(cat "$base/.pi-reaper-owner")" = "$id" ]; }
[ ! -e "$unit" ] || grep -Fqx "X-Pi-GitHub-Runners-Installation=$id" "$unit"
stage=$(mktemp -d "$parent/.\${id}.stage.XXXXXX")
backup="$parent/.\${id}.backup.$$"
unitbackup="$unit.backup.$$"
unitstage="$parent/.\${id}.unit.$$"
hadbase=0
hadunit=0
wasactive=0
basebackedup=0
unitbackedup=0
newbase=0
newunit=0
mutated=0
cleanup() { status=$?; if [ "$status" -ne 0 ] && [ "$mutated" = 1 ]; then systemctl --user stop "pi-github-runners-$id.service" >/dev/null 2>&1 || true; if [ "$hadunit" = 0 ] && [ "$newunit" = 1 ]; then systemctl --user disable "pi-github-runners-$id.service" >/dev/null 2>&1 || true; fi; [ "$newunit" = 0 ] || rm -f "$unit"; [ "$newbase" = 0 ] || rm -rf "$base"; [ "$basebackedup" = 0 ] || mv "$backup" "$base"; [ "$unitbackedup" = 0 ] || mv "$unitbackup" "$unit"; systemctl --user daemon-reload >/dev/null 2>&1 || true; [ "$wasactive" = 0 ] || systemctl --user start "pi-github-runners-$id.service" >/dev/null 2>&1 || true; fi; rm -rf "$stage" "$unitstage"; exit "$status"; }
trap cleanup EXIT HUP INT TERM
tar -xzf - -C "$stage" --no-same-owner --no-same-permissions
[ -f "$stage/package.json" ] && [ -f "$stage/package-lock.json" ] && [ -f "$stage/dist/reaper-cli.js" ]
printf '%s\n' "$id" > "$stage/.pi-reaper-owner"
chmod 700 "$stage"
chmod 600 "$stage/config.json" "$stage/.pi-reaper-owner"
( cd "$stage" && npm ci --omit=dev --ignore-scripts --legacy-peer-deps )
( cd "$stage" && node --input-type=module -e 'import("./dist/reaper-runtime.js").then(({loadReaperConfig}) => loadReaperConfig(process.argv[1]))' "$stage/config.json" )
if [ -f "$base/.prewarm.json" ]; then cp "$base/.prewarm.json" "$stage/.prewarm.json"; chmod 600 "$stage/.prewarm.json"; fi
cat > "$unitstage" <<EOF
[Unit]
Description=Pi GitHub runners reaper $id
[Service]
Type=simple
X-Pi-GitHub-Runners-Installation=$id
ExecStart=/usr/bin/env node $base/dist/reaper-cli.js serve --config $base/config.json --env-file $env
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
EOF
chmod 600 "$unitstage"
[ ! -e "$base" ] || hadbase=1
[ ! -e "$unit" ] || hadunit=1
if systemctl --user is-active --quiet "pi-github-runners-$id.service"; then wasactive=1; systemctl --user stop "pi-github-runners-$id.service"; fi
mutated=1
if [ "$hadbase" = 1 ]; then mv "$base" "$backup"; basebackedup=1; fi
if [ "$hadunit" = 1 ]; then mv "$unit" "$unitbackup"; unitbackedup=1; fi
mv "$stage" "$base"; newbase=1
mv "$unitstage" "$unit"; newunit=1
systemctl --user daemon-reload
systemctl --user enable "pi-github-runners-$id.service"
systemctl --user start "pi-github-runners-$id.service"
systemctl --user is-active --quiet "pi-github-runners-$id.service"
[ "$basebackedup" = 0 ] || rm -rf "$backup"
[ "$unitbackedup" = 0 ] || rm -f "$unitbackup"
mutated=0`;

function packageRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return moduleDirectory.endsWith("/dist") ? dirname(moduleDirectory) : moduleDirectory;
}
async function newestSource(root: string): Promise<number> {
  const paths = [...(await readdir(root)).filter((name) => name.endsWith(".ts")), "src"];
  let newest = 0;
  const visit = async (relative: string): Promise<void> => {
    const entry = await stat(join(root, relative));
    if (entry.isDirectory()) for (const name of await readdir(join(root, relative))) await visit(join(relative, name));
    else if (relative.endsWith(".ts") && !relative.includes("/test/")) newest = Math.max(newest, entry.mtimeMs);
  };
  await Promise.all(paths.map(visit));
  return newest;
}
async function assertCurrentBuild(root: string): Promise<void> {
  const required = ["dist/index.js", "dist/reaper-cli.js", "dist/src/cli.js"];
  const outputs = await Promise.all(required.map(async (file) => {
    try { return await stat(join(root, file)); } catch { throw new Error(`compiled reaper artifact is missing ${file}; run npm run build before deploying`); }
  }));
  if (Math.min(...outputs.map((entry) => entry.mtimeMs)) < await newestSource(root)) throw new Error("compiled reaper artifacts are stale; run npm run build before deploying");
}
export async function packReaper(config: Buffer, root = packageRoot()): Promise<Buffer> {
  await assertCurrentBuild(root);
  const staging = await mkdtemp(join(tmpdir(), "pi-reaper-package-"));
  try {
    await Promise.all([cp(join(root, "package.json"), join(staging, "package.json")), cp(join(root, "package-lock.json"), join(staging, "package-lock.json")), cp(join(root, "dist"), join(staging, "dist"), { recursive: true })]);
    await writeFile(join(staging, "config.json"), config, { mode: 0o600 });
    await validatePackage(staging);
    return await archiveDirectory(staging);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
async function defaultPack(config: Buffer): Promise<Buffer> { return await packReaper(config); }
async function archiveDirectory(directory: string): Promise<Buffer> { return await new Promise<Buffer>((resolveArchive, reject) => { const child = spawn("tar", ["-czf", "-", "-C", directory, "."], { stdio: ["ignore", "pipe", "pipe"] }); const chunks: Buffer[] = []; let size = 0; let error = ""; child.stdout.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > maxArchiveBytes) child.kill("SIGTERM"); else chunks.push(chunk); }); child.stderr.on("data", (chunk) => { error += String(chunk); }); child.once("error", reject); child.once("close", (code) => code === 0 ? resolveArchive(Buffer.concat(chunks)) : reject(new Error(`tar packaging failed: ${error.trim() || "archive limit exceeded"}`))); }); }
async function validatePackage(directory: string): Promise<void> { const allowed = new Set(["package.json", "package-lock.json", "config.json"]); const visit = async (path: string, relative = ""): Promise<void> => { for (const name of await readdir(path)) { const child = join(path, name); const rel = relative ? `${relative}/${name}` : name; const entry = await lstat(child); if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("reaper package contains unsafe entries"); if (entry.isDirectory()) { if (rel !== "dist" && !rel.startsWith("dist/")) throw new Error(`reaper package contains disallowed path: ${rel}`); await visit(child, rel); } else if (!allowed.has(rel) && !rel.startsWith("dist/")) throw new Error(`reaper package contains disallowed file: ${rel}`); } }; await visit(directory); for (const file of ["package.json", "package-lock.json", "config.json", "dist/index.js", "dist/reaper-cli.js", "dist/src/cli.js"]) { try { await stat(join(directory, file)); } catch { throw new Error(`reaper package is missing ${file}`); } } }

export async function installReaper(binding: RepositoryBinding, settings: RunnerSettings, request: { sshTarget: string; environmentFile: string }, deps: ReaperDependencies = {}): Promise<ReaperInstallation> {
  const installation: ReaperInstallation = { sshTarget: request.sshTarget, environmentFile: request.environmentFile, installationId: reaperInstallationId(binding, settings) }; checked(installation);
  const transport = deps.transport ?? sshTransport; const timeout = deps.timeoutMs ?? timeoutMs;
  mustSucceed("remote preflight", await run(transport, installation.sshTarget, preflightScript, [installation.installationId, installation.environmentFile], undefined, timeout));
  const config = await configPayload(binding, settings); const archive = await (deps.pack ?? defaultPack)(config);
  if (archive.byteLength > maxArchiveBytes) throw new Error("installer archive exceeds 32 MiB limit");
  mustSucceed("remote install", await run(transport, installation.sshTarget, installScript, [installation.installationId, installation.environmentFile], archive, timeout));
  return installation;
}

const ownedScript = `set -eu
id=$1
env=$2
base="$HOME/.local/share/pi-github-runners/$id"
parent=$(dirname "$base")
unit="$HOME/.config/systemd/user/pi-github-runners-$id.service"
[ -f "$base/.pi-reaper-owner" ] && [ "$(cat "$base/.pi-reaper-owner")" = "$id" ]
[ -f "$unit" ] && grep -Fqx "X-Pi-GitHub-Runners-Installation=$id" "$unit"`;
export async function uninstallReaper(installation: ReaperInstallation, deps: ReaperDependencies = {}): Promise<void> {
  checked(installation); const transport = deps.transport ?? sshTransport; const script = `${ownedScript}\nexec 9>"$parent/.\${id}.install.lock"\nflock -x 9\nsystemctl --user disable --now "pi-github-runners-$id.service"\nrm -f "$unit"\nrm -rf "$base"\nsystemctl --user daemon-reload`;
  mustSucceed("remote uninstall", await run(transport, installation.sshTarget, script, [installation.installationId, installation.environmentFile], undefined, deps.timeoutMs ?? timeoutMs));
}
export async function reaperStatus(installation: ReaperInstallation, deps: ReaperDependencies = {}): Promise<string> {
  checked(installation); const transport = deps.transport ?? sshTransport; const result = await run(transport, installation.sshTarget, `${ownedScript}\nsystemctl --user is-active "pi-github-runners-$id.service"`, [installation.installationId, installation.environmentFile], undefined, deps.timeoutMs ?? timeoutMs); return resultText(result) || (result.code === 0 ? "active" : "inactive");
}
function validRequest(request: ReaperRequest): void { if (!request || !["status", "ensure", "reconcile", "drain", "destroy", "startup"].includes(request.operation) || (request.policy !== undefined && (!/^[A-Za-z0-9_.-]{1,64}$/.test(request.policy))) || (request.capacity !== undefined && (!Number.isInteger(request.capacity) || request.capacity < 0 || request.capacity > 100)) || (request.instance !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(request.instance)) || (request.apply !== undefined && typeof request.apply !== "boolean") || (request.expectedPlanFingerprint !== undefined && !/^[A-Za-z0-9_-]{8,256}$/.test(request.expectedPlanFingerprint))) throw new Error("invalid reaper request"); }
export async function requestReaper(installation: ReaperInstallation, request: ReaperRequest, deps: ReaperDependencies = {}): Promise<{ code: number; text: string }> {
  checked(installation); validRequest(request); parseReaperRequest(request); const input = Buffer.from(JSON.stringify(request)); if (input.byteLength > 64 * 1024) throw new Error("reaper request exceeds 64 KiB"); const transport = deps.transport ?? sshTransport;
  const script = `${ownedScript}\nexec 9>"$parent/.\${id}.install.lock"\nflock -s 9\nexec node "$base/dist/reaper-cli.js" request --config "$base/config.json" --env-file "$env"`;
  const result = await run(transport, installation.sshTarget, script, [installation.installationId, installation.environmentFile], input, deps.timeoutMs ?? timeoutMs); return { code: result.code, text: resultText(result) };
}
