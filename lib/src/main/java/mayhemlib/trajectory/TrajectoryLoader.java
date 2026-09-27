package mayhemlib.trajectory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.wpilibj.Filesystem;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import mayhemlib.geometry.ConvexPolygon;

/** Loads {@code .mtraj} files written by the Mayhem app. */
public final class TrajectoryLoader {
  public static final String DEPLOY_SUBDIR = "mayhem";
  public static final String EXTENSION = ".mtraj";
  public static final int SUPPORTED_FORMAT = 1;

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final Map<String, MayhemTrajectory> CACHE = new ConcurrentHashMap<>();

  private TrajectoryLoader() {}

  /** Loads {@code deploy/mayhem/<name>.mtraj}, caching the result. */
  public static MayhemTrajectory load(String name) {
    return CACHE.computeIfAbsent(name, n -> {
      File dir = new File(Filesystem.getDeployDirectory(), DEPLOY_SUBDIR);
      return load(new File(dir, n + EXTENSION));
    });
  }

  /** Clears the cache (for tests or hot reload). */
  public static void clearCache() {
    CACHE.clear();
  }

  public static MayhemTrajectory load(File file) {
    try {
      return parse(Files.readString(file.toPath()));
    } catch (IOException e) {
      throw new IllegalArgumentException("Could not read trajectory " + file + ": " + e.getMessage(), e);
    }
  }

  public static MayhemTrajectory parse(String json) {
    JsonNode root;
    try {
      root = MAPPER.readTree(json);
    } catch (IOException e) {
      throw new IllegalArgumentException("Invalid trajectory JSON: " + e.getMessage(), e);
    }
    String name = root.path("name").asText("unnamed");
    int format = root.path("formatVersion").asInt(1);
    if (format > SUPPORTED_FORMAT) {
      throw new IllegalArgumentException("Trajectory '" + name + "' uses format " + format
          + " but this MayhemLib supports up to " + SUPPORTED_FORMAT + ". Update MayhemLib.");
    }
    JsonNode out = root.path("output");
    if (out.isMissingNode() || out.isNull()) {
      throw new IllegalArgumentException("Trajectory '" + name + "' has not been generated yet.");
    }
    List<TrajectorySample> samples = new ArrayList<>();
    for (JsonNode s : out.path("samples")) {
      samples.add(new TrajectorySample(
          s.path("t").asDouble(), s.path("x").asDouble(), s.path("y").asDouble(),
          s.path("heading").asDouble(), s.path("vx").asDouble(), s.path("vy").asDouble(),
          s.path("omega").asDouble(), s.path("ax").asDouble(), s.path("ay").asDouble(),
          s.path("alpha").asDouble(), doubles(s.path("fx")), doubles(s.path("fy"))));
    }
    List<TrajectoryEvent> events = new ArrayList<>();
    for (JsonNode e : out.path("events")) {
      JsonNode end = e.path("endT");
      events.add(new TrajectoryEvent(
          e.path("name").asText(), e.path("command").asText(""), e.path("t").asDouble(),
          end.isNumber() ? end.asDouble() : Double.NaN,
          TrajectoryEvent.RecoveryPolicy.fromString(e.path("recoveryPolicy").asText("fireAtJoin")),
          e.path("mustHit").asBoolean(false)));
    }
    List<TerrainSpan> terrain = new ArrayList<>();
    for (JsonNode s : out.path("terrain")) {
      terrain.add(new TerrainSpan(s.path("t").asDouble(), s.path("endT").asDouble(),
          s.path("expectedSpeed").asDouble(0.7), s.path("feedbackScale").asDouble(0.3)));
    }
    terrain.sort((a, b) -> Double.compare(a.t, b.t));
    int[] splits = ints(out.path("splits"));
    double[] wtimes = doubles(out.path("waypointTimes"));
    RecoveryData rec = parseRecovery(out.path("recovery"));
    return new MayhemTrajectory(name, samples, events, terrain, splits, wtimes, rec,
        out.path("inputHash").asText(""), false);
  }

  private static RecoveryData parseRecovery(JsonNode r) {
    if (r.isMissingNode() || r.isNull()) {
      return null;
    }
    List<Translation2d> bumper = points(r.path("bumper"));
    List<ConvexPolygon> obstacles = new ArrayList<>();
    for (JsonNode poly : r.path("obstacles")) {
      List<Translation2d> pts = points(poly);
      if (pts.size() >= 3) {
        obstacles.add(ConvexPolygon.of(pts));
      }
    }
    List<int[]> edges = new ArrayList<>();
    for (JsonNode e : r.path("roadmapEdges")) {
      edges.add(new int[] {e.get(0).asInt(), e.get(1).asInt()});
    }
    JsonNode lim = r.path("limits");
    return new RecoveryData(
        bumper.toArray(new Translation2d[0]), obstacles, r.path("fieldLength").asDouble(16.541),
        r.path("fieldWidth").asDouble(8.069), FieldSymmetry.fromString(r.path("symmetry").asText()),
        points(r.path("roadmapNodes")), edges, lim.path("maxVelocity").asDouble(3.0),
        lim.path("maxAcceleration").asDouble(4.0), lim.path("maxAngularVelocity").asDouble(6.0),
        lim.path("maxAngularAcceleration").asDouble(10.0), doubles(r.path("mustHitTimes")));
  }

  private static List<Translation2d> points(JsonNode arr) {
    List<Translation2d> out = new ArrayList<>();
    for (JsonNode p : arr) {
      out.add(new Translation2d(p.get(0).asDouble(), p.get(1).asDouble()));
    }
    return out;
  }

  private static double[] doubles(JsonNode arr) {
    double[] out = new double[arr.size()];
    for (int i = 0; i < out.length; i++) {
      out[i] = arr.get(i).asDouble();
    }
    return out;
  }

  private static int[] ints(JsonNode arr) {
    int[] out = new int[arr.size()];
    for (int i = 0; i < out.length; i++) {
      out[i] = arr.get(i).asInt();
    }
    return out;
  }
}
