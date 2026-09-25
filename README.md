# exactly-once

**Agents propose. The database decides.**

Exactly-once, domain-checked commits for AI agent actions.

> Status: the name is reserved at `0.0.1`. The real v0.1 (propose / commit / get over Postgres) is being built in the open during the next weeks. Follow along at [roddcode.com](https://roddcode.com).

## What it will guarantee

- No duplicated agent actions, ever: unique idempotency keys and immutable receipts.
- The database decides, not the model: domain validation against live state.
- Holds with TTL and clean rejections with alternatives.
- A full audit trail of every proposal, decision and commit.

## License

MIT
