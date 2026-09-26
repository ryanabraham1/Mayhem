package mayhemlib.recovery;

import static org.wpilib.math.optimization.Constraints.bounds;
import static org.wpilib.math.optimization.Constraints.eq;
import static org.wpilib.math.optimization.Constraints.le;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import mayhemlib.trajectory.RecoveryData;
import mayhemlib.trajectory.TrajectorySample;
import org.wpilib.math.autodiff.Variable;
import org.wpilib.math.autodiff.VariableMatrix;
import org.wpilib.math.optimization.Problem;
import org.wpilib.math.optimization.solver.ExitStatus;
import org.wpilib.math.optimization.solver.Options;

/**
 * Optional background refinement of a recovery bridge using Sleipnir (the optimizer behind
 * Choreo). Solves a small minimum-time problem with constant-acceleration dynamics and the
 * exported velocity/acceleration limits, then verifies it with the swept collision check.
 *
 * <p>Requires the SleipnirJava vendordep ({@code https://file.tavsys.net/sleipnir/SleipnirJava.json}).
 * Off by default; the roboRIO 2 is usually too slow for it to finish in time, so this is mainly
 * for faster controllers.
 */
public final class SleipnirBridgeRefiner implements BridgeRefiner {
  private final int samples;
  private final double timeoutSeconds;
  private final double collisionStep;

  public SleipnirBridgeRefiner() {
    this(16, 0.05, 0.04);
  }

  public SleipnirBridgeRefiner(int samples, double timeoutSeconds, double collisionStep) {
    this.samples = samples;
    this.timeoutSeconds = timeoutSeconds;
    this.collisionStep = collisionStep;
  }

  @Override
  public Optional<Bridge> refine(TrajectorySample start, TrajectorySample target, double joinTime,
      double coarseRemaining, RecoveryData rec) {
    final int N = samples;
    try (Problem problem = new Problem()) {
      VariableMatrix X = problem.decisionVariable(6, N + 1); // x, y, th, vx, vy, w
      VariableMatrix U = problem.decisionVariable(3, N); // ax, ay, alpha
      Variable h = problem.decisionVariable();

      for (int k = 0; k < N; k++) {
        for (int d = 0; d < 3; d++) {
          Variable p = X.get(d, k);
          Variable v = X.get(d + 3, k);
          Variable a = U.get(d, k);
          problem.subjectTo(eq(X.get(d, k + 1), p.plus(v.times(h)).plus(a.times(h).times(h).times(0.5))));
          problem.subjectTo(eq(X.get(d + 3, k + 1), v.plus(a.times(h))));
        }
      }
      double[] s0 = {start.x, start.y, start.heading, start.vx, start.vy, start.omega};
      double[] s1 = {target.x, target.y, target.heading, target.vx, target.vy, target.omega};
      for (int d = 0; d < 6; d++) {
        problem.subjectTo(eq(X.get(d, 0), s0[d]));
        problem.subjectTo(eq(X.get(d, N), s1[d]));
      }
      double vmax = Math.max(rec.maxVelocity, Math.max(start.speed(), target.speed()) * 1.01);
      for (int k = 0; k <= N; k++) {
        Variable vx = X.get(3, k);
        Variable vy = X.get(4, k);
        problem.subjectTo(le(vx.times(vx).plus(vy.times(vy)), vmax * vmax));
        problem.subjectTo(bounds(-rec.maxAngularVelocity * 1.01 - Math.abs(start.omega),
            X.get(5, k), rec.maxAngularVelocity * 1.01 + Math.abs(start.omega)));
      }
      for (int k = 0; k < N; k++) {
        Variable ax = U.get(0, k);
        Variable ay = U.get(1, k);
        problem.subjectTo(le(ax.times(ax).plus(ay.times(ay)), rec.maxAcceleration * rec.maxAcceleration));
        problem.subjectTo(bounds(-rec.maxAngularAcceleration, U.get(2, k), rec.maxAngularAcceleration));
      }
      problem.subjectTo(bounds(0.005, h, 0.5));
      problem.minimize(h.times(N));

      // initial guess: linear blend, sized from the coarse bridge
      double hg = Math.max(coarseRemaining / N, 0.01);
      h.setValue(hg);
      for (int k = 0; k <= N; k++) {
        double u = (double) k / N;
        for (int d = 0; d < 6; d++) {
          X.get(d, k).setValue(s0[d] + (s1[d] - s0[d]) * u);
        }
      }

      Options opts = new Options();
      opts.timeout = timeoutSeconds;
      opts.tolerance = 1e-6;
      ExitStatus status = problem.solve(opts);
      if (status != ExitStatus.SUCCESS) {
        return Optional.empty();
      }
      double hv = h.value();
      List<Bridge.Segment> segs = new ArrayList<>();
      for (int k = 0; k < N; k++) {
        Quintic[] q = new Quintic[3];
        for (int d = 0; d < 3; d++) {
          double a = U.value(d, k);
          q[d] = new Quintic(X.value(d, k), X.value(d + 3, k), a, X.value(d, k + 1), X.value(d + 3, k + 1), a, hv);
        }
        segs.add(new Bridge.Segment(q[0], q[1], q[2]));
      }
      Bridge b = new Bridge(segs, joinTime, false);
      if (!BridgePlanner.isCollisionFree(b, rec, collisionStep)) {
        return Optional.empty();
      }
      return Optional.of(b);
    } catch (RuntimeException | UnsatisfiedLinkError e) {
      return Optional.empty();
    }
  }
}
