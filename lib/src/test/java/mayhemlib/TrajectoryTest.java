package mayhemlib;

import static org.junit.jupiter.api.Assertions.*;

import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.TrajectorySample;
import org.junit.jupiter.api.Test;

class TrajectoryTest {
  @Test
  void loadsAndInterpolatesContinuously() {
    MayhemTrajectory t = Fixtures.load("HubCycle");
    assertEquals("HubCycle", t.name());
    assertTrue(t.totalTime() > 1.0);
    assertEquals(0.0, t.initialSample().speed(), 1e-6);
    double prevX = t.sampleAt(0).x;
    for (double s = 0.005; s <= t.totalTime(); s += 0.005) {
      TrajectorySample a = t.sampleAt(s);
      assertTrue(Math.abs(a.x - prevX) < 0.05, "jump at t=" + s);
      prevX = a.x;
    }
    // interpolation hits the samples exactly
    for (TrajectorySample k : t.samples()) {
      assertEquals(k.x, t.sampleAt(k.t).x, 1e-6);
      assertEquals(k.y, t.sampleAt(k.t).y, 1e-6);
    }
    assertNotNull(t.recovery());
    assertFalse(t.recovery().obstacles.isEmpty());
    assertEquals(4, t.initialSample().fx.length);
  }

  @Test
  void flipTwiceIsIdentityAndRotatesPose() {
    MayhemTrajectory t = Fixtures.load("HubCycle");
    MayhemTrajectory f = t.flipped();
    double L = t.recovery().fieldLength;
    double W = t.recovery().fieldWidth;
    assertEquals(L - t.initialPose().getX(), f.initialPose().getX(), 1e-9);
    assertEquals(W - t.initialPose().getY(), f.initialPose().getY(), 1e-9);
    TrajectorySample a = t.sampleAt(1.0);
    TrajectorySample b = f.sampleAt(1.0);
    assertEquals(-a.vx, b.vx, 1e-9);
    assertEquals(a.omega, b.omega, 1e-9);
    MayhemTrajectory ff = f.flipped();
    assertEquals(t.sampleAt(0.7).x, ff.sampleAt(0.7).x, 1e-9);
    assertEquals(0.0, edu.wpi.first.math.MathUtil.angleModulus(
        t.sampleAt(0.7).heading - ff.sampleAt(0.7).heading), 1e-9);
  }

  @Test
  void segmentsSplitAtStopPoint() {
    MayhemTrajectory t = Fixtures.load("HubCycle");
    assertEquals(2, t.segmentCount());
    MayhemTrajectory s0 = t.segment(0);
    MayhemTrajectory s1 = t.segment(1);
    assertEquals(t.totalTime(), s0.totalTime() + s1.totalTime(), 1e-9);
    assertEquals(0.0, s1.initialSample().t, 1e-12);
    assertEquals(s0.finalPose().getX(), s1.initialPose().getX(), 1e-9);
    assertTrue(s0.events().stream().anyMatch(e -> e.name.equals("raise")));
    assertTrue(s1.events().stream().anyMatch(e -> e.name.equals("intake")));
  }
}
