import { z } from "zod";
import { gitBranchNameSchema } from "bb-checkout-contract/git-branch-name";
export {
  gitBranchNameSchema,
  isValidGitBranchName,
  type GitBranchName,
} from "bb-checkout-contract/git-branch-name";

export const gitBranchSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: gitBranchNameSchema }),
  z.object({ kind: z.literal("default") }),
]);
export type GitBranchSelection = z.infer<typeof gitBranchSelectionSchema>;

export const gitCheckoutRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("branch"),
    branchName: z.string().min(1),
    headSha: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("detached"),
    headSha: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("unborn"),
    branchName: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("unknown"),
    reason: z.string().min(1),
  }),
]);
export type GitCheckoutRef = z.infer<typeof gitCheckoutRefSchema>;

const workspaceGitOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("merge"),
    hasConflicts: z.boolean(),
  }),
  z.object({
    kind: z.literal("rebase"),
    hasConflicts: z.boolean(),
  }),
  z.object({
    kind: z.literal("cherry-pick"),
    hasConflicts: z.boolean(),
  }),
  z.object({
    kind: z.literal("revert"),
    hasConflicts: z.boolean(),
  }),
  z.object({
    kind: z.literal("unknown"),
    reason: z.string().min(1),
    hasConflicts: z.boolean(),
  }),
]);
export type WorkspaceGitOperation = z.infer<typeof workspaceGitOperationSchema>;

export const gitBranchRefClassificationSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["local", "remote", "missing"]),
});
export type GitBranchRefClassification = z.infer<
  typeof gitBranchRefClassificationSchema
>;

const defaultBranchRelationSchema = z.enum([
  "equal",
  "local-behind",
  "local-ahead",
  "diverged",
  "unknown",
]);
export type DefaultBranchRelation = z.infer<typeof defaultBranchRelationSchema>;

export const gitSourceInspectionSchema = z.object({
  checkout: gitCheckoutRefSchema,
  defaultBranch: z.string().min(1).nullable(),
  isWorktree: z.boolean(),
  defaultBranchRelation: defaultBranchRelationSchema.nullable(),
  hasUncommittedChanges: z.boolean(),
  operation: workspaceGitOperationSchema,
  originDefaultBranch: z.string().min(1).nullable(),
});
export type GitSourceInspection = z.infer<typeof gitSourceInspectionSchema>;

export const gitBranchOptionsSchema = z.object({
  branches: z.array(z.string()),
  branchesTruncated: z.boolean(),
  remoteBranches: z.array(z.string()),
  remoteBranchesTruncated: z.boolean(),
  selectedBranch: gitBranchRefClassificationSchema.nullable(),
});

export const projectSourceCheckoutSchema = gitSourceInspectionSchema.extend(
  gitBranchOptionsSchema.shape,
);
