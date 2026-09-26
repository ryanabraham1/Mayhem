package mayhemlib.auto;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj.event.EventLoop;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.button.Trigger;
import java.util.HashMap;
import java.util.Map;
import mayhemlib.follow.DriveCommand;
import mayhemlib.runner.TrajectoryRunner;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.TrajectoryEvent;

/** A trajectory (or one split segment) bound to a factory: commands, triggers and helpers. */
public final class AutoTrajectory {
  private final MayhemAutoFactory f;
  private final MayhemTrajectory base; // blue alliance, full trajectory
  private final int segment; // -1 = whole trajectory

  private final Map<String, MarkerState> markers = new HashMap<>();
  private final Map<String, Command> runningZones = new HashMap<>();
  private boolean active;
  private boolean recovering;
  private int doneSeq;
  private int doneSeen;
  private TrajectoryRunner runner;

  private static final class MarkerState {
    int fireSeq;
    int seenSeq;
    boolean zoneActive;
  }

  AutoTrajectory(MayhemAutoFactory f, MayhemTrajectory base, int segment) {
    this.f = f;
    this.base = base;
    this.segment = segment;
  }

  /** Blue-alliance trajectory data for this (segment of the) trajectory. */
  public MayhemTrajectory rawTrajectory() {
    return segment < 0 ? base : base.segment(segment);
  }

  /** Alliance-correct trajectory, resolved now. */
  public MayhemTrajectory resolved() {
    MayhemTrajectory t = rawTrajectory();
    return f.isRed() ? t.flipped() : t;
  }

  public int segmentCount() {
    return base.segmentCount();
  }

  /** Split segment {@code i} as its own AutoTrajectory. */
  public AutoTrajectory segment(int i) {
    if (segment >= 0) {
      throw new IllegalStateException("Already a segment");
    }
    base.segment(i); // validates the index
    return new AutoTrajectory(f, base, i);
  }

  public Pose2d initialPose() {
    return resolved().initialPose();
  }

  public Pose2d finalPose() {
    return resolved().finalPose();
  }

  /** Resets odometry to the (alliance-correct) start pose. */
  public Command resetOdometry() {
    return Commands.runOnce(() -> f.resetPose.accept(initialPose()));
  }

  /** Follows the trajectory with bump recovery; ends when it finishes. */
  public Command cmd() {
    Command c = new Command() {
      @Override
      public void initialize() {
        MayhemTrajectory traj = resolved();
        runner = new TrajectoryRunner(traj, f.followerConfig, f.recoveryConfig, new Listener(), f.refiner);
        runner.start(Timer.getFPGATimestamp());
        active = true;
        if (f.telemetry != null) {
          f.telemetry.startTrajectory(traj);
        }
      }

      @Override
      public void execute() {
        double now = Timer.getFPGATimestamp();
        DriveCommand dc = runner.update(now, f.pose.get(), f.fieldSpeeds.get(), f.accelG.getAsDouble());
        f.output.accept(dc);
        recovering = runner.isRecovering();
        f.visionBoost.accept(runner.visionBoostActive());
        if (f.telemetry != null) {
          f.telemetry.update(runner);
        }
      }

      @Override
      public boolean isFinished() {
        return runner != null && runner.isFinished();
      }

      @Override
      public void end(boolean interrupted) {
        if (runner != null) {
          runner.stop();
          boolean endsMoving = runner.trajectory().finalSample().speed() > 0.05;
          if (interrupted || !endsMoving) {
            f.output.accept(DriveCommand.stop(f.followerConfig.modules));
          }
        }
        for (Command z : runningZones.values()) {
          z.cancel();
        }
        runningZones.clear();
        for (MarkerState m : markers.values()) {
          m.zoneActive = false;
        }
        active = false;
        recovering = false;
        f.visionBoost.accept(false);
        doneSeq++;
        if (f.telemetry != null) {
          f.telemetry.stop();
        }
      }
    };
    c.addRequirements(f.requirements);
    c.setName("Mayhem " + rawTrajectory().name());
    return c;
  }

  private final class Listener implements TrajectoryRunner.EventListener {
    @Override
    public void onEvent(TrajectoryEvent e) {
      MarkerState m = markers.computeIfAbsent(e.name, k -> new MarkerState());
      m.fireSeq++;
      if (e.isZone()) {
        m.zoneActive = true;
      }
      f.boundCommand(e.command).ifPresent(cmd -> {
        CommandScheduler.getInstance().schedule(cmd);
        if (e.isZone()) {
          runningZones.put(e.name, cmd);
        }
      });
    }

    @Override
    public void onZoneEnd(TrajectoryEvent e) {
      MarkerState m = markers.computeIfAbsent(e.name, k -> new MarkerState());
      m.zoneActive = false;
      Command z = runningZones.remove(e.name);
      if (z != null) {
        z.cancel();
      }
    }
  }

  private EventLoop loop() {
    return CommandScheduler.getInstance().getDefaultButtonLoop();
  }

  /**
   * True for one loop when an instant marker fires, and for the whole duration of a zone marker.
   */
  public Trigger atMarker(String name) {
    MarkerState m = markers.computeIfAbsent(name, k -> new MarkerState());
    return new Trigger(loop(), () -> {
      if (m.zoneActive) {
        return true;
      }
      if (m.fireSeq != m.seenSeq) {
        m.seenSeq = m.fireSeq;
        return true;
      }
      return false;
    });
  }

  /** True while this trajectory's command is running. */
  public Trigger active() {
    return new Trigger(loop(), () -> active);
  }

  /** True while bump recovery is driving a bridge path. */
  public Trigger recovering() {
    return new Trigger(loop(), () -> recovering);
  }

  /** Pulses true for one loop after the trajectory command ends. */
  public Trigger done() {
    return new Trigger(loop(), () -> {
      if (doneSeq != doneSeen) {
        doneSeen = doneSeq;
        return true;
      }
      return false;
    });
  }
}
