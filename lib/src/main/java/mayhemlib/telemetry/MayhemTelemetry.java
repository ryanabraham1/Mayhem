package mayhemlib.telemetry;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.networktables.BooleanPublisher;
import edu.wpi.first.networktables.DoublePublisher;
import edu.wpi.first.networktables.NetworkTable;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.networktables.StringPublisher;
import edu.wpi.first.networktables.StructArrayPublisher;
import edu.wpi.first.networktables.StructPublisher;
import java.util.List;
import mayhemlib.runner.TrajectoryRunner;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.TrajectorySample;

/** Publishes runner state to NetworkTables (also captured in DataLog if NT logging is on). */
public final class MayhemTelemetry {
  private final StructPublisher<Pose2d> reference;
  private final StructArrayPublisher<Pose2d> path;
  private final StructArrayPublisher<Pose2d> bridge;
  private final StringPublisher state;
  private final StringPublisher name;
  private final DoublePublisher time;
  private final DoublePublisher rate;
  private final DoublePublisher error;
  private final DoublePublisher planMs;
  private final DoublePublisher bridges;
  private final BooleanPublisher terrain;
  private final BooleanPublisher unbeaching;
  private final DoublePublisher tilt;
  private final DoublePublisher unbeaches;
  private final StructArrayPublisher<Pose2d> unbeachTarget;

  public MayhemTelemetry(String root) {
    NetworkTable t = NetworkTableInstance.getDefault().getTable(root);
    reference = t.getStructTopic("reference", Pose2d.struct).publish();
    path = t.getStructArrayTopic("trajectory", Pose2d.struct).publish();
    bridge = t.getStructArrayTopic("bridge", Pose2d.struct).publish();
    state = t.getStringTopic("state").publish();
    name = t.getStringTopic("name").publish();
    time = t.getDoubleTopic("time").publish();
    rate = t.getDoubleTopic("clockRate").publish();
    error = t.getDoubleTopic("positionError").publish();
    planMs = t.getDoubleTopic("lastPlanMs").publish();
    bridges = t.getDoubleTopic("bridgesPlanned").publish();
    terrain = t.getBooleanTopic("onRoughTerrain").publish();
    unbeaching = t.getBooleanTopic("unbeaching").publish();
    tilt = t.getDoubleTopic("tiltDegrees").publish();
    unbeaches = t.getDoubleTopic("unbeachesStarted").publish();
    unbeachTarget = t.getStructArrayTopic("unbeachTarget", Pose2d.struct).publish();
  }

  public void startTrajectory(MayhemTrajectory traj) {
    List<TrajectorySample> s = traj.samples();
    int step = Math.max(1, s.size() / 150);
    Pose2d[] poses = new Pose2d[(s.size() + step - 1) / step];
    for (int i = 0, j = 0; i < s.size(); i += step, j++) {
      poses[j] = s.get(i).getPose();
    }
    path.set(poses);
    name.set(traj.name());
  }

  public void update(TrajectoryRunner r) {
    reference.set(r.reference().getPose());
    state.set(r.state().name());
    time.set(r.trajectoryTime());
    rate.set(r.clockRate());
    error.set(r.positionError());
    planMs.set(r.lastPlanSeconds() * 1000);
    bridges.set(r.bridgesPlanned());
    terrain.set(r.onRoughTerrain());
    unbeaching.set(r.isUnbeaching());
    tilt.set(r.tiltDegrees());
    unbeaches.set(r.unbeachCount());
    unbeachTarget.set(r.unbeachTarget()
        .map(p -> new Pose2d[] {new Pose2d(p, edu.wpi.first.math.geometry.Rotation2d.kZero)})
        .orElse(new Pose2d[0]));
    bridge.set(r.bridge().map(b -> b.poses(30)).orElse(new Pose2d[0]));
  }

  public void stop() {
    state.set("IDLE");
    terrain.set(false);
    unbeaching.set(false);
    unbeachTarget.set(new Pose2d[0]);
    bridge.set(new Pose2d[0]);
  }
}
