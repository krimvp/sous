# Security

## What sous does not protect against

Workers are not sandboxed. They run as you, with your shell, your files and your network, and a worker can forge an
approval, an answer or a cancel. This is by design for now, and the README says so under
[Before you trust it](README.md#before-you-trust-it). A report that only restates it is not a vulnerability.

## Reporting a vulnerability

Do not open a public issue. Report it privately with
[GitHub's private vulnerability reporting](https://github.com/krimvp/sous/security/advisories/new). Say which version
you ran, what you did and what happened.

Examples of what to report: `sous ui` serving a run to a request without its token or to another host, sous changing
your checkout or writing outside `.sous/` and its worktrees, or a credential written to a log or an export.

Fixes go into the latest release only.
