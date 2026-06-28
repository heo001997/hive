import type {
  BranchFromBaseParams,
  CreateFromBranchParams,
  CreateWorktreeParams,
  DeleteWorktreeParams,
  DuplicateWorktreeParams,
  RenameBranchParams,
  SyncWorktreesParams
} from '../../services/worktree-ops'
import {
  branchWorktreeFromBaseOpEffect,
  createWorktreeFromBranchOpEffect,
  createWorktreeOpEffect,
  deleteWorktreeOpEffect,
  duplicateWorktreeOpEffect,
  renameWorktreeBranchOpEffect,
  syncWorktreesOpEffect
} from '../../services/worktree-ops'
import { getRuntime } from './runtime'

export const worktreeOpsFacade = {
  create: (params: CreateWorktreeParams) => getRuntime().runPromise(createWorktreeOpEffect(params)),
  delete: (params: DeleteWorktreeParams) => getRuntime().runPromise(deleteWorktreeOpEffect(params)),
  sync: (params: SyncWorktreesParams) => getRuntime().runPromise(syncWorktreesOpEffect(params)),
  duplicate: (params: DuplicateWorktreeParams) =>
    getRuntime().runPromise(duplicateWorktreeOpEffect(params)),
  renameBranch: (params: RenameBranchParams) =>
    getRuntime().runPromise(renameWorktreeBranchOpEffect(params)),
  branchFromBase: (params: BranchFromBaseParams) =>
    getRuntime().runPromise(branchWorktreeFromBaseOpEffect(params)),
  createFromBranch: (params: CreateFromBranchParams) =>
    getRuntime().runPromise(createWorktreeFromBranchOpEffect(params))
}
