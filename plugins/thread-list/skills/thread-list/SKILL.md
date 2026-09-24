---
name: thread-list
description: "Inspect or change the sidebar thread list's layout preferences: organization mode, sort, section order, project groups, hidden groups, and collapsed groups."
---

# Thread list preferences

The Thread list plugin owns the sidebar's layout state. Read it with
`bb thread-list prefs list --json`; keys are `showProviderIcons`, `threadLifecycles`,
`organizationMode`, `environmentGrouping`, `chronologicalSort`, `sortDirection`,
`projectSort`, `projectSortDirection`, `projectGroups`, `sectionOrder`,
`manualSectionOrder`,
`machineSectionOrder`, `hiddenGroups` (including the built-in `threads` group),
`collapsedSections`, `collapsedProjects`, `collapsedThreads`,
`collapsedEnvironments`, `collapsedThreadSections`, `collapsedProjectGroups`,
and `collapsedMachines`.

```sh
bb thread-list prefs list [--json]
bb thread-list prefs get <key> [--json]
bb thread-list prefs set <key> <value> [--json]
bb thread-list prefs reset <key> [--json]
```

`set` takes JSON; a bare word is read as a string, so
`bb thread-list prefs set organizationMode machine` and
`bb thread-list prefs set manualSectionOrder '["pinned","sections","threads"]'`
both work. A value the key's schema rejects fails with
`invalid_preference_value` and leaves the stored value alone. Every open
window applies a change immediately. Sections themselves and a thread's
section are bb core state: use `bb thread section` and `bb thread update`.

On first load the plugin copies any non-default `sidebar.*` values from
`bb settings ui` once; after that the two are independent.

The header's Filter menu selects Active, Archived, or both; at least one must
remain selected. `bb thread-list prefs set threadLifecycles '["archived"]'`
shows archived threads, and `'["active","archived"]'` shows both. The default
is `'["active"]'`. Archived results load in pages; use Show more at the end
of the list. The same preference is available through `setPreference` RPC.

Organize → Rows → Provider icons toggles the icon before each thread title.
`showProviderIcons` defaults to `false`; use
`bb thread-list prefs set showProviderIcons true` to show them. Unknown
provider ids have no icon.

Thread sorting and project sorting are independent. `chronologicalSort` and
`sortDirection` order threads within project rows. `projectSort` accepts
`custom`, `alpha`, or `activity`; `projectSortDirection` controls automatic
project order without changing the stored drag order. Recent activity is the
latest visible, non-archived thread update in each project.

Project groups keep related projects together when organized by project.
`projectGroups` is a list of `{"id","name","projectIds"}` objects; ids must be
unique, names cannot be blank, and a project belongs to at most one group.
Groups render at their first project's position (or by group name / latest
member activity under automatic project sorting). `collapsedProjectGroups`
lists collapsed group ids. `set` replaces every group, so read the current
value first:

```sh
bb thread-list prefs get projectGroups --json
bb thread-list prefs set projectGroups '[{"id":"work","name":"Work","projectIds":["proj_a","proj_b"]},{"id":"bb","name":"bb","projectIds":["proj_c"]}]'
```

In the app, a project's **Move to group** menu assigns, creates, or clears its
group, and a group header's menu renames or ungroups it.
