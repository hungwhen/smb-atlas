# SMB Atlas

A local Windows application for inventorying SMB shares across IP addresses and subnets, using one username and password. Includes a single browser UI, live progress, host outcomes, searchable metadata, file type and size statistics, sorting, pagination, and CSV/JSON exports. No npm packages or cloud service are required.

## Run

Requires Windows 10/11 or Windows Server with Windows PowerShell 5.1 and an existing local Node.js 20 or newer runtime. The launcher also recognizes the runtime already bundled with Codex when available. No package installation or asset download is needed.

1. Extract the complete folder, then double-click **Start-SMBAtlas.cmd**. The launcher opens the browser automatically.
2. Keep the terminal open. The app is available at **http://127.0.0.1:8787**.
3. Enter your account, targets, and options, then start the scan. Use **Cancel** to stop early. Partial results remain available to search and export.
4. Press **Ctrl+C** in the terminal to stop the app. Restarting clears all results.

Alternatively, run `node server.mjs` or `npm start` from this folder. For a different port, set the `PORT` environment variable before starting. The server always binds to 127.0.0.1. It is designed for a single local user, rather than deployment on a shared web server.

## Credentials and targets

Use `DOMAIN\username` with an empty Domain field; or a username and separate Domain field; or `user@example.com` with an empty Domain field. For a server-local account, use its computer name as the Domain and target that server. Accounts with an empty password are not supported. Native Windows outbound network authentication is used. Authentication happens when a share is accessed, rather than when the form is submitted.

Example targets (replace these with your organization's addresses):

```text
# File servers
10.20.0.12
10.20.1.0/24
10.21.0.10, 10.21.0.11
2001:db8::12
```

Separate targets with whitespace, commas, or semicolons; `#` starts a line comment. Import accepts a plain text list or CSV. CSV headers such as Target, IP, Subnet, CIDR, or Address select the target column; without a recognized header, all cells are treated as targets. Hostnames, IP ranges such as `10.0.0.1-20`, and URLs are not accepted. IPv4 and IPv6 are supported. Targets are normalized, deduplicated, and sorted. IPv4 CIDRs exclude network and broadcast addresses except /31 and /32; IPv6 includes every address. The default maximum is 4,096 unique hosts. Oversized subnets are rejected before expansion.

The interface is written from scratch using local HTML, CSS, and JavaScript. It uses system fonts and locally authored inline SVG, with no UI frameworks, downloaded templates, icon packages, external assets, or CDN requests. The server uses Node.js built-ins and native Windows APIs. The included launchers do not download or install anything.

Use **Scan settings** to collapse or reopen the scan form. The inventory expands into the available space, and existing form values stay intact when the settings are hidden.

## Visual overview

The **Overview** tab opens by default and presents interactive charts:

- **File type mix:** a donut and legend showing the largest file types, with smaller groups combined as Other.
- **File size distribution:** six size ranges shown as a column chart.
- **Top hosts:** a horizontal comparison of hosts with matching files.
- **Scan health:** a status breakdown across every target in the scan, independently of file filters.
- **Share map:** choose a host to see its shares and the matching file counts and sizes.

Switch between **Storage** and **Files** to compare bytes or file counts. Select a file type, host, or share to open the matching inventory. Search and filters apply across every result page; scan health remains explicitly scoped to the whole scan. The host chart groups hosts beyond the largest eight as Other, and the share map combines shares beyond the largest six. Combined groups retain their full totals. Shares and hosts without matching files are excluded from the file charts.

Charts update during a scan. They use locally generated SVG and readable legends, without downloaded chart libraries or online services. JSON exports include the host/share totals used by the charts. The share map describes the file inventory; it does not discover physical network routes.

## Sorting and file type statistics

Use the inventory's **Sort by** control or clickable column headings to sort by file type, size, name, path, host, share, or modification time. Toggle the direction to put the largest files first or reverse the order. Sorting applies to the full matching inventory, including rows beyond the current page.

The **File types** tab lists every matching extension with its file count, total size, average file size, largest file size, and percentage of the matching storage. Sort this summary by its columns to find the most common types or the types consuming the most space. Use **View files** for a type to filter the inventory to that extension. Files without an extension appear as **No extension**.

Size distribution groups matching files into empty files, under 1 MB, 1–10 MB, 10–100 MB, 100 MB–1 GB, and 1 GB or larger, with counts and total bytes for each range. The UI uses binary size units (1 MB = 1,048,576 bytes; 1 GB = 1,073,741,824 bytes).

Statistics include **all files matching the current search and filters**, across every result page. Folders are excluded. Reset the filters and clear the search to see the complete scan. Statistics update as a live scan discovers files; incomplete scans describe only the files collected so far. JSON exports include these statistics alongside the matching entries.

## Inventory behavior

- Probes TCP 445, then enumerates disk shares and their file metadata. It never opens file contents, downloads files, changes permissions, or creates/deletes remote files. Directory listings and authentication can produce normal server audit records.
- Files include their name, UNC path, host, share, size, extension, and modification time. Folder rows are optional. Hidden/admin shares ending in `$` are excluded unless enabled. NTFS hidden files inside selected shares are included.
- Optional explicit share names bypass share discovery, useful when your account can access a known share but cannot enumerate shares. Enable hidden shares when explicitly targeting `C$`, `ADMIN$`, or another `$` share.
- A depth of 0 lists immediate entries in each share root. Default depth is 8, with a maximum of 32. Directories beyond the limit are skipped and reported as partial. Directory reparse points are skipped to prevent traversal loops. DFS referrals use the Windows SMB client's behavior and may resolve to backend servers; use concrete server shares when exact endpoint scope is required.
- Default concurrency is 4 hosts (maximum 16); each host has a 90-second worker deadline (configurable 5–600 seconds) plus a 3-second TCP probe. The deadline includes worker startup, authentication, discovery, and enumeration of all shares on that host. Cancel terminates active workers and prevents queued hosts from starting.
- Default inventory limit is 50,000 rows across the scan (maximum 250,000). Limits, deadlines, inaccessible paths, and skipped directories can make a scan partial. Error details are shown in the UI. Unreachable means TCP 445 did not answer the probe; it does not prove the server is offline.
- Explicit credential/account rejection stops the remaining queue; already concurrent hosts may have attempted authentication. There are no password retries. Other access-denied errors are reported for the affected paths. Windows policies for SMB versions, signing, encryption, and authentication remain in force; the app does not weaken them. IP-based connections can require NTLM, so environments that prohibit it may reject these scans.
- Export applies the current search and filters to **all matching rows**, including rows beyond the current page. JSON also contains scan status and errors. CSV protects spreadsheet formula cells and includes a UTF-8 BOM for Excel.

## Local data handling

The application sends credentials only to its local server over loopback. Credentials are passed to isolated Windows workers through stdin, not command arguments, and are never intentionally logged, written to disk, included in exports, or saved in browser storage. The password field clears once a scan starts. Credentials remain in process/Windows authentication memory while scanning; JavaScript and Windows do not provide a guarantee of immediate memory erasure. Results remain in memory until cleared, replaced, or the app stops. Exports are saved only when you request them.

API requests require a random per-process session token. Host and Origin validation, same-origin restrictions, and a content security policy protect the local interface from other websites. Any local process running as your user can still access the local app; do not expose it through a proxy or port forward. The current implementation keeps a single scan in memory, and a new scan replaces the previous results. The demo is clearly labeled and entirely synthetic; it does not contact any hosts.

## Troubleshooting

If no shares appear, check TCP 445 reachability, the account's share and NTFS listing rights, and Windows authentication policies. Try an explicit known share when share discovery is denied. A local administrator account may be restricted by remote UAC policies. The app does not change those policies. Run from a machine connected to your organization’s network or VPN. Administrator privileges on the scanning PC are usually unnecessary.

PowerShell must be allowed to execute the included worker and compile its small native API wrapper with `Add-Type`. Application control, constrained language mode, or endpoint protection can prevent it; the app will report a worker failure. No execution-policy setting is changed globally.

## Verification and implementation

Run `npm test` (or `node --test`) from this directory. Tests use synthetic data and injected workers; they do not scan your network or test a real organization's credentials. Browser demo verification does not establish compatibility with your specific SMB servers or policies.

The implementation uses Windows [LogonUser with outbound credentials](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-logonuserw) and [NetShareEnum at level 1](https://learn.microsoft.com/en-us/windows/win32/api/lmshare/nf-lmshare-netshareenum), plus read-only directory metadata enumeration. All source is included: `server.mjs` handles the local API, `lib/` handles targets and scan orchestration, `scripts/scan-host.ps1` handles SMB access, and `public/` contains the UI.
