package mayhemlib.auto;

import edu.wpi.first.util.sendable.Sendable;
import edu.wpi.first.util.sendable.SendableBuilder;
import edu.wpi.first.util.sendable.SendableRegistry;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * A dashboard auto picker, modeled on Choreo's {@code choreo.auto.AutoChooser}. Routines are built
 * lazily: only the selected one is generated, when it is picked while the robot is disabled (so
 * trajectory loading happens before the match, not at the start of auto).
 *
 * <pre>{@code
 * autoChooser = new AutoChooser();
 * autoChooser.addRoutine("Hub cycle", this::hubCycle);
 * autoChooser.addCmd("Drive forward", this::driveForward);
 * SmartDashboard.putData("Auto Chooser", autoChooser);
 * RobotModeTriggers.autonomous().whileTrue(autoChooser.selectedCommandScheduler());
 * }</pre>
 */
public final class AutoChooser implements Sendable {
  public static final String NONE_NAME = "Nothing";
  private static final AtomicInteger INSTANCES = new AtomicInteger();

  private final Map<String, Supplier<Command>> generators = new LinkedHashMap<>();
  private final int instance = INSTANCES.getAndIncrement();
  private String selected = NONE_NAME;
  private String builtFor = NONE_NAME;
  private Command built = Commands.none().withName(NONE_NAME);

  public AutoChooser() {
    generators.put(NONE_NAME, () -> Commands.none().withName(NONE_NAME));
    SendableRegistry.add(this, "AutoChooser", instance);
  }

  /** Adds a routine; {@code generator} runs only when this option is selected. */
  public AutoChooser addRoutine(String name, Supplier<AutoRoutine> generator) {
    generators.put(name, () -> generator.get().cmd());
    return this;
  }

  /** Adds a plain command; {@code generator} runs only when this option is selected. */
  public AutoChooser addCmd(String name, Supplier<Command> generator) {
    generators.put(name, generator);
    return this;
  }

  /** Selects an option by name, as the dashboard would. Unknown names are ignored. */
  public void select(String name) {
    if (!generators.containsKey(name)) {
      DriverStation.reportWarning("[MayhemLib] AutoChooser has no option named '" + name + "'", false);
      return;
    }
    selected = name;
    if (DriverStation.isDisabled()) {
      build();
    }
  }

  /** The command for the selected option, generating it if the selection changed. */
  public Command selectedCommand() {
    build();
    return built;
  }

  /** A command that runs the selected auto as a proxy; bind it to {@code autonomous().whileTrue}. */
  public Command selectedCommandScheduler() {
    return Commands.defer(() -> selectedCommand().asProxy(), Set.of()).withName("AutoChooser");
  }

  private void build() {
    if (!selected.equals(builtFor)) {
      built = generators.get(selected).get();
      builtFor = selected;
    }
  }

  @Override
  public void initSendable(SendableBuilder builder) {
    builder.setSmartDashboardType("String Chooser");
    builder.publishConstInteger(".instance", instance);
    builder.addStringProperty("default", () -> NONE_NAME, null);
    builder.addStringArrayProperty("options", () -> generators.keySet().toArray(new String[0]), null);
    builder.addStringProperty("active", () -> selected, null);
    builder.addStringProperty("selected", null, this::select);
  }
}
