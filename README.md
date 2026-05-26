# Futbot

Standalone Discord bot for Mario Strikers Competitive Rated matches and Futbot gear/role utilities.

This project is intentionally independent from the main bot: it has its own npm package, command registration, tests, start script and Git history. The SQL database remains the shared external contract.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill `FUTBOT_TOKEN`, `FUTBOT_ID`, database credentials and `COMPETITIVE_DB_SCHEMA`.
3. Install dependencies:

```powershell
npm install
```

## Run

```powershell
npm start
```

or use `teststart-futbot.bat`.

## Register Commands

```powershell
npm run commands:register
```

## Tests

```powershell
npm test -- --runInBand
```

## Competitive DB Operations

Competitive migration/reset/rebuild scripts live in `scripts/` and are exposed through `package.json` scripts. They operate only on the configured competitive schema and the shared `dbo.Player` identity table.
