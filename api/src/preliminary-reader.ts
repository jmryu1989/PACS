/** Stored subjects survive renamed/recycled roster labels. Null subjects retain legacy compatibility. */
export function designationMatches(actor: string | null | undefined, sub: string | null | undefined,
  caller: { actor: string; sub?: string }): boolean {
  return sub != null ? !!caller.sub && sub === caller.sub : !!actor && actor === caller.actor;
}

export function canReadPreliminary(state: any, caller: { actor: string; sub?: string }): boolean {
  return state?.rs !== 'P' || designationMatches(state.preDoc, state.preDocSub, caller)
    || designationMatches(state.preReviewer, state.preReviewerSub, caller);
}
