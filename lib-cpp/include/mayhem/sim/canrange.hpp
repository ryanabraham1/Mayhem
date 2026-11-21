#pragma once
// mayhem::sim CANrange emulator. Header-only, C++17, no dependencies.
//
// A time-of-flight sensor that measures at its own rate: ShortRange100Hz samples every 10 ms,
// the user-frequency modes at UpdateFrequency. Each sample latches the distance set with
// SetDistance(); IsDetected() follows ProximityThreshold with ProximityHysteresis like the
// device (detected below threshold - hysteresis, undetected above threshold + hysteresis).
//
// Step it every physics tick (1 kHz is fine) after setting the distance. A TalonFx that uses
// it as a remote limit switch (TalonFx::AttachCanRange) reads IsDetected() each of its own
// steps, so the Talon sees the detection at the CANrange's rate, as on the robot.
//
// Not modeled: signal strength, the field of view, ambient light and CAN latency.
#include <cmath>
#include <limits>

namespace mayhem::sim {

// Defaults are Phoenix 6 (2026) factory defaults.
struct CanRangeConfig {
  double proximityThreshold = 0.4;   // m
  double proximityHysteresis = 0.01; // m
  enum class UpdateMode { ShortRange100Hz, ShortRangeUserFreq, LongRangeUserFreq } updateMode = UpdateMode::ShortRange100Hz;
  double updateFrequency = 50;  // Hz, for the user-frequency modes
};

class CanRange {
 public:
  static constexpr double kNothing = std::numeric_limits<double>::infinity();

  explicit CanRange(CanRangeConfig config = {}) : cfg_(config) {}
  void Configure(const CanRangeConfig& config) { cfg_ = config; }
  const CanRangeConfig& Config() const { return cfg_; }

  /** The true distance to what is in front of the sensor now (m); kNothing (or NaN) for nothing. */
  void SetDistance(double meters) { truth_ = std::isnan(meters) ? kNothing : meters; }

  /** Advance the sensor clock; takes a measurement when one is due. Returns true on a new sample. */
  bool Step(double dt) {
    const double period = Period();
    elapsed_ += dt;
    if (elapsed_ + 1e-9 < period) return false;
    elapsed_ = elapsed_ >= 2 * period ? 0 : elapsed_ - period;  // a long dt does not queue samples
    Sample();
    return true;
  }

  /** Take a measurement now (e.g. at startup), restarting the sample period. */
  void Sample() {
    measured_ = truth_;
    if (detected_) detected_ = !(measured_ > cfg_.proximityThreshold + cfg_.proximityHysteresis);
    else detected_ = measured_ <= cfg_.proximityThreshold - cfg_.proximityHysteresis;
    sampled_ = true;
  }

  /** The latest measurement (m); kNothing before the first sample or when nothing is in view. */
  double Distance() const { return sampled_ ? measured_ : kNothing; }
  bool IsDetected() const { return detected_; }
  /** Seconds between measurements. */
  double Period() const {
    if (cfg_.updateMode == CanRangeConfig::UpdateMode::ShortRange100Hz) return 0.010;
    return cfg_.updateFrequency > 0 ? 1.0 / cfg_.updateFrequency : 0.020;
  }

 private:
  CanRangeConfig cfg_;
  double truth_ = kNothing, measured_ = kNothing;
  // The first Step measures at once.
  double elapsed_ = std::numeric_limits<double>::infinity();
  bool detected_ = false, sampled_ = false;
};

}  // namespace mayhem::sim
