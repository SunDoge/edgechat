export type StagedMlsPosition = "previous" | "next" | "mismatch";

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function stagedMlsPosition(active: Uint8Array, previous: Uint8Array, next: Uint8Array): StagedMlsPosition {
  if (equalBytes(active, previous)) return "previous";
  if (equalBytes(active, next)) return "next";
  return "mismatch";
}
