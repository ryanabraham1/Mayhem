package mayhemlib.auto;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.ScheduleCommand;
import edu.wpi.first.wpilibj2.command.button.Trigger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Predicate;
import mayhemlib.follow.DriveCommand;
import mayhemlib.runner.TrajectoryRunner;
import mayhemlib.trajectory.FieldSymmetry;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.RecoveryData;
import mayhemlib.trajectory.TrajectoryEvent;

/**
 * A trajectory (or one split segment) in an {@link AutoRoutine}, modeled on Choreo's
 * {@code choreo.auto.AutoTrajectory}: a follow command plus triggers for its timeline.
 *
 * <p>Triggers are polled by the routine, so they only fire while the routine runs. One-cycle
 * triggers ({@link #done()}, {@link #atTime(double)}, instant markers) are true on the routine
 * poll right after the event happened.
 */
public final class AutoTrajectory {
  private final AutoFactory f;
  private final AutoRoutine routine;
  private final MayhemTrajectory base; // blue alliance

  private final Map<String, Pulse> markerPulses = new HashMap<>();
  private final Map<String, Boolean> zoneActive = new HashMap<>();
  private final Map<String, Command> runningZones = new HashMap<>();
  private final Map<Double, Pulse> timePulses = new HashMap<>();
  private final Pulse donePulse = new Pulse();

  private Command activeCmd;
  private boolean isActive;
  private boolean recovering;
  private boolean onTerrain;
  private boolean hasFinished;
  private double finishedAt = Double.NEGATIVE_INFINITY;
  private int startsAtFinish = -1;
  private double time;
  private MayhemTrajectory running; // alliance-correct trajectory of the current run
  private TrajectoryRunner runner;

  /** Marks the routine poll an event happened on, so every binding of a trigger sees it once. */
  private final class Pulse {
    long at = Long.MIN_VALUE / 2;

    void fire() {
      at = routine.pollCount();
    }

    boolean high(int delayCycles) {
      return routine.pollCount() == at + 1 + delayCycles;
    }
  }

  AutoTrajectory(AutoFactory f, AutoRoutine routine, MayhemTrajectory base) {
    this.f = f;
    this.routine = routine;
    this.base = base;
  }

  public String name() {
    return base.name();
  }

  /** The trajectory as authored (blue alliance). */
  public MayhemTrajectory getRawTrajectory() {
    return base;
  }

  /** Alliance-correct start pose, resolved now. */
  public Optional<Pose2d> getInitialPose() {
    return Optional.of(resolved().initialPose());
  }

  /** Alliance-correct end pose, resolved now. */
  public Optional<Pose2d> getFinalPose() {
    return Optional.of(resolved().finalPose());
  }

  private MayhemTrajectory resolved() {
    return f.isRed() ? base.flipped() : base;
  }

  // --------------------------------------------------------------------------- commands

  /** Resets odometry to the alliance-correct start pose (resolved when the command runs). */
  public Command resetOdometry() {
    return Commands.runOnce(() -> f.resetOdometry.accept(resolved().initialPose()))
        .withName("Mayhem reset " + name());
  }

  /**
   * Follows the trajectory with bump recovery, requires the drivetrain, and ends when it finishes.
   * The alliance is resolved when the command starts.
   */
  public Command cmd() {
    Command c = new Command() {
      @Override
      public void initialize() {
        running = resolved();
        runner = new TrajectoryRunner(running, f.followerConfig, f.recoveryConfig, new Listener(), f.refiner);
        activeCmd = this;
        isActive = true;
        time = 0;
        routine.onTrajectoryStart();
        runner.start(Timer.getFPGATimestamp());
        if (f.telemetry != null) {
          f.telemetry.startTrajectory(running);
        }
      }

      @Override
      public void execute() {
        double now = Timer.getFPGATimestamp();
        DriveCommand dc = runner.update(now, f.pose.get(), f.fieldSpeeds.get(), f.accelG.getAsDouble());
        f.output.accept(dc);
        double prev = time;
        time = runner.trajectoryTime();
        for (Map.Entry<Double, Pulse> e : timePulses.entrySet()) {
          if (prev < e.getKey() && time >= e.getKey()) {
            e.getValue().fire();
          }
        }
        recovering = runner.isRecovering();
        onTerrain = runner.onRoughTerrain();
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
        zoneActive.clear();
        isActive = false;
        recovering = false;
        onTerrain = false;
        activeCmd = null;
        f.visionBoost.accept(false);
        if (!interrupted) {
          hasFinished = true;
          finishedAt = Timer.getFPGATimestamp();
          startsAtFinish = routine.trajectoryStarts();
          donePulse.fire();
        }
        if (f.telemetry != null) {
          f.telemetry.stop();
        }
      }
    };
    c.addRequirements(f.driveSubsystem);
    c.setName("Mayhem " + name());
    return c;
  }

  /** Schedules {@link #cmd()} without waiting for it, so a sequence can move on. */
  public Command spawnCmd() {
    return new ScheduleCommand(cmd()).withName("Mayhem spawn " + name());
  }

  /** Starts {@code next} as soon as this trajectory finishes. */
  public void chain(AutoTrajectory next) {
    done().onTrue(next.cmd());
  }

  private final class Listener implements TrajectoryRunner.EventListener {
    @Override
    public void onEvent(TrajectoryEvent e) {
      markerPulses.computeIfAbsent(e.name, k -> new Pulse()).fire();
      if (e.isZone()) {
        zoneActive.put(e.name, true);
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
      zoneActive.remove(e.name);
      Command z = runningZones.remove(e.name);
      if (z != null) {
        z.cancel();
      }
    }
  }

  // --------------------------------------------------------------------------- triggers

  /** True while this trajectory's command runs. */
  public Trigger active() {
    return routine.observe(() -> isActive);
  }

  /** True while this trajectory's command is not running. */
  public Trigger inactive() {
    return active().negate();
  }

  /** True for one cycle after the trajectory finishes (not when it is interrupted). */
  public Trigger done() {
    return doneDelayed(0);
  }

  /** Like {@link #done()}, but {@code cyclesToDelay} routine cycles later. */
  public Trigger doneDelayed(int cyclesToDelay) {
    return routine.observe(() -> donePulse.high(cyclesToDelay));
  }

  /** True for {@code seconds} after the trajectory finishes. */
  public Trigger doneFor(double seconds) {
    return routine.observe(() -> hasFinished && !isActive
        && Timer.getFPGATimestamp() - finishedAt <= seconds);
  }

  /** True from when the trajectory finishes until another trajectory in the routine starts. */
  public Trigger recentlyDone() {
    return routine.observe(() -> hasFinished && routine.trajectoryStarts() == startsAtFinish);
  }

  /** True for one cycle when the trajectory clock passes {@code timeSinceStart} seconds. */
  public Trigger atTime(double timeSinceStart) {
    Pulse p = timePulses.computeIfAbsent(timeSinceStart, k -> new Pulse());
    return routine.observe(() -> p.high(0));
  }

  /**
   * True for one cycle when an instant marker named {@code eventName} fires, and for the whole
   * duration of a zone marker. Markers skipped by bump recovery follow their recovery policy.
   */
  public Trigger atTime(String eventName) {
    Pulse p = markerPulses.computeIfAbsent(eventName, k -> new Pulse());
    return routine.observe(() -> p.high(0) || zoneActive.getOrDefault(eventName, false));
  }

  /** True while the robot is within tolerance of where marker {@code eventName} sits on the path. */
  public Trigger atPose(String eventName, double toleranceMeters, double toleranceRadians) {
    return routine.observe(() -> isActive && eventPoses(eventName).stream()
        .anyMatch(near(toleranceMeters, toleranceRadians)));
  }

  /** True while the robot is within tolerance of a blue-alliance pose (flipped for red). */
  public Trigger atPose(Pose2d pose, double toleranceMeters, double toleranceRadians) {
    return routine.observe(() -> isActive && near(toleranceMeters, toleranceRadians).test(flip(pose)));
  }

  /** True while the robot is within {@code toleranceMeters} of where marker {@code eventName} sits. */
  public Trigger atTranslation(String eventName, double toleranceMeters) {
    return atPose(eventName, toleranceMeters, Double.POSITIVE_INFINITY);
  }

  /** True while the robot is within {@code toleranceMeters} of a blue-alliance point (flipped for red). */
  public Trigger atTranslation(Translation2d translation, double toleranceMeters) {
    return atPose(new Pose2d(translation, Rotation2d.kZero), toleranceMeters, Double.POSITIVE_INFINITY);
  }

  /** MayhemLib extra: true while bump recovery is driving a bridge back onto the path. */
  public Trigger recovering() {
    return routine.observe(() -> recovering);
  }

  /** MayhemLib extra: true while the reference is on a rough-terrain zone (e.g. the bump). */
  public Trigger onRoughTerrain() {
    return routine.observe(() -> onTerrain);
  }

  // --------------------------------------------------------------------------- internals

  private Predicate<Pose2d> near(double tolM, double tolRad) {
    return target -> {
      Pose2d p = f.pose.get();
      return p.getTranslation().getDistance(target.getTranslation()) <= tolM
          && Math.abs(p.getRotation().minus(target.getRotation()).getRadians()) <= tolRad;
    };
  }

  private List<Pose2d> eventPoses(String eventName) {
    List<Pose2d> out = new ArrayList<>();
    MayhemTrajectory t = running != null ? running : resolved();
    for (TrajectoryEvent e : t.events()) {
      if (e.name.equals(eventName)) {
        out.add(t.sampleAt(e.t).getPose());
      }
    }
    return out;
  }

  private Pose2d flip(Pose2d blue) {
    RecoveryData r = base.recovery();
    if (!f.isRed() || r == null) {
      return blue;
    }
    FieldSymmetry s = r.symmetry;
    return new Pose2d(s.flipX(blue.getX(), r.fieldLength), s.flipY(blue.getY(), r.fieldWidth),
        new Rotation2d(s.flipHeading(blue.getRotation().getRadians())));
  }

  boolean isActive() {
    return isActive;
  }

  boolean hasFinished() {
    return hasFinished;
  }

  /** Cancels a running command and forgets finished state; called when the routine stops. */
  void reset() {
    if (activeCmd != null) {
      activeCmd.cancel();
    }
    hasFinished = false;
    startsAtFinish = -1;
    finishedAt = Double.NEGATIVE_INFINITY;
  }
}
