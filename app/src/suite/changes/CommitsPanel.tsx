import { useEffect, useState } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { desktop, invoke } from "../native";
import type { Review } from "./useReview";

/** The commits between the two versions being reviewed, newest first. */
export function CommitsPanel({ review }: { review: Review }) {
  const [commits, setCommits] = useState<{ sha: string; subject: string; body: string }[]>([]);
  const before = review.snapshots?.before.rev,
    after = review.snapshots?.after.rev;
  useEffect(() => {
    if (!desktop || !review.repo || !before || !after || before === after || review.imported) return setCommits([]);
    invoke<{ sha: string; subject: string; body: string }[]>("review_commits", { repo: review.repo, before, after })
      .then(setCommits)
      .catch(() => setCommits([]));
  }, [review.repo, review.imported, before, after]);
  if (!commits.length) return null;
  return (
    <section className="mx-commits" aria-label="Commits in this change">
      <h3>
        <GitCommitHorizontal size={15} /> {commits.length} commit{commits.length === 1 ? "" : "s"} in this change
      </h3>
      <ul>
        {commits.slice(0, 8).map((c) => (
          <li key={c.sha}>
            <code>{c.sha.slice(0, 7)}</code> {c.subject}
          </li>
        ))}
        {commits.length > 8 && <li className="is-more">and {commits.length - 8} earlier</li>}
      </ul>
    </section>
  );
}
