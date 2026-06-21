// Shared, persisted "download from issue" preference for TWIC. The setup wizard
// and the Maintenance panel both read/write it, so whatever starting issue you
// set in one place is carried over to the other.

const TWIC_FROM_KEY = "twicFromIssue";
export const TWIC_FROM_DEFAULT = "920";

export function getTwicFrom(): string {
  return localStorage.getItem(TWIC_FROM_KEY) || TWIC_FROM_DEFAULT;
}

export function setTwicFrom(value: string): void {
  localStorage.setItem(TWIC_FROM_KEY, value);
}
