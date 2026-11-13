# Security policy

## Supported versions

n8n-nodes-observability is in active development. Security fixes land on the latest release line only; older
tags are not patched. If you are running an older version, the fix is to upgrade.

| Version | Supported |
|---------|-----------|
| latest `0.2.0` | yes |
| older tags | no |

## Reporting a vulnerability

Please report privately, through GitHub's advisory flow:

**https://github.com/nonagenticai/n8n-nodes-observability/security/advisories/new**

Do not open a public issue, and do not post details in a discussion. A public issue turns
a fixable bug into a disclosure.

Please include a description of the issue and its impact, steps to reproduce or a proof of
concept, the affected version(s) or commit hashes, and any suggested mitigation.

## What to expect

| Stage | Target |
|-------|--------|
| Acknowledgement of your report | 5 business days |
| Initial triage and severity assessment | 10 business days |
| Fix for high-severity issues | 30 days |
| Coordinated public disclosure | 90 days, or sooner by agreement |

## Scope

In scope: the code in this repository and the ways it can be made to misbehave. Out of
scope: vulnerabilities in the n8n runtime or in third-party dependencies (report those
upstream).

## Deployment-specific responsibility

This repository is source code. Whoever operates a deployment of it is responsible for that
deployment's configuration, its network exposure, and its credentials.
