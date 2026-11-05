import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../scripts/scan-host.ps1', import.meta.url));
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsOnly = { skip: process.platform !== 'win32', timeout: 30_000 };
const syntheticCredentials = {
  username: 'smb-atlas-synthetic-user',
  password: 'SYNTHETIC-only-Secret-DoNotEcho-42',
  domain: 'SMB-ATLAS-TEST',
};

function runPowerShell(args, { input = '', env = {} } = {}) {
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'Text', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', ...args], {
    input, encoding: 'utf8', windowsHide: true, timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, SMB_ATLAS_WORKER_PATH: workerPath, ...env },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'The test worker must finish within its timeout.');
  return result;
}

function runScript(script, options) {
  const prefix = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n`;
  // Direct argv keeps this script separate from shell parsing. Unlike
  // -EncodedCommand, -Command does not serialize module startup progress to
  // stderr as CLIXML on Windows PowerShell 5.1.
  return runPowerShell(['-Command', prefix + script], options);
}

function events(result) {
  assert.equal(result.stderr, '', 'The worker must not emit raw PowerShell diagnostics.');
  return result.stdout.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

const extractFunctions = `
$source = Get-Content -LiteralPath $env:SMB_ATLAS_WORKER_PATH -Raw
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'The worker source did not parse.' }
foreach ($node in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($node.Name -in $functionNames) {
        $code = $node.Extent.Text
        if ($node.Name -eq 'Invoke-ShareInventory') {
            # The adapter changes only the in-memory test function. Production
            # keeps its IP-only UNC root and is never dot-sourced by this test.
            $code = [regex]::Replace($code, '(?m)^    \\$root = .*$', [Text.RegularExpressions.MatchEvaluator]{ param($match) '    $root = $UncHost' })
        }
        Invoke-Expression $code
    }
}
`;

test('Windows worker parses under Windows PowerShell 5.1', windowsOnly, () => {
  const result = runScript(`
$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($env:SMB_ATLAS_WORKER_PATH, [ref]$tokens, [ref]$parseErrors)
[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ errors = @($parseErrors | ForEach-Object { $_.Message }); version = $PSVersionTable.PSVersion.ToString() }))
`);
  assert.equal(result.status, 0);
  const [record] = events(result);
  assert.deepEqual(record.errors, []);
  assert.match(record.version, /^5\.1\./);
});

test('Windows native impersonation accepts stdin credentials without any network I/O', windowsOnly, () => {
  // NEW_CREDENTIALS does not validate the synthetic account locally. An explicit
  // hidden share is filtered before traversal, and bypasses NetShareEnum. No
  // network path is opened for either documentation-only IP literal.
  for (const host of ['192.0.2.1', '2001:db8::1']) {
    const result = runPowerShell(['-File', workerPath], {
      input: JSON.stringify({ host, ...syntheticCredentials, options: { shareNames: ['C$'], includeHiddenShares: false } }),
    });
    assert.equal(result.status, 0);
    const records = events(result);
    assert.equal(records.at(-1).status, 'complete');
    assert.equal(records.filter(event => event.type === 'share' || event.type === 'entry').length, 0);
    for (const secret of Object.values(syntheticCredentials)) assert.ok(!result.stdout.includes(secret));
  }
});

test('Windows malformed request errors never echo submitted credentials', windowsOnly, () => {
  const malformed = JSON.stringify({ host: '192.0.2.1', ...syntheticCredentials }).slice(0, -1) + ',not-valid-json}';
  const result = runPowerShell(['-File', workerPath], { input: malformed });
  assert.equal(result.status, 1);
  const records = events(result);
  assert.deepEqual(records.map(event => [event.type, event.status]), [['done', 'error']]);
  for (const secret of Object.values(syntheticCredentials)) {
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stderr.includes(secret));
  }
});

test('Windows request validation rejects UNC injection and out-of-range production options', windowsOnly, () => {
  for (const change of [
    { host: '192.0.2.1\\escape' },
    { options: { shareNames: ['share\\escape'] } },
    { options: { maxDepth: 33 } },
  ]) {
    const result = runPowerShell(['-File', workerPath], {
      input: JSON.stringify({ host: '192.0.2.1', ...syntheticCredentials, ...change }),
    });
    assert.equal(result.status, 1);
    assert.equal(events(result).at(-1).status, 'error');
  }
});

test('Windows local traversal adapter verifies metadata, depth limits, and folder rows', windowsOnly, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'smb-atlas-worker-'));
  try {
    mkdirSync(join(fixture, 'nested'));
    writeFileSync(join(fixture, "notes ' [α].txt"), 'synthetic file');
    writeFileSync(join(fixture, 'nested', 'b.csv'), 'synthetic,file');
    // Junction creation requires no administrator rights. A second path to the
    // nested directory must not duplicate files or escape normal traversal.
    symlinkSync(join(fixture, 'nested'), join(fixture, 'junction'), 'junction');
    const result = runScript(`
$functionNames = @('Get-SafeError', 'Write-WarningEvent', 'Invoke-ShareInventory')
${extractFunctions}
function Write-Event { param([hashtable]$Event) $script:testEvents.Add($Event) }
$cases = @(
    @{ depth = 0; folders = $false },
    @{ depth = 2; folders = $false },
    @{ depth = 2; folders = $true }
)
foreach ($case in $cases) {
    $script:hostName = '192.0.2.1'
    $script:warningCount = 0
    $script:hadErrors = $false
    $script:credentialFailed = $false
    $script:testEvents = New-Object 'System.Collections.Generic.List[hashtable]'
    Invoke-ShareInventory -Share 'fixture' -UncHost $env:SMB_ATLAS_FIXTURE_DIR -MaxDepth $case.depth -IncludeFolders $case.folders
    [Console]::Out.WriteLine((ConvertTo-Json -Depth 7 -Compress -InputObject @{ depth = $case.depth; folders = $case.folders; events = @($script:testEvents.ToArray()) }))
}
`, { env: { SMB_ATLAS_FIXTURE_DIR: fixture } });
    assert.equal(result.status, 0);
    const cases = events(result);
    assert.equal(cases.length, 3);
    const expected = [[1, 'partial'], [2, 'complete'], [4, 'complete']];
    for (const [index, record] of cases.entries()) {
      const rows = record.events.filter(event => event.type === 'entry').map(event => event.entry);
      assert.equal(rows.length, expected[index][0]);
      assert.equal(record.events.at(-1).status, expected[index][1]);
      for (const row of rows) {
        assert.equal(row.host, '192.0.2.1');
        assert.equal(row.share, 'fixture');
        assert.match(row.modified, /Z$/);
        assert.ok(Number.isFinite(Date.parse(row.modified)));
        assert.ok(row.path.startsWith(fixture));
        assert.ok(!row.path.includes('junction\\'), 'Directory reparse points must not be traversed.');
        if (row.kind === 'file') assert.equal(row.size, 14);
        else assert.equal(row.size, null);
      }
    }
    assert.ok(cases[0].events.some(event => event.type === 'warning' && /depth limit/.test(event.message)));
    assert.deepEqual(cases[1].events.filter(event => event.type === 'entry').map(event => event.entry.extension).sort(), ['.csv', '.txt']);
  } finally {
    // Remove only the owned, randomly named fixture directory.
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Windows legacy maxEntries option does not truncate a local inventory', windowsOnly, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'smb-atlas-worker-uncapped-'));
  try {
    for (let index = 0; index < 105; index++) {
      writeFileSync(join(fixture, `entry-${index}.txt`), 'synthetic file');
    }
    const result = runScript(`
$source = Get-Content -LiteralPath $env:SMB_ATLAS_WORKER_PATH -Raw
$rootPattern = '(?m)^    \\$root = .*$'
if ([regex]::Matches($source, $rootPattern).Count -ne 1) { throw 'The local-only root adapter could not be applied.' }
# Keep production request parsing and traversal, replacing only the UNC root
# in memory. The explicit share bypasses discovery; NEW_CREDENTIALS retains
# the current local identity and does not authenticate to any remote host.
$source = [regex]::Replace($source, $rootPattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) '    $root = $env:SMB_ATLAS_FIXTURE_DIR' })
& ([ScriptBlock]::Create($source))
`, {
      env: { SMB_ATLAS_FIXTURE_DIR: fixture },
      input: JSON.stringify({
        host: '192.0.2.1',
        ...syntheticCredentials,
        options: { shareNames: ['fixture'], maxEntries: 100 },
      }),
    });
    assert.equal(result.status, 0);
    const records = events(result);
    const rows = records.filter(event => event.type === 'entry').map(event => event.entry);
    assert.equal(rows.length, 105);
    assert.equal(new Set(rows.map(row => row.name)).size, 105);
    assert.ok(rows.every(row => row.path.startsWith(fixture)));
    assert.equal(records.findLast(event => event.type === 'share').status, 'complete');
    assert.equal(records.at(-1).status, 'complete');
    assert.ok(!records.some(event => event.type === 'warning' || event.status === 'partial'));
    for (const secret of Object.values(syntheticCredentials)) assert.ok(!result.stdout.includes(secret));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Windows account rejection signals stop-worthy auth failures and distinguishes access denial', windowsOnly, () => {
  const result = runScript(`
$functionNames = @('Get-SafeError', 'Write-Event')
${extractFunctions}
foreach ($code in @(1326, 1909, 1330, 1331, 1793, 5)) {
    $script:credentialFailed = $false
    $reason = Get-SafeError ([ComponentModel.Win32Exception]::new($code))
    Write-Event @{ type = 'done'; status = 'error'; errorCode = $code; error = $reason }
}
`);
  assert.equal(result.status, 0);
  const records = events(result);
  assert.equal(records.length, 6);
  for (const record of records) {
    assert.equal(record.authFailure === true, record.errorCode !== 5);
    assert.ok(record.error.length > 0);
  }
});
