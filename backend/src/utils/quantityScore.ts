export function calculateQuantityScore(
  donationRemaining: number,
  requirementRemaining: number
): number {
  if (!Number.isFinite(donationRemaining) || !Number.isFinite(requirementRemaining)) {
    return 0;
  }
  if (donationRemaining <= 0 || requirementRemaining <= 0) {
    return 0;
  }
  const smaller = Math.min(donationRemaining, requirementRemaining);
  const larger = Math.max(donationRemaining, requirementRemaining);
  return smaller / larger;
}
