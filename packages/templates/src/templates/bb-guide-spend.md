---
kind: instruction
title: bb Guide Spend
summary: Token and usage totals the server records.
intent: Help agents read recorded spend and understand what the numbers do and do not cover.
editingNotes: Keep accurate against apps/server/src/routes/spend.ts and bb spend --help.
---
Spend commands

bb records per-thread, per-provider, per-model, per-day token totals as events
are stored.

  bb spend [--by day|thread|provider|model] [--from <day>] [--to <day>]
  bb spend [--thread <id>] [--provider <id>] [--json]
  bb spend backfill [--json]

Days are local calendar days on the machine running the server. Each stored row
also carries the first and last event time behind it, so a consumer in another
timezone can tell whether a row straddles its own day boundary.

Why the server records this:

  `thread/tokenUsage/updated` is a prunable event type. The periodic usage
  pruner deletes every one of them in a thread except the latest root-turn
  reading, so the event store is a window onto recent usage rather than a
  record of it. Anything that polls the event log for spend is racing deletion.
  The server sees each usage event before it is pruned, so it records the total
  then.

How readings are counted:

  Each reading carries the usage of its own request and a running total for
  its provider thread. bb records the request's usage only when the running
  total moves past the highest total it already counted for that provider
  thread, or when the running total restarts: it is below the previous total
  and equal to the reading's own usage, as after a provider process restart.
  A restart-shaped reading identical to one already stored for the same turn
  is a retried delivery and is not counted. A daemon that re-sends a batch
  the server already committed therefore adds nothing.

Grouping:

  `--by day` lists days newest first. `--by thread`, `--by provider` and
  `--by model` list the largest total first. The coverage line honours
  `--thread` and `--provider` as well as the day window.

What the columns mean:

  Fresh input, cached input, output and reasoning output are disjoint counts.
  Providers disagree about whether cached input sits inside the input count;
  bb normalises to disjoint when it records the row, so the numbers are
  comparable across providers.

  Weighted units apply the published price ratios - fresh input 1, cached input
  0.1, output 5. They are a cost proxy, not money.

  Dollars come from `fork_spend_prices`, which ships empty, so `bb spend` shows
  no dollar column until you put a rate in it. bb does not guess one: a
  subscription has no per-token rate to apply, and a guessed figure reads as
  fact. Insert a row per provider and model with input, cached-input and output
  dollars per million tokens to turn the column on. A grouped row reports no
  dollars if anything behind it is unpriced, rather than showing a partial sum
  as a total.

  Providers that report no token usage at all, such as ACP agents, are absent
  rather than estimated. `bb spend` reports coverage so "no data" is visibly
  different from "no spend".

Backfill:

  `bb spend backfill` replays the usage events still in the store. Each thread
  is replayed in its own transaction, so it is safe to run repeatedly, safe to
  run alongside live traffic, and an interrupted run does not count anything
  twice. It reports how many threads it could only record a floor for.

When a thread counts as complete:

  There is no way to see a deleted row, so a thread is complete only when that
  can be proved, in one of two ways:

  - Live: the rollup was running when the thread emitted its first usage
    event. That holds when no earlier usage event of the thread is stored and
    the thread has never had a message edited, or when every provider thread
    already recorded for it is complete. Event count and later pruning do not
    change this.
  - Backfill: the thread's stored event sequence numbers run from 1 to its
    latest event without a gap and the thread has never had a message edited,
    so nothing of it was ever deleted. Any gap, whichever event type the pruner
    removed, leaves the thread partial.

  A thread with several provider threads is complete only when all of them
  are. Complete never reverts to partial; a backfill can only upgrade a thread.
  Everything else is reported as partial and its total read as a floor.
