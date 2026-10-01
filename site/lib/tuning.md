# Tuning the follower

## `FollowerConfig`

Pass it with `withFollowerConfig(...)`. Fields are public, or use the `with*` helpers.

| Field | Default | Notes |
|---|---|---|
| `translationKp` | 6.0 (m/s)/m | Position feedback. |
| `translationKv` | 0 | Optional velocity-error feedback. |
| `rotationKp` | 5.0 (rad/s)/rad | Heading feedback. |
| `maxFeedbackVelocity` / `maxFeedbackOmega` | 1.5 m/s / 3.0 rad/s | Clamp on the feedback part only. |
| `maxVelocity` / `maxOmega` | 5.0 m/s / 12 rad/s | Clamp on the total command. |
| `useForceFeedforward` | true | Sends the trajectory's module forces. |
| `modules` | 4 | Number of swerve modules. |

## Tune in this order

1. **Drivetrain first.** Tune the drive-motor velocity gains (kS, kV, kP) and steer gains with SysId. These are in the Tuner X project, and `CommandSwerveDrivetrain` has SysId bindings. No path follower can make up for a slow velocity loop.
2. **Check the model.** Robot mass, MOI, wheel radius, and max speed in the Mayhem app must match the real robot. If they don't, the feedforward and force feedforward will be wrong.
3. **Feedforward only.** Set `translationKp` and `rotationKp` to 0 and run a path. The robot should end up close to the target, within about 10–20 cm. If it overshoots during acceleration phases, compare runs with `withForceFeedforward(false)`. The force feedforward depends on accurate motor and gearing constants in `TunerConstants`.
4. **Feedback.** Raise `translationKp` until tracking is tight without oscillation. Typical values are 4–10. Then raise `rotationKp` (typically 3–8).
5. **Recovery thresholds.** Watch `/Mayhem/positionError` during clean runs. Keep `dilationStartError` above your normal tracking error. Keep `bridgeTriggerError` well above your worst clean-run error, or bridges will trigger without a real hit. See [Bump recovery](/lib/recovery).
6. **Accelerometer.** Log the Pigeon's horizontal g during hard accelerations. If `accelSpikeG` false-triggers, raise it, or disable the spike check with `withAccelerometer(() -> Double.NaN)`. Sustained-error detection still works without it.
