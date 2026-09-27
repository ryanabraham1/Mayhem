package mayhemlib.auto;

import edu.wpi.first.wpilibj.event.EventLoop;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.button.Trigger;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import mayhemlib.trajectory.MayhemTrajectory;

/**
 * A trigger-based auto, modeled on Choreo's {@code choreo.auto.AutoRoutine}. It owns an
 * {@link EventLoop} that {@link #cmd()} polls, so every trigger made from this routine or its
 * trajectories only reacts while the routine runs.
 *
 * <pre>{@code
 * AutoRoutine routine = autoFactory.newRoutine("HubCycle");
 * AutoTrajectory toHub = routine.trajectory("HubCycle", 0);
 * AutoTrajectory toIntake = routine.trajectory("HubCycle", 1);
 * routine.active().onTrue(Commands.sequence(toHub.resetOdometry(), toHub.cmd()));
 * toHub.done().onTrue(shooter.shoot().andThen(toIntake.cmd()));
 * return routine.cmd();
 * }</pre>
 */
public final class AutoRoutine {
  private final AutoFactory factory;
  private final String name;
  private final EventLoop loop = new EventLoop();
  private final List<AutoTrajectory> trajectories = new ArrayList<>();
  private boolean isActive;
  private boolean isKilled;
  private long pollCount;
  private int trajectoryStarts;

  AutoRoutine(AutoFactory factory, String name) {
    this.factory = factory;
    this.name = name;
  }

  public String name() {
    return name;
  }

  // --------------------------------------------------------------------------- trajectories

  /** Loads {@code deploy/mayhem/<name>.mtraj} as a trajectory of this routine. */
  public AutoTrajectory trajectory(String trajectoryName) {
    return trajectory(AutoFactory.load(trajectoryName, -1));
  }

  /** Split segment {@code splitIndex} of a trajectory, with its own time starting at 0. */
  public AutoTrajectory trajectory(String trajectoryName, int splitIndex) {
    return trajectory(AutoFactory.load(trajectoryName, splitIndex));
  }

  /** Wraps an already loaded trajectory (for example from {@code TrajectoryLoader.load(File)}). */
  public AutoTrajectory trajectory(MayhemTrajectory trajectory) {
    AutoTrajectory t = new AutoTrajectory(factory, this, trajectory);
    trajectories.add(t);
    return t;
  }

  // --------------------------------------------------------------------------- triggers

  /** True while the routine's command runs. Bind the first step to its rising edge. */
  public Trigger active() {
    return observe(() -> isActive);
  }

  /** A trigger on this routine's event loop, so it is only polled while the routine runs. */
  public Trigger observe(BooleanSupplier condition) {
    return new Trigger(loop, condition);
  }

  /** True while no trajectory of this routine is running. */
  public Trigger idle() {
    return observe(() -> trajectories.stream().noneMatch(AutoTrajectory::isActive));
  }

  /** True for one cycle after any of the given trajectories finishes. */
  public Trigger anyDone(AutoTrajectory trajectory, AutoTrajectory... trajectories) {
    Trigger t = trajectory.done();
    for (AutoTrajectory other : trajectories) {
      t = t.or(other.done());
    }
    return t;
  }

  /** True once every given trajectory has finished during this run of the routine. */
  public Trigger allDone(AutoTrajectory trajectory, AutoTrajectory... trajectories) {
    return observe(() -> {
      if (!trajectory.hasFinished()) {
        return false;
      }
      for (AutoTrajectory other : trajectories) {
        if (!other.hasFinished()) {
          return false;
        }
      }
      return true;
    });
  }

  /** True while any of the given trajectories is running. */
  public Trigger anyActive(AutoTrajectory trajectory, AutoTrajectory... trajectories) {
    Trigger t = trajectory.active();
    for (AutoTrajectory other : trajectories) {
      t = t.or(other.active());
    }
    return t;
  }

  /** True while none of the given trajectories is running. */
  public Trigger allInactive(AutoTrajectory trajectory, AutoTrajectory... trajectories) {
    return anyActive(trajectory, trajectories).negate();
  }

  // --------------------------------------------------------------------------- lifecycle

  /** The routine's event loop. */
  public EventLoop loop() {
    return loop;
  }

  /** Polls the routine's triggers once. {@link #cmd()} calls this every loop. */
  public void poll() {
    if (isKilled) {
      isActive = false;
      return;
    }
    isActive = true;
    pollCount++;
    loop.poll();
  }

  /** Stops the routine and cancels its trajectory commands; it can run again later. */
  public void reset() {
    isActive = false;
    for (AutoTrajectory t : trajectories) {
      t.reset();
    }
  }

  /** Stops the routine for good: {@link #cmd()} ends and triggers stop firing. */
  public void kill() {
    isKilled = true;
    reset();
  }

  /** Runs the routine until it is killed or cancelled (usually when autonomous ends). */
  public Command cmd() {
    return cmd(() -> false);
  }

  /** Runs the routine until {@code finishCondition} is true, it is killed, or it is cancelled. */
  public Command cmd(BooleanSupplier finishCondition) {
    return Commands.run(this::poll)
        .until(() -> isKilled || finishCondition.getAsBoolean())
        .finallyDo(this::reset)
        .withName(name);
  }

  // --------------------------------------------------------------------------- internals

  long pollCount() {
    return pollCount;
  }

  int trajectoryStarts() {
    return trajectoryStarts;
  }

  void onTrajectoryStart() {
    trajectoryStarts++;
  }
}
