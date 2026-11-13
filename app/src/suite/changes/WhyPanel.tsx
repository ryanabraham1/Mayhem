import { useEffect, useState } from "react";
import { Lightbulb } from "lucide-react";
import { tasksInMessage } from "../core/review/tasks.ts";
import { desktop, invoke } from "../native";
import { anchorText, useTasks } from "../tasks/feedback";
import { Badge } from "../ui";
import type { Review } from "./useReview";

/** Why this change exists: the feedback (and approved plan) behind the commits being reviewed. */
export function WhyPanel({ review }: { review: Review }) {
  const { items } = useTasks();
  const [commits, setCommits] = useState<{ sha: string; subject: string; body: string }[]>([]);
  const before = review.snapshots?.before.rev,
    after = review.snapshots?.after.rev;
  useEffect(() => {
    if (!desktop || !review.repo || !before || !after || before === after) return setCommits([]);
    invoke<{ sha: string; subject: string; body: string }[]>("review_commits", { repo: review.repo, before, after })
      .then(setCommits)
      .catch(() => setCommits([]));
  }, [review.repo, before, after]);
  const shas = new Set(commits.map((c) => c.sha));
  const named = new Set(commits.flatMap((c) => tasksInMessage(`${c.subject}\n${c.body}`)));
  const linked = items.filter((t) => named.has(t.id) || t.changes.some((c) => shas.has(c.revision) || c.revision === after));
  if (!linked.length) return commits.length ? <p className="mx-help">No feedback is linked to these {commits.length} commits (agents add a <code>Mayhem-Task: &lt;id&gt;</code> line).</p> : null;
  return (
    <section className="mx-panel mx-why" aria-label="Why this change">
      <h2>
        <Lightbulb size={16} /> Why this change
      </h2>
      {linked.map((t) => (
        <div key={t.id} className="mx-why-item">
          <strong>{t.title}</strong> <small>· {t.author}</small> <Badge>{t.status}</Badge>
          {t.text && <p>{t.text}</p>}
          {anchorText(t.anchor) && <small className="mx-anchor">{anchorText(t.anchor)}</small>}
          {t.plan && (
            <p className="mx-before-after">
              Plan{t.planDecision?.approved ? ` (approved by ${t.planDecision.by})` : ""}: {t.plan}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
