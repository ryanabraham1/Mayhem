package mayhemlib;

import static org.junit.jupiter.api.Assertions.assertTrue;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import java.util.Arrays;
import java.util.Random;
import mayhemlib.recovery.BridgePlanner;
import mayhemlib.recovery.RecoveryConfig;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.TrajectorySample;
import org.junit.jupiter.api.Test;

/** Rough timing of the planner on random bumps (desktop JVM; the roboRIO is ~10-30x slower). */
class PlannerBenchmarkTest {
  @Test
  void randomBumpsPlanQuickly() {
    MayhemTrajectory t = Fixtures.load("AroundReef");
    BridgePlanner planner = new BridgePlanner(new RecoveryConfig());
    Random rng = new Random(3256);
    int n = 400;
    double[] ms = new double[n];
    int found = 0;
    int validFail = 0;
    for (int i = 0; i < n; i++) {
      double tn = rng.nextDouble() * t.totalTime();
      TrajectorySample r = t.sampleAt(tn);
      Pose2d p = new Pose2d(r.x + rng.nextGaussian() * 0.4, r.y + rng.nextGaussian() * 0.4,
          new Rotation2d(r.heading + rng.nextGaussian() * 0.4));
      var res = planner.plan(t, tn, p, new ChassisSpeeds(r.vx + rng.nextGaussian(), r.vy + rng.nextGaussian(), 0));
      ms[i] = res.planSeconds * 1000;
      if (res.bridge.isPresent()) {
        found++;
      } else if (!RecoveryTest.collides(t.recovery(), p)) {
        validFail++;
        if (System.getenv("MAYHEM_DEBUG") != null) {
          System.out.printf("fail t=%.2f pose=%s ref=%s%n", tn, p, r.getPose());
        }
      }
    }
    double[] warm = Arrays.copyOfRange(ms, 50, n);
    Arrays.sort(warm);
    System.out.printf("planner: median %.3f ms, p95 %.3f ms, max %.3f ms, success %d/%d%n",
        warm[warm.length / 2], warm[(int) (warm.length * 0.95)], warm[warm.length - 1], found, n);
    assertTrue(warm[warm.length / 2] < 2.0);
    System.out.println("failures from collision-free starts: " + validFail);
    assertTrue(found > n * 0.8);
  }
}
