# Manually dispatched drafts

Status: **not live-verified in this inventory refresh**.

## Setup and entry points

Enable the built-in Drafts plugin and use disposable new-thread and existing-thread composers with inspectable queued messages.

## Source

- `plugins/drafts/package.json`
- `plugins/drafts/app.tsx`
- `plugins/drafts/server.ts`
- `plugins/drafts/PLUGIN_OVERVIEW.md`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Save a follow-up draft | Enter text and attachments in an existing thread, choose Save draft, and reload the thread. | The composer clears and one unscheduled Drafts-owned queued message preserves the submitted content. |
| Save a new-thread draft | Select a project, environment, provider, model, and permissions before saving from the new-thread composer. | The created thread remains queued without dispatch and retains every selected execution option. |
| Manage and dispatch | Edit, reorder, and delete disposable drafts, then use Send now on the remaining draft. | Each queue action affects only its target and Send now bypasses the Drafts wait exactly once. |
| Submission boundaries | Try an empty composer, a concurrent submit, and submission metadata owned by another plugin. | Empty or busy composers cannot save; unrelated plugin submissions proceed without being claimed as drafts. |

## Evidence and cleanup

Record the queue cards and source CLI output. Delete only the disposable drafts and threads created by the verification run.
