# Contributing to n8n-nodes-observability

Thanks for your interest. Contributions of every size are welcome — bug reports,
documentation fixes, and code.

By participating you agree to the
[Code of Conduct](https://github.com/nonagenticai/.github/blob/main/CODE_OF_CONDUCT.md).

## Before you start

- **Open an issue before a large change.** It saves you writing code that will not be merged.
- **One concern per pull request.**
- **Keep the tree green.** If a check fails, say so in the PR rather than working around it.
- **No credentials, ever.** Not in code, tests, fixtures, CI, or commit messages.

## Development setup

```bash
git clone https://github.com/nonagenticai/n8n-nodes-observability.git
cd n8n-nodes-observability
npm ci --registry=https://registry.npmjs.org/
npm run build
```

## Tests and lint

```bash
npm test
npm run lint
```

Both must pass before a pull request is ready for review. CI runs the same gates on
GitHub-hosted runners.

## Branches and commits

Branch names: `feat/`, `fix/`, `docs/`, `chore/`, `ci/`. Commit messages follow
`type(scope): summary` in the imperative mood.

This project uses the [Developer Certificate of Origin](https://developercertificate.org).
Sign off every commit:

```bash
git commit -s -m "fix(node): reject an empty response"
```

## Pull requests

Describe the problem before the solution, link the issue it closes, and add or update tests
for behaviour changes. A maintainer reviews every PR.

## Reporting a security issue

Do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under Apache-2.0, as described
in [LICENSE](LICENSE).
