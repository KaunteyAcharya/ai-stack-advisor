# Contributing to AI Stack Advisor

Thank you for helping. The most useful contributions are corrections to the numbers the advisor relies on, because prices and statistics go out of date quickly.

## What helps most

- **A price that has changed.** Open an issue or a pull request with the official vendor pricing page and the date you checked it.
- **A better source** for a labour cost, tax rate or exchange rate: an official statistics office, tax authority or central bank page.
- **A bug.** Describe what you entered and what you expected. The "Download inputs + results (JSON)" button or a shareable link from the advisor makes it easy to reproduce.
- **A better assumption or formula.** Explain the reasoning and give a source where there is one.

## Rules for every change

- **Never invent prices.** Every price in `data/prices.json` needs an official `source_url` and a `last_verified` date, or `is_sample: true`.
- **Keep it browser-only.** No backend, no API keys, no analytics, tracking or cookies, no scripts or styles from other sites, and no inline scripts (the Content Security Policy blocks them).
- **No new dependencies.** The site has no build step. Files in `assets/vendor/` and `scripts/vendor/` are updated by the maintainer only.
- **Changes to `.github/` workflows** get extra review and may be declined.
- **Keep the docs in step.** If you change a formula, update `docs/METHODOLOGY.md`. If you change the methodology or anything in `data/`, run `npm run docs:about` so the About page matches.
- **Run the checks** before opening a pull request:

  ```bash
  npm test
  node scripts/check-site.mjs .
  ```

- Keep pull requests small and focused on one thing.

Every pull request is reviewed and tested before it is merged, and nothing reaches the live site until then.

## Security

Please do not open a public issue for a security problem. Use **Report a vulnerability** on the repository's Security tab instead.

## Licence

Contributions are accepted under the project's [MIT licence](LICENSE).
