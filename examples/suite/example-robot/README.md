# Example robot

`../example-robot.mayhem.json` is a made-up swerve robot with a claw on a single-jointed arm. It isn't based on any team's code. Open it to try the suite without a robot project of your own.

- **Autos:**
  - *Leave only* drives out of the start zone.
  - *Preload + one* places the preload, picks up a piece, and scores it. If the claw doesn't see the piece when the grab window ends, it skips the score and parks (the `Missed` branch).
  - *Low-side sweep* collects two pieces using moving handoffs between poses.

  The pickup arm runs during the drives (`during: arm.floorPickup`). Robot code owns `arm.place` and `claw.grab`.
- **Manipulator machine:** stow, floor pickup, hold, aim low/high, place, eject, climb, and a fault state that any state enters when the arm encoder drops out. Inputs are tagged by category (operator, auto, sensor, timer). The state is logged on `/RealOutputs/Manipulator/State`.

Try it from the command line:

```sh
node scripts/mayhem.mjs validate examples/suite/example-robot.mayhem.json
node scripts/mayhem.mjs simulate examples/suite/example-robot.mayhem.json \
  '{"routine":"two-piece","signals":{"claw.hasPiece":false},"actions":{"arm.place":"succeeded","claw.grab":"succeeded","arm.floorPickup":"running"}}'
```
