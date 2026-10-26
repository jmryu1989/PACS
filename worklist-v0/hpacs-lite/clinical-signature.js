// Display only the evidence returned with the body. The owning panel checks
// UID, request generation and account before it renders either of them.
window.KinClinicalSignature = function(evidence, revision) {
  const row = evidence?.signatures?.find(item => item.revision === revision);
  const signature = row ? row.signature : evidence?.receipt?.revision === revision ? evidence.signature : undefined;
  if (signature === undefined) return '';
  if (signature === null) return 'Recorded';
  const at = signature.signedAt;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return 'Unverified';
  return 'Signed · ' + new Date(at).toLocaleString();
};
