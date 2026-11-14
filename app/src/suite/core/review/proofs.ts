/**
 * Sim proof results kept with the commit they ran on, as a git note (`refs/notes/mayhem-proof`)
 * on that commit. Whatever ran the simulation writes the note (the `run_scenarios` tool, or the
 * app's Sim proof tab), so a person reviewing a change reads the run's result and not somebody's
 * account of it. A note holds the newest run per version the commit was compared with.
 */

export const PROOF_NOTES = "refs/notes/mayhem-proof";

export interface ProofSummary {
  /** The version the commit was compared with (a full commit id), when it was compared. */
  before?: string;
  at: string;
  /** Who ran it: an agent's name, or the person's in the app. */
  by: string;
  /** Scenarios run. */
  ran: number;
  /** Scenarios that crashed or failed an expectation, by name. */
  failed: string[];
  /** Scenarios where the robot does something a driver would notice as different, by name. */
  different: string[];
  /** Only some scenarios were run, so this is not the whole proof. */
  partial?: boolean;
}

/** One line for a proof: what a person needs before opening it. */
export function proofText(proof: ProofSummary): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (proof.failed.length) return `${proof.failed.length} of ${n(proof.ran, "scenario")} failed`;
  if (proof.different.length) return `${n(proof.ran, "scenario")} pass, ${proof.different.length} behave${proof.different.length === 1 ? "s" : ""} differently`;
  return `${n(proof.ran, "scenario")} pass, same behavior`;
}

const names = (value: unknown) => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);

/** The proofs in a note's text, newest first; a missing or unreadable note has none. */
export function parseProofNote(text: string | null | undefined): ProofSummary[] {
  if (!text) return [];
  try {
    const note = JSON.parse(text);
    if (note?.format !== "mayhem-proof" || !Array.isArray(note.proofs)) return [];
    return (note.proofs as Record<string, unknown>[])
      .filter((p) => typeof p?.at === "string" && typeof p.by === "string" && typeof p.ran === "number")
      .map((p) => ({
        ...(typeof p.before === "string" ? { before: p.before } : {}),
        at: p.at as string,
        by: p.by as string,
        ran: p.ran as number,
        failed: names(p.failed),
        different: names(p.different),
        ...(p.partial === true ? { partial: true } : {}),
      }))
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/** How many runs a note keeps (one per compared version, newest first). */
const KEPT = 6;

/** The note's text with `proof` added, replacing an earlier run against the same version. */
export function withProof(text: string | null | undefined, proof: ProofSummary): string {
  const others = parseProofNote(text).filter((p) => p.before !== proof.before);
  return JSON.stringify({ format: "mayhem-proof", version: 1, proofs: [proof, ...others].slice(0, KEPT) }, null, 2) + "\n";
}

/**
 * The run to show for a commit reviewed against `base`: the one made against that base, else the
 * newest run against anything (the caller says what it was compared with).
 */
export function proofFor(proofs: ProofSummary[], base?: string): ProofSummary | undefined {
  return proofs.find((p) => base !== undefined && p.before === base) ?? proofs[0];
}
