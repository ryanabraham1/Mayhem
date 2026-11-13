#pragma once
// mayhem::sim battery: Thevenin source (open-circuit voltage + internal and wiring resistance).
// Header-only, C++17, no dependencies.
//
// Step() takes the total current drawn this step (sum of every device's supply current plus a
// fixed load for the roboRIO/radio/etc.) and returns the bus voltage. Use the voltage from the
// previous step as the bus voltage for this step's motor updates; at 1 ms that one-step lag is
// negligible. Defaults: a fresh FRC SLA battery (12.6 V open circuit, ~15 mOhm) with ~8 mOhm of
// main breaker, PDH and wire.
#include <algorithm>

namespace mayhem::sim {

class Battery {
 public:
  explicit Battery(double openCircuitVolts = 12.6, double internalResistanceOhms = 0.015,
                   double wiringResistanceOhms = 0.008)
      : ocv_(openCircuitVolts), rInt_(internalResistanceOhms), rWire_(wiringResistanceOhms),
        voltage_(openCircuitVolts) {}

  /** Total current (A) drawn this step; regenerated (negative) current raises the voltage. */
  double Step(double totalCurrentAmps) {
    current_ = totalCurrentAmps + baseLoad_;
    voltage_ = std::max(0.0, ocv_ - current_ * (rInt_ + rWire_));
    return voltage_;
  }
  /** Step with a time step, also integrating the charge drawn (amp-hours). */
  double Step(double totalCurrentAmps, double dt) {
    const double v = Step(totalCurrentAmps);
    usedAmpHours_ += current_ * dt / 3600.0;
    return v;
  }
  double Voltage() const { return voltage_; }
  double TotalCurrent() const { return current_; }
  double UsedAmpHours() const { return usedAmpHours_; }
  /** roboRIO 2 brownout: below 6.75 V by default (RobotController::SetBrownoutVoltage). */
  bool Brownout() const { return voltage_ < brownoutVolts_; }
  void SetBrownoutVoltage(double volts) { brownoutVolts_ = volts; }
  /** Constant extra load (A): roboRIO, radio, sensors, LEDs. Default 2 A. */
  void SetBaseLoad(double amps) { baseLoad_ = amps; }
  void SetOpenCircuitVoltage(double volts) { ocv_ = volts; }
  double OpenCircuitVoltage() const { return ocv_; }
  double Resistance() const { return rInt_ + rWire_; }

 private:
  double ocv_, rInt_, rWire_, voltage_;
  double current_ = 0, baseLoad_ = 2, usedAmpHours_ = 0, brownoutVolts_ = 6.75;
};

}  // namespace mayhem::sim
