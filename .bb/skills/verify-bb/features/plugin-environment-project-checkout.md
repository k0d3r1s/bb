# Project checkout environment provider

Status: **not live-verified in this change**.

## Setup and entry points

Use a disposable project source and select the Project checkout environment provider.

## Source

- `plugins/environment-project-checkout/package.json`
- `plugins/environment-project-checkout/`

## Feature recipes

| Feature | Drive                                          | Observable success                                                         |
| ------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Attach  | Spawn a thread in the project checkout.        | The environment references the existing source without claiming ownership. |
| Reuse   | Reuse the environment from another thread.     | Both threads resolve the same checkout and machine.                        |
| Removal | Delete the environment after its threads stop. | BB removes its record without deleting the checkout.                       |

## Evidence and cleanup

Record environment and source paths. Preserve the attached project checkout and its Git state.
