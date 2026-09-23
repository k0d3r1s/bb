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

  `thread/tokenUsage/updated` is a prunable event type. The pruner keeps at most
  two of them per thread below its cutoff, so the event store is a window onto
  recent usage rather than a record of it. Anything that polls the event log for
  spend is racing deletion. The server sees each usage event before it is
  pruned, so it records the total then.

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

  `bb spend backfill` replays the usage events still in the store. It is safe to
  run repeatedly and safe to run alongside live traffic. It reports how many
  threads it could only record a floor for. There is no way to see a deleted
  row, so a thread is called complete only when that can be proved: it has not
  reached the pruner's smallest keep-recent window, so the pruner cannot have
  run; or the rollup was running when the thread emitted its very first usage
  event. Everything else is reported as partial and its total read as a floor.
