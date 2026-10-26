import type { PatientLinkSnapshot } from '../emr-contract/access-event';
import { freeze, refuse } from '../emr-contract/validation';
import type { PackageVersion } from './contract';

export type FixedListing = { recordId: string; revision: string;
  subject: { patient: PatientLinkSnapshot; studyId: string; managingInstitutionId: string };
  versions: PackageVersion[] };
const listings = new WeakMap<object, FixedListing>();
const originals = new WeakMap<object, readonly string[]>();

/** The online storage adapter supplies already-verified originals. A serialized
 * request cannot stand in for a stored listing at F's pure decision boundary. */
export function bindFixedListing(value: FixedListing, bytes: readonly string[]): object {
  const listing = Object.freeze({ recordId: value.recordId });
  listings.set(listing, freeze(value)); originals.set(listing, Object.freeze([...bytes]));
  return listing;
}
export function onlineFixedListing(value: unknown): FixedListing | null {
  return value !== null && typeof value === 'object' ? listings.get(value) ?? null : null;
}
export function fixedOriginals(listing: object, selected: readonly string[]) {
  const l = listings.get(listing), bytes = originals.get(listing);
  if (!l || !bytes) refuse('VersionListingRefused');
  return selected.map(id => {
    const index = l.versions.findIndex(v => v.versionId === id);
    if (index < 0) refuse('VersionListingIncomplete');
    return { recordId: l.recordId, versionId: id, original: bytes[index] };
  });
}
