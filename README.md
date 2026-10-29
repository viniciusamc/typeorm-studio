# typeorm-studio

> **Unofficial and vibe-coded.** typeorm-studio is an AI-assisted adapter that opens
> [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) on the database of a
> TypeORM project, built for NestJS apps. It finds your DataSource and `.env`, then runs the
> official, unmodified drizzle-kit; the UI is Drizzle's hosted Studio at
> `https://local.drizzle.studio`. Not affiliated with or endorsed by the Drizzle Team or TypeORM.

Status: work in progress, not published.

## Usage

```sh
npx typeorm-studio            # from your project or monorepo root
npx typeorm-studio --write    # Studio starts read-only; --write allows edits
npx typeorm-studio --dry-run  # find the DataSource, env and database, then stop
```

It looks for the DataSource file your `typeorm -d <file>` scripts use, loads `.env` files without
overriding your shell, reads the connection options, and checks the database before starting.
Only PostgreSQL is supported for now.

## What leaves your machine

Drizzle Studio's UI is a hosted web page. In our checks it sent a page view and an `init` event
(dialect, driver, UI settings) to its analytics, loaded Cloudflare's analytics script and sent one
Sentry request at load. Queries and rows go from your browser to the local server only, but this
is not a guarantee: the hosted page is closed source and can change at any time.

## License

MIT
