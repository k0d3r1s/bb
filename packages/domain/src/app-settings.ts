import { z } from "zod";
import { completedTurnDisplaySchema } from "./completed-turn-display.js";
import { isValidGitBranchName } from "./git-checkout.js";

export const MANAGED_BRANCH_PREFIX_MAX_LENGTH = 64;

export const DEFAULT_MANAGED_BRANCH_PREFIX = "bb/";

export const PROVIDER_TURN_IDLE_WATCHDOG_MIN_MS = 5 * 60_000;
export const DEFAULT_PROVIDER_TURN_IDLE_NOTIFY_MS = 6 * 60 * 60_000;
export const DEFAULT_PROVIDER_TURN_IDLE_INTERRUPT_MS = 12 * 60 * 60_000;

export const managedBranchPrefixSchema = z
  .string()
  .max(MANAGED_BRANCH_PREFIX_MAX_LENGTH)
  .refine((prefix) => isValidGitBranchName(`${prefix}slug-thr_id`), {
    message: "Prefix must start a valid git branch name",
  });

export const appSettingsSchema = z
  .object({
    showKeyboardHints: z.boolean(),
    steerActiveThreadOnEnter: z.boolean(),
    showDiagnosticEvents: z.boolean(),
    providerOrder: z.array(z.string().min(1)),
    defaultProviderId: z.string().min(1).nullable(),
    providerCompletedTurnDisplay: z.record(
      z.string().min(1),
      completedTurnDisplaySchema,
    ),
    streamerMode: z.boolean(),
    telemetryEnabled: z.boolean(),
    managedBranchPrefix: managedBranchPrefixSchema,
    machineServerUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      })
      .nullable(),
    machineGitCredentialsEnabled: z.boolean(),
    defaultMachineAccess: z.string().min(1).nullable(),
    providerTurnIdleWatchdogEnabled: z.boolean(),
    providerTurnIdleNotifyMs: z
      .number()
      .int()
      .finite()
      .min(PROVIDER_TURN_IDLE_WATCHDOG_MIN_MS),
    providerTurnIdleInterruptMs: z
      .number()
      .int()
      .finite()
      .min(PROVIDER_TURN_IDLE_WATCHDOG_MIN_MS),
  })
  .strict();
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultAppSettings: AppSettings = {
  showKeyboardHints: true,
  steerActiveThreadOnEnter: true,
  showDiagnosticEvents: false,
  providerOrder: [],
  defaultProviderId: null,
  providerCompletedTurnDisplay: {},
  streamerMode: false,
  telemetryEnabled: true,
  managedBranchPrefix: DEFAULT_MANAGED_BRANCH_PREFIX,
  machineServerUrl: null,
  defaultMachineAccess: null,
  machineGitCredentialsEnabled: true,
  providerTurnIdleWatchdogEnabled: true,
  providerTurnIdleNotifyMs: DEFAULT_PROVIDER_TURN_IDLE_NOTIFY_MS,
  providerTurnIdleInterruptMs: DEFAULT_PROVIDER_TURN_IDLE_INTERRUPT_MS,
};

export const appSettingsUpdateSchema = z
  .union([
    appSettingsSchema.extend({
      telemetryEnabled: z.boolean().optional(),
      showUnhandledProviderEvents: z.boolean().optional(),
    }),
    appSettingsSchema.omit({ showDiagnosticEvents: true }).extend({
      telemetryEnabled: z.boolean().optional(),
      showUnhandledProviderEvents: z.boolean(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.providerTurnIdleInterruptMs <= value.providerTurnIdleNotifyMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerTurnIdleInterruptMs"],
        message: `providerTurnIdleInterruptMs (${value.providerTurnIdleInterruptMs}) must be greater than providerTurnIdleNotifyMs (${value.providerTurnIdleNotifyMs})`,
      });
    }
  });
export type AppSettingsUpdate = z.infer<typeof appSettingsUpdateSchema>;
