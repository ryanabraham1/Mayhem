package mayhemlib;

import static org.junit.jupiter.api.Assertions.*;

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import java.util.ArrayList;
import java.util.List;
import mayhemlib.follow.DriveCommand;
import mayhemlib.follow.FollowerConfig;
import mayhemlib.follow.HolonomicFollower;
import mayhemlib.geometry.ConvexPolygon;
import mayhemlib.trajectory.FieldSymmetry;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.RecoveryData;
import mayhemlib.trajectory.TrajectoryEvent;
import mayhemlib.trajectory.TrajectoryLoader;
import mayhemlib.trajectory.TrajectorySample;
import org.junit.jupiter.api.Test;

class SegmentFlipTest {
  @Test
  void segmentsRebaseEventsAndMustHitTimes() {
    MayhemTrajectory t = Fixtures.load("HubCycle");
    double split = t.segment(0).totalTime();
    MayhemTrajectory s0 = t.segment(0);
    MayhemTrajectory s1 = t.segment(1);

    // must-hit times: kept inside each segment, shifted, and the segment end is always one
    for (MayhemTrajectory s : List.of(s0, s1)) {
      double[] mh = s.recovery().mustHitTimes;
      assertEquals(s.totalTime(), mh[mh.length - 1], 1e-9, "segment end is a must-hit point");
      for (double m : mh) {
        assertTrue(m > 0 && m <= s.totalTime() + 1e-9, "must-hit " + m + " inside " + s.name());
      }
    }
    for (double m : t.recovery().mustHitTimes) {
      if (m > split + 1e-3) {
        double shifted = Math.min(m - split, s1.totalTime());
        assertTrue(java.util.Arrays.stream(s1.recovery().mustHitTimes).anyMatch(x -> Math.abs(x - shifted) < 1e-3),
            "must-hit " + m + " rebased into segment 1");
      }
    }
    // the exported (rounded) must-hit at the split point must not become a spurious one at ~0 s
    assertTrue(s1.recovery().mustHitTimes[0] > 1e-3, "no must-hit at the very start of segment 1");

    // events: a marker exactly at the split belongs to the following segment, at t = 0
    TrajectoryEvent score = s1.events().stream().filter(e -> e.name.equals("score")).findFirst().orElseThrow();
    assertEquals(0.0, score.t, 1e-9);
    assertTrue(s0.events().stream().noneMatch(e -> e.name.equals("score")));
    TrajectoryEvent orig = t.events().stream().filter(e -> e.name.equals("intake")).findFirst().orElseThrow();
    TrajectoryEvent intake = s1.events().stream().filter(e -> e.name.equals("intake")).findFirst().orElseThrow();
    assertEquals(orig.t - split, intake.t, 1e-9);
    assertTrue(intake.endT <= s1.totalTime() + 1e-9, "zone end clamped to the segment");

    // waypoint times rebased too
    for (double w : s1.waypointTimes()) {
      assertTrue(w >= -1e-9 && w <= s1.totalTime() + 1e-9);
    }
    assertEquals("HubCycle[1]", s1.name());
    assertThrows(IndexOutOfBoundsException.class, () -> t.segment(2));
    // a trajectory without splits is its own only segment
    MayhemTrajectory straight = Fixtures.load("Straight");
    assertEquals(1, straight.segmentCount());
    assertSame(straight, straight.segment(0));
  }

  @Test
  void flippedSegmentEqualsSegmentOfFlipped() {
    MayhemTrajectory t = Fixtures.load("HubCycle");
    MayhemTrajectory a = t.flipped().segment(1);
    MayhemTrajectory b = t.segment(1).flipped();
    for (double s = 0; s <= a.totalTime(); s += 0.05) {
      assertEquals(a.sampleAt(s).x, b.sampleAt(s).x, 1e-9);
      assertEquals(a.sampleAt(s).y, b.sampleAt(s).y, 1e-9);
      assertEquals(a.sampleAt(s).vx, b.sampleAt(s).vx, 1e-9);
    }
    assertTrue(a.isFlipped() && b.isFlipped());
  }

  /** A small synthetic trajectory with distinct per-module forces. */
  static MayhemTrajectory synthetic(FieldSymmetry sym) {
    List<TrajectorySample> samples = new ArrayList<>();
    for (int k = 0; k <= 20; k++) {
      double t = k * 0.1;
      double ax = 1.0;
      double ay = -0.5;
      double al = 0.8;
      samples.add(new TrajectorySample(t, 2 + 0.5 * ax * t * t, 3 + 0.5 * ay * t * t, 0.3 + 0.5 * al * t * t,
          ax * t, ay * t, al * t, ax, ay, al,
          new double[] {10, 20, 30, 40}, new double[] {-1, -2, -3, -4}));
    }
    Translation2d[] bumper = {
        new Translation2d(0.4, 0.4), new Translation2d(-0.4, 0.4),
        new Translation2d(-0.4, -0.4), new Translation2d(0.4, -0.4)};
    ConvexPolygon box = new ConvexPolygon(new double[] {5, 6, 6, 5}, new double[] {1, 1, 2, 2});
    RecoveryData rec = new RecoveryData(bumper, List.of(box), 16.0, 8.0, sym,
        List.of(new Translation2d(4, 1)), List.of(), 3, 4, 5, 10, new double[] {2.0});
    return new MayhemTrajectory("syn", samples, List.of(), new int[0], new double[] {0, 2}, rec, "", false);
  }

  @Test
  void mirrorFlipReflectsAcrossCenterLineAndSwapsSides() {
    MayhemTrajectory t = synthetic(FieldSymmetry.MIRROR);
    MayhemTrajectory f = t.flipped();
    TrajectorySample a = t.samples().get(10);
    TrajectorySample b = f.samples().get(10);
    assertEquals(16.0 - a.x, b.x, 1e-12);
    assertEquals(a.y, b.y, 1e-12, "mirror keeps y");
    assertEquals(0.0, MathUtil.angleModulus(Math.PI - a.heading - b.heading), 1e-12);
    assertEquals(-a.vx, b.vx, 1e-12);
    assertEquals(a.vy, b.vy, 1e-12);
    assertEquals(-a.omega, b.omega, 1e-12, "mirroring reverses rotation direction");
    assertEquals(-a.alpha, b.alpha, 1e-12);
    // left and right modules swap (FL<->FR, BL<->BR); x force negates, y force kept
    assertArrayEquals(new double[] {-20, -10, -40, -30}, b.fx, 1e-12);
    assertArrayEquals(new double[] {-2, -1, -4, -3}, b.fy, 1e-12);
    // obstacles and roadmap are mirrored as well
    assertEquals(16.0 - 4, f.recovery().roadmapNodes.get(0).getX(), 1e-12);
    assertEquals(1, f.recovery().roadmapNodes.get(0).getY(), 1e-12);
    // flipping twice is the identity
    MayhemTrajectory ff = f.flipped();
    assertFalse(ff.isFlipped());
    TrajectorySample c = ff.samples().get(10);
    assertEquals(a.x, c.x, 1e-12);
    assertEquals(a.omega, c.omega, 1e-12);
    assertArrayEquals(a.fx, c.fx, 1e-12);
    assertArrayEquals(a.fy, c.fy, 1e-12);
    assertEquals(0.0, MathUtil.angleModulus(a.heading - c.heading), 1e-12);
  }

  @Test
  void flipCommutesWithInterpolation() {
    for (FieldSymmetry sym : FieldSymmetry.values()) {
      MayhemTrajectory t = synthetic(sym);
      MayhemTrajectory f = t.flipped();
      for (double s = 0.013; s < t.totalTime(); s += 0.1) {
        TrajectorySample expect = t.sampleAt(s).flipped(sym, 16.0, 8.0);
        TrajectorySample got = f.sampleAt(s);
        assertEquals(expect.x, got.x, 1e-9, sym + " x");
        assertEquals(expect.y, got.y, 1e-9, sym + " y");
        assertEquals(expect.heading, got.heading, 1e-9, sym + " heading");
        assertEquals(expect.vx, got.vx, 1e-9);
        assertEquals(expect.omega, got.omega, 1e-9);
      }
    }
  }

  @Test
  void loaderRejectsNewerFormatsAndUngeneratedFiles() {
    IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
        () -> TrajectoryLoader.parse("{\"name\":\"X\",\"formatVersion\":99,\"output\":{}}"));
    assertTrue(e.getMessage().contains("Update MayhemLib"));
    e = assertThrows(IllegalArgumentException.class,
        () -> TrajectoryLoader.parse("{\"name\":\"X\",\"formatVersion\":1,\"output\":null}"));
    assertTrue(e.getMessage().contains("not been generated"));
    assertThrows(IllegalArgumentException.class, () -> TrajectoryLoader.parse("not json"));
    assertThrows(IllegalArgumentException.class,
        () -> TrajectoryLoader.load(new java.io.File("does/not/exist.mtraj")));
  }

  @Test
  void followerSaturatesFeedbackAndScalesFeedforwardWithClockRate() {
    FollowerConfig cfg = new FollowerConfig();
    HolonomicFollower f = new HolonomicFollower(cfg);
    TrajectorySample ref = new TrajectorySample(0, 5, 5, 0, 2, 0, 1, 0, 0, 0,
        new double[] {4, 4, 4, 4}, new double[] {1, 1, 1, 1});
    // robot 2 m behind: feedback would be 12 m/s but is capped at maxFeedbackVelocity
    DriveCommand c = f.calculate(ref, new Pose2d(3, 5, new Rotation2d()), new ChassisSpeeds(), 1.0);
    assertEquals(2 + cfg.maxFeedbackVelocity, c.fieldSpeeds.vxMetersPerSecond, 1e-9);
    assertEquals(0, c.fieldSpeeds.vyMetersPerSecond, 1e-9);
    // on the reference, half clock rate: velocity x0.5, forces x0.25
    c = f.calculate(ref, new Pose2d(5, 5, new Rotation2d()), new ChassisSpeeds(), 0.5);
    assertEquals(1.0, c.fieldSpeeds.vxMetersPerSecond, 1e-9);
    assertEquals(0.5, c.fieldSpeeds.omegaRadiansPerSecond, 1e-9);
    assertArrayEquals(new double[] {1, 1, 1, 1}, c.wheelForceX, 1e-9);
    assertArrayEquals(new double[] {0.25, 0.25, 0.25, 0.25}, c.wheelForceY, 1e-9);
    // total speed is capped at maxVelocity
    cfg.maxVelocity = 2.5;
    c = f.calculate(ref, new Pose2d(3, 5, new Rotation2d()), new ChassisSpeeds(), 1.0);
    assertEquals(2.5, Math.hypot(c.fieldSpeeds.vxMetersPerSecond, c.fieldSpeeds.vyMetersPerSecond), 1e-9);
    // force feedforward can be turned off
    cfg.useForceFeedforward = false;
    c = f.calculate(ref, new Pose2d(5, 5, new Rotation2d()), new ChassisSpeeds(), 1.0);
    assertArrayEquals(new double[4], c.wheelForceX, 1e-12);
  }
}
