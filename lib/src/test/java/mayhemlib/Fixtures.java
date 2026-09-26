package mayhemlib;

import java.io.File;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.TrajectoryLoader;

final class Fixtures {
  static MayhemTrajectory load(String name) {
    String dir = System.getProperty("mayhem.testdata", "src/test/resources");
    return TrajectoryLoader.load(new File(dir, name + ".mtraj"));
  }
}
