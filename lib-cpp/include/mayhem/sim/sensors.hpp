#pragma once
// mayhem::sim sensor measurement models: what robot code reads, not the truth. Header-only, C++17.
//
// SampledSignal<T>: a status signal. The device samples the true value every periodS (its update
//   frequency) and the sample reaches robot code latencyS later; robot code sees the latest
//   arrived sample and its capture time. Use it for anything read over CAN or a network table.
// GyroModel: a Pigeon2-style yaw. Integrates the true yaw change with a scale error, a constant
//   bias drift and a random-walk bias (bias instability), saturates at the gyro's rate range,
//   adds white noise per sample, then delivers it as a SampledSignal. SetYaw re-zeroes it.
// Defaults are ideal (no error, no latency) except the 100 Hz Pigeon2 yaw update rate, so a sim
// stays exact until you set the errors you measured (docs/SIMULATION.md, "Sensor errors").
// Deterministic for a given seed.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <deque>
#include <utility>

#include "mayhem/sim/rng.hpp"
#include "mayhem/sim/swerve.hpp"

namespace mayhem::sim {

template <class T>
class SampledSignal {
 public:
  explicit SampledSignal(double periodS = 0, double latencyS = 0) : period_(periodS), latency_(latencyS) {}
  void Configure(double periodS, double latencyS) { period_ = periodS; latency_ = latencyS; }
  double Period() const { return period_; }
  double Latency() const { return latency_; }

  /** Will Update(now, ...) take a sample? (to compute expensive or noisy values only then) */
  bool Due(double now) const { return !started_ || now + 1e-9 >= next_; }

  /** Call every sim step with the true value. Returns true when a new sample arrived. */
  bool Update(double now, const T& truth) {
    if (Due(now)) {
      pending_.push_back({now, truth});
      next_ = (started_ && now - next_ < period_) ? next_ + period_ : now + period_;
      started_ = true;
    }
    bool fresh = false;
    while (!pending_.empty() && pending_.front().first + latency_ <= now + 1e-9) {
      stamp_ = pending_.front().first;
      value_ = std::move(pending_.front().second);
      pending_.pop_front();
      has_ = fresh = true;
    }
    return fresh;
  }
  bool HasValue() const { return has_; }
  const T& Value() const { return value_; }
  /** Capture time of Value(). */
  double Timestamp() const { return stamp_; }
  void Reset() { pending_.clear(); started_ = has_ = false; value_ = T{}; stamp_ = 0; }

 private:
  double period_, latency_, next_ = 0, stamp_ = 0;
  bool started_ = false, has_ = false;
  T value_{};
  std::deque<std::pair<double, T>> pending_;
};

struct GyroParams {
  double updatePeriodS = 0.01;  // Pigeon2 yaw defaults to 100 Hz; Phoenix swerve odometry often sets 250 Hz
  double latencyS = 0;          // CAN delay from sample to robot code
  double scaleError = 0;        // fraction: reported yaw change = (1 + scaleError) x true change
  double biasRadPerS = 0;       // constant drift while still
  double biasRandomWalk = 0;    // bias instability, rad/s per sqrt(s)
  double yawNoiseRad = 0;       // white noise per yaw sample, 1 sigma
  double rateNoiseRadPerS = 0;  // white noise per rate sample, 1 sigma
  double maxRateRadPerS = 34.9;  // +-2000 deg/s range: faster spins are under-reported
  std::uint64_t seed = 2;
};

struct GyroReading {
  double yaw = 0;          // continuous, radians (Pigeon2 GetYaw in radians)
  Vec3 rates{0, 0, 0};     // body-frame roll, pitch, yaw rates, rad/s
};

class GyroModel {
 public:
  explicit GyroModel(GyroParams p = {}) : p_(p), rng_(p.seed), signal_(p.updatePeriodS, p.latencyS) {}
  const GyroParams& Params() const { return p_; }

  /** Start from the true yaw (call once before stepping, or after a teleport). */
  void Reset(double trueYaw, double reportedYaw = 0) {
    lastTrue_ = trueYaw;
    yaw_ = reportedYaw;
    started_ = true;
    signal_.Reset();
  }
  /** Pigeon2 SetYaw: the reported yaw becomes `reportedYaw` (the integrated error stays in the bias). */
  void SetYaw(double reportedYaw) { yaw_ = reportedYaw; }

  /** Advance by dt to time `now` with the true continuous yaw and body rates. */
  void Step(double now, double dt, double trueYaw, Vec3 trueBodyRates) {
    if (!started_) Reset(trueYaw, trueYaw);
    double d = trueYaw - lastTrue_;
    lastTrue_ = trueYaw;
    if (dt > 0) d = std::clamp(d, -p_.maxRateRadPerS * dt, p_.maxRateRadPerS * dt);
    yaw_ += (1 + p_.scaleError) * d + (p_.biasRadPerS + walk_) * dt;
    if (p_.biasRandomWalk > 0 && dt > 0) walk_ += p_.biasRandomWalk * std::sqrt(dt) * rng_.Normal();
    GyroReading r;
    if (signal_.Due(now)) {
      r.yaw = yaw_ + (p_.yawNoiseRad > 0 ? rng_.Normal(0, p_.yawNoiseRad) : 0);
      for (int k = 0; k < 3; ++k) {
        const double rate = std::clamp(trueBodyRates[k], -p_.maxRateRadPerS, p_.maxRateRadPerS);
        r.rates[k] = (k == 2 ? (1 + p_.scaleError) * rate + p_.biasRadPerS + walk_ : rate) +
                     (p_.rateNoiseRadPerS > 0 ? rng_.Normal(0, p_.rateNoiseRadPerS) : 0);
      }
    }
    signal_.Update(now, r);
  }
  void Step(double now, double dt, const SwerveSim& robot) { Step(now, dt, robot.GyroYaw(), robot.GyroRates()); }

  double Yaw() const { return signal_.Value().yaw; }
  Vec3 Rates() const { return signal_.Value().rates; }
  double Timestamp() const { return signal_.Timestamp(); }
  bool HasValue() const { return signal_.HasValue(); }
  /** Current total yaw bias, rad/s (diagnostic). */
  double Bias() const { return p_.biasRadPerS + walk_; }

 private:
  GyroParams p_;
  Rng rng_;
  SampledSignal<GyroReading> signal_;
  bool started_ = false;
  double lastTrue_ = 0, yaw_ = 0, walk_ = 0;
};

}  // namespace mayhem::sim
